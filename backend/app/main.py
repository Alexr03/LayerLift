"""LayerLift HTTP API (FastAPI). Also serves the built frontend when present."""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import http
import json
import logging
import secrets
import time
from pathlib import Path

from fastapi import Depends, FastAPI, File, Form, Request, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, Response
from pydantic import ValidationError

from relief import __version__
from relief.colour import hex_to_lab
from relief.imageio import ImageError
from relief.mapping import suggest_mapping

from . import worker
from .config import get_settings
from .jobs import JobStore, LRUCache
from .pool import JobTimeout, WorkerCrashed, WorkerPool
from .protect import SESSION_COOKIE, JobQueue, RateLimiter, Rejected, Sessions, client_ip, verify_turnstile
from .schemas import AnalyseResponse, AnalysisOptions, BuildRequest, BuildResponse, FilamentIn, MapRequest, MapResponse

log = logging.getLogger("layerlift")
access_log = logging.getLogger("layerlift.access")


def _setup_logging() -> None:
    """Send LayerLift's logs to stderr in uvicorn's style (they were silently dropped before)."""
    if log.handlers:
        return
    try:
        from uvicorn.logging import DefaultFormatter

        formatter: logging.Formatter = DefaultFormatter("%(levelprefix)s %(message)s", use_colors=None)
    except ImportError:  # pragma: no cover - uvicorn is always installed with the app
        formatter = logging.Formatter("%(levelname)s: %(message)s")
    handler = logging.StreamHandler()
    handler.setFormatter(formatter)
    log.addHandler(handler)
    log.setLevel(logging.INFO)
    log.propagate = False


_setup_logging()


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str, detail: dict | None = None):
        self.status, self.code, self.message, self.detail = status, code, message, detail or {}


def _error(status: int, code: str, message: str, detail: dict | None = None) -> JSONResponse:
    return JSONResponse({"error": {"code": code, "message": message, "detail": detail or {}}}, status_code=status)


@contextlib.asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    app.state.settings = settings
    app.state.jobs = JobStore(settings.data_dir, settings.job_ttl_seconds)
    app.state.cache = LRUCache(settings.analysis_cache_size)
    app.state.pool = WorkerPool(settings.workers)
    app.state.pool.warm_up()
    app.state.builds = {}  # job_id -> in-memory state of builds started with POST /api/builds
    app.state.sessions = Sessions(settings.session_secret, settings.session_ttl_seconds)
    app.state.limiter = RateLimiter(settings.rate_limit_per_minute)
    app.state.map_limiter = RateLimiter(settings.map_rate_limit_per_minute)
    app.state.queue = JobQueue(settings.max_queue, settings.max_jobs_per_client)
    if settings.turnstile_enabled:
        log.info("Cloudflare Turnstile human check is on")
    if settings.access_log:
        # Our access log (below) shows the real client IP; uvicorn's would show the proxy's.
        logging.getLogger("uvicorn.access").disabled = True

    async def sweeper():
        while True:
            try:
                removed = app.state.jobs.sweep()
                cutoff = time.time() - settings.job_ttl_seconds
                for job_id in [j for j, b in app.state.builds.items() if b["started"] < cutoff and b["state"] in ("done", "error")]:
                    del app.state.builds[job_id]
                if removed:
                    log.info("removed %d expired jobs", removed)
            except Exception:  # pragma: no cover - never let the sweeper die
                log.exception("job sweep failed")
            await asyncio.sleep(min(300, max(10, settings.job_ttl_seconds // 4)))

    task = asyncio.create_task(sweeper())
    try:
        yield
    finally:
        task.cancel()
        app.state.pool.shutdown()


_docs = get_settings().enable_docs
app = FastAPI(
    title="LayerLift",
    version=__version__,
    lifespan=lifespan,
    docs_url="/api/docs" if _docs else None,
    redoc_url=None,
    openapi_url="/api/openapi.json" if _docs else None,
)


# ----------------------------------------------------------------------------- errors


@app.exception_handler(ApiError)
async def api_error_handler(_: Request, exc: ApiError):
    return _error(exc.status, exc.code, exc.message, exc.detail)


@app.exception_handler(Rejected)
async def rejected_handler(_: Request, exc: Rejected):
    response = _error(exc.status, exc.code, exc.message)
    if exc.retry_after:
        response.headers["Retry-After"] = str(exc.retry_after)
    return response


@app.exception_handler(RequestValidationError)
async def validation_handler(_: Request, exc: RequestValidationError):
    return _error(422, "invalid_request", "The request is invalid.", {"errors": json.loads(json.dumps(exc.errors(), default=str))})


# Turnstile runs from challenges.cloudflare.com; everything else is served by this app.
CSP = (
    "default-src 'self'; script-src 'self' https://challenges.cloudflare.com; "
    "frame-src https://challenges.cloudflare.com; connect-src 'self'; img-src 'self' data: blob:; "
    "style-src 'self' 'unsafe-inline'; font-src 'self'; worker-src 'self' blob:; object-src 'none'; "
    "base-uri 'self'; form-action 'self'; frame-ancestors 'none'"
)


@app.middleware("http")
async def security_headers(request: Request, call_next):
    response = await call_next(request)
    h = response.headers
    h.setdefault("X-Content-Type-Options", "nosniff")
    h.setdefault("Referrer-Policy", "same-origin")
    h.setdefault("X-Frame-Options", "DENY")
    h.setdefault("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
    if h.get("content-type", "").startswith("text/html"):
        h.setdefault("Content-Security-Policy", CSP)
    return response


@app.middleware("http")
async def limit_upload_size(request: Request, call_next):
    length = request.headers.get("content-length")
    limit = get_settings().max_upload_bytes + 256 * 1024  # room for form fields
    if request.method == "POST" and length and length.isdigit() and int(length) > limit:
        return _error(413, "file_too_large", f"Uploads are limited to {get_settings().max_upload_mb:g} MB.")
    return await call_next(request)


QUIET_PATHS = ("/api/health", "/assets/", "/favicon.svg")


@app.middleware("http")
async def log_requests(request: Request, call_next):
    """One access-log line per request, with the client IP the rate limits use.

    Registered last, so it wraps the other middleware and logs their responses too
    (for example 413 for oversized uploads). Health probes and static assets are skipped.
    """
    if not get_settings().access_log or request.url.path.startswith(QUIET_PATHS):
        return await call_next(request)
    start = time.perf_counter()
    status = 500
    try:
        response = await call_next(request)
        status = response.status_code
        return response
    finally:
        try:
            phrase = http.HTTPStatus(status).phrase
        except ValueError:
            phrase = ""
        target = request.url.path + (f"?{request.url.query}" if request.url.query else "")
        access_log.info(
            '%s - "%s %s HTTP/%s" %d %s %.2fs',
            _client(request),
            request.method,
            target,
            request.scope.get("http_version", "1.1"),
            status,
            phrase,
            time.perf_counter() - start,
        )


# ----------------------------------------------------------------------------- helpers


async def _read_upload(file: UploadFile) -> bytes:
    limit = get_settings().max_upload_bytes
    chunks, size = [], 0
    while chunk := await file.read(1 << 20):
        size += len(chunk)
        if size > limit:
            raise ApiError(413, "file_too_large", f"Uploads are limited to {get_settings().max_upload_mb:g} MB.")
        chunks.append(chunk)
    if size == 0:
        raise ApiError(422, "invalid_image", "The uploaded file is empty.")
    return b"".join(chunks)


def _parse(model, raw: str, field: str):
    try:
        return model.model_validate_json(raw or "{}")
    except ValidationError as exc:
        raise ApiError(422, "invalid_request", f"Invalid {field}.", {"errors": json.loads(exc.json())}) from None


def _cache_key(image: bytes, options: AnalysisOptions, max_side: int) -> str:
    h = hashlib.sha256(image)
    h.update(options.model_dump_json().encode())
    h.update(str(max_side).encode())
    return h.hexdigest()[:24]


def _client(request: Request) -> str:
    return client_ip(request, get_settings().client_ip_header)


def require_human(request: Request) -> None:
    """When Turnstile is on, expensive endpoints need a session from POST /api/session."""
    if get_settings().turnstile_enabled and app.state.sessions.verify(request.cookies.get(SESSION_COOKIE)) is None:
        raise Rejected(401, "verification_required", "Confirm you are human to continue.")


def rate_limited(request: Request) -> str:
    """Count one analysis or build against the caller's per-minute allowance. Returns the client key."""
    client = _client(request)
    app.state.limiter.check(client)
    return client


async def _run(fn, *args, timeout: float, job_id: str | None = None):
    queue = app.state.queue
    on_start = (lambda: queue.started(job_id)) if job_id else None
    try:
        return await app.state.pool.run(fn, *args, timeout=timeout, on_start=on_start)
    except JobTimeout:
        raise ApiError(504, "timeout", f"Processing took longer than {timeout:g} s and was stopped.") from None
    except WorkerCrashed:
        raise ApiError(503, "worker_restarted", "The worker was restarted while processing; please retry.") from None
    except ImageError as exc:
        raise ApiError(422, "invalid_image", str(exc)) from None
    except ValueError as exc:
        raise ApiError(422, "invalid_settings", str(exc)) from None


# ----------------------------------------------------------------------------- API


@app.get("/api/health")
async def health():
    return {"status": "ok", "version": __version__, "busy_workers": app.state.pool.busy}


@app.get("/api/config")
async def client_config():
    s = get_settings()
    return {
        "max_upload_mb": s.max_upload_mb,
        "max_image_side": s.max_image_side,
        "job_ttl_seconds": s.job_ttl_seconds,
        "version": __version__,
        "turnstile_site_key": s.turnstile_site_key if s.turnstile_enabled else None,
    }


@app.get("/api/session")
async def session_state(request: Request):
    """Whether a human check is required, and whether this browser has already passed it."""
    s = get_settings()
    verified = app.state.sessions.verify(request.cookies.get(SESSION_COOKIE)) is not None
    return {
        "required": s.turnstile_enabled,
        "verified": verified or not s.turnstile_enabled,
        "site_key": s.turnstile_site_key if s.turnstile_enabled else None,
    }


@app.post("/api/session")
async def start_session(request: Request, token: str = Form("")):
    """Exchange a Turnstile token for a signed session cookie."""
    s = get_settings()
    response = JSONResponse({"verified": True})
    if not s.turnstile_enabled:
        return response
    client = _client(request)
    app.state.map_limiter.check(client)  # verification attempts are cheap but not free
    if not token or not await verify_turnstile(s.turnstile_secret_key, token, client):
        raise Rejected(403, "verification_failed", "The human check failed. Try again.")
    cookie, ttl = app.state.sessions.issue()
    secure = s.cookie_secure if s.cookie_secure is not None else request.url.scheme == "https"
    response.set_cookie(SESSION_COOKIE, cookie, max_age=ttl, httponly=True, samesite="lax", secure=secure, path="/api")
    return response


@app.post("/api/analyse", response_model=AnalyseResponse, dependencies=[Depends(require_human)])
async def analyse_image(
    file: UploadFile = File(...),
    options: str = Form("{}"),
    filaments: str = Form(""),
    client: str = Depends(rate_limited),
):
    """Detect source colours and regions. Optionally suggest a mapping onto ``filaments``."""
    s = get_settings()
    opts = _parse(AnalysisOptions, options, "options")
    fils = None
    if filaments:
        try:
            fils = [FilamentIn.model_validate(f).model_dump() for f in json.loads(filaments)]
        except (ValueError, ValidationError, TypeError) as exc:
            raise ApiError(422, "invalid_request", f"Invalid filaments: {exc}") from None
    image = await _read_upload(file)
    key = _cache_key(image, opts, s.max_image_side)
    ticket = "analyse-" + secrets.token_hex(8)
    app.state.queue.admit(ticket, client, "analyse")
    try:
        analysis, payload = await _run(
            worker.run_analysis, image, opts.model_dump(), s.max_image_side, fils, timeout=s.analyse_timeout_seconds, job_id=ticket
        )
    finally:
        app.state.queue.release(ticket)
    app.state.cache.put(key, analysis)
    return {"analysis_id": key, **payload}


@app.post("/api/map", response_model=MapResponse, dependencies=[Depends(require_human)])
async def map_colours(req: MapRequest, request: Request):
    """Suggest a cluster -> filament mapping (cheap; runs in a thread so it can't block the server)."""
    app.state.map_limiter.check(_client(request))
    k = len(req.clusters)
    if len(req.adjacency) != k or any(len(row) != k for row in req.adjacency):
        raise ApiError(422, "invalid_request", "adjacency must be a square matrix matching the clusters")
    result = await run_in_threadpool(
        suggest_mapping,
        [hex_to_lab(c.hex) for c in req.clusters],
        [c.share for c in req.clusters],
        req.adjacency,
        [hex_to_lab(f.hex) for f in req.filaments],
        fixed=req.fixed,
    )
    return {"mapping": result.assignment, "method": result.method}


async def _prepare_build(file: UploadFile, settings: str, client: str):
    s = get_settings()
    req = _parse(BuildRequest, settings, "settings")
    image = await _read_upload(file)
    key = _cache_key(image, req.analysis, s.max_image_side)
    job_id, job_dir = app.state.jobs.create()
    try:
        app.state.queue.admit(job_id, client, "build")
    except Rejected:
        app.state.jobs.discard(job_id)
        raise
    return req, image, key, job_id, job_dir


async def _execute_build(req: BuildRequest, image: bytes, key: str, job_id: str, job_dir: Path) -> dict:
    s = get_settings()
    cached = app.state.cache.get(key)
    try:
        analysis, stats = await _run(
            worker.run_build,
            None if cached is not None else image,
            cached,
            req.model_dump(),
            str(job_dir),
            s.max_image_side,
            timeout=s.job_timeout_seconds,
            job_id=job_id,
        )
    except ApiError:
        app.state.jobs.discard(job_id)
        raise
    finally:
        app.state.queue.release(job_id)
    app.state.cache.put(key, analysis)
    base = f"/api/jobs/{job_id}"
    return {
        "job_id": job_id,
        "preview_url": f"{base}/preview.png",
        "glb_url": f"{base}/model.glb",
        "downloads": {"3mf": f"{base}/download?format=3mf", "stl-zip": f"{base}/download?format=stl-zip"},
        **stats,
    }


@app.post("/api/build", response_model=BuildResponse, dependencies=[Depends(require_human)])
async def build(file: UploadFile = File(...), settings: str = Form(...), client: str = Depends(rate_limited)):
    """Build the relief and wait for it. Returns stats plus URLs for the preview, GLB and downloads."""
    req, image, key, job_id, job_dir = await _prepare_build(file, settings, client)
    return await _execute_build(req, image, key, job_id, job_dir)


@app.post("/api/builds", status_code=202, dependencies=[Depends(require_human)])
async def start_build(file: UploadFile = File(...), settings: str = Form(...), client: str = Depends(rate_limited)):
    """Start a build in the background. Poll /api/jobs/{job_id}/status for progress and the result."""
    req, image, key, job_id, job_dir = await _prepare_build(file, settings, client)
    job = {"state": "queued", "started": time.time(), "result": None, "error": None}

    async def runner():
        try:
            job["result"] = BuildResponse.model_validate(await _execute_build(req, image, key, job_id, job_dir)).model_dump()
            job["state"] = "done"
        except ApiError as exc:
            job["state"] = "error"
            job["error"] = {"code": exc.code, "message": exc.message, "detail": exc.detail}
        except Exception:  # never leave a job "running" forever
            log.exception("build %s failed", job_id)
            app.state.jobs.discard(job_id)
            app.state.queue.release(job_id)
            job["state"] = "error"
            job["error"] = {"code": "internal_error", "message": "The build failed unexpectedly.", "detail": {}}

    job["task"] = asyncio.create_task(runner())
    app.state.builds[job_id] = job
    return {"job_id": job_id, "status_url": f"/api/jobs/{job_id}/status"}


@app.get("/api/jobs/{job_id}/status")
async def job_status(job_id: str):
    """Progress of a background build: state, stage text, fraction done, and the result when done."""
    job = app.state.builds.get(job_id)
    if job is None:
        raise ApiError(404, "job_not_found", "This job has expired or does not exist. Build again.")
    out = {"job_id": job_id, "state": job["state"], "elapsed_s": round(time.time() - job["started"], 1)}
    if job["state"] == "done":
        out.update(stage="Done", progress=1.0, result=job["result"])
    elif job["state"] == "error":
        out.update(stage="Failed", progress=0.0, error=job["error"])
    else:
        out.update(stage="Waiting in line", progress=0.0, queue_position=app.state.queue.position(job_id))
        path = app.state.jobs.path(job_id)
        if path is not None and (path / "progress.json").is_file():
            try:
                out.update(json.loads((path / "progress.json").read_text(encoding="utf8")), state="running")
            except (OSError, ValueError):
                out["state"] = "running"  # being rewritten right now; the next poll will read it
    return out


def _job_file(job_id: str, name: str) -> Path:
    path = app.state.jobs.path(job_id)
    if path is None or not (path / name).is_file():
        raise ApiError(404, "job_not_found", "This job has expired or does not exist. Build again.")
    return path / name


@app.get("/api/jobs/{job_id}")
async def job_result(job_id: str):
    return JSONResponse(json.loads(_job_file(job_id, "result.json").read_text()))


@app.get("/api/jobs/{job_id}/preview.png")
async def job_preview(job_id: str):
    return FileResponse(_job_file(job_id, "preview.png"), media_type="image/png")


@app.get("/api/jobs/{job_id}/model.glb")
async def job_glb(job_id: str):
    return FileResponse(_job_file(job_id, "model.glb"), media_type="model/gltf-binary")


@app.get("/api/jobs/{job_id}/download")
async def job_download(job_id: str, format: str = "3mf"):
    files = {"3mf": ("relief.3mf", "model/3mf", ".3mf"), "stl-zip": ("relief_stl.zip", "application/zip", "_stl.zip")}
    if format not in files:
        raise ApiError(422, "invalid_request", "format must be 3mf or stl-zip")
    name, media, suffix = files[format]
    path = _job_file(job_id, name)
    title = json.loads(_job_file(job_id, "result.json").read_text()).get("title", "relief")
    safe = "".join(c if c.isalnum() or c in "-_ " else "_" for c in title).strip().replace(" ", "_") or "relief"
    return FileResponse(path, media_type=media, filename=f"{safe}{suffix}")


@app.api_route("/api/{rest:path}", methods=["GET", "POST", "PUT", "DELETE", "PATCH"])
async def api_not_found(rest: str):
    raise ApiError(404, "not_found", "Unknown API endpoint.")


# ----------------------------------------------------------------------------- frontend


@app.get("/{path:path}", include_in_schema=False)
async def spa(path: str):
    static = get_settings().resolved_static_dir()
    if static is None:
        return Response("LayerLift API is running. The frontend has not been built.", media_type="text/plain")
    target = (static / path).resolve()
    if path and target.is_file() and static.resolve() in target.parents:
        return FileResponse(target)
    return FileResponse(static / "index.html")

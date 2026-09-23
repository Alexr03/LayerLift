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
from dataclasses import dataclass
from pathlib import Path

import httpx
from fastapi import Depends, FastAPI, File, Form, Request, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, Response, StreamingResponse
from pydantic import ValidationError
from starlette.background import BackgroundTask

from relief import __version__
from relief.colour import hex_to_lab
from relief.imageio import ImageError
from relief.mapping import suggest_mapping

from . import worker
from .config import get_settings
from .jobs import JobStore, LRUCache
from .pb import Limits, PocketBase, User, default_limits, expiry, record_id
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
    app.state.pb = PocketBase(settings) if settings.pocketbase_url else None
    if app.state.pb is not None:
        app.state.pb.sync.start()
        # Load the tiers now, so the upload guard knows the largest allowance from the start.
        asyncio.create_task(app.state.pb.tiers())
        log.info("Accounts are on (PocketBase at %s)", settings.pocketbase_url)
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
                if app.state.pb is not None and (records := await app.state.pb.delete_expired()):
                    log.info("removed %d expired job records", records)
            except Exception:  # pragma: no cover - never let the sweeper die
                log.exception("job sweep failed")
            await asyncio.sleep(min(300, max(10, settings.job_ttl_seconds // 4)))

    task = asyncio.create_task(sweeper())
    try:
        yield
    finally:
        task.cancel()
        app.state.pool.shutdown()
        if app.state.pb is not None:
            await app.state.pb.close()


_docs = get_settings().enable_docs
app = FastAPI(
    title="LayerLift",
    version=__version__,
    lifespan=lifespan,
    docs_url="/api/docs" if _docs else None,
    redoc_url=None,
    openapi_url="/api/openapi.json" if _docs else None,
)
# Compress text responses (the JS bundle shrinks to about a third). Event streams are left alone
# by default, and so is anything already compressed.
app.add_middleware(
    GZipMiddleware,
    minimum_size=1024,
    exclude_content_types=("text/event-stream", "image/png", "application/zip", "model/3mf", "model/gltf-binary"),
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
    # PocketBase's dashboard (proxied under /pb) brings its own pages; the policy is for ours.
    if h.get("content-type", "").startswith("text/html") and not request.url.path.startswith("/pb/"):
        h.setdefault("Content-Security-Policy", CSP)
    return response


@app.middleware("http")
async def limit_upload_size(request: Request, call_next):
    """Refuse oversized uploads before reading them. The exact per-tier limit is checked later."""
    if request.url.path.startswith("/pb/"):
        return await call_next(request)  # PocketBase enforces its own limits
    length = request.headers.get("content-length")
    pb = getattr(app.state, "pb", None)
    cap = pb.max_upload_bytes if pb is not None else get_settings().max_upload_bytes
    if request.method == "POST" and length and length.isdigit() and int(length) > cap + 256 * 1024:  # room for form fields
        return _error(413, "file_too_large", f"Uploads are limited to {cap / 1024 / 1024:g} MB.")
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


async def _read_upload(file: UploadFile, limits: Limits) -> bytes:
    chunks, size = [], 0
    while chunk := await file.read(1 << 20):
        size += len(chunk)
        if size > limits.max_upload_bytes:
            hint = "" if limits.tier != "anonymous" or app.state.pb is None else " Sign in for larger uploads."
            raise ApiError(413, "file_too_large", f"Uploads are limited to {limits.max_upload_mb:g} MB.{hint}")
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


@dataclass(frozen=True)
class Caller:
    """Who is asking: their IP, their account (if signed in) and the limits that apply."""

    ip: str
    user: User | None
    limits: Limits

    @property
    def key(self) -> str:
        """What the rate limits and the job queue count against: the account, else the IP."""
        return f"user:{self.user.id}" if self.user else self.ip

    def info(self, title: str) -> dict:
        return {"ip": self.ip, "user": self.user.email if self.user else None, "tier": self.limits.tier, "title": title}


def _auth_token(request: Request) -> str:
    """The PocketBase token sent by the frontend ("Bearer <token>" or the bare token)."""
    value = request.headers.get("authorization", "").strip()
    return value[7:].strip() if value.lower().startswith("bearer ") else value


async def caller(request: Request) -> Caller:
    ip = _client(request)
    pb: PocketBase | None = app.state.pb
    if pb is None:
        return Caller(ip, None, default_limits(get_settings()))
    token = _auth_token(request)
    user = await pb.verify_user(token, ip) if token else None
    return Caller(ip, user, await pb.limits_for(user))


def require_human(request: Request, who: Caller = Depends(caller)) -> None:
    """When Turnstile is on, expensive endpoints need a session from POST /api/session (or an account)."""
    if who.user is not None:
        return
    if get_settings().turnstile_enabled and app.state.sessions.verify(request.cookies.get(SESSION_COOKIE)) is None:
        raise Rejected(401, "verification_required", "Confirm you are human to continue.")


def rate_limited(who: Caller = Depends(caller)) -> Caller:
    """Count one analysis or build against the caller's per-minute allowance."""
    app.state.limiter.check(who.key, who.limits.rate_limit_per_minute)
    return who


def require_admin(who: Caller = Depends(caller)) -> Caller:
    if who.user is None:
        raise ApiError(401, "sign_in_required", "Sign in first.")
    if not who.user.is_admin:
        raise ApiError(403, "forbidden", "Only administrators can do that.")
    return who


# ----------------------------------------------------------------------------- job records


def _record(job_id: str, who: Caller, kind: str, title: str) -> None:
    """Start the job's PocketBase record (when accounts are on). Written in the background."""
    pb: PocketBase | None = app.state.pb
    if pb is None:
        return
    pb.sync.create(
        record_id(job_id),
        {
            "kind": kind,
            "user": who.user.id if who.user else "",
            "client": who.ip,
            "state": "queued",
            "stage": "Waiting in line",
            "progress": 0,
            "title": title[:200],
            "expires": expiry(24 * get_settings().job_record_days),
        },
    )


def _record_update(job_id: str, **fields) -> None:
    if app.state.pb is not None:
        app.state.pb.sync.update(record_id(job_id), fields)


async def _watch_progress(job_id: str, job_dir: Path) -> None:
    """Mirror the worker's progress file into the job record, at most about once a second."""
    last = None
    path = job_dir / "progress.json"
    while True:
        await asyncio.sleep(1)
        try:
            data = json.loads(path.read_text(encoding="utf8"))
        except (OSError, ValueError):
            continue
        current = (str(data.get("stage", "")), round(float(data.get("progress", 0)), 2))
        if current != last:
            last = current
            _record_update(job_id, state="running", stage=current[0], progress=current[1])


def _safe_name(title: str) -> str:
    return "".join(c if c.isalnum() or c in "-_ " else "_" for c in title).strip().replace(" ", "_") or "relief"


def _store_build(job_id: str, job_dir: Path, stats: dict, who: Caller, elapsed: float) -> str | None:
    """Finish the build's record. Accounts whose tier keeps builds also get the files stored.
    Returns when the stored build expires, or None if it isn't stored."""
    pb: PocketBase | None = app.state.pb
    if pb is None:
        return None
    fields = {"state": "done", "stage": "Done", "progress": 1, "elapsed_s": round(elapsed, 2), "result": stats}
    hours = who.limits.retention_hours if who.user else 0
    if hours <= 0:
        pb.sync.update(record_id(job_id), fields)
        return None
    until = expiry(hours)
    name = _safe_name(stats.get("title", "relief"))
    files = {
        "preview": (f"{name}.png", job_dir / "preview.png", "image/png"),
        "glb": (f"{name}.glb", job_dir / "model.glb", "model/gltf-binary"),
        "model_3mf": (f"{name}.3mf", job_dir / "relief.3mf", "model/3mf"),
        "stl_zip": (f"{name}_stl.zip", job_dir / "relief_stl.zip", "application/zip"),
    }
    pb.sync.attach(record_id(job_id), files, {**fields, "expires": until})
    return until


async def _run(fn, *args, timeout: float, job_id: str | None = None, stage: str = "Working"):
    queue = app.state.queue

    def on_start():
        queue.started(job_id)
        _record_update(job_id, state="running", stage=stage)

    on_start = on_start if job_id else None
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
        "accounts": app.state.pb is not None,
    }


@app.get("/api/me")
async def me(who: Caller = Depends(caller)):
    """The signed-in account (or null) and the limits that apply to this visitor."""
    return {"accounts": app.state.pb is not None, "user": who.user.public() if who.user else None, "limits": who.limits.public()}


@app.get("/api/session")
async def session_state(request: Request, who: Caller = Depends(caller)):
    """Whether a human check is required, and whether this browser has already passed it."""
    s = get_settings()
    verified = who.user is not None or app.state.sessions.verify(request.cookies.get(SESSION_COOKIE)) is not None
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
    who: Caller = Depends(rate_limited),
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
    image = await _read_upload(file, who.limits)
    max_side = who.limits.max_image_side
    key = _cache_key(image, opts, max_side)
    ticket = "analyse-" + secrets.token_hex(8)
    title = file.filename or "image"
    app.state.queue.admit(ticket, who.key, "analyse", per_client=who.limits.max_jobs, info=who.info(title))
    _record(ticket, who, "analyse", title)
    started = time.time()
    try:
        analysis, payload = await _run(
            worker.run_analysis,
            image,
            opts.model_dump(),
            max_side,
            fils,
            timeout=s.analyse_timeout_seconds,
            job_id=ticket,
            stage="Finding colours",
        )
    except ApiError as exc:
        _record_update(ticket, state="error", stage="Failed", error=exc.message, elapsed_s=round(time.time() - started, 2))
        raise
    finally:
        app.state.queue.release(ticket)
    _record_update(ticket, state="done", stage="Done", progress=1, elapsed_s=round(time.time() - started, 2))
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


async def _prepare_build(file: UploadFile, settings: str, who: Caller):
    req = _parse(BuildRequest, settings, "settings")
    image = await _read_upload(file, who.limits)
    key = _cache_key(image, req.analysis, who.limits.max_image_side)
    job_id, job_dir = app.state.jobs.create()
    try:
        app.state.queue.admit(job_id, who.key, "build", per_client=who.limits.max_jobs, info=who.info(req.title))
    except Rejected:
        app.state.jobs.discard(job_id)
        raise
    _record(job_id, who, "build", req.title)
    return req, image, key, job_id, job_dir


async def _execute_build(req: BuildRequest, image: bytes, key: str, job_id: str, job_dir: Path, who: Caller) -> dict:
    cached = app.state.cache.get(key)
    watcher = asyncio.create_task(_watch_progress(job_id, job_dir)) if app.state.pb is not None else None
    started = time.time()
    try:
        analysis, stats = await _run(
            worker.run_build,
            None if cached is not None else image,
            cached,
            req.model_dump(),
            str(job_dir),
            who.limits.max_image_side,
            timeout=who.limits.job_timeout_seconds,
            job_id=job_id,
            stage="Starting the build",
        )
    except ApiError as exc:
        app.state.jobs.discard(job_id)
        _record_update(job_id, state="error", stage="Failed", error=exc.message, elapsed_s=round(time.time() - started, 2))
        raise
    except BaseException:  # cancelled while waiting, or unexpected: leave nothing behind
        app.state.jobs.discard(job_id)
        raise
    finally:
        if watcher is not None:
            watcher.cancel()
        app.state.queue.release(job_id)
    app.state.cache.put(key, analysis)
    saved_until = _store_build(job_id, job_dir, stats, who, time.time() - started)
    base = f"/api/jobs/{job_id}"
    return {
        "job_id": job_id,
        "preview_url": f"{base}/preview.png",
        "glb_url": f"{base}/model.glb",
        "downloads": {"3mf": f"{base}/download?format=3mf", "stl-zip": f"{base}/download?format=stl-zip"},
        "saved_until": saved_until,
        **stats,
    }


@app.post("/api/build", response_model=BuildResponse, dependencies=[Depends(require_human)])
async def build(file: UploadFile = File(...), settings: str = Form(...), who: Caller = Depends(rate_limited)):
    """Build the relief and wait for it. Returns stats plus URLs for the preview, GLB and downloads."""
    req, image, key, job_id, job_dir = await _prepare_build(file, settings, who)
    return await _execute_build(req, image, key, job_id, job_dir, who)


@app.post("/api/builds", status_code=202, dependencies=[Depends(require_human)])
async def start_build(file: UploadFile = File(...), settings: str = Form(...), who: Caller = Depends(rate_limited)):
    """Start a build in the background. Poll /api/jobs/{job_id}/status for progress and the result."""
    req, image, key, job_id, job_dir = await _prepare_build(file, settings, who)
    job = {"state": "queued", "started": time.time(), "result": None, "error": None}

    async def runner():
        try:
            job["result"] = BuildResponse.model_validate(await _execute_build(req, image, key, job_id, job_dir, who)).model_dump()
            job["state"] = "done"
        except ApiError as exc:
            job["state"] = "error"
            job["error"] = {"code": exc.code, "message": exc.message, "detail": exc.detail}
        except asyncio.CancelledError:
            # An administrator cancelled it while it waited (see admin_cancel). Not re-raised:
            # the cancellation was ours and everything is cleaned up.
            job["state"] = "error"
            job["error"] = {"code": "cancelled", "message": "An administrator cancelled this build before it started.", "detail": {}}
            _record_update(job_id, state="cancelled", stage="Cancelled")
        except Exception:  # never leave a job "running" forever
            log.exception("build %s failed", job_id)
            app.state.jobs.discard(job_id)
            app.state.queue.release(job_id)
            job["state"] = "error"
            job["error"] = {"code": "internal_error", "message": "The build failed unexpectedly.", "detail": {}}
            _record_update(job_id, state="error", stage="Failed", error="The build failed unexpectedly.")

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
    return FileResponse(path, media_type=media, filename=f"{_safe_name(title)}{suffix}")


# ----------------------------------------------------------------------------- admin


@app.get("/api/admin/status")
async def admin_status(_: Caller = Depends(require_admin)):
    """Workers, the queue, and every job running or waiting right now (with who started it)."""
    queue, pool, now = app.state.queue, app.state.pool, time.monotonic()
    jobs = [
        {
            "job_id": jid,
            "record_id": record_id(jid),
            "kind": job.kind,
            "state": "running" if job.started else "queued",
            "position": queue.position(jid),
            "age_s": round(now - job.admitted_at, 1),
            "cancellable": not job.started and jid in app.state.builds,
            **job.info,
        }
        for jid, job in queue.jobs.items()
    ]
    return {
        "version": __version__,
        "workers": pool.size,
        "busy_workers": pool.busy,
        "capacity": queue.capacity,
        "running": sum(1 for j in jobs if j["state"] == "running"),
        "waiting": queue.waiting,
        "jobs": jobs,
    }


@app.post("/api/admin/jobs/{job_id}/cancel")
async def admin_cancel(job_id: str, who: Caller = Depends(require_admin)):
    """Cancel a build that is still waiting for a worker. Running builds can't be stopped singly."""
    build, queued = app.state.builds.get(job_id), app.state.queue.jobs.get(job_id)
    if build is None or queued is None or build.get("task") is None:
        raise ApiError(404, "job_not_found", "No waiting build with that id.")
    if queued.started:
        raise ApiError(409, "already_running", "This build has started; only waiting builds can be cancelled.")
    build["task"].cancel()
    log.info("%s cancelled build %s", who.user.email if who.user else "?", job_id)
    return {"cancelled": True}


# ----------------------------------------------------------------------------- accounts (PocketBase)

# Hop-by-hop headers (and ones the proxy sets itself) are not passed through.
_HOP = {
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "trailers",
    "transfer-encoding", "upgrade", "host", "content-length", "x-forwarded-for", "x-forwarded-proto", "x-forwarded-host",
}


@app.api_route("/pb/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"], include_in_schema=False)
async def pocketbase_proxy(path: str, request: Request):
    """PocketBase, under this site's origin: its API (/pb/api/...), realtime events and dashboard (/pb/_/)."""
    pb: PocketBase | None = app.state.pb
    if pb is None:
        raise ApiError(404, "accounts_disabled", "Accounts are not enabled on this server.")
    if not get_settings().pocketbase_dashboard and (path == "_" or path.startswith("_/")):
        raise ApiError(404, "not_found", "The PocketBase dashboard is not exposed on this server.")
    headers = [(k, v) for k, v in request.headers.items() if k.lower() not in _HOP]
    headers += [("x-forwarded-for", _client(request)), ("x-forwarded-proto", request.url.scheme), ("x-forwarded-host", request.url.netloc)]
    url = f"{pb.url}/{path}" + (f"?{request.url.query}" if request.url.query else "")
    body = request.stream() if request.method in ("POST", "PUT", "PATCH", "DELETE") else None
    upstream = pb.proxy_client.build_request(request.method, url, headers=headers, content=body)
    try:
        resp = await pb.proxy_client.send(upstream, stream=True)
    except httpx.HTTPError as exc:
        log.warning("PocketBase proxy: %s", exc)
        raise ApiError(502, "accounts_unavailable", "The account service is not responding. Try again shortly.") from None
    out = {}
    for k, v in resp.headers.multi_items():
        if k.lower() in _HOP:
            continue
        if k.lower() == "location" and v.startswith("/"):
            v = "/pb" + v  # PocketBase redirects to its own root paths
        out[k] = v
    return StreamingResponse(resp.aiter_raw(), status_code=resp.status_code, headers=out, background=BackgroundTask(resp.aclose))


@app.api_route("/api/{rest:path}", methods=["GET", "POST", "PUT", "DELETE", "PATCH"])
async def api_not_found(rest: str):
    raise ApiError(404, "not_found", "Unknown API endpoint.")


# ----------------------------------------------------------------------------- frontend


_index_cache: tuple[float, str] | None = None


def _index_template(static: Path) -> str:
    global _index_cache
    index = static / "index.html"
    mtime = index.stat().st_mtime
    if _index_cache is None or _index_cache[0] != mtime:
        _index_cache = (mtime, index.read_text(encoding="utf8"))
    return _index_cache[1]


async def _bootstrap() -> dict:
    """Start-up data carried in the page itself (as fresh as the page). The account and limits are
    not included: the app holds its loading screen until /api/me confirms them."""
    s = get_settings()
    return {"version": __version__, "turnstile_site_key": s.turnstile_site_key if s.turnstile_enabled else None}


@app.get("/{path:path}", include_in_schema=False)
async def spa(path: str):
    static = get_settings().resolved_static_dir()
    if static is None:
        return Response("LayerLift API is running. The frontend has not been built.", media_type="text/plain")
    target = (static / path).resolve()
    if path and target.is_file() and static.resolve() in target.parents:
        # Vite names built assets by content hash, so they never change: cache them for good.
        immutable = path.startswith("assets/")
        headers = {"Cache-Control": "public, max-age=31536000, immutable" if immutable else "no-cache"}
        return FileResponse(target, headers=headers)
    # The page carries its start-up data as a JSON block (not a script, so the CSP allows it).
    data = json.dumps(await _bootstrap()).replace("</", "<\\/")  # "</script>" can't end the block early
    html = _index_template(static).replace(
        "</head>", f'<script id="ll-bootstrap" type="application/json">{data}</script></head>', 1
    )
    return HTMLResponse(html, headers={"Cache-Control": "no-cache"})

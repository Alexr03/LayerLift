"""LayerLift HTTP API (FastAPI). Also serves the built frontend when present."""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import logging
from pathlib import Path

from fastapi import FastAPI, File, Form, Request, UploadFile
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
from .schemas import AnalyseResponse, AnalysisOptions, BuildRequest, BuildResponse, FilamentIn, MapRequest, MapResponse

log = logging.getLogger("layerlift")


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

    async def sweeper():
        while True:
            try:
                removed = app.state.jobs.sweep()
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


app = FastAPI(title="LayerLift", version=__version__, lifespan=lifespan)


# ----------------------------------------------------------------------------- errors


@app.exception_handler(ApiError)
async def api_error_handler(_: Request, exc: ApiError):
    return _error(exc.status, exc.code, exc.message, exc.detail)


@app.exception_handler(RequestValidationError)
async def validation_handler(_: Request, exc: RequestValidationError):
    return _error(422, "invalid_request", "The request is invalid.", {"errors": json.loads(json.dumps(exc.errors(), default=str))})


@app.middleware("http")
async def limit_upload_size(request: Request, call_next):
    length = request.headers.get("content-length")
    limit = get_settings().max_upload_bytes + 256 * 1024  # room for form fields
    if request.method == "POST" and length and length.isdigit() and int(length) > limit:
        return _error(413, "file_too_large", f"Uploads are limited to {get_settings().max_upload_mb:g} MB.")
    return await call_next(request)


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


async def _run(fn, *args, timeout: float):
    try:
        return await app.state.pool.run(fn, *args, timeout=timeout)
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
    return {"max_upload_mb": s.max_upload_mb, "max_image_side": s.max_image_side, "job_ttl_seconds": s.job_ttl_seconds, "version": __version__}


@app.post("/api/analyse", response_model=AnalyseResponse)
async def analyse_image(file: UploadFile = File(...), options: str = Form("{}"), filaments: str = Form("")):
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
    analysis, payload = await _run(worker.run_analysis, image, opts.model_dump(), s.max_image_side, fils, timeout=s.analyse_timeout_seconds)
    app.state.cache.put(key, analysis)
    return {"analysis_id": key, **payload}


@app.post("/api/map", response_model=MapResponse)
async def map_colours(req: MapRequest):
    """Suggest a cluster -> filament mapping (cheap; runs inline)."""
    k = len(req.clusters)
    if len(req.adjacency) != k or any(len(row) != k for row in req.adjacency):
        raise ApiError(422, "invalid_request", "adjacency must be a square matrix matching the clusters")
    result = suggest_mapping(
        [hex_to_lab(c.hex) for c in req.clusters],
        [c.share for c in req.clusters],
        req.adjacency,
        [hex_to_lab(f.hex) for f in req.filaments],
        fixed=req.fixed,
    )
    return {"mapping": result.assignment, "method": result.method}


@app.post("/api/build", response_model=BuildResponse)
async def build(file: UploadFile = File(...), settings: str = Form(...)):
    """Build the relief. Returns stats plus URLs for the preview, the GLB and downloads."""
    s = get_settings()
    req = _parse(BuildRequest, settings, "settings")
    image = await _read_upload(file)
    key = _cache_key(image, req.analysis, s.max_image_side)
    cached = app.state.cache.get(key)
    job_id, job_dir = app.state.jobs.create()
    try:
        analysis, stats = await _run(
            worker.run_build,
            None if cached is not None else image,
            cached,
            req.model_dump(),
            str(job_dir),
            s.max_image_side,
            timeout=s.job_timeout_seconds,
        )
    except ApiError:
        app.state.jobs.discard(job_id)
        raise
    app.state.cache.put(key, analysis)
    base = f"/api/jobs/{job_id}"
    return {
        "job_id": job_id,
        "preview_url": f"{base}/preview.png",
        "glb_url": f"{base}/model.glb",
        "downloads": {"3mf": f"{base}/download?format=3mf", "stl-zip": f"{base}/download?format=stl-zip"},
        **stats,
    }


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

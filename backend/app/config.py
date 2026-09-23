from __future__ import annotations

import tempfile
from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Runtime configuration, from environment variables prefixed LAYERLIFT_."""

    model_config = SettingsConfigDict(env_prefix="LAYERLIFT_")

    max_upload_mb: float = 10.0
    max_image_side: int = 1024  # images are downscaled to this before processing
    job_ttl_seconds: int = 3600  # job outputs are deleted after this long
    job_timeout_seconds: int = 180
    analyse_timeout_seconds: int = 60
    workers: int = 2  # processes available for analysis and builds
    data_dir: Path = Path(tempfile.gettempdir()) / "layerlift"
    static_dir: Path | None = None  # built frontend; defaults to ./static or ../frontend/dist
    analysis_cache_size: int = 16

    # --- protections for public deployments -------------------------------------------
    # Cloudflare Turnstile. When both keys are set, visitors must pass the check once per
    # session before they can analyse or build.
    turnstile_site_key: str = ""
    turnstile_secret_key: str = ""
    # Signs session cookies. Set it so sessions survive restarts; otherwise a random one is used.
    session_secret: str = ""
    session_ttl_seconds: int = 6 * 3600
    # Mark the session cookie Secure. None = only when the request arrived over HTTPS.
    # Set true when TLS ends at Cloudflare or another proxy that does not pass X-Forwarded-Proto.
    cookie_secure: bool | None = None
    # Header carrying the real client IP when behind a proxy, e.g. "CF-Connecting-IP" behind
    # Cloudflare. Only set it if every request really comes through that proxy.
    client_ip_header: str = ""
    # Jobs (analyses + builds) running or waiting, across everyone. Further requests get 503.
    max_queue: int = 8
    # Jobs one client may have running or waiting at once.
    max_jobs_per_client: int = 2
    # Analyses + builds one client may start per minute.
    rate_limit_per_minute: int = 12
    # Mapping suggestions (cheap, but CPU) one client may request per minute.
    map_rate_limit_per_minute: int = 90
    # Serve the interactive API docs at /docs. Off by default for public deployments.
    enable_docs: bool = False
    # Log one line per request with the real client IP (the same one the rate limits use).
    # Replaces uvicorn's access log, which only sees the proxy's address behind Cloudflare.
    access_log: bool = True

    # --- accounts (optional) ------------------------------------------------------------
    # PocketBase, as LayerLift reaches it (e.g. http://pocketbase:8090). Empty = no accounts.
    # Browsers reach it through LayerLift at /pb, so it needn't be public.
    pocketbase_url: str = ""
    # The superuser LayerLift signs in as (created by deploy/pocketbase/entrypoint.sh).
    pocketbase_superuser_email: str = ""
    pocketbase_superuser_password: str = ""
    # Proxy PocketBase's own dashboard at /pb/_/ (it has its own superuser login).
    pocketbase_dashboard: bool = True
    # Job records without stored files (analyses, guests' builds) are deleted after this many days.
    job_record_days: int = 14

    @property
    def turnstile_enabled(self) -> bool:
        return bool(self.turnstile_site_key and self.turnstile_secret_key)

    @property
    def max_upload_bytes(self) -> int:
        return int(self.max_upload_mb * 1024 * 1024)

    def resolved_static_dir(self) -> Path | None:
        if self.static_dir:
            return self.static_dir if self.static_dir.is_dir() else None
        here = Path(__file__).resolve().parent
        for candidate in (here.parent / "static", here.parents[1] / "frontend" / "dist"):
            if (candidate / "index.html").is_file():
                return candidate
        return None


@lru_cache
def get_settings() -> Settings:
    return Settings()

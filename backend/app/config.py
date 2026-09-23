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

"""Per-job temp directories with expiry, and a small in-memory analysis cache."""

from __future__ import annotations

import re
import secrets
import shutil
import time
from collections import OrderedDict
from pathlib import Path

JOB_ID = re.compile(r"^[0-9a-f]{24}$")


class JobStore:
    def __init__(self, root: Path, ttl_seconds: int):
        self.root = root
        self.ttl = ttl_seconds
        self.root.mkdir(parents=True, exist_ok=True)

    def create(self) -> tuple[str, Path]:
        job_id = secrets.token_hex(12)
        path = self.root / job_id
        path.mkdir()
        return job_id, path

    def path(self, job_id: str) -> Path | None:
        if not JOB_ID.match(job_id):
            return None
        p = self.root / job_id
        return p if p.is_dir() else None

    def discard(self, job_id: str) -> None:
        p = self.path(job_id)
        if p is not None:
            shutil.rmtree(p, ignore_errors=True)

    def sweep(self) -> int:
        """Delete job directories older than the TTL. Returns how many were removed."""
        cutoff = time.time() - self.ttl
        removed = 0
        for p in self.root.iterdir():
            if p.is_dir() and JOB_ID.match(p.name) and p.stat().st_mtime < cutoff:
                shutil.rmtree(p, ignore_errors=True)
                removed += 1
        return removed


class LRUCache:
    def __init__(self, size: int):
        self.size = size
        self._data: OrderedDict = OrderedDict()

    def get(self, key):
        if key not in self._data:
            return None
        self._data.move_to_end(key)
        return self._data[key]

    def put(self, key, value) -> None:
        self._data[key] = value
        self._data.move_to_end(key)
        while len(self._data) > self.size:
            self._data.popitem(last=False)

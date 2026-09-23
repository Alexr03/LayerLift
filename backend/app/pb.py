"""Optional PocketBase integration: accounts, tiers (per-account limits), live job records and
stored builds. Without ``LAYERLIFT_POCKETBASE_URL`` none of this runs and every visitor gets the
limits from the environment, as before.

LayerLift talks to PocketBase as a superuser. Visitors' tokens (from the PocketBase JS SDK) are
checked with ``auth-refresh``; job records are written by a single background task, so a slow
or unavailable PocketBase never holds up an analysis or a build.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import logging
import time
from collections import OrderedDict
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path

import httpx

from .config import Settings

log = logging.getLogger("layerlift")

TOKEN_CACHE_SECONDS = 60
TIER_CACHE_SECONDS = 30
SUPERUSER_TOKEN_SECONDS = 6 * 3600


@dataclass(frozen=True)
class Limits:
    tier: str  # tier name, e.g. "anonymous", "free"
    label: str
    rate_limit_per_minute: int
    max_jobs: int
    max_upload_mb: float
    max_image_side: int
    job_timeout_seconds: int
    retention_hours: int  # how long finished builds are kept in PocketBase; 0 = not stored

    @property
    def max_upload_bytes(self) -> int:
        return int(self.max_upload_mb * 1024 * 1024)

    def public(self) -> dict:
        return {
            "tier": self.tier,
            "label": self.label,
            "rate_limit_per_minute": self.rate_limit_per_minute,
            "max_jobs": self.max_jobs,
            "max_upload_mb": self.max_upload_mb,
            "max_image_side": self.max_image_side,
            "job_timeout_seconds": self.job_timeout_seconds,
            "retention_hours": self.retention_hours,
        }


def default_limits(settings: Settings) -> Limits:
    """The limits from the environment: everyone's without PocketBase, and the fallback with it."""
    return Limits(
        tier="anonymous",
        label="Guest",
        rate_limit_per_minute=settings.rate_limit_per_minute,
        max_jobs=settings.max_jobs_per_client,
        max_upload_mb=settings.max_upload_mb,
        max_image_side=settings.max_image_side,
        job_timeout_seconds=settings.job_timeout_seconds,
        retention_hours=0,
    )


@dataclass(frozen=True)
class User:
    id: str
    email: str
    name: str
    role: str
    tier_id: str
    verified: bool

    @property
    def is_admin(self) -> bool:
        return self.role == "admin"

    def public(self) -> dict:
        return {"id": self.id, "email": self.email, "name": self.name, "role": self.role or "user", "verified": self.verified}


def record_id(job_id: str) -> str:
    """PocketBase record id for a LayerLift job: ids are 15 characters of [a-z0-9]."""
    return job_id.rsplit("-", 1)[-1][:15]


def pb_date(dt: datetime) -> str:
    return dt.astimezone(UTC).strftime("%Y-%m-%d %H:%M:%S.000Z")


def _tier_limits(item: dict, fallback: Limits) -> Limits:
    def num(key: str, cast):
        value = item.get(key)
        return cast(value) if isinstance(value, int | float) and value > 0 else getattr(fallback, key)

    retention = item.get("retention_hours")
    return Limits(
        tier=item.get("name") or fallback.tier,
        label=item.get("label") or item.get("name") or fallback.label,
        rate_limit_per_minute=num("rate_limit_per_minute", int),
        max_jobs=num("max_jobs", int),
        max_upload_mb=num("max_upload_mb", float),
        max_image_side=num("max_image_side", int),
        job_timeout_seconds=num("job_timeout_seconds", int),
        retention_hours=int(retention) if isinstance(retention, int | float) and retention >= 0 else 0,
    )


class JobSync:
    """Writes job records in the background, in order, merging updates that pile up.

    ``create``/``update``/``attach`` only queue work; one task sends it. Updates to a record
    that hasn't been sent yet are merged into the pending write, so frequent progress changes
    cost one request per round, not one each.
    """

    def __init__(self, pb: PocketBase):
        self.pb = pb
        self.pending: OrderedDict[str, dict] = OrderedDict()
        self.wake = asyncio.Event()
        self.task: asyncio.Task | None = None

    def start(self) -> None:
        self.task = asyncio.create_task(self._run())

    async def stop(self) -> None:
        if self.task:
            self.task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self.task

    def _queue(self, rid: str, fields: dict | None = None, create: bool = False, files: dict | None = None) -> None:
        entry = self.pending.setdefault(rid, {"create": False, "fields": {}, "files": {}})
        entry["create"] |= create
        entry["fields"].update(fields or {})
        entry["files"].update(files or {})
        self.wake.set()

    def create(self, rid: str, fields: dict) -> None:
        self._queue(rid, fields, create=True)

    def update(self, rid: str, fields: dict) -> None:
        self._queue(rid, fields)

    def attach(self, rid: str, files: dict[str, tuple[str, Path, str]], fields: dict | None = None) -> None:
        """Upload files ({field: (download name, path, media type)}) to the record."""
        self._queue(rid, fields, files=files)

    async def flush(self) -> None:
        """Send everything queued so far (tests use this)."""
        while self.pending:
            await self._send_one()

    async def _run(self) -> None:
        while True:
            await self.wake.wait()
            self.wake.clear()
            while self.pending:
                await self._send_one()

    async def _send_one(self) -> None:
        rid, entry = self.pending.popitem(last=False)
        try:
            if entry["create"]:
                await self.pb.request("POST", "/api/collections/jobs/records", json={"id": rid, **entry["fields"]})
            elif entry["fields"]:
                await self.pb.request("PATCH", f"/api/collections/jobs/records/{rid}", json=entry["fields"])
            if entry["files"]:
                files = {}
                for field, (name, path, media) in entry["files"].items():
                    files[field] = (name, await asyncio.to_thread(Path(path).read_bytes), media)
                await self.pb.request("PATCH", f"/api/collections/jobs/records/{rid}", files=files, timeout=120)
        except Exception as exc:  # a lost update only makes the record stale
            log.warning("PocketBase: could not write job %s: %s", rid, exc)


class PocketBase:
    def __init__(self, settings: Settings, transport: httpx.AsyncBaseTransport | None = None):
        self.settings = settings
        self.url = settings.pocketbase_url.rstrip("/")
        self.client = httpx.AsyncClient(base_url=self.url, timeout=10, transport=transport)
        # Proxied requests include the realtime event stream, which stays open indefinitely.
        self.proxy_client = httpx.AsyncClient(timeout=httpx.Timeout(10, read=None), transport=transport)
        self.sync = JobSync(self)
        self._token = ""
        self._token_at = 0.0
        self._auth_lock = asyncio.Lock()
        self._users: dict[str, tuple[float, User | None]] = {}
        self._tiers: tuple[float, dict[str, Limits], dict[str, str]] | None = None
        self.max_upload_bytes = settings.max_upload_bytes  # largest of any tier, for the upload guard

    async def close(self) -> None:
        await self.sync.stop()
        await self.client.aclose()
        await self.proxy_client.aclose()

    # ------------------------------------------------------------------ superuser requests

    async def _superuser_token(self, force: bool = False) -> str:
        async with self._auth_lock:
            if force or not self._token or time.monotonic() - self._token_at > SUPERUSER_TOKEN_SECONDS:
                r = await self.client.post(
                    "/api/collections/_superusers/auth-with-password",
                    json={"identity": self.settings.pocketbase_superuser_email, "password": self.settings.pocketbase_superuser_password},
                )
                r.raise_for_status()
                self._token, self._token_at = r.json()["token"], time.monotonic()
            return self._token

    async def request(self, method: str, path: str, **kwargs) -> httpx.Response:
        """A request as the superuser. Re-authenticates once if the token was rejected."""
        for attempt in range(2):
            token = await self._superuser_token(force=attempt > 0)
            r = await self.client.request(method, path, headers={"Authorization": token}, **kwargs)
            if r.status_code != 401:
                r.raise_for_status()
                return r
        r.raise_for_status()
        return r

    # ------------------------------------------------------------------ visitors

    async def verify_user(self, token: str, ip: str) -> User | None:
        """The account behind a PocketBase auth token, or None if it isn't valid."""
        key = hashlib.sha256(token.encode()).hexdigest()
        now = time.monotonic()
        cached = self._users.get(key)
        if cached and cached[0] > now:
            return cached[1]
        try:
            r = await self.client.post(
                "/api/collections/users/auth-refresh", headers={"Authorization": token, "X-Forwarded-For": ip}
            )
        except httpx.HTTPError as exc:
            log.warning("PocketBase: could not check a sign-in: %s", exc)
            return None  # not cached: try again on the next request
        user = None
        if r.status_code == 200:
            rec = r.json().get("record", {})
            user = User(
                id=rec.get("id", ""),
                email=rec.get("email", ""),
                name=rec.get("name", ""),
                role=rec.get("role", "") or "user",
                tier_id=rec.get("tier", "") or "",
                verified=bool(rec.get("verified")),
            )
        elif r.status_code >= 500:
            log.warning("PocketBase: sign-in check failed with %s", r.status_code)
            return None
        if len(self._users) > 5000:
            self._users = {k: v for k, v in self._users.items() if v[0] > now}
        self._users[key] = (now + TOKEN_CACHE_SECONDS, user)
        return user

    async def tiers(self) -> tuple[dict[str, Limits], dict[str, str]]:
        """Limits by tier name, and tier id -> name. Cached briefly; stale data beats none."""
        now = time.monotonic()
        if self._tiers and self._tiers[0] > now:
            return self._tiers[1], self._tiers[2]
        fallback = default_limits(self.settings)
        try:
            r = await self.request("GET", "/api/collections/tiers/records", params={"perPage": 200})
            items = r.json().get("items", [])
            by_name = {i["name"]: _tier_limits(i, fallback) for i in items if i.get("name")}
            ids = {i["id"]: i["name"] for i in items if i.get("name")}
            self.max_upload_bytes = max([self.settings.max_upload_bytes] + [t.max_upload_bytes for t in by_name.values()])
            self._tiers = (now + TIER_CACHE_SECONDS, by_name, ids)
        except (httpx.HTTPError, ValueError, KeyError) as exc:
            log.warning("PocketBase: could not load tiers: %s", exc)
            if self._tiers is None:
                return {}, {}
            self._tiers = (now + 5, self._tiers[1], self._tiers[2])  # retry soon
        return self._tiers[1], self._tiers[2]

    async def limits_for(self, user: User | None) -> Limits:
        by_name, ids = await self.tiers()
        fallback = default_limits(self.settings)
        if user is None:
            return by_name.get("anonymous", fallback)
        name = ids.get(user.tier_id, "free")
        return by_name.get(name) or by_name.get("free") or fallback

    # ------------------------------------------------------------------ housekeeping

    async def delete_expired(self) -> int:
        """Delete job records (and their files) past their expiry. Returns how many."""
        removed = 0
        try:
            r = await self.request(
                "GET",
                "/api/collections/jobs/records",
                params={"filter": f'expires != "" && expires < "{pb_date(datetime.now(UTC))}"', "perPage": 200, "fields": "id"},
            )
            for item in r.json().get("items", []):
                await self.request("DELETE", f"/api/collections/jobs/records/{item['id']}")
                removed += 1
        except httpx.HTTPError as exc:
            log.warning("PocketBase: could not delete expired jobs: %s", exc)
        return removed


def expiry(hours: float) -> str:
    return pb_date(datetime.now(UTC) + timedelta(hours=hours))

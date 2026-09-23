"""Protections for public deployments: human check, sessions, rate limits and a job queue."""

from __future__ import annotations

import hashlib
import hmac
import secrets
import time
from collections import OrderedDict, deque
from dataclasses import dataclass, field

from fastapi import Request

TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify"
SESSION_COOKIE = "ll_session"


class Rejected(Exception):
    """A request refused by a protection. Converted to an API error by the app."""

    def __init__(self, status: int, code: str, message: str, retry_after: int | None = None):
        self.status, self.code, self.message, self.retry_after = status, code, message, retry_after


# ----------------------------------------------------------------------------- clients


def client_ip(request: Request, header: str) -> str:
    """The caller's IP. With ``header`` set (e.g. CF-Connecting-IP) it is trusted over the
    socket address, so only set it when every request passes through that proxy."""
    if header:
        value = request.headers.get(header, "").split(",")[0].strip()
        if value:
            return value
    return request.client.host if request.client else "unknown"


# ----------------------------------------------------------------------------- sessions


class Sessions:
    """Signed, stateless session cookies: "<id>.<expiry>.<hmac>"."""

    def __init__(self, secret: str, ttl_seconds: int):
        self.key = (secret or secrets.token_hex(32)).encode()
        self.ttl = ttl_seconds

    def _sign(self, payload: str) -> str:
        return hmac.new(self.key, payload.encode(), hashlib.sha256).hexdigest()[:32]

    def issue(self) -> tuple[str, int]:
        sid = secrets.token_hex(12)
        expiry = int(time.time()) + self.ttl
        payload = f"{sid}.{expiry}"
        return f"{payload}.{self._sign(payload)}", self.ttl

    def verify(self, cookie: str | None) -> str | None:
        """Return the session id if the cookie is authentic and unexpired."""
        if not cookie or cookie.count(".") != 2:
            return None
        sid, expiry, sig = cookie.split(".")
        if not hmac.compare_digest(sig, self._sign(f"{sid}.{expiry}")):
            return None
        if not expiry.isdigit() or int(expiry) < time.time():
            return None
        return sid


async def verify_turnstile(secret: str, token: str, remote_ip: str | None) -> bool:
    """Ask Cloudflare whether a Turnstile token is valid."""
    import httpx

    data = {"secret": secret, "response": token}
    if remote_ip and remote_ip != "unknown":
        data["remoteip"] = remote_ip
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.post(TURNSTILE_VERIFY_URL, data=data)
        return bool(r.json().get("success"))
    except (httpx.HTTPError, ValueError):
        return False


# ----------------------------------------------------------------------------- rate limiting


class RateLimiter:
    """Sliding one-minute window per key."""

    def __init__(self, per_minute: int):
        self.per_minute = per_minute
        self.hits: dict[str, deque] = {}

    def check(self, key: str) -> None:
        if self.per_minute <= 0:
            return
        now = time.monotonic()
        q = self.hits.setdefault(key, deque())
        while q and q[0] <= now - 60:
            q.popleft()
        if len(q) >= self.per_minute:
            wait = int(60 - (now - q[0])) + 1
            raise Rejected(429, "rate_limited", f"Too many requests. Try again in {wait} s.", retry_after=wait)
        q.append(now)
        if len(self.hits) > 10_000:  # forget idle clients
            for k in [k for k, v in self.hits.items() if not v or v[-1] <= now - 60]:
                del self.hits[k]


# ----------------------------------------------------------------------------- job queue


@dataclass
class _Job:
    client: str
    kind: str
    started: bool = False
    admitted_at: float = field(default_factory=time.monotonic)


class JobQueue:
    """Admission control for analyses and builds.

    ``capacity`` bounds jobs running or waiting across all clients; ``per_client`` bounds
    one client's share. Work beyond that is refused straight away (503 / 429) instead of
    piling up, so a burst of traffic can't exhaust memory or make everyone wait forever.
    Waiting jobs run in arrival order (the worker pool's semaphore is FIFO).
    """

    def __init__(self, capacity: int, per_client: int):
        self.capacity = max(1, capacity)
        self.per_client = max(1, per_client)
        self.jobs: OrderedDict[str, _Job] = OrderedDict()

    def admit(self, job_id: str, client: str, kind: str) -> None:
        if len(self.jobs) >= self.capacity:
            raise Rejected(503, "busy", "LayerLift is busy right now. Try again in a minute.", retry_after=30)
        if sum(1 for j in self.jobs.values() if j.client == client) >= self.per_client:
            raise Rejected(
                429,
                "too_many_jobs",
                "You already have work running. Wait for it to finish, then try again.",
                retry_after=10,
            )
        self.jobs[job_id] = _Job(client, kind)

    def started(self, job_id: str) -> None:
        job = self.jobs.get(job_id)
        if job:
            job.started = True

    def release(self, job_id: str) -> None:
        self.jobs.pop(job_id, None)

    def position(self, job_id: str) -> int | None:
        """1-based place among waiting jobs, or None if running or unknown."""
        n = 0
        for jid, job in self.jobs.items():
            if not job.started:
                n += 1
            if jid == job_id:
                return n if not job.started else None
        return None

    @property
    def waiting(self) -> int:
        return sum(1 for j in self.jobs.values() if not j.started)

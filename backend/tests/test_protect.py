"""Protections for public deployments: queue, rate limits, sessions, Turnstile gate, headers."""

from __future__ import annotations

import json
import time

import pytest
from fastapi.testclient import TestClient

import app.main as main
from app.config import get_settings
from app.protect import JobQueue, RateLimiter, Rejected, Sessions

from .conftest import TURTLES

# ----------------------------------------------------------------------------- units


def test_queue_capacity_per_client_and_position():
    q = JobQueue(capacity=3, per_client=2)
    q.admit("a", "alice", "build")
    q.admit("b", "alice", "build")
    with pytest.raises(Rejected) as exc:
        q.admit("c", "alice", "build")
    assert exc.value.status == 429
    q.admit("c", "bob", "build")
    with pytest.raises(Rejected) as exc:
        q.admit("d", "carol", "build")
    assert exc.value.status == 503 and exc.value.retry_after
    assert [q.position(j) for j in "abc"] == [1, 2, 3]
    q.started("a")
    assert [q.position(j) for j in "abc"] == [None, 1, 2]
    q.release("a")
    q.admit("d", "carol", "build")
    assert q.position("d") == 3 and q.waiting == 3


def test_rate_limiter_blocks_after_limit():
    rl = RateLimiter(per_minute=2)
    rl.check("x")
    rl.check("x")
    with pytest.raises(Rejected) as exc:
        rl.check("x")
    assert exc.value.status == 429 and 1 <= exc.value.retry_after <= 61
    rl.check("y")  # other clients are unaffected


def test_sessions_sign_and_expire():
    s = Sessions("secret", ttl_seconds=60)
    cookie, _ = s.issue()
    assert s.verify(cookie)
    sid, expiry, sig = cookie.split(".")
    assert s.verify(f"{sid}.{int(expiry) + 999}.{sig}") is None  # tampered expiry
    assert Sessions("other-secret", 60).verify(cookie) is None
    assert s.verify("garbage") is None and s.verify(None) is None
    old = Sessions("secret", ttl_seconds=-1)
    stale, _ = old.issue()
    assert s.verify(stale) is None


# ----------------------------------------------------------------------------- app


@pytest.fixture
def configured(monkeypatch):
    """Start the app with the given LAYERLIFT_* settings."""

    def make(**env):
        for k, v in env.items():
            monkeypatch.setenv(f"LAYERLIFT_{k.upper()}", str(v))
        get_settings.cache_clear()
        return TestClient(main.app)

    yield make
    get_settings.cache_clear()


def _analyse(c):
    return c.post("/api/analyse", files={"file": ("t.png", TURTLES.read_bytes(), "image/png")})


def test_turnstile_gate(configured, monkeypatch):
    calls = []

    async def fake_verify(secret, token, ip):
        calls.append((secret, token))
        return token == "good-token"

    monkeypatch.setattr(main, "verify_turnstile", fake_verify)
    with configured(turnstile_site_key="site", turnstile_secret_key="secret", session_secret="s3") as c:
        assert c.get("/api/config").json()["turnstile_site_key"] == "site"
        assert c.get("/api/session").json() == {"required": True, "verified": False, "site_key": "site"}

        r = _analyse(c)
        assert r.status_code == 401 and r.json()["error"]["code"] == "verification_required"
        assert c.post("/api/map", json={}).status_code in (401, 422)

        r = c.post("/api/session", data={"token": "bad-token"})
        assert r.status_code == 403
        r = c.post("/api/session", data={"token": "good-token"})
        assert r.status_code == 200 and "ll_session" in r.cookies
        assert calls[-1] == ("secret", "good-token")
        assert c.get("/api/session").json()["verified"] is True

        assert _analyse(c).status_code == 200


def test_gate_is_off_without_keys(configured):
    with configured() as c:
        assert c.get("/api/session").json() == {"required": False, "verified": True, "site_key": None}
        assert c.post("/api/session", data={"token": ""}).status_code == 200


def test_rate_limit_returns_429_with_retry_after(configured):
    with configured(rate_limit_per_minute=1) as c:
        assert _analyse(c).status_code == 200
        r = _analyse(c)
        assert r.status_code == 429 and r.json()["error"]["code"] == "rate_limited"
        assert int(r.headers["retry-after"]) > 0


def test_full_queue_is_refused_and_status_shows_position(configured):
    with configured(workers=1, max_queue=2, max_jobs_per_client=5) as c:
        settings = json.dumps({"filaments": [{"name": "Black", "hex": "#111111", "height_mm": 2.8}]})
        start = lambda: c.post(  # noqa: E731
            "/api/builds", files={"file": ("t.png", TURTLES.read_bytes(), "image/png")}, data={"settings": settings}
        )
        first, second = start(), start()
        assert first.status_code == 202 and second.status_code == 202
        third = start()
        assert third.status_code == 503 and third.json()["error"]["code"] == "busy"
        assert "retry-after" in third.headers

        status = c.get(second.json()["status_url"]).json()
        assert status["state"] == "queued" and status["queue_position"] == 1
        # Let both finish so the app shuts down cleanly.
        for r in (first, second):
            for _ in range(600):
                if c.get(r.json()["status_url"]).json()["state"] in ("done", "error"):
                    break
                time.sleep(0.2)


def test_security_headers_and_docs_off(configured):
    with configured() as c:
        r = c.get("/")
        assert r.headers["x-content-type-options"] == "nosniff"
        assert r.headers["x-frame-options"] == "DENY"
        if r.headers["content-type"].startswith("text/html"):
            assert "challenges.cloudflare.com" in r.headers["content-security-policy"]
        assert c.get("/api/docs").status_code == 404
        assert c.get("/api/openapi.json").status_code == 404

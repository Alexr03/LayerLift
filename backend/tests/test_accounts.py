"""Accounts via PocketBase: token checks, tiers, job records, the admin API and the /pb proxy.

The unit tests use a fake PocketBase. The integration test runs against a real one and is
skipped unless LAYERLIFT_TEST_POCKETBASE_URL (plus _EMAIL and _PASSWORD for its superuser) is set,
for example with the compose stack's PocketBase:

    docker build -t layerlift-pocketbase deploy/pocketbase
    docker run -d -p 18090:8090 -e PB_SUPERUSER_EMAIL=admin@example.com \\
        -e PB_SUPERUSER_PASSWORD=change-me-please-123 layerlift-pocketbase
"""

from __future__ import annotations

import asyncio
import json
import os
import secrets
import time

import httpx
import pytest
from fastapi.testclient import TestClient

from app.config import Settings, get_settings
from app.pb import JobSync, PocketBase, User, record_id

from .conftest import TURTLES

TIERS = [
    {"id": "t_anon", "name": "anonymous", "label": "Guest", "rate_limit_per_minute": 5, "max_jobs": 1, "max_upload_mb": 4,
     "max_image_side": 512, "job_timeout_seconds": 60, "retention_hours": 0},
    {"id": "t_free", "name": "free", "label": "Free", "rate_limit_per_minute": 20, "max_jobs": 3, "max_upload_mb": 20,
     "max_image_side": 1536, "job_timeout_seconds": 300, "retention_hours": 168},
    {"id": "t_plus", "name": "supporter", "label": "Supporter", "rate_limit_per_minute": 60, "max_jobs": 4, "max_upload_mb": 30,
     "max_image_side": 2048, "job_timeout_seconds": 600, "retention_hours": 720},
]


class FakePocketBase:
    """Enough of PocketBase's API for the client: superuser auth, auth-refresh, tiers, jobs."""

    def __init__(self, tiers=TIERS):
        self.tiers = tiers
        self.users = {"good-token": {"id": "u1", "email": "a@example.com", "role": "", "tier": "", "verified": True},
                      "plus-token": {"id": "u2", "email": "b@example.com", "role": "admin", "tier": "t_plus", "verified": True}}
        self.calls: list[tuple[str, str]] = []
        self.jobs: dict[str, dict] = {}
        self.down = False

    def __call__(self, request: httpx.Request) -> httpx.Response:
        path, method = request.url.path, request.method
        self.calls.append((method, path))
        if self.down:
            raise httpx.ConnectError("down", request=request)
        if path == "/api/collections/_superusers/auth-with-password":
            return httpx.Response(200, json={"token": "su"})
        if path == "/api/collections/users/auth-refresh":
            rec = self.users.get(request.headers.get("authorization", ""))
            return httpx.Response(200, json={"token": "new", "record": rec}) if rec else httpx.Response(401, json={})
        if request.headers.get("authorization") != "su":
            return httpx.Response(401, json={})
        if path == "/api/collections/tiers/records":
            return httpx.Response(200, json={"items": self.tiers})
        if path == "/api/collections/jobs/records" and method == "POST":
            body = json.loads(request.content)
            self.jobs[body["id"]] = body
            return httpx.Response(200, json=body)
        if path.startswith("/api/collections/jobs/records/") and method == "PATCH":
            rid = path.rsplit("/", 1)[1]
            if rid not in self.jobs:
                return httpx.Response(404, json={})
            if request.headers.get("content-type", "").startswith("application/json"):
                self.jobs[rid].update(json.loads(request.content))
            else:
                self.jobs[rid]["files"] = request.content.count(b"filename=")
            return httpx.Response(200, json=self.jobs[rid])
        return httpx.Response(404, json={})


def make_pb(fake: FakePocketBase) -> PocketBase:
    settings = Settings(pocketbase_url="http://pb.test", pocketbase_superuser_email="su@x", pocketbase_superuser_password="pw")
    return PocketBase(settings, transport=httpx.MockTransport(fake))


# ----------------------------------------------------------------------------- units


def test_verify_user_checks_and_caches_tokens():
    fake = FakePocketBase()

    async def go():
        pb = make_pb(fake)
        user = await pb.verify_user("good-token", "1.2.3.4")
        assert user == User("u1", "a@example.com", "", "user", "", True)
        assert await pb.verify_user("good-token", "1.2.3.4") == user
        assert await pb.verify_user("bad-token", "1.2.3.4") is None
        assert await pb.verify_user("bad-token", "1.2.3.4") is None
        await pb.close()

    asyncio.run(go())
    refreshes = [c for c in fake.calls if c[1].endswith("auth-refresh")]
    assert len(refreshes) == 2  # one per token; the repeats came from the cache


def test_limits_follow_tiers_with_fallbacks():
    fake = FakePocketBase()

    async def go():
        pb = make_pb(fake)
        anon = await pb.limits_for(None)
        free = await pb.limits_for(User("u1", "", "", "user", "", True))
        plus = await pb.limits_for(User("u2", "", "", "admin", "t_plus", True))
        unknown = await pb.limits_for(User("u3", "", "", "user", "t_gone", True))
        assert (anon.tier, anon.max_upload_mb, anon.retention_hours) == ("anonymous", 4, 0)
        assert (free.tier, free.max_jobs) == ("free", 3)
        assert (plus.tier, plus.max_image_side, plus.retention_hours) == ("supporter", 2048, 720)
        assert unknown.tier == "free"
        assert pb.max_upload_bytes == 30 * 1024 * 1024  # the largest tier sets the upload guard
        await pb.close()

    asyncio.run(go())


def test_pocketbase_down_falls_back_to_environment_limits():
    fake = FakePocketBase()
    fake.down = True

    async def go():
        pb = make_pb(fake)
        assert await pb.verify_user("good-token", "ip") is None
        limits = await pb.limits_for(None)
        assert limits.rate_limit_per_minute == pb.settings.rate_limit_per_minute
        assert limits.max_upload_mb == pb.settings.max_upload_mb
        await pb.close()

    asyncio.run(go())


def test_job_sync_merges_updates_and_keeps_order():
    fake = FakePocketBase()

    async def go():
        pb = make_pb(fake)
        sync = JobSync(pb)
        sync.create("abc", {"kind": "build", "state": "queued"})
        sync.update("abc", {"state": "running", "progress": 0.2})
        sync.update("abc", {"progress": 0.5})
        await sync.flush()
        sync.update("abc", {"state": "done", "progress": 1})
        sync.update("missing", {"state": "done"})  # a lost record only logs a warning
        await sync.flush()
        await pb.close()

    asyncio.run(go())
    writes = [c for c in fake.calls if "/jobs/records" in c[1]]
    assert writes == [
        ("POST", "/api/collections/jobs/records"),
        ("PATCH", "/api/collections/jobs/records/abc"),
        ("PATCH", "/api/collections/jobs/records/missing"),
    ]
    assert fake.jobs["abc"] == {"id": "abc", "kind": "build", "state": "done", "progress": 1}


def test_record_ids_fit_pocketbase():
    assert record_id("0123456789abcdef01234567") == "0123456789abcde"
    assert record_id("analyse-0123456789abcdef") == "0123456789abcde"


# ----------------------------------------------------------------------------- against a real PocketBase

PB_URL = os.environ.get("LAYERLIFT_TEST_POCKETBASE_URL", "")
PB_EMAIL = os.environ.get("LAYERLIFT_TEST_POCKETBASE_EMAIL", "admin@example.com")
PB_PASSWORD = os.environ.get("LAYERLIFT_TEST_POCKETBASE_PASSWORD", "change-me-please-123")


@pytest.fixture
def live(monkeypatch):
    if not PB_URL:
        pytest.skip("set LAYERLIFT_TEST_POCKETBASE_URL to run against a real PocketBase")
    import app.main as main

    monkeypatch.setenv("LAYERLIFT_POCKETBASE_URL", PB_URL)
    monkeypatch.setenv("LAYERLIFT_POCKETBASE_SUPERUSER_EMAIL", PB_EMAIL)
    monkeypatch.setenv("LAYERLIFT_POCKETBASE_SUPERUSER_PASSWORD", PB_PASSWORD)
    get_settings.cache_clear()
    with TestClient(main.app) as client:
        yield client, main
    get_settings.cache_clear()


def _sign_up(pb: httpx.Client) -> tuple[str, dict]:
    email = f"test-{secrets.token_hex(4)}@example.com"
    r = pb.post("/api/collections/users/records", json={"email": email, "password": "password123", "passwordConfirm": "password123"})
    assert r.status_code == 200, r.text
    time.sleep(1.6)  # PocketBase allows 2 password sign-ins per 3 s per address
    auth = pb.post("/api/collections/users/auth-with-password", json={"identity": email, "password": "password123"}).json()
    return auth["token"], auth["record"]


def test_accounts_end_to_end(live):
    client, main = live
    pb = httpx.Client(base_url=PB_URL, timeout=10)
    token, user = _sign_up(pb)
    auth = {"Authorization": token}

    # The proxy reaches PocketBase under this origin.
    assert client.get("/pb/api/health").json()["code"] == 200
    assert client.get("/api/config").json()["accounts"] is True

    me = client.get("/api/me", headers=auth).json()
    assert me["user"]["email"] == user["email"] and me["limits"]["tier"] == "free"
    assert client.get("/api/me").json()["limits"]["tier"] == "anonymous"

    settings = {"filaments": [{"name": "Black", "hex": "#1C1C1E", "height_mm": 2.8}, {"name": "White", "hex": "#F5F5F5", "height_mm": 3.2}],
                "width_mm": 40, "title": "Account test"}
    files = {"file": ("t.png", TURTLES.read_bytes(), "image/png")}
    r = client.post("/api/build", files=files, data={"settings": json.dumps(settings)}, headers=auth)
    assert r.status_code == 200, r.text
    built = r.json()
    assert built["saved_until"]

    su = pb.post("/api/collections/_superusers/auth-with-password", json={"identity": PB_EMAIL, "password": PB_PASSWORD}).json()["token"]
    rid = record_id(built["job_id"])
    for _ in range(50):  # the record is written in the background
        rec = pb.get(f"/api/collections/jobs/records/{rid}", headers={"Authorization": su}).json()
        if rec.get("model_3mf"):
            break
        time.sleep(0.2)
    assert rec["state"] == "done" and rec["user"] == user["id"] and rec["kind"] == "build"
    assert rec["model_3mf"].endswith(".3mf") and rec["stl_zip"] and rec["preview"] and rec["glb"]
    assert rec["result"]["filament_changes"] == built["filament_changes"]
    # The owner sees their build, without the hidden client IP; a guest sees nothing.
    mine = pb.get("/api/collections/jobs/records", params={"filter": f'id = "{rid}"'}, headers=auth).json()
    assert mine["totalItems"] == 1 and "client" not in mine["items"][0]
    assert pb.get("/api/collections/jobs/records", params={"filter": f'id = "{rid}"'}).json()["totalItems"] == 0

    # Admin endpoints need the admin role.
    assert client.get("/api/admin/status").status_code == 401
    assert client.get("/api/admin/status", headers=auth).status_code == 403
    pb.patch(f"/api/collections/users/records/{user['id']}", json={"role": "admin"}, headers={"Authorization": su})
    main.app.state.pb._users.clear()  # forget the cached role
    status = client.get("/api/admin/status", headers=auth).json()
    assert status["workers"] >= 1 and status["jobs"] == []
    assert client.post("/api/admin/jobs/0123456789abcdef01234567/cancel", headers=auth).status_code == 404
    pb.delete(f"/api/collections/users/records/{user['id']}", headers={"Authorization": su})

"""HTTP API tests (FastAPI TestClient, real worker processes)."""

from __future__ import annotations

import base64
import io
import json
import zipfile

import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.config import get_settings
from app.main import app

from .conftest import TURTLES

FILAMENTS = [
    {"name": "Black", "hex": "#1C1C1E", "height_mm": 2.8},
    {"name": "Blue", "hex": "#1446AA", "height_mm": 3.2},
    {"name": "Apricot", "hex": "#F7B28C", "height_mm": 3.6},
    {"name": "White", "hex": "#F5F5F5", "height_mm": 4.0, "start_from_bed": True},
]


@pytest.fixture(scope="module")
def client():
    get_settings.cache_clear()
    with TestClient(app) as c:
        yield c


@pytest.fixture(scope="module")
def analysed(client):
    r = client.post(
        "/api/analyse",
        files={"file": ("turtles.png", TURTLES.read_bytes(), "image/png")},
        data={"filaments": json.dumps(FILAMENTS)},
    )
    assert r.status_code == 200, r.text
    return r.json()


def test_health(client):
    r = client.get("/api/health")
    assert r.status_code == 200 and r.json()["status"] == "ok"


def test_analyse_returns_clusters_regions_and_mapping(analysed):
    assert 6 <= len(analysed["clusters"]) <= 12
    assert analysed["width"] == 512 and analysed["height"] == 512
    assert len(analysed["suggested_mapping"]) == len(analysed["clusters"])
    outline = analysed["regions"][analysed["outline_region"]]
    assert analysed["clusters"][outline["cluster"]]["hex"] == "#FFFFFF"
    # Region map encodes region id + 1 in RGB.
    img = np.asarray(Image.open(io.BytesIO(base64.b64decode(analysed["region_map_png"]))).convert("RGB")).astype(np.int64)
    ids = (img[..., 0] << 16) + (img[..., 1] << 8) + img[..., 2] - 1
    assert ids.max() == len(analysed["regions"]) - 1
    assert ids[0, 0] == -1  # transparent corner is background
    assert int((ids == outline["id"]).sum()) == outline["area"]


def test_map_endpoint(client, analysed):
    body = {
        "clusters": [{"hex": c["hex"], "share": c["share"]} for c in analysed["clusters"]],
        "adjacency": analysed["adjacency"],
        "filaments": FILAMENTS,
        "fixed": {"0": 1},
    }
    r = client.post("/api/map", json=body)
    assert r.status_code == 200, r.text
    assert r.json()["mapping"][0] == 1


def test_build_and_downloads(client, analysed):
    settings = {
        "title": "Space Turtles",
        "filaments": FILAMENTS,
        "mapping": analysed["suggested_mapping"],
        "region_overrides": {str(analysed["outline_region"]): {"height_mm": 2.8}},
        "width_mm": 100,
    }
    r = client.post(
        "/api/build",
        files={"file": ("turtles.png", TURTLES.read_bytes(), "image/png")},
        data={"settings": json.dumps(settings)},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert len(body["parts"]) == 4
    assert body["size_mm"][0] == pytest.approx(100, abs=0.01)
    assert body["size_mm"][2] == pytest.approx(4.0)
    assert body["total_grams"] > 10
    assert 20 <= body["filament_changes"] <= 32
    assert [p["slot"] for p in body["parts"]] == [1, 2, 3, 4]

    png = client.get(body["preview_url"])
    assert png.status_code == 200 and png.content[:4] == b"\x89PNG"
    glb = client.get(body["glb_url"])
    assert glb.status_code == 200 and glb.content[:4] == b"glTF"
    three = client.get(body["downloads"]["3mf"])
    assert three.status_code == 200
    assert "Space_Turtles.3mf" in three.headers["content-disposition"]
    assert "Metadata/model_settings.config" in zipfile.ZipFile(io.BytesIO(three.content)).namelist()
    stl = client.get(body["downloads"]["stl-zip"])
    assert stl.status_code == 200
    assert sum(n.endswith(".stl") for n in zipfile.ZipFile(io.BytesIO(stl.content)).namelist()) == 4
    assert client.get(f"/api/jobs/{body['job_id']}").json()["filament_changes"] == body["filament_changes"]


def test_invalid_image(client):
    r = client.post("/api/analyse", files={"file": ("x.png", b"not an image", "image/png")})
    assert r.status_code == 422
    assert r.json()["error"]["code"] == "invalid_image"


def test_upload_too_large(client):
    big = b"\x89PNG" + b"\0" * int(get_settings().max_upload_bytes + 10)
    r = client.post("/api/analyse", files={"file": ("big.png", big, "image/png")})
    assert r.status_code == 413
    assert r.json()["error"]["code"] == "file_too_large"


def test_invalid_settings_are_structured(client):
    bad = {"filaments": [{"name": "X", "hex": "nothex"}]}
    r = client.post(
        "/api/build",
        files={"file": ("t.png", TURTLES.read_bytes(), "image/png")},
        data={"settings": json.dumps(bad)},
    )
    assert r.status_code == 422 and r.json()["error"]["code"] == "invalid_request"

    wrong_mapping = {"filaments": FILAMENTS, "mapping": [0, 1]}
    r = client.post(
        "/api/build",
        files={"file": ("t.png", TURTLES.read_bytes(), "image/png")},
        data={"settings": json.dumps(wrong_mapping)},
    )
    assert r.status_code == 422 and r.json()["error"]["code"] == "invalid_settings"


def test_unknown_job_and_endpoint(client):
    assert client.get("/api/jobs/0123456789abcdef01234567/preview.png").status_code == 404
    assert client.get("/api/jobs/..%2F..%2Fetc/preview.png").status_code == 404
    assert client.get("/api/nope").json()["error"]["code"] == "not_found"


def test_background_build_reports_progress(client, analysed):
    import time

    settings = {"filaments": FILAMENTS, "mapping": analysed["suggested_mapping"], "width_mm": 80}
    r = client.post(
        "/api/builds",
        files={"file": ("turtles.png", TURTLES.read_bytes(), "image/png")},
        data={"settings": json.dumps(settings)},
    )
    assert r.status_code == 202, r.text
    status_url = r.json()["status_url"]
    seen = []
    deadline = time.time() + 120
    while time.time() < deadline:
        s = client.get(status_url).json()
        seen.append((s["state"], s["stage"], s["progress"]))
        if s["state"] in ("done", "error"):
            break
        time.sleep(0.2)
    assert s["state"] == "done", s
    assert s["result"]["size_mm"][0] == pytest.approx(80, abs=0.01)
    running = [p for state, _, p in seen if state == "running"]
    assert running, seen
    assert running == sorted(running)  # progress never goes backwards
    assert {stage for state, stage, _ in seen if state == "running"} & {"Fitting colours together", "Building 3D parts"}
    assert client.get(s["result"]["downloads"]["3mf"]).status_code == 200


def test_background_build_reports_errors(client):
    r = client.post(
        "/api/builds",
        files={"file": ("t.png", TURTLES.read_bytes(), "image/png")},
        data={"settings": json.dumps({"filaments": FILAMENTS, "mapping": [0, 1]})},
    )
    status_url = r.json()["status_url"]
    for _ in range(300):
        s = client.get(status_url).json()
        if s["state"] in ("done", "error"):
            break
        __import__("time").sleep(0.2)
    assert s["state"] == "error" and s["error"]["code"] == "invalid_settings"
    assert client.get("/api/jobs/0123456789abcdef01234567/status").status_code == 404


@pytest.fixture
def built_frontend(monkeypatch, tmp_path):
    (tmp_path / "assets").mkdir()
    (tmp_path / "index.html").write_text("<html><head><title>LayerLift</title></head><body></body></html>")
    (tmp_path / "assets" / "index-abc123.js").write_text("console.log('layerlift');\n" * 400)
    monkeypatch.setattr(get_settings(), "static_dir", tmp_path)
    return tmp_path


def _startup_block(html: str) -> str:
    return html.split('<script id="ll-bootstrap" type="application/json">')[1].split("</script>")[0]


def test_page_carries_startup_data_and_assets_are_cached(client, built_frontend):
    page = client.get("/some/deep/link")
    assert page.headers["cache-control"] == "no-cache"
    data = json.loads(_startup_block(page.text))
    assert data["version"] and data["turnstile_site_key"] is None
    assert "Content-Security-Policy" in page.headers  # a JSON block is data, so script-src 'self' still holds

    asset = client.get("/assets/index-abc123.js", headers={"Accept-Encoding": "gzip"})
    assert asset.headers["cache-control"] == "public, max-age=31536000, immutable"
    assert asset.headers["content-encoding"] == "gzip"


def test_startup_block_cannot_be_closed_early(client, built_frontend, monkeypatch):
    import app.main as main

    async def hostile():
        return {"label": "</script><img src=x onerror=alert(1)>"}

    monkeypatch.setattr(main, "_bootstrap", hostile)
    page = client.get("/")
    assert json.loads(_startup_block(page.text)) == {"label": "</script><img src=x onerror=alert(1)>"}
    assert "<img" not in page.text.split("</script>", 1)[1]


# Keep last: this starts a second app lifespan, which replaces the shared app state.

def test_timeout_kills_the_job(monkeypatch):
    monkeypatch.setenv("LAYERLIFT_JOB_TIMEOUT_SECONDS", "1")
    monkeypatch.setenv("LAYERLIFT_WORKERS", "1")
    get_settings.cache_clear()
    try:
        with TestClient(app) as c:
            settings = {"filaments": FILAMENTS, "width_mm": 100}
            r = c.post(
                "/api/build",
                files={"file": ("t.png", TURTLES.read_bytes(), "image/png")},
                data={"settings": json.dumps(settings)},
            )
            assert r.status_code == 504 and r.json()["error"]["code"] == "timeout"
            assert c.get("/api/health").status_code == 200
    finally:
        get_settings.cache_clear()

"""Acceptance tests, run on the Space Turtles fixture."""

from __future__ import annotations

import io
import itertools
import re
import zipfile

import numpy as np
import pytest
import trimesh
from manifold3d import CrossSection, Manifold, OpType
from shapely.ops import unary_union

from relief.export import export_3mf, export_glb, export_stl_zip
from relief.geometry import clean, opening, polygons_of
from relief.preview import preview_image

from .conftest import FILAMENTS_4, FIXTURES, load_rgb, preview_agreement


def test_four_watertight_meshes(result_4):
    assert [p.name for p in result_4.parts] == ["Black", "Blue", "Apricot", "White"]
    for part in result_4.parts:
        # process=True merges coincident vertices, like a slicer reading an STL.
        mesh = trimesh.Trimesh(part.mesh.vertices, part.mesh.faces, process=True)
        assert mesh.is_watertight, part.name
        assert mesh.is_winding_consistent, part.name
        assert part.volume_mm3 > 0


def test_bounding_box(result_4):
    lo = np.min([p.mesh.bounds[0] for p in result_4.parts], axis=0)
    hi = np.max([p.mesh.bounds[1] for p in result_4.parts], axis=0)
    size = hi - lo
    assert size[0] == pytest.approx(100.0, abs=0.01)
    assert size[1] == pytest.approx(100.0, abs=0.5)
    assert size[2] == pytest.approx(4.0, abs=1e-6)
    assert lo[2] == pytest.approx(0.0, abs=1e-9)


def test_preview_matches_expected(result_4):
    img = preview_image(result_4.footprints_for_preview(), result_4.size_mm[:2])
    expected = load_rgb(FIXTURES / "expected_4colour_preview.png")
    assert preview_agreement(img, expected, [f.rgb for f in FILAMENTS_4]) >= 0.95


def test_filament_change_estimate(result_4):
    assert abs(result_4.changes.total - 28) <= 2


def test_parts_do_not_overlap(result_4):
    for a, b in itertools.combinations(result_4.parts, 2):
        shared = Manifold.batch_boolean([a.solid, b.solid], OpType.Intersect).volume()
        assert shared < 1e-4, (a.name, b.name, shared)


def test_no_gaps_at_top_surface(result_4):
    footprints = unary_union([e.footprint for e in result_4.elements])
    assert footprints.symmetric_difference(result_4.silhouette).area < 1e-3
    # The meshes themselves cover the silhouette, seen from above.
    projected = CrossSection.batch_boolean([p.solid.project() for p in result_4.parts], OpType.Add)
    assert projected.area() == pytest.approx(result_4.silhouette.area, abs=1e-3)


def test_no_feature_narrower_than_nozzle(result_4):
    nozzle = 0.4
    for e in result_4.elements:
        thin = clean(e.footprint.difference(opening(e.footprint, 0.45 * nozzle)))
        # Only corner rounding may remain; no strip or blob thinner than the nozzle.
        worst = max((p.area for p in polygons_of(thin)), default=0.0)
        assert worst < 0.05, (e.key, worst)


def test_all_z_on_layer_multiples(result_4):
    zs = np.concatenate([p.mesh.vertices[:, 2] for p in result_4.parts])
    k = zs / 0.2
    assert np.abs(k - np.round(k)).max() < 1e-6
    assert set(np.round(np.unique(np.round(zs, 6)), 6)) == {0.0, 2.0, 2.8, 3.2, 3.6, 3.8, 4.0}


def test_white_starts_at_bed_and_others_on_base(result_4):
    z_min = {p.name: p.mesh.bounds[0][2] for p in result_4.parts}
    assert z_min["White"] == 0.0 and z_min["Black"] == 0.0
    assert z_min["Blue"] == pytest.approx(2.0) and z_min["Apricot"] == pytest.approx(2.0)


def test_seven_colour_reproduction(result_7):
    assert len(result_7.parts) == 7
    for part in result_7.parts:
        assert trimesh.Trimesh(part.mesh.vertices, part.mesh.faces, process=True).is_watertight, part.name
    img = preview_image(result_7.footprints_for_preview(), result_7.size_mm[:2])
    expected = load_rgb(FIXTURES / "expected_7colour_preview.png")
    assert preview_agreement(img, expected, [f.rgb for f in result_7.filaments]) >= 0.93


# ----------------------------------------------------------------------------- exports


def test_3mf_structure(result_4):
    data = export_3mf(result_4, "Space Turtles", thumbnail_png=b"\x89PNG fake")
    z = zipfile.ZipFile(io.BytesIO(data))
    names = set(z.namelist())
    assert {"[Content_Types].xml", "_rels/.rels", "3D/3dmodel.model", "3D/Objects/object_1.model", "Metadata/model_settings.config"} <= names
    assert "Metadata/project_settings.config" not in names
    main = z.read("3D/3dmodel.model").decode()
    assert main.count("<component ") == 4 and main.count("<item ") == 1
    assert 'name="OrcaSlicer"' not in main
    settings = z.read("Metadata/model_settings.config").decode()
    assert settings.count("<object ") == 1
    parts = re.findall(r'<part id="(\d+)" subtype="normal_part">\s*<metadata key="name" value="([^"]+)"/>', settings)
    assert [p[1] for p in parts] == ["01 Black", "02 Blue", "03 Apricot", "04 White"]
    slots = re.findall(r'<part id="\d+"[^>]*>.*?key="extruder" value="(\d+)"', settings, flags=re.S)
    assert slots == ["1", "2", "3", "4"]
    sub = z.read("3D/Objects/object_1.model").decode()
    assert sub.count("<object ") == 4
    for part in result_4.parts:
        assert f'<mesh_stat face_count="{len(part.mesh.faces)}"' in settings


def test_stl_zip_and_glb(result_4):
    z = zipfile.ZipFile(io.BytesIO(export_stl_zip(result_4, "Space Turtles")))
    stls = sorted(n for n in z.namelist() if n.endswith(".stl"))
    assert len(stls) == 4 and "README.txt" in z.namelist()
    loaded = [trimesh.load(io.BytesIO(z.read(n)), file_type="stl") for n in stls]
    assert all(m.is_watertight for m in loaded)
    glb = export_glb(result_4)
    assert glb[:4] == b"glTF"

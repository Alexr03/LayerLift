"""Relief strategies that trade the detailed layout for fewer filament changes."""

from __future__ import annotations

import itertools

import pytest
import trimesh
from manifold3d import CrossSection, Manifold, OpType

from relief.pipeline import BuildSettings, RegionOverride, build_relief, squeeze_heights, stack_bands
from relief.preview import preview_image

from .conftest import FILAMENTS_4, FIXTURES, GROUPING_4, NAMES, load_rgb, outer_border_region, preview_agreement


def build_4(analysis, strategy: str):
    return build_relief(
        analysis,
        FILAMENTS_4,
        BuildSettings(width_mm=100, layer_mm=0.2, base_mm=2.0, nozzle_mm=0.4, strategy=strategy),
        mapping=[GROUPING_4[n] for n in NAMES],
    )


@pytest.fixture(scope="module")
def compact_4(prototype_analysis):
    return build_4(prototype_analysis, "compact")


@pytest.fixture(scope="module")
def stacked_4(prototype_analysis):
    return build_4(prototype_analysis, "stacked")


@pytest.fixture(params=["compact", "stacked"])
def strategy_result(request, compact_4, stacked_4):
    return {"compact": compact_4, "stacked": stacked_4}[request.param]


def test_squeeze_heights_keeps_order_one_layer_apart():
    squeeze = squeeze_heights([2.0, 2.8, 3.6, 2.8, 4.0], base_mm=2.0, layer=0.2)
    assert [squeeze(z) for z in (2.0, 2.8, 3.6, 4.0)] == [2.0, 2.2, 2.4, 2.6]
    assert squeeze(3.0) == 2.4  # between levels: just above the ones below it


def test_stack_bands_follow_heights_and_are_at_least_a_layer():
    order, tops = stack_bands([0, 1, 2], {0: 3.0, 1: 2.8, 2: 3.0}, None, base_mm=2.0, layer=0.2)
    assert order == [1, 0, 2]
    assert tops == {1: 2.8, 0: 3.0, 2: 3.2}


def test_stack_bands_explicit_base_goes_first_at_base_height():
    order, tops = stack_bands([0, 1], {0: 2.8, 1: 3.2}, 1, base_mm=2.0, layer=0.2)
    assert order == [1, 0]
    assert tops == {1: 2.0, 0: 2.8}


def test_unknown_strategy_is_rejected(prototype_analysis):
    with pytest.raises(ValueError, match="strategy"):
        build_4(prototype_analysis, "fastest")


def test_fewer_changes_than_detailed(compact_4, stacked_4, result_4):
    assert stacked_4.changes.total == len(stacked_4.parts) - 1 == 3
    assert compact_4.changes.total <= 8
    assert compact_4.changes.total < result_4.changes.total


def test_stacked_layers_hold_one_colour(stacked_4):
    assert all(len(layer.filaments) == 1 for layer in stacked_4.changes.layers)
    z = {p.name: (p.mesh.bounds[0][2], p.z_max) for p in stacked_4.parts}
    assert z == pytest.approx({"Black": (0.0, 2.8), "Blue": (2.8, 3.2), "Apricot": (3.2, 3.6), "White": (3.6, 4.0)})


def test_compact_ignores_bed_start_and_squeezes_heights(compact_4):
    z = {p.name: (p.mesh.bounds[0][2], p.z_max) for p in compact_4.parts}
    assert z == pytest.approx({"Black": (0.0, 2.2), "Blue": (2.0, 2.4), "Apricot": (2.0, 2.6), "White": (2.0, 2.8)})


def test_meshes_watertight_and_disjoint(strategy_result):
    for part in strategy_result.parts:
        mesh = trimesh.Trimesh(part.mesh.vertices, part.mesh.faces, process=True)
        assert mesh.is_watertight, part.name
    for a, b in itertools.combinations(strategy_result.parts, 2):
        shared = Manifold.batch_boolean([a.solid, b.solid], OpType.Intersect).volume()
        assert shared < 1e-4, (a.name, b.name, shared)


def test_top_view_unchanged(strategy_result):
    projected = CrossSection.batch_boolean([p.solid.project() for p in strategy_result.parts], OpType.Add)
    assert projected.area() == pytest.approx(strategy_result.silhouette.area, abs=1e-3)
    img = preview_image(strategy_result.footprints_for_preview(), strategy_result.size_mm[:2])
    expected = load_rgb(FIXTURES / "expected_4colour_preview.png")
    assert preview_agreement(img, expected, [f.rgb for f in FILAMENTS_4]) >= 0.95


def test_stacked_warns_about_ignored_heights_and_thin_light_bands(prototype_analysis):
    border = outer_border_region(prototype_analysis)
    result = build_relief(
        prototype_analysis,
        FILAMENTS_4,
        BuildSettings(strategy="stacked"),
        mapping=[GROUPING_4[n] for n in NAMES],
        region_overrides={border: RegionOverride(height_mm=2.8)},
    )
    codes = [w.code for w in result.warnings]
    assert "heights_ignored" in codes
    # Every band above black is 0.4 mm and lighter than the one below it.
    thin = {w.detail["filament"] for w in result.warnings if w.code == "thin_band"}
    assert thin == {1, 2, 3}

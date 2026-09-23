"""Unit tests for the colour, analysis, mapping, change-estimate and image-loading code."""

from __future__ import annotations

import io

import numpy as np
import pytest
from PIL import Image

from relief.analyse import remove_specks
from relief.changes import estimate_changes, layer_sets
from relief.colour import delta_e_2000, hex_to_lab, lab_to_srgb, srgb_to_lab
from relief.imageio import ImageError, foreground_mask, load_image
from relief.mapping import nearest_mapping, suggest_mapping

from .conftest import FILAMENTS_4, GROUPING_4, NAMES

# ------------------------------------------------------------------------------ colour

SHARMA = [  # Sharma, Wu & Dalal (2005) CIEDE2000 test data
    ((50, 2.6772, -79.7751), (50, 0, -82.7485), 2.0425),
    ((50, -1.3802, -84.2814), (50, 0, -82.7485), 1.0000),
    ((50, 0, 0), (50, -1, 2), 2.3669),
    ((50, 2.5, 0), (73, 25, -18), 27.1492),
    ((60.2574, -34.0099, 36.2677), (60.4626, -34.1751, 39.4387), 1.2644),
    ((2.0776, 0.0795, -1.135), (0.9033, -0.0636, -0.5514), 0.9082),
]


@pytest.mark.parametrize("a,b,expected", SHARMA)
def test_ciede2000_reference_values(a, b, expected):
    assert float(delta_e_2000(np.array(a), np.array(b))) == pytest.approx(expected, abs=1e-4)


def test_lab_round_trip():
    rgb = np.array([[12, 200, 77], [255, 255, 255], [0, 0, 0], [247, 178, 140]], float)
    assert np.abs(lab_to_srgb(srgb_to_lab(rgb)) - rgb).max() < 1e-6


# ------------------------------------------------------------------------------ changes


def test_change_estimate_worked_example():
    # black 0-2.8, white 0-4.0, blue 2.0-3.2, apricot 2.0-3.6 at 0.2 mm layers
    est = estimate_changes(layer_sets([(0, 0, 2.8), (1, 0, 4.0), (2, 2.0, 3.2), (3, 2.0, 3.6)], 0.2), 0.2)
    assert est.total == 28
    assert [l.changes for l in est.layers] == [1] * 10 + [3] * 4 + [2] * 2 + [1] * 2 + [0] * 2


def test_change_estimate_white_from_1_2mm():
    est = estimate_changes(layer_sets([(0, 0, 2.8), (1, 1.2, 4.0), (2, 2.0, 3.2), (3, 2.0, 3.6)], 0.2), 0.2)
    assert est.total == 22


def test_change_estimate_chains_across_layers():
    # A, B every layer: 1 change per layer, the boundary is always free.
    assert estimate_changes([{0, 1}] * 5).total == 5
    # Single colour throughout: nothing to change.
    assert estimate_changes([{2}] * 5).total == 0
    # Alternating single colours: one change per boundary.
    assert estimate_changes([{0}, {1}, {0}, {1}]).total == 3


# ------------------------------------------------------------------------------ mapping


def _problem(analysis):
    return (
        [c.lab for c in analysis.clusters],
        [c.share for c in analysis.clusters],
        analysis.adjacency,
        [f.lab for f in FILAMENTS_4],
    )


def test_auto_mapping_reproduces_hand_mapping(prototype_analysis):
    result = suggest_mapping(*_problem(prototype_analysis))
    assert result.assignment == [GROUPING_4[n] for n in NAMES]


def test_nearest_colour_mapping_is_worse(prototype_analysis):
    """Plain nearest-colour mapping loses the green turtle; the contrast-aware mapping keeps it."""
    cl, sh, adj, fl = _problem(prototype_analysis)
    nearest = nearest_mapping(cl, fl)
    assert nearest[NAMES.index("green")] != GROUPING_4["green"]


def test_auto_mapping_on_automatic_clusters(auto_analysis):
    """With automatic clustering the main colours still land where a person would put them."""
    clusters = auto_analysis.clusters
    result = suggest_mapping(*_problem(auto_analysis))

    def closest(rgb):
        return min(clusters, key=lambda c: np.abs(np.array(c.rgb) - rgb).sum()).id

    fil = {c: result.assignment[c] for c in range(len(clusters))}
    assert fil[closest((0, 42, 65))] == 0  # navy -> black
    assert fil[closest((255, 255, 255))] == 3  # white -> white
    assert fil[closest((0, 255, 255))] == 3  # cyan accent -> white, not merged into blue
    assert fil[closest((0, 165, 112))] == 2  # turtle green -> apricot
    assert fil[closest((228, 178, 117))] == 2  # tan -> apricot
    assert fil[closest((0, 65, 108))] == 1  # space blue -> blue


def test_mapping_respects_overrides(prototype_analysis):
    cl, sh, adj, fl = _problem(prototype_analysis)
    fixed = {NAMES.index("cyan"): 1}
    result = suggest_mapping(cl, sh, adj, fl, fixed=fixed)
    assert result.assignment[NAMES.index("cyan")] == 1


def test_local_search_matches_exhaustive():
    rng = np.random.default_rng(3)
    for _ in range(5):
        k, f = 6, 4
        cl = rng.uniform([0, -60, -60], [100, 60, 60], (k, 3))
        fl = rng.uniform([0, -60, -60], [100, 60, 60], (f, 3))
        sh = rng.dirichlet(np.ones(k))
        adj = rng.integers(0, 50, (k, k)).astype(float)
        adj = adj + adj.T
        np.fill_diagonal(adj, 0)
        ex = suggest_mapping(cl, sh, adj, fl)
        ls = suggest_mapping(cl, sh, adj, fl, brute_force_limit=1)
        assert ex.method == "exhaustive" and ls.method == "local-search"
        assert ls.cost == pytest.approx(ex.cost, rel=1e-9)


# ------------------------------------------------------------------------------ analysis


def test_auto_analysis_finds_the_main_colours(auto_analysis):
    assert 6 <= len(auto_analysis.clusters) <= 12
    assert sum(c.share for c in auto_analysis.clusters) == pytest.approx(1.0)
    labs = np.array([c.lab for c in auto_analysis.clusters])
    for target in ["#00FFFF", "#FFFFFF", "#E4B275", "#002A41"]:
        assert delta_e_2000(labs, hex_to_lab(target)).min() < 6, target


def test_outer_border_region_is_white(auto_analysis):
    border = max(auto_analysis.region_info, key=lambda r: r.outline_share)
    assert border.outline_share > 0.9
    assert auto_analysis.clusters[border.cluster].hex == "#FFFFFF"


def test_no_fringe_specks_left(auto_analysis):
    from scipy import ndimage as ndi

    labels = auto_analysis.labels
    for k in range(len(auto_analysis.clusters)):
        cc, n = ndi.label(labels == k, structure=np.ones((3, 3)))
        sizes = np.bincount(cc.ravel())[1:]
        assert sizes.min() >= 10


def test_remove_specks_reassigns_to_neighbour():
    labels = np.zeros((20, 20), np.int16)
    labels[5:7, 5:7] = 1  # 4 px speck inside label 0
    out = remove_specks(labels, min_area=10)
    assert (out == 0).all()


# ------------------------------------------------------------------------------ image loading


def _png(img: Image.Image) -> bytes:
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def test_load_downscales_and_masks_alpha():
    img = Image.new("RGBA", (2000, 1000), (0, 0, 0, 0))
    img.paste((255, 0, 0, 255), (500, 250, 1500, 750))
    loaded = load_image(_png(img), max_side=1024)
    assert loaded.rgba.shape == (512, 1024, 4)
    mask, info = foreground_mask(loaded.rgba)
    assert info["mode"] == "alpha"
    assert 0.2 < mask.mean() < 0.3


def test_background_colour_detection_without_alpha():
    img = Image.new("RGB", (200, 200), (255, 255, 255))
    img.paste((20, 60, 160), (50, 50, 150, 150))
    loaded = load_image(_png(img))
    mask, info = foreground_mask(loaded.rgba)
    assert info["mode"] == "colour" and info["colour"] == "#FFFFFF"
    assert mask.sum() == 100 * 100


def test_svg_is_rasterised():
    svg = b'<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="20" height="20" fill="#f00"/></svg>'
    loaded = load_image(svg, max_side=400)
    assert loaded.source_format == "SVG"
    assert loaded.rgba.shape[:2] == (200, 400)


def test_svg_with_external_reference_is_rejected():
    svg = b'<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><image xlink:href="/etc/passwd"/></svg>'
    with pytest.raises(ImageError):
        load_image(svg)


def test_garbage_is_rejected():
    with pytest.raises(ImageError):
        load_image(b"this is not an image")

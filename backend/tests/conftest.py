"""Shared fixtures. The fixture builds are slow (~10 s each), so they are session-scoped."""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from relief.analyse import analyse
from relief.colour import srgb_to_lab
from relief.imageio import foreground_mask, load_image
from relief.pipeline import BuildSettings, Filament, RegionOverride, build_relief

FIXTURES = Path(__file__).resolve().parent / "fixtures"
TURTLES = FIXTURES / "strp_512x512.png"

# The original prototype's hand-picked palette, snapped in RGB.
PROTOTYPE_PALETTE = {
    "navy": (0, 40, 64),
    "blue": (0, 64, 128),
    "lightblue": (0, 145, 190),
    "cyan": (0, 245, 245),
    "green": (0, 140, 100),
    "white": (250, 250, 250),
    "tan": (215, 170, 115),
}
NAMES = list(PROTOTYPE_PALETTE)

# 4-colour acceptance palette and the prototype's grouping into it.
FILAMENTS_4 = [
    Filament("Black", "#1C1C1E", 2.8),
    Filament("Blue", "#1446AA", 3.2),
    Filament("Apricot", "#F7B28C", 3.6),
    Filament("White", "#F5F5F5", 4.0, start_from_bed=True),
]
GROUPING_4 = {"navy": 0, "blue": 1, "lightblue": 1, "green": 2, "tan": 2, "white": 3, "cyan": 3}

# 7-colour prototype heights.
HEIGHTS_7 = {"navy": 2.8, "blue": 3.0, "lightblue": 3.2, "green": 3.4, "tan": 3.4, "cyan": 3.6, "white": 4.0}


@pytest.fixture(scope="session")
def turtles_rgba():
    return load_image(TURTLES.read_bytes()).rgba


@pytest.fixture(scope="session")
def prototype_analysis(turtles_rgba):
    mask, info = foreground_mask(turtles_rgba)
    lab = srgb_to_lab(np.array(list(PROTOTYPE_PALETTE.values()), float))
    return analyse(turtles_rgba, mask, palette_lab=lab, palette_metric="rgb", background=info)


@pytest.fixture(scope="session")
def auto_analysis(turtles_rgba):
    mask, info = foreground_mask(turtles_rgba)
    return analyse(turtles_rgba, mask, background=info)


def outer_border_region(analysis) -> int:
    return max(analysis.region_info, key=lambda r: r.outline_share).id


@pytest.fixture(scope="session")
def result_4(prototype_analysis):
    """The 4-colour acceptance build: rim at 2.8 mm, SPACE/stars at 3.8, TURTLES/eyes at 4.0."""
    border = outer_border_region(prototype_analysis)
    return build_relief(
        prototype_analysis,
        FILAMENTS_4,
        BuildSettings(width_mm=100, layer_mm=0.2, base_mm=2.0, nozzle_mm=0.4),
        mapping=[GROUPING_4[n] for n in NAMES],
        cluster_heights={NAMES.index("cyan"): 3.8},
        region_overrides={border: RegionOverride(height_mm=2.8)},
    )


@pytest.fixture(scope="session")
def result_7(prototype_analysis):
    border = outer_border_region(prototype_analysis)
    filaments = [
        Filament(n.title(), "#%02X%02X%02X" % PROTOTYPE_PALETTE[n], HEIGHTS_7[n], start_from_bed=(n == "white"))
        for n in NAMES
    ]
    return build_relief(
        prototype_analysis,
        filaments,
        BuildSettings(),
        mapping=list(range(len(NAMES))),
        region_overrides={border: RegionOverride(height_mm=2.8)},
    )


def load_rgb(path: Path) -> np.ndarray:
    return np.asarray(Image.open(path).convert("RGB"))


def preview_agreement(img: np.ndarray, expected: np.ndarray, colours, max_shift: int = 3) -> float:
    """Fraction of pixels whose nearest flat-shaded palette colour matches the expected
    preview, at the best small offset (the prototype framed its grid slightly differently)."""
    cols = np.array([[230, 230, 230]] + [list(c) for c in colours], float) * 0.85

    def classify(x):
        return ((x[..., None, :].astype(float) - cols[None, None]) ** 2).sum(-1).argmin(-1)

    h = min(img.shape[0], expected.shape[0])
    w = min(img.shape[1], expected.shape[1])
    a = classify(img[:h, :w])
    b = classify(expected[:h, :w])
    best = 0.0
    for dy in range(-max_shift, max_shift + 1):
        for dx in range(-max_shift, max_shift + 1):
            best = max(best, float((np.roll(np.roll(a, dy, 0), dx, 1) == b).mean()))
    return best

"""Removing areas of the colour map from the print."""

from __future__ import annotations

import pytest

from relief.pipeline import BuildSettings, RegionOverride, build_relief

from .conftest import FILAMENTS_4, GROUPING_4, NAMES


def test_removed_area_becomes_a_hole(prototype_analysis, result_4):
    # The largest area that doesn't touch the outline: removing it leaves the bounding box alone.
    inner = max((r for r in prototype_analysis.region_info if r.outline_share == 0), key=lambda r: r.area)
    total_px = sum(r.area for r in prototype_analysis.region_info)
    result = build_relief(
        prototype_analysis,
        FILAMENTS_4,
        BuildSettings(width_mm=100, layer_mm=0.2, base_mm=2.0, nozzle_mm=0.4),
        mapping=[GROUPING_4[n] for n in NAMES],
        region_overrides={inner.id: RegionOverride(removed=True)},
    )
    assert result.size_mm[:2] == pytest.approx(result_4.size_mm[:2], abs=0.05)
    expected_loss = inner.area / total_px * result_4.silhouette.area
    loss = result_4.silhouette.area - result.silhouette.area
    assert loss == pytest.approx(expected_loss, rel=0.15)
    assert not any(inner.id in e.regions for e in result.elements)


def test_removing_everything_is_an_error(prototype_analysis):
    everything = {r.id: RegionOverride(removed=True) for r in prototype_analysis.region_info}
    with pytest.raises(ValueError, match="removed"):
        build_relief(prototype_analysis, FILAMENTS_4, mapping=[GROUPING_4[n] for n in NAMES], region_overrides=everything)

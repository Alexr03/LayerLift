"""Filament-change estimate for a layer-by-layer multi-colour print."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass
class LayerInfo:
    index: int  # 0-based
    z_top: float
    filaments: list[int]
    changes: int  # increase in the running optimum caused by this layer


@dataclass
class ChangeEstimate:
    total: int
    layers: list[LayerInfo]


def layer_sets(intervals: list[tuple[int, float, float]], layer_mm: float) -> list[set[int]]:
    """Which filaments are present in each layer.

    intervals: (filament, z0, z1) solids. A filament is present in layer i if any of its
    solids spans the middle of that layer.
    """
    if not intervals:
        return []
    top = max(z1 for _, _, z1 in intervals)
    n = int(round(top / layer_mm))
    return [{f for f, z0, z1 in intervals if z0 <= (i + 0.5) * layer_mm < z1} for i in range(n)]


def estimate_changes(sets: list[set[int]], layer_mm: float = 0.2) -> ChangeEstimate:
    """Minimum number of filament changes with optimal chaining.

    A layer with n colours needs n - 1 changes. Each layer may start with the colour the
    previous layer ended on, so the colour order inside every layer is chosen (dynamic
    programming over the last colour used) to avoid changes at layer boundaries wherever
    possible. The very first colour is free.
    """
    dp: dict[int, int] | None = None  # last colour -> fewest changes so far
    layers: list[LayerInfo] = []
    prev_total = 0
    for i, s in enumerate(sets):
        z_top = round((i + 1) * layer_mm, 6)
        if not s:
            layers.append(LayerInfo(i, z_top, [], 0))
            continue
        n = len(s)
        if dp is None:
            new = {b: n - 1 for b in s}
        else:
            switch = min(dp.values()) + 1  # start this layer with a change
            new = {}
            for b in s:
                opt = switch
                for a, cost in dp.items():
                    # Start on the previous layer's last colour a, which must be present here
                    # and (with more than one colour) differ from the colour we end on.
                    if a in s and (n == 1 or a != b) and cost < opt:
                        opt = cost
                new[b] = opt + n - 1
        dp = new
        cur = min(dp.values())
        layers.append(LayerInfo(i, z_top, sorted(s), cur - prev_total))
        prev_total = cur
    return ChangeEstimate(total=min(dp.values()) if dp else 0, layers=layers)

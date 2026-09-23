"""Map source colour clusters to the filaments the user has loaded.

Nearest-colour mapping fails when the palette is small: a cyan accent next to a blue
background snaps to blue and disappears into it, and mid-tone greens scatter over
whichever neutral happens to be closest. The mapping here minimises

    colour term      sum_i  w_i * dE(cluster_i, filament(i))
  + neighbour term   lam_adj    * sum_{i<j} boundary_ij     * distortion_ij
  + global term      lam_global * sum_{i<j} share_i*share_j * distortion_ij

where distortion_ij = max(0, dE_src - dE_fil) + beta * max(0, dE_fil - dE_src) compares
the contrast between two clusters in the source with the contrast between the filaments
they are assigned. Lost contrast (distinct colours merged) costs most; invented contrast
(similar shades split across very different filaments) costs ``beta`` as much.
dE is CIEDE2000 throughout. Weights were tuned on the Space Turtles fixture.
"""

from __future__ import annotations

from dataclasses import dataclass
from itertools import product

import numpy as np

from .colour import pairwise_delta_e

DEFAULT_WEIGHTS = {"share_power": 1.0, "lam_adj": 0.5, "lam_global": 1.0, "beta": 0.5}


@dataclass
class MappingResult:
    assignment: list[int]  # filament index per cluster
    cost: float
    method: str


class _Problem:
    def __init__(self, cluster_lab, cluster_share, adjacency, filament_lab, share_power, lam_adj, lam_global, beta):
        cl = np.asarray(cluster_lab, np.float64).reshape(-1, 3)
        fl = np.asarray(filament_lab, np.float64).reshape(-1, 3)
        share = np.clip(np.asarray(cluster_share, np.float64).reshape(-1), 0, None)
        share = share / max(share.sum(), 1e-12)
        w = share**share_power
        w = w / max(w.sum(), 1e-12)
        self.k, self.f = len(cl), len(fl)
        self.colour = pairwise_delta_e(cl, fl) * w[:, None]  # (K, F)
        adj = np.asarray(adjacency, np.float64).reshape(self.k, self.k) if self.k else np.zeros((0, 0))
        adj = adj / max(adj.sum() / 2, 1e-12)
        glob = np.outer(share, share)
        np.fill_diagonal(glob, 0)
        glob = glob / max(glob.sum() / 2, 1e-12)
        # Upper-triangular pair weights so each unordered pair counts once.
        self.pair_w = np.triu(lam_adj * adj + lam_global * glob, 1)
        self.src = pairwise_delta_e(cl, cl)
        self.fil = pairwise_delta_e(fl, fl)
        self.beta = beta

    def cost_many(self, a: np.ndarray) -> np.ndarray:
        """Total cost for a batch of assignments, shape (N, K)."""
        rows = np.arange(self.k)
        c = self.colour[rows[None, :], a].sum(1)
        fc = self.fil[a[:, :, None], a[:, None, :]]
        diff = self.src[None] - fc
        dist = np.maximum(diff, 0) + self.beta * np.maximum(-diff, 0)
        return c + (dist * self.pair_w[None]).sum((1, 2))

    def cost(self, a) -> float:
        return float(self.cost_many(np.asarray(a, np.int64)[None])[0])


def suggest_mapping(
    cluster_lab,
    cluster_share,
    adjacency,
    filament_lab,
    fixed: dict[int, int] | None = None,
    allowed: list[list[int]] | None = None,
    share_power: float = DEFAULT_WEIGHTS["share_power"],
    lam_adj: float = DEFAULT_WEIGHTS["lam_adj"],
    lam_global: float = DEFAULT_WEIGHTS["lam_global"],
    beta: float = DEFAULT_WEIGHTS["beta"],
    brute_force_limit: int = 300_000,
    restarts: int = 32,
    seed: int = 0,
) -> MappingResult:
    """Choose a filament for every cluster.

    fixed: cluster -> filament overrides that must be kept (user choices).
    allowed: optional per-cluster list of permitted filament indices.
    Exhaustive search when the assignment space is small, otherwise local search
    (single-cluster moves) from the nearest-colour start plus random restarts.
    """
    p = _Problem(cluster_lab, cluster_share, adjacency, filament_lab, share_power, lam_adj, lam_global, beta)
    k, f = p.k, p.f
    if k == 0:
        return MappingResult([], 0.0, "empty")
    if f == 0:
        raise ValueError("at least one filament is required")
    fixed = {int(c): int(v) for c, v in (fixed or {}).items() if 0 <= int(c) < k and 0 <= int(v) < f}
    choices: list[list[int]] = []
    for i in range(k):
        if i in fixed:
            choices.append([fixed[i]])
        elif allowed and i < len(allowed) and allowed[i]:
            choices.append(sorted(set(allowed[i]) & set(range(f))) or list(range(f)))
        else:
            choices.append(list(range(f)))

    space = float(np.prod([len(c) for c in choices], dtype=np.float64))
    if space <= brute_force_limit:
        combos = np.array(list(product(*choices)), dtype=np.int64)
        best, best_cost = None, np.inf
        step = max(1, 2_000_000 // max(k * k, 1))
        for s in range(0, len(combos), step):
            chunk = combos[s : s + step]
            costs = p.cost_many(chunk)
            i = int(np.argmin(costs))
            if costs[i] < best_cost:
                best_cost, best = float(costs[i]), chunk[i].tolist()
        return MappingResult([int(v) for v in best], best_cost, "exhaustive")

    rng = np.random.default_rng(seed)
    nearest = [min(ch, key=lambda j, i=i: p.colour[i, j]) for i, ch in enumerate(choices)]
    best, best_cost = None, np.inf
    for r in range(restarts):
        a = np.array(nearest if r == 0 else [int(rng.choice(ch)) for ch in choices], np.int64)
        cur = p.cost(a)
        improved = True
        while improved:
            improved = False
            for i in rng.permutation(k):
                if len(choices[i]) < 2:
                    continue
                cand = np.repeat(a[None], len(choices[i]), 0)
                cand[:, i] = choices[i]
                costs = p.cost_many(cand)
                j = int(np.argmin(costs))
                if costs[j] < cur - 1e-9:
                    a, cur, improved = cand[j].copy(), float(costs[j]), True
        if cur < best_cost:
            best_cost, best = cur, a.tolist()
    return MappingResult([int(v) for v in best], best_cost, "local-search")


def nearest_mapping(cluster_lab, filament_lab) -> list[int]:
    """Plain nearest-colour (CIEDE2000) mapping, for comparison."""
    if len(cluster_lab) == 0:
        return []
    return [int(v) for v in pairwise_delta_e(cluster_lab, filament_lab).argmin(1)]

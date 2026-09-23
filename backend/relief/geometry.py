"""2D geometry: smooth upscaling, vectorising label maps, exact partition, extrusion."""

from __future__ import annotations

from dataclasses import dataclass, field

import cv2
import numpy as np
import shapely
from shapely import affinity
from shapely.geometry import GeometryCollection, MultiPolygon, Polygon
from shapely.ops import unary_union
from shapely.strtree import STRtree

from .analyse import remove_specks

EMPTY = Polygon()


# --------------------------------------------------------------------------- raster stage


def smooth_upscale(labels: np.ndarray, n_labels: int, up: int, sigma: float = 0.8) -> np.ndarray:
    """Upscale a label map with smooth edges.

    Each class (and the background) is blurred as a one-hot mask, upscaled bicubically,
    and the arg-max taken. This replaces pixel stair-steps with smooth outlines.
    """
    h, w = labels.shape
    size = (w * up, h * up)

    def prob(mask: np.ndarray) -> np.ndarray:
        p = cv2.GaussianBlur(mask.astype(np.float32), (0, 0), sigma) if sigma > 0 else mask.astype(np.float32)
        return cv2.resize(p, size, interpolation=cv2.INTER_CUBIC)

    best = prob(labels < 0)
    out = np.full(best.shape, -1, np.int16)
    for k in range(n_labels):
        m = labels == k
        if not m.any():
            continue
        p = prob(m)
        upd = p > best
        best[upd] = p[upd]
        out[upd] = k
    return out


def mask_polygons(mask: np.ndarray, epsilon: float = 0.8):
    """Trace a binary mask into (Multi)Polygons in pixel coordinates, keeping holes."""
    contours, hier = cv2.findContours(mask.astype(np.uint8), cv2.RETR_CCOMP, cv2.CHAIN_APPROX_NONE)
    if hier is None:
        return EMPTY
    hier = hier[0]
    polys = []
    for i, c in enumerate(contours):
        if hier[i][3] != -1:
            continue
        outer = cv2.approxPolyDP(c, epsilon, True)[:, 0].astype(np.float64)
        if len(outer) < 3:
            continue
        holes = []
        j = hier[i][2]
        while j != -1:
            hc = cv2.approxPolyDP(contours[j], epsilon, True)[:, 0].astype(np.float64)
            if len(hc) >= 3:
                holes.append(hc)
            j = hier[j][0]
        p = Polygon(outer, holes)
        if not p.is_valid:
            p = shapely.make_valid(p)
        polys.append(p)
    return clean(unary_union(polys)) if polys else EMPTY


# --------------------------------------------------------------------------- shapely helpers


def polygons_of(geom) -> list[Polygon]:
    """Flatten any geometry into its polygon parts."""
    if geom is None or geom.is_empty:
        return []
    if isinstance(geom, Polygon):
        return [geom]
    if isinstance(geom, (MultiPolygon, GeometryCollection)):
        out = []
        for g in geom.geoms:
            out.extend(polygons_of(g))
        return out
    return []


def clean(geom, min_area: float = 0.0):
    """Repair (buffer(0)) and keep only polygons with area >= min_area."""
    if geom is None or geom.is_empty:
        return EMPTY
    if not geom.is_valid:
        geom = geom.buffer(0)
    polys = [p for p in polygons_of(geom) if p.area >= min_area and p.area > 0]
    if not polys:
        return EMPTY
    return polys[0] if len(polys) == 1 else MultiPolygon(polys)


def opening(geom, r: float, grow: float = 0.0):
    """Morphological opening (erode then dilate) removing features narrower than 2r."""
    if geom.is_empty or r <= 0:
        return geom.buffer(grow) if grow else geom
    return geom.buffer(-r, join_style="mitre", mitre_limit=2.0).buffer(r + grow, join_style="round")


# --------------------------------------------------------------------------- partition


@dataclass
class PartitionItem:
    key: str
    geom: object  # raw geometry (mm)
    z1: float
    area: float = 0.0
    final: object = field(default=EMPTY)


@dataclass
class PartitionReport:
    removed_area: dict = field(default_factory=dict)  # key -> mm^2 lost to the feature filter
    moved_area: dict = field(default_factory=dict)  # key -> mm^2 given to neighbours
    dropped_area: float = 0.0  # area removed from the silhouette entirely


def partition(
    items: list[PartitionItem],
    silhouette,
    min_feature: float,
    grow_frac: float = 0.25,
    min_area: float = 0.05,
    cleanup_rounds: int = 3,
    progress=None,
) -> tuple[dict[str, object], object, PartitionReport]:
    """Exact partition of the silhouette between items (no gaps, no overlaps).

    Items are processed in priority order (tallest first, then smallest). Each one is
    morphologically opened with radius min_feature/2 (plus a small growth to close the
    seams left by vectorising), clipped to the silhouette and to what is still free. The
    largest item takes the remainder. Pieces narrower than ``min_feature`` or smaller
    than ``min_area`` are then handed to the neighbour sharing the longest edge.
    Returns (key -> final geometry, final silhouette, report). ``progress(fraction)`` is
    called as items are processed.
    """
    tick = progress or (lambda fraction: None)
    report = PartitionReport()
    r = min_feature / 2
    sil = clean(opening(silhouette, r), min_area)
    report.dropped_area += max(0.0, silhouette.area - sil.area)
    if not items:
        return {}, sil, report
    for it in items:
        it.area = it.geom.area
    remainder = max(items, key=lambda it: it.area)
    order = sorted((it for it in items if it is not remainder), key=lambda it: (-it.z1, it.area))

    taken = EMPTY
    result: dict[str, object] = {}
    for n, it in enumerate(order):
        tick(0.6 * n / max(len(order), 1))
        g = opening(it.geom, r, grow=r * grow_frac).intersection(sil)
        g = clean(g.difference(taken) if not taken.is_empty else g)
        g = clean(opening(g, r * 0.5).intersection(g))  # drop slivers left by the subtraction
        result[it.key] = g
        report.removed_area[it.key] = max(0.0, it.area - g.area)
        taken = unary_union([taken, g]) if not taken.is_empty else g
    result[remainder.key] = clean(sil.difference(taken))
    report.removed_area.setdefault(remainder.key, 0.0)

    tick(0.6)
    result, sil = _hand_off_slivers(result, sil, r, min_area, cleanup_rounds, report)
    tick(1.0)
    return result, sil, report


def _hand_off_slivers(result, sil, r, min_area, rounds, report):
    """Give thin or tiny pieces of each part to the neighbour they share most edge with."""
    keys = list(result)
    eps = max(r * 0.05, 1e-3)
    probe_r = r * 0.9  # slightly under r so exact-width features and float noise survive
    for _ in range(rounds):
        moved_any = False
        for key in keys:
            g = result[key]
            if g.is_empty:
                continue
            thin = clean(g.difference(opening(g, probe_r)))
            pieces = [p for p in polygons_of(thin) if p.area > min_area * 0.5]
            pieces += [p for p in polygons_of(g) if p.area < min_area]
            if not pieces:
                continue
            others = [k for k in keys if k != key and not result[k].is_empty]
            tree = STRtree([result[k] for k in others]) if others else None
            gains: dict[str, list] = {}
            losses = []
            for piece in pieces:
                best, best_len = None, 0.0
                if tree is not None:
                    halo = piece.buffer(eps)
                    for idx in tree.query(halo):
                        k = others[int(idx)]
                        shared = halo.intersection(result[k]).area
                        if shared > best_len:
                            best, best_len = k, shared
                losses.append(piece)
                if best is None:
                    report.dropped_area += piece.area
                else:
                    gains.setdefault(best, []).append(piece)
            if not losses:
                continue
            lost = unary_union(losses)
            result[key] = clean(g.difference(lost))
            moved = sum(p.area for ps in gains.values() for p in ps)
            report.moved_area[key] = report.moved_area.get(key, 0.0) + moved
            for k, ps in gains.items():
                result[k] = clean(unary_union([result[k], *ps]))
            moved_any = True
        if not moved_any:
            break
    # Re-derive the silhouette from the parts so union(parts) == silhouette exactly.
    sil = clean(unary_union([g for g in result.values() if not g.is_empty]))
    return result, sil


# --------------------------------------------------------------------------- transforms


def pixel_to_mm(geom, bounds: tuple[float, float, float, float], scale: float, mirror: bool = False):
    """Map pixel coordinates (y down) to mm (y up), origin at the bottom-left of ``bounds``."""
    minx, miny, maxx, maxy = bounds
    g = affinity.translate(geom, -minx, -maxy)
    g = affinity.scale(g, scale, -scale, origin=(0, 0))
    if mirror:
        g = affinity.scale(g, -1, 1, origin=(0, 0))
        g = affinity.translate(g, (maxx - minx) * scale, 0)
    return g


# --------------------------------------------------------------------------- extrusion


def _cross_section(geom):
    from manifold3d import CrossSection, FillRule

    rings = []
    for p in polygons_of(geom):
        rings.append(np.asarray(p.exterior.coords, np.float64)[:-1])
        for hole in p.interiors:
            rings.append(np.asarray(hole.coords, np.float64)[:-1])
    if not rings:
        return None
    return CrossSection(rings, FillRule.EvenOdd)


def extrude(geom, z0: float, z1: float):
    """Extrude a 2D geometry between z0 and z1 as a manifold3d Manifold (or None)."""
    from manifold3d import Manifold

    if geom is None or geom.is_empty or z1 <= z0:
        return None
    cs = _cross_section(geom)
    if cs is None or cs.is_empty():
        return None
    return Manifold.extrude(cs, z1 - z0).translate((0.0, 0.0, z0))


def union_solids(solids):
    from manifold3d import Manifold, OpType

    solids = [s for s in solids if s is not None and not s.is_empty()]
    if not solids:
        return None
    if len(solids) == 1:
        return solids[0]
    return Manifold.batch_boolean(solids, OpType.Add)


def pinch_edges(solid, tol: float = 1e-6) -> list[tuple[float, float, float, float]]:
    """Edges shared by more than two faces once coincident vertices are merged.

    Manifold keeps solids that touch only along an edge topologically separate, but file
    formats without topology (STL) and slicers merge vertices by position, which turns
    such an edge into a non-manifold one. Returns (x, y, z_low, z_high) per edge.
    """
    mesh = solid.to_mesh64()
    verts = np.asarray(mesh.vert_properties, np.float64)[:, :3]
    faces = np.asarray(mesh.tri_verts, np.int64)
    if len(faces) == 0:
        return []
    key = np.round(verts / tol).astype(np.int64)
    _, canon = np.unique(key, axis=0, return_inverse=True)
    canon = canon.reshape(-1)
    f = canon[faces]
    edges = np.sort(np.concatenate([f[:, [0, 1]], f[:, [1, 2]], f[:, [2, 0]]]), axis=1)
    uniq, counts = np.unique(edges, axis=0, return_counts=True)
    bad = uniq[counts > 2]
    out = []
    for a, b in bad:
        pa, pb = verts[canon == a][0], verts[canon == b][0]
        out.append((float((pa[0] + pb[0]) / 2), float((pa[1] + pb[1]) / 2), float(min(pa[2], pb[2])), float(max(pa[2], pb[2]))))
    return out


def manifold_to_trimesh(solid):
    import trimesh

    mesh = solid.to_mesh64()
    verts = np.asarray(mesh.vert_properties, np.float64)[:, :3]
    faces = np.asarray(mesh.tri_verts, np.int64)
    tm = trimesh.Trimesh(vertices=verts, faces=faces, process=True)
    return tm

"""Colour analysis: cluster source colours in CIELAB, segment the image and find regions."""

from __future__ import annotations

from dataclasses import dataclass, field

import cv2
import numpy as np
from scipy import ndimage as ndi

from .colour import lab_to_srgb, pairwise_delta_e, rgb_to_hex, srgb_to_lab

_EIGHT = np.ones((3, 3), bool)


@dataclass
class Cluster:
    id: int
    lab: np.ndarray
    rgb: tuple[int, int, int]
    hex: str
    pixels: int = 0
    share: float = 0.0


@dataclass
class Region:
    id: int
    cluster: int
    area: int
    bbox: tuple[int, int, int, int]  # x, y, w, h
    centroid: tuple[float, float]  # x, y
    outline_share: float  # fraction of the silhouette outline this region lies on


@dataclass
class Analysis:
    mask: np.ndarray  # (H, W) bool foreground
    labels: np.ndarray  # (H, W) int16 cluster id, -1 = background
    regions: np.ndarray  # (H, W) int32 region id, -1 = background
    clusters: list[Cluster]
    region_info: list[Region]
    adjacency: np.ndarray  # (K, K) shared boundary length in pixels between clusters
    background: dict = field(default_factory=dict)

    @property
    def shape(self) -> tuple[int, int]:
        return self.labels.shape


# --------------------------------------------------------------------------- helpers


def _local_range(lab: np.ndarray) -> np.ndarray:
    """Max over L, a, b of (3x3 max - 3x3 min): how 'busy' each pixel's neighbourhood is."""
    k = np.ones((3, 3), np.uint8)
    out = np.zeros(lab.shape[:2], np.float32)
    for c in range(3):
        ch = np.ascontiguousarray(lab[..., c], dtype=np.float32)
        out = np.maximum(out, cv2.dilate(ch, k) - cv2.erode(ch, k))
    return out


def interior_pixels(lab: np.ndarray, mask: np.ndarray, flat_threshold: float = 10.0) -> np.ndarray:
    """Pixels inside the silhouette whose neighbourhood is flat (not anti-aliasing fringe)."""
    eroded = cv2.erode(mask.astype(np.uint8), np.ones((3, 3), np.uint8)).astype(bool)
    return eroded & (_local_range(lab) <= flat_threshold)


# --------------------------------------------------------------------------- clustering


def cluster_colours(
    lab: np.ndarray,
    mask: np.ndarray,
    interior: np.ndarray | None = None,
    max_colours: int = 12,
    n_colours: int | None = None,
    merge_delta_e: float = 8.0,
    min_share: float = 0.001,
    sample: int = 40_000,
    seed: int = 0,
) -> np.ndarray:
    """Find representative colours (CIELAB centres) of the foreground.

    k-means (k = max_colours) runs on flat interior pixels so anti-aliasing fringe does not
    create clusters. Clusters closer than ``merge_delta_e`` (CIEDE2000) are then merged, or,
    if ``n_colours`` is given, the closest pairs are merged until exactly that many remain.
    Returns centres sorted by pixel count, largest first.
    """
    from sklearn.cluster import KMeans

    if interior is None:
        interior = interior_pixels(lab, mask)
    pts = lab[interior]
    if len(pts) < max(50, 0.05 * mask.sum()):
        pts = lab[mask]
    if len(pts) == 0:
        raise ValueError("the image has no foreground pixels")
    pts = pts.astype(np.float64)
    rng = np.random.default_rng(seed)
    if len(pts) > sample:
        pts = pts[rng.choice(len(pts), sample, replace=False)]

    uniq = len(np.unique(np.round(pts, 1), axis=0))
    k = int(min(max(max_colours, n_colours or 0), uniq))
    km = KMeans(n_clusters=max(1, k), n_init=3, random_state=seed).fit(pts)
    centres = km.cluster_centers_.astype(np.float64)
    counts = np.bincount(km.labels_, minlength=len(centres)).astype(np.float64)

    # Drop negligible clusters (usually leftover fringe), but never drop everything.
    keep = counts / counts.sum() >= min_share
    if keep.sum() >= max(1, n_colours or 1):
        centres, counts = centres[keep], counts[keep]

    target = n_colours if n_colours is not None else max_colours
    while len(centres) > 1:
        d = pairwise_delta_e(centres, centres)
        np.fill_diagonal(d, np.inf)
        i, j = np.unravel_index(np.argmin(d), d.shape)
        if len(centres) <= target and (n_colours is not None or d[i, j] >= merge_delta_e):
            break
        w = counts[i] + counts[j]
        centres[i] = (centres[i] * counts[i] + centres[j] * counts[j]) / w
        counts[i] = w
        centres = np.delete(centres, j, 0)
        counts = np.delete(counts, j)
    order = np.argsort(-counts, kind="stable")
    return centres[order]


# --------------------------------------------------------------------------- segmentation


def segment(
    lab: np.ndarray,
    palette_lab: np.ndarray,
    mask: np.ndarray,
    interior: np.ndarray | None = None,
    edge_radius: float = 2.5,
) -> np.ndarray:
    """Assign each foreground pixel to a palette colour.

    Plain nearest-colour snapping assigns anti-aliased fringe pixels to unrelated colours
    (e.g. a light-blue halo between navy and white). Here, pixels on colour edges may only
    take a colour that occurs in a flat area within ``edge_radius`` pixels, which removes
    most fringe. Returns an int16 label map with -1 for background.
    """
    palette_lab = np.asarray(palette_lab, np.float64).reshape(-1, 3)
    h, w = mask.shape
    labels = np.full((h, w), -1, np.int16)
    if not mask.any():
        return labels
    # Squared Euclidean (CIE76) distance per palette entry; adequate for assignment.
    d = np.empty((len(palette_lab), h, w), np.float32)
    for i, c in enumerate(palette_lab):
        d[i] = ((lab - c) ** 2).sum(-1)
    nearest = d.argmin(0).astype(np.int16)
    if interior is None or edge_radius <= 0:
        labels[mask] = nearest[mask]
        return labels

    allowed = np.zeros(d.shape, dtype=bool)
    for i in range(len(palette_lab)):
        src = interior & (nearest == i)
        if not src.any():
            continue
        dist = cv2.distanceTransform((~src).astype(np.uint8), cv2.DIST_L2, 3)
        allowed[i] = dist <= edge_radius
    constrained = np.where(allowed, d, np.inf).argmin(0).astype(np.int16)
    result = np.where(allowed.any(0), constrained, nearest)
    labels[mask] = result[mask]
    return labels


def remove_specks(labels: np.ndarray, min_area: int, max_passes: int = 3) -> np.ndarray:
    """Reassign connected components smaller than ``min_area`` pixels to their majority
    neighbouring label. Components surrounded only by background become background."""
    labels = labels.copy()
    if min_area <= 1:
        return labels
    for _ in range(max_passes):
        changed = False
        for k in np.unique(labels):
            if k < 0:
                continue
            cc, n = ndi.label(labels == k, structure=_EIGHT)
            if n == 0:
                continue
            sizes = np.bincount(cc.ravel(), minlength=n + 1)
            small = np.nonzero(sizes[1:] < min_area)[0] + 1
            if len(small) == 0:
                continue
            slices = ndi.find_objects(cc)
            for idx in small:
                sl = slices[idx - 1]
                if sl is None:
                    continue
                y0, y1 = max(sl[0].start - 2, 0), min(sl[0].stop + 2, labels.shape[0])
                x0, x1 = max(sl[1].start - 2, 0), min(sl[1].stop + 2, labels.shape[1])
                msk = cc[y0:y1, x0:x1] == idx
                sub = labels[y0:y1, x0:x1]
                ring = ndi.binary_dilation(msk, iterations=2) & ~msk
                vals = sub[ring]
                vals = vals[vals != k]
                fg = vals[vals >= 0]
                if len(fg):
                    new = np.bincount(fg).argmax()
                elif len(vals):
                    new = -1
                else:
                    continue
                sub[msk] = new
                changed = True
        if not changed:
            break
    return labels


def find_regions(labels: np.ndarray) -> tuple[np.ndarray, list[Region]]:
    """Connected components (8-connectivity) of each label, as a region-id map plus stats."""
    h, w = labels.shape
    regions = np.full((h, w), -1, np.int32)
    info: list[Region] = []
    fg = labels >= 0
    # Silhouette outline: foreground pixels touching background or the image edge.
    padded = np.pad(fg, 1, constant_values=False)
    outline = fg & ~ndi.binary_erosion(padded, structure=_EIGHT)[1:-1, 1:-1]
    outline_total = max(int(outline.sum()), 1)
    next_id = 0
    for k in sorted(int(v) for v in np.unique(labels) if v >= 0):
        cc, n = ndi.label(labels == k, structure=_EIGHT)
        if n == 0:
            continue
        slices = ndi.find_objects(cc)
        areas = np.bincount(cc.ravel(), minlength=n + 1)
        outline_counts = np.bincount(cc[outline], minlength=n + 1)
        for idx in range(1, n + 1):
            sl = slices[idx - 1]
            msk = cc[sl] == idx
            regions[sl][msk] = next_id
            ys, xs = np.nonzero(msk)
            info.append(
                Region(
                    id=next_id,
                    cluster=k,
                    area=int(areas[idx]),
                    bbox=(int(sl[1].start), int(sl[0].start), int(sl[1].stop - sl[1].start), int(sl[0].stop - sl[0].start)),
                    centroid=(float(xs.mean() + sl[1].start), float(ys.mean() + sl[0].start)),
                    outline_share=float(outline_counts[idx] / outline_total),
                )
            )
            next_id += 1
    return regions, info


def cluster_adjacency(labels: np.ndarray, n: int) -> np.ndarray:
    """Symmetric (n, n) matrix of shared boundary length (4-neighbour pixel pairs)."""
    adj = np.zeros((n, n), np.float64)
    for a, b in ((labels[:, :-1], labels[:, 1:]), (labels[:-1, :], labels[1:, :])):
        sel = (a != b) & (a >= 0) & (b >= 0)
        if sel.any():
            np.add.at(adj, (a[sel].astype(np.int64), b[sel].astype(np.int64)), 1)
    return adj + adj.T


def default_speck_px(shape: tuple[int, int]) -> int:
    """Speck threshold in source pixels, scaled from ~10 px at a 512 px image."""
    return max(4, int(round(10 * (max(shape) / 512) ** 2)))


# --------------------------------------------------------------------------- top level


def analyse(
    rgba: np.ndarray,
    mask: np.ndarray,
    max_colours: int = 12,
    n_colours: int | None = None,
    merge_delta_e: float = 8.0,
    palette_lab: np.ndarray | None = None,
    speck_px: int | None = None,
    background: dict | None = None,
    palette_metric: str = "lab",
) -> Analysis:
    """Full analysis of an RGBA image with a foreground mask.

    If ``palette_lab`` is given it is used instead of automatic clustering (fixed palette).
    ``palette_metric`` = "rgb" snaps to a fixed palette by RGB distance instead of CIELAB,
    which reproduces palettes that were picked by eye in RGB (as in the prototype).
    """
    lab = srgb_to_lab(rgba[..., :3]).astype(np.float32)
    interior = interior_pixels(lab, mask)
    fixed = palette_lab is not None
    if fixed:
        centres = np.asarray(palette_lab, np.float64).reshape(-1, 3)
    else:
        centres = cluster_colours(lab, mask, interior, max_colours=max_colours, n_colours=n_colours, merge_delta_e=merge_delta_e)
    if fixed and palette_metric == "rgb":
        from .colour import lab_to_srgb as _to_rgb

        labels = segment(rgba[..., :3].astype(np.float32), _to_rgb(centres), mask, interior)
    else:
        labels = segment(lab, centres, mask, interior)
    labels = remove_specks(labels, default_speck_px(mask.shape) if speck_px is None else speck_px)

    # Renumber clusters by pixel count; drop palette entries that ended up unused
    # (only for automatic clustering: a fixed palette keeps its indices).
    counts = np.bincount(labels[labels >= 0].ravel(), minlength=len(centres))
    if fixed:
        used = list(range(len(centres)))
    else:
        used = [int(i) for i in np.argsort(-counts, kind="stable") if counts[i] > 0]
        remap = np.full(len(centres) + 1, -1, np.int16)
        for new, old in enumerate(used):
            remap[old + 1] = new
        labels = remap[labels.astype(np.int32) + 1]
    total = max(int(counts.sum()), 1)

    clusters: list[Cluster] = []
    for new, old in enumerate(used):
        if fixed:
            c_lab = centres[old]
        else:
            sel = labels == new
            flat = sel & interior
            # Re-estimate the colour from flat pixels where possible (less fringe bias).
            c_lab = lab[flat].mean(0) if flat.sum() >= 10 else lab[sel].mean(0)
        rgb = lab_to_srgb(np.asarray(c_lab, np.float64))
        clusters.append(
            Cluster(
                id=new,
                lab=np.asarray(c_lab, np.float64),
                rgb=tuple(int(round(v)) for v in rgb),
                hex=rgb_to_hex(rgb),
                pixels=int(counts[old]),
                share=float(counts[old] / total),
            )
        )
    regions, info = find_regions(labels)
    adjacency = cluster_adjacency(labels, len(clusters))
    return Analysis(
        mask=labels >= 0,
        labels=labels,
        regions=regions,
        clusters=clusters,
        region_info=info,
        adjacency=adjacency,
        background=background or {},
    )

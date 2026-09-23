"""High-level pipeline: analysis + mapping + heights -> per-filament watertight meshes."""

from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np
from shapely.ops import unary_union

from . import geometry as geo
from .analyse import Analysis, remove_specks
from .changes import ChangeEstimate, estimate_changes, layer_sets
from .colour import hex_to_lab, hex_to_rgb, relative_luminance
from .mapping import suggest_mapping

PLA_DENSITY = 1.24  # g/cm^3


@dataclass
class Filament:
    name: str
    hex: str
    height_mm: float | None = None  # top of this filament's regions (manual mode)
    start_from_bed: bool = False  # light colours: print from z=0 so a dark base can't show through
    density: float = PLA_DENSITY

    @property
    def rgb(self) -> tuple[int, int, int]:
        return hex_to_rgb(self.hex)

    @property
    def lab(self) -> np.ndarray:
        return hex_to_lab(self.hex)


@dataclass
class RegionOverride:
    filament: int | None = None
    height_mm: float | None = None


@dataclass
class BuildSettings:
    width_mm: float = 100.0
    size_mode: str = "width"  # which silhouette dimension width_mm sets: width | height | longest
    nozzle_mm: float = 0.4
    layer_mm: float = 0.2
    base_mm: float = 2.0
    min_feature_mm: float | None = None  # defaults to the nozzle width
    height_mode: str = "manual"  # manual | by_luminance
    lighter_taller: bool = True
    relief_min_mm: float = 0.8  # by_luminance: lowest colour sits this far above the base
    relief_step_mm: float = 0.4  # by_luminance: step between colours
    base_filament: int | None = None  # None = the non-bed filament covering the most area
    mirror: bool = False
    upscale: int | None = None  # None = auto (about 2048 px on the long side, max x4)
    smooth_sigma: float = 0.8
    simplify_px: float = 0.8


@dataclass
class BuildWarning:
    code: str
    message: str
    detail: dict = field(default_factory=dict)


@dataclass
class Element:
    """A set of regions printed with one filament between z0 and z1."""

    key: str
    filament: int
    z0: float
    z1: float
    regions: list[int]
    footprint: object = None
    area_mm2: float = 0.0


@dataclass
class Part:
    filament: int
    name: str
    hex: str
    solid: object  # manifold3d.Manifold
    mesh: object  # trimesh.Trimesh
    volume_mm3: float
    grams: float
    z_max: float


@dataclass
class ReliefResult:
    parts: list[Part]
    elements: list[Element]
    silhouette: object
    size_mm: tuple[float, float, float]
    base_filament: int
    base_mm: float
    mapping: list[int]
    filament_heights: dict[int, float]
    changes: ChangeEstimate
    warnings: list[BuildWarning]
    filaments: list[Filament]
    layer_mm: float

    def footprints_for_preview(self):
        return [(e.footprint, e.z1, self.filaments[e.filament].rgb) for e in self.elements if e.footprint is not None]


def snap(z: float, layer: float) -> float:
    """Round to the nearest multiple of the layer height (at least one layer)."""
    return round(max(1, round(z / layer)) * layer, 6)


def filament_heights(
    filaments: list[Filament], used: list[int], settings: BuildSettings, base_mm: float
) -> dict[int, float]:
    """Top height per filament. Manual heights win; missing ones fall back to luminance order."""
    layer = settings.layer_mm
    order = sorted(used, key=lambda i: relative_luminance(filaments[i].rgb), reverse=not settings.lighter_taller)
    auto = {f: snap(base_mm + settings.relief_min_mm + rank * settings.relief_step_mm, layer) for rank, f in enumerate(order)}
    heights: dict[int, float] = {}
    for i, f in enumerate(filaments):
        if settings.height_mode == "manual" and f.height_mm is not None:
            heights[i] = snap(f.height_mm, layer)
        else:
            heights[i] = auto.get(i, snap(base_mm + settings.relief_min_mm, layer))
    return heights


def _extrude_all(elements: list[Element], silhouette, base_fil: int, base_mm: float):
    """Extrude every element (and the base slab) and union them per filament."""
    silhouette = geo.clean(unary_union([e.footprint for e in elements if not e.footprint.is_empty]))
    bed_other = [e.footprint for e in elements if e.z0 == 0.0 and e.filament != base_fil]
    slab = geo.clean(silhouette.difference(unary_union(bed_other)) if bed_other else silhouette, 1e-6)
    solids: dict[int, list] = {}
    intervals: list[tuple[int, float, float]] = []
    if not slab.is_empty and base_mm > 0:
        solids.setdefault(base_fil, []).append(geo.extrude(slab, 0.0, base_mm))
        intervals.append((base_fil, 0.0, base_mm))
    for e in elements:
        z0 = base_mm if e.filament == base_fil else e.z0
        if e.z1 > z0 and not e.footprint.is_empty:
            solids.setdefault(e.filament, []).append(geo.extrude(e.footprint, z0, e.z1))
            intervals.append((e.filament, z0, e.z1))
    merged = {}
    for fil in sorted(solids):
        solid = geo.union_solids(solids[fil])
        if solid is not None:
            merged[fil] = solid
    return merged, intervals, silhouette


def _resolve_pinches(elements: list[Element], pinches: dict[int, list], base_fil: int, base_mm: float) -> None:
    """Give a tiny disc around each pinch point to a single element.

    A pinch is where two pieces of one filament touch only at a point (in 2D) and so share
    just an edge in 3D. Handing the disc to one element joins that filament's pieces with
    a small bridge and cleanly separates everyone else's.
    """
    from shapely.geometry import Point

    done: list[Point] = []
    for fil, edges in pinches.items():
        for x, y, zlo, zhi in edges:
            pt = Point(x, y)
            if any(pt.distance(d) < 0.03 for d in done):
                continue
            done.append(pt)
            disc = pt.buffer(0.03, quad_segs=4)
            touching = [e for e in elements if not e.footprint.is_empty and e.footprint.intersects(disc)]
            spans = [
                e
                for e in touching
                if e.filament == fil and (base_mm if e.filament == base_fil else e.z0) <= zhi + 1e-9 and e.z1 >= zlo - 1e-9
            ]
            if not spans and fil == base_fil:
                # The base slab itself is pinched between bed-starting parts: bridge those instead.
                spans = [e for e in touching if e.z0 == 0.0 and e.filament != base_fil]
            if spans:
                owner = max(spans, key=lambda e: (e.z1, e.footprint.intersection(disc).area))
                for e in touching:
                    if e is owner:
                        e.footprint = geo.clean(unary_union([e.footprint, disc]))
                    else:
                        e.footprint = geo.clean(e.footprint.difference(disc))
            else:
                for e in touching:
                    e.footprint = geo.clean(e.footprint.difference(disc))
    for e in elements:
        e.area_mm2 = e.footprint.area


def build_relief(
    analysis: Analysis,
    filaments: list[Filament],
    settings: BuildSettings | None = None,
    mapping: list[int] | None = None,
    cluster_heights: dict[int, float] | None = None,
    region_overrides: dict[int, RegionOverride] | None = None,
) -> ReliefResult:
    settings = settings or BuildSettings()
    warnings: list[BuildWarning] = []
    layer = settings.layer_mm
    if not filaments:
        raise ValueError("at least one filament is required")
    if layer <= 0 or settings.nozzle_mm <= 0 or settings.width_mm <= 0:
        raise ValueError("layer height, nozzle and width must be positive")
    n_clusters = len(analysis.clusters)
    if n_clusters == 0:
        raise ValueError("the image has no foreground")

    # ---- mapping ---------------------------------------------------------------
    if mapping is None:
        res = suggest_mapping(
            [c.lab for c in analysis.clusters],
            [c.share for c in analysis.clusters],
            analysis.adjacency,
            [f.lab for f in filaments],
        )
        mapping = res.assignment
    if len(mapping) != n_clusters:
        raise ValueError(f"mapping has {len(mapping)} entries but the analysis has {n_clusters} colours")
    if any(not 0 <= m < len(filaments) for m in mapping):
        raise ValueError("mapping refers to a filament that does not exist")
    region_overrides = region_overrides or {}
    cluster_heights = cluster_heights or {}

    # ---- per-region filament and heights ----------------------------------------
    n_regions = len(analysis.region_info)
    reg_fil = np.empty(n_regions, np.int64)
    for r in analysis.region_info:
        ov = region_overrides.get(r.id)
        fil = ov.filament if ov is not None and ov.filament is not None else mapping[r.cluster]
        if not 0 <= fil < len(filaments):
            raise ValueError(f"region {r.id} override refers to a filament that does not exist")
        reg_fil[r.id] = fil
    areas = np.bincount(reg_fil, weights=[r.area for r in analysis.region_info], minlength=len(filaments))
    used = [i for i in range(len(filaments)) if areas[i] > 0]

    base_mm = snap(settings.base_mm, layer)
    if settings.base_filament is not None:
        if not 0 <= settings.base_filament < len(filaments):
            raise ValueError("base_filament refers to a filament that does not exist")
        base_fil = settings.base_filament
    else:
        candidates = [i for i in used if not filaments[i].start_from_bed] or used
        base_fil = max(candidates, key=lambda i: areas[i])
    heights = filament_heights(filaments, used, settings, base_mm)

    groups: dict[tuple[int, float, float], list[int]] = {}
    clamped: dict[int, list[float]] = {}
    for r in analysis.region_info:
        fil = int(reg_fil[r.id])
        ov = region_overrides.get(r.id)
        if ov is not None and ov.height_mm is not None:
            z1 = snap(ov.height_mm, layer)
        elif r.cluster in cluster_heights and cluster_heights[r.cluster] is not None:
            z1 = snap(cluster_heights[r.cluster], layer)
        else:
            z1 = heights[fil]
        from_bed = filaments[fil].start_from_bed or fil == base_fil
        z0 = 0.0 if from_bed else base_mm
        if fil == base_fil:
            lo = base_mm
        elif from_bed:
            lo = layer
        else:
            lo = round(base_mm + layer, 6)
        if z1 < lo:
            clamped.setdefault(fil, []).append(z1)
            z1 = lo
        groups.setdefault((fil, z0, z1), []).append(r.id)
    for fil, zs in clamped.items():
        warnings.append(
            BuildWarning(
                "height_clamped",
                f"{filaments[fil].name}: heights below {base_mm if fil == base_fil else base_mm + layer:.2f} mm were raised so the colour stays visible above the base.",
                {"filament": fil, "requested": sorted(set(zs))},
            )
        )

    elements: list[Element] = []
    region_to_element = np.full(n_regions + 1, -1, np.int32)
    for idx, ((fil, z0, z1), regs) in enumerate(sorted(groups.items())):
        elements.append(Element(key=f"f{fil}_z{z0:g}-{z1:g}", filament=fil, z0=z0, z1=z1, regions=regs))
        region_to_element[np.asarray(regs) + 1] = idx
    elem_labels = region_to_element[analysis.regions + 1].astype(np.int16)

    # ---- raster -> vector ----------------------------------------------------------
    h, w = elem_labels.shape
    up = settings.upscale or int(min(4, max(1, round(2048 / max(h, w)))))
    big = geo.smooth_upscale(elem_labels, len(elements), up, settings.smooth_sigma)
    big = remove_specks(big, max(4, int(round(10 * (max(h, w) / 512) ** 2 * up * up / 4))))

    sil_px = geo.mask_polygons(big >= 0, settings.simplify_px)
    if sil_px.is_empty:
        raise ValueError("nothing left to print after cleaning the image")
    minx, miny, maxx, maxy = sil_px.bounds
    dims = {"width": maxx - minx, "height": maxy - miny}
    dims["longest"] = max(dims["width"], dims["height"])
    if settings.size_mode not in dims:
        raise ValueError("size_mode must be width, height or longest")
    scale = settings.width_mm / dims[settings.size_mode]
    bounds = (minx, miny, maxx, maxy)

    def to_mm(g):
        return geo.clean(geo.pixel_to_mm(g, bounds, scale, settings.mirror))

    silhouette = to_mm(sil_px)
    items = []
    for i, e in enumerate(elements):
        g = to_mm(geo.mask_polygons(big == i, settings.simplify_px))
        items.append(geo.PartitionItem(key=e.key, geom=g, z1=e.z1))

    min_feature = settings.min_feature_mm or settings.nozzle_mm
    finals, silhouette, report = geo.partition(items, silhouette, min_feature)
    for e in elements:
        e.footprint = finals.get(e.key, geo.EMPTY)
        e.area_mm2 = e.footprint.area
        raw = next(it.area for it in items if it.key == e.key)
        lost = report.removed_area.get(e.key, 0.0)
        if e.footprint.is_empty and raw > 0:
            warnings.append(
                BuildWarning(
                    "region_removed",
                    f"{filaments[e.filament].name} areas at {e.z1:g} mm are all narrower than {min_feature:g} mm and were removed.",
                    {"filament": e.filament, "z1": e.z1, "area_mm2": round(raw, 2)},
                )
            )
        elif lost > max(1.0, 0.05 * raw):
            warnings.append(
                BuildWarning(
                    "thin_features_removed",
                    f"{filaments[e.filament].name}: {lost:.1f} mm² of detail narrower than {min_feature:g} mm was merged into neighbours.",
                    {"filament": e.filament, "z1": e.z1, "area_mm2": round(lost, 2)},
                )
            )
    if report.dropped_area > 1.0:
        warnings.append(
            BuildWarning(
                "outline_trimmed",
                f"{report.dropped_area:.1f} mm² of thin outline detail was trimmed from the silhouette.",
                {"area_mm2": round(report.dropped_area, 2)},
            )
        )
    elements = [e for e in elements if not e.footprint.is_empty]

    # ---- extrusion -------------------------------------------------------------------
    for _attempt in range(6):
        merged, intervals, silhouette = _extrude_all(elements, silhouette, base_fil, base_mm)
        pinches = {fil: geo.pinch_edges(solid) for fil, solid in merged.items()}
        if not any(pinches.values()):
            break
        _resolve_pinches(elements, pinches, base_fil, base_mm)
    else:
        warnings.append(
            BuildWarning(
                "non_manifold_edges",
                "Some parts still touch themselves along an edge; slicers usually repair this automatically.",
                {"filaments": [filaments[f].name for f, p in pinches.items() if p]},
            )
        )

    parts: list[Part] = []
    for fil in sorted(merged):
        solid = merged[fil]
        mesh = geo.manifold_to_trimesh(solid)
        vol = float(solid.volume())
        f = filaments[fil]
        parts.append(
            Part(
                filament=fil,
                name=f.name,
                hex=f.hex,
                solid=solid,
                mesh=mesh,
                volume_mm3=vol,
                grams=vol / 1000.0 * f.density,
                z_max=float(mesh.bounds[1][2]),
            )
        )
    unused = [filaments[i].name for i in range(len(filaments)) if i not in merged]
    if unused:
        warnings.append(BuildWarning("unused_filaments", "Not used by this design: " + ", ".join(unused) + ".", {"filaments": unused}))

    b = silhouette.bounds
    top = max((p.z_max for p in parts), default=0.0)
    changes = estimate_changes(layer_sets(intervals, layer), layer)
    return ReliefResult(
        parts=parts,
        elements=elements,
        silhouette=silhouette,
        size_mm=(b[2] - b[0], b[3] - b[1], top),
        base_filament=base_fil,
        base_mm=base_mm,
        mapping=list(mapping),
        filament_heights=heights,
        changes=changes,
        warnings=warnings,
        filaments=filaments,
        layer_mm=layer,
    )

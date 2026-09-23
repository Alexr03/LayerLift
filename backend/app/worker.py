"""CPU-heavy work, executed in worker processes (see app.pool)."""

from __future__ import annotations

import base64
import io
import json
import os
import time
from pathlib import Path

import numpy as np
from PIL import Image

from relief.analyse import Analysis, analyse
from relief.export import export_3mf, export_glb, export_stl_zip
from relief.imageio import foreground_mask, load_image
from relief.mapping import suggest_mapping
from relief.pipeline import BuildSettings, Filament, RegionOverride, build_relief
from relief.preview import png_bytes, preview_image


def compute_analysis(image: bytes, options: dict, max_side: int) -> tuple[Analysis, dict]:
    loaded = load_image(image, max_side=max_side)
    bg = options.get("background", {})
    mask, info = foreground_mask(loaded.rgba, mode=bg.get("mode", "auto"), colour=bg.get("colour"), tolerance=bg.get("tolerance", 12.0))
    if mask.sum() < 16:
        raise ValueError("no foreground found; check the background setting")
    analysis = analyse(
        loaded.rgba,
        mask,
        max_colours=options.get("max_colours", 12),
        n_colours=options.get("n_colours"),
        merge_delta_e=options.get("merge_delta_e", 8.0),
        background=info,
    )
    meta = {"source_format": loaded.source_format, "original_size": loaded.original_size, "scale": loaded.scale}
    return analysis, meta


def region_map_png(analysis: Analysis) -> str:
    ids = analysis.regions.astype(np.int64) + 1  # 0 = background
    rgb = np.stack([(ids >> 16) & 255, (ids >> 8) & 255, ids & 255], -1).astype(np.uint8)
    buf = io.BytesIO()
    Image.fromarray(rgb, "RGB").save(buf, format="PNG", optimize=True)
    return base64.b64encode(buf.getvalue()).decode("ascii")


def analysis_payload(analysis: Analysis, meta: dict, filaments: list[dict] | None) -> dict:
    h, w = analysis.shape
    outline = max(analysis.region_info, key=lambda r: r.outline_share, default=None)
    payload = {
        "width": w,
        "height": h,
        "source_format": meta["source_format"],
        "original_size": meta["original_size"],
        "background": analysis.background,
        "clusters": [
            {"id": c.id, "hex": c.hex, "rgb": c.rgb, "share": c.share, "pixels": c.pixels} for c in analysis.clusters
        ],
        "regions": [
            {
                "id": r.id,
                "cluster": r.cluster,
                "area": r.area,
                "bbox": r.bbox,
                "centroid": r.centroid,
                "outline_share": r.outline_share,
            }
            for r in analysis.region_info
        ],
        "adjacency": analysis.adjacency.tolist(),
        "outline_region": outline.id if outline is not None and outline.outline_share > 0.5 else None,
        "region_map_png": region_map_png(analysis),
        "suggested_mapping": None,
    }
    if filaments:
        fl = [Filament(**f) for f in filaments]
        payload["suggested_mapping"] = suggest_mapping(
            [c.lab for c in analysis.clusters], [c.share for c in analysis.clusters], analysis.adjacency, [f.lab for f in fl]
        ).assignment
    return payload


def run_analysis(image: bytes, options: dict, max_side: int, filaments: list[dict] | None) -> tuple[Analysis, dict]:
    analysis, meta = compute_analysis(image, options, max_side)
    return analysis, analysis_payload(analysis, meta, filaments)


class ProgressWriter:
    """Writes {stage, progress} to a JSON file the API process reads when the browser polls."""

    def __init__(self, path: str | None):
        self.path = path
        self.stage = ""
        self.last = 0.0

    def __call__(self, stage: str, fraction: float) -> None:
        if self.path is None:
            return
        now = time.monotonic()
        # Throttle repeats of the same stage; always write stage changes.
        if stage == self.stage and now - self.last < 0.2:
            return
        self.stage, self.last = stage, now
        tmp = self.path + ".tmp"
        try:
            with open(tmp, "w", encoding="utf8") as fh:
                json.dump({"stage": stage, "progress": round(max(0.0, min(1.0, fraction)), 3)}, fh)
            os.replace(tmp, self.path)
        except OSError:
            pass  # a reader holding the file open (Windows) just means this update is skipped


def run_build(
    image: bytes | None, analysis: Analysis | None, request: dict, job_dir: str, max_side: int
) -> tuple[Analysis, dict]:
    """Build the relief and write every output file into job_dir. Returns stats for the API."""
    t0 = time.perf_counter()
    report = ProgressWriter(str(Path(job_dir) / "progress.json"))
    start = 0.0
    if analysis is None:
        report("Finding colours", 0.0)
        analysis, _ = compute_analysis(image, request.get("analysis", {}), max_side)
        start = 0.1
    span = 0.85 - start
    filaments = [Filament(**f) for f in request["filaments"]]
    settings = BuildSettings(
        width_mm=request["width_mm"],
        size_mode=request["size_mode"],
        nozzle_mm=request["nozzle_mm"],
        layer_mm=request["layer_mm"],
        base_mm=request["base_mm"],
        min_feature_mm=request.get("min_feature_mm"),
        height_mode=request["height_mode"],
        lighter_taller=request["lighter_taller"],
        relief_min_mm=request["relief_min_mm"],
        relief_step_mm=request["relief_step_mm"],
        base_filament=request.get("base_filament"),
        mirror=request["mirror"],
    )
    overrides = {int(k): RegionOverride(**v) for k, v in request.get("region_overrides", {}).items()}
    n_regions = len(analysis.region_info)
    bad = [k for k in overrides if not 0 <= k < n_regions]
    if bad:
        raise ValueError(f"unknown region ids: {bad[:5]}")
    result = build_relief(
        analysis,
        filaments,
        settings,
        mapping=request.get("mapping"),
        cluster_heights={int(k): v for k, v in request.get("cluster_heights", {}).items()},
        region_overrides=overrides,
        progress=lambda stage, f: report(stage, start + span * f),
    )
    title = request.get("title") or "LayerLift relief"
    out = Path(job_dir)
    report("Rendering previews", 0.86)
    preview = png_bytes(preview_image(result.footprints_for_preview(), result.size_mm[:2], px_per_mm=max(2.0, 800 / max(result.size_mm[:2]))))
    thumb = png_bytes(preview_image(result.footprints_for_preview(), result.size_mm[:2], px_per_mm=max(1.0, 256 / max(result.size_mm[:2]))))
    (out / "preview.png").write_bytes(preview)
    (out / "model.glb").write_bytes(export_glb(result))
    report("Writing the 3MF and STL files", 0.9)
    (out / "relief.3mf").write_bytes(export_3mf(result, title, thumbnail_png=thumb))
    (out / "relief_stl.zip").write_bytes(export_stl_zip(result, title))
    stats = {
        "title": title,
        "size_mm": [round(v, 3) for v in result.size_mm],
        "base_filament": result.base_filament,
        "base_mm": result.base_mm,
        "mapping": result.mapping,
        "filament_heights": result.filament_heights,
        "parts": [
            {
                "slot": p.filament + 1,
                "filament": p.filament,
                "name": p.name,
                "hex": p.hex,
                "volume_mm3": round(p.volume_mm3, 1),
                "grams": round(p.grams, 2),
                "z_max": round(p.z_max, 3),
            }
            for p in result.parts
        ],
        "total_grams": round(sum(p.grams for p in result.parts), 2),
        "filament_changes": result.changes.total,
        "layers": [
            {"index": l.index, "z_top": l.z_top, "filaments": l.filaments, "changes": l.changes} for l in result.changes.layers
        ],
        "warnings": [{"code": w.code, "message": w.message, "detail": w.detail} for w in result.warnings],
        "elapsed_s": round(time.perf_counter() - t0, 2),
    }
    (out / "result.json").write_text(json.dumps(stats))
    return analysis, stats

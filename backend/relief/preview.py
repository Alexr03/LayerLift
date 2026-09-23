"""Top-down hill-shaded preview of the relief."""

from __future__ import annotations

import io

import cv2
import numpy as np
from PIL import Image

from .geometry import polygons_of

SHIFT = 4  # fixed-point bits for sub-pixel polygon filling


def _fill(canvas: np.ndarray, geom, to_px) -> None:
    rings = []
    for p in polygons_of(geom):
        rings.append(to_px(np.asarray(p.exterior.coords)))
        rings.extend(to_px(np.asarray(h.coords)) for h in p.interiors)
    if rings:
        cv2.fillPoly(canvas, rings, 1, lineType=cv2.LINE_8, shift=SHIFT)


def render_heightmap(
    footprints: list[tuple[object, float, tuple[int, int, int]]],
    size_mm: tuple[float, float],
    px_per_mm: float = 8.0,
    margin_mm: float = 2.0,
    background=(230, 230, 230),
) -> tuple[np.ndarray, np.ndarray]:
    """Rasterise (geometry, top z, rgb) footprints into height and colour maps.

    The footprints partition the silhouette, so each pixel's top surface is simply the
    footprint covering it. This matches a straight-down ray cast of the extruded meshes.
    """
    w_mm, h_mm = size_mm
    nx = int(np.ceil((w_mm + 2 * margin_mm) * px_per_mm))
    ny = int(np.ceil((h_mm + 2 * margin_mm) * px_per_mm))
    z = np.zeros((ny, nx), np.float32)
    col = np.empty((ny, nx, 3), np.float32)
    col[:] = background
    scale = px_per_mm * (1 << SHIFT)

    def to_px(xy: np.ndarray) -> np.ndarray:
        px = (xy[:, 0] + margin_mm) * scale
        py = (h_mm + margin_mm - xy[:, 1]) * scale
        return np.round(np.stack([px, py], 1)).astype(np.int32)

    for geom, top, rgb in sorted(footprints, key=lambda t: t[1]):
        m = np.zeros((ny, nx), np.uint8)
        _fill(m, geom, to_px)
        sel = m.astype(bool)
        z[sel] = top
        col[sel] = rgb
    return z, col


def hillshade(z: np.ndarray, col: np.ndarray, px_per_mm: float) -> np.ndarray:
    gy, gx = np.gradient(z * px_per_mm * 3)
    nx, ny, nz = -gx, gy, np.ones_like(z)
    light = np.array([-0.5, 0.6, 0.7])
    light /= np.linalg.norm(light)
    shade = (nx * light[0] + ny * light[1] + nz * light[2]) / np.sqrt(nx**2 + ny**2 + nz**2)
    return np.clip(col * (0.35 + 0.75 * np.clip(shade, 0, 1))[..., None], 0, 255).astype(np.uint8)


def preview_image(footprints, size_mm, px_per_mm: float = 8.0, margin_mm: float = 2.0) -> np.ndarray:
    z, col = render_heightmap(footprints, size_mm, px_per_mm, margin_mm)
    return hillshade(z, col, px_per_mm)


def png_bytes(img: np.ndarray) -> bytes:
    buf = io.BytesIO()
    Image.fromarray(img).save(buf, format="PNG", optimize=True)
    return buf.getvalue()

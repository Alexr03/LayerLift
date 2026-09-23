"""Image loading: PNG / JPEG / WebP / SVG into an RGBA array plus a foreground mask."""

from __future__ import annotations

import io
import re
from dataclasses import dataclass

import numpy as np
from PIL import Image, ImageOps

from .colour import hex_to_rgb, srgb_to_lab, delta_e_2000

Image.MAX_IMAGE_PIXELS = 64_000_000  # decompression-bomb guard (~8000 x 8000)

SUPPORTED_FORMATS = {"PNG", "JPEG", "WEBP"}
_SVG_SNIFF = re.compile(rb"<svg[\s>]", re.IGNORECASE)
_EXTERNAL_HREF = re.compile(r"""(?:xlink:)?href\s*=\s*["'](?!#|data:)""", re.IGNORECASE)


class ImageError(ValueError):
    """Raised for unsupported or unreadable images."""


@dataclass
class LoadedImage:
    rgba: np.ndarray  # (H, W, 4) uint8
    source_format: str
    original_size: tuple[int, int]  # (width, height) before any downscale
    scale: float  # processing size / original size


_BINARY_MAGIC = (b"\x89PNG", b"\xff\xd8", b"RIFF", b"GIF8", b"BM", b"II*\x00", b"MM\x00*")


def _looks_like_svg(data: bytes) -> bool:
    if data.startswith(_BINARY_MAGIC):
        return False
    head = data[:65536].lstrip(b"\xef\xbb\xbf \t\r\n")
    return head.startswith(b"<") and bool(_SVG_SNIFF.search(head))


def _rasterise_svg(data: bytes, target_px: int) -> Image.Image:
    import resvg_py

    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise ImageError("SVG is not valid UTF-8") from exc
    if _EXTERNAL_HREF.search(text):
        raise ImageError("SVGs that reference external files are not supported; embed images as data: URIs")
    if "<!ENTITY" in text:
        raise ImageError("SVGs with XML entity declarations are not supported")
    try:
        # Render once at default size to read the aspect ratio, then at the target size.
        probe = Image.open(io.BytesIO(bytes(resvg_py.svg_to_bytes(svg_string=text, skip_system_fonts=False))))
        w, h = probe.size
        if w >= h:
            png = resvg_py.svg_to_bytes(svg_string=text, width=target_px)
        else:
            png = resvg_py.svg_to_bytes(svg_string=text, height=target_px)
    except ValueError as exc:
        raise ImageError(f"could not render SVG: {exc}") from exc
    return Image.open(io.BytesIO(bytes(png)))


def load_image(data: bytes, max_side: int = 1024) -> LoadedImage:
    """Decode image bytes into RGBA, downscaling so the longest side is at most ``max_side``.

    SVGs are rasterised directly at ``max_side``.
    """
    if not data:
        raise ImageError("empty file")
    if _looks_like_svg(data):
        img = _rasterise_svg(data, max_side)
        fmt = "SVG"
        original = img.size
    else:
        try:
            img = Image.open(io.BytesIO(data))
            img.load()
        except Image.DecompressionBombError as exc:
            raise ImageError("image is too large") from exc
        except Exception as exc:  # PIL raises many exception types for bad input
            raise ImageError("unrecognised or corrupt image file") from exc
        fmt = (img.format or "").upper()
        if fmt not in SUPPORTED_FORMATS:
            raise ImageError(f"unsupported image format {fmt or 'unknown'}; use PNG, JPEG, WebP or SVG")
        img = ImageOps.exif_transpose(img)
        original = img.size

    # Palette PNGs carry transparency in the palette; convert() handles that.
    img = img.convert("RGBA")
    scale = 1.0
    longest = max(img.size)
    if longest > max_side:
        scale = max_side / longest
        new_size = (max(1, round(img.size[0] * scale)), max(1, round(img.size[1] * scale)))
        img = img.resize(new_size, Image.Resampling.LANCZOS)
    rgba = np.asarray(img, dtype=np.uint8).copy()
    if rgba.shape[0] < 8 or rgba.shape[1] < 8:
        raise ImageError("image is too small (minimum 8 x 8 pixels)")
    return LoadedImage(rgba=rgba, source_format=fmt, original_size=original, scale=scale)


def detect_background_colour(rgba: np.ndarray) -> tuple[int, int, int]:
    """Most common colour along the image border (quantised), for images without alpha."""
    border = np.concatenate([rgba[0, :, :3], rgba[-1, :, :3], rgba[:, 0, :3], rgba[:, -1, :3]])
    q = (border // 8).astype(np.int32)
    keys = q[:, 0] * 1024 + q[:, 1] * 32 + q[:, 2]
    top = np.bincount(keys).argmax()
    return tuple(int(v) for v in np.median(border[keys == top], axis=0))


def foreground_mask(
    rgba: np.ndarray,
    mode: str = "auto",
    colour: str | None = None,
    tolerance: float = 12.0,
    alpha_threshold: int = 128,
) -> tuple[np.ndarray, dict]:
    """Compute the foreground mask.

    mode: 'alpha' (alpha > threshold), 'colour' (pixels far from ``colour`` in CIEDE2000),
    'none' (whole image), or 'auto' (alpha if the image has transparency, else the
    border colour is treated as background).
    Returns the mask and a dict describing what was used.
    """
    alpha = rgba[..., 3]
    has_alpha = bool((alpha < 250).mean() > 0.01)
    if mode == "auto":
        mode = "alpha" if has_alpha else "colour"
    info: dict = {"mode": mode}
    if mode == "alpha":
        mask = alpha > alpha_threshold
    elif mode == "none":
        mask = np.ones(alpha.shape, bool)
    elif mode == "colour":
        rgb = hex_to_rgb(colour) if colour else detect_background_colour(rgba)
        info["colour"] = "#%02X%02X%02X" % rgb
        lab = srgb_to_lab(rgba[..., :3])
        d = delta_e_2000(lab, srgb_to_lab(np.array(rgb, float)))
        mask = (d > tolerance) & (alpha > alpha_threshold)
    else:
        raise ValueError(f"unknown background mode {mode!r}")
    return mask, info

"""Generate the LayerLift wordmark: the word lifting off in layers, left to right.

"LayerLift" is set in Barlow Condensed (the app's display face) three times, as three stacked
layers. The bottom layer lies flat; each layer above is sheared upward a little more, so on the
left the three coincide and "Layer" reads as one solid word, while towards the right the top
layer comes up and off and the layers beneath show through, which is what the app does to a
flat image. Each layer has a darker underside so it reads as a slab with thickness.

Writes:
  docs/brand/logo.svg          for light backgrounds (README, anywhere without CSS)
  docs/brand/logo-dark.svg     for dark backgrounds
  frontend/src/logo-data.ts    outlines and geometry for the app's <Wordmark> component
  frontend/index.html          the loading screen's copy, between the wordmark markers
  frontend/public/favicon.svg  the tab icon: three slabs lifting off the same way, light and dark
The app's copies take their colours from CSS (--wm-0..2 in index.html), so they follow the theme,
and each layer's lift is a CSS variable (--a) so the loading screen can animate it.

Run from the repository root (fonts come from the frontend's node_modules):
  uv run --no-project --with fonttools --with brotli --with uharfbuzz python docs/brand/make_logo.py
"""

from __future__ import annotations

import io
import json
import math
from pathlib import Path

import uharfbuzz as hb
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parents[2]
FONT = ROOT / "frontend/node_modules/@fontsource/barlow-condensed/files/barlow-condensed-latin-700-normal.woff2"
TEXT = "LayerLift"
NL = "\n"

LAYERS = 3  # bottom to top
LIFT_DEG = 2.0  # extra upward shear per layer, in degrees: layer i rises tan(i * LIFT_DEG) * x
EDGE = 20  # thickness of each layer's darker underside, in font units
TRACKING = 8  # extra space between letters, in font units
PAD = 40

PALETTES = {
    # bottom -> top. The top layer carries the word, so it gets the strongest contrast.
    "light": {"layers": ["#c7962f", "#2f5d8c", "#1f2328"], "edge": 0.62},
    "dark": {"layers": ["#d9a93f", "#7fb0e0", "#e8eaed"], "edge": 0.55},
}


def shade(hex_colour: str, factor: float) -> str:
    r, g, b = (int(hex_colour[i : i + 2], 16) for i in (1, 3, 5))
    return "#{:02x}{:02x}{:02x}".format(*(max(0, min(255, round(c * factor))) for c in (r, g, b)))


def outline(text: str = TEXT) -> tuple[str, float, float, float]:
    """The text as one SVG path (y down, baseline at y=0), with its width, cap height, descender."""
    font = TTFont(FONT)
    font.flavor = None
    raw = io.BytesIO()
    font.save(raw)
    hb_font = hb.Font(hb.Face(raw.getvalue()))
    buf = hb.Buffer()
    buf.add_str(text)
    buf.guess_segment_properties()
    hb.shape(hb_font, buf, {"kern": True, "liga": True})

    glyph_set = font.getGlyphSet()
    order = font.getGlyphOrder()
    pen = SVGPathPen(glyph_set)
    x = 0.0
    for info, pos in zip(buf.glyph_infos, buf.glyph_positions):
        # Flip y (fonts are y-up) and place the glyph at the pen position.
        glyph_set[order[info.codepoint]].draw(TransformPen(pen, (1, 0, 0, -1, x + pos.x_offset, -pos.y_offset)))
        x += pos.x_advance + TRACKING
    cap = float(getattr(font["OS/2"], "sCapHeight", 0) or 700)
    descender = float(-min(0, font["hhea"].descent))
    return pen.getCommands(), x - TRACKING, cap, descender


def geometry_for(d: str, width: float, cap: float, descender: float) -> dict:
    rise = math.tan(math.radians((LAYERS - 1) * LIFT_DEG)) * width  # how far the top layer's right end rises
    min_y = -cap - rise - PAD
    max_y = descender + EDGE + PAD
    return {
        "d": d,
        "viewBox": [-PAD, round(min_y), round(width + 2 * PAD), round(max_y - min_y)],
        "angles": [-i * LIFT_DEG for i in range(LAYERS)],  # CSS skewY per layer, bottom to top
        "edge": EDGE,
    }


def standalone(geometry: dict, palette: dict) -> str:
    """The wordmark with its colours built in, for the README and anywhere without the app's CSS."""
    x, y, w, h = geometry["viewBox"]
    layers = []
    for i, angle in enumerate(geometry["angles"]):
        colour = palette["layers"][i]
        shear = -math.tan(math.radians(-angle))
        layers.append(
            f'<g transform="matrix(1 {shear:.5f} 0 1 0 0)">'
            f'<use href="#w" fill="{shade(colour, palette["edge"])}" transform="translate(0 {geometry["edge"]})"/>'
            f'<use href="#w" fill="{colour}"/></g>'
        )
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{x} {y} {w} {h}" role="img" aria-label="LayerLift">'
        f'<title>LayerLift</title><defs><path id="w" d="{geometry["d"]}"/></defs>{"".join(layers)}</svg>{NL}'
    )


def themed_markup(geometry: dict, path_id: str) -> str:
    """The wordmark for the app: colours from CSS classes, each layer's lift a CSS variable.
    Must match components/Wordmark.tsx, which renders the same structure from logo-data.ts."""
    x, y, w, h = geometry["viewBox"]
    origin = f"{-x}px {-y}px"  # user-space (0, 0), where the layers are hinged
    layers = "".join(
        f'<g class="wm-layer" style="--a: {a:g}deg; transform-origin: {origin}">'
        f'<use href="#{path_id}" class="l{i} edge" transform="translate(0 {geometry["edge"]})"/>'
        f'<use href="#{path_id}" class="l{i}"/></g>'
        for i, a in enumerate(geometry["angles"])
    )
    return (
        f'<svg class="wordmark" viewBox="{x} {y} {w} {h}" role="img" aria-label="LayerLift">'
        f'<defs><path id="{path_id}" d="{geometry["d"]}"/></defs>{layers}</svg>'
    )


def favicon() -> str:
    """The tab icon: three slabs in the wordmark's colours, hinged on the left and lifting up and
    off to the right, like the word. Letters are unreadable at 16 px; this shape isn't."""
    x, w, h, gap, edge = 6, 52, 9, 2.5, 3
    lift_deg = 6.0  # the top slab's right end rises tan(12 deg) * 52 = 11 units: it stays in the box
    bottom = 56  # bottom of the lowest slab
    slabs = []
    for i in range(LAYERS):
        y = bottom - h - i * (h + gap + edge)
        shear = -math.tan(math.radians(i * lift_deg))
        # Hinge at the slab's left end: shear about (x, y + h).
        hinge = f"translate({x} {y + h}) matrix(1 {shear:.5f} 0 1 0 0) translate({-x} {-(y + h)})"
        slabs.append(
            f'<g transform="{hinge}">'
            f'<rect class="l{i} e" x="{x}" y="{y + edge}" width="{w}" height="{h}" rx="2.5"/>'
            f'<rect class="l{i}" x="{x}" y="{y}" width="{w}" height="{h}" rx="2.5"/></g>'
        )

    def css(palette: dict) -> str:
        return "".join(
            f".l{i}{{fill:{c}}}.l{i}.e{{fill:{shade(c, palette['edge'])}}}" for i, c in enumerate(palette["layers"])
        )

    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">'
        f"<style>{css(PALETTES['light'])}@media (prefers-color-scheme: dark){{{css(PALETTES['dark'])}}}</style>"
        f'{"".join(slabs)}</svg>{NL}'
    )


def write(path: Path, text: str) -> None:
    path.write_text(text, encoding="utf-8", newline=NL)


def main() -> None:
    d, width, cap, descender = outline()
    geometry = geometry_for(d, width, cap, descender)
    write(ROOT / "docs/brand/logo.svg", standalone(geometry, PALETTES["light"]))
    write(ROOT / "docs/brand/logo-dark.svg", standalone(geometry, PALETTES["dark"]))
    write(
        ROOT / "frontend/src/logo-data.ts",
        "// Generated by docs/brand/make_logo.py; do not edit by hand." + NL
        + f"export const LOGO = {json.dumps(geometry, separators=(',', ':'))} as const" + NL,
    )
    index = ROOT / "frontend/index.html"
    html = index.read_text(encoding="utf-8")
    start, end = "<!-- wordmark:start -->", "<!-- wordmark:end -->"
    a, b = html.index(start) + len(start), html.index(end)
    write(index, html[:a] + themed_markup(geometry, "ll-splash-w") + html[b:])
    write(ROOT / "frontend/public/favicon.svg", favicon())
    print(f"width {width:.0f}, cap {cap:.0f}, descender {descender:.0f}, viewBox {geometry['viewBox']}")


if __name__ == "__main__":
    main()

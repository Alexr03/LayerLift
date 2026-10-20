// Label icons: a few built-in shapes for common drawer contents, and SVG files turned into
// outlines. Every icon is fitted to the unit square, y up, outer outlines counter-clockwise and
// holes clockwise (so they combine with text under the non-zero fill rule).
import type { LabelIcon } from './types'

type Pt = [number, number]
type Poly = Pt[]

const TAU = Math.PI * 2

function circle(cx: number, cy: number, r: number, n = 32, cw = false): Poly {
  const pts: Poly = []
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU * (cw ? -1 : 1)
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)])
  }
  return pts
}

function ngon(cx: number, cy: number, r: number, n: number, rot = 0): Poly {
  return Array.from({ length: n }, (_, i) => {
    const a = rot + (i / n) * TAU
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)] as Pt
  })
}

const rect = (x0: number, y0: number, x1: number, y1: number): Poly => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
]

function area(p: Poly): number {
  let a = 0
  for (let i = 0; i < p.length; i++) {
    const [x0, y0] = p[i]
    const [x1, y1] = p[(i + 1) % p.length]
    a += x0 * y1 - x1 * y0
  }
  return a / 2
}

const ccw = (p: Poly) => (area(p) < 0 ? [...p].reverse() : p)
const cw = (p: Poly) => (area(p) > 0 ? [...p].reverse() : p)

function gear(): Poly[] {
  const teeth = 8
  const outer: Poly = []
  for (let i = 0; i < teeth * 4; i++) {
    const a = (i / (teeth * 4)) * TAU
    const r = i % 4 < 2 ? 0.5 : 0.38
    outer.push([0.5 + r * Math.cos(a + TAU / (teeth * 8)), 0.5 + r * Math.sin(a + TAU / (teeth * 8))])
  }
  return [ccw(outer), circle(0.5, 0.5, 0.15, 24, true)]
}

function screw(): Poly[] {
  // Side view: a round head on a threaded shank, point down.
  const pts: Poly = [
    [0.18, 1],
    [0.82, 1],
    [0.82, 0.86],
    [0.62, 0.8],
  ]
  let y = 0.8
  const pitch = 0.1
  while (y - pitch > 0.22) {
    pts.push([0.62, y - pitch / 2], [0.66, y - pitch / 2 - 0.02], [0.62, y - pitch])
    y -= pitch
  }
  pts.push([0.5, 0], [0.38, y])
  for (let yy = y; yy < 0.8 - 1e-6; yy += pitch) pts.push([0.38, yy + pitch / 2], [0.34, yy + pitch / 2 + 0.02], [0.38, yy + pitch])
  pts.push([0.18, 0.86])
  return [ccw(pts)]
}

const BUILTIN: Record<string, { label: string; polys: () => Poly[] }> = {
  nut: { label: 'Nut', polys: () => [ccw(ngon(0.5, 0.5, 0.5, 6, Math.PI / 6)), circle(0.5, 0.5, 0.22, 32, true)] },
  washer: { label: 'Washer', polys: () => [ccw(circle(0.5, 0.5, 0.5, 40)), circle(0.5, 0.5, 0.2, 32, true)] },
  screw: { label: 'Screw', polys: screw },
  bolt: {
    label: 'Bolt',
    polys: () => [ccw([[0.12, 1], [0.88, 1], [0.88, 0.76], [0.62, 0.76], [0.62, 0], [0.38, 0], [0.38, 0.76], [0.12, 0.76]])],
  },
  gear: { label: 'Gear', polys: gear },
  battery: {
    label: 'Battery',
    polys: () => [ccw(rect(0.22, 0, 0.78, 0.88)), cw(rect(0.3, 0.08, 0.7, 0.8)), ccw(rect(0.38, 0.88, 0.62, 1)), ccw(rect(0.44, 0.52, 0.56, 0.72)), ccw(rect(0.4, 0.56, 0.6, 0.68))],
  },
  bolt_lightning: {
    label: 'Electronics',
    polys: () => [ccw([[0.58, 1], [0.2, 0.42], [0.46, 0.42], [0.36, 0], [0.8, 0.6], [0.54, 0.6], [0.66, 1]])],
  },
  magnet: {
    label: 'Magnet',
    polys: () => {
      const pts: Poly = [[0.08, 1], [0.34, 1], [0.34, 0.5]]
      for (let i = 0; i <= 16; i++) {
        const a = Math.PI + (i / 16) * Math.PI
        pts.push([0.5 + 0.16 * Math.cos(a), 0.5 + 0.16 * Math.sin(a)])
      }
      pts.push([0.66, 1], [0.92, 1], [0.92, 0.5])
      for (let i = 0; i <= 16; i++) {
        const a = -(i / 16) * Math.PI
        pts.push([0.5 + 0.42 * Math.cos(a), 0.5 + 0.42 * Math.sin(a)])
      }
      return [ccw(pts)]
    },
  },
  star: {
    label: 'Star',
    polys: () => [ccw(Array.from({ length: 10 }, (_, i) => {
      const a = Math.PI / 2 + (i / 10) * TAU
      const r = i % 2 ? 0.2 : 0.5
      return [0.5 + r * Math.cos(a), 0.52 + r * Math.sin(a)] as Pt
    }))],
  },
  circle: { label: 'Dot', polys: () => [ccw(circle(0.5, 0.5, 0.5, 40))] },
}

export const BUILTIN_ICONS = Object.entries(BUILTIN).map(([id, v]) => ({ id, label: v.label }))

export function builtinIcon(id: string): LabelIcon | null {
  const b = BUILTIN[id]
  return b ? { name: b.label, polys: fit(b.polys()) } : null
}

/** Scale outlines to fit the unit square, centred, keeping the aspect ratio; round the numbers. */
export function fit(polys: Poly[]): Poly[] {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const p of polys)
    for (const [x, y] of p) {
      x0 = Math.min(x0, x)
      y0 = Math.min(y0, y)
      x1 = Math.max(x1, x)
      y1 = Math.max(y1, y)
    }
  const s = 1 / Math.max(x1 - x0, y1 - y0, 1e-9)
  const ox = (1 - (x1 - x0) * s) / 2
  const oy = (1 - (y1 - y0) * s) / 2
  const r = (v: number) => Math.round(v * 1e4) / 1e4
  return polys.map((p) => p.map(([x, y]) => [r(ox + (x - x0) * s), r(oy + (y - y0) * s)] as Pt))
}

const MAX_POINTS = 3000

/** Outlines of the filled shapes in an SVG file (strokes are ignored). Runs in the page. */
export async function svgIcon(file: File): Promise<LabelIcon> {
  const { SVGLoader } = await import('three/examples/jsm/loaders/SVGLoader.js')
  const { ShapeUtils } = await import('three')
  const data = new SVGLoader().parse(await file.text())
  const polys: Poly[] = []
  let detail = 12
  for (let attempt = 0; attempt < 4; attempt++) {
    polys.length = 0
    for (const path of data.paths) {
      const fill = (path.userData?.style as { fill?: string } | undefined)?.fill
      if (fill === 'none' || fill === 'transparent') continue
      for (const shape of SVGLoader.createShapes(path)) {
        const { shape: outer, holes } = shape.extractPoints(detail)
        // SVG's y points down: flip it, which also flips each outline's winding.
        const flip = (pts: { x: number; y: number }[]): Poly => pts.map((v) => [v.x, -v.y] as Pt)
        if (outer.length >= 3) polys.push(ShapeUtils.isClockWise(outer) ? flip(outer) : flip(outer).reverse())
        for (const h of holes) if (h.length >= 3) polys.push(ShapeUtils.isClockWise(h) ? flip(h).reverse() : flip(h))
      }
    }
    if (polys.reduce((n, p) => n + p.length, 0) <= MAX_POINTS) break
    detail = Math.max(2, Math.floor(detail / 2))
  }
  if (!polys.length) throw new Error('That SVG has no filled shapes to use.')
  if (polys.reduce((n, p) => n + p.length, 0) > MAX_POINTS * 2) throw new Error('That SVG is too detailed for a label. Try a simpler icon.')
  return { name: file.name.replace(/\.svg$/i, '').slice(0, 40) || 'Icon', polys: fit(polys) }
}

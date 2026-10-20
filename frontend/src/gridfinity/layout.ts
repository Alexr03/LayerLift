// Drawer arithmetic: how many cells fit, where the spare room goes, how the baseplate is split
// into pieces that fit the printer, and whether the bins fit on the grid.
import { BIN_CLEARANCE, DEFAULT_GRID, type GridSpec, LIP_HEIGHT, PITCH } from './spec'
import type { BinDesign, Drawer, PlacedBin, Scene } from './types'

export interface Grid {
  pitch: number // mm per cell
  nx: number
  ny: number
  padLeft: number
  padRight: number
  padFront: number
  padBack: number
  width: number // baseplate outside, mm
  depth: number
}

function splitSpare(spare: number, align: Drawer['alignX']): [number, number] {
  if (align === 'start') return [0, spare]
  if (align === 'end') return [spare, 0]
  return [spare / 2, spare / 2]
}

/** The grid that fits in a drawer, with the leftover filled by a solid margin. */
export function drawerGrid(d: Drawer): Grid {
  const P = d.pitch || PITCH
  if (d.sizeMode === 'cells') {
    // A baseplate of exactly so many cells, no margin.
    const nx = Math.max(1, Math.round(d.cellsX))
    const ny = Math.max(1, Math.round(d.cellsY))
    return { pitch: P, nx, ny, padLeft: 0, padRight: 0, padFront: 0, padBack: 0, width: nx * P, depth: ny * P }
  }
  const w = Math.max(P, d.width - d.clearance)
  const dp = Math.max(P, d.depth - d.clearance)
  const nx = Math.max(1, Math.floor(w / P + 1e-6))
  const ny = Math.max(1, Math.floor(dp / P + 1e-6))
  const [padLeft, padRight] = splitSpare(Math.max(0, w - nx * P), d.alignX)
  const [padFront, padBack] = splitSpare(Math.max(0, dp - ny * P), d.alignY)
  return { pitch: P, nx, ny, padLeft, padRight, padFront, padBack, width: nx * P + padLeft + padRight, depth: ny * P + padFront + padBack }
}

/** The grid a drawer's bins are built for. */
export const gridSpec = (d: Drawer): GridSpec => ({ pitch: d.pitch || DEFAULT_GRID.pitch, unit: d.unit || DEFAULT_GRID.unit })

/** One printable piece of the baseplate: a block of cells plus any margin on the drawer's edges. */
export interface Piece {
  pitch: number // mm per cell
  joins: { left: boolean; right: boolean; front: boolean; back: boolean } // sides that meet another piece
  index: number
  col: number // piece column and row, for naming
  row: number
  cx: number // first cell column
  cy: number
  nx: number // cells
  ny: number
  padLeft: number
  padRight: number
  padFront: number
  padBack: number
  x: number // position of the piece's front-left corner on the whole baseplate, mm
  y: number
  width: number
  depth: number
}

interface Span {
  start: number
  count: number
  padA: number
  padB: number
}

/**
 * Split n cells (with margins padA before and padB after) into as few spans as fit on the bed,
 * as even as possible. Returns null if even a single cell plus its margin doesn't fit.
 */
export function splitAxis(n: number, padA: number, padB: number, bed: number, pitch = PITCH): Span[] | null {
  const margin = 0.5 // don't fill the bed to the edge
  for (let k = 1; k <= n; k++) {
    const base = Math.floor(n / k)
    const extra = n % k
    // Any larger spans go as near the middle as they can, away from the margins.
    const counts = Array.from({ length: k }, (_, i) => base + (i >= Math.floor((k - extra) / 2) && i < Math.floor((k - extra) / 2) + extra ? 1 : 0))
    let start = 0
    const spans: Span[] = counts.map((count, i) => {
      const s = { start, count, padA: i === 0 ? padA : 0, padB: i === k - 1 ? padB : 0 }
      start += count
      return s
    })
    if (spans.every((s) => s.count * pitch + s.padA + s.padB <= bed - margin)) return spans
  }
  return null
}

export function platePieces(d: Drawer, g: Grid = drawerGrid(d)): Piece[] | null {
  // Try both bed orientations and keep whichever needs fewer pieces. Unsplit, it's one piece.
  const attempt = (bx: number, by: number) => {
    if (!d.split) return { xs: [{ start: 0, count: g.nx, padA: g.padLeft, padB: g.padRight }], ys: [{ start: 0, count: g.ny, padA: g.padFront, padB: g.padBack }] }
    const xs = splitAxis(g.nx, g.padLeft, g.padRight, bx, g.pitch)
    const ys = splitAxis(g.ny, g.padFront, g.padBack, by, g.pitch)
    return xs && ys ? { xs, ys } : null
  }
  const a = attempt(d.bedX, d.bedY)
  const b = d.bedX !== d.bedY ? attempt(d.bedY, d.bedX) : null
  const best = a && b ? (b.xs.length * b.ys.length < a.xs.length * a.ys.length ? b : a) : (a ?? b)
  if (!best) return null
  const pieces: Piece[] = []
  best.ys.forEach((sy, row) =>
    best.xs.forEach((sx, col) => {
      const x = sx.start === 0 ? 0 : g.padLeft + sx.start * g.pitch
      const y = sy.start === 0 ? 0 : g.padFront + sy.start * g.pitch
      pieces.push({
        pitch: g.pitch,
        joins: { left: col > 0, right: col < best.xs.length - 1, front: row > 0, back: row < best.ys.length - 1 },
        index: pieces.length,
        col,
        row,
        cx: sx.start,
        cy: sy.start,
        nx: sx.count,
        ny: sy.count,
        padLeft: sx.padA,
        padRight: sx.padB,
        padFront: sy.padA,
        padBack: sy.padB,
        x,
        y,
        width: sx.count * g.pitch + sx.padA + sx.padB,
        depth: sy.count * g.pitch + sy.padA + sy.padB,
      })
    }),
  )
  return pieces
}

/** Height of a bin to the top of its lip (or wall), mm. */
export const binHeight = (b: BinDesign, g: GridSpec = DEFAULT_GRID) => b.h * g.unit + (b.lip ? LIP_HEIGHT : 0)
export const binFootprint = (b: BinDesign, g: GridSpec = DEFAULT_GRID): [number, number] => [b.w * g.pitch - BIN_CLEARANCE, b.d * g.pitch - BIN_CLEARANCE]

const overlaps = (a: PlacedBin, b: PlacedBin) =>
  a.x < b.x + b.design.w && b.x < a.x + a.design.w && a.y < b.y + b.design.d && b.y < a.y + a.design.d

export interface BinIssue {
  id: string
  message: string
}

export function binIssues(p: Scene, g: Grid = drawerGrid(p.drawer)): BinIssue[] {
  const out: BinIssue[] = []
  const floor = plateFloor(p.drawer.plate) // bins stand on the plate's floor
  p.bins.forEach((b, i) => {
    if (b.x + b.design.w > g.nx || b.y + b.design.d > g.ny) out.push({ id: b.id, message: 'Runs off the grid.' })
    const other = p.bins.slice(0, i).find((o) => overlaps(o, b))
    if (other) out.push({ id: b.id, message: 'Overlaps another bin.' })
    const [fx, fy] = binFootprint(b.design, gridSpec(p.drawer))
    const fits = (fx <= p.drawer.bedX && fy <= p.drawer.bedY) || (fx <= p.drawer.bedY && fy <= p.drawer.bedX)
    if (!fits) out.push({ id: b.id, message: 'Larger than the printer bed.' })
    if (p.drawer.height > 0 && binHeight(b.design, gridSpec(p.drawer)) + floor > p.drawer.height)
      out.push({ id: b.id, message: 'Taller than the drawer.' })
  })
  return out
}

/** Floor under the receptacles of a baseplate, mm. */
export function plateFloor(style: Drawer['plate']): number {
  return style === 'thin' ? 0 : style === 'solid' ? 1.2 : 3.0
}

/** The first free spot for a bin of w × d cells, scanning rows from the front. */
export function freeSpot(p: Scene, w: number, d: number, g: Grid = drawerGrid(p.drawer)): { x: number; y: number } | null {
  for (let y = 0; y + d <= g.ny; y++)
    for (let x = 0; x + w <= g.nx; x++) {
      const probe = { id: '', x, y, design: { w, d } as BinDesign }
      if (!p.bins.some((b) => overlaps(b, probe))) return { x, y }
    }
  return null
}

/** Cells covered by no bin. */
export function freeCells(p: Scene, g: Grid = drawerGrid(p.drawer)): number {
  let used = 0
  for (const b of p.bins) {
    const x1 = Math.min(g.nx, b.x + b.design.w)
    const y1 = Math.min(g.ny, b.y + b.design.d)
    used += Math.max(0, x1 - b.x) * Math.max(0, y1 - b.y)
  }
  return Math.max(0, g.nx * g.ny - used)
}

/** The most whole cells that fit a bed (with the half-millimetre margin the splitter keeps). */
export const cellsForBed = (bed: number, pitch = PITCH) => Math.max(1, Math.floor((bed - 0.5) / pitch))

/** Where clip holes go on a piece, in piece coordinates: the middle of each cell's edge along every
 * seam with another piece, and along the outer sides picked in `connectorEdges`. `acrossX` is
 * true when the clip runs across x (left and right sides). */
export function clipSpots(p: Piece, d: Drawer): { x: number; y: number; acrossX: boolean }[] {
  if (d.connectors === 'none') return []
  const e = d.connectorEdges
  const out: { x: number; y: number; acrossX: boolean }[] = []
  // An outer edge only takes clips where the cells reach it (no margin in the way).
  const side = (joined: boolean, picked: boolean, pad: number) => joined || (picked && pad < 1e-6)
  for (let j = 0; j < p.ny; j++) {
    const y = p.padFront + (j + 0.5) * p.pitch
    if (side(p.joins.left, e.left, p.padLeft)) out.push({ x: 0, y, acrossX: true })
    if (side(p.joins.right, e.right, p.padRight)) out.push({ x: p.width, y, acrossX: true })
  }
  for (let i = 0; i < p.nx; i++) {
    const x = p.padLeft + (i + 0.5) * p.pitch
    if (side(p.joins.front, e.front, p.padFront)) out.push({ x, y: 0, acrossX: false })
    if (side(p.joins.back, e.back, p.padBack)) out.push({ x, y: p.depth, acrossX: false })
  }
  return out
}

/** Clips to print for a whole baseplate: one per seam spot, plus one per outer-edge spot. */
export function clipCount(d: Drawer, pieces: Piece[]): number {
  if (d.connectors === 'none') return 0
  let n = 0
  for (const p of pieces)
    for (const s of clipSpots(p, d)) {
      // A seam is shared by two pieces: count it from the piece on its right or behind it.
      const seam = s.acrossX ? (s.x === 0 ? p.joins.left : p.joins.right) : s.y === 0 ? p.joins.front : p.joins.back
      if (!seam || (s.acrossX ? s.x === 0 : s.y === 0)) n++
    }
  return n
}

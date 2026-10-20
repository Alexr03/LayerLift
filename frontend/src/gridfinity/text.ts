// Label text as polygons: glyph outlines from a font (opentype.js), with curves flattened.
import { type Font, parse } from 'opentype.js'

export type Poly = [number, number][]

export interface Shaped {
  polys: Poly[] // y up, baseline at y = 0, starting at x = 0
  minX: number
  maxX: number
  minY: number
  maxY: number
}

export function loadFont(buffer: ArrayBuffer): Font {
  return parse(buffer)
}

const STEPS = 6 // segments per curve: plenty at label sizes

/** Outlines of a line of text, `size` mm from baseline to cap height (roughly). */
export function shapeText(font: Font, text: string, size: number): Shaped | null {
  // opentype sizes by the em square; scale so capitals are `size` tall.
  const capHeight = (font.tables.os2?.sCapHeight || font.unitsPerEm * 0.7) / font.unitsPerEm
  const path = font.getPath(text, 0, 0, size / capHeight)
  const polys: Poly[] = []
  let cur: Poly = []
  let x = 0
  let y = 0
  const close = () => {
    if (cur.length >= 3) polys.push(cur)
    cur = []
  }
  for (const c of path.commands) {
    if (c.type === 'M') {
      close()
      x = c.x
      y = c.y
      cur.push([x, -y])
    } else if (c.type === 'L') {
      x = c.x
      y = c.y
      cur.push([x, -y])
    } else if (c.type === 'Q') {
      for (let i = 1; i <= STEPS; i++) {
        const t = i / STEPS
        const a = (1 - t) * (1 - t)
        const b = 2 * (1 - t) * t
        const d = t * t
        cur.push([a * x + b * c.x1 + d * c.x, -(a * y + b * c.y1 + d * c.y)])
      }
      x = c.x
      y = c.y
    } else if (c.type === 'C') {
      for (let i = 1; i <= STEPS; i++) {
        const t = i / STEPS
        const a = (1 - t) ** 3
        const b = 3 * (1 - t) ** 2 * t
        const d = 3 * (1 - t) * t * t
        const e = t ** 3
        cur.push([a * x + b * c.x1 + d * c.x2 + e * c.x, -(a * y + b * c.y1 + d * c.y2 + e * c.y)])
      }
      x = c.x
      y = c.y
    } else if (c.type === 'Z') {
      close()
    }
  }
  close()
  if (!polys.length) return null
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  for (const p of polys)
    for (const [px, py] of p) {
      minX = Math.min(minX, px)
      maxX = Math.max(maxX, px)
      minY = Math.min(minY, py)
      maxY = Math.max(maxY, py)
    }
  return { polys, minX, maxX, minY, maxY }
}

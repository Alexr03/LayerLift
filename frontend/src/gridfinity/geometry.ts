// Bin and baseplate solids, built with manifold-3d. Millimetres, Z up. A bin is centred on the
// origin in XY with its feet on z = 0; a baseplate piece has its front-left corner at the origin.
//
// Profiles (the chamfered feet, receptacles and lip) are built from frustums: the convex hull of
// two rounded rectangles at different heights. Each profile segment is convex on its own, so the
// solids are unions of hulls, which manifold computes exactly and fast.
import type { Font } from 'opentype.js'
import { type CrossSection, type Manifold, type ManifoldToplevel, crossSection } from './mf'
import {
  BASE_HEIGHT,
  BIN_CLEARANCE,
  BIN_RADIUS,
  DIVIDER,
  FOOT_HEIGHT,
  BRIDGE_Z,
  FOOT_PROFILE,
  LIP_HEIGHT,
  LIP_PROFILE,
  LIP_SUPPORT,
  MAGNET_DEPTH,
  MAGNET_DIAMETER,
  DEFAULT_GRID,
  type GridSpec,
  holeOffset,
  CLIP,
  CLIP_CUT,
  CLIP_LENGTH,
  RAIL,
  PLATE_PROFILE,
  PLATE_RADIUS,
  SCREW_DEPTH,
  SCREW_DIAMETER,
} from './spec'
import { type Poly, shapeText } from './text'
import type { BinDesign, Drawer, PlateStyle } from './types'
import type { Piece } from './layout'
import { clipSpots, plateFloor } from './layout'

type Vec2 = [number, number]
type Vec3 = [number, number, number]

/** Label inlay depth / raised label height, mm (three and two 0.2 mm layers). */
export const INLAY_DEPTH = 0.6
export const RAISED_HEIGHT = 0.4

/** Points of a w × d rectangle centred on (cx, cy) with corner radius r. */
export function roundedRect(w: number, d: number, r: number, cx = 0, cy = 0): Vec2[] {
  r = Math.min(r, w / 2, d / 2)
  const hw = w / 2
  const hd = d / 2
  if (r < 0.05)
    return [
      [cx - hw, cy - hd],
      [cx + hw, cy - hd],
      [cx + hw, cy + hd],
      [cx - hw, cy + hd],
    ]
  const seg = Math.max(2, Math.min(10, Math.ceil(r * 2.5)))
  const pts: Vec2[] = []
  const corners: [number, number, number][] = [
    [cx + hw - r, cy - hd + r, -90],
    [cx + hw - r, cy + hd - r, 0],
    [cx - hw + r, cy + hd - r, 90],
    [cx - hw + r, cy - hd + r, 180],
  ]
  for (const [ox, oy, start] of corners)
    for (let i = 0; i <= seg; i++) {
      const a = ((start + (90 * i) / seg) * Math.PI) / 180
      pts.push([ox + r * Math.cos(a), oy + r * Math.sin(a)])
    }
  return pts
}

/** A rounded-rectangle outline that can be inset: size w × d at inset 0, corner radius r - inset. */
interface Outline {
  w: number
  d: number
  r: number
  cx: number
  cy: number
}

const inset = (o: Outline, i: number): Vec2[] => roundedRect(o.w - 2 * i, o.d - 2 * i, Math.max(0, o.r - i), o.cx, o.cy)

export class Builder {
  readonly M: ManifoldToplevel
  readonly font: Font | null

  constructor(M: ManifoldToplevel, font: Font | null = null) {
    this.M = M
    this.font = font
  }

  /** Convex solid between an outline inset i0 at z0 and inset i1 at z1. */
  frustum(o: Outline, z0: number, i0: number, z1: number, i1: number): Manifold {
    if (Math.abs(i0 - i1) < 1e-9) return this.prism(inset(o, i0), z0, z1)
    const pts: Vec3[] = []
    for (const [x, y] of inset(o, i0)) pts.push([x, y, z0])
    for (const [x, y] of inset(o, i1)) pts.push([x, y, z1])
    return this.M.Manifold.hull(pts)
  }

  /** Solid following a profile of [inset, z] points, bottom up. */
  profile(o: Outline, profile: [number, number][], dz = 0): Manifold {
    const parts: Manifold[] = []
    for (let k = 0; k + 1 < profile.length; k++) {
      const [i0, z0] = profile[k]
      const [i1, z1] = profile[k + 1]
      if (z1 - z0 > 1e-9) parts.push(this.frustum(o, z0 + dz, i0, z1 + dz, i1))
    }
    return this.M.Manifold.union(parts)
  }

  prism(poly: Vec2[] | Vec2[][], z0: number, z1: number): Manifold {
    const polys = (Array.isArray(poly[0][0]) ? poly : [poly]) as Vec2[][]
    return crossSection(this.M, polys).extrude(z1 - z0).translate([0, 0, z0])
  }

  box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): Manifold {
    return this.M.Manifold.cube([x1 - x0, y1 - y0, z1 - z0]).translate([x0, y0, z0])
  }

  cylinder(x: number, y: number, z0: number, z1: number, d: number): Manifold {
    return this.M.Manifold.cylinder(z1 - z0, d / 2, d / 2, Math.max(16, Math.round(d * 5))).translate([x, y, z0])
  }

  // ------------------------------------------------------------------ bins

  bin(b: BinDesign, grid: GridSpec = DEFAULT_GRID): { body: Manifold; label: Manifold | null; info: BinInfo } {
    const PITCH = grid.pitch
    const HOLE_OFFSET = holeOffset(grid.pitch)
    const M = this.M.Manifold
    const W = b.w * PITCH - BIN_CLEARANCE
    const D = b.d * PITCH - BIN_CLEARANCE
    const H = b.h * grid.unit
    const outer: Outline = { w: W, d: D, r: BIN_RADIUS, cx: 0, cy: 0 }
    const cells: Outline[] = []
    for (let i = 0; i < b.w; i++)
      for (let j = 0; j < b.d; j++)
        cells.push({ w: PITCH - BIN_CLEARANCE, d: PITCH - BIN_CLEARANCE, r: BIN_RADIUS, cx: (i + 0.5) * PITCH - (b.w * PITCH) / 2, cy: (j + 0.5) * PITCH - (b.d * PITCH) / 2 })

    // Outside: a foot under every cell, the body, and the lip.
    // Each foot runs straight up to the top of a baseplate's ridges before the solid bridge starts,
    // so on a baseplate the ridge between two cells fits in the gap between two feet.
    const footUp: [number, number][] = [...FOOT_PROFILE, [0, BRIDGE_Z]]
    const solids: Manifold[] = cells.map((c) => this.profile(c, footUp))
    solids.push(this.prism(inset(outer, 0), BRIDGE_Z, H + (b.lip ? LIP_HEIGHT : 0)))
    let body = M.union(solids)

    // Inside.
    const wall = b.wall
    const lite = b.base === 'lite'
    const floorZ = FOOT_HEIGHT + b.floor // lite: the web between the feet is b.floor thick too
    const lipIn = LIP_PROFILE[0][0] // the lip's inner tip, as an inset from the outside
    const supportTop = H - LIP_SUPPORT
    const supportBottom = supportTop - Math.max(0, lipIn - wall)
    const cavity: Manifold[] = []
    if (b.lip) {
      cavity.push(this.prism(inset(outer, wall), floorZ, supportBottom))
      cavity.push(this.frustum(outer, supportBottom, wall, supportTop, Math.max(wall, lipIn)))
      cavity.push(this.prism(inset(outer, Math.max(wall, lipIn)), supportTop, H))
      cavity.push(this.profile(outer, LIP_PROFILE, H))
      const topInset = LIP_PROFILE[LIP_PROFILE.length - 1][0]
      cavity.push(this.prism(inset(outer, topInset), H + LIP_HEIGHT - 1e-3, H + LIP_HEIGHT + 1))
    } else {
      cavity.push(this.prism(inset(outer, wall), floorZ, H + 1))
    }
    if (lite) {
      // Hollow feet: each foot is a shell `wall` thick with a floor of b.floor at the bottom; a thin
      // web between the feet carries the main floor.
      for (const c of cells) {
        cavity.push(this.profile(c, clipProfile(FOOT_PROFILE.map(([i, z]) => [i + wall, z]), b.floor)))
        cavity.push(this.prism(inset(c, wall), FOOT_HEIGHT - 1e-3, floorZ + 1e-3))
      }
    }
    body = body.subtract(M.union(cavity))

    // Magnet and screw holes (standard base only).
    if (!lite && b.holes !== 'none') {
      const holes: Manifold[] = []
      const corner = (x: number, y: number) => Math.abs(Math.abs(x) - (W / 2 - (PITCH / 2 - BIN_CLEARANCE / 2) + HOLE_OFFSET)) < 1e-6 && Math.abs(Math.abs(y) - (D / 2 - (PITCH / 2 - BIN_CLEARANCE / 2) + HOLE_OFFSET)) < 1e-6
      for (const c of cells)
        for (const [sx, sy] of [
          [-1, -1],
          [1, -1],
          [1, 1],
          [-1, 1],
        ]) {
          const x = c.cx + sx * HOLE_OFFSET
          const y = c.cy + sy * HOLE_OFFSET
          if (b.holesCorners && !corner(x, y)) continue
          if (b.holes === 'magnets' || b.holes === 'both') holes.push(this.cylinder(x, y, -1, MAGNET_DEPTH, MAGNET_DIAMETER))
          if (b.holes === 'screws' || b.holes === 'both') holes.push(this.cylinder(x, y, -1, SCREW_DEPTH, SCREW_DIAMETER))
        }
      if (holes.length) body = body.subtract(M.union(holes))
    }

    // Compartments.
    const xi0 = -W / 2 + wall
    const xi1 = W / 2 - wall
    const yi0 = -D / 2 + wall
    const yi1 = D / 2 - wall
    const top = b.lip ? supportTop : H // dividers and tabs stay clear of a stacked bin's foot
    const colEdges = edges(xi0, xi1, b.divX)
    const rowEdges = edges(yi0, yi1, b.divY)
    const add: Manifold[] = []
    for (let k = 1; k <= b.divX; k++) {
      const x = (colEdges[k - 1][1] + colEdges[k][0]) / 2
      add.push(this.box(x - DIVIDER / 2, yi0 - wall / 2, floorZ - 0.01, x + DIVIDER / 2, yi1 + wall / 2, top))
    }
    for (let k = 1; k <= b.divY; k++) {
      const y = (rowEdges[k - 1][1] + rowEdges[k][0]) / 2
      add.push(this.box(xi0 - wall / 2, y - DIVIDER / 2, floorZ - 0.01, xi1 + wall / 2, y + DIVIDER / 2, top))
    }

    // Finger scoops along the front of each row.
    const room = top - floorZ
    let scoop = 0
    if (b.scoop > 0) {
      const rowDepth = Math.min(...rowEdges.map(([a, c]) => c - a))
      scoop = Math.max(0, Math.min(b.scoop, rowDepth / 2, room - 2))
      if (scoop >= 1)
        for (const [y0] of rowEdges) {
          const block = this.box(xi0 - 0.01, y0 - 0.01, floorZ - 0.01, xi1 + 0.01, y0 + scoop, floorZ + scoop)
          const round = M.cylinder(xi1 - xi0 + 1, scoop, scoop, Math.max(24, Math.round(scoop * 6)))
            .rotate([0, 90, 0])
            .translate([xi0 - 0.5, y0 + scoop, floorZ + scoop])
          add.push(block.subtract(round))
        }
      else scoop = 0
    }

    // Label tabs along the back of each compartment.
    const labelAreas: LabelArea[] = []
    let tabBottom = top
    let tabDepth = 0
    if (b.tab !== 'none') {
      const minRow = Math.min(...rowEdges.map(([a, c]) => c - a))
      const depth = Math.min(b.tabDepth, minRow - 4, room - LIP_SUPPORT - 3)
      if (depth >= 4) {
        tabBottom = top - LIP_SUPPORT - depth
        tabDepth = depth
        rowEdges.forEach(([, yB], row) => {
          colEdges.forEach(([c0, c1], col) => {
            const width = c1 - c0
            const tw = b.tab === 'full' ? width : Math.min(b.tabWidth, width)
            const x0 = b.tab === 'left' || b.tab === 'full' ? c0 : b.tab === 'right' ? c1 - tw : (c0 + c1) / 2 - tw / 2
            // Cross-section in (y, z), extruded along x.
            const section: Vec2[] = [
              [yB + 0.01, top],
              [yB - depth, top],
              [yB - depth, top - LIP_SUPPORT],
              [yB + 0.01, top - LIP_SUPPORT - depth - 0.01],
            ]
            const leftEnd = x0 <= c0 + 1e-6 ? wall / 2 : 0
            const rightEnd = x0 + tw >= c1 - 1e-6 ? wall / 2 : 0
            const tab = crossSection(this.M, [section.map(([y, z]) => [y, z] as Vec2)])
              .extrude(tw + leftEnd + rightEnd)
              .transform([0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, x0 - leftEnd, 0, 0, 1])
            add.push(tab)
            // The back row's tab sits under the lip's overhang: keep the label out from under it.
            const shadow = row === rowEdges.length - 1 && b.lip ? Math.max(0, lipIn - wall) + 0.4 : 0.4
            labelAreas.push({ index: row * colEdges.length + col, x0: x0 + 0.8, x1: x0 + tw - 0.8, y0: yB - depth + 0.8, y1: yB - shadow, z: top })
          })
        })
      }
    }
    if (add.length) body = M.union([body, ...add])

    // Hexagon cut-outs in the outer walls, kept clear of where dividers, tabs and scoops join them.
    if (b.pattern === 'hex') {
      const vMin = floorZ + 1.5
      const vMax = b.lip ? supportBottom - 1 : H - 2
      const rib = b.hexRib
      const all = [-Infinity, Infinity] as const
      const xDiv = colEdges.slice(1).map(([a], k) => (colEdges[k][1] + a) / 2)
      const yDiv = rowEdges.slice(1).map(([a], k) => (rowEdges[k][1] + a) / 2)
      const band = (c: number): KeepOut => [c - DIVIDER / 2 - rib, c + DIVIDER / 2 + rib, -Infinity, Infinity]
      const tabZone = tabDepth > 0 ? tabBottom - rib : Infinity
      const scoopZone = scoop > 0 ? floorZ + scoop + rib : -Infinity
      // Along the front and back walls (x), and along the sides (y).
      const front: KeepOut[] = [...xDiv.map(band), [...all, -Infinity, scoopZone]]
      const back: KeepOut[] = [...xDiv.map(band), [...all, tabZone, Infinity]]
      const side: KeepOut[] = [...yDiv.map(band)]
      for (const [yF, yB] of rowEdges) {
        side.push([yB - tabDepth - rib, yB + rib, tabZone, Infinity])
        side.push([yF - rib, yF + scoop + rib, -Infinity, scoopZone])
      }
      const mirror = (k: KeepOut[]): KeepOut[] => k.map(([u0, u1, v0, v1]) => [-u1, -u0, v0, v1])
      const margin = BIN_RADIUS + 1
      const cut: Manifold[] = []
      const place = (c: Manifold | null, f: (m: Manifold) => Manifold) => c && cut.push(f(c))
      place(this.hexWall(W, wall, vMin, vMax, margin, front, b), (m) => m.translate([0, -D / 2, 0]))
      // Rotating 180° maps u to -x, so the back wall's keep-outs are mirrored first; likewise the left.
      place(this.hexWall(W, wall, vMin, vMax, margin, mirror(back), b), (m) => m.rotate([0, 0, 180]).translate([0, D / 2, 0]))
      place(this.hexWall(D, wall, vMin, vMax, margin, side, b), (m) => m.rotate([0, 0, 90]).translate([W / 2, 0, 0]))
      place(this.hexWall(D, wall, vMin, vMax, margin, mirror(side), b), (m) => m.rotate([0, 0, -90]).translate([-W / 2, 0, 0]))
      if (cut.length) body = body.subtract(M.union(cut))
    }

    // Labels.
    let label: Manifold | null = null
    const shapes = labelAreas.map((a) => this.labelShape(b, a)).filter((s): s is CrossSection => s != null)
    if (shapes.length) {
      const all = this.M.CrossSection.union(shapes)
      if (b.labelStyle === 'inlay') {
        const z = labelAreas[0].z
        label = all.extrude(INLAY_DEPTH).translate([0, 0, z - INLAY_DEPTH])
        body = body.subtract(label)
      } else {
        label = all.extrude(RAISED_HEIGHT).translate([0, 0, labelAreas[0].z])
      }
    }

    return {
      body,
      label,
      info: { width: W, depth: D, height: H + (b.lip ? LIP_HEIGHT : 0), floorZ, labelAreas: labelAreas.length, top },
    }
  }

  /**
   * The cutter for one wall's hexagon holes, for the wall at y = 0 of a bin extending to +y (the
   * front wall of a bin centred on the origin, before it is moved to y = -D/2). Only whole holes
   * are cut, clear of the corners and of the keep-out rectangles [u0, u1, v0, v1].
   */
  hexWall(length: number, wall: number, vMin: number, vMax: number, margin: number, keepOut: KeepOut[], b: BinDesign): Manifold | null {
    const s = b.hexSize
    const R = s / Math.sqrt(3) // circumradius; points up and down, so the tops print without support
    const pitchU = s + b.hexRib
    const pitchV = (pitchU * Math.sqrt(3)) / 2
    const u0 = -length / 2 + margin
    const u1 = length / 2 - margin
    if (u1 - u0 < s || vMax - vMin < 2 * R) return null
    const rows = Math.floor((vMax - vMin - 2 * R) / pitchV) + 1
    const vStart = (vMin + vMax) / 2 - ((rows - 1) * pitchV) / 2
    const holes: Vec2[][] = []
    for (let r = 0; r < rows; r++) {
      const v = vStart + r * pitchV
      const shift = r % 2 ? pitchU / 2 : 0
      const n = Math.floor((u1 - u0 - s) / pitchU) + 2
      for (let k = -n; k <= n; k++) {
        const u = k * pitchU + shift
        if (u - s / 2 < u0 || u + s / 2 > u1) continue
        if (keepOut.some(([a, c, lo, hi]) => u + s / 2 > a && u - s / 2 < c && v + R > lo && v - R < hi)) continue
        const hex: Vec2[] = []
        for (let a = 0; a < 6; a++) {
          const t = ((90 + a * 60) * Math.PI) / 180
          hex.push([u + R * Math.cos(t), v + R * Math.sin(t)])
        }
        holes.push(hex)
      }
    }
    if (!holes.length) return null
    // Extrude through the wall (u along x, v up), from just outside to the inner face.
    const depth = wall + 1.01
    return crossSection(this.M, holes)
      .extrude(depth)
      .rotate([90, 0, 0]) // extrusion now runs along -y, v along +z
      .translate([0, wall + 0.01, 0])
  }

  /** Text (and icon) for one label area, as a flat outline at z = 0. */
  labelShape(b: BinDesign, a: LabelArea): CrossSection | null {
    const text = (b.labels[a.index] ?? '').trim()
    const icon = b.icons[a.index] ?? null
    const aw = a.x1 - a.x0
    const ad = a.y1 - a.y0
    if (aw < 3 || ad < 2 || (!text && !icon)) return null
    const size = b.labelSize > 0 ? Math.min(b.labelSize, ad) : Math.min(ad * 0.7, 9)
    const pieces: { polys: Poly[]; w: number; minX: number; minY: number; h: number }[] = []
    if (icon) pieces.push({ polys: icon.polys, w: 1, minX: 0, minY: 0, h: 1 })
    const shaped = text && this.font ? shapeText(this.font, text, size) : null
    if (shaped) pieces.push({ polys: shaped.polys, w: shaped.maxX - shaped.minX, minX: shaped.minX, minY: 0, h: size })
    if (!pieces.length) return null
    // Lay out: icon (square, text height tall) then text, scaled down to fit the area.
    const iconSize = icon ? Math.min(ad * 0.9, size * 1.3) : 0
    const gap = icon && shaped ? size * 0.35 : 0
    const textW = shaped ? shaped.maxX - shaped.minX : 0
    const total = iconSize + gap + textW
    const k = Math.min(1, aw / total)
    const polys: Vec2[][] = []
    let x = a.x0 + (aw - total * k) / 2
    const cy = (a.y0 + a.y1) / 2
    if (icon) {
      const s = iconSize * k
      for (const p of icon.polys) polys.push(p.map(([u, v]) => [x + u * s, cy - s / 2 + v * s] as Vec2))
      x += (iconSize + gap) * k
    }
    if (shaped) {
      // Centre capitals vertically; descenders may dip a little below.
      const base = cy - (size * k) / 2
      for (const p of shaped.polys) polys.push(p.map(([u, v]) => [x + (u - shaped.minX) * k, base + v * k] as Vec2))
    }
    const shape = crossSection(this.M, polys, 'NonZero')
    // Keep everything on the tab.
    const clip = crossSection(this.M, [roundedRect(aw, ad, 0, (a.x0 + a.x1) / 2, (a.y0 + a.y1) / 2)])
    return shape.intersect(clip)
  }

  // ------------------------------------------------------------------ baseplates

  /**
   * A connection clip, as Gridfinity Generator exports it: its end outline in XY, extruded up.
   * `play` (the clip tolerance) opens the channel and shortens the clip; 0 is Generator's own fit.
   */
  clip(play = 0): Manifold {
    const pts: Vec2[] = CLIP.map(([x, d]) => {
      const inner = Math.abs(x) <= 1.45 + 1e-6 && d >= 2.45 - 1e-6 // the channel and its barbs
      return [inner ? x + Math.sign(x) * play : x, inner && Math.abs(d - 2.45) < 1e-6 ? d - play : d] as Vec2
    })
    // Depth below the top becomes height: the clip stands on its end, 3.8 mm deep.
    const outline = pts.map(([x, d]) => [x, -d] as Vec2)
    return this.prism(ccw(outline), 0, CLIP_LENGTH - 2 * play)
  }

  /** What to cut from a piece for one clip, on its left edge (x = 0) centred at y = 0. */
  clipCut(top: number, length: number): Manifold {
    // (distance from the edge, height): everything above the rail, and the undercut below it.
    const rail = RAIL.map(([u, d]) => [u, top - d] as Vec2)
    const wall = 2.15 + 0.01 // the cell's wall face above the first chamfer
    const section: Vec2[] = [[rail[0][0], rail[0][1]], [wall, rail[0][1]], [wall, top + 1], [-1, top + 1], [-1, rail[rail.length - 1][1]], ...rail.slice().reverse().map((p) => [p[0], p[1]] as Vec2)]
    // Extrude along z, then stand the section up: x stays across the edge, extrusion runs along y.
    return crossSection(this.M, [ccw(dedupe(section))]).extrude(length).rotate([90, 0, 0]).translate([0, length / 2, 0])
  }

  plate(p: Piece, style: PlateStyle, drawer: Pick<Drawer, 'connectors' | 'connectorEdges' | 'clipTolerance'> | null = null): Manifold {
    const M = this.M.Manifold
    const floor = plateFloor(style)
    const top = floor + PLATE_PROFILE[PLATE_PROFILE.length - 1][1]
    const solid = this.box(0, 0, 0, p.width, p.depth, top)
    const voids: Manifold[] = []
    const holes: Manifold[] = []
    for (let i = 0; i < p.nx; i++)
      for (let j = 0; j < p.ny; j++) {
        const c: Outline = { w: p.pitch, d: p.pitch, r: PLATE_RADIUS, cx: p.padLeft + (i + 0.5) * p.pitch, cy: p.padFront + (j + 0.5) * p.pitch }
        const prof = PLATE_PROFILE.map(([a, z]) => [a, z] as [number, number])
        if (style === 'thin') prof.unshift([prof[0][0], -1]) // open bottom
        prof.push([0, prof[prof.length - 1][1] + 1]) // clear through the top
        voids.push(this.profile(c, prof, floor))
        if (style === 'magnets')
          for (const [sx, sy] of [
            [-1, -1],
            [1, -1],
            [1, 1],
            [-1, 1],
          ])
            holes.push(this.cylinder(c.cx + sx * holeOffset(p.pitch), c.cy + sy * holeOffset(p.pitch), floor - MAGNET_DEPTH, floor + 0.01, MAGNET_DIAMETER))
      }
    // Clip rails, at the middle of each clipped cell edge.
    const cutLength = Math.min(CLIP_CUT, p.pitch - 22)
    for (const s of drawer ? clipSpots(p, drawer as Drawer) : []) {
      const cut = this.clipCut(top, cutLength)
      if (s.acrossX) holes.push(s.x === 0 ? cut.translate([0, s.y, 0]) : cut.rotate([0, 0, 180]).translate([p.width, s.y, 0]))
      else holes.push(s.y === 0 ? cut.rotate([0, 0, 90]).translate([s.x, 0, 0]) : cut.rotate([0, 0, -90]).translate([s.x, p.depth, 0]))
    }
    return solid.subtract(M.union([...voids, ...holes]))
  }
}

function area(p: Vec2[]): number {
  let a = 0
  for (let i = 0; i < p.length; i++) a += p[i][0] * p[(i + 1) % p.length][1] - p[(i + 1) % p.length][0] * p[i][1]
  return a / 2
}
const ccw = (p: Vec2[]) => (area(p) < 0 ? [...p].reverse() : p)
const dedupe = (p: Vec2[]) => p.filter((q, i) => { const n = p[(i + 1) % p.length]; return Math.hypot(q[0] - n[0], q[1] - n[1]) > 1e-9 })

/** A rectangle on a wall, [u0, u1, v0, v1], where no hole may reach. */
type KeepOut = [number, number, number, number]

export interface LabelArea {
  index: number // compartment
  x0: number
  x1: number
  y0: number
  y1: number
  z: number // tab top
}

export interface BinInfo {
  width: number
  depth: number
  height: number
  floorZ: number
  labelAreas: number
  top: number
}

/** Split [a, b] into n + 1 equal compartments separated by n dividers; returns each one's span. */
function edges(a: number, b: number, n: number): [number, number][] {
  const inner = b - a - n * DIVIDER
  const each = inner / (n + 1)
  const out: [number, number][] = []
  for (let k = 0; k <= n; k++) {
    const s = a + k * (each + DIVIDER)
    out.push([s, s + each])
  }
  return out
}

/** The part of a profile above z0 (interpolating the point at z0). */
function clipProfile(profile: [number, number][], z0: number): [number, number][] {
  const out: [number, number][] = []
  for (let k = 0; k < profile.length; k++) {
    const [i, z] = profile[k]
    if (z > z0) {
      if (!out.length && k > 0) {
        const [pi, pz] = profile[k - 1]
        out.push([pi + ((i - pi) * (z0 - pz)) / (z - pz), z0])
      } else if (!out.length) out.push([i, z0])
      out.push([i, z])
    }
  }
  return out
}

/** Height of a bin's solid base (feet plus bridge) for the standard style. */
export const SOLID_BASE = BASE_HEIGHT

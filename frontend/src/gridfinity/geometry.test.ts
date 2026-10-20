import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { Builder } from './geometry'
import { binParts } from './parts'
import { clipCount, platePieces, drawerGrid } from './layout'
import { type Manifold, type ManifoldToplevel, loadManifold, scoped } from './mf'
import { BIN_CLEARANCE, CLIP_LENGTH, FOOT_HEIGHT, HEIGHT_UNIT, LIP_HEIGHT, MAGNET_DEPTH, MAGNET_DIAMETER, PITCH, PLATE_HEIGHT } from './spec'
import { loadFont } from './text'
import { type BinDesign, DEFAULT_BIN, DEFAULT_DRAWER, normaliseBin } from './types'

let M: ManifoldToplevel
let g: Builder

beforeAll(async () => {
  M = await loadManifold()
  const woff = readFileSync(fileURLToPath(new URL('../../node_modules/@fontsource/barlow-condensed/files/barlow-condensed-latin-600-normal.woff', import.meta.url)))
  g = new Builder(M, loadFont(woff.buffer.slice(woff.byteOffset, woff.byteOffset + woff.byteLength) as ArrayBuffer))
})

const plain = (patch: Partial<BinDesign> = {}): BinDesign => normaliseBin({ ...DEFAULT_BIN, tab: 'none', labels: [], w: 1, d: 1, h: 3, ...patch })

/** Width and depth of a solid's slice at height z. */
function sliceSize(m: Manifold, z: number): [number, number] {
  const b = m.slice(z).bounds()
  return [b.max[0] - b.min[0], b.max[1] - b.min[1]]
}

const overlap = (a: Manifold, b: Manifold) => a.intersect(b).volume()
// Rounded corners are polygons, and arcs of different radii are faceted differently: surfaces that
// touch in theory overlap by a few hundredths of a cubic millimetre.
const TOUCH = 0.2

describe('bin outside', () => {
  it('is 41.5 mm per cell less the clearance, 7 mm per unit plus the lip', () =>
    scoped(() => {
      const { body } = g.bin(plain({ w: 2, d: 3, h: 4 }))
      expect(body.status()).toBe('NoError')
      const bb = body.boundingBox()
      expect(bb.max[0] - bb.min[0]).toBeCloseTo(2 * PITCH - BIN_CLEARANCE, 3)
      expect(bb.max[1] - bb.min[1]).toBeCloseTo(3 * PITCH - BIN_CLEARANCE, 3)
      expect(bb.min[2]).toBeCloseTo(0, 6)
      expect(bb.max[2]).toBeCloseTo(4 * HEIGHT_UNIT + LIP_HEIGHT, 3)
    }))

  it('has the Gridfinity foot profile under each cell', () =>
    scoped(() => {
      const { body } = g.bin(plain())
      // 35.6 mm at the bottom, 37.2 mm after the first chamfer, 41.5 mm at the top of the foot.
      expect(sliceSize(body, 0.001)[0]).toBeCloseTo(35.6, 1)
      expect(sliceSize(body, 1.5)[0]).toBeCloseTo(37.2, 2)
      expect(sliceSize(body, 3.675)[0]).toBeCloseTo(37.2 + 2 * 1.075, 1)
      expect(sliceSize(body, FOOT_HEIGHT + 0.5)[0]).toBeCloseTo(41.5, 3)
    }))

  it('without a lip stops at 7 mm per unit', () =>
    scoped(() => {
      const bb = g.bin(plain({ lip: false })).body.boundingBox()
      expect(bb.max[2]).toBeCloseTo(3 * HEIGHT_UNIT, 3)
    }))
})

describe('fit', () => {
  it('seats in a baseplate on its chamfers, bottom level with the plate bottom', () =>
    scoped(() => {
      const plate = g.plate(platePieces({ ...DEFAULT_DRAWER, sizeMode: 'cells', cellsX: 1, cellsY: 1 })![0], 'thin')
      expect(plate.boundingBox().max[2]).toBeCloseTo(PLATE_HEIGHT, 3)
      const bin = g.bin(plain()).body.translate([PITCH / 2, PITCH / 2, 0])
      expect(overlap(plate, bin)).toBeLessThan(TOUCH)
      expect(overlap(plate, bin.translate([0, 0, -0.1]))).toBeGreaterThan(5 * TOUCH)
    }))

  it('follows a non-standard grid: a 50 mm bin seats in a 50 mm baseplate', () =>
    scoped(() => {
      const grid = { pitch: 50, unit: 8 }
      const { body } = g.bin(plain({ w: 2, h: 3 }), grid)
      const bb = body.boundingBox()
      expect(bb.max[0] - bb.min[0]).toBeCloseTo(2 * 50 - BIN_CLEARANCE, 3)
      expect(bb.max[2]).toBeCloseTo(3 * 8 + LIP_HEIGHT, 3)
      const plate = g.plate(platePieces({ ...DEFAULT_DRAWER, pitch: 50, unit: 8, sizeMode: 'cells', cellsX: 2, cellsY: 1 })![0], 'thin')
      const seated = body.translate([50, 25, 0])
      expect(overlap(plate, seated)).toBeLessThan(TOUCH)
      expect(overlap(plate, seated.translate([0, 0, -0.1]))).toBeGreaterThan(5 * TOUCH)
    }))

  it('seats a multi-cell bin over the ridges between cells', () =>
    scoped(() => {
      const plate = g.plate(platePieces({ ...DEFAULT_DRAWER, sizeMode: 'cells', cellsX: 2, cellsY: 2 })![0], 'thin')
      const bin = g.bin(plain({ w: 2, d: 2, h: 3 })).body.translate([PITCH, PITCH, 0])
      expect(overlap(plate, bin)).toBeLessThan(4 * TOUCH) // faceting noise, per cell
      expect(overlap(plate, bin.translate([0, 0, -0.1]))).toBeGreaterThan(5 * TOUCH)
    }))

  it('stacks on another bin, resting on the lip', () =>
    scoped(() => {
      const lower = g.bin(plain({ divX: 1, tab: 'full', labels: ['A', 'B'] })).body
      const upper = g.bin(plain()).body
      const z = 3 * HEIGHT_UNIT - 0.35
      expect(overlap(lower, upper.translate([0, 0, z]))).toBeLessThan(TOUCH)
      expect(overlap(lower, upper.translate([0, 0, z - 0.1]))).toBeGreaterThan(5 * TOUCH)
    }))
})

describe('features', () => {
  it('cuts 6.5 × 2.4 mm magnet holes under each cell corner', () =>
    scoped(() => {
      const solid = g.bin(plain()).body.volume()
      const holed = g.bin(plain({ holes: 'magnets' })).body.volume()
      const expected = 4 * Math.PI * (MAGNET_DIAMETER / 2) ** 2 * MAGNET_DEPTH
      expect(solid - holed).toBeGreaterThan(expected * 0.97)
      expect(solid - holed).toBeLessThan(expected * 1.01)
    }))

  it('puts holes only on the outer corners when asked', () =>
    scoped(() => {
      const all = g.bin(plain({ w: 2, d: 2, holes: 'magnets' })).body.volume()
      const corners = g.bin(plain({ w: 2, d: 2, holes: 'magnets', holesCorners: true })).body.volume()
      const solid = g.bin(plain({ w: 2, d: 2 })).body.volume()
      expect((solid - all) / (solid - corners)).toBeCloseTo(4, 1)
    }))

  it('cuts hexagons through the walls and stays one solid', () =>
    scoped(() => {
      const d = plain({ w: 2, h: 6, pattern: 'hex', wall: 1.6, divX: 1, scoop: 8, tab: 'full', labels: ['M3', 'M4'] })
      const hex = g.bin(d).body
      const solid = g.bin({ ...d, pattern: 'solid' }).body
      expect(hex.status()).toBe('NoError')
      expect(hex.decompose().length).toBe(1)
      expect(hex.volume()).toBeLessThan(solid.volume() * 0.97)
      expect(hex.genus()).toBeGreaterThan(solid.genus() + 20)
    }))

  it('makes lighter bins with hollow feet', () =>
    scoped(() => {
      const std = g.bin(plain({ w: 2, d: 2 })).body
      const lite = g.bin(plain({ w: 2, d: 2, base: 'lite', floor: 1 })).body
      expect(lite.status()).toBe('NoError')
      expect(lite.decompose().length).toBe(1)
      expect(lite.volume()).toBeLessThan(std.volume() * 0.85)
      // The foot bottoms are closed, so nothing falls out.
      expect(lite.slice(0.5).area()).toBeCloseTo(std.slice(0.5).area(), 1)
    }))

  it('inlays labels flush in their own part, without overlapping the body', () =>
    scoped(() => {
      const { body, label, info } = g.bin(plain({ w: 3, h: 6, divX: 2, labels: ['M3', '', 'Nuts'], tab: 'full' }))
      expect(info.labelAreas).toBe(3)
      expect(label).not.toBeNull()
      expect(label!.decompose().length).toBeGreaterThan(3) // M, 3, N, u, t, s
      expect(overlap(body, label!)).toBeLessThan(1e-3)
      expect(label!.boundingBox().max[2]).toBeCloseTo(info.top, 3)
      // The label fills the pocket: together they are the unlabelled bin.
      const blank = g.bin(plain({ w: 3, h: 6, divX: 2, tab: 'full' })).body
      expect(body.volume() + label!.volume()).toBeCloseTo(blank.volume(), 1)
    }))

  it('engraves the label when it is printed in the bin colour', () => {
    const d = plain({ w: 2, h: 6, labels: ['Bits'], tab: 'full', body: 0, labelFilament: 0 })
    const { parts } = binParts(g, d, [{ name: 'Grey', hex: '#808080' }])
    expect(parts.length).toBe(1)
    const engraved = scoped(() => M.Manifold.ofMesh(new M.Mesh({ numProp: 3, vertProperties: parts[0].mesh.positions, triVerts: parts[0].mesh.indices })).volume())
    const blank = scoped(() => g.bin(plain({ w: 2, h: 6, tab: 'full' })).body.volume())
    expect(engraved).toBeLessThan(blank - 5) // the letters are cut out, not filled back in
  })

  it('adds dividers and scoops that stay inside the bin', () =>
    scoped(() => {
      const d = plain({ w: 2, d: 2, h: 5, divX: 2, divY: 1, scoop: 10 })
      const { body } = g.bin(d)
      expect(body.status()).toBe('NoError')
      expect(body.volume()).toBeGreaterThan(g.bin(plain({ w: 2, d: 2, h: 5 })).body.volume())
      const bb = body.boundingBox()
      expect(bb.max[0] - bb.min[0]).toBeCloseTo(2 * PITCH - BIN_CLEARANCE, 3)
    }))
})

describe('baseplates', () => {
  it('cuts clip rails along seams (and picked outer edges); the clip locks on and rebuilds the ridge', () =>
    scoped(() => {
      // A 60 mm bed forces one cell per piece: piece 0 joins piece 1 on its right.
      const drawer = { ...DEFAULT_DRAWER, sizeMode: 'cells' as const, cellsX: 2, cellsY: 1, bedX: 60, bedY: 60, connectors: 'clips' as const }
      const pieces = platePieces(drawer)!
      expect(pieces.length).toBe(2)
      expect(clipCount(drawer, pieces)).toBe(1)
      expect(clipCount({ ...drawer, connectorEdges: { ...drawer.connectorEdges, back: true, left: true } }, pieces)).toBe(1 + 2 + 1)
      expect(platePieces({ ...drawer, split: false })!.length).toBe(1)
      const plain0 = g.plate(pieces[0], 'thin')
      const left = g.plate(pieces[0], 'thin', drawer)
      const right = g.plate(pieces[1], 'thin', drawer).translate([pieces[1].x, 0, 0])
      expect(left.status()).toBe('NoError')
      expect(plain0.volume() - left.volume()).toBeGreaterThan(20) // half a ridge, 20 mm long
      // The clip, standing as exported, laid along the seam: across x, its depth measured down from the top.
      const top = PLATE_HEIGHT
      const clip = g.clip().rotate([90, 0, 0]).translate([PITCH, PITCH / 2 + CLIP_LENGTH / 2, top])
      const both = left.add(right)
      expect(overlap(both, clip)).toBeLessThan(0.05) // it fits
      expect(overlap(both, clip.translate([0, 0, 0.3]))).toBeGreaterThan(0.05) // and the barbs hold it down
      // With the clip in, a bin seats across the seam as on a plain plate.
      const bin = g.bin(plain({ w: 2 })).body.translate([PITCH, PITCH / 2, 0])
      expect(overlap(both.add(clip), bin)).toBeLessThan(2 * TOUCH)
      expect(overlap(left, g.bin(plain({})).body.translate([PITCH / 2, PITCH / 2, 0]))).toBeLessThan(TOUCH)
    }))

  it('splits a large drawer into pieces that fit the bed and add up to the plate', () =>
    scoped(() => {
      const drawer = { ...DEFAULT_DRAWER, sizeMode: 'mm' as const, width: 500, depth: 300, bedX: 256, bedY: 256 }
      const grid = drawerGrid(drawer)
      expect(grid.nx).toBe(11)
      expect(grid.ny).toBe(7)
      const pieces = platePieces(drawer)!
      expect(pieces.length).toBe(6) // 11 cells need 3 pieces across a 256 mm bed, 7 rows need 2
      let area = 0
      for (const p of pieces) {
        expect(p.width).toBeLessThanOrEqual(255.5)
        expect(p.depth).toBeLessThanOrEqual(255.5)
        area += p.width * p.depth
      }
      expect(area).toBeCloseTo(grid.width * grid.depth, 3)
      expect(grid.width).toBeCloseTo(499.5, 6)
      const plate = g.plate(pieces[0], 'magnets')
      expect(plate.status()).toBe('NoError')
      const bb = plate.boundingBox()
      expect(bb.max[0]).toBeCloseTo(pieces[0].width, 3)
    }))
})

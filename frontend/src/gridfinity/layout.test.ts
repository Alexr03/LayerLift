import { describe, expect, it } from 'vitest'
import { binIssues, drawerGrid, freeSpot, splitAxis } from './layout'
import { DEFAULT_BIN, DEFAULT_DRAWER, type Scene, normaliseProject } from './types'

const project = (bins: Scene['bins'], drawer: Partial<Scene['drawer']> = {}): Scene => ({
  title: 't',
  filaments: [{ name: 'Grey', hex: '#808080' }],
  drawer: { ...DEFAULT_DRAWER, sizeMode: 'mm', width: 5 * 42 + 10.5, depth: 4 * 42 + 0.5, ...drawer },
  bins,
})

describe('drawer grid', () => {
  it('sizes a baseplate by cells with no margin', () => {
    const g = drawerGrid({ ...DEFAULT_DRAWER, sizeMode: 'cells', cellsX: 6, cellsY: 6 })
    expect([g.nx, g.ny, g.width, g.padLeft]).toEqual([6, 6, 252, 0])
  })

  it('fits whole cells and puts the spare room where asked', () => {
    const g = drawerGrid({ ...DEFAULT_DRAWER, sizeMode: 'mm', width: 5 * 42 + 10.5, depth: 4 * 42 + 0.5 })
    expect([g.nx, g.ny]).toEqual([5, 4])
    expect(g.padLeft).toBeCloseTo(5)
    expect(g.padRight).toBeCloseTo(5)
    expect(g.padFront + g.padBack).toBeCloseTo(0)
    const right = drawerGrid({ ...DEFAULT_DRAWER, sizeMode: 'mm', width: 5 * 42 + 10.5, alignX: 'start' })
    expect([right.padLeft, right.padRight]).toEqual([0, 10])
  })

  it('splits evenly with the margins on the outer pieces', () => {
    const spans = splitAxis(11, 8, 8, 256)!
    expect(spans.map((s) => s.count)).toEqual([4, 4, 3])
    expect(spans[0].padA).toBe(8)
    expect(spans[spans.length - 1].padB).toBe(8)
    for (const s of spans) expect(s.count * 42 + s.padA + s.padB).toBeLessThanOrEqual(255.5)
    expect(splitAxis(1, 300, 0, 256)).toBeNull()
  })
})

describe('bins', () => {
  const bin = (id: string, x: number, y: number, w = 2, d = 1, h = 6) => ({ id, x, y, design: { ...DEFAULT_BIN, w, d, h } })

  it('flags overlaps, bins off the grid and bins taller than the drawer', () => {
    const p = project([bin('a', 0, 0), bin('b', 1, 0), bin('c', 4, 3), bin('d', 0, 2, 1, 1, 9)], { height: 60 })
    const issues = binIssues(p)
    expect(issues.find((i) => i.id === 'b')?.message).toMatch(/Overlaps/)
    expect(issues.find((i) => i.id === 'c')?.message).toMatch(/off the grid/)
    expect(issues.find((i) => i.id === 'd')?.message).toMatch(/Taller/)
    expect(issues.some((i) => i.id === 'a')).toBe(false)
  })

  it('finds the first free spot', () => {
    const p = project([bin('a', 0, 0, 5, 1)])
    expect(freeSpot(p, 2, 2)).toEqual({ x: 0, y: 1 })
    expect(freeSpot(project([bin('a', 0, 0, 5, 4)]), 1, 1)).toBeNull()
  })
})

describe('loading projects', () => {
  it('fills in and clamps whatever it is given', () => {
    // A project from before baseplates were a list: its drawer and bins become the first one.
    const p = normaliseProject({
      title: 'x',
      filaments: [{ name: 'Red', hex: 'nope' }],
      drawer: { width: -5, plate: 'marble' },
      bins: [{ x: 2.6, design: { w: 99, h: 1, holes: 'magnets', base: 'lite', body: 7 } }],
    })
    expect(p.version).toBe(2)
    expect(p.mode).toBe('project')
    expect(p.filaments[0].hex).toBe('#808080')
    expect(p.plates.length).toBe(1)
    const plate = p.plates[0]
    expect(plate.drawer.sizeMode).toBe('mm') // it was measured in millimetres
    expect(plate.drawer.width).toBe(42)
    expect(plate.drawer.plate).toBe('thin')
    const b = plate.bins[0]
    expect(b.id).toBeTruthy()
    expect(b.x).toBe(3)
    expect(b.design.w).toBe(10)
    expect(b.design.h).toBe(2)
    expect(b.design.holes).toBe('none') // lite feet can't hold magnets
    expect(b.design.body).toBe(0)
    expect(normaliseProject(null).plates[0].bins).toEqual([])
  })
})

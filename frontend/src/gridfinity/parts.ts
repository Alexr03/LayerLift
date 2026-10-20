// From designs to coloured parts: what the preview draws and what the 3MF contains.
import type { Builder, BinInfo } from './geometry'
import type { Piece } from './layout'
import { type MeshData, scoped, toMesh } from './mf'
import type { BinDesign, Drawer, GfFilament } from './types'
import { DEFAULT_GRID, type GridSpec } from './spec'

export interface BuiltPart {
  name: string // "01 Grey": slot and filament, as in the relief tool's files
  filament: number
  hex: string
  mesh: MeshData
}

const partName = (filaments: GfFilament[], i: number) => `${String(i + 1).padStart(2, '0')} ${filaments[i]?.name ?? 'Filament'}`

export function binParts(g: Builder, design: BinDesign, filaments: GfFilament[], grid: GridSpec = DEFAULT_GRID): { parts: BuiltPart[]; info: BinInfo } {
  return scoped(() => {
    const { body, label, info } = g.bin(design, grid)
    const parts: BuiltPart[] = []
    const same = label != null && design.labelFilament === design.body
    // A label in the body's own filament is part of the body: raised text stays on, and an
    // inlay is left as an engraving (the pocket is already cut), so it still shows in one colour.
    const whole = same && design.labelStyle === 'raised' ? body.add(label) : body
    parts.push({ name: partName(filaments, design.body), filament: design.body, hex: filaments[design.body]?.hex ?? '#808080', mesh: toMesh(whole) })
    if (label && !same)
      parts.push({
        name: partName(filaments, design.labelFilament),
        filament: design.labelFilament,
        hex: filaments[design.labelFilament]?.hex ?? '#1C1C1E',
        mesh: toMesh(label),
      })
    return { parts, info }
  })
}

export function plateParts(g: Builder, piece: Piece, drawer: Drawer, filaments: GfFilament[]): BuiltPart[] {
  return scoped(() => {
    const f = drawer.plateFilament
    return [{ name: partName(filaments, f), filament: f, hex: filaments[f]?.hex ?? '#808080', mesh: toMesh(g.plate(piece, drawer.plate, drawer)) }]
  })
}

/** `count` connection clips standing in a grid, ready to print in one go. */
export function clipParts(g: Builder, drawer: Drawer, filaments: GfFilament[], count: number): BuiltPart[] {
  return scoped(() => {
    const one = g.clip(drawer.clipTolerance)
    const cols = Math.ceil(Math.sqrt(count))
    const keys = Array.from({ length: count }, (_, i) => one.translate([(i % cols) * 9, Math.floor(i / cols) * 9, 0]))
    const f = drawer.plateFilament
    return [{ name: partName(filaments, f), filament: f, hex: filaments[f]?.hex ?? '#808080', mesh: toMesh(g.M.Manifold.union(keys)) }]
  })
}

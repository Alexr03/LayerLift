// Builds Gridfinity geometry off the main thread: manifold-3d (WASM) plus the label font. Bin
// meshes are cached by design, so re-arranging a drawer only rebuilds what changed.
import wasmUrl from 'manifold-3d/manifold.wasm?url'
import fontUrl from '@fontsource/barlow-condensed/files/barlow-condensed-latin-600-normal.woff?url'
import { export3mf, exportStl, safeName, zip } from './export'
import { Builder } from './geometry'
import { type Piece, clipCount, drawerGrid, gridSpec, platePieces, plateFloor } from './layout'
import { loadManifold } from './mf'
import { type BuiltPart, binParts, clipParts, plateParts } from './parts'
import { loadFont } from './text'
import type { BinDesign, Scene } from './types'
import type { Request, Response, ViewPart } from './protocol'

let builder: Promise<Builder> | null = null
function getBuilder(): Promise<Builder> {
  builder ??= Promise.all([loadManifold(wasmUrl), fetch(fontUrl).then((r) => r.arrayBuffer())]).then(([M, font]) => new Builder(M, loadFont(font)))
  return builder
}

// ------------------------------------------------------------------ cache

const cache = new Map<string, { parts: BuiltPart[]; volume: number }>()
const CACHE_SIZE = 80

function binCached(g: Builder, design: BinDesign, project: Scene) {
  const grid = gridSpec(project.drawer)
  const key = JSON.stringify([design, project.filaments, grid])
  const hit = cache.get(key)
  if (hit) {
    cache.delete(key)
    cache.set(key, hit)
    return hit
  }
  const { parts } = binParts(g, design, project.filaments, grid)
  const entry = { parts, volume: parts.reduce((a, p) => a + meshVolume(p.mesh.positions, p.mesh.indices), 0) }
  cache.set(key, entry)
  if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!)
  return entry
}

function meshVolume(p: Float32Array, t: Uint32Array): number {
  let v = 0
  for (let i = 0; i < t.length; i += 3) {
    const a = t[i] * 3
    const b = t[i + 1] * 3
    const c = t[i + 2] * 3
    v += p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c])
  }
  return v / 6
}

const plateCache = new Map<string, BuiltPart[]>()

function plateCached(g: Builder, piece: Piece, project: Scene): BuiltPart[] {
  const key = JSON.stringify([piece, project.drawer.plate, project.drawer.plateFilament, project.drawer.connectors, project.drawer.connectorEdges, project.drawer.clipTolerance, project.filaments])
  let parts = plateCache.get(key)
  if (!parts) {
    parts = plateParts(g, piece, project.drawer, project.filaments)
    plateCache.set(key, parts)
    if (plateCache.size > 24) plateCache.delete(plateCache.keys().next().value!)
  }
  return parts
}

/** A copy of the mesh moved by (dx, dy, dz): cached meshes are never handed over themselves. */
function moved(part: BuiltPart, group: string, dx: number, dy: number, dz: number): ViewPart {
  const src = part.mesh.positions
  const positions = new Float32Array(src.length)
  for (let i = 0; i < src.length; i += 3) {
    positions[i] = src[i] + dx
    positions[i + 1] = src[i + 1] + dy
    positions[i + 2] = src[i + 2] + dz
  }
  return { group, name: part.name, hex: part.hex, filament: part.filament, positions, indices: part.mesh.indices.slice() }
}

// ------------------------------------------------------------------ requests

async function handle(req: Request): Promise<Response> {
  const g = await getBuilder()
  if (req.kind === 'export') return exportFiles(g, req)
  const p = req.scene
  if (req.kind === 'bin') {
    const bin = p.bins.find((b) => b.id === req.bin)
    if (!bin) return { id: req.id, kind: 'parts', parts: [], volume: 0 }
    const { parts, volume } = binCached(g, bin.design, p)
    return { id: req.id, kind: 'parts', parts: parts.map((part) => moved(part, bin.id, 0, 0, 0)), volume }
  }
  if (req.kind === 'drawer' || req.kind === 'plate') {
    const grid = drawerGrid(p.drawer)
    const pieces = platePieces(p.drawer, grid) ?? []
    const parts: ViewPart[] = []
    let volume = 0
    // Pieces are pulled apart a little so the joins show.
    const gap = req.kind === 'plate' ? 6 : 0
    for (const piece of pieces) {
      for (const part of plateCached(g, piece, p)) {
        parts.push(moved(part, `plate-${piece.index}`, piece.x + piece.col * gap, piece.y + piece.row * gap, 0))
        volume += meshVolume(part.mesh.positions, part.mesh.indices)
      }
    }
    if (req.kind === 'drawer') {
      const z = plateFloor(p.drawer.plate)
      for (const b of p.bins) {
        const { parts: bp } = binCached(g, b.design, p)
        const cx = grid.padLeft + (b.x + b.design.w / 2) * grid.pitch
        const cy = grid.padFront + (b.y + b.design.d / 2) * grid.pitch
        for (const part of bp) parts.push(moved(part, b.id, cx, cy, z))
      }
    }
    return { id: req.id, kind: 'parts', parts, volume }
  }
  throw new Error('unknown request')
}

type ExportRequest = Extract<Request, { kind: 'export' }>

function exportFiles(g: Builder, req: ExportRequest): Response {
  const files: Record<string, Uint8Array> = {}
  const three = (title: string, parts: BuiltPart[]) =>
    export3mf(
      title,
      parts.map((x) => ({ name: x.name, slot: x.filament + 1, mesh: x.mesh })),
      { version: req.version },
    )
  const many = req.plates.length > 1
  req.plates.forEach((plate, pi) => {
    const scene: Scene = { title: req.title, filaments: req.filaments, drawer: plate.drawer, bins: plate.bins }
    // With several baseplates, each gets its own folder.
    const dir = many ? `${safeName(`${String(pi + 1).padStart(2, '0')} ${plate.name}`)}/` : ''
    const bins = req.bins === 'all' ? plate.bins : plate.bins.filter((b) => req.bins.includes(b.id))
    // Identical bins share one file, named with how many to print.
    const groups = new Map<string, { design: BinDesign; count: number; label: string }>()
    for (const b of bins) {
      const key = JSON.stringify(b.design)
      const label = b.design.labels.filter(Boolean).join(', ')
      const g0 = groups.get(key)
      if (g0) g0.count++
      else groups.set(key, { design: b.design, count: 1, label })
    }
    let n = 0
    for (const { design, count, label } of groups.values()) {
      n++
      const title = `Bin ${design.w}x${design.d}x${design.h}${label ? ` ${label}` : ''}`
      const name = safeName(`${String(n).padStart(2, '0')} ${title}${count > 1 ? ` (print ${count})` : ''}`)
      const { parts } = binCached(g, design, scene)
      files[`${dir}${name}.3mf`] = three(title, parts)
      if (req.stl) parts.forEach((x) => (files[`${dir}STL/${name} - ${safeName(x.name)}.stl`] = exportStl(x.mesh, x.name)))
    }
    if (req.plate) {
      const pieces = platePieces(plate.drawer) ?? []
      for (const piece of pieces) {
        const title = pieces.length > 1 ? `Baseplate ${piece.row + 1}-${piece.col + 1} (${piece.nx}x${piece.ny})` : `Baseplate ${piece.nx}x${piece.ny}`
        const parts = plateCached(g, piece, scene)
        files[`${dir}${safeName(title)}.3mf`] = three(title, parts)
        if (req.stl) files[`${dir}STL/${safeName(title)}.stl`] = exportStl(parts[0].mesh, title)
      }
      const keys = clipCount(plate.drawer, pieces)
      if (keys) {
        const title = `Connection clips (print ${keys})`
        const parts = clipParts(g, plate.drawer, req.filaments, keys)
        files[`${dir}${safeName(title)}.3mf`] = three(title, parts)
        if (req.stl) files[`${dir}STL/${safeName(title)}.stl`] = exportStl(parts[0].mesh, title)
      }
    }
  })
  const names = Object.keys(files)
  if (!names.length) throw new Error('nothing to export')
  if (names.length === 1 && !req.forceZip) return { id: req.id, kind: 'file', name: names[0].split('/').pop()!, data: files[names[0]] }
  files['README.txt'] = new TextEncoder().encode(readme(req))
  return { id: req.id, kind: 'file', name: `${safeName(req.title)}.zip`, data: zip(files) }
}

function readme(req: ExportRequest): string {
  const plates = req.plates.map((p) => {
    const grid = drawerGrid(p.drawer)
    const pieces = platePieces(p.drawer, grid) ?? []
    return `${p.name}: ${grid.nx} x ${grid.ny} cells, ${grid.width.toFixed(1)} x ${grid.depth.toFixed(1)} mm, ${pieces.length} piece${pieces.length === 1 ? '' : 's'}, ${p.bins.length} bin${p.bins.length === 1 ? '' : 's'}.`
  })
  return [
    req.title,
    '',
    ...plates,
    '',
    'Each 3MF opens in OrcaSlicer or Bambu Studio with every part already on its AMS slot:',
    ...req.filaments.map((f, i) => `  Slot ${i + 1}: ${f.name} (${f.hex})`),
    '',
    'Files named "(print N)" are for N identical bins.',
    'Made with LayerLift.',
    '',
  ].join('\n')
}

// The app is typed against the DOM library; this is the part of the worker scope used here.
const scope = self as unknown as { postMessage(message: Response, transfer: Transferable[]): void; onmessage: ((e: MessageEvent<Request>) => void) | null }

scope.onmessage = async (e: MessageEvent<Request>) => {
  const req = e.data
  try {
    const res = await handle(req)
    const transfer: Transferable[] = []
    if (res.kind === 'parts') for (const x of res.parts) transfer.push(x.positions.buffer, x.indices.buffer)
    if (res.kind === 'file') transfer.push(res.data.buffer)
    scope.postMessage(res, transfer)
  } catch (err) {
    scope.postMessage({ id: req.id, kind: 'error', message: err instanceof Error ? err.message : String(err) }, [])
  }
}

// Client-side mirror of the backend's height rules, for live feedback before a build.
import type { Analysis, BuildSettings, Filament } from './api'
import { luminance, snap } from './palettes'

export interface PlanBand {
  filament: number
  z0: number
  z1: number
  area: number // source pixels
}

export interface Plan {
  bands: PlanBand[]
  baseFilament: number | null
  top: number
  changes: number
  heights: number[]
}

export function effectiveFilaments(analysis: Analysis, mapping: number[], settings: BuildSettings): number[] {
  return analysis.regions.map((r) => settings.region_overrides[r.id]?.filament ?? mapping[r.cluster] ?? 0)
}

export function filamentHeights(filaments: Filament[], used: number[], s: BuildSettings): number[] {
  const base = snap(s.base_mm, s.layer_mm)
  const order = [...used].sort((a, b) => {
    const d = luminance(filaments[a].hex) - luminance(filaments[b].hex)
    return s.lighter_taller ? d : -d
  })
  const auto = new Map(order.map((f, rank) => [f, snap(base + 0.8 + rank * 0.4, s.layer_mm)]))
  return filaments.map((f, i) =>
    s.height_mode === 'manual' && f.height_mm != null
      ? snap(f.height_mm, s.layer_mm)
      : (auto.get(i) ?? snap(base + 0.8, s.layer_mm)),
  )
}

export function makePlan(analysis: Analysis, mapping: number[], s: BuildSettings): Plan {
  const { filaments, layer_mm: layer } = s
  const regionFil = effectiveFilaments(analysis, mapping, s)
  const area = new Array(filaments.length).fill(0)
  analysis.regions.forEach((r, i) => (area[regionFil[i]] += r.area))
  const used = filaments.map((_, i) => i).filter((i) => area[i] > 0)
  const base = snap(s.base_mm, layer)
  let baseFil: number | null = s.base_filament
  if (baseFil == null || baseFil >= filaments.length) {
    const cands = used.filter((i) => !filaments[i].start_from_bed)
    const pool = cands.length ? cands : used
    baseFil = pool.length ? pool.reduce((a, b) => (area[b] > area[a] ? b : a)) : null
  }
  const heights = filamentHeights(filaments, used, s)
  const groups = new Map<string, PlanBand>()
  analysis.regions.forEach((r, i) => {
    const fil = regionFil[i]
    const ov = s.region_overrides[r.id]
    let z1 = ov?.height_mm != null ? snap(ov.height_mm, layer) : s.cluster_heights[r.cluster] != null ? snap(s.cluster_heights[r.cluster], layer) : heights[fil]
    const fromBed = filaments[fil].start_from_bed || fil === baseFil
    const z0 = fromBed ? 0 : base
    const lo = fil === baseFil ? base : fromBed ? layer : base + layer
    z1 = Math.max(z1, lo)
    const key = `${fil}:${z0}:${z1.toFixed(3)}`
    const g = groups.get(key)
    if (g) g.area += r.area
    else groups.set(key, { filament: fil, z0: fil === baseFil ? base : z0, z1, area: r.area })
  })
  const bands = [...groups.values()]
  if (baseFil != null && base > 0) bands.push({ filament: baseFil, z0: 0, z1: base, area: 0 })
  const top = bands.reduce((m, b) => Math.max(m, b.z1), 0)
  return { bands, baseFilament: baseFil, top, changes: estimateChanges(bands, layer, top), heights }
}

/** Same dynamic programme as relief/changes.py: fewest changes with optimal chaining. */
export function estimateChanges(bands: PlanBand[], layer: number, top: number): number {
  const n = Math.round(top / layer)
  let dp: Map<number, number> | null = null
  for (let i = 0; i < n; i++) {
    const zm = (i + 0.5) * layer
    const s = new Set(bands.filter((b) => b.z0 <= zm && zm < b.z1).map((b) => b.filament))
    if (s.size === 0) continue
    const k = s.size
    const next = new Map<number, number>()
    if (dp === null) {
      s.forEach((b) => next.set(b, k - 1))
    } else {
      const prev: Map<number, number> = dp
      const sw = Math.min(...prev.values()) + 1
      s.forEach((b) => {
        let opt = sw
        prev.forEach((cost, a) => {
          if (s.has(a) && (k === 1 || a !== b) && cost < opt) opt = cost
        })
        next.set(b, opt + k - 1)
      })
    }
    dp = next
  }
  return dp ? Math.min(...dp.values()) : 0
}

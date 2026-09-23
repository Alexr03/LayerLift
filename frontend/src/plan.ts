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
  baseHeights: number[] // per filament before the strategy reshapes them (what an explicit height means)
  regionTop: (number | null)[] // per region id, null = removed
  mmPerPx: number // print scale of one source pixel
}

/** Millimetres per source pixel, from the kept regions' extent (the backend sizes the traced outline). */
export function mmPerPx(analysis: Analysis, s: BuildSettings, kept: boolean[]): number {
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity]
  analysis.regions.forEach((r, i) => {
    if (!kept[i]) return
    x0 = Math.min(x0, r.bbox[0])
    y0 = Math.min(y0, r.bbox[1])
    x1 = Math.max(x1, r.bbox[0] + r.bbox[2])
    y1 = Math.max(y1, r.bbox[1] + r.bbox[3])
  })
  if (!(x1 > x0)) return 0
  const dims = { width: x1 - x0, height: y1 - y0, longest: Math.max(x1 - x0, y1 - y0) }
  return s.width_mm / dims[s.size_mode]
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

const r6 = (z: number) => Math.round(z * 1e6) / 1e6

/** Compact strategy (relief/pipeline.py squeeze_heights): distinct levels above the base one layer apart. */
export function squeezeHeights(levels: number[], base: number, layer: number): (z: number) => number {
  const above = [...new Set(levels.filter((z) => z > base + 1e-9).map(r6))].sort((a, b) => a - b)
  return (z) => (z <= base + 1e-9 ? z : r6(base + (above.filter((a) => a < z - 1e-9).length + 1) * layer))
}

/** Stacked strategy (relief/pipeline.py stack_bands): filament order bottom to top and each band's top. */
export function stackBands(used: number[], heights: number[], baseFilament: number | null, base: number, layer: number) {
  let order = [...used].sort((a, b) => heights[a] - heights[b] || a - b)
  let top: number
  if (baseFilament != null && order[0] !== baseFilament) {
    order = [baseFilament, ...order.filter((f) => f !== baseFilament)]
    top = base
  } else {
    top = Math.max(base, heights[order[0]])
  }
  top = Math.max(top, layer)
  const tops = new Map<number, number>()
  order.forEach((f, i) => {
    if (i) top = Math.max(heights[f], r6(top + layer))
    tops.set(f, r6(top))
  })
  return { order, tops }
}

export function makePlan(analysis: Analysis, mapping: number[], s: BuildSettings): Plan {
  const { filaments, layer_mm: layer } = s
  const regionFil = effectiveFilaments(analysis, mapping, s)
  const kept = analysis.regions.map((r) => !s.region_overrides[r.id]?.removed)
  const area = new Array(filaments.length).fill(0)
  analysis.regions.forEach((r, i) => kept[i] && (area[regionFil[i]] += r.area))
  const used = filaments.map((_, i) => i).filter((i) => area[i] > 0)
  const base = snap(s.base_mm, layer)
  const explicitBase = s.base_filament != null && s.base_filament < filaments.length ? s.base_filament : null
  let heights = filamentHeights(filaments, used, s)
  const baseHeights = heights
  const scale = mmPerPx(analysis, s, kept)
  const regionTop: (number | null)[] = analysis.regions.map(() => null)

  if (s.strategy === 'stacked') {
    // One band per filament; per-colour and per-area heights don't apply.
    if (!used.length) return { bands: [], baseFilament: null, top: 0, changes: 0, heights, baseHeights, regionTop, mmPerPx: scale }
    const { order, tops } = stackBands(used, heights, explicitBase, base, layer)
    heights = heights.map((h, i) => tops.get(i) ?? h)
    const bands = order.map((f, j) => ({ filament: f, z0: j ? heights[order[j - 1]] : 0, z1: heights[f], area: area[f] }))
    const top = heights[order[order.length - 1]]
    analysis.regions.forEach((r, i) => kept[i] && (regionTop[r.id] = heights[regionFil[i]]))
    return { bands, baseFilament: order[0], top, changes: estimateChanges(bands, layer, top), heights, baseHeights, regionTop, mmPerPx: scale }
  }

  let baseFil: number | null = explicitBase
  if (baseFil == null) {
    const cands = used.filter((i) => !filaments[i].start_from_bed)
    const pool = cands.length ? cands : used
    baseFil = pool.length ? pool.reduce((a, b) => (area[b] > area[a] ? b : a)) : null
  }
  const compact = s.strategy === 'compact'
  const placed = analysis.regions.filter((_, i) => kept[i]).map((r) => {
    const fil = regionFil[r.id]
    const ov = s.region_overrides[r.id]
    let z1 = ov?.height_mm != null ? snap(ov.height_mm, layer) : s.cluster_heights[r.cluster] != null ? snap(s.cluster_heights[r.cluster], layer) : heights[fil]
    const fromBed = (filaments[fil].start_from_bed && !compact) || fil === baseFil
    const z0 = fromBed ? 0 : base
    const lo = fil === baseFil ? base : fromBed ? layer : base + layer
    z1 = r6(Math.max(z1, lo))
    return { id: r.id, fil, z0, z1, area: r.area }
  })
  if (compact) {
    const squeeze = squeezeHeights(placed.map((p) => p.z1), base, layer)
    placed.forEach((p) => (p.z1 = squeeze(p.z1)))
    heights = heights.map(squeeze)
  }
  placed.forEach((p) => (regionTop[p.id] = p.z1))
  const groups = new Map<string, PlanBand>()
  placed.forEach(({ fil, z0, z1, area }) => {
    const key = `${fil}:${z0}:${z1.toFixed(3)}`
    const g = groups.get(key)
    if (g) g.area += area
    else groups.set(key, { filament: fil, z0: fil === baseFil ? base : z0, z1, area })
  })
  const bands = [...groups.values()]
  if (baseFil != null && base > 0) bands.push({ filament: baseFil, z0: 0, z1: base, area: 0 })
  const top = bands.reduce((m, b) => Math.max(m, b.z1), 0)
  return { bands, baseFilament: baseFil, top, changes: estimateChanges(bands, layer, top), heights, baseHeights, regionTop, mmPerPx: scale }
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

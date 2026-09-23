// Region edits that need more than setting one field: merging into the surroundings and tidying specks.
import type { Analysis, RegionOverride } from './api'

/** The user's edits to the colour map, as one value so they can be undone together. */
export interface Edits {
  mapping: number[]
  locked: Record<number, number>
  regionOverrides: Record<number, RegionOverride>
  clusterHeights: Record<number, number>
}

/** Drop an override that no longer changes anything. */
export function withOverride(ro: Record<number, RegionOverride>, id: number, o: RegionOverride | null): Record<number, RegionOverride> {
  const next = { ...ro }
  if (!o || (o.filament == null && o.height_mm == null && !o.removed)) delete next[id]
  else next[id] = o
  return next
}

export function filamentOf(analysis: Analysis, mapping: number[], ro: Record<number, RegionOverride>, id: number): number {
  return ro[id]?.filament ?? mapping[analysis.regions[id].cluster] ?? 0
}

/**
 * The override that makes a region look like its surroundings: the filament it shares the most
 * boundary with (removed areas and ``skip`` don't count), plus the height of the neighbour it shares
 * the longest edge with when that height was set explicitly. If the region's own colour has a height
 * set, the filament's usual height (``filamentHeight``) replaces it. Null if it has no usable neighbour.
 */
export function mergeOverride(
  analysis: Analysis,
  mapping: number[],
  ro: Record<number, RegionOverride>,
  clusterHeights: Record<number, number>,
  filamentHeight: (filament: number) => number,
  id: number,
  skip: Set<number> = new Set(),
): RegionOverride | null {
  const byFilament = new Map<number, number>()
  const usable = (analysis.regions[id].neighbours ?? []).filter(([n]) => !ro[n]?.removed && !skip.has(n))
  for (const [n, len] of usable) {
    const f = filamentOf(analysis, mapping, ro, n)
    byFilament.set(f, (byFilament.get(f) ?? 0) + len)
  }
  if (!byFilament.size) return null
  const filament = [...byFilament].reduce((a, b) => (b[1] > a[1] ? b : a))[0]
  // Neighbours are sorted longest edge first.
  const [dominant] = usable.find(([n]) => filamentOf(analysis, mapping, ro, n) === filament)!
  const explicit = ro[dominant]?.height_mm ?? clusterHeights[analysis.regions[dominant].cluster] ?? null
  const ownColourHeight = clusterHeights[analysis.regions[id].cluster] != null
  return { filament, height_mm: explicit ?? (ownColourHeight ? filamentHeight(filament) : null) }
}

/**
 * Merge several regions into their surroundings, biggest first. Each prefers neighbours that aren't
 * being merged themselves, so a cluster of specks takes the colour around it rather than each other's.
 */
export function mergeAll(
  analysis: Analysis,
  mapping: number[],
  ro: Record<number, RegionOverride>,
  clusterHeights: Record<number, number>,
  filamentHeight: (filament: number) => number,
  ids: number[],
): Record<number, RegionOverride> {
  const pending = new Set(ids)
  let next = ro
  for (const id of [...ids].sort((a, b) => analysis.regions[b].area - analysis.regions[a].area)) {
    pending.delete(id)
    const o =
      mergeOverride(analysis, mapping, next, clusterHeights, filamentHeight, id, pending) ??
      mergeOverride(analysis, mapping, next, clusterHeights, filamentHeight, id)
    if (o) next = withOverride(next, id, { ...next[id], ...o, removed: false })
  }
  return next
}

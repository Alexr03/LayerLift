import { useState } from 'react'
import type { Analysis, RegionOverride } from '../api'
import { fmt } from '../palettes'

interface Props {
  analysis: Analysis
  overrides: Record<number, RegionOverride>
  mmPerPx: number
  standsOut: (region: number) => boolean // its filament differs from what merging would give it
  onSelect: (regions: number[]) => void
  onMerge: (regions: number[]) => void
  onRemove: (regions: number[]) => void
}

/**
 * Find every area below a size that still stands out from its surroundings, and merge it in, remove it,
 * or select it for a closer look.
 */
export default function SpeckCleanup({ analysis, overrides, mmPerPx, standsOut, onSelect, onMerge, onRemove }: Props) {
  const [limit, setLimit] = useState(1) // mm²
  const px = limit / Math.max(mmPerPx * mmPerPx, 1e-9)
  const small = analysis.regions.filter((r) => r.area < px && !overrides[r.id]?.removed && standsOut(r.id)).map((r) => r.id)
  const n = small.length

  return (
    <section className="panel" aria-labelledby="specks-h">
      <div className="panel-head">
        <h2 id="specks-h">Small areas</h2>
        <span className="count">{n === 1 ? '1 area' : `${n} areas`}</span>
      </div>
      <label className="speck-range">
        <span>Smaller than</span>
        <input type="range" min={0.1} max={20} step={0.1} value={limit} onChange={(e) => setLimit(Number(e.target.value))} aria-label="Size limit in square millimetres" />
        <em>{fmt(limit)} mm²</em>
      </label>
      <p className="hint">
        About a {fmt(Math.sqrt(limit))} mm square at this print size. For specks big enough to print but not worth their own colour.
      </p>
      <div className="row wrap">
        <button type="button" className="ghost" disabled={!n} onClick={() => onSelect(small)}>
          Select
        </button>
        <button type="button" className="ghost" disabled={!n} onClick={() => onMerge(small)} title="Each takes the filament of the neighbour sharing the longest edge">
          Merge into surroundings
        </button>
        <button type="button" className="ghost danger" disabled={!n} onClick={() => onRemove(small)}>
          Remove
        </button>
      </div>
    </section>
  )
}

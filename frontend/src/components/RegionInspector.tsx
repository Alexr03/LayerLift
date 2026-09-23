import type { Analysis, Filament, RegionOverride } from '../api'
import { fmt, inkOn } from '../palettes'

interface Props {
  analysis: Analysis
  regions: number[] // selected region ids, at least one
  filaments: Filament[]
  mapping: number[]
  overrides: Record<number, RegionOverride>
  clusterHeights: Record<number, number>
  regionTop: (number | null)[]
  mmPerPx: number
  heightsLocked: boolean
  canMerge: boolean
  layer: number
  onFilament: (filament: number | null) => void // null = follow the colour's filament
  onHeight: (h: number | null) => void
  onClusterFilament: (filament: number) => void
  onClusterHeight: (h: number | null) => void
  onRemove: (removed: boolean, wholeColour: boolean) => void
  onMerge: () => void
  onClose: () => void
}

/** The one value all items share, or undefined when they differ. */
function common<T>(items: T[]): T | undefined {
  return items.every((x) => x === items[0]) ? items[0] : undefined
}

export default function RegionInspector(p: Props) {
  const regions = p.regions.map((id) => p.analysis.regions[id])
  const single = regions.length === 1 ? regions[0] : null
  const cluster = single ? p.analysis.clusters[single.cluster] : null
  const filamentOf = (id: number) => p.overrides[id]?.filament ?? p.mapping[p.analysis.regions[id].cluster]
  const current = common(p.regions.map(filamentOf))
  const siblings = single ? p.analysis.regions.filter((x) => x.cluster === single.cluster).length : 0
  const isRim = single != null && p.analysis.outline_region === single.id
  const removedCount = p.regions.filter((id) => p.overrides[id]?.removed).length
  const allRemoved = removedCount === p.regions.length
  const anyFilamentOverride = p.regions.some((id) => p.overrides[id]?.filament != null)
  const ownHeight = common(p.regions.map((id) => p.overrides[id]?.height_mm ?? null))
  const planned = common(p.regions.map((id) => p.regionTop[id]))
  const px = regions.reduce((a, r) => a + r.area, 0)
  const mm2 = px * p.mmPerPx * p.mmPerPx
  const these = single ? 'this area' : `these ${regions.length} areas`

  return (
    <section className="panel inspector" aria-labelledby="region-h">
      <div className="panel-head">
        <h2 id="region-h">
          {cluster && <span className="chip" style={{ background: cluster.hex }} />} {single ? (isRim ? 'Outer rim' : 'Region') : `${regions.length} areas`}
        </h2>
        <button type="button" className="icon" onClick={p.onClose} aria-label="Clear the selection">
          ×
        </button>
      </div>
      <p className="hint">
        {single
          ? `${siblings === 1 ? 'The only area in this colour' : `One of ${siblings} areas in this colour`}, `
          : `${new Set(regions.map((r) => r.cluster)).size} colours, `}
        {mm2 >= 0.05 ? `about ${fmt(mm2)} mm²` : `${px.toLocaleString()} px`}
        {isRim && '. Rims often look best at the base colour height.'}
        {single && '. Shift-click to select more.'}
      </p>

      {allRemoved ? (
        <>
          <p className="hint">Removed from the print: {single ? 'this area is' : 'these areas are'} left empty, like the background.</p>
          <div className="row wrap">
            <button type="button" className="ghost" onClick={() => p.onRemove(false, false)}>
              Restore {these}
            </button>
            {single && siblings > 1 && (
              <button type="button" className="ghost" onClick={() => p.onRemove(false, true)}>
                Restore all {siblings} areas of this colour
              </button>
            )}
          </div>
        </>
      ) : (
        <>
          {removedCount > 0 && (
            <p className="hint">
              {removedCount} of these {removedCount === 1 ? 'is' : 'are'} removed.{' '}
              <button type="button" className="link" onClick={() => p.onRemove(false, false)}>
                Restore
              </button>
            </p>
          )}
          <div className="field-label">Filament</div>
          <div className="swatch-row" role="radiogroup" aria-label={`Filament for ${these}`}>
            {p.filaments.map((f, i) => (
              <button
                key={i}
                type="button"
                role="radio"
                aria-checked={current === i}
                className={current === i ? 'swatch on' : 'swatch'}
                style={{ background: f.hex, color: inkOn(f.hex) }}
                onClick={() => p.onFilament(i)}
                title={f.name}
              >
                {i + 1}
              </button>
            ))}
          </div>
          <div className="row wrap">
            {single && siblings > 1 && current != null && (
              <button type="button" className="ghost" onClick={() => p.onClusterFilament(current)}>
                Use for all {siblings} areas of this colour
              </button>
            )}
            {anyFilamentOverride && (
              <button type="button" className="ghost" onClick={() => p.onFilament(null)}>
                Follow colour
              </button>
            )}
            <button
              type="button"
              className="ghost"
              onClick={p.onMerge}
              disabled={!p.canMerge}
              title="Take the filament of the neighbour sharing the longest edge"
            >
              Merge into surroundings
            </button>
          </div>

          <div className="field-label">Top height</div>
          {p.heightsLocked ? (
            <p className="hint">The stacked strategy sets heights by filament order{planned != null ? ` (${fmt(planned)} mm here)` : ''}.</p>
          ) : (
            <>
              <div className="row">
                <label className="inline-num">
                  <input
                    type="number"
                    step={p.layer}
                    min={p.layer}
                    max={50}
                    placeholder={planned != null ? fmt(planned) : 'mixed'}
                    value={ownHeight ?? ''}
                    onChange={(e) => p.onHeight(e.target.value === '' ? null : Number(e.target.value))}
                    aria-label={`Height for ${these} in millimetres`}
                  />
                  <span>mm, {single ? 'this area' : 'these areas'}</span>
                </label>
                {single && (
                  <label className="inline-num">
                    <input
                      type="number"
                      step={p.layer}
                      min={p.layer}
                      max={50}
                      placeholder="—"
                      value={p.clusterHeights[single.cluster] ?? ''}
                      onChange={(e) => p.onClusterHeight(e.target.value === '' ? null : Number(e.target.value))}
                      aria-label="Height for every area of this colour in millimetres"
                    />
                    <span>mm, whole colour</span>
                  </label>
                )}
              </div>
              <p className="hint">Leave empty to use the filament's height{planned != null ? ` (${fmt(planned)} mm now)` : ''}.</p>
            </>
          )}

          <div className="field-label">Remove</div>
          <div className="row wrap">
            <button type="button" className="ghost danger" onClick={() => p.onRemove(true, false)} title="Delete key">
              Remove {these}
            </button>
            {single && siblings > 1 && (
              <button type="button" className="ghost danger" onClick={() => p.onRemove(true, true)}>
                Remove all {siblings} areas of this colour
              </button>
            )}
          </div>
        </>
      )}
    </section>
  )
}

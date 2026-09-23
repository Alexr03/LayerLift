import type { Analysis, Filament, RegionOverride } from '../api'
import { fmt, inkOn } from '../palettes'

interface Props {
  analysis: Analysis
  region: number
  filaments: Filament[]
  mapping: number[]
  override: RegionOverride | undefined
  clusterHeight: number | undefined
  plannedHeight: number
  layer: number
  onRegion: (o: RegionOverride | null) => void
  onClusterFilament: (filament: number) => void
  onClusterHeight: (h: number | null) => void
  onClose: () => void
}

export default function RegionInspector(p: Props) {
  const r = p.analysis.regions[p.region]
  const cluster = p.analysis.clusters[r.cluster]
  const current = p.override?.filament ?? p.mapping[r.cluster]
  const siblings = p.analysis.regions.filter((x) => x.cluster === r.cluster).length
  const isRim = p.analysis.outline_region === r.id

  return (
    <section className="panel inspector" aria-labelledby="region-h">
      <div className="panel-head">
        <h2 id="region-h">
          <span className="chip" style={{ background: cluster.hex }} /> {isRim ? 'Outer rim' : 'Region'}
        </h2>
        <button type="button" className="icon" onClick={p.onClose} aria-label="Close region settings">
          ×
        </button>
      </div>
      <p className="hint">
        {siblings === 1 ? 'The only area in this colour' : `One of ${siblings} areas in this colour`}, {r.area.toLocaleString()} px
        {isRim && '. Rims often look best at the base colour height.'}
      </p>

      <div className="field-label">Filament</div>
      <div className="swatch-row" role="radiogroup" aria-label="Filament for this region">
        {p.filaments.map((f, i) => (
          <button
            key={i}
            type="button"
            role="radio"
            aria-checked={current === i}
            className={current === i ? 'swatch on' : 'swatch'}
            style={{ background: f.hex, color: inkOn(f.hex) }}
            onClick={() => p.onRegion({ ...p.override, filament: i })}
            title={f.name}
          >
            {i + 1}
          </button>
        ))}
      </div>
      <div className="row wrap">
        {siblings > 1 && (
          <button type="button" className="ghost" onClick={() => p.onClusterFilament(current)}>
            Use for all {siblings} areas of this colour
          </button>
        )}
        {p.override?.filament != null && (
          <button type="button" className="ghost" onClick={() => p.onRegion({ ...p.override, filament: null })}>
            Follow colour
          </button>
        )}
      </div>

      <div className="field-label">Top height</div>
      <div className="row">
        <label className="inline-num">
          <input
            type="number"
            step={p.layer}
            min={p.layer}
            max={50}
            placeholder={fmt(p.plannedHeight)}
            value={p.override?.height_mm ?? ''}
            onChange={(e) => p.onRegion({ ...p.override, height_mm: e.target.value === '' ? null : Number(e.target.value) })}
            aria-label="Height for this region in millimetres"
          />
          <span>mm, this area</span>
        </label>
        <label className="inline-num">
          <input
            type="number"
            step={p.layer}
            min={p.layer}
            max={50}
            placeholder="—"
            value={p.clusterHeight ?? ''}
            onChange={(e) => p.onClusterHeight(e.target.value === '' ? null : Number(e.target.value))}
            aria-label="Height for every area of this colour in millimetres"
          />
          <span>mm, whole colour</span>
        </label>
      </div>
      <p className="hint">Leave empty to use the filament's height ({fmt(p.plannedHeight)} mm now).</p>
    </section>
  )
}

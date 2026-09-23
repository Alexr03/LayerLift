import type { Analysis, Filament } from '../api'
import { inkOn } from '../palettes'

interface Props {
  analysis: Analysis
  filaments: Filament[]
  mapping: number[]
  locked: Record<number, number>
  onAssign: (cluster: number, filament: number | null) => void
}

export default function ColourList({ analysis, filaments, mapping, locked, onAssign }: Props) {
  return (
    <section className="panel" aria-labelledby="colours-h">
      <div className="panel-head">
        <h2 id="colours-h">Detected colours</h2>
        <span className="count">{analysis.clusters.length}</span>
      </div>
      <p className="hint">Suggested filaments keep neighbouring colours apart. Pick one to pin it; the rest re-balance.</p>
      <ul className="clusters">
        {analysis.clusters.map((c) => {
          const f = filaments[mapping[c.id]]
          const pinned = c.id in locked
          return (
            <li key={c.id}>
              <span className="chip" style={{ background: c.hex }} title={c.hex} />
              <span className="share">{c.share >= 0.01 ? `${Math.round(c.share * 100)}%` : '<1%'}</span>
              <span className="to" aria-hidden>
                →
              </span>
              <select
                value={mapping[c.id] ?? 0}
                onChange={(e) => onAssign(c.id, Number(e.target.value))}
                style={f ? { background: f.hex, color: inkOn(f.hex) } : undefined}
                aria-label={`Filament for colour ${c.hex}`}
              >
                {filaments.map((fl, i) => (
                  <option key={i} value={i}>
                    {i + 1}. {fl.name}
                  </option>
                ))}
              </select>
              {pinned ? (
                <button type="button" className="icon pin" onClick={() => onAssign(c.id, null)} title="Pinned by you. Click to let LayerLift choose." aria-label={`Unpin colour ${c.hex}`}>
                  ●
                </button>
              ) : (
                <span className="icon pin off" title="Chosen automatically" aria-hidden>
                  ○
                </span>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}

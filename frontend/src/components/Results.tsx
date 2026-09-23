import type { BuildResult } from '../api'
import { fmt } from '../palettes'
import { when } from '../pb'

interface Props {
  result: BuildResult
  stale: boolean
}

export default function Results({ result, stale }: Props) {
  const [w, h, d] = result.size_mm
  return (
    <section className={stale ? 'panel results stale' : 'panel results'} aria-labelledby="results-h">
      <div className="panel-head">
        <h2 id="results-h">Print</h2>
        {stale && <span className="badge">Settings changed, build again</span>}
      </div>
      <dl className="facts">
        <div>
          <dt>Size</dt>
          <dd>
            {w.toFixed(1)} × {h.toFixed(1)} × {fmt(d)} mm
          </dd>
        </div>
        <div>
          <dt>Filament</dt>
          <dd>{result.total_grams.toFixed(1)} g</dd>
        </div>
        <div>
          <dt>Changes</dt>
          <dd>{result.filament_changes}</dd>
        </div>
      </dl>
      <table className="parts">
        <thead>
          <tr>
            <th scope="col">Slot</th>
            <th scope="col">Filament</th>
            <th scope="col" className="r">
              Top
            </th>
            <th scope="col" className="r">
              Grams
            </th>
          </tr>
        </thead>
        <tbody>
          {result.parts.map((p) => (
            <tr key={p.slot}>
              <td>
                <span className="chip" style={{ background: p.hex }} /> {p.slot}
              </td>
              <td>{p.name}</td>
              <td className="r">{fmt(p.z_max)} mm</td>
              <td className="r">{p.grams.toFixed(1)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {result.warnings.length > 0 && (
        <ul className="warnings">
          {result.warnings.map((warn, i) => (
            <li key={i}>{warn.message}</li>
          ))}
        </ul>
      )}
      <div className="downloads">
        <a className="button primary" href={result.downloads['3mf']} download>
          Download 3MF for OrcaSlicer
        </a>
        <a className="button ghost" href={result.downloads['stl-zip']} download>
          STL files (zip)
        </a>
      </div>
      <p className="hint">
        The 3MF opens as one object with a part per filament, already on the slots listed above.{' '}
        {result.saved_until ? (
          <>
            A copy is saved in <a href="#/builds">My builds</a> until {when(result.saved_until)}.
          </>
        ) : (
          'Downloads expire about an hour after the build.'
        )}
      </p>
    </section>
  )
}

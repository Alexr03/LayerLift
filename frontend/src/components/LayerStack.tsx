import type { Filament } from '../api'
import type { PlanBand } from '../plan'
import { fmt } from '../palettes'

interface Props {
  bands: PlanBand[]
  filaments: Filament[]
  layer: number
  base: number
  top: number
  changes: number
  confirmedChanges: number | null
}

/**
 * Side view of the print as a slicer would see it: one column per filament, one tick per
 * layer. Shows at a glance where colours overlap in height, which is what costs changes.
 */
export default function LayerStack({ bands, filaments, layer, base, top, changes, confirmedChanges }: Props) {
  const used = [...new Set(bands.map((b) => b.filament))].sort((a, b) => a - b)
  const layers = Math.max(1, Math.round(top / layer))
  const H = 180
  const colW = 30
  const gap = 8
  const left = 34
  const W = left + used.length * (colW + gap)
  const y = (z: number) => H - (z / Math.max(top, layer)) * (H - 8)
  const ticks: number[] = []
  const step = top > 6 ? 1 : 0.5
  for (let z = 0; z <= top + 1e-9; z += step) ticks.push(Math.round(z * 100) / 100)

  return (
    <section className="panel" aria-labelledby="stack-h">
      <div className="panel-head">
        <h2 id="stack-h">Layer stack</h2>
        <span className="count" title="Estimated filament changes with the best colour order per layer">
          {confirmedChanges ?? changes} changes
        </span>
      </div>
      <svg className="stack" viewBox={`0 0 ${W} ${H + 18}`} role="img" aria-label={`Colour heights over ${layers} layers, about ${changes} filament changes`}>
        {Array.from({ length: layers + 1 }, (_, i) => (
          <line key={i} x1={left - 4} x2={W} y1={y(i * layer)} y2={y(i * layer)} className={i * layer === base ? 'grid base' : 'grid'} />
        ))}
        {ticks.map((z) => (
          <text key={z} x={left - 8} y={y(z) + 3} className="tick">
            {fmt(z)}
          </text>
        ))}
        {used.map((fil, col) => {
          const x = left + col * (colW + gap) + gap / 2
          return (
            <g key={fil}>
              {bands
                .filter((b) => b.filament === fil)
                .map((b, i) => (
                  <rect key={i} x={x} width={colW} y={y(b.z1)} height={Math.max(1, y(b.z0) - y(b.z1))} fill={filaments[fil]?.hex ?? '#888'} className="band">
                    <title>{`${filaments[fil]?.name}: ${fmt(b.z0)}–${fmt(b.z1)} mm`}</title>
                  </rect>
                ))}
              <text x={x + colW / 2} y={H + 14} className="col-label">
                {fil + 1}
              </text>
            </g>
          )
        })}
      </svg>
      <p className="hint">
        {fmt(top)} mm tall, {layers} layers at {fmt(layer)} mm. The dashed line is the top of the {fmt(base)} mm base.
      </p>
    </section>
  )
}

import { fmt } from '../palettes'

interface Props {
  height: number // top of the model, mm
  layer: number // layer height, mm
  value: number | null // cut height, mm; null shows the whole model
  onChange: (z: number | null) => void
}

/**
 * The slicer's layer slider, on the plate's right edge: drag it down to cut the model at a layer
 * and see what prints there. At the top it shows the whole model.
 */
export default function LayerScrubber({ height, layer, value, onChange }: Props) {
  if (!(height > 0) || !(layer > 0)) return null
  const total = Math.max(1, Math.round(height / layer))
  const current = value == null ? total : Math.max(1, Math.min(total, Math.round(value / layer)))
  const pct = (1 - current / total) * 100
  return (
    <div className="layer-scrub" aria-label="Layer slider">
      <span className="ls-end">{total}</span>
      <div className="ls-track">
        <input
          type="range"
          min={1}
          max={total}
          step={1}
          value={current}
          aria-label="Show the model up to this layer"
          aria-valuetext={`Layer ${current} of ${total}, ${fmt(current * layer)} mm`}
          onChange={(e) => {
            const n = Number(e.target.value)
            onChange(n >= total ? null : n * layer)
          }}
          onDoubleClick={() => onChange(null)}
        />
        {value != null && (
          <div className="ls-badge" style={{ top: `${pct}%` }}>
            Layer {current}
            <span>{fmt(current * layer)} mm</span>
          </div>
        )}
      </div>
      <span className="ls-end">1</span>
    </div>
  )
}

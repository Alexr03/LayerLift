import type { BuildSettings, Filament, Strategy } from '../api'

const STRATEGIES: { value: Strategy; label: string; hint: string }[] = [
  { value: 'detailed', label: 'Detailed', hint: 'Every colour is a solid column at its own height. Most flexible, most filament changes.' },
  {
    value: 'compact',
    label: 'Compact',
    hint: 'Same columns, one layer between heights and nothing starts from the bed. Far fewer changes, a flatter relief.',
  },
  {
    value: 'stacked',
    label: 'Stacked',
    hint: 'One colour per layer, stacked in height order: only one change per colour. Sides show stripes, and per-area heights are ignored.',
  },
]

interface Props {
  s: BuildSettings
  filaments: Filament[]
  onChange: (patch: Partial<BuildSettings>) => void
}

function Num(props: { label: string; value: number; step: number; min: number; max: number; unit: string; onChange: (v: number) => void }) {
  return (
    <label className="num">
      <span>{props.label}</span>
      <span className="num-input">
        <input
          type="number"
          value={props.value}
          step={props.step}
          min={props.min}
          max={props.max}
          onChange={(e) => e.target.value !== '' && props.onChange(Number(e.target.value))}
        />
        <em>{props.unit}</em>
      </span>
    </label>
  )
}

export default function SizeDepth({ s, filaments, onChange }: Props) {
  return (
    <section className="panel" aria-labelledby="size-h">
      <div className="panel-head">
        <h2 id="size-h">Size and depth</h2>
      </div>
      <div className="grid2">
        <Num label="Size" value={s.width_mm} step={1} min={5} max={500} unit="mm" onChange={(v) => onChange({ width_mm: v })} />
        <label className="num">
          <span>Measured along</span>
          <select value={s.size_mode} onChange={(e) => onChange({ size_mode: e.target.value as BuildSettings['size_mode'] })}>
            <option value="width">Width</option>
            <option value="height">Height</option>
            <option value="longest">Longest side</option>
          </select>
        </label>
        <Num label="Base" value={s.base_mm} step={s.layer_mm} min={0} max={20} unit="mm" onChange={(v) => onChange({ base_mm: v })} />
        <label className="num">
          <span>Base colour</span>
          <select value={s.base_filament ?? ''} onChange={(e) => onChange({ base_filament: e.target.value === '' ? null : Number(e.target.value) })}>
            <option value="">Automatic</option>
            {filaments.map((f, i) => (
              <option key={i} value={i}>
                {i + 1}. {f.name}
              </option>
            ))}
          </select>
        </label>
        <Num label="Layer height" value={s.layer_mm} step={0.04} min={0.04} max={0.6} unit="mm" onChange={(v) => onChange({ layer_mm: v })} />
        <Num label="Nozzle" value={s.nozzle_mm} step={0.2} min={0.2} max={1.2} unit="mm" onChange={(v) => onChange({ nozzle_mm: v })} />
      </div>

      <fieldset className="radio-row">
        <legend>Relief strategy</legend>
        {STRATEGIES.map((o) => (
          <label key={o.value}>
            <input type="radio" name="strategy" checked={s.strategy === o.value} onChange={() => onChange({ strategy: o.value })} />
            {o.label}
          </label>
        ))}
      </fieldset>
      <p className="hint">{STRATEGIES.find((o) => o.value === s.strategy)?.hint}</p>

      <fieldset className="radio-row">
        <legend>{s.strategy === 'stacked' ? 'Colour order (bottom to top)' : 'Colour heights'}</legend>
        <label>
          <input type="radio" checked={s.height_mode === 'manual'} onChange={() => onChange({ height_mode: 'manual' })} />
          Set per filament
        </label>
        <label>
          <input type="radio" checked={s.height_mode === 'by_luminance' && s.lighter_taller} onChange={() => onChange({ height_mode: 'by_luminance', lighter_taller: true })} />
          Lighter is taller
        </label>
        <label>
          <input type="radio" checked={s.height_mode === 'by_luminance' && !s.lighter_taller} onChange={() => onChange({ height_mode: 'by_luminance', lighter_taller: false })} />
          Darker is taller
        </label>
      </fieldset>
      <label className="check">
        <input type="checkbox" checked={s.mirror} onChange={(e) => onChange({ mirror: e.target.checked })} />
        Mirror (for printing face down)
      </label>
    </section>
  )
}

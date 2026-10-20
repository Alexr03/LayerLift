import { Ban, Copy, Paintbrush, Plus, RotateCw, Trash2, Upload } from 'lucide-react'
import NumberField from '../NumberField'
import { useRef, useState } from 'react'
import { BUILTIN_ICONS, builtinIcon, svgIcon } from '../../gridfinity/icons'
import { binFootprint, binHeight } from '../../gridfinity/layout'
import { DEFAULT_GRID, type GridSpec } from '../../gridfinity/spec'
import { type BinDesign, type GfFilament, type LabelIcon, compartments } from '../../gridfinity/types'
import { fmt, inkOn } from '../../palettes'

interface Props {
  design: BinDesign // the first selected bin; the others take the same changes
  count: number // bins selected
  standalone?: boolean // a bin made on its own: no duplicate, delete or style-all
  grid?: GridSpec // the baseplate's cell and height unit
  filaments: GfFilament[]
  volume: number | null // mm³ of the built bin, when known
  onChange: (patch: Partial<BinDesign>, key?: string) => void
  onApplyToAll: () => void
  onDuplicate: () => void
  onRotate: () => void
  onDelete: () => void
  onError: (message: string) => void
}

function Num({
  label,
  value,
  min,
  max,
  step = 1,
  unit,
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  step?: number
  unit?: string
  onChange: (v: number) => void
}) {
  return (
    <label className="num">
      <span>{label}</span>
      <span className="num-input">
        <NumberField value={value} min={min} max={max} step={step} onChange={onChange} />
        {unit && <em>{unit}</em>}
      </span>
    </label>
  )
}

function FilamentPick({ label, value, filaments, onChange }: { label: string; value: number; filaments: GfFilament[]; onChange: (i: number) => void }) {
  return (
    <fieldset className="radio-row gf-swatches">
      <legend>{label}</legend>
      {filaments.map((f, i) => (
        <button
          key={i}
          type="button"
          className={value === i ? 'swatch on' : 'swatch'}
          style={{ background: f.hex, color: inkOn(f.hex) }}
          aria-pressed={value === i}
          title={`Slot ${i + 1}: ${f.name}`}
          onClick={() => onChange(i)}
        >
          {i + 1}
        </button>
      ))}
      <span className="hint">
        Slot {value + 1}, {filaments[value]?.name}
      </span>
    </fieldset>
  )
}

/** Settings of the selected bin. */
export default function BinEditor({ design: b, count, standalone = false, grid = DEFAULT_GRID, filaments, volume, onChange, onApplyToAll, onDuplicate, onRotate, onDelete, onError }: Props) {
  const many = count > 1
  const [iconFor, setIconFor] = useState<number | null>(null)
  const upload = useRef<HTMLInputElement>(null)
  const cols = b.divX + 1
  const rows = b.divY + 1
  const n = compartments(b)
  const [fx, fy] = binFootprint(b, grid)
  const oneColour = filaments.length === 1 || b.labelFilament === b.body // the label can't differ in colour

  const setLabel = (i: number, text: string) => {
    const labels = Array.from({ length: n }, (_, k) => b.labels[k] ?? '')
    labels[i] = text
    onChange({ labels }, `label-${i}`)
  }
  const setIcon = (i: number, icon: LabelIcon | null) => {
    const icons = Array.from({ length: n }, (_, k) => b.icons[k] ?? null)
    icons[i] = icon
    onChange({ icons })
    setIconFor(null)
  }

  const onSvg = async (file: File | undefined) => {
    if (!file || iconFor == null) return
    try {
      setIcon(iconFor, await svgIcon(file))
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Could not read that SVG.')
    }
  }

  // Label inputs laid out like the bin seen from above: back row at the top.
  const labelGrid = []
  for (let r = rows - 1; r >= 0; r--)
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c
      labelGrid.push(
        <div key={i} className="gf-label-cell">
          <input
            value={b.labels[i] ?? ''}
            maxLength={40}
            placeholder={n > 1 ? `Label ${i + 1}` : 'Label'}
            aria-label={`Label for compartment ${i + 1}`}
            onChange={(e) => setLabel(i, e.target.value)}
          />
          <button
            type="button"
            className={b.icons[i] ? 'icon gf-icon-btn has' : 'icon gf-icon-btn'}
            title={b.icons[i] ? `Icon: ${b.icons[i]!.name}` : 'Add an icon'}
            aria-label="Choose an icon"
            aria-expanded={iconFor === i}
            onClick={() => setIconFor(iconFor === i ? null : i)}
          >
            {b.icons[i] ? <IconPreview icon={b.icons[i]!} /> : <Plus size={15} />}
          </button>
        </div>,
      )
    }

  return (
    <section className="panel" aria-labelledby="bin-h">
      <div className="panel-head">
        <h2 id="bin-h">{many ? `${count} bins` : 'Bin'}</h2>
        <span className="count">{many ? 'Changes apply to all' : `${b.w}×${b.d}×${b.h}`}</span>
      </div>
      {!many && (
        <p className="hint">
          {fmt(fx)} × {fmt(fy)} × {fmt(binHeight(b, grid))} mm{volume ? ` · about ${Math.round((volume / 1000) * 1.24)} g of PLA` : ''}
        </p>
      )}

      <div className="grid3">
        <Num label="Width" value={b.w} min={1} max={10} unit="cells" onChange={(w) => onChange({ w })} />
        <Num label="Depth" value={b.d} min={1} max={10} unit="cells" onChange={(d) => onChange({ d })} />
        <Num label={`Height (${fmt(b.h * grid.unit)} mm)`} value={b.h} min={2} max={20} unit="u" onChange={(h) => onChange({ h })} />
      </div>
      <label className="check">
        <input type="checkbox" checked={b.lip} onChange={(e) => onChange({ lip: e.target.checked })} />
        Stacking lip (bins stack on top)
      </label>

      <h3 className="gf-sub">Compartments</h3>
      <div className="grid2">
        <Num label="Across" value={cols} min={1} max={13} onChange={(v) => onChange({ divX: v - 1 })} />
        <Num label="Front to back" value={rows} min={1} max={13} onChange={(v) => onChange({ divY: v - 1 })} />
      </div>
      <label className="check">
        <input type="checkbox" checked={b.scoop > 0} onChange={(e) => onChange({ scoop: e.target.checked ? 10 : 0 })} />
        Finger scoop at the front
      </label>
      {b.scoop > 0 && <Num label="Scoop radius" value={b.scoop} min={2} max={20} step={0.5} unit="mm" onChange={(scoop) => onChange({ scoop }, 'scoop')} />}

      <h3 className="gf-sub">Labels</h3>
      <div className="grid2">
        <label className="num">
          <span>Label tab</span>
          <select value={b.tab} onChange={(e) => onChange({ tab: e.target.value as BinDesign['tab'] })}>
            <option value="full">Full width</option>
            <option value="left">Left</option>
            <option value="center">Centre</option>
            <option value="right">Right</option>
            <option value="none">No tab</option>
          </select>
        </label>
        {b.tab !== 'none' && b.tab !== 'full' ? (
          <Num label="Tab width" value={b.tabWidth} min={8} max={420} unit="mm" onChange={(tabWidth) => onChange({ tabWidth }, 'tabw')} />
        ) : (
          <label className="num">
            <span>Text</span>
            <select value={b.labelStyle} onChange={(e) => onChange({ labelStyle: e.target.value as BinDesign['labelStyle'] })} disabled={b.tab === 'none'}>
              <option value="inlay">{oneColour ? 'Engraved' : 'Inlaid, flush'}</option>
              <option value="raised">Raised</option>
            </select>
          </label>
        )}
      </div>
      {b.tab !== 'none' && (
        <>
          {b.tab !== 'full' && (
            <label className="num">
              <span>Text</span>
              <select value={b.labelStyle} onChange={(e) => onChange({ labelStyle: e.target.value as BinDesign['labelStyle'] })}>
                <option value="inlay">{oneColour ? 'Engraved' : 'Inlaid, flush'}</option>
                <option value="raised">Raised</option>
              </select>
            </label>
          )}
          {many ? (
            <p className="hint">Label text is set per bin.</p>
          ) : (
            <div className="gf-labels" style={{ gridTemplateColumns: `repeat(${Math.min(cols, 3)}, minmax(0, 1fr))` }}>
              {labelGrid}
            </div>
          )}
          {iconFor != null && (
            <div className="gf-icon-picker" role="dialog" aria-label="Icon">
              {BUILTIN_ICONS.map((ic) => {
                const icon = builtinIcon(ic.id)!
                return (
                  <button key={ic.id} type="button" className="ghost" title={ic.label} onClick={() => setIcon(iconFor, icon)}>
                    <IconPreview icon={icon} />
                  </button>
                )
              })}
              <button type="button" className="ghost" onClick={() => upload.current?.click()}>
                <Upload size={14} /> SVG…
              </button>
              <button type="button" className="ghost" onClick={() => setIcon(iconFor, null)}>
                <Ban size={14} /> None
              </button>
              <input ref={upload} type="file" accept="image/svg+xml,.svg" hidden onChange={(e) => onSvg(e.target.files?.[0])} />
            </div>
          )}
          <div className="grid2">
            <Num label="Text height (0 = fit)" value={b.labelSize} min={0} max={30} step={0.5} unit="mm" onChange={(labelSize) => onChange({ labelSize }, 'lsize')} />
            <Num label="Tab depth" value={b.tabDepth} min={4} max={20} step={0.5} unit="mm" onChange={(tabDepth) => onChange({ tabDepth }, 'tabd')} />
          </div>
          {filaments.length > 1 && <FilamentPick label="Label colour" value={b.labelFilament} filaments={filaments} onChange={(labelFilament) => onChange({ labelFilament })} />}
        </>
      )}

      <h3 className="gf-sub">Walls and base</h3>
      <div className="grid2">
        <label className="num">
          <span>Walls</span>
          <select
            value={b.pattern}
            onChange={(e) => {
              const pattern = e.target.value as BinDesign['pattern']
              onChange(pattern === 'hex' && b.wall < 1.6 ? { pattern, wall: 1.8 } : { pattern })
            }}
          >
            <option value="solid">Solid</option>
            <option value="hex">Hexagon cut-outs</option>
          </select>
        </label>
        <Num label="Wall thickness" value={b.wall} min={0.8} max={4} step={0.05} unit="mm" onChange={(wall) => onChange({ wall }, 'wall')} />
      </div>
      {b.pattern === 'hex' && (
        <>
          <div className="grid2">
            <Num label="Hexagon size" value={b.hexSize} min={3} max={20} step={0.5} unit="mm" onChange={(hexSize) => onChange({ hexSize }, 'hexs')} />
            <Num label="Between holes" value={b.hexRib} min={0.8} max={5} step={0.1} unit="mm" onChange={(hexRib) => onChange({ hexRib }, 'hexr')} />
          </div>
          {b.wall < 1.6 && <p className="hint danger">Walls under 1.6 mm get flimsy with holes in them.</p>}
        </>
      )}
      <div className="grid2">
        <label className="num">
          <span>Base</span>
          <select
            value={b.base}
            onChange={(e) => {
              const base = e.target.value as BinDesign['base']
              onChange(base === 'lite' ? { base, floor: Math.min(b.floor, 1), holes: 'none' } : { base, floor: Math.max(b.floor, 2.25) })
            }}
          >
            <option value="standard">Standard (solid feet)</option>
            <option value="lite">Lite (hollow feet)</option>
          </select>
        </label>
        <Num label="Floor" value={b.floor} min={0.8} max={6} step={0.05} unit="mm" onChange={(floor) => onChange({ floor }, 'floor')} />
      </div>
      {b.base === 'standard' && (
        <div className="grid2">
          <label className="num">
            <span>Holes underneath</span>
            <select value={b.holes} onChange={(e) => onChange({ holes: e.target.value as BinDesign['holes'] })}>
              <option value="none">None</option>
              <option value="magnets">Magnets (6 × 2 mm)</option>
              <option value="screws">Screws (M3)</option>
              <option value="both">Magnets and screws</option>
            </select>
          </label>
          {b.holes !== 'none' && (
            <label className="check gf-check-low">
              <input type="checkbox" checked={b.holesCorners} onChange={(e) => onChange({ holesCorners: e.target.checked })} />
              Outer corners only
            </label>
          )}
        </div>
      )}
      {filaments.length > 1 && <FilamentPick label="Bin colour" value={b.body} filaments={filaments} onChange={(body) => onChange({ body })} />}

      <div className="row wrap gf-bin-actions">
        <button type="button" className="ghost" onClick={onRotate} title="Rotate a quarter turn (R)">
          <RotateCw size={15} /> Rotate
        </button>
        {!standalone && (
          <button type="button" className="ghost" onClick={onDuplicate} title="Duplicate (Ctrl+D)">
            <Copy size={15} /> Duplicate
          </button>
        )}
        {!many && !standalone && (
          <button type="button" className="ghost" onClick={onApplyToAll} title="Walls, base, holes, lip, tab style and colours; not size or labels">
            <Paintbrush size={15} /> Style all bins like this
          </button>
        )}
        {!standalone && (
          <button type="button" className="ghost danger" onClick={onDelete} title="Delete (Del)">
            <Trash2 size={15} /> Delete
          </button>
        )}
      </div>
    </section>
  )
}

export function IconPreview({ icon, size = 18 }: { icon: LabelIcon; size?: number }) {
  const d = icon.polys.map((p) => `M${p.map(([x, y]) => `${x.toFixed(3)} ${(1 - y).toFixed(3)}`).join('L')}Z`).join('')
  return (
    <svg width={size} height={size} viewBox="-0.05 -0.05 1.1 1.1" aria-hidden>
      <path d={d} fill="currentColor" fillRule="nonzero" />
    </svg>
  )
}

import { Maximize2 } from 'lucide-react'
import { useState } from 'react'
import NumberField from '../NumberField'
import { usePrinters } from '../../printers'
import { type Grid, type Piece, cellsForBed, clipCount } from '../../gridfinity/layout'
import type { Drawer, GfFilament } from '../../gridfinity/types'
import { fmt } from '../../palettes'

interface Props {
  title: string // "Drawer", or "Baseplate" for a baseplate made on its own
  drawer: Drawer
  grid: Grid
  pieces: Piece[] | null
  filaments: GfFilament[]
  onChange: (patch: Partial<Drawer>, key?: string) => void
}

function Field({ label, value, min, max, step = 0.5, unit, onChange }: { label: string; value: number; min: number; max: number; step?: number; unit: string; onChange: (v: number) => void }) {
  return (
    <label className="num">
      <span>{label}</span>
      <span className="num-input">
        <NumberField value={value} min={min} max={max} step={step} onChange={onChange} />
        <em>{unit}</em>
      </span>
    </label>
  )
}

/** The grid: cell size and height unit, 42 × 7 mm for standard Gridfinity. */
export function GridFields({ drawer: d, onChange }: { drawer: Drawer; onChange: (patch: Partial<Drawer>, key?: string) => void }) {
  const standard = d.pitch === 42 && d.unit === 7
  return (
    <>
      <div className="grid2">
        <Field label="Cell size" value={d.pitch} min={20} max={100} step={0.5} unit="mm" onChange={(pitch) => onChange({ pitch }, 'pitch')} />
        <Field label="Height unit" value={d.unit} min={2} max={20} step={0.5} unit="mm" onChange={(unit) => onChange({ unit }, 'unit')} />
      </div>
      {!standard && (
        <p className="hint">
          Not standard Gridfinity (42 × 7 mm): these bins only fit this baseplate.{' '}
          <button type="button" className="link" onClick={() => onChange({ pitch: 42, unit: 7 })}>
            Reset
          </button>
        </p>
      )}
    </>
  )
}

/** The baseplate's size (in cells, or to fit a measured drawer), the printer's bed, and its style. */
export default function DrawerPanel({ title, drawer: d, grid, pieces, filaments, onChange }: Props) {
  const { printers } = usePrinters()
  const [customBed, setCustomBed] = useState(false)
  const match = printers.find((p) => p.bedX === d.bedX && p.bedY === d.bedY)
  const bedChoice = customBed || !match ? 'custom' : match.id
  const spareX = grid.padLeft + grid.padRight
  const spareY = grid.padFront + grid.padBack
  const cells = d.sizeMode === 'cells'
  const fitBed = () =>
    cells ? onChange({ cellsX: cellsForBed(d.bedX, d.pitch), cellsY: cellsForBed(d.bedY, d.pitch) }) : onChange({ width: d.bedX, depth: d.bedY })
  return (
    <section className="panel" aria-labelledby="drawer-h">
      <div className="panel-head">
        <h2 id="drawer-h">{title}</h2>
        <span className="row">
          <span className="count">
            {grid.nx} × {grid.ny}
          </span>
          <button
            type="button"
            className="icon"
            onClick={fitBed}
            aria-label="Fit the printer bed"
            title={
              cells
                ? `Fit the bed: ${cellsForBed(d.bedX, d.pitch)} × ${cellsForBed(d.bedY, d.pitch)} cells, one piece on ${d.bedX} × ${d.bedY} mm`
                : `Make the drawer the size of the bed, ${d.bedX} × ${d.bedY} mm`
            }
          >
            <Maximize2 size={15} />
          </button>
        </span>
      </div>
      <fieldset className="radio-row" aria-label="Size by">
        <label>
          <input type="radio" checked={cells} onChange={() => onChange({ sizeMode: 'cells', cellsX: grid.nx, cellsY: grid.ny })} />
          Cells
        </label>
        <label>
          <input type="radio" checked={!cells} onChange={() => onChange({ sizeMode: 'mm', width: d.width || grid.width, depth: d.depth || grid.depth })} />
          Fit a drawer
        </label>
      </fieldset>
      {cells ? (
        <div className="grid3">
          <Field label="Across" value={d.cellsX} min={1} max={40} step={1} unit="cells" onChange={(cellsX) => onChange({ cellsX }, 'cx')} />
          <Field label="Front to back" value={d.cellsY} min={1} max={40} step={1} unit="cells" onChange={(cellsY) => onChange({ cellsY }, 'cy')} />
          <Field label="Drawer height" value={d.height} min={0} max={1000} unit="mm" onChange={(height) => onChange({ height }, 'dh')} />
        </div>
      ) : (
        <>
          <div className="grid3">
            <Field label="Width" value={d.width} min={42} max={2000} unit="mm" onChange={(width) => onChange({ width }, 'dw')} />
            <Field label="Depth" value={d.depth} min={42} max={2000} unit="mm" onChange={(depth) => onChange({ depth }, 'dd')} />
            <Field label="Height" value={d.height} min={0} max={1000} unit="mm" onChange={(height) => onChange({ height }, 'dh')} />
          </div>
          <div className="grid2">
            <label className="num">
              <span>Spare room across</span>
              <select value={d.alignX} onChange={(e) => onChange({ alignX: e.target.value as Drawer['alignX'] })}>
                <option value="center">Both sides</option>
                <option value="start">On the right</option>
                <option value="end">On the left</option>
              </select>
            </label>
            <label className="num">
              <span>Front to back</span>
              <select value={d.alignY} onChange={(e) => onChange({ alignY: e.target.value as Drawer['alignY'] })}>
                <option value="center">Both ends</option>
                <option value="start">At the back</option>
                <option value="end">At the front</option>
              </select>
            </label>
          </div>
          <Field label="Clearance" value={d.clearance} min={0} max={5} unit="mm" onChange={(clearance) => onChange({ clearance }, 'dc')} />
        </>
      )}
      <p className="hint">
        {grid.nx * grid.ny} cells · {fmt(grid.width)} × {fmt(grid.depth)} mm
        {!cells && ` · ${fmt(spareX)} / ${fmt(spareY)} mm spare`}
        {d.height > 0 ? ` · bins to ${Math.floor((d.height - 1) / 7)}u` : ''}
      </p>

      <GridFields drawer={d} onChange={onChange} />

      <h3 className="gf-sub">Baseplate</h3>
      <div className="grid2">
        <label className="num">
          <span>Style</span>
          <select value={d.plate} onChange={(e) => onChange({ plate: e.target.value as Drawer['plate'] })}>
            <option value="thin">Thin (open grid)</option>
            <option value="solid">With a floor</option>
            <option value="magnets">Floor with magnet holes</option>
          </select>
        </label>
        {filaments.length > 1 && (
          <label className="num">
            <span>Colour</span>
            <select value={d.plateFilament} onChange={(e) => onChange({ plateFilament: Number(e.target.value) })}>
              {filaments.map((f, i) => (
                <option key={i} value={i}>
                  Slot {i + 1}: {f.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <label className="num">
        <span>Printer bed</span>
        <select
          value={bedChoice}
          onChange={(e) => {
            const v = e.target.value
            if (v === '__add') {
              window.location.hash = '#/printers'
              return
            }
            const p = printers.find((x) => x.id === v)
            setCustomBed(!p)
            if (p) onChange({ bedX: p.bedX, bedY: p.bedY })
          }}
        >
          {printers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} · {p.bedX} × {p.bedY}
            </option>
          ))}
          <option value="custom">Custom size</option>
          {!printers.length && <option value="__add">Add my printer…</option>}
        </select>
      </label>
      {bedChoice === 'custom' && (
        <div className="grid2">
          <Field label="Bed width" value={d.bedX} min={60} max={1000} unit="mm" onChange={(bedX) => onChange({ bedX }, 'bx')} />
          <Field label="Bed depth" value={d.bedY} min={60} max={1000} unit="mm" onChange={(bedY) => onChange({ bedY }, 'by')} />
        </div>
      )}
      <p className="hint">
        {pieces
          ? pieces.length === 1
            ? 'Prints in one piece.'
            : `Prints in ${pieces.length} pieces that butt together.`
          : 'One cell plus the margin is larger than the bed.'}
      </p>
      <label className="check">
        <input type="checkbox" checked={d.split} onChange={(e) => onChange({ split: e.target.checked })} />
        Split to fit the build plate
      </label>

      <h3 className="gf-sub">Connectors</h3>
      <fieldset className="radio-row" aria-label="Connectors">
        <label>
          <input type="radio" checked={d.connectors === 'none'} onChange={() => onChange({ connectors: 'none' })} />
          None
        </label>
        <label>
          <input type="radio" checked={d.connectors === 'clips'} onChange={() => onChange({ connectors: 'clips' })} />
          Clips
        </label>
      </fieldset>
      {d.connectors === 'clips' && (
        <>
          <fieldset className="gf-edges">
            <legend>Clip holes on outer edges</legend>
            {(['back', 'front', 'left', 'right'] as const).map((side) => (
              <label key={side} className="check">
                <input type="checkbox" checked={d.connectorEdges[side]} onChange={(e) => onChange({ connectorEdges: { ...d.connectorEdges, [side]: e.target.checked } })} />
                {side[0].toUpperCase() + side.slice(1)}
              </label>
            ))}
          </fieldset>
          <Field label="Extra clip play" value={d.clipTolerance} min={0} max={0.4} step={0.05} unit="mm" onChange={(clipTolerance) => onChange({ clipTolerance }, 'ctol')} />
          <p className="hint">
            {pieces ? `${clipCount(d, pieces)} clip${clipCount(d, pieces) === 1 ? '' : 's'} to print, included in the download.` : ''}
            {pieces && pieces.length === 1 && !Object.values(d.connectorEdges).some(Boolean) ? ' One piece and no outer edges picked: nothing to clip.' : ''}
          </p>
        </>
      )}
    </section>
  )
}

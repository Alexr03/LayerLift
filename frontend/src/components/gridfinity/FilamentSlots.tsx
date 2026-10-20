import { Plus, Printer, X } from 'lucide-react'
import type { GfFilament } from '../../gridfinity/types'
import { inkOn } from '../../palettes'
import { usePrinters } from '../../printers'

interface Props {
  filaments: GfFilament[]
  used: boolean[]
  onChange: (next: GfFilament[], reindex?: (number | null)[]) => void
}

/** The AMS slots the project's parts are assigned to. */
export default function FilamentSlots({ filaments, used, onChange }: Props) {
  const update = (i: number, patch: Partial<GfFilament>) => onChange(filaments.map((f, j) => (j === i ? { ...f, ...patch } : f)))
  const remove = (i: number) =>
    onChange(
      filaments.filter((_, j) => j !== i),
      filaments.map((_, j) => (j === i ? null : j > i ? j - 1 : j)),
    )
  const { active } = usePrinters()
  const fromPrinter = () => {
    const p = active?.filaments.map((f) => ({ ...f })) ?? []
    if (p.length) onChange(p.slice(0, 16), filaments.map((_, j) => (j < p.length ? j : 0)))
  }
  return (
    <section className="panel" aria-labelledby="gf-fil-h">
      <div className="panel-head">
        <h2 id="gf-fil-h">Filaments</h2>
        {active ? (
          <button type="button" className="ghost" onClick={fromPrinter} title={`Use the filaments loaded in ${active.name}`}>
            <Printer size={15} /> Load from printer
          </button>
        ) : (
          <a className="button ghost" href="#/printers">
            <Plus size={15} /> Add my printer
          </a>
        )}
      </div>
      <ul className="slots">
        {filaments.map((f, i) => (
          <li key={i} className={used[i] ? 'slot gf-slot' : 'slot gf-slot unused'}>
            <label className="spool" style={{ background: f.hex, color: inkOn(f.hex) }} title="Change colour">
              {i + 1}
              <input type="color" value={f.hex.toLowerCase()} onChange={(e) => update(i, { hex: e.target.value.toUpperCase() })} />
            </label>
            <input className="slot-name" value={f.name} maxLength={40} onChange={(e) => update(i, { name: e.target.value })} aria-label={`Slot ${i + 1} name`} />
            <div className="slot-actions">
              <button type="button" className="icon" onClick={() => remove(i)} disabled={filaments.length <= 1 || used[i]} title={used[i] ? 'In use' : 'Remove'} aria-label="Remove">
                <X size={14} />
              </button>
            </div>
          </li>
        ))}
      </ul>
      <button type="button" className="ghost" onClick={() => onChange([...filaments, { name: `Slot ${filaments.length + 1}`, hex: '#808080' }])} disabled={filaments.length >= 16}>
        <Plus size={15} /> Add a slot
      </button>
    </section>
  )
}

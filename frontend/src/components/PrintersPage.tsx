import { Check, Plus, Trash2, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { Me } from '../api'
import { inkOn } from '../palettes'
import { MODELS, type Printer, deletePrinter, newPrinter, savePrinter, setActivePrinter, usePrinters } from '../printers'
import NumberField from './NumberField'

interface Props {
  me: Me
  onSignIn: () => void
}

/** One printer, edited in place; changes save a moment after they stop. */
function PrinterCard({ printer, active, onError }: { printer: Printer; active: boolean; onError: (m: string) => void }) {
  const [p, setP] = useState(printer)
  const dirty = useRef(false)
  useEffect(() => {
    if (!dirty.current) setP(printer)
  }, [printer])
  useEffect(() => {
    if (!dirty.current) return
    const t = setTimeout(() => {
      dirty.current = false
      savePrinter(p).catch(() => onError(`Could not save ${p.name}.`))
    }, 600)
    return () => clearTimeout(t)
  }, [p, onError])

  const change = (patch: Partial<Printer>) => {
    dirty.current = true
    setP((cur) => ({ ...cur, ...patch }))
  }
  const setFilament = (i: number, patch: Partial<Printer['filaments'][number]>) => change({ filaments: p.filaments.map((f, j) => (j === i ? { ...f, ...patch } : f)) })

  return (
    <li className={active ? 'panel printer on' : 'panel printer'}>
      <div className="printer-head">
        <input className="title-input" value={p.name} maxLength={80} onChange={(e) => change({ name: e.target.value })} aria-label="Printer name" />
        {active ? (
          <span className="printer-active">
            <Check size={15} /> In use
          </span>
        ) : (
          <button type="button" className="ghost" onClick={() => setActivePrinter(p.id)}>
            <Check size={15} /> Use this printer
          </button>
        )}
        <button
          type="button"
          className="icon"
          aria-label={`Delete ${p.name}`}
          onClick={() => window.confirm(`Delete "${p.name}"?`) && deletePrinter(p.id).catch(() => onError('Could not delete that printer.'))}
        >
          <Trash2 size={16} />
        </button>
      </div>

      <label className="num">
        <span>Model</span>
        <select
          value={p.model}
          onChange={(e) => {
            const m = MODELS.find((x) => x.id === e.target.value)
            if (!m) return change({ model: '' })
            const slots = m.multi ? Math.max(p.filaments.length, m.slots) : 1
            change({
              model: m.id,
              bedX: m.bedX,
              bedY: m.bedY,
              bedZ: m.bedZ,
              multi: m.multi,
              filaments: newPrinter(m).filaments.map((f, i) => p.filaments[i] ?? f).slice(0, slots),
            })
          }}
        >
          <option value="">Custom</option>
          {MODELS.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
      </label>
      <div className="grid3">
        {(
          [
            ['Bed width', 'bedX'],
            ['Bed depth', 'bedY'],
            ['Build height', 'bedZ'],
          ] as const
        ).map(([label, key]) => (
          <label className="num" key={key}>
            <span>{label}</span>
            <span className="num-input">
              <NumberField value={p[key]} min={60} max={1000} onChange={(v) => change({ [key]: v, model: '' })} />
              <em>mm</em>
            </span>
          </label>
        ))}
        <label className="num">
          <span>Nozzle</span>
          <span className="num-input">
            <NumberField value={p.nozzle} min={0.1} max={2} step={0.1} onChange={(nozzle) => change({ nozzle })} />
            <em>mm</em>
          </span>
        </label>
      </div>

      <fieldset className="radio-row">
        <legend>Colours</legend>
        <label>
          <input type="radio" checked={!p.multi} onChange={() => change({ multi: false, filaments: p.filaments.slice(0, 1) })} />
          Single colour
        </label>
        <label>
          <input
            type="radio"
            checked={p.multi}
            onChange={() => change({ multi: true, filaments: p.filaments.length > 1 ? p.filaments : newPrinter(MODELS[0]).filaments.map((f, i) => p.filaments[i] ?? f) })}
          />
          AMS / multi-material
        </label>
      </fieldset>

      <h3 className="gf-sub">{p.multi ? 'Loaded filaments' : 'Loaded filament'}</h3>
      <ul className="slots">
        {p.filaments.map((f, i) => (
          <li key={i} className="slot gf-slot">
            <label className="spool" style={{ background: f.hex, color: inkOn(f.hex) }} title="Change colour">
              {i + 1}
              <input type="color" value={f.hex.toLowerCase()} onChange={(e) => setFilament(i, { hex: e.target.value.toUpperCase() })} aria-label={`Slot ${i + 1} colour`} />
            </label>
            <input className="slot-name" value={f.name} maxLength={40} onChange={(e) => setFilament(i, { name: e.target.value })} aria-label={`Slot ${i + 1} name`} />
            <div className="slot-actions">
              {p.multi && (
                <button type="button" className="icon" disabled={p.filaments.length <= 1} aria-label={`Remove slot ${i + 1}`} onClick={() => change({ filaments: p.filaments.filter((_, j) => j !== i) })}>
                  <X size={14} />
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
      {p.multi && (
        <button
          type="button"
          className="ghost"
          disabled={p.filaments.length >= 16}
          onClick={() => change({ filaments: [...p.filaments, { name: `Slot ${p.filaments.length + 1}`, hex: '#808080' }] })}
        >
          <Plus size={15} /> Add a slot
        </button>
      )}
    </li>
  )
}

/** "My printers": beds and loaded filaments, used by both tools. */
export default function PrintersPage({ me, onSignIn }: Props) {
  const { printers, activeId, signedIn, loaded } = usePrinters()
  const [error, setError] = useState<string | null>(null)
  const [model, setModel] = useState(MODELS[0].id)

  const add = async () => {
    try {
      const saved = await savePrinter(newPrinter(MODELS.find((m) => m.id === model) ?? null))
      if (!activeId) setActivePrinter(saved.id)
    } catch {
      setError('Could not add that printer.')
    }
  }

  return (
    <section className="page" aria-labelledby="printers-h">
      <div className="page-head">
        <h2 id="printers-h">My printers</h2>
        <p className="hint">
          {signedIn
            ? 'Saved to your account. Both tools use the printer marked In use.'
            : me.accounts
              ? 'Kept in this browser. '
              : 'Kept in this browser. Both tools use the printer marked In use.'}
          {!signedIn && me.accounts && (
            <button type="button" className="link" onClick={onSignIn}>
              Sign in to keep them in your account
            </button>
          )}
        </p>
        <span className="row printer-add">
          <select value={model} onChange={(e) => setModel(e.target.value)} aria-label="Printer model">
            {MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
            <option value="">Other (custom size)</option>
          </select>
          <button type="button" className="solid" onClick={add}>
            <Plus size={15} /> Add printer
          </button>
        </span>
      </div>
      {error && <p className="hint danger">{error}</p>}
      {!loaded ? (
        <p className="hint">Loading…</p>
      ) : printers.length === 0 ? (
        <div className="panel page-intro">
          <h2>Add your printer</h2>
          <p>Pick its model above. LayerLift uses its bed size to split baseplates and the filaments loaded in it (or its one colour) for every part.</p>
        </div>
      ) : (
        <ul className="printer-grid">
          {printers.map((p) => (
            <PrinterCard key={p.id} printer={p} active={p.id === activeId} onError={setError} />
          ))}
        </ul>
      )}
    </section>
  )
}

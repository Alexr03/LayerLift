import { useState } from 'react'
import type { Filament } from '../api'
import { PRESETS, type SavedPalette, deletePalette, fmt, inkOn, loadSavedPalettes, savePalette } from '../palettes'

interface Props {
  filaments: Filament[]
  layer: number
  base: number
  manualHeights: boolean
  autoHeights: number[]
  used: boolean[]
  onChange: (next: Filament[], reindex?: (number | null)[]) => void
}

export default function FilamentEditor({ filaments, layer, base, manualHeights, autoHeights, used, onChange }: Props) {
  const [saved, setSaved] = useState<SavedPalette[]>(loadSavedPalettes)
  const [paletteName, setPaletteName] = useState('My AMS')

  const update = (i: number, patch: Partial<Filament>) =>
    onChange(filaments.map((f, j) => (j === i ? { ...f, ...patch } : f)))

  const remove = (i: number) => {
    const next = filaments.filter((_, j) => j !== i)
    onChange(next, filaments.map((_, j) => (j === i ? null : j > i ? j - 1 : j)))
  }

  const move = (i: number, d: -1 | 1) => {
    const j = i + d
    if (j < 0 || j >= filaments.length) return
    const next = [...filaments]
    ;[next[i], next[j]] = [next[j], next[i]]
    onChange(next, filaments.map((_, k) => (k === i ? j : k === j ? i : k)))
  }

  const add = () => {
    const top = Math.max(base + 0.8, ...filaments.map((f) => f.height_mm ?? 0))
    onChange([...filaments, { name: `Slot ${filaments.length + 1}`, hex: '#808080', height_mm: top + 0.4, start_from_bed: false }])
  }

  const applyPalette = (value: string) => {
    const [kind, name] = value.split(':', 2)
    const source = kind === 'preset' ? PRESETS : saved
    const p = source.find((x) => x.name === name)
    if (!p) return
    // Slot numbers change meaning with a new palette, so drop per-slot assignments.
    onChange(p.filaments.map((f) => ({ ...f })), filaments.map(() => null))
  }

  return (
    <section className="panel" aria-labelledby="filaments-h">
      <div className="panel-head">
        <h2 id="filaments-h">Filaments</h2>
        <select className="palette-select" value="" onChange={(e) => applyPalette(e.target.value)} aria-label="Load a palette">
          <option value="">Load palette…</option>
          <optgroup label="Presets">
            {PRESETS.map((p) => (
              <option key={p.name} value={`preset:${p.name}`}>
                {p.name}
              </option>
            ))}
          </optgroup>
          {saved.length > 0 && (
            <optgroup label="Saved in this browser">
              {saved.map((p) => (
                <option key={p.name} value={`saved:${p.name}`}>
                  {p.name}
                </option>
              ))}
            </optgroup>
          )}
        </select>
      </div>
      <p className="hint">One row per AMS slot, in slot order. Heights are the top of each colour.</p>

      <ol className="slots">
        {filaments.map((f, i) => (
          <li key={i} className={used[i] ? 'slot' : 'slot unused'}>
            <label className="spool" style={{ background: f.hex, color: inkOn(f.hex) }} title="Change colour">
              {i + 1}
              <input type="color" value={f.hex.toLowerCase()} onChange={(e) => update(i, { hex: e.target.value.toUpperCase() })} aria-label={`Slot ${i + 1} colour`} />
            </label>
            <input className="slot-name" value={f.name} maxLength={40} onChange={(e) => update(i, { name: e.target.value })} aria-label={`Slot ${i + 1} name`} />
            <label className="slot-height" title={manualHeights ? 'Top height in mm' : 'Set automatically by brightness'}>
              <input
                type="number"
                step={layer}
                min={layer}
                max={50}
                disabled={!manualHeights}
                value={manualHeights ? (f.height_mm ?? '') : fmt(autoHeights[i] ?? 0)}
                onChange={(e) => update(i, { height_mm: e.target.value === '' ? null : Number(e.target.value) })}
                onBlur={() => f.height_mm != null && update(i, { height_mm: Math.max(layer, Math.round(f.height_mm / layer) * layer) })}
                aria-label={`Slot ${i + 1} top height in millimetres`}
              />
              <span>mm</span>
            </label>
            <label className="bed-toggle" title="Print this colour from the bed up, so a dark base can't show through">
              <input type="checkbox" checked={f.start_from_bed} onChange={(e) => update(i, { start_from_bed: e.target.checked })} />
              <span>From bed</span>
            </label>
            <span className="slot-actions">
              <button type="button" className="icon" onClick={() => move(i, -1)} disabled={i === 0} aria-label={`Move slot ${i + 1} up`}>
                ↑
              </button>
              <button type="button" className="icon" onClick={() => move(i, 1)} disabled={i === filaments.length - 1} aria-label={`Move slot ${i + 1} down`}>
                ↓
              </button>
              <button type="button" className="icon" onClick={() => remove(i)} disabled={filaments.length <= 1} aria-label={`Remove slot ${i + 1}`}>
                ×
              </button>
            </span>
          </li>
        ))}
      </ol>
      <div className="row">
        <button type="button" className="ghost" onClick={add} disabled={filaments.length >= 16}>
          Add slot
        </button>
      </div>
      <div className="save-row">
        <input value={paletteName} onChange={(e) => setPaletteName(e.target.value)} aria-label="Palette name" maxLength={40} />
        <button type="button" className="ghost" onClick={() => paletteName.trim() && setSaved(savePalette(paletteName.trim(), filaments))}>
          Save palette
        </button>
        {saved.some((p) => p.name === paletteName.trim()) && (
          <button type="button" className="ghost danger" onClick={() => setSaved(deletePalette(paletteName.trim()))}>
            Delete
          </button>
        )}
      </div>
    </section>
  )
}

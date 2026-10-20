import { Check, ChevronDown, Plus, Printer as PrinterIcon, Settings2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { type Printer, setActivePrinter, usePrinters } from '../printers'

function Spools({ printer }: { printer: Printer }) {
  return (
    <span className="ps-spools" aria-hidden>
      {printer.filaments.slice(0, 8).map((f, i) => (
        <i key={i} style={{ background: f.hex }} />
      ))}
    </span>
  )
}

/** The printer in use, in the top bar, like a slicer's printer selector. */
export default function PrinterSwitch() {
  const { printers, active, loaded } = usePrinters()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false)
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', esc)
    }
  }, [open])

  if (!loaded) return null
  if (!active)
    return (
      <a className="printer-switch button ghost" href="#/printers">
        <PrinterIcon size={16} /> Add your printer
      </a>
    )

  const go = (hash: string) => {
    window.location.hash = hash
    setOpen(false)
  }

  return (
    <div className="printer-switch" ref={ref}>
      <button type="button" className="ghost ps-button" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)} title="Printer in use">
        <PrinterIcon size={16} aria-hidden />
        <span className="ps-name">{active.name}</span>
        <Spools printer={active} />
        <ChevronDown size={14} aria-hidden />
      </button>
      {open && (
        <div className="ps-menu" role="menu">
          {printers.map((p) => (
            <button
              key={p.id}
              type="button"
              role="menuitemradio"
              aria-checked={p.id === active.id}
              className={p.id === active.id ? 'ps-item on' : 'ps-item'}
              onClick={() => {
                setActivePrinter(p.id)
                setOpen(false)
              }}
            >
              <span className="ps-check">{p.id === active.id && <Check size={15} />}</span>
              <span className="ps-text">
                <strong>{p.name}</strong>
                <span>
                  {p.bedX} × {p.bedY} mm · {p.multi ? `${p.filaments.length} slots` : 'single colour'}
                </span>
              </span>
              <Spools printer={p} />
            </button>
          ))}
          <div className="ps-foot">
            <button type="button" className="ghost" onClick={() => go('#/printers')}>
              <Settings2 size={15} /> Manage printers
            </button>
            <button type="button" className="ghost" onClick={() => go('#/printers')}>
              <Plus size={15} /> Add
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

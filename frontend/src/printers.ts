// "My printers": the printers someone owns, their beds and the filaments loaded in them. Kept in
// the account (PocketBase `printers`) when signed in, otherwise in this browser. Both tools read
// the active printer: Gridfinity for the bed and slots, Image to Layers for its filament list.
import { useSyncExternalStore } from 'react'
import { pb } from './pb'

export interface PrinterFilament {
  name: string
  hex: string
}

export interface Printer {
  id: string
  name: string
  model: string // preset id, or '' for custom
  bedX: number
  bedY: number
  bedZ: number
  nozzle: number
  multi: boolean // has an AMS or another multi-material unit
  filaments: PrinterFilament[] // in slot order; a single-colour printer has one
}

export interface PrinterModel {
  id: string
  label: string
  bedX: number
  bedY: number
  bedZ: number
  multi: boolean // usually sold with (or commonly fitted with) a multi-material unit
  slots: number
}

export const MODELS: PrinterModel[] = [
  { id: 'bambu-x1', label: 'Bambu Lab X1 / X1C / X1E', bedX: 256, bedY: 256, bedZ: 256, multi: true, slots: 4 },
  { id: 'bambu-p1s', label: 'Bambu Lab P1S / P1P', bedX: 256, bedY: 256, bedZ: 256, multi: true, slots: 4 },
  { id: 'bambu-p2s', label: 'Bambu Lab P2S', bedX: 256, bedY: 256, bedZ: 256, multi: true, slots: 4 },
  { id: 'bambu-h2d', label: 'Bambu Lab H2D', bedX: 325, bedY: 320, bedZ: 325, multi: true, slots: 4 },
  { id: 'bambu-a1', label: 'Bambu Lab A1', bedX: 256, bedY: 256, bedZ: 256, multi: true, slots: 4 },
  { id: 'bambu-a1-mini', label: 'Bambu Lab A1 mini', bedX: 180, bedY: 180, bedZ: 180, multi: true, slots: 4 },
  { id: 'prusa-core-one', label: 'Prusa Core One', bedX: 250, bedY: 220, bedZ: 270, multi: false, slots: 1 },
  { id: 'prusa-mk4', label: 'Prusa MK4 / MK4S', bedX: 250, bedY: 210, bedZ: 220, multi: false, slots: 1 },
  { id: 'prusa-xl', label: 'Prusa XL', bedX: 360, bedY: 360, bedZ: 360, multi: true, slots: 5 },
  { id: 'prusa-mini', label: 'Prusa MINI', bedX: 180, bedY: 180, bedZ: 180, multi: false, slots: 1 },
  { id: 'creality-k1', label: 'Creality K1 / K1C', bedX: 220, bedY: 220, bedZ: 250, multi: false, slots: 1 },
  { id: 'creality-k2', label: 'Creality K2 Plus', bedX: 350, bedY: 350, bedZ: 350, multi: true, slots: 4 },
  { id: 'ender-3', label: 'Creality Ender 3 V3', bedX: 220, bedY: 220, bedZ: 250, multi: false, slots: 1 },
  { id: 'voron-350', label: 'Voron 2.4 (350)', bedX: 350, bedY: 350, bedZ: 340, multi: false, slots: 1 },
]

const STARTER: PrinterFilament[] = [
  { name: 'Black', hex: '#1C1C1E' },
  { name: 'White', hex: '#F5F5F5' },
  { name: 'Red', hex: '#C12E1F' },
  { name: 'Blue', hex: '#0A2989' },
  { name: 'Yellow', hex: '#F4EE2A' },
]

export function newPrinter(model: PrinterModel | null): Printer {
  const multi = model?.multi ?? false
  const slots = multi ? (model?.slots ?? 4) : 1
  return {
    id: Math.random().toString(36).slice(2, 10),
    name: model?.label ?? 'My printer',
    model: model?.id ?? '',
    bedX: model?.bedX ?? 220,
    bedY: model?.bedY ?? 220,
    bedZ: model?.bedZ ?? 250,
    nozzle: 0.4,
    multi,
    filaments: STARTER.slice(0, slots).map((f) => ({ ...f })),
  }
}

const num = (v: unknown, lo: number, hi: number, fallback: number) => {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : fallback
  return Math.min(hi, Math.max(lo, n))
}

export function normalisePrinter(raw: unknown, id?: string): Printer {
  const p = (raw ?? {}) as Partial<Printer>
  const multi = !!p.multi
  const filaments = (Array.isArray(p.filaments) ? p.filaments : [])
    .slice(0, multi ? 16 : 1)
    .map((f) => ({ name: String(f?.name ?? 'Filament').slice(0, 40), hex: /^#[0-9a-f]{6}$/i.test(f?.hex ?? '') ? f!.hex : '#808080' }))
  return {
    id: id ?? (typeof p.id === 'string' && p.id ? p.id : Math.random().toString(36).slice(2, 10)),
    name: String(p.name ?? 'My printer').slice(0, 80) || 'My printer',
    model: typeof p.model === 'string' ? p.model : '',
    bedX: num(p.bedX, 60, 1000, 220),
    bedY: num(p.bedY, 60, 1000, 220),
    bedZ: num(p.bedZ, 60, 1000, 250),
    nozzle: num(p.nozzle, 0.1, 2, 0.4),
    multi,
    filaments: filaments.length ? filaments : [{ name: 'Black', hex: '#1C1C1E' }],
  }
}

// ------------------------------------------------------------------ store

const LOCAL = 'layerlift.printers.v1'
const ACTIVE = 'layerlift.active-printer.v1'

interface State {
  printers: Printer[]
  activeId: string | null
  signedIn: boolean
  loaded: boolean
}

let state: State = { printers: readLocal(), activeId: readActive(), signedIn: false, loaded: false }
const listeners = new Set<() => void>()

function set(next: Partial<State>) {
  state = { ...state, ...next }
  if (state.activeId && !state.printers.some((p) => p.id === state.activeId)) state.activeId = state.printers[0]?.id ?? null
  if (!state.activeId && state.printers.length) state.activeId = state.printers[0].id
  listeners.forEach((l) => l())
}

function readLocal(): Printer[] {
  try {
    const raw = localStorage.getItem(LOCAL)
    return raw ? (JSON.parse(raw) as unknown[]).map((p) => normalisePrinter(p)) : []
  } catch {
    return []
  }
}

function readActive(): string | null {
  try {
    return localStorage.getItem(ACTIVE)
  } catch {
    return null
  }
}

function writeLocal(printers: Printer[]) {
  try {
    localStorage.setItem(LOCAL, JSON.stringify(printers))
  } catch {
    /* storage full or blocked */
  }
}

interface PrinterRecord {
  id: string
  name: string
  data: unknown
}

/** Load the signed-in account's printers (moving any kept in this browser into it), or the local ones. */
export async function loadPrinters(userId: string | null) {
  if (!userId) {
    set({ printers: readLocal(), signedIn: false, loaded: true })
    return
  }
  try {
    const records = await pb.collection('printers').getFullList<PrinterRecord>({ filter: pb.filter('user = {:u}', { u: userId }), sort: 'created' })
    let printers = records.map((r) => normalisePrinter(r.data, r.id))
    const local = readLocal()
    if (!printers.length && local.length) {
      // First sign-in on this browser: keep what was set up before.
      const created = await Promise.all(
        local.map((p) => pb.collection('printers').create<PrinterRecord>({ user: userId, name: p.name, data: { ...p, id: undefined } })),
      )
      printers = created.map((r) => normalisePrinter(r.data, r.id))
      const activeIndex = local.findIndex((p) => p.id === state.activeId)
      if (activeIndex >= 0) setActivePrinter(printers[activeIndex].id)
    }
    set({ printers, signedIn: true, loaded: true })
  } catch {
    // PocketBase unreachable: fall back to this browser's list.
    set({ printers: readLocal(), signedIn: false, loaded: true })
  }
}

export async function savePrinter(p: Printer): Promise<Printer> {
  const clean = normalisePrinter(p, p.id)
  const userId = pb.authStore.isValid ? pb.authStore.record?.id : null
  if (state.signedIn && userId) {
    const exists = state.printers.some((x) => x.id === clean.id)
    const body = { name: clean.name, data: { ...clean, id: undefined } }
    const r = exists
      ? await pb.collection('printers').update<PrinterRecord>(clean.id, body)
      : await pb.collection('printers').create<PrinterRecord>({ ...body, user: userId })
    const saved = normalisePrinter(r.data, r.id)
    set({ printers: exists ? state.printers.map((x) => (x.id === saved.id ? saved : x)) : [...state.printers, saved] })
    return saved
  }
  const printers = state.printers.some((x) => x.id === clean.id) ? state.printers.map((x) => (x.id === clean.id ? clean : x)) : [...state.printers, clean]
  writeLocal(printers)
  set({ printers })
  return clean
}

export async function deletePrinter(id: string) {
  if (state.signedIn) await pb.collection('printers').delete(id)
  const printers = state.printers.filter((p) => p.id !== id)
  if (!state.signedIn) writeLocal(printers)
  set({ printers })
}

export function setActivePrinter(id: string) {
  try {
    localStorage.setItem(ACTIVE, id)
  } catch {
    /* ignore */
  }
  set({ activeId: id })
}

const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => listeners.delete(l)
}

export function usePrinters() {
  const s = useSyncExternalStore(subscribe, () => state)
  return { ...s, active: s.printers.find((p) => p.id === s.activeId) ?? null }
}

export function getActivePrinter(): Printer | null {
  return state.printers.find((p) => p.id === state.activeId) ?? null
}

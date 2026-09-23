// Filament palettes: built-in presets plus named palettes saved in this browser.
import type { Filament } from './api'

export interface SavedPalette {
  name: string
  filaments: Filament[]
}

const STORAGE_KEY = 'layerlift.palettes.v1'
const CURRENT_KEY = 'layerlift.current-palette.v1'

const f = (name: string, hex: string, height_mm: number, start_from_bed = false): Filament => ({
  name,
  hex,
  height_mm,
  start_from_bed,
})

export const PRESETS: SavedPalette[] = [
  {
    name: 'Space Turtles sample',
    filaments: [
      f('Black', '#1C1C1E', 2.8),
      f('Blue', '#1446AA', 3.2),
      f('Apricot', '#F7B28C', 3.6),
      f('White', '#F5F5F5', 4.0, true),
    ],
  },
  {
    name: 'Bambu PLA Basic starter',
    filaments: [
      f('Black', '#000000', 2.8),
      f('Red', '#C12E1F', 3.2),
      f('Blue', '#0A2989', 3.2),
      f('Yellow', '#F4EE2A', 3.6, true),
      f('White', '#FFFFFF', 4.0, true),
    ],
  },
  {
    name: 'Two-colour sign',
    filaments: [f('Black', '#161616', 2.4), f('White', '#F2F2F2', 3.2, true)],
  },
]

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* storage full or blocked: palettes just won't persist */
  }
}

export const loadSavedPalettes = (): SavedPalette[] => read<SavedPalette[]>(STORAGE_KEY, [])

export function savePalette(name: string, filaments: Filament[]): SavedPalette[] {
  const list = loadSavedPalettes().filter((p) => p.name !== name)
  list.push({ name, filaments })
  list.sort((a, b) => a.name.localeCompare(b.name))
  write(STORAGE_KEY, list)
  return list
}

export function deletePalette(name: string): SavedPalette[] {
  const list = loadSavedPalettes().filter((p) => p.name !== name)
  write(STORAGE_KEY, list)
  return list
}

export const loadCurrentPalette = (): Filament[] => read<Filament[]>(CURRENT_KEY, PRESETS[0].filaments)
export const storeCurrentPalette = (filaments: Filament[]) => write(CURRENT_KEY, filaments)

/** Relative luminance (0..1) of a #RRGGBB colour. */
export function luminance(hex: string): number {
  const v = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
  const lin = v.map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2]
}

/** Text colour that stays readable on the given swatch. */
export const inkOn = (hex: string) => (luminance(hex) > 0.35 ? '#1F2328' : '#FFFFFF')

export const snap = (z: number, layer: number) => Math.max(layer, Math.round(z / layer) * layer)
export const fmt = (z: number) => (Math.round(z * 100) / 100).toString()

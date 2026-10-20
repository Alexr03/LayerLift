// The Gridfinity project model: a drawer (with its baseplate) and the bins placed in it. A project
// is small JSON; meshes are always rebuilt from it, so saving one costs almost nothing.
import { HEIGHT_UNIT, PITCH } from './spec'

export type Holes = 'none' | 'magnets' | 'screws' | 'both'
export type TabStyle = 'none' | 'full' | 'left' | 'center' | 'right'
export type WallPattern = 'solid' | 'hex'
export type BaseStyle = 'standard' | 'lite'
export type LabelStyle = 'inlay' | 'raised'
export type PlateStyle = 'thin' | 'solid' | 'magnets'
export type Align = 'start' | 'center' | 'end'

/** Outlines of a label icon, fitted to the unit square (y up). */
export interface LabelIcon {
  name: string
  polys: [number, number][][]
}

export interface BinDesign {
  w: number // cells across (x)
  d: number // cells deep (y)
  h: number // height units of 7 mm
  lip: boolean // stacking lip
  wall: number // mm
  floor: number // mm of floor above the foot (standard base) or under the cavity (lite)
  base: BaseStyle
  holes: Holes
  holesCorners: boolean // holes only at the bin's four outer corners
  divX: number // dividers across: divX + 1 compartments along x
  divY: number // dividers front to back: divY + 1 rows
  scoop: number // radius of the finger scoop at the front of each row, 0 for none
  tab: TabStyle
  tabWidth: number // mm, for left/center/right tabs
  tabDepth: number // mm the tab reaches in from the back wall
  pattern: WallPattern
  hexSize: number // hexagon hole across flats, mm
  hexRib: number // material between holes, mm
  labels: string[] // one per compartment, row by row from the front left
  icons: (LabelIcon | null)[]
  labelStyle: LabelStyle
  labelSize: number // text height, mm (0 = fit to the tab)
  body: number // filament index
  labelFilament: number // filament index
}

export interface PlacedBin {
  id: string
  x: number // cell column of the bin's front-left cell
  y: number // cell row
  design: BinDesign
}

export interface Drawer {
  pitch: number // grid cell, mm (42 is standard Gridfinity)
  unit: number // bin height unit, mm (7 is standard)
  sizeMode: 'cells' | 'mm' // a grid of so many cells, or whatever fits a measured drawer
  cellsX: number
  cellsY: number
  width: number // inside of the drawer, mm
  depth: number
  height: number // mm, 0 when unknown (only used for warnings)
  clearance: number // mm left free across each direction so the baseplate drops in
  alignX: Align // where the spare room goes
  alignY: Align
  bedX: number // printer bed, mm: baseplates are split into pieces that fit
  bedY: number
  plate: PlateStyle
  plateFilament: number
  split: boolean // split into pieces that fit the printer bed
  connectors: Connectors
  connectorEdges: ConnectorEdges // outer sides that also get clip holes, to join other baseplates
  clipTolerance: number // extra play in the clip, mm; 0 is Gridfinity Generator's own fit
}

/** Baseplate connectors: none, or clips in holes along the seams between pieces. */
export type Connectors = 'none' | 'clips'
export interface ConnectorEdges {
  back: boolean
  front: boolean
  left: boolean
  right: boolean
}

export interface GfFilament {
  name: string
  hex: string
}

/** One baseplate (a drawer) and the bins on it. */
export interface Plate {
  id: string
  name: string
  drawer: Drawer
  bins: PlacedBin[]
}

/** What a project is: a set of drawers, or a single bin or baseplate made on its own. */
export type ProjectMode = 'project' | 'bin' | 'plate'

export interface GfProject {
  version: 2
  title: string
  mode: ProjectMode
  filaments: GfFilament[]
  plates: Plate[]
}

/** One baseplate with the project's filaments; the unit the geometry, layout and export work on. */
export interface Scene {
  title: string
  filaments: GfFilament[]
  drawer: Drawer
  bins: PlacedBin[]
}

export const DEFAULT_BIN: BinDesign = {
  w: 2,
  d: 1,
  h: 6,
  lip: true,
  wall: 1.2,
  floor: 2.25,
  base: 'standard',
  holes: 'none',
  holesCorners: false,
  divX: 0,
  divY: 0,
  scoop: 0,
  tab: 'none',
  tabWidth: 42,
  tabDepth: 13,
  pattern: 'solid',
  hexSize: 7,
  hexRib: 1.6,
  labels: [],
  icons: [],
  labelStyle: 'inlay',
  labelSize: 0,
  body: 0,
  labelFilament: 1,
}

export const DEFAULT_DRAWER: Drawer = {
  pitch: PITCH,
  unit: HEIGHT_UNIT,
  sizeMode: 'cells',
  cellsX: 5,
  cellsY: 4,
  width: 5 * PITCH + 12,
  depth: 4 * PITCH + 8,
  height: 0,
  clearance: 0.5,
  alignX: 'center',
  alignY: 'center',
  bedX: 256,
  bedY: 256,
  plate: 'thin',
  plateFilament: 0,
  split: true,
  connectors: 'none',
  connectorEdges: { back: false, front: false, left: false, right: false },
  clipTolerance: 0,
}

export const DEFAULT_FILAMENTS: GfFilament[] = [
  { name: 'Grey', hex: '#8C9196' },
  { name: 'Black', hex: '#1C1C1E' },
  { name: 'White', hex: '#F5F5F5' },
  { name: 'Blue', hex: '#1446AA' },
]

export function newId(): string {
  return Math.random().toString(36).slice(2, 10)
}

export function newPlate(name = 'Baseplate 1', bins: PlacedBin[] = []): Plate {
  return { id: newId(), name, drawer: { ...DEFAULT_DRAWER }, bins }
}

export function newProject(filaments: GfFilament[] = DEFAULT_FILAMENTS, mode: ProjectMode = 'project'): GfProject {
  const bin: PlacedBin = { id: newId(), x: 0, y: 0, design: { ...DEFAULT_BIN } }
  const plate = newPlate('Baseplate 1', mode === 'plate' ? [] : [bin])
  if (mode === 'bin') plate.drawer = { ...plate.drawer, cellsX: DEFAULT_BIN.w, cellsY: DEFAULT_BIN.d }
  return {
    version: 2,
    title: mode === 'bin' ? 'Bin' : mode === 'plate' ? 'Baseplate' : 'My drawers',
    mode,
    filaments: filaments.length ? filaments : DEFAULT_FILAMENTS,
    plates: [plate],
  }
}

export const compartments = (b: BinDesign) => (b.divX + 1) * (b.divY + 1)

const num = (v: unknown, lo: number, hi: number, fallback: number, int = false): number => {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : fallback
  const c = Math.min(hi, Math.max(lo, n))
  return int ? Math.round(c) : c
}
const pick = <T extends string>(v: unknown, options: readonly T[], fallback: T): T => (options.includes(v as T) ? (v as T) : fallback)

/** Fill in and clamp a bin design (from storage, an older version or a typo in a field). */
export function normaliseBin(raw: Partial<BinDesign> | undefined, filaments = 8): BinDesign {
  const b = { ...DEFAULT_BIN, ...(raw ?? {}) }
  const out: BinDesign = {
    w: num(b.w, 1, 10, 2, true),
    d: num(b.d, 1, 10, 1, true),
    h: num(b.h, 2, 20, 6, true),
    lip: !!b.lip,
    wall: num(b.wall, 0.8, 4, 1.2),
    floor: num(b.floor, 0.8, 6, 2.25),
    base: pick(b.base, ['standard', 'lite'] as const, 'standard'),
    holes: pick(b.holes, ['none', 'magnets', 'screws', 'both'] as const, 'none'),
    holesCorners: !!b.holesCorners,
    divX: num(b.divX, 0, 12, 0, true),
    divY: num(b.divY, 0, 12, 0, true),
    scoop: num(b.scoop, 0, 20, 0),
    tab: pick(b.tab, ['none', 'full', 'left', 'center', 'right'] as const, 'none'),
    tabWidth: num(b.tabWidth, 8, 420, 42),
    tabDepth: num(b.tabDepth, 4, 20, 13),
    pattern: pick(b.pattern, ['solid', 'hex'] as const, 'solid'),
    hexSize: num(b.hexSize, 3, 20, 7),
    hexRib: num(b.hexRib, 0.8, 5, 1.6),
    labels: Array.isArray(b.labels) ? b.labels.map((s) => String(s ?? '').slice(0, 40)) : [],
    icons: Array.isArray(b.icons) ? b.icons.map((i) => (i && Array.isArray(i.polys) ? i : null)) : [],
    labelStyle: pick(b.labelStyle, ['inlay', 'raised'] as const, 'inlay'),
    labelSize: num(b.labelSize, 0, 30, 0),
    body: num(b.body, 0, filaments - 1, 0, true),
    labelFilament: num(b.labelFilament, 0, filaments - 1, Math.min(1, filaments - 1), true),
  }
  if (out.base === 'lite') out.holes = 'none' // hollow feet have nothing to hold a magnet
  return out
}

function normaliseFilaments(raw: unknown): GfFilament[] {
  return Array.isArray(raw) && raw.length
    ? raw.slice(0, 16).map((f) => ({ name: String(f?.name ?? 'Filament').slice(0, 40), hex: /^#[0-9a-f]{6}$/i.test(f?.hex) ? f.hex : '#808080' }))
    : DEFAULT_FILAMENTS
}

export function normaliseDrawer(raw: Partial<Drawer> | undefined, filaments: number): Drawer {
  const d = { ...DEFAULT_DRAWER, ...(raw ?? {}) }
  // Drawers saved before sizing by cells existed were sized in millimetres.
  const sizeMode = raw && !('sizeMode' in raw) ? 'mm' : pick(d.sizeMode, ['cells', 'mm'] as const, 'cells')
  return {
    pitch: num(d.pitch, 20, 100, PITCH),
    unit: num(d.unit, 2, 20, HEIGHT_UNIT),
    sizeMode,
    cellsX: num(d.cellsX, 1, 40, 5, true),
    cellsY: num(d.cellsY, 1, 40, 4, true),
    width: num(d.width, PITCH, 2000, DEFAULT_DRAWER.width),
    depth: num(d.depth, PITCH, 2000, DEFAULT_DRAWER.depth),
    height: num(d.height, 0, 1000, 0),
    clearance: num(d.clearance, 0, 5, 0.5),
    alignX: pick(d.alignX, ['start', 'center', 'end'] as const, 'center'),
    alignY: pick(d.alignY, ['start', 'center', 'end'] as const, 'center'),
    bedX: num(d.bedX, 60, 1000, 256),
    bedY: num(d.bedY, 60, 1000, 256),
    plate: pick(d.plate, ['thin', 'solid', 'magnets'] as const, 'thin'),
    plateFilament: num(d.plateFilament, 0, filaments - 1, 0, true),
    split: d.split !== false,
    // Earlier versions had 'joins' and 'edges' (every outer edge).
    connectors: (d.connectors as string) === 'joins' || (d.connectors as string) === 'edges' ? 'clips' : pick(d.connectors, ['none', 'clips'] as const, 'none'),
    connectorEdges:
      (d.connectors as string) === 'edges'
        ? { back: true, front: true, left: true, right: true }
        : { back: !!d.connectorEdges?.back, front: !!d.connectorEdges?.front, left: !!d.connectorEdges?.left, right: !!d.connectorEdges?.right },
    clipTolerance: num(d.clipTolerance, 0, 0.4, 0),
  }
}

function normaliseBins(raw: unknown, filaments: number): PlacedBin[] {
  return Array.isArray(raw)
    ? raw.slice(0, 400).map((b) => ({
        id: typeof b?.id === 'string' && b.id ? b.id : newId(),
        x: num(b?.x, 0, 100, 0, true),
        y: num(b?.y, 0, 100, 0, true),
        design: normaliseBin(b?.design, filaments),
      }))
    : []
}

/** Fill in and clamp a project; projects saved before baseplates became a list are converted. */
export function normaliseProject(raw: unknown): GfProject {
  const p = (raw ?? {}) as Partial<GfProject> & Partial<Scene>
  const filaments = normaliseFilaments(p.filaments)
  const rawPlates: Partial<Plate>[] = Array.isArray(p.plates) && p.plates.length ? p.plates : [{ name: 'Baseplate 1', drawer: p.drawer, bins: p.bins }]
  const plates: Plate[] = rawPlates.slice(0, 50).map((pl, i) => ({
    id: typeof pl?.id === 'string' && pl.id ? pl.id : newId(),
    name: String(pl?.name ?? `Baseplate ${i + 1}`).slice(0, 80) || `Baseplate ${i + 1}`,
    drawer: normaliseDrawer(pl?.drawer, filaments.length),
    bins: normaliseBins(pl?.bins, filaments.length),
  }))
  return {
    version: 2,
    title: String(p.title ?? 'Untitled').slice(0, 120) || 'Untitled',
    mode: pick(p.mode, ['project', 'bin', 'plate'] as const, 'project'),
    filaments,
    plates,
  }
}

/** One baseplate with the project's filaments: what the geometry and layout code work on. */
export function sceneOf(p: GfProject, plateId?: string | null): Scene {
  const plate = p.plates.find((x) => x.id === plateId) ?? p.plates[0]
  return { title: p.title, filaments: p.filaments, drawer: plate.drawer, bins: plate.bins }
}

/** A short description: "2×1×6". */
export const binSize = (b: BinDesign) => `${b.w}×${b.d}×${b.h}`

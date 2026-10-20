import { useEffect, useMemo, useRef, useState } from 'react'
import { Box, Copy, Download, FileUp, FolderOpen, Grid3x3, Plus, Redo2, Save, Trash2, Undo2, X } from 'lucide-react'
import type { Me } from '../../api'
import { request, saveFile } from '../../gridfinity/client'
import { binIssues, clipCount, drawerGrid, freeCells, freeSpot, gridSpec, platePieces } from '../../gridfinity/layout'
import { type Draft, type ProjectRecord, getProject, loadDraft, putProject, saveDraft } from '../../gridfinity/projects'
import type { ViewPart } from '../../gridfinity/protocol'
import {
  type BinDesign,
  type GfFilament,
  type GfProject,
  type PlacedBin,
  type Plate,
  type ProjectMode,
  binSize,
  newId,
  newPlate,
  newProject,
  normaliseBin,
  normaliseProject,
  sceneOf,
} from '../../gridfinity/types'
import { when } from '../../pb'
import { getActivePrinter } from '../../printers'
import LayerScrubber from '../LayerScrubber'
import ProgressCard from '../ProgressCard'
import BinEditor from './BinEditor'
import DrawerPanel, { GridFields } from './DrawerPanel'
import FilamentSlots from './FilamentSlots'
import PartsViewer from './PartsViewer'
import Planner from './Planner'
import ProjectList from './ProjectList'
import { KIND } from '../../gridfinity/kinds'

type View = 'layout' | 'bin' | 'drawer' | 'plate'

interface Props {
  me: Me
  active: boolean
  openId: string | null // a saved project to open (from #/gridfinity/<id>)
  version: string | null
  onSignIn: () => void
}

/** A new project set up for the printer in use: its bed and the filaments loaded in it. */
function forPrinter(p: GfProject): GfProject {
  const printer = getActivePrinter()
  if (!printer) return p
  return normaliseProject({
    ...p,
    filaments: printer.filaments.map((f) => ({ ...f })),
    plates: p.plates.map((pl) => ({ ...pl, drawer: { ...pl.drawer, bedX: printer.bedX, bedY: printer.bedY } })),
  })
}

/** Turn a bin a quarter: swap its size and compartments, and carry the labels with them. */
function rotated(b: BinDesign): BinDesign {
  const cols = b.divX + 1
  const rows = b.divY + 1
  const labels: string[] = []
  const icons: BinDesign['icons'] = []
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      // Compartment (row r, column c) becomes (row c, column rows-1-r).
      const i = c * rows + (rows - 1 - r)
      labels[i] = b.labels[r * cols + c] ?? ''
      icons[i] = b.icons[r * cols + c] ?? null
    }
  return { ...b, w: b.d, d: b.w, divX: b.divY, divY: b.divX, labels, icons }
}

const STYLE_KEYS = ['lip', 'wall', 'floor', 'base', 'holes', 'holesCorners', 'scoop', 'tab', 'tabWidth', 'tabDepth', 'pattern', 'hexSize', 'hexRib', 'labelStyle', 'labelSize', 'body', 'labelFilament'] as const

/** The Gridfinity tool: drawer projects, or a single bin or baseplate, with live 3D and 3MF export. */
export default function GridfinityStudio({ me, active, openId, version, onSignIn }: Props) {
  const [draft, setDraft] = useState<Draft | null>(loadDraft)
  const userId = me.user?.id ?? null
  const [error, setError] = useState<string | null>(null)
  const [opening, setOpening] = useState(false)
  const [listKey, setListKey] = useState(0)
  const [session, setSession] = useState(0) // a new editor for each project opened; saving keeps it
  const importInput = useRef<HTMLInputElement>(null)

  // Keep the working copy in this browser, saved or not.
  useEffect(() => {
    const t = setTimeout(() => saveDraft(draft), 300)
    return () => clearTimeout(t)
  }, [draft])

  const open = (d: Draft | null) => {
    setDraft(d)
    setSession((n) => n + 1)
    setError(null)
    window.history.replaceState(null, '', d?.recordId ? `#/gridfinity/${d.recordId}` : '#/gridfinity')
  }

  const unsaved = draft != null && JSON.stringify(draft.project) !== draft.savedJson
  const leave = () => !unsaved || window.confirm('This project has unsaved changes. Leave it anyway?')

  const start = (mode: ProjectMode) => {
    if (!leave()) return
    open({ project: forPrinter(newProject(undefined, mode)), recordId: null, store: null, savedJson: '' })
  }

  const openRecord = (r: ProjectRecord) => {
    if (draft?.recordId === r.id) return open(draft)
    if (!leave()) return
    open({ project: r.data, recordId: r.id, store: userId ? 'account' : 'local', savedJson: JSON.stringify(r.data) })
  }

  // Open a saved project named in the address.
  useEffect(() => {
    if (!openId || openId === draft?.recordId) return
    let alive = true
    setOpening(true)
    getProject(openId, userId)
      .then((r) => {
        if (!alive) return
        setDraft({ project: r.data, recordId: r.id, store: userId ? 'account' : 'local', savedJson: JSON.stringify(r.data) })
        setSession((n) => n + 1)
      })
      .catch(() => alive && setError('Could not open that project. It may have been deleted, or belong to another account.'))
      .finally(() => alive && setOpening(false))
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openId, userId])

  const importJson = async (file: File | undefined) => {
    if (!file) return
    try {
      const p = normaliseProject(JSON.parse(await file.text()))
      if (!leave()) return
      open({ project: p, recordId: null, store: null, savedJson: '' })
    } catch {
      setError('That file is not a LayerLift project.')
    }
  }

  if (!draft)
    return (
      <section className="page gf-home" hidden={!active} aria-labelledby="gf-home-h">
        <div className="page-head">
          <h2 id="gf-home-h">Gridfinity</h2>
          <p className="hint">Plan drawers of bins, or make a single bin or baseplate.</p>
          <button type="button" className="ghost" onClick={() => importInput.current?.click()}>
            <FileUp size={15} /> Import a file
          </button>
          <input ref={importInput} type="file" accept=".json,application/json" hidden onChange={(e) => importJson(e.target.files?.[0])} />
        </div>
        {error && <p className="hint danger">{error}</p>}
        {opening && <p className="hint">Opening…</p>}
        <div className="gf-start">
          {(['project', 'bin', 'plate'] as const).map((mode) => {
            const Icon = KIND[mode].icon
            return (
              <button key={mode} type="button" className="gf-start-tile" onClick={() => start(mode)}>
                <Icon size={30} strokeWidth={1.5} />
                <strong>{mode === 'project' ? 'New drawer project' : KIND[mode].label}</strong>
                <span>
                  {mode === 'project'
                    ? 'Baseplates for your drawers, and the bins on them.'
                    : mode === 'bin'
                      ? 'One bin to print on its own.'
                      : 'One baseplate, sized in cells or to a drawer.'}
                </span>
              </button>
            )
          })}
        </div>
        <h3 className="gf-home-sub">
          <FolderOpen size={15} /> {userId ? 'Saved projects' : 'Saved in this browser'}
        </h3>
        <ProjectList userId={userId} onOpen={openRecord} refreshKey={listKey} />
      </section>
    )

  return (
    <Studio
      key={session}
      draft={draft}
      setDraft={setDraft}
      me={me}
      userId={userId}
      active={active}
      version={version}
      unsaved={unsaved}
      onSignIn={onSignIn}
      onClose={() => {
        if (!leave()) return
        open(null)
        setListKey((n) => n + 1)
      }}
    />
  )
}

interface StudioProps {
  draft: Draft
  setDraft: React.Dispatch<React.SetStateAction<Draft | null>>
  me: Me
  userId: string | null
  active: boolean
  version: string | null
  unsaved: boolean
  onSignIn: () => void
  onClose: () => void
}

function Studio({ draft, setDraft, me, userId, active, version, unsaved, onSignIn, onClose }: StudioProps) {
  const project = draft.project
  const mode = project.mode
  const [plateId, setPlateId] = useState(project.plates[0].id)
  const plate = project.plates.find((p) => p.id === plateId) ?? project.plates[0]
  const scene = useMemo(() => sceneOf(project, plate.id), [project, plate.id])
  const [selected, setSelected] = useState<string[]>(() => (mode === 'plate' ? [] : plate.bins.slice(0, 1).map((b) => b.id)))
  const [view, setView] = useState<View>(mode === 'bin' ? 'bin' : mode === 'plate' ? 'plate' : 'layout')
  const [history, setHistory] = useState<{ past: GfProject[]; future: GfProject[] }>({ past: [], future: [] })
  const lastRecord = useRef<{ key: string; at: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [binView, setBinView] = useState<{ parts: ViewPart[]; volume: number; id: string } | null>(null)
  const [bigView, setBigView] = useState<ViewPart[]>([])
  const [insetView, setInsetView] = useState<ViewPart[]>([])
  const [building, setBuilding] = useState(false)
  const [exporting, setExporting] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState('')
  const [stl, setStl] = useState(false)
  const [clipZ, setClipZ] = useState<number | null>(null) // the layer slider's cut in 3D
  const [modelTop, setModelTop] = useState(0)
  const importInput = useRef<HTMLInputElement>(null)

  const grid = useMemo(() => drawerGrid(plate.drawer), [plate.drawer])
  useEffect(() => setClipZ(null), [view])
  const pieces = useMemo(() => platePieces(plate.drawer, grid), [plate.drawer, grid])
  const issues = useMemo(() => binIssues(scene, grid), [scene, grid])
  const problemIds = useMemo(() => new Set(issues.map((i) => i.id)), [issues])
  const chosen = plate.bins.filter((b) => selected.includes(b.id))
  const bin = chosen[0] ?? null

  // ---------------------------------------------------------------- edits + undo

  const setProject = (next: GfProject | ((p: GfProject) => GfProject)) =>
    setDraft((d) => (d ? { ...d, project: typeof next === 'function' ? next(d.project) : next } : d))

  /** Save the project before a change; changes with the same key within a second share a step. */
  const record = (key = '') => {
    const now = Date.now()
    const last = lastRecord.current
    lastRecord.current = { key, at: now }
    if (key && last?.key === key && now - last.at < 1000) return
    const snapshot = project
    setHistory((h) => ({ past: [...h.past.slice(-99), snapshot], future: [] }))
  }

  const edit = (fn: (p: GfProject) => GfProject, key = '') => {
    record(key)
    setProject(fn)
  }

  /** Change the current baseplate. */
  const editPlate = (fn: (p: Plate) => Plate, key = '') => edit((p) => ({ ...p, plates: p.plates.map((pl) => (pl.id === plate.id ? fn(pl) : pl)) }), key)

  const undo = () => {
    const prev = history.past[history.past.length - 1]
    if (!prev) return
    setHistory({ past: history.past.slice(0, -1), future: [project, ...history.future] })
    setProject(prev)
    lastRecord.current = null
  }
  const redo = () => {
    const next = history.future[0]
    if (!next) return
    setHistory({ past: [...history.past, project], future: history.future.slice(1) })
    setProject(next)
    lastRecord.current = null
  }

  const updateBins = (ids: string[], fn: (b: PlacedBin) => PlacedBin, key = '') =>
    editPlate((pl) => ({ ...pl, bins: pl.bins.map((b) => (ids.includes(b.id) ? fn(b) : b)) }), key)

  /** A change made in the editor applies to every selected bin (only the fields that changed). */
  const patchDesign = (patch: Partial<BinDesign>, key = '') => {
    if (!chosen.length) return
    updateBins(
      chosen.map((b) => b.id),
      (b) => ({ ...b, design: normaliseBin({ ...b.design, ...patch }, project.filaments.length) }),
      key ? `${selected.join(',')}-${key}` : '',
    )
    if (mode === 'bin' && (patch.w || patch.d))
      editPlate((pl) => ({ ...pl, drawer: { ...pl.drawer, cellsX: patch.w ?? pl.drawer.cellsX, cellsY: patch.d ?? pl.drawer.cellsY } }))
  }

  const template = (): BinDesign => bin?.design ?? plate.bins[plate.bins.length - 1]?.design ?? normaliseBin(undefined, project.filaments.length)

  const covered = (x: number, y: number, w: number, d: number, except?: string) =>
    plate.bins.some((b) => b.id !== except && x < b.x + b.design.w && b.x < x + w && y < b.y + b.design.d && b.y < y + d)

  const drawBin = (x: number, y: number, w: number, d: number) => {
    if (covered(x, y, w, d)) {
      setError('That space overlaps a bin. Drag across empty cells to add one.')
      return
    }
    const t = template()
    const placed: PlacedBin = { id: newId(), x, y, design: { ...t, w, d, divX: Math.min(t.divX, w * 3 - 1), labels: [], icons: [] } }
    editPlate((pl) => ({ ...pl, bins: [...pl.bins, placed] }))
    setSelected([placed.id])
    setError(null)
  }

  const addBin = () => {
    const t = template()
    const fits = freeSpot(scene, t.w, t.d, grid)
    const spot = fits ?? freeSpot(scene, 1, 1, grid)
    if (!spot) {
      setError('This baseplate is full. Make it bigger or remove a bin first.')
      return
    }
    drawBin(spot.x, spot.y, fits ? t.w : 1, fits ? t.d : 1)
  }

  const duplicate = () => {
    if (!chosen.length) return
    let bins = plate.bins
    const copies: PlacedBin[] = []
    for (const b of chosen) {
      const spot = freeSpot({ ...scene, bins }, b.design.w, b.design.d, grid)
      if (!spot) {
        setError(`No free ${b.design.w}×${b.design.d} space left for a copy.`)
        break
      }
      const copy = { id: newId(), x: spot.x, y: spot.y, design: b.design }
      copies.push(copy)
      bins = [...bins, copy]
    }
    if (!copies.length) return
    editPlate((pl) => ({ ...pl, bins: [...pl.bins, ...copies] }))
    setSelected(copies.map((c) => c.id))
  }

  const removeBins = (ids: string[]) => {
    editPlate((pl) => ({ ...pl, bins: pl.bins.filter((b) => !ids.includes(b.id)) }))
    setSelected((s) => s.filter((id) => !ids.includes(id)))
  }

  const rotate = () => {
    if (!chosen.length) return
    updateBins(
      chosen.map((b) => b.id),
      (b) => {
        const design = rotated(b.design)
        return { ...b, design, x: Math.max(0, Math.min(grid.nx - design.w, b.x)), y: Math.max(0, Math.min(grid.ny - design.d, b.y)) }
      },
    )
    if (mode === 'bin') editPlate((pl) => ({ ...pl, drawer: { ...pl.drawer, cellsX: pl.drawer.cellsY, cellsY: pl.drawer.cellsX } }))
  }

  const applyStyleToAll = () => {
    if (!bin) return
    const style = Object.fromEntries(STYLE_KEYS.map((k) => [k, bin.design[k]])) as Partial<BinDesign>
    editPlate((pl) => ({ ...pl, bins: pl.bins.map((b) => ({ ...b, design: normaliseBin({ ...b.design, ...style }, project.filaments.length) })) }))
  }

  const moveSelected = (dx: number, dy: number) => {
    const ids = chosen.map((b) => b.id)
    updateBins(ids, (b) => ({ ...b, x: Math.max(0, Math.min(grid.nx - b.design.w, b.x + dx)), y: Math.max(0, Math.min(grid.ny - b.design.d, b.y + dy)) }), `move-${ids.join(',')}`)
  }

  const selectBin = (id: string | null, additive: boolean) =>
    setSelected((cur) => (id == null ? [] : !additive ? [id] : cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]))

  // Baseplates.
  const addPlate = () => {
    const p = { ...newPlate(`Baseplate ${project.plates.length + 1}`), drawer: { ...plate.drawer } }
    edit((pr) => ({ ...pr, plates: [...pr.plates, p] }))
    setPlateId(p.id)
    setSelected([])
  }
  const duplicatePlate = () => {
    const p: Plate = { ...plate, id: newId(), name: `${plate.name} copy`, bins: plate.bins.map((b) => ({ ...b, id: newId() })) }
    edit((pr) => ({ ...pr, plates: [...pr.plates, p] }))
    setPlateId(p.id)
    setSelected([])
  }
  const removePlate = (id: string) => {
    if (project.plates.length <= 1) return
    const pl = project.plates.find((p) => p.id === id)!
    if (pl.bins.length && !window.confirm(`Delete "${pl.name}" and its ${pl.bins.length} bin${pl.bins.length === 1 ? '' : 's'}?`)) return
    edit((pr) => ({ ...pr, plates: pr.plates.filter((p) => p.id !== id) }))
    if (id === plate.id) {
      setPlateId(project.plates.find((p) => p.id !== id)!.id)
      setSelected([])
    }
  }

  const setFilaments = (next: GfFilament[], reindex?: (number | null)[]) => {
    const fix = (i: number) => Math.min(next.length - 1, reindex ? (reindex[i] ?? 0) : i)
    edit(
      (p) => ({
        ...p,
        filaments: next,
        plates: p.plates.map((pl) => ({
          ...pl,
          drawer: { ...pl.drawer, plateFilament: fix(pl.drawer.plateFilament) },
          bins: pl.bins.map((b) => ({ ...b, design: { ...b.design, body: fix(b.design.body), labelFilament: fix(b.design.labelFilament) } })),
        })),
      }),
      reindex ? '' : 'filaments',
    )
  }

  const used = project.filaments.map((_, i) =>
    project.plates.some((pl) => (mode !== 'bin' && pl.drawer.plateFilament === i) || pl.bins.some((b) => b.design.body === i || (b.design.tab !== 'none' && b.design.labelFilament === i))),
  )

  // ---------------------------------------------------------------- saving (manual)

  const save = async () => {
    if (saving) return
    setSaving(true)
    setError(null)
    try {
      // A project saved in this browser goes to the account (as a new record) once signed in.
      const where = userId ? 'account' : 'local'
      const id = draft.store === where ? draft.recordId : null
      const r = await putProject(id, userId, project)
      setSavedAt(r.updated)
      setDraft((d) => (d ? { ...d, recordId: r.id, store: where, savedJson: JSON.stringify(project) } : d))
      window.history.replaceState(null, '', `#/gridfinity/${r.id}`)
    } catch (e) {
      const status = (e as { status?: number }).status
      setError(status === 404 ? 'That project no longer exists. Save again to keep it as a new one.' : `Could not save: ${(e as Error).message}`)
      if (status === 404) setDraft((d) => (d ? { ...d, recordId: null, store: null } : d))
    } finally {
      setSaving(false)
    }
  }

  const exportJson = () => saveFile(`${project.title || 'gridfinity'}.layerlift.json`, new TextEncoder().encode(JSON.stringify({ layerlift: 'gridfinity', ...project }, null, 1)), 'application/json')

  const importJson = async (file: File | undefined) => {
    if (!file) return
    try {
      const p = normaliseProject(JSON.parse(await file.text()))
      if (unsaved && !window.confirm('This project has unsaved changes. Replace it anyway?')) return
      setDraft({ project: p, recordId: null, store: null, savedJson: '' })
      window.history.replaceState(null, '', '#/gridfinity')
    } catch {
      setError('That file is not a LayerLift project.')
    }
  }

  // ---------------------------------------------------------------- geometry

  const single = chosen.length === 1 ? bin : null
  // The selected bin, in the Bin view and in the layout's corner.
  const binKey = single ? JSON.stringify([single.design, project.filaments]) : ''
  useEffect(() => {
    if (!active || !single || (view !== 'layout' && view !== 'bin')) return
    let alive = true
    const t = setTimeout(() => {
      setBuilding(true)
      request({ kind: 'bin', scene, bin: single.id })
        .then((r) => alive && r.kind === 'parts' && setBinView({ parts: r.parts, volume: r.volume, id: single.id }))
        .catch((e) => alive && setError(`Could not build the preview: ${e.message}`))
        .finally(() => alive && setBuilding(false))
    }, 60)
    return () => {
      alive = false
      clearTimeout(t)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [binKey, single?.id, view, active])

  // The whole baseplate with its bins (Drawer view, and the layout's corner when no single bin is
  // selected), or the baseplate pieces pulled apart (Baseplate view).
  const wholeKey = JSON.stringify([plate.drawer, project.filaments, plate.bins])
  const wantInset = view === 'layout' && !single
  useEffect(() => {
    if (!active || (view !== 'drawer' && view !== 'plate' && !wantInset)) return
    let alive = true
    const kind = view === 'plate' ? 'plate' : 'drawer'
    const t = setTimeout(() => {
      setBuilding(true)
      request({ kind, scene })
        .then((r) => alive && r.kind === 'parts' && (view === 'layout' ? setInsetView(r.parts) : setBigView(r.parts)))
        .catch((e) => alive && setError(`Could not build the preview: ${e.message}`))
        .finally(() => alive && setBuilding(false))
    }, 120)
    return () => {
      alive = false
      clearTimeout(t)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view === 'plate' ? JSON.stringify([plate.drawer, project.filaments]) : wholeKey, view, active, wantInset])

  const download = async (what: 'bin' | 'plate' | 'all') => {
    setExporting(what)
    setError(null)
    try {
      const plates = what === 'all' ? project.plates : [plate]
      const r = await request({
        kind: 'export',
        title: project.title,
        filaments: project.filaments,
        plates: plates.map((p) => ({ name: p.name, drawer: p.drawer, bins: p.bins })),
        bins: what === 'bin' ? chosen.map((b) => b.id) : what === 'all' ? 'all' : [],
        plate: what !== 'bin',
        stl,
        forceZip: what === 'all' && mode === 'project',
        version: version ?? undefined,
      })
      if (r.kind === 'file') saveFile(r.name, r.data, r.name.endsWith('.zip') ? 'application/zip' : 'model/3mf')
    } catch (e) {
      setError(`Export failed: ${(e as Error).message}`)
    } finally {
      setExporting(null)
    }
  }

  // ---------------------------------------------------------------- keyboard

  const onKey = useRef<(e: KeyboardEvent) => void>(() => undefined)
  onKey.current = (e: KeyboardEvent) => {
    if (!active) return
    const mod = e.ctrlKey || e.metaKey
    const k = e.key.toLowerCase()
    if (mod && k === 's') {
      e.preventDefault()
      save()
      return
    }
    const t = e.target as HTMLElement | null
    if ((t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName))) || document.querySelector('dialog[open]')) return
    if (mod && k === 'z') {
      e.preventDefault()
      if (e.shiftKey) redo()
      else undo()
    } else if (mod && k === 'y') {
      e.preventDefault()
      redo()
    } else if (mode !== 'project') return
    else if (mod && k === 'd' && chosen.length) {
      e.preventDefault()
      duplicate()
    } else if (mod && k === 'a') {
      e.preventDefault()
      setSelected(plate.bins.map((b) => b.id))
    } else if (k === 'r' && !mod && chosen.length) rotate()
    else if (e.key === 'Escape') setSelected([])
    else if ((e.key === 'Delete' || e.key === 'Backspace') && chosen.length) {
      e.preventDefault()
      removeBins(chosen.map((b) => b.id))
    } else if (chosen.length && view === 'layout' && e.key.startsWith('Arrow')) {
      e.preventDefault()
      moveSelected(e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0, e.key === 'ArrowDown' ? -1 : e.key === 'ArrowUp' ? 1 : 0)
    }
  }
  useEffect(() => {
    const listener = (e: KeyboardEvent) => onKey.current(e)
    window.addEventListener('keydown', listener)
    return () => window.removeEventListener('keydown', listener)
  }, [])

  // ---------------------------------------------------------------- render

  const saveLabel = saving
    ? 'Saving…'
    : unsaved
      ? draft.recordId
        ? 'Unsaved changes'
        : 'Not saved yet'
      : `Saved ${draft.store === 'account' ? 'to your account' : 'in this browser'}${savedAt ? `, ${when(savedAt)}` : ''}`

  const binParts = binView && single && binView.id === single.id ? binView.parts : []
  const tabs: [View, string][] =
    mode === 'bin'
      ? [['bin', 'Bin in 3D']]
      : mode === 'plate'
        ? [['plate', 'Baseplate in 3D']]
        : [
            ['layout', 'Layout'],
            ['bin', 'Bin in 3D'],
            ['drawer', 'Drawer in 3D'],
            ['plate', 'Baseplate'],
          ]
  const KindIcon = KIND[mode].icon

  return (
    <main className="workspace gf" hidden={!active}>
      <aside className="col setup">
        <section className="panel" aria-labelledby="gf-project-h">
          <div className="panel-head">
            <h2 id="gf-project-h">
              <KindIcon size={14} /> {KIND[mode].label}
            </h2>
            <button type="button" className="ghost" onClick={onClose} title="Close and go back to the start">
              <FolderOpen size={15} /> Projects
            </button>
          </div>
          <input className="title-input" value={project.title} maxLength={120} onChange={(e) => edit((p) => ({ ...p, title: e.target.value }), 'title')} aria-label="Project name" />
          <p className={unsaved ? 'hint gf-unsaved' : 'hint'}>{saveLabel}</p>
          <div className="row wrap">
            <button type="button" className="solid" onClick={save} disabled={saving || (!unsaved && !!draft.recordId)} title="Save (Ctrl+S)">
              <Save size={15} /> Save
            </button>
            {me.accounts && !userId && (
              <button type="button" className="link" onClick={onSignIn}>
                Sign in to save to your account
              </button>
            )}
          </div>
          <div className="row wrap">
            <button type="button" className="ghost" onClick={exportJson} title="Download the project as a file">
              <Download size={15} /> Export
            </button>
            <button type="button" className="ghost" onClick={() => importInput.current?.click()} title="Open a project file">
              <FileUp size={15} /> Import
            </button>
            <input ref={importInput} type="file" accept=".json,application/json" hidden onChange={(e) => importJson(e.target.files?.[0])} />
          </div>
        </section>

        {mode === 'project' && (
          <section className="panel" aria-labelledby="gf-plates-h">
            <div className="panel-head">
              <h2 id="gf-plates-h">Baseplates</h2>
              <span className="row">
                <button type="button" className="icon" onClick={duplicatePlate} aria-label="Duplicate this baseplate" title="Duplicate this baseplate">
                  <Copy size={15} />
                </button>
                <button type="button" className="icon" onClick={addPlate} aria-label="Add a baseplate" title="Add a baseplate">
                  <Plus size={16} />
                </button>
              </span>
            </div>
            <ul className="gf-plate-list">
              {project.plates.map((pl) => {
                const g = drawerGrid(pl.drawer)
                const on = pl.id === plate.id
                return (
                  <li key={pl.id} className={on ? 'gf-plate on' : 'gf-plate'}>
                    <Grid3x3 size={15} aria-hidden />
                    {on ? (
                      <input value={pl.name} maxLength={80} aria-label="Baseplate name" onChange={(e) => editPlate((p) => ({ ...p, name: e.target.value }), `name-${pl.id}`)} />
                    ) : (
                      <button
                        type="button"
                        className="gf-plate-pick"
                        onClick={() => {
                          setPlateId(pl.id)
                          setSelected([])
                        }}
                      >
                        {pl.name}
                      </button>
                    )}
                    <span className="hint">
                      {g.nx}×{g.ny} · {pl.bins.length}
                    </span>
                    <button type="button" className="icon" onClick={() => removePlate(pl.id)} disabled={project.plates.length <= 1} aria-label={`Delete ${pl.name}`} title="Delete this baseplate">
                      <Trash2 size={14} />
                    </button>
                  </li>
                )
              })}
            </ul>
          </section>
        )}

        {mode !== 'bin' && (
          <DrawerPanel
            title={mode === 'plate' ? 'Baseplate' : 'Drawer'}
            drawer={plate.drawer}
            grid={grid}
            pieces={pieces}
            filaments={project.filaments}
            onChange={(patch, key) => editPlate((pl) => ({ ...pl, drawer: { ...pl.drawer, ...patch } }), key)}
          />
        )}
        {mode === 'bin' && (
          <section className="panel" aria-labelledby="gf-grid-h">
            <div className="panel-head">
              <h2 id="gf-grid-h">Grid</h2>
            </div>
            <GridFields drawer={plate.drawer} onChange={(patch, key) => editPlate((pl) => ({ ...pl, drawer: { ...pl.drawer, ...patch } }), key)} />
          </section>
        )}
        <FilamentSlots filaments={project.filaments} used={used} onChange={setFilaments} />
      </aside>

      <section className="stage" aria-label="Preview">
        <div className="tabs" role="tablist">
          {tabs.map(([v, label]) => (
            <button key={v} type="button" role="tab" aria-selected={view === v} className={view === v ? 'tab on' : 'tab'} disabled={v === 'bin' && !single} onClick={() => setView(v)}>
              {label}
            </button>
          ))}
          {building && (
            <span className="gf-building" aria-live="polite">
              Updating…
            </span>
          )}
          <span className="undo-redo">
            <button type="button" className="ghost" onClick={undo} disabled={!history.past.length} title="Undo (Ctrl+Z)">
              <Undo2 size={15} /> Undo
            </button>
            <button type="button" className="ghost" onClick={redo} disabled={!history.future.length} title="Redo (Ctrl+Y)">
              <Redo2 size={15} /> Redo
            </button>
          </span>
        </div>

        {error && (
          <div className="error" role="alert">
            <span>{error}</span>
            <button type="button" className="icon" onClick={() => setError(null)} aria-label="Dismiss">
              <X size={16} />
            </button>
          </div>
        )}

        <div className="canvas-area gf-canvas">
          {view === 'layout' && (
            <div className="gf-layout">
              <Planner
                project={scene}
                grid={grid}
                pieces={pieces ?? []}
                selected={selected}
                problems={problemIds}
                onSelect={selectBin}
                onDraw={drawBin}
                onMove={(id, x, y) => updateBins([id], (b) => ({ ...b, x, y }))}
                onResize={(id, w, d) => updateBins([id], (b) => ({ ...b, design: normaliseBin({ ...b.design, w, d }, project.filaments.length) }))}
              />
              <div className="gf-inset" aria-label={single ? 'Selected bin in 3D' : 'Baseplate and bins in 3D'}>
                {single
                  ? binParts.length > 0 && <PartsViewer parts={binParts} fitKey={`${single.id}-${single.design.w}-${single.design.d}-${single.design.h}`} />
                  : insetView.length > 0 && <PartsViewer parts={insetView} fitKey={`whole-${plate.id}-${grid.width}-${grid.depth}`} selected={null} />}
                <button type="button" className="gf-inset-open ghost" onClick={() => setView(single ? 'bin' : 'drawer')}>
                  <Box size={13} /> Open in 3D
                </button>
              </div>
            </div>
          )}
          {view === 'bin' &&
            (single ? (
              <PartsViewer parts={binParts} fitKey={`bin-${single.id}-${single.design.w}-${single.design.d}-${single.design.h}`} clipZ={clipZ} onHeight={setModelTop} />
            ) : (
              <p className="canvas-note">Select one bin to see it on its own.</p>
            ))}
          {(view === 'drawer' || view === 'plate') && (
            <PartsViewer
              parts={bigView}
              fitKey={`${view}-${plate.id}-${grid.width}-${grid.depth}`}
              selected={view === 'drawer' && single ? single.id : null}
              onPick={view === 'drawer' ? (g) => (g && !g.startsWith('plate-') ? setSelected([g]) : setSelected([])) : undefined}
              drag={
                view === 'drawer'
                  ? {
                      cell: grid.pitch,
                      canDrag: (g) => !g.startsWith('plate-'),
                      onDrop: (id, dx, dy) => {
                        setSelected([id])
                        updateBins([id], (b) => ({
                          ...b,
                          x: Math.max(0, Math.min(grid.nx - b.design.w, b.x + dx)),
                          y: Math.max(0, Math.min(grid.ny - b.design.d, b.y + dy)),
                        }))
                      },
                    }
                  : undefined
              }
              clipZ={clipZ}
              onHeight={setModelTop}
            />
          )}
          {view !== 'layout' && <LayerScrubber height={modelTop} layer={0.2} value={clipZ} onChange={setClipZ} />}
          {exporting && <ProgressCard title="Making the files" progress={null} />}
        </div>

        <div className="buildbar gf-bar">
          <p className="hint">
            {view === 'layout'
              ? plate.bins.length
                ? `${plate.bins.length} bin${plate.bins.length === 1 ? '' : 's'}, ${freeCells(scene, grid)} free cell${freeCells(scene, grid) === 1 ? '' : 's'}. Shift-click to select several; R rotates.`
                : 'Drag across the grid to add a bin.'
              : view === 'plate'
                ? pieces
                  ? `${pieces.length} piece${pieces.length === 1 ? '' : 's'}${pieces.length > 1 ? ', pulled apart to show the joins' : ''}.`
                  : 'The baseplate does not fit the bed.'
                : view === 'drawer'
                  ? 'Drag a bin to move it; drag elsewhere to orbit.'
                  : 'Drag to orbit, scroll to zoom.'}
            {pieces && clipCount(plate.drawer, pieces) > 0 && ` Downloads include ${clipCount(plate.drawer, pieces)} clips.`}
          </p>
          <label className="check">
            <input type="checkbox" checked={stl} onChange={(e) => setStl(e.target.checked)} />
            Add STL files
          </label>
          {mode === 'project' ? (
            <>
              <button type="button" className="ghost" onClick={() => download('bin')} disabled={!chosen.length || exporting != null}>
                <Box size={15} /> {chosen.length > 1 ? `These ${chosen.length} bins` : 'This bin'}
              </button>
              <button type="button" className="ghost" onClick={() => download('plate')} disabled={!pieces || exporting != null}>
                <Grid3x3 size={15} /> This baseplate
              </button>
              <button type="button" className="primary big" onClick={() => download('all')} disabled={exporting != null}>
                <Download size={17} /> {project.plates.length > 1 ? 'Download all baseplates' : 'Download all'}
              </button>
            </>
          ) : (
            <button type="button" className="primary big" onClick={() => download(mode === 'bin' ? 'bin' : 'plate')} disabled={exporting != null || (mode === 'plate' && !pieces)}>
              <Download size={17} /> Download 3MF
            </button>
          )}
        </div>
      </section>

      {mode !== 'plate' && (
        <aside className="col info">
          {bin ? (
            <BinEditor
              key={chosen.map((b) => b.id).join(',')}
              design={bin.design}
              count={chosen.length}
              standalone={mode === 'bin'}
              grid={gridSpec(plate.drawer)}
              filaments={project.filaments}
              volume={single && binView?.id === single.id ? binView.volume : null}
              onChange={patchDesign}
              onApplyToAll={applyStyleToAll}
              onDuplicate={duplicate}
              onRotate={rotate}
              onDelete={() => removeBins(chosen.map((b) => b.id))}
              onError={setError}
            />
          ) : (
            <section className="panel quiet">
              <h2>No bin selected</h2>
              <p className="hint">Click a bin to edit it, or shift-click to edit several at once. The corner shows the whole baseplate.</p>
            </section>
          )}
          {mode === 'project' && (
            <section className="panel" aria-labelledby="gf-bins-h">
              <div className="panel-head">
                <h2 id="gf-bins-h">Bins</h2>
                <button type="button" className="ghost" onClick={addBin}>
                  <Plus size={15} /> Add a bin
                </button>
              </div>
              {plate.bins.length === 0 ? (
                <p className="hint">No bins yet.</p>
              ) : (
                <ul className="gf-bin-list">
                  {plate.bins.map((b) => {
                    const bad = issues.filter((i) => i.id === b.id)
                    const on = selected.includes(b.id)
                    return (
                      <li key={b.id}>
                        <button type="button" className={on ? 'gf-bin-row on' : 'gf-bin-row'} onClick={(e) => selectBin(b.id, e.shiftKey || e.ctrlKey || e.metaKey)} aria-pressed={on}>
                          <i className="chip" style={{ background: project.filaments[b.design.body]?.hex }} />
                          <strong>{binSize(b.design)}</strong>
                          <span className="gf-bin-labels">{b.design.labels.filter(Boolean).join(', ') || 'No label'}</span>
                          {bad.length > 0 && (
                            <span className="gf-bad" title={bad.map((i) => i.message).join(' ')}>
                              {bad[0].message}
                            </span>
                          )}
                        </button>
                      </li>
                    )
                  })}
                </ul>
              )}
            </section>
          )}
        </aside>
      )}
    </main>
  )
}


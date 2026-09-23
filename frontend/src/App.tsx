import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  type Analysis,
  type AnalysisOptions,
  ApiError,
  type BuildResult,
  type BuildSettings,
  type BuildStatus,
  type Filament,
  type Me,
  type RegionOverride,
  analyse,
  buildWithProgress,
  getConfig,
  getMe,
  getSession,
  suggestMapping,
} from './api'
import { boot } from './bootstrap'
import { pb } from './pb'
import { fmt, loadCurrentPalette, snap, storeCurrentPalette } from './palettes'
import { type Edits, filamentOf, mergeAll, mergeOverride, withOverride } from './edits'
import { makePlan } from './plan'
import AccountMenu from './components/AccountMenu'
import AdminPage from './components/AdminPage'
import AuthDialog from './components/AuthDialog'
import ColourList from './components/ColourList'
import MyBuilds from './components/MyBuilds'
import FilamentEditor from './components/FilamentEditor'
import Footer from './components/Footer'
import HumanCheck from './components/HumanCheck'
import LayerStack from './components/LayerStack'
import MappingCanvas from './components/MappingCanvas'
import ProgressCard from './components/ProgressCard'
import RegionInspector from './components/RegionInspector'
import Results from './components/Results'
import SizeDepth from './components/SizeDepth'
import SpeckCleanup from './components/SpeckCleanup'
import Splash from './components/Splash'
import Wordmark from './components/Wordmark'

// three.js is large; load it only when the 3D view is first opened.
const Viewer3D = lazy(() => import('./components/Viewer3D'))

type View = 'map' | 'original' | '3d' | 'relief'
type Options = Omit<BuildSettings, 'analysis' | 'filaments' | 'mapping' | 'cluster_heights' | 'region_overrides'>

const ACCEPT = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml']
type Page = 'editor' | 'builds' | 'admin'

function pageFromHash(): Page {
  const h = window.location.hash
  return h.startsWith('#/builds') ? 'builds' : h.startsWith('#/admin') ? 'admin' : 'editor'
}

const DEFAULT_OPTIONS: Options = {
  title: 'LayerLift relief',
  width_mm: 100,
  size_mode: 'width',
  nozzle_mm: 0.4,
  layer_mm: 0.2,
  base_mm: 2.0,
  height_mode: 'manual',
  lighter_taller: true,
  base_filament: null,
  mirror: false,
  strategy: 'detailed',
}

function remapIndex(map: (number | null)[], i: number | null | undefined): number | null {
  return i == null ? null : (map[i] ?? null)
}

export default function App() {
  const [filaments, setFilaments] = useState<Filament[]>(loadCurrentPalette)
  const [file, setFile] = useState<File | null>(null)
  const [imageUrl, setImageUrl] = useState('')
  const [analysis, setAnalysis] = useState<Analysis | null>(null)
  const [analysisOpts, setAnalysisOpts] = useState<AnalysisOptions>({ background: { mode: 'auto' }, max_colours: 12, n_colours: null })
  const [mapping, setMapping] = useState<number[]>([])
  const [locked, setLocked] = useState<Record<number, number>>({})
  const [regionOverrides, setRegionOverrides] = useState<Record<number, RegionOverride>>({})
  const [clusterHeights, setClusterHeights] = useState<Record<number, number>>({})
  const [options, setOptions] = useState<Options>(DEFAULT_OPTIONS)
  const [selected, setSelected] = useState<number[]>([])
  const [history, setHistory] = useState<{ past: Edits[]; future: Edits[] }>({ past: [], future: [] })
  const lastRecord = useRef<{ key: string; at: number } | null>(null)
  const [busy, setBusy] = useState<'analysing' | 'building' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<BuildResult | null>(null)
  const [status, setStatus] = useState<BuildStatus | null>(null)
  const [builtKey, setBuiltKey] = useState('')
  const [view, setView] = useState<View>('map')
  const [explode, setExplode] = useState(0)
  const [liftFilament, setLiftFilament] = useState<number | null>(null) // colour picked for dragging in 3D
  const [dragging, setDragging] = useState(false)
  const [version, setVersion] = useState<string | null>(boot?.version ?? null)
  const [me, setMe] = useState<Me | null>(null)
  // The loading screen stays until the server has confirmed the account: nothing is guessed.
  const [loading, setLoading] = useState<'loading' | 'error' | 'leaving' | 'done'>('loading')
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [authOpen, setAuthOpen] = useState(false)
  const [page, setPage] = useState<Page>(pageFromHash)
  const [gate, setGate] = useState<{ required: boolean; verified: boolean; siteKey: string | null }>({
    required: false,
    verified: true,
    siteKey: boot?.turnstile_site_key ?? null,
  })
  const fileInput = useRef<HTMLInputElement>(null)
  const buildAbort = useRef<AbortController | null>(null)

  const settings: BuildSettings = useMemo(
    () => ({
      ...options,
      analysis: analysisOpts,
      filaments,
      mapping,
      cluster_heights: clusterHeights,
      region_overrides: regionOverrides,
    }),
    [options, analysisOpts, filaments, mapping, clusterHeights, regionOverrides],
  )
  const settingsKey = useMemo(() => JSON.stringify(settings), [settings])
  const stale = result != null && builtKey !== settingsKey
  const plan = useMemo(() => (analysis && mapping.length === analysis.clusters.length ? makePlan(analysis, mapping, settings) : null), [analysis, mapping, settings])

  // ---------------------------------------------------------------- human check

  useEffect(() => {
    if (boot) return // the page already carried the version
    getConfig()
      .then((c) => setVersion(c.version))
      .catch(() => undefined)
  }, [])

  // First load: the account, its limits and the human-check state, all from the server, before
  // the loading screen lifts. A slow or unreachable server gets an error with a retry button.
  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    setLoading('loading')
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('timeout')), 15_000)
    })
    Promise.race([Promise.all([getMe(), getSession()]), timeout])
      .then(([m, s]) => {
        if (!alive) return
        setMe(m)
        setGate({ required: s.required, verified: s.verified, siteKey: s.site_key })
        setLoading('leaving')
        timer = setTimeout(() => alive && setLoading('done'), 220) // after the fade
      })
      .catch(() => alive && setLoading('error'))
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [loadAttempt])

  // Afterwards the account is re-read whenever the sign-in changes, and on every page change so
  // a new role or tier shows without a reload.
  useEffect(() => {
    const refresh = () => {
      getMe()
        .then(setMe)
        .catch(() => undefined)
      getSession()
        .then((s) => setGate({ required: s.required, verified: s.verified, siteKey: s.site_key }))
        .catch(() => undefined)
    }
    // A stored sign-in may be stale (role or tier changed, account deleted): renew it once.
    if (pb.authStore.isValid) {
      pb.collection('users')
        .authRefresh()
        .catch((e) => e?.status === 401 && pb.authStore.clear())
    }
    const onHash = () => refresh()
    window.addEventListener('hashchange', onHash)
    const stop = pb.authStore.onChange(refresh)
    return () => {
      stop()
      window.removeEventListener('hashchange', onHash)
    }
  }, [])

  useEffect(() => {
    const onHash = () => setPage(pageFromHash())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  const maxMb = me?.limits.max_upload_mb ?? 10
  const needsCheck = gate.required && !gate.verified
  const onVerified = useCallback(() => setGate((g) => ({ ...g, verified: true })), [])

  const fail = useCallback((e: unknown) => {
    if (e instanceof ApiError && e.code === 'verification_required') {
      setGate((g) => ({ ...g, verified: false }))
      setError("Your session has expired. Confirm you're human again, then retry.")
    } else {
      setError(e instanceof ApiError ? e.message : 'Could not reach the LayerLift server.')
    }
  }, [])

  // ---------------------------------------------------------------- image + analysis

  const runAnalysis = useCallback(
    async (f: File, opts: AnalysisOptions) => {
      setBusy('analysing')
      setError(null)
      try {
        const a = await analyse(f, opts, filaments)
        setAnalysis(a)
        setMapping(a.suggested_mapping ?? a.clusters.map(() => 0))
        setLocked({})
        setRegionOverrides({})
        setClusterHeights({})
        setSelected([])
        setHistory({ past: [], future: [] })
        setResult(null)
        setView('map')
      } catch (e) {
        fail(e)
      } finally {
        setBusy(null)
      }
    },
    [filaments, fail],
  )

  const acceptFile = (f: File | undefined) => {
    if (!f) return
    if (needsCheck) {
      setError("Confirm you're human first, then choose your image again.")
      return
    }
    if (!ACCEPT.includes(f.type) && !/\.(png|jpe?g|webp|svg)$/i.test(f.name)) {
      setError('Use a PNG, JPEG, WebP or SVG image.')
      return
    }
    if (f.size > maxMb * 1024 * 1024) {
      const more = me?.accounts && !me.user ? ' Sign in for larger uploads.' : ''
      setError(`That file is ${(f.size / 1024 / 1024).toFixed(1)} MB. The limit is ${maxMb} MB.${more}`)
      return
    }
    if (imageUrl) URL.revokeObjectURL(imageUrl)
    setFile(f)
    setImageUrl(URL.createObjectURL(f))
    setOptions((o) => ({ ...o, title: f.name.replace(/\.[^.]+$/, '').replace(/[_+-]+/g, ' ').trim() || 'LayerLift relief' }))
    runAnalysis(f, analysisOpts)
  }

  const loadSample = async () => {
    const blob = await (await fetch('/sample-space-turtles.png')).blob()
    acceptFile(new File([blob], 'Space Turtles.png', { type: 'image/png' }))
  }

  // ---------------------------------------------------------------- mapping

  // Re-balance the automatic part of the mapping whenever filament colours or pins change.
  const mappingInputs = JSON.stringify([filaments.map((f) => f.hex), locked])
  useEffect(() => {
    if (!analysis) return
    const timer = setTimeout(() => {
      suggestMapping(analysis, filaments, locked)
        .then(setMapping)
        .catch(() => undefined)
    }, 250)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analysis, mappingInputs])

  const onFilaments = (next: Filament[], reindex?: (number | null)[]) => {
    if (reindex) {
      const fix = (i: number | null | undefined) => remapIndex(reindex, i)
      setMapping((m) => m.map((i) => fix(i) ?? 0))
      setLocked((l) => Object.fromEntries(Object.entries(l).flatMap(([c, i]) => (fix(i) == null ? [] : [[c, fix(i)!]]))))
      setRegionOverrides((ro) =>
        Object.fromEntries(Object.entries(ro).map(([r, o]) => [r, { ...o, filament: o.filament == null ? null : fix(o.filament) }])),
      )
      setOptions((o) => ({ ...o, base_filament: fix(o.base_filament) }))
      setHistory({ past: [], future: [] })
    } else if (next.some((f, i) => f.height_mm !== filaments[i]?.height_mm)) {
      record('filament-heights') // typed heights share one undo step while typing
    }
    setFilaments(next)
    storeCurrentPalette(next)
  }

  // ---------------------------------------------------------------- edits + undo

  const snapshot = (): Edits => ({
    mapping,
    locked,
    regionOverrides,
    clusterHeights,
    heights: filaments.map((f) => f.height_mm),
    heightMode: options.height_mode,
  })

  /**
   * Save the current edits before changing them. Calls with the same ``key`` less than a second apart
   * (typing a height, say) share one undo step.
   */
  const record = (key = '') => {
    const now = Date.now()
    const last = lastRecord.current
    lastRecord.current = { key, at: now }
    if (key && last?.key === key && now - last.at < 1000) return
    const current = snapshot()
    setHistory((h) => ({ past: [...h.past.slice(-99), current], future: [] }))
  }

  const restore = (e: Edits) => {
    setMapping(e.mapping)
    setLocked(e.locked)
    setRegionOverrides(e.regionOverrides)
    setClusterHeights(e.clusterHeights)
    if (e.heights.length === filaments.length) {
      const next = filaments.map((f, i) => ({ ...f, height_mm: e.heights[i] ?? null }))
      setFilaments(next)
      storeCurrentPalette(next)
    }
    setOptions((o) => ({ ...o, height_mode: e.heightMode }))
    lastRecord.current = null
  }

  /**
   * A colour was dragged to new heights in 3D (stacked: the bands above move with it). The tops
   * become the filaments' heights; heights set by brightness are frozen as they are first.
   */
  const commitHeights = (tops: Record<number, number>) => {
    if (!plan) return
    record()
    const frozen = options.height_mode !== 'manual'
    const next = filaments.map((f, i) => ({ ...f, height_mm: tops[i] ?? (frozen ? plan.heights[i] : f.height_mm) }))
    if (frozen) setOptions((o) => ({ ...o, height_mode: 'manual' }))
    setFilaments(next)
    storeCurrentPalette(next)
  }

  const undo = () => {
    const prev = history.past[history.past.length - 1]
    if (!prev) return
    setHistory({ past: history.past.slice(0, -1), future: [snapshot(), ...history.future] })
    restore(prev)
  }

  const redo = () => {
    const next = history.future[0]
    if (!next) return
    setHistory({ past: [...history.past, snapshot()], future: history.future.slice(1) })
    restore(next)
  }

  const assignCluster = (cluster: number, fil: number | null) => {
    record()
    setLocked((l) => {
      const next = { ...l }
      if (fil == null) delete next[cluster]
      else next[cluster] = fil
      return next
    })
    if (fil != null) setMapping((m) => m.map((v, i) => (i === cluster ? fil : v)))
  }

  /** Change the same fields on several regions. */
  const updateRegions = (regions: number[], patch: RegionOverride, key = '') => {
    record(key)
    setRegionOverrides((ro) => regions.reduce((acc, id) => withOverride(acc, id, { ...acc[id], ...patch }), ro))
  }

  /** Leave areas out of the print (or put them back). */
  const setRemoved = (regions: number[], removed: boolean) => updateRegions(regions, { removed })

  const filamentHeight = (fil: number) => plan?.baseHeights[fil] ?? 0

  const mergeRegions = (regions: number[]) => {
    if (!analysis) return
    record()
    setRegionOverrides((ro) => mergeAll(analysis, mapping, ro, clusterHeights, filamentHeight, regions))
  }

  const removedCount = useMemo(() => Object.values(regionOverrides).filter((o) => o.removed).length, [regionOverrides])

  const setClusterFilament = (cluster: number, fil: number) => {
    assignCluster(cluster, fil)
    setRegionOverrides((ro) => {
      const next: Record<number, RegionOverride> = {}
      for (const [k, o] of Object.entries(ro)) {
        const r = analysis!.regions[Number(k)]
        const cleared = r.cluster === cluster ? { ...o, filament: null } : o
        if (cleared.filament != null || cleared.height_mm != null || cleared.removed) next[Number(k)] = cleared
      }
      return next
    })
  }

  const setClusterHeight = (cluster: number, h: number | null) => {
    record(`cluster-height-${cluster}`)
    setClusterHeights((ch) => {
      const next = { ...ch }
      if (h == null) delete next[cluster]
      else next[cluster] = h
      return next
    })
  }

  /** Click on the map: select one region, or with a modifier add/remove it from the selection. */
  const selectRegion = (id: number | null, additive: boolean) =>
    setSelected((cur) => {
      if (id == null) return additive ? cur : []
      if (!additive) return [id]
      return cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]
    })

  const regionColours = useMemo(() => {
    if (!analysis) return []
    return analysis.regions.map((r) =>
      regionOverrides[r.id]?.removed ? null : (filaments[regionOverrides[r.id]?.filament ?? mapping[r.cluster]]?.hex ?? '#FF00FF'),
    )
  }, [analysis, filaments, mapping, regionOverrides])

  // ---------------------------------------------------------------- build

  const runBuild = async () => {
    if (!file || !analysis) return
    buildAbort.current?.abort()
    const ctrl = new AbortController()
    buildAbort.current = ctrl
    setBusy('building')
    setError(null)
    const key = settingsKey
    setStatus(null)
    try {
      const r = await buildWithProgress(file, settings, setStatus, ctrl.signal)
      setResult(r)
      setBuiltKey(key)
      setView('3d')
    } catch (e) {
      if ((e as Error).name === 'AbortError') return
      fail(e)
    } finally {
      if (buildAbort.current === ctrl) {
        setBusy(null)
        setStatus(null)
      }
    }
  }

  const usedFilaments = useMemo(() => filaments.map((_, i) => (plan ? plan.bands.some((b) => b.filament === i) : true)), [filaments, plan])
  const selectedIds = analysis ? selected.filter((id) => id < analysis.regions.length) : []
  const canMerge =
    analysis != null && selectedIds.some((id) => mergeOverride(analysis, mapping, regionOverrides, clusterHeights, filamentHeight, id) != null)

  // Keyboard: Escape clears the selection, Delete/Backspace removes (or restores) it, Ctrl+Z / Ctrl+Y undo and redo.
  // The listener is registered once and calls the latest handlers through a ref.
  const onKey = useRef<(e: KeyboardEvent) => void>(() => undefined)
  onKey.current = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement | null
    if (t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName))) return
    if (page !== 'editor' || authOpen) return
    const mod = e.ctrlKey || e.metaKey
    if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault()
      if (e.shiftKey) redo()
      else undo()
    } else if (mod && e.key.toLowerCase() === 'y') {
      e.preventDefault()
      redo()
    } else if (e.key === 'Escape') setSelected([])
    else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedIds.length && view === 'map') {
      e.preventDefault()
      setRemoved(selectedIds, !selectedIds.every((id) => regionOverrides[id]?.removed))
    }
  }
  useEffect(() => {
    const listener = (e: KeyboardEvent) => onKey.current(e)
    window.addEventListener('keydown', listener)
    return () => window.removeEventListener('keydown', listener)
  }, [])

  const regionTooltip = (id: number) => {
    const r = analysis!.regions[id]
    const o = regionOverrides[id]
    const fil = filaments[o?.filament ?? mapping[r.cluster]]
    const mm2 = r.area * (plan?.mmPerPx ?? 0) ** 2
    const top = plan?.regionTop[id]
    return (
      <>
        <strong>
          {o?.removed ? (
            'Removed'
          ) : (
            <>
              <i className="chip" style={{ background: fil?.hex }} /> {fil?.name ?? 'No filament'}
            </>
          )}
        </strong>
        {!o?.removed && top != null && <span>Top at {fmt(top)} mm</span>}
        <span>{mm2 >= 0.05 ? `About ${fmt(mm2)} mm²` : `${r.area.toLocaleString()} px`}</span>
        {o?.filament != null && !o.removed && <span>Own filament, not the colour's</span>}
      </>
    )
  }

  // ---------------------------------------------------------------- render

  return (
    <div className="app">
      {loading !== 'done' && <Splash state={loading === 'leaving' ? 'leaving' : loading} onRetry={() => setLoadAttempt((n) => n + 1)} />}
      <header className="topbar">
        <h1 className="brand">
          <Wordmark />
        </h1>
        <p>Flat-colour artwork in, multi-colour relief out, sliced by colour for your AMS.</p>
        {me && <AccountMenu me={me} onSignIn={() => setAuthOpen(true)} />}
      </header>

      {error && (
        <div className="error" role="alert">
          <span>{error}</span>
          <button type="button" className="icon" onClick={() => setError(null)} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}

      {me && <AuthDialog open={authOpen} onClose={() => setAuthOpen(false)} />}
      {page === 'builds' && me && <MyBuilds me={me} onSignIn={() => setAuthOpen(true)} />}
      {page === 'admin' && me && <AdminPage me={me} />}
      <main className="workspace" hidden={page !== 'editor'}>
        <aside className="col setup">
          <section className="panel" aria-labelledby="image-h">
            <div className="panel-head">
              <h2 id="image-h">Image</h2>
            </div>
            {file ? (
              <div className="file-row">
                <img src={imageUrl} alt="" className="thumb" />
                <div>
                  <input
                    className="title-input"
                    value={options.title}
                    maxLength={80}
                    onChange={(e) => setOptions((o) => ({ ...o, title: e.target.value }))}
                    aria-label="Project name"
                  />
                  <div className="hint">
                    {file.name}
                    {analysis && `, ${analysis.original_size[0]}×${analysis.original_size[1]} px`}
                  </div>
                </div>
              </div>
            ) : (
              <p className="hint">PNG, JPEG, WebP or SVG up to {maxMb} MB. Logos, badges and icons with flat colours work best.</p>
            )}
            {needsCheck && analysis && gate.siteKey && <HumanCheck siteKey={gate.siteKey} onVerified={onVerified} />}
            <div className="row wrap">
              <button type="button" className={file ? 'ghost' : 'primary'} onClick={() => fileInput.current?.click()} disabled={needsCheck}>
                {file ? 'Replace image' : 'Choose image'}
              </button>
              {!file && (
                <button type="button" className="ghost" onClick={loadSample} disabled={needsCheck}>
                  Try the sample
                </button>
              )}
            </div>
            <input ref={fileInput} type="file" accept={ACCEPT.join(',')} hidden onChange={(e) => acceptFile(e.target.files?.[0])} />
            <div className="grid2 detect">
              <label className="num">
                <span>Background</span>
                <select
                  value={analysisOpts.background.mode}
                  onChange={(e) => setAnalysisOpts((o) => ({ ...o, background: { ...o.background, mode: e.target.value as AnalysisOptions['background']['mode'] } }))}
                >
                  <option value="auto">Automatic</option>
                  <option value="alpha">Transparency</option>
                  <option value="colour">A colour</option>
                  <option value="none">None (keep all)</option>
                </select>
              </label>
              {analysisOpts.background.mode === 'colour' ? (
                <label className="num">
                  <span>Background colour</span>
                  <input
                    type="color"
                    value={(analysisOpts.background.colour ?? '#ffffff').toLowerCase()}
                    onChange={(e) => setAnalysisOpts((o) => ({ ...o, background: { ...o.background, colour: e.target.value.toUpperCase() } }))}
                  />
                </label>
              ) : (
                <label className="num">
                  <span>Colours to find</span>
                  <select
                    value={analysisOpts.n_colours ?? ''}
                    onChange={(e) => setAnalysisOpts((o) => ({ ...o, n_colours: e.target.value === '' ? null : Number(e.target.value) }))}
                  >
                    <option value="">Automatic</option>
                    {Array.from({ length: 11 }, (_, i) => i + 2).map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
            {file && (
              <button type="button" className="ghost" onClick={() => runAnalysis(file, analysisOpts)} disabled={busy != null}>
                Detect colours again
              </button>
            )}
          </section>

          <FilamentEditor
            filaments={filaments}
            layer={options.layer_mm}
            base={options.base_mm}
            manualHeights={options.height_mode === 'manual'}
            bedStarts={options.strategy === 'detailed'}
            autoHeights={plan?.heights ?? []}
            used={usedFilaments}
            onChange={onFilaments}
          />
          <SizeDepth s={settings} filaments={filaments} onChange={(patch) => setOptions((o) => ({ ...o, ...patch }))} />
        </aside>

        <section className="stage" aria-label="Preview">
          <div className="tabs" role="tablist">
            {(
              [
                ['map', 'Colour map'],
                ['original', 'Original'],
                ['3d', '3D model'],
                ['relief', 'Top view'],
              ] as [View, string][]
            ).map(([v, label]) => (
              <button
                key={v}
                type="button"
                role="tab"
                aria-selected={view === v}
                className={view === v ? 'tab on' : 'tab'}
                disabled={(v === '3d' || v === 'relief') && !result}
                onClick={() => setView(v)}
              >
                {label}
              </button>
            ))}
            {analysis && (view === 'map' || view === 'original') && (
              <span className="undo-redo">
                <button type="button" className="ghost" onClick={undo} disabled={!history.past.length} title="Undo (Ctrl+Z)">
                  ↶ Undo
                </button>
                <button type="button" className="ghost" onClick={redo} disabled={!history.future.length} title="Redo (Ctrl+Y)">
                  ↷ Redo
                </button>
              </span>
            )}
            {view === '3d' && result && (
              <label className="explode">
                <span>Separate layers</span>
                <input type="range" min={0} max={1} step={0.01} value={explode} onChange={(e) => setExplode(Number(e.target.value))} />
              </label>
            )}
          </div>

          <div
            className={dragging ? 'canvas-area dragging' : 'canvas-area'}
            onClick={(e) => e.target === e.currentTarget && setSelected([])}
            onDragOver={(e) => {
              e.preventDefault()
              setDragging(true)
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault()
              setDragging(false)
              acceptFile(e.dataTransfer.files?.[0])
            }}
          >
            {!analysis && busy !== 'analysing' && (
              <div className="empty">
                <svg viewBox="0 0 240 120" className="empty-art" aria-hidden>
                  <rect x="20" y="92" width="200" height="16" rx="2" fill="currentColor" />
                  <rect x="44" y="74" width="152" height="16" rx="2" fill="#2F5D8C" />
                  <rect x="76" y="56" width="88" height="16" rx="2" fill="#C7962F" />
                  <rect x="100" y="38" width="40" height="16" rx="2" fill="#F2F2EE" stroke="currentColor" strokeWidth="1.5" />
                </svg>
                <h2>Drop a logo here</h2>
                <p>LayerLift finds its colours, matches them to the filaments in your AMS, and stacks each colour at its own height.</p>
                {needsCheck && gate.siteKey ? (
                  <HumanCheck siteKey={gate.siteKey} onVerified={onVerified} />
                ) : (
                  <div className="row center">
                    <button type="button" className="primary" onClick={() => fileInput.current?.click()}>
                      Choose image
                    </button>
                    <button type="button" className="ghost" onClick={loadSample}>
                      Try the sample
                    </button>
                  </div>
                )}
              </div>
            )}
            {busy === 'analysing' && (
              <ProgressCard title="Finding colours and regions" progress={null} detail="Usually a few seconds. Large images take a little longer." />
            )}
            {busy === 'building' && (
              <ProgressCard
                title={!status ? 'Starting the build' : status.state === 'queued' ? 'Waiting in line' : status.stage}
                progress={status?.progress ?? 0}
                detail={
                  status?.state === 'queued'
                    ? (status.queue_position ?? 1) <= 1
                      ? "You're next. Your build starts as soon as the one before it finishes."
                      : `${(status.queue_position ?? 1) - 1} builds are ahead of you. This page updates by itself.`
                    : `${(status?.elapsed_s ?? 0) < 1 ? 'Just started' : `${Math.round(status!.elapsed_s)} s so far`}. Detailed images take longer. You can keep editing; changes apply to the next build.`
                }
              />
            )}
            {analysis && busy !== 'analysing' && (view === 'map' || view === 'original') && (
              <MappingCanvas
                analysis={analysis}
                imageUrl={imageUrl}
                regionColours={regionColours}
                selected={selectedIds}
                onSelect={selectRegion}
                tooltip={regionTooltip}
                showOriginal={view === 'original'}
              />
            )}
            {view === '3d' && result && (
              <Suspense fallback={<ProgressCard title="Loading the 3D viewer" progress={null} />}>
                <Viewer3D
                  url={result.glb_url}
                  explode={explode}
                  edit={
                    plan
                      ? {
                          parts: result.parts.map((p) => ({ filament: p.filament, name: p.name, hex: p.hex })),
                          built: Object.fromEntries(Object.entries(result.filament_heights).map(([k, v]) => [Number(k), v])),
                          current: Object.fromEntries(plan.heights.map((h, i) => [i, h])),
                          stacked: options.strategy === 'stacked',
                          layer: options.layer_mm,
                          min: Object.fromEntries(
                            filaments.map((f, i) => {
                              const base = snap(options.base_mm, options.layer_mm)
                              // The same floors as the build: the base colour stays above the base,
                              // bed starts need a layer, the rest a layer above the base.
                              const low = i === plan.baseFilament ? base : f.start_from_bed && options.strategy === 'detailed' ? options.layer_mm : base + options.layer_mm
                              return [i, Math.max(low, options.layer_mm)]
                            }),
                          ),
                          active: liftFilament,
                          onActive: setLiftFilament,
                          onCommit: commitHeights,
                          disabled:
                            options.strategy === 'compact'
                              ? 'The compact strategy sets heights itself. Switch to Detailed or Stacked to drag heights.'
                              : undefined,
                        }
                      : undefined
                  }
                />
              </Suspense>
            )}
            {view === 'relief' && result && <img className="relief-img" src={result.preview_url} alt="Top view of the relief with shading" />}
          </div>

          <div className="buildbar">
            <p className="hint">
              {analysis
                ? view === 'map'
                  ? removedCount
                    ? (
                        <>
                          {removedCount === 1 ? '1 area removed.' : `${removedCount} areas removed.`}{' '}
                          <button type="button" className="link" onClick={() => setRemoved(Object.keys(regionOverrides).map(Number), false)}>
                            Restore all
                          </button>
                        </>
                      )
                    : 'Click an area to change it or remove it; shift-click to select several.'
                  : result
                    ? `Built in ${result.elapsed_s.toFixed(1)} s.`
                    : 'Build to see the 3D model.'
                : 'Choose an image to start.'}
            </p>
            <button type="button" className="primary big" onClick={runBuild} disabled={!analysis || busy != null || needsCheck}>
              {busy === 'building' ? `Building… ${Math.round((status?.progress ?? 0) * 100)}%` : result && !stale ? 'Build again' : 'Build relief'}
            </button>
          </div>
        </section>

        <aside className="col info">
          {analysis && selectedIds.length > 0 && (
            <RegionInspector
              analysis={analysis}
              regions={selectedIds}
              filaments={filaments}
              mapping={mapping}
              overrides={regionOverrides}
              clusterHeights={clusterHeights}
              regionTop={plan?.regionTop ?? []}
              mmPerPx={plan?.mmPerPx ?? 0}
              heightsLocked={options.strategy === 'stacked'}
              canMerge={canMerge}
              layer={options.layer_mm}
              onFilament={(fil) => updateRegions(selectedIds, { filament: fil })}
              onHeight={(h) => updateRegions(selectedIds, { height_mm: h }, `height-${selectedIds.join(',')}`)}
              onClusterFilament={(fil) => setClusterFilament(analysis.regions[selectedIds[0]].cluster, fil)}
              onClusterHeight={(h) => setClusterHeight(analysis.regions[selectedIds[0]].cluster, h)}
              onRemove={(removed, wholeColour) => {
                const cluster = analysis.regions[selectedIds[0]].cluster
                setRemoved(wholeColour ? analysis.regions.filter((r) => r.cluster === cluster).map((r) => r.id) : selectedIds, removed)
              }}
              onMerge={() => mergeRegions(selectedIds)}
              onClose={() => setSelected([])}
            />
          )}
          {result && <Results result={result} stale={stale} />}
          {analysis && plan && (
            <LayerStack
              bands={plan.bands}
              filaments={filaments}
              layer={options.layer_mm}
              base={options.base_mm}
              top={plan.top}
              changes={plan.changes}
              confirmedChanges={result && !stale ? result.filament_changes : null}
            />
          )}
          {analysis && <ColourList analysis={analysis} filaments={filaments} mapping={mapping} locked={locked} onAssign={assignCluster} />}
          {analysis && plan && (
            <SpeckCleanup
              analysis={analysis}
              overrides={regionOverrides}
              mmPerPx={plan.mmPerPx}
              standsOut={(id) => {
                const o = mergeOverride(analysis, mapping, regionOverrides, clusterHeights, filamentHeight, id)
                return o != null && o.filament !== filamentOf(analysis, mapping, regionOverrides, id)
              }}
              onSelect={(ids) => {
                setSelected(ids)
                setView('map')
              }}
              onMerge={mergeRegions}
              onRemove={(ids) => setRemoved(ids, true)}
            />
          )}
          {!analysis && (
            <section className="panel quiet">
              <h2>How it works</h2>
              <ol className="steps">
                <li>Upload a logo with flat colours.</li>
                <li>List the filaments loaded in your AMS, in slot order.</li>
                <li>Check the colour map and click areas to adjust them.</li>
                <li>Build, then open the 3MF in OrcaSlicer. Every colour is already on its slot.</li>
              </ol>
            </section>
          )}
        </aside>
      </main>
      <Footer version={version} />
    </div>
  )
}

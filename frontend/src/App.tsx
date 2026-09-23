import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  type Analysis,
  type AnalysisOptions,
  ApiError,
  type BuildResult,
  type BuildSettings,
  type Filament,
  type RegionOverride,
  analyse,
  build,
  suggestMapping,
} from './api'
import { loadCurrentPalette, storeCurrentPalette } from './palettes'
import { makePlan } from './plan'
import ColourList from './components/ColourList'
import FilamentEditor from './components/FilamentEditor'
import LayerStack from './components/LayerStack'
import MappingCanvas from './components/MappingCanvas'
import RegionInspector from './components/RegionInspector'
import Results from './components/Results'
import SizeDepth from './components/SizeDepth'

// three.js is large; load it only when the 3D view is first opened.
const Viewer3D = lazy(() => import('./components/Viewer3D'))

type View = 'map' | 'original' | '3d' | 'relief'
type Options = Omit<BuildSettings, 'analysis' | 'filaments' | 'mapping' | 'cluster_heights' | 'region_overrides'>

const ACCEPT = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml']
const MAX_MB = 10

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
  const [selected, setSelected] = useState<number | null>(null)
  const [busy, setBusy] = useState<'analysing' | 'building' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<BuildResult | null>(null)
  const [builtKey, setBuiltKey] = useState('')
  const [view, setView] = useState<View>('map')
  const [explode, setExplode] = useState(0)
  const [dragging, setDragging] = useState(false)
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
        setSelected(null)
        setResult(null)
        setView('map')
      } catch (e) {
        setError(e instanceof ApiError ? e.message : 'Could not reach the LayerLift server.')
      } finally {
        setBusy(null)
      }
    },
    [filaments],
  )

  const acceptFile = (f: File | undefined) => {
    if (!f) return
    if (!ACCEPT.includes(f.type) && !/\.(png|jpe?g|webp|svg)$/i.test(f.name)) {
      setError('Use a PNG, JPEG, WebP or SVG image.')
      return
    }
    if (f.size > MAX_MB * 1024 * 1024) {
      setError(`That file is ${(f.size / 1024 / 1024).toFixed(1)} MB. The limit is ${MAX_MB} MB.`)
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
    }
    setFilaments(next)
    storeCurrentPalette(next)
  }

  const assignCluster = (cluster: number, fil: number | null) => {
    setLocked((l) => {
      const next = { ...l }
      if (fil == null) delete next[cluster]
      else next[cluster] = fil
      return next
    })
    if (fil != null) setMapping((m) => m.map((v, i) => (i === cluster ? fil : v)))
  }

  const setRegion = (region: number, o: RegionOverride | null) =>
    setRegionOverrides((ro) => {
      const next = { ...ro }
      if (!o || (o.filament == null && o.height_mm == null)) delete next[region]
      else next[region] = o
      return next
    })

  const setClusterFilament = (cluster: number, fil: number) => {
    assignCluster(cluster, fil)
    setRegionOverrides((ro) => {
      const next: Record<number, RegionOverride> = {}
      for (const [k, o] of Object.entries(ro)) {
        const r = analysis!.regions[Number(k)]
        const cleared = r.cluster === cluster ? { ...o, filament: null } : o
        if (cleared.filament != null || cleared.height_mm != null) next[Number(k)] = cleared
      }
      return next
    })
  }

  const setClusterHeight = (cluster: number, h: number | null) =>
    setClusterHeights((ch) => {
      const next = { ...ch }
      if (h == null) delete next[cluster]
      else next[cluster] = h
      return next
    })

  const regionColours = useMemo(() => {
    if (!analysis) return []
    return analysis.regions.map((r) => filaments[regionOverrides[r.id]?.filament ?? mapping[r.cluster]]?.hex ?? '#FF00FF')
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
    try {
      const r = await build(file, settings, ctrl.signal)
      setResult(r)
      setBuiltKey(key)
      setView('3d')
    } catch (e) {
      if ((e as Error).name === 'AbortError') return
      setError(e instanceof ApiError ? e.message : 'Could not reach the LayerLift server.')
    } finally {
      if (buildAbort.current === ctrl) setBusy(null)
    }
  }

  const usedFilaments = useMemo(() => filaments.map((_, i) => (plan ? plan.bands.some((b) => b.filament === i) : true)), [filaments, plan])
  const selectedRegion = selected != null && analysis ? analysis.regions[selected] : null

  // ---------------------------------------------------------------- render

  return (
    <div className="app">
      <header className="topbar">
        <svg className="mark" viewBox="0 0 32 32" aria-hidden>
          <rect x="4" y="22" width="24" height="5" rx="1" fill="#1F2328" />
          <rect x="8" y="16" width="16" height="5" rx="1" fill="#2F5D8C" />
          <rect x="12" y="10" width="8" height="5" rx="1" fill="#C7962F" />
          <rect x="14" y="5" width="4" height="4" rx="1" fill="#F2F2EE" stroke="#1F2328" />
        </svg>
        <h1>LayerLift</h1>
        <p>Flat-colour artwork in, multi-colour relief out, sliced by colour for your AMS.</p>
      </header>

      {error && (
        <div className="error" role="alert">
          <span>{error}</span>
          <button type="button" className="icon" onClick={() => setError(null)} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}

      <main className="workspace">
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
              <p className="hint">PNG, JPEG, WebP or SVG up to {MAX_MB} MB. Logos, badges and icons with flat colours work best.</p>
            )}
            <div className="row wrap">
              <button type="button" className={file ? 'ghost' : 'primary'} onClick={() => fileInput.current?.click()}>
                {file ? 'Replace image' : 'Choose image'}
              </button>
              {!file && (
                <button type="button" className="ghost" onClick={loadSample}>
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
            {view === '3d' && result && (
              <label className="explode">
                <span>Separate layers</span>
                <input type="range" min={0} max={1} step={0.01} value={explode} onChange={(e) => setExplode(Number(e.target.value))} />
              </label>
            )}
          </div>

          <div
            className={dragging ? 'canvas-area dragging' : 'canvas-area'}
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
                  <rect x="20" y="92" width="200" height="16" rx="2" fill="#1F2328" />
                  <rect x="44" y="74" width="152" height="16" rx="2" fill="#2F5D8C" />
                  <rect x="76" y="56" width="88" height="16" rx="2" fill="#C7962F" />
                  <rect x="100" y="38" width="40" height="16" rx="2" fill="#F2F2EE" stroke="#1F2328" strokeWidth="1.5" />
                </svg>
                <h2>Drop a logo here</h2>
                <p>LayerLift finds its colours, matches them to the filaments in your AMS, and stacks each colour at its own height.</p>
                <div className="row center">
                  <button type="button" className="primary" onClick={() => fileInput.current?.click()}>
                    Choose image
                  </button>
                  <button type="button" className="ghost" onClick={loadSample}>
                    Try the sample
                  </button>
                </div>
              </div>
            )}
            {busy === 'analysing' && <div className="empty"><p className="working">Finding colours and regions…</p></div>}
            {analysis && busy !== 'analysing' && (view === 'map' || view === 'original') && (
              <MappingCanvas
                analysis={analysis}
                imageUrl={imageUrl}
                regionColours={regionColours}
                selected={selected}
                onSelect={setSelected}
                showOriginal={view === 'original'}
              />
            )}
            {view === '3d' && result && (
              <Suspense fallback={<p className="working">Loading 3D viewer…</p>}>
                <Viewer3D url={result.glb_url} explode={explode} />
              </Suspense>
            )}
            {view === 'relief' && result && <img className="relief-img" src={result.preview_url} alt="Top view of the relief with shading" />}
          </div>

          <div className="buildbar">
            <p className="hint">
              {analysis
                ? view === 'map'
                  ? 'Click any area to give it its own filament or height.'
                  : result
                    ? `Built in ${result.elapsed_s.toFixed(1)} s.`
                    : 'Build to see the 3D model.'
                : 'Choose an image to start.'}
            </p>
            <button type="button" className="primary big" onClick={runBuild} disabled={!analysis || busy != null}>
              {busy === 'building' ? 'Building…' : result && !stale ? 'Build again' : 'Build relief'}
            </button>
          </div>
        </section>

        <aside className="col info">
          {analysis && selectedRegion && (
            <RegionInspector
              analysis={analysis}
              region={selectedRegion.id}
              filaments={filaments}
              mapping={mapping}
              override={regionOverrides[selectedRegion.id]}
              clusterHeight={clusterHeights[selectedRegion.cluster]}
              plannedHeight={plan?.heights[regionOverrides[selectedRegion.id]?.filament ?? mapping[selectedRegion.cluster]] ?? 0}
              layer={options.layer_mm}
              onRegion={(o) => setRegion(selectedRegion.id, o)}
              onClusterFilament={(fil) => setClusterFilament(selectedRegion.cluster, fil)}
              onClusterHeight={(h) => setClusterHeight(selectedRegion.cluster, h)}
              onClose={() => setSelected(null)}
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
    </div>
  )
}

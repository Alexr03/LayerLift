// Typed client for the LayerLift API.

export interface Filament {
  name: string
  hex: string
  height_mm: number | null
  start_from_bed: boolean
}

export interface Cluster {
  id: number
  hex: string
  rgb: [number, number, number]
  share: number
  pixels: number
}

export interface Region {
  id: number
  cluster: number
  area: number
  bbox: [number, number, number, number]
  centroid: [number, number]
  outline_share: number
}

export interface Analysis {
  analysis_id: string
  width: number
  height: number
  source_format: string
  original_size: [number, number]
  background: { mode: string; colour?: string }
  clusters: Cluster[]
  regions: Region[]
  adjacency: number[][]
  outline_region: number | null
  region_map_png: string
  suggested_mapping: number[] | null
}

export interface BackgroundOptions {
  mode: 'auto' | 'alpha' | 'colour' | 'none'
  colour?: string | null
  tolerance?: number
}

export interface AnalysisOptions {
  background: BackgroundOptions
  max_colours: number
  n_colours: number | null
}

export interface RegionOverride {
  filament?: number | null
  height_mm?: number | null
}

export interface BuildSettings {
  title: string
  analysis: AnalysisOptions
  filaments: Filament[]
  mapping: number[]
  cluster_heights: Record<number, number>
  region_overrides: Record<number, RegionOverride>
  width_mm: number
  size_mode: 'width' | 'height' | 'longest'
  nozzle_mm: number
  layer_mm: number
  base_mm: number
  height_mode: 'manual' | 'by_luminance'
  lighter_taller: boolean
  base_filament: number | null
  mirror: boolean
}

export interface BuildWarning {
  code: string
  message: string
  detail: Record<string, unknown>
}

export interface PartStats {
  slot: number
  filament: number
  name: string
  hex: string
  volume_mm3: number
  grams: number
  z_max: number
}

export interface LayerStats {
  index: number
  z_top: number
  filaments: number[]
  changes: number
}

export interface BuildResult {
  job_id: string
  preview_url: string
  glb_url: string
  downloads: { '3mf': string; 'stl-zip': string }
  size_mm: [number, number, number]
  base_filament: number
  base_mm: number
  mapping: number[]
  filament_heights: Record<string, number>
  parts: PartStats[]
  total_grams: number
  filament_changes: number
  layers: LayerStats[]
  warnings: BuildWarning[]
  elapsed_s: number
}

export class ApiError extends Error {
  code: string
  status: number
  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

async function handle<T>(res: Response): Promise<T> {
  if (res.ok) return (await res.json()) as T
  let code = 'http_error'
  let message = `The server answered ${res.status}.`
  try {
    const body = await res.json()
    if (body?.error) {
      code = body.error.code
      message = body.error.message
    }
  } catch {
    /* not JSON */
  }
  if (res.status === 413) message = message || 'The file is too large.'
  throw new ApiError(res.status, code, message)
}

export async function analyse(file: File, options: AnalysisOptions, filaments: Filament[]): Promise<Analysis> {
  const form = new FormData()
  form.append('file', file)
  form.append('options', JSON.stringify(options))
  form.append('filaments', JSON.stringify(filaments))
  return handle<Analysis>(await fetch('/api/analyse', { method: 'POST', body: form }))
}

export async function suggestMapping(
  analysis: Analysis,
  filaments: Filament[],
  fixed: Record<number, number>,
): Promise<number[]> {
  const res = await fetch('/api/map', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clusters: analysis.clusters.map((c) => ({ hex: c.hex, share: c.share })),
      adjacency: analysis.adjacency,
      filaments,
      fixed,
    }),
  })
  return (await handle<{ mapping: number[] }>(res)).mapping
}

export async function build(file: File, settings: BuildSettings, signal?: AbortSignal): Promise<BuildResult> {
  const form = new FormData()
  form.append('file', file)
  form.append('settings', JSON.stringify(settings))
  return handle<BuildResult>(await fetch('/api/build', { method: 'POST', body: form, signal }))
}

export async function getConfig(): Promise<{ max_upload_mb: number; version: string }> {
  return handle(await fetch('/api/config'))
}

export interface BuildStatus {
  job_id: string
  state: 'queued' | 'running' | 'done' | 'error'
  stage: string
  progress: number
  elapsed_s: number
  result?: BuildResult
  error?: { code: string; message: string }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(t)
      reject(new DOMException('Aborted', 'AbortError'))
    })
  })
}

/** Start a background build and poll its status, reporting progress until it finishes. */
export async function buildWithProgress(
  file: File,
  settings: BuildSettings,
  onProgress: (s: BuildStatus) => void,
  signal?: AbortSignal,
): Promise<BuildResult> {
  const form = new FormData()
  form.append('file', file)
  form.append('settings', JSON.stringify(settings))
  const started = await handle<{ job_id: string; status_url: string }>(await fetch('/api/builds', { method: 'POST', body: form, signal }))
  for (;;) {
    await sleep(350, signal)
    const s = await handle<BuildStatus>(await fetch(started.status_url, { signal }))
    onProgress(s)
    if (s.state === 'done' && s.result) return s.result
    if (s.state === 'error') throw new ApiError(422, s.error?.code ?? 'build_failed', s.error?.message ?? 'The build failed.')
  }
}

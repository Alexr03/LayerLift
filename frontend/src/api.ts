// Typed client for the LayerLift API.

import { authHeaders } from './pb'

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
  neighbours?: [number, number][] // [region id, shared boundary px], longest first
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
  removed?: boolean // left out of the print; the area becomes background
}

/** How colours are arranged in height; see relief/pipeline.py STRATEGIES. */
export type Strategy = 'detailed' | 'compact' | 'stacked'

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
  strategy: Strategy
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
  saved_until?: string | null // signed in: the copy in My builds is kept until then
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
  return handle<Analysis>(await fetch('/api/analyse', { method: 'POST', body: form, headers: authHeaders() }))
}

export async function suggestMapping(
  analysis: Analysis,
  filaments: Filament[],
  fixed: Record<number, number>,
): Promise<number[]> {
  const res = await fetch('/api/map', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
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
  return handle<BuildResult>(await fetch('/api/build', { method: 'POST', body: form, signal, headers: authHeaders() }))
}

export async function getConfig(): Promise<{ max_upload_mb: number; version: string; accounts: boolean }> {
  return handle(await fetch('/api/config'))
}

export interface Limits {
  tier: string
  label: string
  rate_limit_per_minute: number
  max_jobs: number
  max_upload_mb: number
  max_image_side: number
  job_timeout_seconds: number
  retention_hours: number
}

export interface Me {
  accounts: boolean
  user: { id: string; email: string; name: string; role: string; verified: boolean } | null
  limits: Limits
}

/** Who the server thinks is signed in, and the limits that apply. */
export async function getMe(): Promise<Me> {
  return handle<Me>(await fetch('/api/me', { headers: authHeaders() }))
}

export interface AdminJob {
  job_id: string
  record_id: string
  kind: 'analyse' | 'build'
  state: 'running' | 'queued'
  position: number | null
  age_s: number
  cancellable: boolean
  ip: string
  user: string | null
  tier: string
  title: string
}

export interface AdminStatus {
  version: string
  workers: number
  busy_workers: number
  capacity: number
  running: number
  waiting: number
  jobs: AdminJob[]
}

export async function getAdminStatus(): Promise<AdminStatus> {
  return handle<AdminStatus>(await fetch('/api/admin/status', { headers: authHeaders() }))
}

export async function cancelJob(jobId: string): Promise<void> {
  await handle(await fetch(`/api/admin/jobs/${jobId}/cancel`, { method: 'POST', headers: authHeaders() }))
}

export interface BuildStatus {
  job_id: string
  state: 'queued' | 'running' | 'done' | 'error'
  stage: string
  progress: number
  elapsed_s: number
  queue_position?: number | null
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
  const started = await handle<{ job_id: string; status_url: string }>(
    await fetch('/api/builds', { method: 'POST', body: form, signal, headers: authHeaders() }),
  )
  for (;;) {
    await sleep(350, signal)
    const s = await handle<BuildStatus>(await fetch(started.status_url, { signal }))
    onProgress(s)
    if (s.state === 'done' && s.result) return s.result
    if (s.state === 'error') throw new ApiError(422, s.error?.code ?? 'build_failed', s.error?.message ?? 'The build failed.')
  }
}

export interface SessionState {
  required: boolean
  verified: boolean
  site_key: string | null
}

export async function getSession(): Promise<SessionState> {
  return handle<SessionState>(await fetch('/api/session', { headers: authHeaders() }))
}

/** Exchange a Turnstile token for a session cookie. */
export async function startSession(token: string): Promise<void> {
  const form = new FormData()
  form.append('token', token)
  await handle(await fetch('/api/session', { method: 'POST', body: form }))
}

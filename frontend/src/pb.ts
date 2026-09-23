// PocketBase client for accounts, "My builds" and the admin page. LayerLift proxies PocketBase
// under /pb on its own origin; the sign-in token is kept in localStorage by the SDK.
import PocketBase from 'pocketbase'

export const pb = new PocketBase('/pb')
// Several components list the same collection at once; don't let the SDK cancel duplicates.
pb.autoCancellation(false)

/** Header that tells the LayerLift API who is signed in (empty when nobody is). */
export function authHeaders(): Record<string, string> {
  return pb.authStore.isValid ? { Authorization: pb.authStore.token } : {}
}

export interface JobRecord {
  id: string
  kind: 'analyse' | 'build'
  user: string
  state: 'queued' | 'running' | 'done' | 'error' | 'cancelled'
  stage: string
  progress: number
  title: string
  error: string
  elapsed_s: number
  result: {
    size_mm?: [number, number, number]
    filament_changes?: number
    total_grams?: number
    parts?: { slot: number; name: string; hex: string; grams: number }[]
  } | null
  preview: string
  glb: string
  model_3mf: string
  stl_zip: string
  expires: string
  created: string
  updated: string
}

export interface TierRecord {
  id: string
  name: string
  label: string
  description: string
  sort: number
  rate_limit_per_minute: number
  max_jobs: number
  max_upload_mb: number
  max_image_side: number
  job_timeout_seconds: number
  retention_hours: number
}

/** PocketBase dates ("2026-09-23 12:00:00.000Z") as a short local date and time. */
export function when(value: string): string {
  if (!value) return ''
  const d = new Date(value.replace(' ', 'T'))
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

/** Keep a list of records in step with realtime events. */
export function applyEvent<T extends { id: string }>(list: T[], action: string, record: T, sort: (a: T, b: T) => number): T[] {
  const rest = list.filter((r) => r.id !== record.id)
  return action === 'delete' ? rest : [record, ...rest].sort(sort)
}

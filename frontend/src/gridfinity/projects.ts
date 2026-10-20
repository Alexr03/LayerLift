// Where Gridfinity projects are kept. Saving is manual: the Save button writes the project to the
// account's `projects` collection when signed in, or to a list in this browser otherwise. The
// working copy (saved or not) is also kept in this browser, so a reload never loses edits.
import { pb } from '../pb'
import { type GfProject, newId, normaliseProject } from './types'

export interface ProjectRecord {
  id: string
  title: string
  data: GfProject
  updated: string
}

const DRAFT_KEY = 'layerlift.gridfinity.current.v1'
const LOCAL_KEY = 'layerlift.gridfinity.projects.v1'

/** The project open in the editor, and what it looked like when last saved. */
export interface Draft {
  project: GfProject
  recordId: string | null // where it was last saved: an account record, or an id in this browser's list
  store: 'account' | 'local' | null
  savedJson: string // the project as last saved, to tell whether there are unsaved changes
}

export function loadDraft(): Draft | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY)
    if (!raw) return null
    const v = JSON.parse(raw) as { project: unknown; recordId?: string | null; savedJson?: string; store?: Draft['store'] }
    const recordId = typeof v.recordId === 'string' ? v.recordId : null
    // Drafts from before manual saving were autosaved to the account when they had a record.
    const store = v.store ?? (recordId ? 'account' : null)
    return { project: normaliseProject(v.project), recordId, store, savedJson: v.savedJson ?? (recordId ? JSON.stringify(normaliseProject(v.project)) : '') }
  } catch {
    return null
  }
}

export function saveDraft(d: Draft | null) {
  try {
    if (d) localStorage.setItem(DRAFT_KEY, JSON.stringify(d))
    else localStorage.removeItem(DRAFT_KEY)
  } catch {
    /* storage full or blocked: the project still lives in memory */
  }
}

// ------------------------------------------------------------------ this browser

function readLocal(): ProjectRecord[] {
  try {
    const raw = localStorage.getItem(LOCAL_KEY)
    return raw ? (JSON.parse(raw) as ProjectRecord[]).map((r) => ({ ...r, data: normaliseProject(r.data) })) : []
  } catch {
    return []
  }
}

function writeLocal(list: ProjectRecord[]) {
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(list))
  } catch {
    throw new Error('This browser has no room left to save projects.')
  }
}

// ------------------------------------------------------------------ either

export async function listProjects(userId: string | null): Promise<ProjectRecord[]> {
  if (!userId) return readLocal().sort((a, b) => b.updated.localeCompare(a.updated))
  const filter = pb.filter('user = {:user} && tool = "gridfinity"', { user: userId })
  const r = await pb.collection('projects').getList<ProjectRecord>(1, 200, { filter, sort: '-updated' })
  return r.items.map((p) => ({ id: p.id, title: p.title, updated: p.updated, data: normaliseProject(p.data) }))
}

export async function getProject(id: string, userId: string | null): Promise<ProjectRecord> {
  if (!userId) {
    const r = readLocal().find((p) => p.id === id)
    if (!r) throw new Error('not found')
    return r
  }
  const p = await pb.collection('projects').getOne<ProjectRecord>(id)
  return { id: p.id, title: p.title, updated: p.updated, data: normaliseProject(p.data) }
}

/** Create (id null) or update a saved project. */
export async function putProject(id: string | null, userId: string | null, project: GfProject): Promise<ProjectRecord> {
  if (!userId) {
    const list = readLocal()
    const rec: ProjectRecord = { id: id && list.some((p) => p.id === id) ? id : newId(), title: project.title, data: project, updated: new Date().toISOString() }
    writeLocal([rec, ...list.filter((p) => p.id !== rec.id)])
    return rec
  }
  const body = { title: project.title, data: project }
  const r = id
    ? await pb.collection('projects').update<ProjectRecord>(id, body)
    : await pb.collection('projects').create<ProjectRecord>({ ...body, user: userId, tool: 'gridfinity' })
  return { id: r.id, title: r.title, updated: r.updated, data: normaliseProject(r.data) }
}

export async function deleteProject(id: string, userId: string | null) {
  if (!userId) writeLocal(readLocal().filter((p) => p.id !== id))
  else await pb.collection('projects').delete(id)
}

import { Box, Copy, Trash2 } from 'lucide-react'
import { KIND } from '../../gridfinity/kinds'
import { useEffect, useState } from 'react'
import { drawerGrid } from '../../gridfinity/layout'
import { type ProjectRecord, deleteProject, listProjects, putProject } from '../../gridfinity/projects'
import { type GfProject, type Scene, sceneOf } from '../../gridfinity/types'
import { onPlate } from '../../palettes'
import { when } from '../../pb'

/** A baseplate's layout from above, drawn from the project data (no stored image needed). */
export function LayoutThumb({ scene }: { scene: Scene }) {
  const g = drawerGrid(scene.drawer)
  const PITCH = g.pitch
  return (
    <svg className="gf-thumb" viewBox={`-2 -2 ${g.width + 4} ${g.depth + 4}`} aria-hidden>
      <rect x={0} y={0} width={g.width} height={g.depth} rx={2} className="pl-plate" />
      {scene.bins.map((b) => (
        <rect
          key={b.id}
          x={g.padLeft + b.x * PITCH + 1.5}
          y={g.depth - (g.padFront + (b.y + b.design.d) * PITCH) + 1.5}
          width={b.design.w * PITCH - 3}
          height={b.design.d * PITCH - 3}
          rx={4}
          fill={onPlate(scene.filaments[b.design.body]?.hex ?? '#8C9196')}
        />
      ))}
    </svg>
  )
}


function describe(p: GfProject): string {
  if (p.mode === 'bin') {
    const b = p.plates[0]?.bins[0]?.design
    return b ? `${b.w} × ${b.d} × ${b.h}` : ''
  }
  const plates = p.plates.length
  const bins = p.plates.reduce((n, pl) => n + pl.bins.length, 0)
  const g = drawerGrid(p.plates[0].drawer)
  if (p.mode === 'plate') return `${g.nx} × ${g.ny} cells`
  return `${plates} baseplate${plates === 1 ? '' : 's'} · ${bins} bin${bins === 1 ? '' : 's'}`
}

interface Props {
  userId: string | null
  onOpen: (r: ProjectRecord) => void
  refreshKey?: number
}

/** Saved projects (in the account, or in this browser when signed out), newest first. */
export default function ProjectList({ userId, onOpen, refreshKey = 0 }: Props) {
  const [items, setItems] = useState<ProjectRecord[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    listProjects(userId)
      .then((r) => alive && setItems(r))
      .catch(() => alive && setError('Could not load your projects.'))
    return () => {
      alive = false
    }
  }, [userId, refreshKey])

  const remove = async (p: ProjectRecord) => {
    if (!window.confirm(`Delete "${p.title || 'this project'}"?`)) return
    try {
      await deleteProject(p.id, userId)
      setItems((list) => list?.filter((x) => x.id !== p.id) ?? null)
    } catch {
      setError('Could not delete that project.')
    }
  }

  const copy = async (p: ProjectRecord) => {
    try {
      const r = await putProject(null, userId, { ...p.data, title: `${p.data.title} (copy)` })
      setItems((list) => [r, ...(list ?? [])])
    } catch {
      setError('Could not copy that project.')
    }
  }

  if (error) return <p className="hint danger">{error}</p>
  if (items === null) return <p className="hint">Loading…</p>
  if (!items.length) return <p className="hint">No saved projects yet.</p>
  return (
    <ul className="build-grid">
      {items.map((p) => {
        const Icon = KIND[p.data.mode].icon
        return (
          <li key={p.id} className="build-card">
            <button type="button" className="build-thumb gf-thumb-wrap gf-open" onClick={() => onOpen(p)} aria-label={`Open ${p.title}`}>
              {p.data.mode === 'bin' ? <Box size={56} strokeWidth={1.2} /> : <LayoutThumb scene={sceneOf(p.data)} />}
            </button>
            <div className="build-body">
              <strong className="build-title">{p.title || 'Untitled'}</strong>
              <span className="hint gf-kind">
                <Icon size={13} /> {KIND[p.data.mode].label} · {describe(p.data)}
              </span>
              <span className="hint">Saved {when(p.updated)}</span>
              <div className="row wrap build-actions">
                <button type="button" className="solid" onClick={() => onOpen(p)}>
                  Open
                </button>
                <button type="button" className="ghost" onClick={() => copy(p)} title="Duplicate">
                  <Copy size={15} /> Duplicate
                </button>
                <button type="button" className="icon danger" onClick={() => remove(p)} aria-label={`Delete ${p.title}`} title="Delete">
                  <Trash2 size={16} />
                </button>
              </div>
            </div>
          </li>
        )
      })}
    </ul>
  )
}

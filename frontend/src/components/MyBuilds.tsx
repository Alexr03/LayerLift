import { Suspense, lazy, useEffect, useState } from 'react'
import type { Me } from '../api'
import { fmt } from '../palettes'
import { type JobRecord, applyEvent, pb, when } from '../pb'

const Viewer3D = lazy(() => import('./Viewer3D'))

interface Props {
  me: Me
  onSignIn: () => void
}

const newestFirst = (a: JobRecord, b: JobRecord) => b.created.localeCompare(a.created)

/** Protected files need a short-lived token; renew it before it lapses. */
function useFileToken(enabled: boolean): string {
  const [token, setToken] = useState('')
  useEffect(() => {
    if (!enabled) return
    let alive = true
    const renew = () =>
      pb.files
        .getToken()
        .then((t) => alive && setToken(t))
        .catch(() => undefined)
    renew()
    const timer = setInterval(renew, 90_000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [enabled])
  return token
}

export default function MyBuilds({ me, onSignIn }: Props) {
  const userId = me.user?.id ?? ''
  const [jobs, setJobs] = useState<JobRecord[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [viewing, setViewing] = useState<string | null>(null)
  const token = useFileToken(!!userId)

  useEffect(() => {
    if (!userId) return
    const filter = pb.filter('user = {:user} && kind = "build"', { user: userId })
    let alive = true
    let unsubscribe: (() => Promise<void>) | null = null
    pb.collection('jobs')
      .getList<JobRecord>(1, 60, { filter, sort: '-created' })
      .then((r) => alive && setJobs(r.items))
      .catch(() => alive && setError('Could not load your builds.'))
    pb.collection('jobs')
      .subscribe<JobRecord>('*', (e) => setJobs((list) => applyEvent(list ?? [], e.action, e.record, newestFirst)), { filter })
      .then((u) => {
        if (alive) unsubscribe = u
        else u()
      })
      .catch(() => undefined)
    return () => {
      alive = false
      unsubscribe?.()
    }
  }, [userId])

  if (!me.user) {
    return (
      <section className="page">
        <div className="panel page-intro">
          <h2>My builds</h2>
          <p>
            Sign in to keep your builds. Each one is saved with its preview, 3MF and STL files, so you can come back and download it again
            later. Accounts also get higher limits.
          </p>
          <div className="row">
            <button type="button" className="primary" onClick={onSignIn}>
              Sign in or create an account
            </button>
            <a className="button ghost" href="#/">
              Back to the editor
            </a>
          </div>
        </div>
      </section>
    )
  }

  const remove = async (job: JobRecord) => {
    if (!window.confirm(`Delete "${job.title || 'this build'}" and its files?`)) return
    try {
      await pb.collection('jobs').delete(job.id)
    } catch {
      setError('Could not delete that build.')
    }
  }

  const file = (job: JobRecord, name: string, download = false) => pb.files.getURL(job, name, { token, ...(download ? { download: true } : {}) })

  return (
    <section className="page" aria-labelledby="builds-h">
      <div className="page-head">
        <h2 id="builds-h">My builds</h2>
        <p className="hint">
          {me.limits.retention_hours > 0
            ? `Builds are kept for ${me.limits.retention_hours >= 48 ? `${Math.round(me.limits.retention_hours / 24)} days` : `${me.limits.retention_hours} hours`} on the ${me.limits.label} plan. This list updates live.`
            : `The ${me.limits.label} plan doesn't keep build files, but your recent builds are listed here.`}
        </p>
        <a className="button ghost" href="#/">
          Back to the editor
        </a>
      </div>
      {error && <p className="hint danger">{error}</p>}
      {jobs === null ? (
        <p className="hint">Loading…</p>
      ) : jobs.length === 0 ? (
        <div className="panel quiet">
          <p>No builds yet. Build a relief in the editor and it appears here.</p>
        </div>
      ) : (
        <ul className="build-grid">
          {jobs.map((job) => {
            const r = job.result ?? {}
            const live = job.state === 'queued' || job.state === 'running'
            return (
              <li key={job.id} className="panel build-card">
                <div className="build-thumb">
                  {job.preview && token ? <img src={file(job, job.preview)} alt="" loading="lazy" /> : <span className="hint">{live ? 'Building…' : 'No preview'}</span>}
                </div>
                <div className="build-body">
                  <strong className="build-title">{job.title || 'Untitled relief'}</strong>
                  <span className="hint">{when(job.created)}</span>
                  {live && (
                    <div className="build-progress">
                      <div className="progress-bar">
                        <div className="progress-fill" style={{ width: `${Math.round((job.progress || 0) * 100)}%` }} />
                      </div>
                      <span className="hint">{job.stage || 'Waiting in line'}</span>
                    </div>
                  )}
                  {job.state === 'done' && r.size_mm && (
                    <span className="hint">
                      {r.size_mm[0].toFixed(0)} × {r.size_mm[1].toFixed(0)} × {fmt(r.size_mm[2])} mm · {r.filament_changes} changes · {r.total_grams?.toFixed(1)} g
                    </span>
                  )}
                  {(job.state === 'error' || job.state === 'cancelled') && <span className="hint danger">{job.error || 'Cancelled.'}</span>}
                  {job.state === 'done' && (
                    <span className="hint">{job.model_3mf ? `Kept until ${when(job.expires)}` : 'Files were not kept for this build.'}</span>
                  )}
                  <div className="row wrap build-actions">
                    {job.model_3mf && (
                      <a className="button primary" href={file(job, job.model_3mf, true)}>
                        3MF
                      </a>
                    )}
                    {job.stl_zip && (
                      <a className="button ghost" href={file(job, job.stl_zip, true)}>
                        STL zip
                      </a>
                    )}
                    {job.glb && (
                      <button type="button" className="ghost" onClick={() => setViewing(viewing === job.id ? null : job.id)} aria-expanded={viewing === job.id}>
                        {viewing === job.id ? 'Hide 3D' : '3D'}
                      </button>
                    )}
                    {!live && (
                      <button type="button" className="ghost danger" onClick={() => remove(job)}>
                        Delete
                      </button>
                    )}
                  </div>
                </div>
                {viewing === job.id && job.glb && token && (
                  <div className="build-viewer">
                    <Suspense fallback={<p className="hint">Loading the 3D viewer…</p>}>
                      <Viewer3D url={file(job, job.glb)} explode={0} />
                    </Suspense>
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

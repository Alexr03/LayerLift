import { useEffect, useRef, useState } from 'react'
import { type AdminStatus, ApiError, type Me, cancelJob, getAdminStatus } from '../api'
import { type JobRecord, type TierRecord, applyEvent, pb, when } from '../pb'

interface Props {
  me: Me
}

const newestFirst = (a: JobRecord, b: JobRecord) => b.created.localeCompare(a.created)

function age(s: number): string {
  return s < 60 ? `${Math.round(s)} s` : `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`
}

/** Live view of the server for accounts with the admin role: workers, the queue, recent jobs. */
export default function AdminPage({ me }: Props) {
  const isAdmin = me.user?.role === 'admin'
  const [status, setStatus] = useState<AdminStatus | null>(null)
  const [recent, setRecent] = useState<JobRecord[]>([])
  const [tiers, setTiers] = useState<TierRecord[]>([])
  const [accounts, setAccounts] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const pollNow = useRef<() => void>(() => undefined)

  // Queue and workers come from LayerLift itself (they aren't stored anywhere). Polled every
  // 2 s, and straight away whenever a job record changes.
  useEffect(() => {
    if (!isAdmin) return
    let alive = true
    let soon: ReturnType<typeof setTimeout> | undefined
    const poll = () =>
      getAdminStatus()
        .then((s) => {
          if (!alive) return
          setStatus(s)
          setError(null)
        })
        .catch((e) => alive && setError(e instanceof ApiError ? e.message : 'Could not reach the server.'))
    poll()
    const timer = setInterval(poll, 2000)
    pollNow.current = () => {
      clearTimeout(soon)
      soon = setTimeout(poll, 150)
    }
    return () => {
      alive = false
      clearInterval(timer)
      clearTimeout(soon)
    }
  }, [isAdmin])

  // Job records stream from PocketBase as LayerLift writes them.
  useEffect(() => {
    if (!isAdmin) return
    let alive = true
    let unsubscribe: (() => Promise<void>) | null = null
    pb.collection('jobs')
      .getList<JobRecord>(1, 40, { sort: '-created' })
      .then((r) => alive && setRecent(r.items))
      .catch(() => undefined)
    pb.collection('jobs')
      .subscribe<JobRecord>('*', (e) => {
        setRecent((list) => applyEvent(list, e.action, e.record, newestFirst).slice(0, 40))
        pollNow.current()
      })
      .then((u) => {
        if (alive) unsubscribe = u
        else u()
      })
      .catch(() => undefined)
    pb.collection('tiers')
      .getFullList<TierRecord>({ sort: 'sort' })
      .then((t) => alive && setTiers(t))
      .catch(() => undefined)
    pb.collection('users')
      .getList(1, 1)
      .then((r) => alive && setAccounts(r.totalItems))
      .catch(() => undefined)
    return () => {
      alive = false
      unsubscribe?.()
    }
  }, [isAdmin])

  if (!isAdmin) {
    return (
      <section className="page">
        <div className="panel page-intro">
          <h2>Admin</h2>
          <p>This page is for administrators. Give an account the admin role in the PocketBase dashboard to open it.</p>
          <a className="button ghost" href="#/">
            Back to the editor
          </a>
        </div>
      </section>
    )
  }

  const records = new Map(recent.map((r) => [r.id, r]))
  const cancel = async (jobId: string) => {
    try {
      await cancelJob(jobId)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not cancel that job.')
    }
  }

  return (
    <section className="page" aria-labelledby="admin-h">
      <div className="page-head">
        <h2 id="admin-h">Admin</h2>
        <p className="hint">Updates live. Accounts, roles and tiers are edited in the PocketBase dashboard.</p>
        <a className="button ghost" href="/pb/_/" target="_blank" rel="noreferrer">
          PocketBase dashboard
        </a>
      </div>
      {error && <p className="hint danger">{error}</p>}

      <div className="stat-row">
        <div className="panel stat">
          <span>Workers busy</span>
          <strong>{status ? `${status.busy_workers} / ${status.workers}` : '–'}</strong>
        </div>
        <div className="panel stat">
          <span>Running</span>
          <strong>{status?.running ?? '–'}</strong>
        </div>
        <div className="panel stat">
          <span>Waiting</span>
          <strong>{status ? `${status.waiting}` : '–'}</strong>
          {status && <em>of {status.capacity} slots</em>}
        </div>
        <div className="panel stat">
          <span>Accounts</span>
          <strong>{accounts ?? '–'}</strong>
        </div>
        <div className="panel stat">
          <span>Version</span>
          <strong className="small">{status?.version ?? '–'}</strong>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <h2>Now</h2>
          <span className="count">{status?.jobs.length ?? 0}</span>
        </div>
        {!status?.jobs.length ? (
          <p className="hint">Nothing running or waiting.</p>
        ) : (
          <table className="admin-table">
            <thead>
              <tr>
                <th scope="col">Job</th>
                <th scope="col">Who</th>
                <th scope="col">State</th>
                <th scope="col" className="r">
                  Age
                </th>
                <th scope="col" />
              </tr>
            </thead>
            <tbody>
              {status.jobs.map((j) => {
                const rec = records.get(j.record_id)
                return (
                  <tr key={j.job_id}>
                    <td>
                      <span className={`kind ${j.kind}`}>{j.kind}</span> {j.title}
                    </td>
                    <td>
                      {j.user ?? 'Guest'}
                      <span className="hint block">
                        {j.ip} · {j.tier}
                      </span>
                    </td>
                    <td>
                      {j.state === 'queued' ? (
                        `Waiting, #${j.position}`
                      ) : (
                        <>
                          {rec?.stage || 'Running'}
                          {rec && rec.progress > 0 && (
                            <div className="progress-bar small">
                              <div className="progress-fill" style={{ width: `${Math.round(rec.progress * 100)}%` }} />
                            </div>
                          )}
                        </>
                      )}
                    </td>
                    <td className="r">{age(j.age_s)}</td>
                    <td className="r">
                      {j.cancellable && (
                        <button type="button" className="ghost danger" onClick={() => cancel(j.job_id)}>
                          Cancel
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      <div className="admin-columns">
        <div className="panel">
          <div className="panel-head">
            <h2>Recent jobs</h2>
          </div>
          <table className="admin-table">
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Job</th>
                <th scope="col">Account</th>
                <th scope="col">State</th>
                <th scope="col" className="r">
                  Time
                </th>
              </tr>
            </thead>
            <tbody>
              {recent.map((r) => (
                <tr key={r.id}>
                  <td className="nowrap">{when(r.created)}</td>
                  <td>
                    <span className={`kind ${r.kind}`}>{r.kind}</span> {r.title}
                  </td>
                  <td>{r.user ? <code>{r.user}</code> : 'Guest'}</td>
                  <td className={r.state === 'error' || r.state === 'cancelled' ? 'danger' : ''} title={r.error || undefined}>
                    {r.state === 'running' ? `${r.stage} (${Math.round(r.progress * 100)}%)` : r.state}
                  </td>
                  <td className="r">{r.elapsed_s ? `${r.elapsed_s.toFixed(1)} s` : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="panel">
          <div className="panel-head">
            <h2>Tiers</h2>
          </div>
          <table className="admin-table">
            <thead>
              <tr>
                <th scope="col">Tier</th>
                <th scope="col" className="r">
                  Per min
                </th>
                <th scope="col" className="r">
                  At once
                </th>
                <th scope="col" className="r">
                  Upload
                </th>
                <th scope="col" className="r">
                  Kept
                </th>
              </tr>
            </thead>
            <tbody>
              {tiers.map((t) => (
                <tr key={t.id}>
                  <td>
                    {t.label || t.name} <code>{t.name}</code>
                  </td>
                  <td className="r">{t.rate_limit_per_minute}</td>
                  <td className="r">{t.max_jobs}</td>
                  <td className="r">{t.max_upload_mb} MB</td>
                  <td className="r">{t.retention_hours ? `${t.retention_hours} h` : '–'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="hint">Accounts without a tier get "free"; visitors without an account get "anonymous".</p>
        </div>
      </div>
    </section>
  )
}

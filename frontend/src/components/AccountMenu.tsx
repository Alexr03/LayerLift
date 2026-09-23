import { useEffect, useRef, useState } from 'react'
import type { Me } from '../api'
import { pb } from '../pb'

interface Props {
  me: Me
  onSignIn: () => void
}

function hours(h: number): string {
  if (h <= 0) return 'not kept'
  if (h % 24 === 0) return h === 24 ? '1 day' : `${h / 24} days`
  return h === 1 ? '1 hour' : `${h} hours`
}

/** "Sign in", or the signed-in account with its limits and links to My builds / Admin. */
export default function AccountMenu({ me, onSignIn }: Props) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false)
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', esc)
    }
  }, [open])

  if (!me.accounts) return null
  if (!me.user) {
    return (
      <div className="account">
        <a className="button ghost" href="#/builds" title="Builds are kept for signed-in accounts">
          My builds
        </a>
        <button type="button" className="primary" onClick={onSignIn}>
          Sign in
        </button>
      </div>
    )
  }
  const l = me.limits
  const go = (hash: string) => {
    window.location.hash = hash
    setOpen(false)
  }
  return (
    <div className="account" ref={ref}>
      <button type="button" className="ghost account-button" aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen((o) => !o)}>
        <span className="avatar" aria-hidden>
          {(me.user.name || me.user.email).slice(0, 1).toUpperCase()}
        </span>
        <span className="account-name">{me.user.name || me.user.email}</span>
      </button>
      {open && (
        <div className="account-menu" role="menu">
          <div className="account-tier">
            <strong>{l.label}</strong>
            <span>
              {l.rate_limit_per_minute} jobs a minute, {l.max_jobs} at once
            </span>
            <span>
              Uploads to {l.max_upload_mb} MB, images to {l.max_image_side} px
            </span>
            <span>Builds kept {hours(l.retention_hours)}</span>
          </div>
          <button type="button" role="menuitem" onClick={() => go('#/')}>
            Editor
          </button>
          <button type="button" role="menuitem" onClick={() => go('#/builds')}>
            My builds
          </button>
          {me.user.role === 'admin' && (
            <button type="button" role="menuitem" onClick={() => go('#/admin')}>
              Admin
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              pb.authStore.clear()
              setOpen(false)
            }}
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  )
}

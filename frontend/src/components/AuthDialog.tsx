import { useEffect, useRef, useState } from 'react'
import { ClientResponseError } from 'pocketbase'
import { pb } from '../pb'

interface Props {
  open: boolean
  onClose: () => void
}

type Mode = 'sign-in' | 'sign-up' | 'reset'

interface Provider {
  name: string
  displayName: string
}

/** PocketBase's field errors ({data: {email: {message}}}) as one readable line. */
function describe(e: unknown): string {
  if (e instanceof ClientResponseError) {
    const fields = Object.entries((e.response?.data ?? {}) as Record<string, { message?: string }>)
      .map(([k, v]) => `${k}: ${v?.message ?? 'invalid'}`)
      .join('. ')
    if (e.status === 429) return 'Too many attempts. Wait a few seconds and try again.'
    if (e.status === 0) return 'Could not reach the account service.'
    return fields || e.response?.message || e.message
  }
  return 'Something went wrong. Try again.'
}

export default function AuthDialog({ open, onClose }: Props) {
  const ref = useRef<HTMLDialogElement>(null)
  const [mode, setMode] = useState<Mode>('sign-in')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [providers, setProviders] = useState<Provider[]>([])

  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (open && !d.open) {
      d.showModal()
      setError(null)
      setNotice(null)
      pb.collection('users')
        .listAuthMethods()
        .then((m) => setProviders(m.oauth2?.enabled ? m.oauth2.providers : []))
        .catch(() => setProviders([]))
    } else if (!open && d.open) d.close()
  }, [open])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      if (mode === 'reset') {
        await pb.collection('users').requestPasswordReset(email)
        setNotice('If that address has an account, a reset link is on its way.')
        return
      }
      if (mode === 'sign-up') {
        await pb.collection('users').create({ email, password, passwordConfirm: password })
      }
      await pb.collection('users').authWithPassword(email, password)
      setPassword('')
      onClose()
    } catch (err) {
      setError(mode === 'sign-in' && err instanceof ClientResponseError && err.status === 400 ? 'Wrong email or password.' : describe(err))
    } finally {
      setBusy(false)
    }
  }

  const oauth = async (provider: string) => {
    setError(null)
    try {
      await pb.collection('users').authWithOAuth2({ provider })
      onClose()
    } catch (err) {
      setError(describe(err))
    }
  }

  const title = mode === 'sign-up' ? 'Create an account' : mode === 'reset' ? 'Reset your password' : 'Sign in'

  return (
    <dialog ref={ref} className="auth-dialog" onClose={onClose} aria-labelledby="auth-h">
      <form onSubmit={submit} className="auth-form">
        <div className="panel-head">
          <h2 id="auth-h">{title}</h2>
          <button type="button" className="icon" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        {mode !== 'reset' && (
          <p className="hint">An account raises your limits and keeps your builds, so you can download them again later.</p>
        )}
        <label className="field">
          <span>Email</span>
          <input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        {mode !== 'reset' && (
          <label className="field">
            <span>Password</span>
            <input
              type="password"
              autoComplete={mode === 'sign-up' ? 'new-password' : 'current-password'}
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
        )}
        {error && <p className="hint danger" role="alert">{error}</p>}
        {notice && <p className="hint" role="status">{notice}</p>}
        <button type="submit" className="primary" disabled={busy}>
          {busy ? 'One moment…' : mode === 'sign-up' ? 'Create account' : mode === 'reset' ? 'Send reset link' : 'Sign in'}
        </button>
        {mode !== 'reset' && providers.length > 0 && (
          <div className="oauth">
            {providers.map((p) => (
              <button key={p.name} type="button" className="ghost" onClick={() => oauth(p.name)}>
                Continue with {p.displayName}
              </button>
            ))}
          </div>
        )}
        <p className="hint auth-switch">
          {mode === 'sign-in' ? (
            <>
              New here?{' '}
              <button type="button" className="link" onClick={() => setMode('sign-up')}>
                Create an account
              </button>
              {' · '}
              <button type="button" className="link" onClick={() => setMode('reset')}>
                Forgot password
              </button>
            </>
          ) : (
            <>
              {mode === 'sign-up' ? 'Already have an account? ' : ''}
              <button type="button" className="link" onClick={() => setMode('sign-in')}>
                Back to sign in
              </button>
            </>
          )}
        </p>
      </form>
    </dialog>
  )
}

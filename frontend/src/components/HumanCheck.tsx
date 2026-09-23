import { useEffect, useRef, useState } from 'react'
import { ApiError, startSession } from '../api'

interface TurnstileApi {
  render: (el: HTMLElement, opts: Record<string, unknown>) => string
  remove: (id: string) => void
  reset: (id: string) => void
}

declare global {
  interface Window {
    turnstile?: TurnstileApi
  }
}

const SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
let loading: Promise<TurnstileApi> | null = null

function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile)
  loading ??= new Promise((resolve, reject) => {
    const s = document.createElement('script')
    s.src = SCRIPT
    s.async = true
    s.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error('Turnstile did not load')))
    s.onerror = () => {
      loading = null
      reject(new Error('Turnstile did not load'))
    }
    document.head.appendChild(s)
  })
  return loading
}

interface Props {
  siteKey: string
  onVerified: () => void
}

/** Cloudflare Turnstile check. On success the server sets a session cookie for this browser. */
export default function HumanCheck({ siteKey, onVerified }: Props) {
  const box = useRef<HTMLDivElement>(null)
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    let widget: string | null = null
    let alive = true
    loadTurnstile()
      .then((ts) => {
        if (!alive || !box.current) return
        widget = ts.render(box.current, {
          sitekey: siteKey,
          theme: 'auto',
          callback: async (token: string) => {
            try {
              await startSession(token)
              setMessage(null)
              onVerified()
            } catch (e) {
              setMessage(e instanceof ApiError ? e.message : 'Could not reach the LayerLift server.')
              if (widget) ts.reset(widget)
            }
          },
          'error-callback': () => setMessage('The check could not run. Reload the page to try again.'),
          'expired-callback': () => widget && ts.reset(widget),
        })
      })
      .catch(() => alive && setMessage('The human check could not load. Check your connection or ad blocker, then reload.'))
    return () => {
      alive = false
      if (widget && window.turnstile) window.turnstile.remove(widget)
    }
  }, [siteKey, onVerified])

  return (
    <div className="human-check">
      <p className="hint">Confirm you're human to start. This keeps the service available for everyone.</p>
      <div ref={box} />
      {message && <p className="hint danger">{message}</p>}
    </div>
  )
}

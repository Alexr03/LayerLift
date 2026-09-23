import { useLayoutEffect } from 'react'

interface Props {
  state: 'loading' | 'error' | 'leaving'
  onRetry: () => void
}

/**
 * The loading screen, shown until the server has confirmed the visitor's account and limits.
 * index.html paints the same markup before any script runs; this takes it over (removing the
 * static copy before the browser paints) and adds the error state with a retry button.
 */
export default function Splash({ state, onRetry }: Props) {
  useLayoutEffect(() => {
    document.getElementById('splash')?.remove()
  }, [])

  return (
    <div className={state === 'error' ? 'splash splash-failed' : state === 'leaving' ? 'splash leaving' : 'splash'} role={state === 'error' ? 'alert' : 'status'} aria-live="polite">
      <svg className="splash-mark" viewBox="0 0 32 32" aria-hidden="true">
        <rect className="l1" x="4" y="22" width="24" height="5" rx="1" />
        <rect className="l2" x="8" y="16" width="16" height="5" rx="1" />
        <rect className="l3" x="12" y="10" width="8" height="5" rx="1" />
        <rect className="l4" x="14" y="5" width="4" height="4" rx="1" />
      </svg>
      <div className="splash-name">LayerLift</div>
      {state === 'error' ? (
        <>
          <p className="splash-note">Can't reach the LayerLift server right now.</p>
          <button type="button" className="splash-retry" onClick={onRetry}>
            Try again
          </button>
        </>
      ) : (
        <p className="splash-note">Loading…</p>
      )}
    </div>
  )
}

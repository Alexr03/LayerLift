import { useLayoutEffect } from 'react'
import Wordmark from './Wordmark'

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
      <Wordmark />
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

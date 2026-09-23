import { type CSSProperties, useId } from 'react'
import { LOGO } from '../logo-data'

/**
 * The LayerLift wordmark: the word in three layers, each sheared up a little more (--a), so it
 * lifts off to the right. Outlines come from logo-data.ts and the styles from index.html; both are
 * written by docs/brand/make_logo.py, which also writes the loading screen's static copy.
 */
export default function Wordmark({ className }: { className?: string }) {
  const id = `wm${useId().replace(/[^a-zA-Z0-9]/g, '')}`
  const [x, y, w, h] = LOGO.viewBox
  const origin = `${-x}px ${-y}px` // user-space (0, 0), where the layers are hinged
  return (
    <svg className={className ? `wordmark ${className}` : 'wordmark'} viewBox={`${x} ${y} ${w} ${h}`} role="img" aria-label="LayerLift">
      <defs>
        <path id={id} d={LOGO.d} />
      </defs>
      {LOGO.angles.map((a, i) => (
        <g key={i} className="wm-layer" style={{ '--a': `${a}deg`, transformOrigin: origin } as CSSProperties}>
          <use href={`#${id}`} className={`l${i} edge`} transform={`translate(0 ${LOGO.edge})`} />
          <use href={`#${id}`} className={`l${i}`} />
        </g>
      ))}
    </svg>
  )
}

interface Props {
  title: string
  /** 0..1, or null for work whose length is unknown. */
  progress: number | null
  detail?: string
}

/** Progress shown over the build plate while LayerLift is working. */
export default function ProgressCard({ title, progress, detail }: Props) {
  const pct = progress == null ? null : Math.round(progress * 100)
  return (
    <div className="progress-overlay">
      <div className="progress-card" role="status" aria-live="polite">
        <div className="progress-head">
          <strong>{title}</strong>
          {pct != null && <span className="progress-pct">{pct}%</span>}
        </div>
        <div
          className={pct == null ? 'progress-bar indeterminate' : 'progress-bar'}
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct ?? undefined}
          aria-label={title}
        >
          <div className="progress-fill" style={pct == null ? undefined : { width: `${Math.max(2, pct)}%` }} />
        </div>
        {detail && <p className="hint">{detail}</p>}
      </div>
    </div>
  )
}

import { useState } from 'react'

interface Props {
  value: number
  min: number
  max: number
  step?: number
  onChange: (v: number) => void
  'aria-label'?: string
}

/**
 * A number input that lets you type freely: a value is applied as soon as it's in range, and
 * anything else is clamped when you leave the field (or press Enter). Clamping on every
 * keystroke would turn the "2" of "256" into the minimum before you could type the rest.
 */
export default function NumberField({ value, min, max, step = 1, onChange, ...rest }: Props) {
  const [draft, setDraft] = useState<string | null>(null)
  const commit = () => {
    if (draft == null) return
    const v = Number(draft)
    if (draft.trim() !== '' && Number.isFinite(v)) onChange(Math.min(max, Math.max(min, v)))
    setDraft(null)
  }
  return (
    <input
      type="number"
      value={draft ?? String(value)}
      min={min}
      max={max}
      step={step}
      aria-label={rest['aria-label']}
      onChange={(e) => {
        const text = e.target.value
        setDraft(text)
        const v = Number(text)
        if (text.trim() !== '' && Number.isFinite(v) && v >= min && v <= max) onChange(v)
      }}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
    />
  )
}

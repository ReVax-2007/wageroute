import type { ReactNode } from 'react'

interface Props {
  label: string
  hint?: string
  /** The reason this field was refused, shown under the control like the desktop's dialogs. */
  error?: string
  children: ReactNode
}

/** One labelled control in a sheet. The hint is the same kind of advice the desktop's dialogs give. */
export function Field({ label, hint, error, children }: Props) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {error ? (
        <span className="form-error" role="alert">
          {error}
        </span>
      ) : null}
      {hint ? <span className="muted small">{hint}</span> : null}
    </label>
  )
}

interface CheckboxProps {
  label: string
  checked: boolean
  onChange: (checked: boolean) => void
}

export function Checkbox({ label, checked, onChange }: CheckboxProps) {
  return (
    <label className="check">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span>{label}</span>
    </label>
  )
}

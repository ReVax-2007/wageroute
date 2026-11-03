import type { ReactNode } from 'react'
import { Sheet } from './Sheet'
import { useSheetSave } from './useSheetSave'

interface DeleteConfirmProps {
  title: string
  hint: string
  detail: ReactNode
  confirmLabel: string
  /** Back to the row sheet — the question was only a wrong tap. */
  onCancel: () => void
  /** The row is gone from phone storage, so both sheets can close. */
  onDone: () => void
  /** The writer that retires the row. A refusal lands on this sheet, not the one behind it. */
  remove: () => Promise<unknown>
}

/**
 * Deleting a bill or a goal is the one action on the phone that a thumb can hit by
 * accident, so it asks first — the same question the desktop shows for the same row.
 */
export function DeleteConfirm({
  title,
  hint,
  detail,
  confirmLabel,
  onCancel,
  onDone,
  remove
}: DeleteConfirmProps) {
  const { saving, error, run } = useSheetSave(onDone)

  return (
    <Sheet title={title} hint={hint} onClose={onCancel}>
      <p className="confirm-text">{detail}</p>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="sheet-actions">
        <button type="button" className="button" disabled={saving} onClick={onCancel}>
          Keep it
        </button>
        <button type="button" className="button danger" disabled={saving} onClick={() => void run(remove)}>
          {saving ? 'Removing…' : confirmLabel}
        </button>
      </div>
    </Sheet>
  )
}

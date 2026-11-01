import { useState } from 'react'

/**
 * The save state every dialog shares: one `saving` flag for its disabled
 * buttons, one `error` line for a message the store did not already show, and a
 * `run` that closes the dialog only when the write succeeded.
 */
export function useDialogSave(onSaved: () => void) {
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = async (submit: () => Promise<boolean>): Promise<boolean> => {
    setSaving(true)
    setError(null)
    try {
      const ok = await submit()
      if (ok) onSaved()
      return ok
    } finally {
      setSaving(false)
    }
  }

  return { saving, error, setError, run }
}

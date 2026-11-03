import { useRef, useState } from 'react'
import { RepositoryError } from '@shared/errors'

/** The reason a write refused, in the same words the desktop uses. */
export function refusalReason(caught: unknown): string {
  if (caught instanceof RepositoryError) return caught.message
  return caught instanceof Error && caught.message ? caught.message : 'That change could not be saved'
}

/**
 * Save state every Pocket sheet shares: one disabled flag while the write is in
 * flight, one error line carrying the desktop's own refusal, and a close that
 * only happens once phone storage has actually taken the new ledger.
 */
export function useSheetSave(onSaved: () => void) {
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // A second tap arrives before React re-renders the disabled button, so the
  // state flag alone cannot stop a double submit; the ref is set synchronously.
  const inFlight = useRef(false)

  const run = async (submit: () => Promise<unknown>): Promise<boolean> => {
    if (inFlight.current) return false
    inFlight.current = true
    setSaving(true)
    setError(null)
    try {
      await submit()
      onSaved()
      return true
    } catch (caught) {
      setError(refusalReason(caught))
      return false
    } finally {
      inFlight.current = false
      setSaving(false)
    }
  }

  return { saving, error, setError, run }
}

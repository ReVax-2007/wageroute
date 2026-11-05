import { useEffect, useState } from 'react'
import { LockKeyholeOpen } from 'lucide-react'
import { formatDateLabel, localDateISO } from '@shared/dates'
import { usePocket, type SealFailure } from '../lib/store'
import { hasCipher, NO_CIPHER_HERE } from '../lib/webcrypto'
import { Field } from './Field'
import { Sheet } from './Sheet'

/**
 * The phone's half of a sealed export. Nothing about its contents can be shown
 * yet — not from caution but because the rows are under the cipher — so this
 * asks for the one thing that can count them and stays on the same box when the
 * answer is wrong. Mounted once, at the app, because a sealed file can arrive
 * either from the first-run screen or from a merge on Data.
 */
export function UnlockSeal() {
  const pending = usePocket((state) => state.pendingSeal)
  const unlockSeal = usePocket((state) => state.unlockSeal)
  const cancelSeal = usePocket((state) => state.cancelSeal)
  const [phrase, setPhrase] = useState('')
  const [visible, setVisible] = useState(false)
  const [failure, setFailure] = useState<SealFailure | null>(null)
  const [opening, setOpening] = useState(false)

  // A different file is a different question: the phrase typed for the last one
  // must not still sit in the box under a file sealed with another.
  useEffect(() => {
    setPhrase('')
    setVisible(false)
    setFailure(null)
    setOpening(false)
  }, [pending])

  if (!pending) return null
  const made = formatDateLabel(localDateISO(pending.exportedAt))
  const cipher = hasCipher()

  return (
    <Sheet
      title="Open an encrypted backup"
      hint={`${pending.name} · written ${made}`}
      onClose={cancelSeal}
    >
      <p className="confirm-text">
        This export was sealed with a passphrase, so nothing in it can be counted until that phrase
        opens it.
      </p>
      <Field label="Passphrase" error={failure ? failure.message : undefined}>
        <input
          className="input"
          type={visible ? 'text' : 'password'}
          value={phrase}
          onChange={(event) => {
            setPhrase(event.target.value)
            setFailure(null)
          }}
          autoComplete="off"
          spellCheck={false}
        />
      </Field>
      <button type="button" className="button compact" onClick={() => setVisible((now) => !now)}>
        {visible ? 'Hide' : 'Show'}
      </button>
      {!cipher ? (
        <p className="notice warn" role="status">
          {NO_CIPHER_HERE} The file is not the problem and choosing another will not fix this one —
          it opens as soon as the app is reached over HTTPS, or on the machine it runs on.
        </p>
      ) : failure && !failure.retry ? (
        <p className="form-error" role="alert">
          That is not a problem the passphrase can fix — the file itself is not one WageRoute can
          open. Choose a different file.
        </p>
      ) : null}
      {cipher ? (
        <p className="hint">
          WageRoute kept no copy of this phrase and there is no reset: a lost one means this file
          stays shut for good. Opening it changes nothing on this phone until the import runs.
        </p>
      ) : null}
      <div className="sheet-actions">
        <button type="button" className="button" onClick={cancelSeal}>
          Choose a different file
        </button>
        <button
          type="button"
          className="button primary"
          disabled={opening || phrase === '' || !cipher}
          onClick={() => {
            setOpening(true)
            void unlockSeal(phrase).then((result) => {
              // Success closes this sheet by clearing the file it was holding, so
              // only a failure needs the button back.
              if (result) {
                setFailure(result)
                setOpening(false)
              }
            })
          }}
        >
          {opening ? 'Opening…' : (
            <>
              <LockKeyholeOpen size={17} aria-hidden="true" /> Open it
            </>
          )}
        </button>
      </div>
    </Sheet>
  )
}

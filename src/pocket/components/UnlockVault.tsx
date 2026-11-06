import { useEffect, useState } from 'react'
import { LockKeyholeOpen, ShieldCheck } from 'lucide-react'
import { formatDateLabel, localDateISO } from '@shared/dates'
import { usePocket, type VaultProblem } from '../lib/store'
import { isV2, typedKinds } from '../lib/vault'
import { hasCipher, NO_CIPHER_HERE } from '../lib/webcrypto'
import { Field } from './Field'
import { Sheet } from './Sheet'

/**
 * The gate over this phone's own sealed copy.
 *
 * It is a screen rather than a sheet because there is nothing behind it to go back
 * to: every number the app would show is under the cipher, and a phone that said
 * "here is your ledger" over unreadable bytes would be lying. The vault's marker is
 * in the clear, so the date the copy was sealed can be shown — the one fact about
 * it that does not need the phrase.
 *
 * Erasing is offered here even though it is destructive. A forgotten passphrase has
 * no reset and nobody holding a copy but the owner, so this screen has exactly two
 * doors: the phrase, and the delete. Hiding the second would leave a person whose
 * vault will not open with nothing but the browser's site-data settings to resort
 * to — a worse way to arrive at the same place.
 */
export function UnlockVault() {
  const status = usePocket((state) => state.status)
  const marker = usePocket((state) => state.vault)
  const unlock = usePocket((state) => state.unlockVaultWith)
  const unlockWithPasskey = usePocket((state) => state.unlockVaultWithPasskey)
  const forget = usePocket((state) => state.forget)
  const [phrase, setPhrase] = useState('')
  const [visible, setVisible] = useState(false)
  const [problem, setProblem] = useState<VaultProblem | null>(null)
  const [opening, setOpening] = useState(false)
  const [erasing, setErasing] = useState(false)

  // Coming back to a locked phone is a new question: the phrase typed for the last
  // attempt must not still be sitting in the box.
  useEffect(() => {
    if (status !== 'locked') return
    setPhrase('')
    setVisible(false)
    setProblem(null)
    setOpening(false)
    setErasing(false)
  }, [status])

  if (status !== 'locked' || !marker) return null
  const made = formatDateLabel(localDateISO(marker.createdAt))
  const cipher = hasCipher()
  const kinds = typedKinds(marker)
  const noun = kinds.passphrase && kinds.pin ? 'passphrase or PIN' : kinds.pin ? 'PIN' : 'passphrase'
  const hasPasskey = isV2(marker) && Boolean(marker.wraps.passkey)
  const usePasskey = (): void => {
    if (opening) return
    setOpening(true)
    setProblem(null)
    void unlockWithPasskey().then((result) => {
      if (result) {
        setProblem(result)
        setOpening(false)
      }
    })
  }

  return (
    <div className="screen">
      <form
        className="card"
        onSubmit={(event) => {
          event.preventDefault()
          if (opening || phrase === '') return
          setOpening(true)
          void unlock(phrase).then((result) => {
            // Success takes this screen away: the store has the rows again. Only a
            // refusal needs the button back.
            if (result) {
              setProblem(result)
              setOpening(false)
            }
          })
        }}
      >
        <h2 className="card-title">
          <ShieldCheck size={18} aria-hidden="true" /> Sealed on {made}
        </h2>
        <p>
          This phone holds your ledger, but every row of it is under a {noun}. WageRoute can say
          when the copy was sealed and nothing else about what is inside.
        </p>
        {hasPasskey && cipher ? (
          <button type="button" className="button primary" disabled={opening} onClick={usePasskey}>
            <LockKeyholeOpen size={17} aria-hidden="true" /> Use fingerprint or face
          </button>
        ) : null}
        <Field label={noun === 'PIN' ? 'PIN' : noun === 'passphrase' ? 'Passphrase' : 'Passphrase or PIN'} error={problem ? problem.message : undefined}>
          <input
            className="input"
            type={visible ? 'text' : 'password'}
            inputMode={noun === 'PIN' ? 'numeric' : undefined}
            value={phrase}
            onChange={(event) => {
              setPhrase(event.target.value)
              setProblem(null)
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
            {NO_CIPHER_HERE} Your ledger is not damaged and erasing it would not help: this page
            simply cannot reach a cipher. Opening the same app over HTTPS, or on the machine it runs
            on, will.
          </p>
        ) : problem && !problem.retry ? (
          <p className="notice warn">
            Typing again will not change this. The copy on this phone is damaged, and the way back
            is a backup from your computer.
          </p>
        ) : null}
        <p className="hint">
          WageRoute kept no copy of what you type here. There is no reset and nobody who can open
          this for you: the {noun} is the whole defence, and also the only way back in.
        </p>
        <div className="card-actions">
          <button
            type="submit"
            className="button primary"
            disabled={opening || phrase === '' || !cipher}
          >
            <LockKeyholeOpen size={17} aria-hidden="true" />
            {opening ? 'Opening…' : 'Open my ledger'}
          </button>
          {/* A page with no cipher cannot open a healthy vault, so the delete here would
              be the end of a copy that only looks lost. The way out is a different URL. */}
          <button
            type="button"
            className="button"
            disabled={!cipher}
            onClick={() => setErasing(true)}
          >
            Forget this phone’s copy
          </button>
        </div>
      </form>

      {erasing ? (
        <Sheet
          title="Erase the copy on this phone?"
          hint="This is the door for a phrase that is gone for good. It deletes what is here and nothing else."
          onClose={() => setErasing(false)}
        >
          <p className="confirm-text">
            Your computer keeps its own ledger, and any backup you exported is still a file you can
            bring back. What lives only on this phone goes with it, and no passphrase will recover it
            afterwards.
          </p>
          <div className="sheet-actions">
            <button type="button" className="button" onClick={() => setErasing(false)}>
              Keep it
            </button>
            <button
              type="button"
              className="button danger"
              onClick={() => {
                setErasing(false)
                void forget()
              }}
            >
              Erase this phone
            </button>
          </div>
        </Sheet>
      ) : null}
    </div>
  )
}

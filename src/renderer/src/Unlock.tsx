import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Button } from './components/ui'

/**
 * The screen shown while a ledger is locked.
 *
 * It is the whole app for that window: no ledger channel exists yet, so there is
 * nothing here to read, write or leak. The passphrase goes to the main process
 * and comes back only as "that did not open it" — the answer itself is never
 * echoed, stored or logged, and the window keeps no history of the attempts.
 */
/** What the main process said this ledger accepts, from the page address it chose. */
function typedKind(): 'passphrase' | 'pin' | 'either' {
  const typed = new URLSearchParams(window.location.search).get('typed')
  return typed === 'pin' || typed === 'either' ? typed : 'passphrase'
}

const WORDS = {
  passphrase: { noun: 'passphrase', label: 'Passphrase' },
  pin: { noun: 'PIN', label: 'PIN' },
  either: { noun: 'passphrase or PIN', label: 'Passphrase or PIN' }
} as const

export default function Unlock() {
  const kind = typedKind()
  const words = WORDS[kind]
  const [passphrase, setPassphrase] = useState('')
  const [visible, setVisible] = useState(false)
  const [checking, setChecking] = useState(false)
  const [wrong, setWrong] = useState(false)
  const [stuck, setStuck] = useState(false)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    input.current?.focus()
    // The main process says only that the last answer did not open the ledger.
    return window.unlock.onRetry(() => {
      setChecking(false)
      setWrong(true)
      input.current?.focus()
      input.current?.select()
    })
  }, [])

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (checking || passphrase.length === 0) return
    setWrong(false)
    setStuck(false)
    setChecking(true)
    // `false` means the prompt is no longer listening, which happens if the app
    // gave up while this window was still open. Saying so beats a spinner forever.
    if (!(await window.unlock.submit(passphrase))) {
      setChecking(false)
      setStuck(true)
    }
  }

  return (
    <div className="boot unlock">
      <h1>This ledger is encrypted</h1>
      <p className="unlock-lead">
        Type the {words.noun} that holds its key. Nothing in WageRoute opens until you do.
      </p>

      <form onSubmit={(event) => void submit(event)}>
        <div className="field">
          <label className="field-label" htmlFor="unlock-passphrase">
            {words.label}
          </label>
          <div className="unlock-row">
            <input
              id="unlock-passphrase"
              className="input"
              type={visible ? 'text' : 'password'}
              inputMode={kind === 'pin' ? 'numeric' : undefined}
              value={passphrase}
              onChange={(event) => setPassphrase(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              disabled={checking}
              aria-invalid={wrong || stuck}
              aria-describedby={wrong ? 'unlock-wrong' : stuck ? 'unlock-stuck' : undefined}
            />
            <Button
              type="button"
              size="sm"
              variant="ghost"
              aria-pressed={visible}
              onClick={() => setVisible((now) => !now)}
            >
              {visible ? 'Hide' : 'Show'}
            </Button>
          </div>
          {wrong && (
            <p id="unlock-wrong" className="field-error" role="alert">
              That {words.noun} does not open this ledger.
            </p>
          )}
          {stuck && (
            <p id="unlock-stuck" className="field-error" role="alert">
              WageRoute is no longer waiting for an answer. Close this window and open the app again.
            </p>
          )}
        </div>

        <Button type="submit" variant="primary" disabled={checking || passphrase.length === 0}>
          {checking ? 'Checking…' : 'Unlock'}
        </Button>
      </form>

      <p className="boot-hint">
        Closing this window leaves WageRoute shut and your ledger exactly as it is. If the {words.noun}{' '}
        is gone, a backup exported before encryption is the only way back in.
      </p>
    </div>
  )
}

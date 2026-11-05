import { useState } from 'react'
import { LockKeyhole, LockKeyholeOpen, ShieldCheck } from 'lucide-react'
import { MIN_PASSPHRASE_CHARACTERS } from '@shared/encryption'
import { formatDateLabel, localDateISO } from '@shared/dates'
import { usePocket, type VaultProblem } from '../lib/store'
import { hasCipher, NO_CIPHER_HERE } from '../lib/webcrypto'
import { Field } from './Field'
import { Sheet } from './Sheet'

/** Which question the sheet is asking. Each one runs a different store action. */
type Mode = 'enable' | 'change' | 'disable'

const BOXES: Record<Mode, ('current' | 'next' | 'confirm')[]> = {
  enable: ['next', 'confirm'],
  change: ['current', 'next', 'confirm'],
  disable: ['current']
}

const LABELS: Record<'current' | 'next' | 'confirm', string> = {
  current: 'Passphrase it uses now',
  next: 'New passphrase',
  confirm: 'Type it again'
}

const QUESTIONS: Record<Mode, { title: string; hint: string; submit: string }> = {
  enable: {
    title: 'Seal this phone’s copy?',
    hint: `The passphrase is checked before anything is written, then forgotten. ${MIN_PASSPHRASE_CHARACTERS} characters is the floor, not a target.`,
    submit: 'Seal it'
  },
  change: {
    title: 'Change the passphrase',
    hint: 'The one it uses now is asked for first, so a typo in the new one cannot lock you out of your own phone.',
    submit: 'Change it'
  },
  disable: {
    title: 'Turn the seal off?',
    hint: 'This phone’s copy goes back to plain storage on this device. A passphrase is the only thing that can do it, so a lost one means this screen is not the way out.',
    submit: 'Turn it off'
  }
}

type Values = Record<'current' | 'next' | 'confirm', string>

const EMPTY: Values = { current: '', next: '', confirm: '' }

/**
 * The one switch on this phone's own copy, and the honest words around it.
 *
 * ADR 0029's rule is that an option has to say what it stops, what it does not, and
 * how it can lock the owner out — a toggle that only says "Encrypt" implies
 * protection it does not provide. The three lines below are the phone's version of
 * that table, and they stay in the card whether the vault is on or off, because the
 * moment to read them is before the choice rather than after it.
 */
export function VaultCard() {
  const vault = usePocket((state) => state.vault)
  const hasLedger = usePocket((state) => state.tables !== null)
  const lockNow = usePocket((state) => state.lockNow)
  const cipher = hasCipher()
  const [mode, setMode] = useState<Mode | null>(null)

  if (!hasLedger) return null

  return (
    <>
      <section className="card">
        <h2 className="card-title">
          <ShieldCheck size={18} aria-hidden="true" />
          {vault ? 'This phone’s copy is sealed' : 'Seal this phone’s copy'}
        </h2>
        <ul className="checks">
          <li>
            <b>Stops:</b> anyone reading the storage of this handset — a copied app folder, a device
            backup, a browser you did not open. They get bytes and a date, not your ledger.
          </li>
          <li>
            <b>Does not stop:</b> anyone using this phone while the app is open and unlocked, or
            shoulder-surfing the screen. It is not a second lock over the one your phone already has.
          </li>
          <li>
            <b>If you lose the phrase:</b> the copy on this phone is gone for good. No reset, no
            recovery, nobody holding a copy of it. Your computer and your exported backups are
            untouched.
          </li>
        </ul>
        {vault ? (
          <dl className="facts">
            <div>
              <dt>Sealed since</dt>
              <dd>{formatDateLabel(localDateISO(vault.createdAt))}</dd>
            </div>
            <div>
              <dt>Cost of a guess</dt>
              <dd>{vault.iterations.toLocaleString()} rounds</dd>
            </div>
          </dl>
        ) : null}
        {cipher ? (
          <>
            <div className="card-actions">
              {vault ? (
                <>
                  <button type="button" className="button" onClick={() => setMode('change')}>
                    Change the passphrase
                  </button>
                  <button type="button" className="button" onClick={() => setMode('disable')}>
                    Turn it off
                  </button>
                  <button type="button" className="button" onClick={lockNow}>
                    <LockKeyhole size={17} aria-hidden="true" /> Close it now
                  </button>
                </>
              ) : (
                <button type="button" className="button primary" onClick={() => setMode('enable')}>
                  <LockKeyholeOpen size={17} aria-hidden="true" /> Seal it
                </button>
              )}
            </div>
            <p className="hint">
              {vault
                ? 'Closing it takes the key out of this page without touching your data. Reopening asks for the phrase again, and so does closing the app and coming back.'
                : 'Nothing changes until you ask for it, and turning it back off is one question away. The app will ask for this phrase every time it is opened after being closed.'}
            </p>
          </>
        ) : (
          <p className="notice warn" role="status">
            {NO_CIPHER_HERE}
          </p>
        )}
      </section>

      {mode ? <VaultSheet mode={mode} onClose={() => setMode(null)} /> : null}
    </>
  )
}

/**
 * One sheet for all three questions, because the machinery is the same — a phrase
 * box, the same rules the desktop applies, and a store action that refuses before it
 * writes — and the copy that differs is the copy that has to be read carefully.
 */
function VaultSheet({ mode, onClose }: { mode: Mode; onClose: () => void }) {
  const enableVault = usePocket((state) => state.enableVault)
  const disableVault = usePocket((state) => state.disableVault)
  const changeVaultPassphrase = usePocket((state) => state.changeVaultPassphrase)
  const [values, setValues] = useState<Values>(EMPTY)
  const [visible, setVisible] = useState(false)
  const [problem, setProblem] = useState<VaultProblem | null>(null)
  const [working, setWorking] = useState(false)
  const question = QUESTIONS[mode]

  const run = async (): Promise<void> => {
    setWorking(true)
    const result =
      mode === 'enable'
        ? await enableVault(values.next, values.confirm)
        : mode === 'change'
          ? await changeVaultPassphrase(values.current, values.next, values.confirm)
          : await disableVault(values.current)
    setWorking(false)
    // The card behind this sheet is already the answer: it flips to the sealed
    // state when the store does, so only a refusal needs to stay on screen.
    if (result) {
      setProblem(result)
      return
    }
    setValues(EMPTY)
    onClose()
  }

  return (
    <Sheet title={question.title} hint={question.hint} onClose={() => (working ? undefined : onClose())}>
      {BOXES[mode].map((box) => (
        <Field
          key={box}
          label={LABELS[box]}
          error={box === BOXES[mode][0] && problem ? problem.message : undefined}
        >
          <input
            className="input"
            type={visible ? 'text' : 'password'}
            value={values[box]}
            onChange={(event) => {
              setValues((now) => ({ ...now, [box]: event.target.value }))
              setProblem(null)
            }}
            autoComplete="off"
            spellCheck={false}
          />
        </Field>
      ))}
      <button type="button" className="button compact" onClick={() => setVisible((now) => !now)}>
        {visible ? 'Hide' : 'Show'}
      </button>
      <div className="sheet-actions">
        <button type="button" className="button" disabled={working} onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="button primary"
          disabled={working || BOXES[mode].some((box) => values[box] === '')}
          onClick={() => void run()}
        >
          {working ? 'One moment…' : question.submit}
        </button>
      </div>
    </Sheet>
  )
}

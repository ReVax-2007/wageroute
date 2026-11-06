import { useState } from 'react'
import { LockKeyhole, LockKeyholeOpen, ShieldCheck } from 'lucide-react'
import { MIN_PASSPHRASE_CHARACTERS, PIN_WARNING } from '@shared/encryption'
import { formatDateLabel, localDateISO } from '@shared/dates'
import { usePocket, type VaultProblem } from '../lib/store'
import { isV2, type VaultMarker } from '../lib/vault'
import { hasCipher, NO_CIPHER_HERE } from '../lib/webcrypto'
import { Field } from './Field'
import { Sheet } from './Sheet'

/** Which question the sheet is asking. Each one runs a different store action. */
type Mode =
  | 'enable'
  | 'change'
  | 'disable'
  | 'add-pin'
  | 'change-pin'
  | 'add-passphrase'
  | 'add-passkey'
  | 'remove-pin'
  | 'remove-passphrase'
  | 'remove-passkey'

type Box = 'current' | 'next' | 'confirm'

const BOXES: Record<Mode, Box[]> = {
  enable: ['next', 'confirm'],
  change: ['current', 'next', 'confirm'],
  disable: ['current'],
  'add-pin': ['current', 'next', 'confirm'],
  'change-pin': ['current', 'next', 'confirm'],
  'add-passphrase': ['current', 'next', 'confirm'],
  'add-passkey': ['current'],
  'remove-pin': [],
  'remove-passphrase': [],
  'remove-passkey': []
}

/** The boxes' labels, by what the sheet is asking for. A PIN gets the number pad. */
function labelFor(mode: Mode, box: Box): string {
  if (box === 'confirm') return 'Type it again'
  if (box === 'next') return mode === 'add-pin' || mode === 'change-pin' ? 'New PIN' : 'New passphrase'
  if (mode === 'change-pin') return 'PIN it uses now'
  if (mode === 'change') return 'Passphrase it uses now'
  return 'Passphrase or PIN it uses now'
}

const NUMERIC: ReadonlySet<Mode> = new Set(['add-pin', 'change-pin'])

/** Whether this page can run a passkey at all. The ceremony itself is the real test. */
function passkeysHere(): boolean {
  return typeof PublicKeyCredential !== 'undefined' && window.isSecureContext
}

/** The three sentences for the phone's own wraps, beside the vault's own (ADR 0031). */
const PIN_ROWS = {
  stops: 'someone who has the phone but not the PIN, while the copy is closed — and it is quicker to type than a phrase.',
  doesNot: PIN_WARNING,
  lose: 'type the passphrase instead, if the copy still has one. A PIN that is the only thing left goes the way a lost phrase does.'
}
const PASSKEY_ROWS = {
  stops:
    'someone reading this handset’s storage, without you typing anything: the secret never leaves your phone’s authenticator.',
  doesNot:
    'anyone who knows your phone’s passcode — it stands in for the fingerprint — or who controls the Apple or Google account the passkey syncs through and signs in on a device of their own.',
  lose: 'nothing is lost. The passphrase stays as long as the passkey does, and opens the same copy.'
}

const QUESTIONS: Record<Mode, { title: string; hint: string; submit: string }> = {
  'add-pin': {
    title: 'Add a PIN?',
    hint: `${PIN_WARNING} Digits only, at least six.`,
    submit: 'I understand — add the PIN'
  },
  'change-pin': {
    title: 'Change the PIN',
    hint: `${PIN_WARNING} The one it uses now is asked for first.`,
    submit: 'I understand — change it'
  },
  'add-passphrase': {
    title: 'Add a passphrase',
    hint: `The passphrase opens this copy alongside the PIN. ${MIN_PASSPHRASE_CHARACTERS} characters is the floor, not a target.`,
    submit: 'Add it'
  },
  'add-passkey': {
    title: 'Open it with your fingerprint or face?',
    hint: 'Your phone will ask to save a passkey, then for your fingerprint or face up to twice more, to prove it gives the same key back. Nothing is saved unless it does.',
    submit: 'Set it up'
  },
  'remove-pin': {
    title: 'Remove the PIN?',
    hint: 'The PIN stops opening this copy. The passphrase keeps working.',
    submit: 'Remove it'
  },
  'remove-passphrase': {
    title: 'Remove the passphrase?',
    hint: `The PIN becomes the only thing that opens this copy. ${PIN_WARNING}`,
    submit: 'Remove it'
  },
  'remove-passkey': {
    title: 'Stop using fingerprint or face?',
    hint: 'It stops opening this copy. The passphrase keeps working; the passkey itself stays in your phone’s password manager until you delete it there.',
    submit: 'Stop using it'
  },
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
        {vault && wraps(vault).pin ? (
          <ul className="checks">
            <li>
              <b>The PIN stops:</b> {PIN_ROWS.stops}
            </li>
            <li>
              <b>It does not stop:</b> {PIN_ROWS.doesNot}
            </li>
            <li>
              <b>If you forget it:</b> {PIN_ROWS.lose}
            </li>
          </ul>
        ) : null}
        {vault && wraps(vault).passkey ? (
          <ul className="checks">
            <li>
              <b>Fingerprint or face stops:</b> {PASSKEY_ROWS.stops}
            </li>
            <li>
              <b>It does not stop:</b> {PASSKEY_ROWS.doesNot}
            </li>
            <li>
              <b>If you lose the passkey:</b> {PASSKEY_ROWS.lose}
            </li>
          </ul>
        ) : null}
        {vault ? (
          <dl className="facts">
            <div>
              <dt>Sealed since</dt>
              <dd>{formatDateLabel(localDateISO(vault.createdAt))}</dd>
            </div>
            <div>
              <dt>Opens with</dt>
              <dd>{waysIn(vault)}</dd>
            </div>
            {costOfGuess(vault) ? (
              <div>
                <dt>Cost of a guess</dt>
                <dd>{costOfGuess(vault)}</dd>
              </div>
            ) : null}
          </dl>
        ) : null}
        {cipher ? (
          <>
            <div className="card-actions">
              {vault ? (
                <>
                  {wraps(vault).passphrase ? (
                    <button type="button" className="button" onClick={() => setMode('change')}>
                      Change the passphrase
                    </button>
                  ) : (
                    <button type="button" className="button" onClick={() => setMode('add-passphrase')}>
                      Add a passphrase
                    </button>
                  )}
                  <button
                    type="button"
                    className="button"
                    onClick={() => setMode(wraps(vault).pin ? 'change-pin' : 'add-pin')}
                  >
                    {wraps(vault).pin ? 'Change the PIN' : 'Add a PIN'}
                  </button>
                  {!wraps(vault).passkey && wraps(vault).passphrase && passkeysHere() ? (
                    <button type="button" className="button" onClick={() => setMode('add-passkey')}>
                      Use fingerprint or face
                    </button>
                  ) : null}
                  {wraps(vault).passkey ? (
                    <button type="button" className="button" onClick={() => setMode('remove-passkey')}>
                      Stop using fingerprint or face
                    </button>
                  ) : null}
                  {wraps(vault).pin && wraps(vault).passphrase ? (
                    <button type="button" className="button" onClick={() => setMode('remove-pin')}>
                      Remove the PIN
                    </button>
                  ) : null}
                  {wraps(vault).pin && wraps(vault).passphrase && !wraps(vault).passkey ? (
                    <button type="button" className="button" onClick={() => setMode('remove-passphrase')}>
                      Remove the passphrase
                    </button>
                  ) : null}
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

/** Which ways in a marker holds. A v1 vault is its passphrase and nothing else. */
function wraps(marker: VaultMarker): { passphrase: boolean; pin: boolean; passkey: boolean } {
  if (!isV2(marker)) return { passphrase: true, pin: false, passkey: false }
  return {
    passphrase: Boolean(marker.wraps.passphrase),
    pin: Boolean(marker.wraps.pin),
    passkey: Boolean(marker.wraps.passkey)
  }
}

function waysIn(marker: VaultMarker): string {
  const held = wraps(marker)
  return [held.passkey && 'fingerprint or face', held.passphrase && 'passphrase', held.pin && 'PIN']
    .filter(Boolean)
    .join(', ')
}

function costOfGuess(marker: VaultMarker): string | null {
  if (!isV2(marker)) return `${marker.iterations.toLocaleString()} rounds`
  const phrase = marker.wraps.passphrase?.iterations
  const pin = marker.wraps.pin?.iterations
  return [phrase && `${phrase.toLocaleString()} rounds per phrase`, pin && `${pin.toLocaleString()} per PIN`]
    .filter(Boolean)
    .join(', ') || null
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
  const addWayIn = usePocket((state) => state.addVaultWayIn)
  const removeWayIn = usePocket((state) => state.removeVaultWayIn)
  const changeVaultPin = usePocket((state) => state.changeVaultPin)
  const [values, setValues] = useState<Values>(EMPTY)
  const [visible, setVisible] = useState(false)
  const [problem, setProblem] = useState<VaultProblem | null>(null)
  const [working, setWorking] = useState(false)
  const question = QUESTIONS[mode]

  const run = async (): Promise<void> => {
    setWorking(true)
    const result = await (() => {
      switch (mode) {
        case 'enable':
          return enableVault(values.next, values.confirm)
        case 'change':
          return changeVaultPassphrase(values.current, values.next, values.confirm)
        case 'disable':
          return disableVault(values.current)
        case 'add-pin':
          return addWayIn(values.current, { kind: 'pin', pin: values.next, confirm: values.confirm })
        case 'change-pin':
          return changeVaultPin(values.current, values.next, values.confirm)
        case 'add-passphrase':
          return addWayIn(values.current, { kind: 'passphrase', passphrase: values.next, confirm: values.confirm })
        case 'add-passkey':
          return addWayIn(values.current, { kind: 'passkey' })
        case 'remove-pin':
          return removeWayIn('pin')
        case 'remove-passphrase':
          return removeWayIn('passphrase')
        case 'remove-passkey':
          return removeWayIn('passkey')
      }
    })()
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
          label={labelFor(mode, box)}
          error={box === BOXES[mode][0] && problem ? problem.message : undefined}
        >
          <input
            className="input"
            type={visible ? 'text' : 'password'}
            inputMode={NUMERIC.has(mode) && box !== 'current' ? 'numeric' : undefined}
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
      {BOXES[mode].length === 0 && problem ? (
        <p className="notice warn" role="alert">
          {problem.message}
        </p>
      ) : null}
      {BOXES[mode].length > 0 ? (
        <button type="button" className="button compact" onClick={() => setVisible((now) => !now)}>
          {visible ? 'Hide' : 'Show'}
        </button>
      ) : null}
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

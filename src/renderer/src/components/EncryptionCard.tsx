import { useEffect, useState, type ReactNode } from 'react'
import { Lock, LockOpen, ShieldCheck } from 'lucide-react'
import type { CustodyMethod, EncryptionStatus, KeyCustodyChange } from '@shared/encryption'
import { CUSTODY_COPY, custodyCopy, custodyInUse, passphraseProblem } from '@shared/encryption'
import { apiErrorMessage } from '@shared/errors'
import { Button, Card, Field, Modal, Segmented } from './ui'
import { useFinanceStore } from '../store/useFinanceStore'

/**
 * The Settings screen's encryption toggle.
 *
 * Two decisions shape this component. It renders the honesty table from
 * `@shared/encryption` rather than sentences of its own, because an option and
 * its weakness have to travel together — a button that says "Encrypt" without
 * saying what it does not stop is the thing ADR 0020 forbids. And it never
 * pretends a change is instant: both directions rewrite every page and restart
 * the app, which is said before the button is clicked, not after.
 *
 * Re-wrapping the key is the one operation here that does not restart anything,
 * so it is the one that keeps the screen live and reads its new state back.
 */

type Form = 'enable' | 'passphrase' | null

export function EncryptionCard() {
  const askConfirm = useFinanceStore((state) => state.askConfirm)
  const [status, setStatus] = useState<EncryptionStatus | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [form, setForm] = useState<Form>(null)
  const [custody, setCustody] = useState<CustodyMethod>('both')
  const [passphrase, setPassphrase] = useState('')
  const [again, setAgain] = useState('')
  const [current, setCurrent] = useState('')
  const [fieldError, setFieldError] = useState<string | null>(null)
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    let alive = true
    window.api
      .getEncryptionStatus()
      .then((next) => {
        if (alive) setStatus(next)
      })
      .catch((error: unknown) => {
        if (alive) setFailed(apiErrorMessage(error))
      })
    return () => {
      alive = false
    }
  }, [])

  const inUse = status ? custodyInUse(status) : null
  const copy = inUse ? custodyCopy(inUse) : null
  // A machine with no keychain is not a choice, so it is not offered — and the
  // reason is said out loud rather than left as a missing option.
  const offered = CUSTODY_COPY.filter((entry) => entry.value !== 'device' || status?.deviceAvailable === true)
  const needsPhrase = custody !== 'device'
  const clearPhrases = (): void => {
    setPassphrase('')
    setAgain('')
    setCurrent('')
  }

  const openForm = (next: Form): void => {
    if (next === 'enable') setCustody(status?.deviceAvailable ? 'both' : 'passphrase')
    clearPhrases()
    setFieldError(null)
    setVisible(false)
    setNotice(null)
    setForm(next)
  }

  const closeForm = (): void => {
    if (busy) return
    setForm(null)
    setFieldError(null)
  }

  /**
   * Checked here for the same reason the main process checks it: the two must not
   * disagree, and a mismatch between the two boxes is the one mistake that costs
   * the ledger later, when nobody is around to type the first one.
   */
  const phraseCheck = (): string | null => {
    const problem = passphraseProblem(passphrase)
    if (problem) return problem
    if (passphrase !== again) return 'The two do not match. Type it once more in the second box.'
    return null
  }

  const refresh = async (): Promise<void> => {
    try {
      setStatus(await window.api.getEncryptionStatus())
    } catch (error: unknown) {
      setFailed(apiErrorMessage(error))
    }
  }

  const submitEnable = async (): Promise<void> => {
    if (needsPhrase) {
      const problem = phraseCheck()
      if (problem) {
        setFieldError(problem)
        return
      }
    }
    const ok = await askConfirm({
      title: 'Encrypt your ledger?',
      body:
        'Every page of the ledger is rewritten as ciphertext, and the dated copies WageRoute keeps ' +
        'beside it from now on. It takes a few seconds, nothing is left in plaintext, and it can be ' +
        'undone from this same screen. WageRoute restarts when it is done and opens the way you chose.',
      confirmLabel: 'Encrypt it'
    })
    if (!ok) return
    setForm(null)
    setBusy(true)
    setFailed(null)
    setNotice('Rewriting the ledger. WageRoute will restart itself once the change has been checked.')
    try {
      await window.api.enableEncryption({ custody, passphrase: needsPhrase ? passphrase : undefined })
      // Stays busy: the reply only says a restart is coming, and a second click
      // while the app is closing has nothing to act on.
    } catch (error: unknown) {
      setNotice(null)
      setFailed(apiErrorMessage(error))
      setBusy(false)
      void refresh()
    }
  }

  const submitDisable = async (): Promise<void> => {
    const ok = await askConfirm({
      title: 'Turn encryption off?',
      body:
        'Every page is rewritten back to plaintext and the key file beside the ledger is deleted. ' +
        'From then on anyone who can read this folder can read the whole ledger. WageRoute restarts ' +
        'when it is done.',
      confirmLabel: 'Turn it off',
      danger: true
    })
    if (!ok) return
    setBusy(true)
    setFailed(null)
    setNotice('Rewriting the ledger. WageRoute will restart itself once the change has been checked.')
    try {
      await window.api.disableEncryption()
    } catch (error: unknown) {
      setNotice(null)
      setFailed(apiErrorMessage(error))
      setBusy(false)
      void refresh()
    }
  }

  const applyCustody = async (change: KeyCustodyChange): Promise<void> => {
    setBusy(true)
    setFailed(null)
    try {
      setStatus(await window.api.changeKeyCustody(change))
      setForm(null)
      setNotice('The key was re-wrapped. No page of the ledger moved, so nothing needs restarting.')
    } catch (error: unknown) {
      setFailed(apiErrorMessage(error))
    } finally {
      setBusy(false)
      clearPhrases()
    }
  }

  const submitPassphrase = async (): Promise<void> => {
    const problem = phraseCheck()
    if (problem) {
      setFieldError(problem)
      return
    }
    if (status?.passphrase) {
      if (current.length === 0) {
        setFieldError('Type the passphrase it uses now, so this cannot overwrite the only way in.')
        return
      }
      await applyCustody({ action: 'change-passphrase', current, next: passphrase })
      return
    }
    await applyCustody({ action: 'add-passphrase', passphrase })
  }

  const removeLastWayIn = async (change: KeyCustodyChange, question: { title: string; body: string }): Promise<void> => {
    const ok = await askConfirm({ ...question, confirmLabel: 'Remove it', danger: true })
    if (ok) void applyCustody(change)
  }

  const headline = (
    status === null
      ? 'Checking this folder…'
      : !status.encrypted
        ? 'Not encrypted'
        : status.device && status.passphrase
          ? 'Encrypted — this computer or the passphrase opens it'
          : status.device
            ? 'Encrypted — this computer opens it without asking'
            : 'Encrypted — only the passphrase opens it'
  )

  const summary: ReactNode =
    status === null
      ? 'WageRoute reads the first bytes of the ledger to answer this, not a setting of its own.'
      : !status.encrypted
        ? 'Anyone who can read this folder can read the whole ledger in any spreadsheet, right now. This is the default, and it is the reasonable choice for a computer only you use.'
        : 'The file on disk is ciphertext. What can open it is the custody below and nothing else, including a copy of the folder on another machine.'

  return (
    <>
      <Card
        title="Encryption at rest"
        subtitle="Whether the ledger on disk can be read without WageRoute opening it"
        actions={status?.encrypted ? <Lock size={16} className="stat-icon" /> : <LockOpen size={16} className="stat-icon" />}
      >
        <div className="setting-row">
          <div>
            <strong>{headline}</strong>
            <p className="field-hint">{summary}</p>
          </div>
        </div>

        {status?.pending && (
          <p className="form-error" role="alert">
            A change to encryption ({status.pending === 'encrypt' ? 'turning it on' : 'turning it off'})
            started and never finished. Close WageRoute and open it again: the launch checks the ledger
            against that record before anything else is changed and puts the safety copy back if it has
            to. Nothing on this screen should be pressed until it has.
          </p>
        )}

        {status?.staleKeyFile && (
          <p className="field-hint">
            There is a key file beside the ledger while the ledger&apos;s own pages are plaintext — what an
            interrupted change leaves behind. Encrypting again replaces it with a live one; nothing here
            can undo an encryption that is not there.
          </p>
        )}

        {status?.encrypted && !status.passphrase && !status.deviceAvailable && (
          <p className="form-error" role="alert">
            This ledger&apos;s key is held by this computer&apos;s keychain, and this system is not offering
            WageRoute one. If the app is closed before a passphrase is added, this screen cannot be
            reached again — the launch would have no way in.
          </p>
        )}

        {copy && (
          <>
            <p className="field-hint">
              <strong>It protects against: </strong>
              {copy.protects}
            </p>
            <p className="field-hint">
              <strong>It does not stop: </strong>
              {copy.fails}
            </p>
            <p className="field-hint">
              <strong>If you lose it: </strong>
              {copy.lockout}
            </p>
          </>
        )}

        <div className="data-actions">
          {status && !status.encrypted && status.pending === null && (
            <Button icon={<ShieldCheck size={15} />} onClick={() => openForm('enable')} disabled={busy}>
              Encrypt my ledger…
            </Button>
          )}
          {status?.encrypted && (
            <>
              {!status.device && status.deviceAvailable && (
                <Button onClick={() => void applyCustody({ action: 'add-device' })} disabled={busy}>
                  Let this computer open it too
                </Button>
              )}
              {!status.passphrase && (
                <Button onClick={() => openForm('passphrase')} disabled={busy}>
                  Add a passphrase…
                </Button>
              )}
              {status.passphrase && (
                <Button onClick={() => openForm('passphrase')} disabled={busy}>
                  Change the passphrase…
                </Button>
              )}
              {status.passphrase && status.device && (
                <Button
                  onClick={() =>
                    void removeLastWayIn({ action: 'remove-passphrase' }, {
                      title: 'Remove the passphrase?',
                      body:
                        'This computer would then be the only way in: anyone signed in as you reads the ' +
                        'whole ledger, and a copy of the folder opens on this machine and nowhere else. ' +
                        'If this computer dies, the ledger dies with it.'
                    })
                  }
                  disabled={busy}
                >
                  Remove the passphrase
                </Button>
              )}
              {status.device && status.passphrase && (
                <Button
                  onClick={() =>
                    void removeLastWayIn({ action: 'remove-device' }, {
                      title: 'Stop letting this computer open it?',
                      body:
                        'Every launch will then ask for the passphrase, including one where you have just ' +
                        'signed in. The phrase becomes the only way in, and a forgotten one the only way out.'
                    })
                  }
                  disabled={busy}
                >
                  Stop letting this computer open it
                </Button>
              )}
              <Button variant="danger" onClick={() => void submitDisable()} disabled={busy}>
                Turn encryption off
              </Button>
            </>
          )}
        </div>

        <p className="field-hint">
          <strong>What it covers: </strong>the ledger file, and the dated copies WageRoute keeps in the
          backups folder beside it — those follow the ledger, so encrypting it means the copies from now
          on are encrypted too. Moving the data to another folder carries the key file with it.
        </p>
        <p className="field-hint">
          <strong>What it does not cover: </strong>an exported backup, unless the export was asked for
          with a passphrase — the plain JSON one is readable whoever holds the file, and it carries
          the settings as well as the money. Nor does it reach the phone, which keeps its own copy of
          the data: what carries between the two is the export, and its passphrase is separate from
          the one here.
        </p>
        <p className="field-hint">
          <strong>This is not a lock: </strong>it is encryption of the file, not a screen that hides your
          money. Once the key is in hand WageRoute opens the ledger without asking again, and the keychain
          on this computer answers to your login, not to your fingerprint.
        </p>

        {notice && (
          <p className="field-hint" role="status">
            {notice}
          </p>
        )}
        {failed && (
          <p className="form-error" role="alert">
            {failed}
          </p>
        )}
      </Card>

      {form === 'enable' && status && (
        <Modal
          title="How should the key be held?"
          subtitle="This is the part you can change later without rewriting the ledger"
          onClose={closeForm}
          wide
          footer={
            <>
              <Button variant="quiet" onClick={closeForm} disabled={busy} autoFocus>
                Cancel
              </Button>
              <Button variant="primary" onClick={() => void submitEnable()} disabled={busy}>
                Encrypt my ledger
              </Button>
            </>
          }
        >
          <Segmented
            label="Who can open the encrypted ledger"
            options={offered.map((entry) => ({ value: entry.value, label: entry.label }))}
            value={custody}
            onChange={setCustody}
          />
          <p className="field-hint">{custodyCopy(custody).headline}</p>
          <p className="field-hint">
            <strong>It protects against: </strong>
            {custodyCopy(custody).protects}
          </p>
          <p className="field-hint">
            <strong>It does not stop: </strong>
            {custodyCopy(custody).fails}
          </p>
          <p className="field-hint">
            <strong>If you lose it: </strong>
            {custodyCopy(custody).lockout}
          </p>
          {!status.deviceAvailable && (
            <p className="field-hint">
              &quot;This computer&quot; is not on offer: this system gives WageRoute no keychain to hold a
              key, so a passphrase is the only choice here.
            </p>
          )}
          {needsPhrase && (
            <>
              <PhraseFields
                visible={visible}
                onToggle={() => setVisible((now) => !now)}
                passphrase={passphrase}
                again={again}
                onPassphrase={setPassphrase}
                onAgain={setAgain}
                error={fieldError ?? undefined}
              />
              <p className="field-hint">
                WageRoute keeps the phrase nowhere: it is used once, to wrap the key, and then forgotten.
                There is no reset and nobody else holding a copy of it.
              </p>
            </>
          )}
        </Modal>
      )}

      {form === 'passphrase' && (
        <Modal
          title={status?.passphrase ? 'Change the passphrase' : 'Add a passphrase'}
          subtitle={
            status?.passphrase
              ? 'The phrase is the only thing that opens this ledger anywhere else'
              : 'Either way in keeps working after this: this computer, or the phrase'
          }
          onClose={closeForm}
          footer={
            <>
              <Button variant="quiet" onClick={closeForm} disabled={busy} autoFocus>
                Cancel
              </Button>
              <Button variant="primary" onClick={() => void submitPassphrase()} disabled={busy}>
                {status?.passphrase ? 'Change it' : 'Add it'}
              </Button>
            </>
          }
        >
          <p className="field-hint">{custodyCopy('passphrase').lockout}</p>
          {status?.passphrase && (
            <Field label="The passphrase it uses now">
              <input
                className="input"
                type={visible ? 'text' : 'password'}
                value={current}
                onChange={(event) => setCurrent(event.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            </Field>
          )}
          <PhraseFields
            visible={visible}
            onToggle={() => setVisible((now) => !now)}
            passphrase={passphrase}
            again={again}
            onPassphrase={setPassphrase}
            onAgain={setAgain}
            error={fieldError ?? undefined}
            label={status?.passphrase ? 'The new passphrase' : 'Passphrase'}
          />
          <p className="field-hint">
            Only the key changes here — 32 bytes re-wrapped, the ledger itself untouched. That is why this
            is instant and you can do it as often as you like.
          </p>
        </Modal>
      )}
    </>
  )
}

export type PhraseField = {
  visible: boolean
  onToggle: () => void
  passphrase: string
  again: string
  onPassphrase: (value: string) => void
  onAgain: (value: string) => void
  error?: string
  label?: string
}

/**
 * The two boxes, in one place, because an option and its weakness have to travel
 * together: the same rule that rejects a short phrase on this screen is the one
 * the main process applies to the file, and a second copy of the fields somewhere
 * else is how the two start to disagree.
 */
export function PhraseFields({
  visible,
  onToggle,
  passphrase,
  again,
  onPassphrase,
  onAgain,
  error,
  label = 'Passphrase'
}: PhraseField): ReactNode {
  const type = visible ? 'text' : 'password'
  return (
    <>
      <div className="unlock-row">
        <Field label={label} error={error}>
          <input
            className="input"
            type={type}
            value={passphrase}
            onChange={(event) => onPassphrase(event.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </Field>
        <Button size="sm" variant="ghost" aria-pressed={visible} onClick={onToggle}>
          {visible ? 'Hide' : 'Show'}
        </Button>
      </div>
      <Field label="Type it again">
        <input
          className="input"
          type={type}
          value={again}
          onChange={(event) => onAgain(event.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
      </Field>
    </>
  )
}

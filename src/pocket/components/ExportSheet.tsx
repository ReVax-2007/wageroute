import { useState } from 'react'
import { Download } from 'lucide-react'
import { passphraseProblem } from '@shared/encryption'
import { usePocket } from '../lib/store'
import { hasCipher, NO_CIPHER_HERE } from '../lib/webcrypto'
import { Field } from './Field'
import { Sheet } from './Sheet'

/** Hands the text to the browser's own save path: no server ever sees it. */
function download(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
  const link = document.createElement('a')
  link.href = url
  link.download = name
  document.body.append(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 4_000)
}

/**
 * The phone hands its copy back the same way the desktop does: a plain JSON
 * file, or one sealed under a passphrase the desktop can open with the same
 * phrase. The name and the header come from one moment, so the file the browser
 * saves cannot disagree with the file inside it.
 */
export function ExportSheet({ onClose }: { onClose: () => void }) {
  const exportJson = usePocket((state) => state.exportJson)
  const cipher = hasCipher()
  const [sealed, setSealed] = useState(false)
  const [passphrase, setPassphrase] = useState('')
  const [again, setAgain] = useState('')
  const [visible, setVisible] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [working, setWorking] = useState(false)

  const run = async (): Promise<void> => {
    if (sealed) {
      const problem = passphraseProblem(passphrase, 'this export')
      if (problem) {
        setError(problem)
        return
      }
      // The second box exists for one mistake: a phrase nobody can type again
      // correctly is only discovered when the file is needed.
      if (passphrase !== again) {
        setError('The two do not match. Type it once more in the second box.')
        return
      }
    }
    setWorking(true)
    try {
      const file = await exportJson(sealed ? passphrase : null)
      if (!file) return
      download(file.fileName, file.text)
      onClose()
    } catch (failure) {
      // A browser without WebCrypto cannot seal anything: say so instead of
      // closing on a file that was never written.
      setError(
        failure instanceof Error
          ? failure.message
          : 'This phone could not write the file. Try again or export from the computer.'
      )
    } finally {
      setWorking(false)
    }
  }

  return (
    <Sheet
      title="Export a backup"
      hint="A JSON file with every table this phone holds, including the entries only it has seen."
      onClose={() => (working ? undefined : onClose())}
    >
      <div className="segmented" role="group" aria-label="How readable should this file be">
        <button
          type="button"
          className={sealed ? 'segment' : 'segment active'}
          aria-pressed={!sealed}
          onClick={() => {
            setSealed(false)
            setError(null)
          }}
        >
          Plain JSON
        </button>
        <button
          type="button"
          className={sealed ? 'segment active' : 'segment'}
          aria-pressed={sealed}
          disabled={!cipher}
          onClick={() => {
            setSealed(true)
            setError(null)
          }}
        >
          Sealed with a passphrase
        </button>
      </div>
      {cipher ? (
        <p className="hint">
          {sealed
            ? 'The contents are sealed with AES-256-GCM under a key stretched from the passphrase, and the file says so in its name. WageRoute on the computer opens it with the same phrase. Anyone holding the file can keep testing guesses at their own speed offline, which is why the phrase has to be a phrase.'
            : 'Anyone who can read this file can read the whole ledger in any spreadsheet. That is the right answer for a copy that never leaves this phone, and the wrong one for anything else.'}
        </p>
      ) : (
        <p className="notice warn" role="status">
          {NO_CIPHER_HERE}
        </p>
      )}
      {sealed ? (
        <>
          <Field label="Passphrase">
            <input
              className="input"
              type={visible ? 'text' : 'password'}
              value={passphrase}
              onChange={(event) => {
                setPassphrase(event.target.value)
                setError(null)
              }}
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
          <Field label="Type it again">
            <input
              className="input"
              type={visible ? 'text' : 'password'}
              value={again}
              onChange={(event) => {
                setAgain(event.target.value)
                setError(null)
              }}
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
          <button type="button" className="button compact" onClick={() => setVisible((now) => !now)}>
            {visible ? 'Hide' : 'Show'}
          </button>
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
          <p className="hint">
            Nothing in WageRoute can recover this phrase: it is used once to seal the file and then
            forgotten, and it is not the passphrase that opens the ledger on your computer unless you
            type the same one.
          </p>
        </>
      ) : null}
      <div className="sheet-actions">
        <button type="button" className="button" disabled={working} onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="button primary" disabled={working} onClick={() => void run()}>
          {working ? (
            'Sealing…'
          ) : (
            <>
              <Download size={17} aria-hidden="true" /> Save to phone
            </>
          )}
        </button>
      </div>
    </Sheet>
  )
}

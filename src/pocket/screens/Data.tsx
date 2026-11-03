import { useState } from 'react'
import { Download, FolderInput, ShieldCheck, Smartphone, Trash2 } from 'lucide-react'
import { formatDateLabel, localDateISO, todayISO } from '@shared/dates'
import { phoneCopyWords } from '@shared/deletion'
import { PickBackup } from '../components/PickBackup'
import { Sheet } from '../components/Sheet'
import { isAppleTouch, useInstallPrompt } from '../lib/install'
import { usePocket, useSnapshot } from '../lib/store'

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

export function Data() {
  const snapshot = useSnapshot()
  const sourceName = usePocket((state) => state.sourceName)
  const importedAt = usePocket((state) => state.importedAt)
  const exportedAt = usePocket((state) => state.exportedAt)
  const version = usePocket((state) => state.version)
  const newerSchema = usePocket((state) => state.newerSchema)
  const localIds = usePocket((state) => state.localIds)
  const warnings = usePocket((state) => state.warnings)
  const exportJson = usePocket((state) => state.exportJson)
  const forget = usePocket((state) => state.forget)
  const { canInstall, installed, install } = useInstallPrompt()
  const [replacing, setReplacing] = useState(false)
  const [forgetting, setForgetting] = useState(false)

  if (!snapshot) return null

  // The copy on this phone is worth exactly the rows only it has ever seen.
  const forgetWords = phoneCopyWords(snapshot.transactionTotal, localIds.length)

  return (
    <div className="screen">
      <header className="screen-head">
        <div>
          <h1>Data</h1>
          <p className="muted small">Everything here lives on this phone.</p>
        </div>
      </header>

      <section className="card">
        <h2 className="card-title">Your ledger</h2>
        <dl className="facts">
          <div>
            <dt>File</dt>
            <dd>{sourceName || 'Imported backup'}</dd>
          </div>
          <div>
            <dt>Imported</dt>
            <dd>{importedAt ? formatDateLabel(localDateISO(importedAt)) : 'Unknown'}</dd>
          </div>
          <div>
            <dt>Backup from</dt>
            <dd>{exportedAt ? formatDateLabel(localDateISO(exportedAt)) : 'Unknown'}</dd>
          </div>
          <div>
            <dt>Entries</dt>
            <dd>
              {snapshot.transactionTotal.toLocaleString()}
              {localIds.length > 0 ? ` · ${localIds.length} added here` : ''}
            </dd>
          </div>
          <div>
            <dt>Schema</dt>
            <dd>{version}</dd>
          </div>
        </dl>
        {newerSchema ? (
          <p className="notice warn">
            This backup came from a newer WageRoute. Some details may be missing here, and this
            phone should not export it back until the desktop app is updated.
          </p>
        ) : null}
        {warnings.length > 0 ? (
          <div className="notice warn">
            <p>The last merge took what it could:</p>
            <ul className="checks">
              {warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </div>
        ) : null}
        <div className="card-actions">
          <button type="button" className="button" onClick={() => setReplacing(true)}>
            <FolderInput size={17} aria-hidden="true" /> Open a newer backup
          </button>
          <button
            type="button"
            className="button"
            onClick={() => {
              const json = exportJson()
              if (json) download(`wageroute-pocket-${todayISO()}.json`, json)
            }}
          >
            <Download size={17} aria-hidden="true" /> Export a backup
          </button>
        </div>
        <p className="hint">
          Opening a backup merges it: what is newer on either side wins, and nothing recorded here
          is thrown away. To bring this phone's entries to your computer, export and import the file
          there with the normal Import step.
        </p>
      </section>

      <section className="card">
        <h2 className="card-title">
          <Smartphone size={18} aria-hidden="true" /> Install on this phone
        </h2>
        {installed ? (
          <p className="hint">This is the installed app. It opens without a browser bar.</p>
        ) : canInstall ? (
          <button type="button" className="button primary" onClick={() => void install()}>
            Add WageRoute to this phone
          </button>
        ) : isAppleTouch() ? (
          <p className="hint">
            In Safari, tap Share, then <b>Add to Home Screen</b>. It opens like an app and works
            offline.
          </p>
        ) : (
          <p className="hint">
            Open your browser menu and choose <b>Install app</b> or <b>Add to Home screen</b>.
          </p>
        )}
      </section>

      <section className="card">
        <h2 className="card-title">
          <ShieldCheck size={18} aria-hidden="true" /> Privacy
        </h2>
        <ul className="checks">
          <li>No account and no sign-in.</li>
          <li>No sync service and no analytics.</li>
          <li>Your ledger is stored only in this browser's storage.</li>
          <li>The app never uploads the file it opens.</li>
        </ul>
      </section>

      <section className="card">
        <h2 className="card-title">Remove from this phone</h2>
        <p className="hint">
          This deletes the copy in this browser. Your computer keeps its own ledger; export first if
          you made entries here.
        </p>
        <button type="button" className="button danger" onClick={() => setForgetting(true)}>
          <Trash2 size={17} aria-hidden="true" /> Forget this phone
        </button>
      </section>

      <p className="fine">
        WageRoute Pocket {__POCKET_VERSION__} ·{' '}
        <a href="https://github.com/ReVax-2007/wageroute" rel="noreferrer" target="_blank">
          source code
        </a>
      </p>

      {replacing ? (
        <Sheet
          title="Open a newer backup?"
          hint="The file is merged into this phone's copy. A record that changed on your computer replaces the copy here; one that changed here stays, and a newer delete is applied."
          onClose={() => setReplacing(false)}
        >
          <p className="confirm-text">
            {localIds.length === 1
              ? '1 entry was added on this phone. It stays unless the file holds a newer version of it or a delete for it.'
              : localIds.length > 1
                ? `${localIds.length} entries were added on this phone. They stay unless the file holds a newer version or a delete for one of them.`
                : 'Nothing recorded here will be lost unless the file holds a newer version of it.'}
          </p>
          <div className="sheet-actions">
            <button type="button" className="button" onClick={() => setReplacing(false)}>
              Cancel
            </button>
            <PickBackup onDone={() => setReplacing(false)}>Choose a backup</PickBackup>
          </div>
        </Sheet>
      ) : null}

      {forgetting ? (
        <Sheet
          title={forgetWords.title}
          hint={forgetWords.body}
          onClose={() => setForgetting(false)}
        >
          <div className="sheet-actions">
            <button type="button" className="button" onClick={() => setForgetting(false)}>
              Keep it
            </button>
            <button
              type="button"
              className="button danger"
              onClick={() => {
                void forget()
                setForgetting(false)
              }}
            >
              {forgetWords.confirmLabel}
            </button>
          </div>
        </Sheet>
      ) : null}
    </div>
  )
}

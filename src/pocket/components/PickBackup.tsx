import { useRef, useState, type ReactNode } from 'react'
import { Upload } from 'lucide-react'
import { MAX_BACKUP_BYTES } from '../lib/backup'
import { usePocket } from '../lib/store'

interface PickBackupProps {
  children?: ReactNode
  className?: string
  /** Called after a file was accepted, so a confirming sheet can close. */
  onDone?: () => void
}

/**
 * Opens the phone's file picker, reads the backup as text, and hands it to the
 * store. A replace is asked about by the screen, not here: this button only
 * knows how to pick.
 */
export function PickBackup({ children, className = 'button primary', onDone }: PickBackupProps) {
  const importFile = usePocket((state) => state.importFile)
  const input = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)

  return (
    <>
      <input
        ref={input}
        type="file"
        accept=".json,application/json"
        hidden
        onChange={async (event) => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (!file) return
          setBusy(true)
          try {
            if (file.size > MAX_BACKUP_BYTES) {
              usePocket.setState({
                error: 'That file is too large to open on a phone.'
              })
              return
            }
            const before = usePocket.getState().tables
            await importFile(await file.text(), file.name)
            // A sealed file is a pass, not a refusal: the confirming sheet has to
            // step aside so the one asking for the passphrase is not behind it.
            const after = usePocket.getState()
            if (after.tables !== before || after.pendingSeal) onDone?.()
          } catch {
            usePocket.setState({ error: 'That file could not be read. Try another copy.' })
          } finally {
            setBusy(false)
          }
        }}
      />
      <button type="button" className={className} disabled={busy} onClick={() => input.current?.click()}>
        <Upload size={17} aria-hidden="true" />
        {busy ? 'Reading…' : (children ?? 'Choose a backup')}
      </button>
    </>
  )
}

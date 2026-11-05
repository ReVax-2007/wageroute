import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { UNLOCK_RETRY, UNLOCK_SUBMIT } from '@shared/channels'
import { logCrash, logNote } from './log'
import { watchDocumentLoad } from './window-load'
import { UNLOCK_QUERY, isTrustedPageUrl } from './window-security'

/**
 * The one window that exists before the ledger is open.
 *
 * It is separate from the main window on purpose. The main window is the ledger:
 * every IPC channel in the app reads or writes it, and they are all registered
 * once a database handle exists. A locked ledger must not have those channels in
 * reach, so the prompt is a window of its own, loading the same bundle with
 * `?mode=unlock`, and only two messages cross it: a passphrase in, a "that was
 * wrong" out.
 *
 * The passphrase is never echoed back, never stored, never logged. The retry
 * event carries no reason either, because the only reason at that point is that
 * the wrap did not open, and the window does not need to be told more.
 */

export interface PassphrasePrompt {
  /**
   * Wait for the next passphrase. `wrong` marks this as a retry. Resolves null
   * when the user closes the window instead of typing.
   */
  next(state: { wrong: boolean }): Promise<string | null>
  /** Removes the handler and closes the window. Safe to call twice. */
  close(): void
}

function packagedPage(): string {
  return pathToFileURL(join(__dirname, '../renderer/index.html')).href
}

function unlockPageUrl(): string {
  const dev = process.env.ELECTRON_RENDERER_URL
  const base = dev ? `${dev.replace(/\/$/, '')}/` : packagedPage()
  return `${base}?${UNLOCK_QUERY}`
}

function isUnlockFrame(event: IpcMainInvokeEvent): boolean {
  let url: string
  try {
    url = event.senderFrame?.url ?? ''
  } catch {
    return false
  }
  return isTrustedPageUrl(url, process.env.ELECTRON_RENDERER_URL, packagedPage())
}

export function openPassphrasePrompt(): PassphrasePrompt {
  let waiting: ((passphrase: string | null) => void) | null = null
  let settled = false

  const window = new BrowserWindow({
    width: 520,
    height: 440,
    minWidth: 420,
    minHeight: 340,
    show: false,
    title: 'WageRoute — locked',
    backgroundColor: '#0b0e14',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: false
    }
  })
  window.removeMenu()

  const fail = (): void => {
    settled = true
    const pending = waiting
    waiting = null
    pending?.(null)
  }
  window.on('closed', fail)

  /**
   * Stop the prompt for good: the ledger's open is waiting on this window, so
   * closing it is what makes that wait give up and say so out loud. Used when the
   * user closes it and when its own page never arrives.
   */
  const dispose = (): void => {
    ipcMain.removeHandler(UNLOCK_SUBMIT)
    fail()
    if (!window.isDestroyed()) window.close()
  }

  // Same posture as the main window: no child windows, no leaving this page.
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, url) => {
    if (!isTrustedPageUrl(url, process.env.ELECTRON_RENDERER_URL, packagedPage())) {
      event.preventDefault()
    }
  })

  ipcMain.handle(UNLOCK_SUBMIT, (event, typed: unknown) => {
    if (!isUnlockFrame(event)) return false
    if (settled || typeof typed !== 'string' || typed.length === 0) return false
    const pending = waiting
    waiting = null
    pending?.(typed)
    return true
  })

  // A watch can outlive its window — a prompt can be closed at any moment — so a
  // retry against a window that is gone does its best and says nothing.
  const load = (): void => {
    if (window.isDestroyed()) return
    void window.loadURL(unlockPageUrl())
  }
  // A prompt that never appears would leave the launch waiting for a passphrase
  // nobody can type. Retrying the load is the fix; giving up is the honest end,
  // because the wait then resolves as "no answer" and the launch says so.
  watchDocumentLoad(
    {
      onFinish: (listen) => window.webContents.once('did-finish-load', listen),
      onFail: (listen) =>
        window.webContents.on('did-fail-load', (_event, errorCode, description, _url, isMainFrame) =>
          listen({ kind: 'failed', mainFrame: isMainFrame, code: errorCode, description: `${description} (${errorCode})` })
        )
    },
    {
      reload: load,
      notice: (reason) => logNote('unlock-prompt-load', reason),
      report: (reason) => {
        logCrash('unlock-prompt-load', new Error(`The passphrase prompt never appeared: ${reason}`))
        dispose()
      }
    }
  )
  load()
  window.once('ready-to-show', () => window.show())

  return {
    async next(state) {
      if (settled) return null
      if (state.wrong) window.webContents.send(UNLOCK_RETRY)
      return new Promise<string | null>((resolve) => {
        waiting = resolve
      })
    },
    close: dispose
  }
}

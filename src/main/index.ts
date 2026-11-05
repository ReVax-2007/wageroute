import { app, BrowserWindow, dialog, Menu, session, shell } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { adoptLegacyDatabase, closeDatabase, databasePath, getDatabase } from './db/connection'
import { deviceCustodyAvailable, openWithDevice } from './db/device-custody'
import { DatabaseCorruptError } from './db/maintenance'
import { SchemaTooNewError } from './db/migrations'
import { postDueAutopay, recordDailySnapshots } from './db/repositories'
import type { Db } from './db/repo/common'
import { seedDemoIfEmpty, seedIfEmpty } from './db/seed'
import { KeyFileError, NoCustodyError } from './db/ledger-key'
import { DB_FILE } from './db/legacy'
import { LedgerLockedError, MissingKeyFileError, openLedgerKey, type LedgerOpening } from './db/unlock'
import { registerIpcHandlers } from './ipc'
import { installCrashLogging, logCrash, logNote } from './log'
import {
  DataLockedError,
  hasCustomDataDirectory,
  resolveDataDirectory,
  StorageUnavailableError
} from './storage'
import { openPassphrasePrompt, type PassphrasePrompt } from './unlock-prompt'
import { isAllowedExternalUrl, isTrustedPageUrl, permissionAllowed } from './window-security'
import { watchDocumentLoad } from './window-load'

app.setName('WageRoute')
installCrashLogging()

let mainWindow: BrowserWindow | null = null

/**
 * A packaged build ships no developer tools and no Electron default menu (which
 * carries reload, force-reload and toggle-devtools). The macOS edit menu is
 * rebuilt by hand so copy, paste and select-all keep their shortcuts.
 */
function installMenu(): void {
  if (!app.isPackaged) return
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null)
    return
  }
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: app.name,
        submenu: [
          { role: 'about' },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit' }
        ]
      },
      {
        label: 'Edit',
        submenu: [
          { role: 'undo' },
          { role: 'redo' },
          { type: 'separator' },
          { role: 'cut' },
          { role: 'copy' },
          { role: 'paste' },
          { role: 'selectAll' }
        ]
      },
      { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'zoom' }] }
    ])
  )
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 1060,
    minHeight: 700,
    show: false,
    backgroundColor: '#0b0e14',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 18, y: 20 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: !app.isPackaged
    }
  })
  const window = mainWindow

  window.on('ready-to-show', () => window.show())
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null
  })

  // A local finance tool has no business opening child windows or navigating away.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    const allowed = isTrustedPageUrl(
      url,
      process.env.ELECTRON_RENDERER_URL,
      pathToFileURL(join(__dirname, '../renderer/index.html')).href
    )
    if (!allowed) event.preventDefault()
  })

  // A watch can outlive its window, so a retry against a window that is already
  // gone does nothing instead of throwing from a destroyed object.
  const load = (): void => {
    if (window.isDestroyed()) return
    if (process.env.ELECTRON_RENDERER_URL) {
      void window.loadURL(process.env.ELECTRON_RENDERER_URL)
    } else {
      void window.loadFile(join(__dirname, '../renderer/index.html'))
    }
  }

  // The window is the app: a frame that never fills is a blank screen over a
  // ledger that may be perfectly open. Retry it, and if it still will not come,
  // say so instead of leaving the user staring at nothing.
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
      notice: (reason) => logNote('window-load', reason),
      report: (reason) => {
        logCrash('window-load', new Error(`WageRoute opened a window and its screen never arrived: ${reason}`))
        dialog.showErrorBox(
          'WageRoute could not show its screen',
          'The window opened, but its page did not arrive and reloading it did not bring it back.\n\n' +
            'Nothing in your ledger was changed. Quit WageRoute and open it again; if it stays blank, the ' +
            'log file in your WageRoute data folder says what the page did.'
        )
        app.quit()
      }
    }
  )
  load()
}

/**
 * Work that has to happen once per launch, before the first screen reads the
 * data. Each step is isolated: a failing autopay run must not stop the daily
 * balance record, and neither may stop the window from opening.
 */
function runBootTasks(db: Db, userId: string): void {
  try {
    postDueAutopay(db, userId)
  } catch (error) {
    logCrash('autopay', error)
  }
  try {
    recordDailySnapshots(db, userId)
  } catch (error) {
    logCrash('snapshots', error)
  }
}

/**
 * Everything that can stop the ledger from opening, and what the user is told
 * about each. Every branch leaves the files untouched and quits: a launch that
 * cannot open the real ledger must not quietly open a different one, or none.
 */
function explainOpenFailure(error: unknown): void {
  if (error instanceof StorageUnavailableError) {
    logCrash('storage-unavailable', error)
    dialog.showErrorBox(
      'Your data folder is not available',
      `${error.message}\n\nWageRoute did not open a different ledger, because that would ` +
        'fork your data. Reconnect the folder and open WageRoute again.'
    )
    app.quit()
    return
  }
  if (error instanceof DataLockedError) {
    logCrash('storage-locked', error)
    dialog.showErrorBox('This data folder is in use', error.message)
    app.quit()
    return
  }
  if (error instanceof SchemaTooNewError) {
    dialog.showErrorBox(
      'This database is from a newer WageRoute',
      `${error.message}\n\nThe file was left untouched. Install the newer version to open it.`
    )
    app.quit()
    return
  }
  if (error instanceof DatabaseCorruptError) {
    logCrash('database-corrupt', error)
    dialog.showErrorBox(
      'This ledger failed its integrity check',
      `${error.message}\n\nWageRoute did not open or change the file. Restore a backup, ` +
        'or open the newer copy in the backups folder if there is one.'
    )
    app.quit()
    return
  }
  if (error instanceof LedgerLockedError) {
    logCrash('ledger-locked', error)
    dialog.showErrorBox(
      'WageRoute stayed locked',
      `${error.message}\n\nThe ledger was not changed. Open WageRoute again when you have the ` +
        'passphrase, or restore a backup taken before the ledger was encrypted.'
    )
    app.quit()
    return
  }
  if (error instanceof NoCustodyError) {
    logCrash('ledger-no-custody', error)
    dialog.showErrorBox(
      'This ledger cannot be opened on this computer',
      `${error.message}\n\nThe key is still in the custody you chose, so nothing is lost: open ` +
        'WageRoute on the computer that holds it, or type the passphrase if you set one. ' +
        'Otherwise a backup exported before encryption is the only way back in.'
    )
    app.quit()
    return
  }
  if (error instanceof MissingKeyFileError) {
    logCrash('ledger-key-file-missing', error)
    dialog.showErrorBox(
      'This ledger has no key file beside it',
      `${error.message}\n\nWageRoute did not open or change either file. An encrypted ledger keeps ` +
        'its key in that small JSON next to it, not inside the database: if only the .db was moved ' +
        'or restored, move the whole folder, or put the key file back from a backup of it. If no ' +
        'copy of the key file survives, a plain (not sealed) export taken before it went missing ' +
        'is the only way to get this history back. If this ledger was never encrypted, the file ' +
        'is damaged rather than locked, and a backup is the way back.'
    )
    app.quit()
    return
  }
  if (error instanceof KeyFileError) {
    logCrash('key-file', error)
    dialog.showErrorBox(
      'The key file beside the ledger is unusable',
      `${error.message}\n\nWageRoute did not open or change the ledger. The key file is the small ` +
        'JSON next to it; if a backup of the data folder has an intact copy, put that back.'
    )
    app.quit()
    return
  }
  logCrash('database-open', error)
  throw error
}

/**
 * The prompt window, if the keychain could not do it on its own. Module state
 * because exactly one launch can be unlocking at a time, and the window must be
 * closed whether the key came back, was refused, or the launch fell over.
 */
let unlockPrompt: PassphrasePrompt | null = null

function askForPassphrase(state: { wrong: boolean }): Promise<string | null> {
  unlockPrompt ??= openPassphrasePrompt()
  return unlockPrompt.next(state)
}

function closeUnlockPrompt(): void {
  unlockPrompt?.close()
  unlockPrompt = null
}

/**
 * Opening the ledger, or telling the user out loud why it stayed shut.
 *
 * This is the gate. Nothing past it exists until the ledger opens: the IPC
 * handlers, and with them every channel that can read or write the data, are
 * registered from the handle returned here. A locked ledger is not a window with
 * an error in it — while it is locked there is no ledger window at all, only the
 * passphrase prompt, which speaks two messages and owns no channels.
 */
async function openLedgerForBoot(): Promise<Db | null> {
  let opening: LedgerOpening
  try {
    const dataDirectory = resolveDataDirectory(app.getPath('userData')).directory
    opening = await openLedgerKey(dataDirectory, join(dataDirectory, DB_FILE), {
      device: { available: deviceCustodyAvailable, open: openWithDevice },
      askForPassphrase
    })
  } catch (error) {
    closeUnlockPrompt()
    explainOpenFailure(error)
    return null
  }
  closeUnlockPrompt()

  if (opening.state === 'unrecoverable') {
    dialog.showErrorBox(
      'This ledger was left mid-change',
      `WageRoute was turning encryption ${opening.direction === 'encrypt' ? 'on' : 'off'} when it ` +
        `last stopped, and neither the ledger nor the safety copy taken first reads as a database.\n\n` +
        `The ledger is at ${databasePath()} and the copy is at ${opening.copy}. Neither was touched, ` +
        'and WageRoute will not guess between them. Restore a backup or ask for help with those two ' +
        'files side by side.'
    )
    app.quit()
    return null
  }
  if (opening.state === 'keyed' && opening.restored) {
    // Said out loud because it is the one thing the user must not learn later:
    // the ledger they are opening was rebuilt from a copy, and the wreck is on disk.
    logCrash(
      'ledger-restored',
      new Error(
        `The ledger was unreadable and has been put back from its safety copy. ` +
          `The unreadable file was kept at ${opening.wrecked ?? 'an unknown path'}.`
      )
    )
  }
  if (opening.state === 'keyed' && opening.via === 'passphrase') {
    // The count, never the phrase: three tries before a ledger opens is a
    // different conversation after the fact than one, and this is the only place
    // either of them is recorded. This is a note, not a crash — the boot worked.
    logNote('ledger-unlocked', `The ledger opened with a passphrase on try ${opening.attempts}.`)
  }
  try {
    return getDatabase(opening.state === 'keyed' ? opening.dataKey : null)
  } catch (error) {
    explainOpenFailure(error)
    return null
  }
}

async function boot(): Promise<void> {
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(permissionAllowed(permission))
  })
  // Synchronous queries (navigator.permissions.query) bypass the request
  // handler, so the check handler answers separately with the same allowlist.
  session.defaultSession.setPermissionCheckHandler((_contents, permission) =>
    permissionAllowed(permission)
  )

  if (process.platform === 'darwin' && !app.isPackaged) {
    const iconPath = join(__dirname, '../../build/icon.png')
    if (existsSync(iconPath)) app.dock?.setIcon(iconPath)
  }

  // Adoption only applies while the app still uses its own data folder; a user
  // who pointed WageRoute at an external ledger has already made that choice.
  if (!hasCustomDataDirectory(app.getPath('userData'))) {
    const adoption = adoptLegacyDatabase()
    if (adoption.error) {
      dialog.showErrorBox(
        'Could not move your old data',
        `${adoption.error}\n\nYour Cash Flow Routing data has been left exactly where it was. ` +
          'Nothing in WageRoute was changed. Fix the problem above and open WageRoute again.'
      )
      // Opening a fresh database here would make the next launch skip adoption
      // (the target exists) and strand the old ledger for good.
      app.quit()
      return
    }
  }
  const db = await openLedgerForBoot()
  if (!db) return
  const userId = app.isPackaged ? seedIfEmpty(db) : seedDemoIfEmpty(db)
  runBootTasks(db, userId)
  registerIpcHandlers(db)
  installMenu()

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
}

const hasLock = app.requestSingleInstanceLock()

if (!hasLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  app.whenReady().then(async () => {
    try {
      await boot()
    } catch (error) {
      // Without this the failure is an unhandled rejection and the window never
      // appears: the app is running, visible in the dock, and completely blank.
      logCrash('boot', error)
      dialog.showErrorBox(
        'WageRoute could not start',
        `${error instanceof Error ? error.message : String(error)}\n\n` +
          'The details are in the log file in your WageRoute data folder.'
      )
      app.quit()
    }
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', () => {
    closeDatabase()
  })
}

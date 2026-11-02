import { app, BrowserWindow, dialog, Menu, session, shell } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { adoptLegacyDatabase, closeDatabase, getDatabase } from './db/connection'
import { DatabaseCorruptError } from './db/maintenance'
import { SchemaTooNewError } from './db/migrations'
import { postDueAutopay, recordDailySnapshots } from './db/repositories'
import type { Db } from './db/repo/common'
import { seedDemoIfEmpty, seedIfEmpty } from './db/seed'
import { registerIpcHandlers } from './ipc'
import { installCrashLogging, logCrash } from './log'

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

  mainWindow.on('ready-to-show', () => mainWindow?.show())
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // A local finance tool has no business opening child windows or navigating away.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const devUrl = process.env.ELECTRON_RENDERER_URL
    const page = url.split('#')[0]
    const allowed = devUrl
      ? page.startsWith(devUrl)
      : page === pathToFileURL(join(__dirname, '../renderer/index.html')).href
    if (!allowed) event.preventDefault()
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
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

function boot(): void {
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false)
  })

  if (process.platform === 'darwin' && !app.isPackaged) {
    const iconPath = join(__dirname, '../../build/icon.png')
    if (existsSync(iconPath)) app.dock?.setIcon(iconPath)
  }

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
  const db = (() => {
    try {
      return getDatabase()
    } catch (error) {
      if (error instanceof SchemaTooNewError) {
        dialog.showErrorBox(
          'This database is from a newer WageRoute',
          `${error.message}\n\nThe file was left untouched. Install the newer version to open it.`
        )
        app.quit()
        return null
      }
      if (error instanceof DatabaseCorruptError) {
        logCrash('database-corrupt', error)
        dialog.showErrorBox(
          'This ledger failed its integrity check',
          `${error.message}\n\nWageRoute did not open or change the file. Restore a backup, ` +
            'or open the newer copy in the backups folder if there is one.'
        )
        app.quit()
        return null
      }
      logCrash('database-open', error)
      throw error
    }
  })()
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

  app.whenReady().then(() => {
    try {
      boot()
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

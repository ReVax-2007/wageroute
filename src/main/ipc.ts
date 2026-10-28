import { app, BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { emptyImportCounts } from '@shared/api'
import { parseEntriesCsv, transactionsToCsv } from '@shared/csv'
import { settingsToRecord } from '@shared/settings'
import type {
  AccountInput,
  AppSettings,
  BillInput,
  GoalInput,
  PaycheckDraftInput,
  TransactionInput,
  TransactionPatch
} from '@shared/types'
import { databasePath } from './db/connection'
import {
  backupToJson,
  buildBackup,
  mergeBackup,
  parseBackupJson
} from './db/backup'
import { mergeEntries } from './db/entries'
import * as repo from './db/repositories'

const MAX_IMPORT_BYTES = 64 * 1024 * 1024

function requireId(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error('Invalid id')
  return value
}

function ownerWindow(event: IpcMainInvokeEvent): BrowserWindow | null {
  return BrowserWindow.fromWebContents(event.sender)
}

function defaultFile(name: string): string {
  const stamp = new Date().toISOString().slice(0, 10)
  return join(app.getPath('documents'), name.replace('DATE', stamp))
}

export function registerIpcHandlers(db: Database.Database): void {
  const userId = repo.getLocalUserId(db)

  ipcMain.handle('snapshot:get', () => repo.getSnapshot(db, userId))
  ipcMain.handle('db:path', () => databasePath())

  ipcMain.handle('account:create', (_event, input: AccountInput) =>
    repo.createAccount(db, userId, input)
  )
  ipcMain.handle('account:update', (_event, id: unknown, patch: Partial<AccountInput>) =>
    repo.updateAccount(db, userId, requireId(id), patch)
  )
  ipcMain.handle('account:delete', (_event, id: unknown) =>
    repo.deleteAccount(db, userId, requireId(id))
  )

  ipcMain.handle('bill:create', (_event, input: BillInput) => repo.createBill(db, userId, input))
  ipcMain.handle('bill:update', (_event, id: unknown, patch: Partial<BillInput>) =>
    repo.updateBill(db, userId, requireId(id), patch)
  )
  ipcMain.handle('bill:delete', (_event, id: unknown) => repo.deleteBill(db, userId, requireId(id)))

  ipcMain.handle('goal:create', (_event, input: GoalInput) => repo.createGoal(db, userId, input))
  ipcMain.handle('goal:update', (_event, id: unknown, patch: Partial<GoalInput>) =>
    repo.updateGoal(db, userId, requireId(id), patch)
  )
  ipcMain.handle('goal:delete', (_event, id: unknown) => repo.deleteGoal(db, userId, requireId(id)))

  ipcMain.handle('transaction:create', (_event, input: TransactionInput) =>
    repo.createTransaction(db, userId, input)
  )
  ipcMain.handle('transaction:update', (_event, id: unknown, patch: TransactionPatch) =>
    repo.updateTransaction(db, userId, requireId(id), patch)
  )
  ipcMain.handle('transaction:delete', (_event, id: unknown) =>
    repo.deleteTransaction(db, userId, requireId(id))
  )

  ipcMain.handle('paycheck:commit', (_event, input: PaycheckDraftInput) =>
    repo.commitPaycheck(db, userId, input)
  )

  ipcMain.handle('settings:save', (_event, settings: AppSettings) =>
    repo.writeSettings(db, userId, settingsToRecord(settings))
  )

  ipcMain.handle('backup:export', async (event) => {
    const win = ownerWindow(event)
    const options = {
      title: 'Export a full backup',
      defaultPath: defaultFile('wageroute-backup-DATE.json'),
      filters: [{ name: 'JSON backup', extensions: ['json'] }]
    }
    const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return null

    const payload = buildBackup(db, userId)
    writeFileSync(result.filePath, backupToJson(payload), 'utf8')
    return result.filePath
  })

  ipcMain.handle('csv:export', async (event) => {
    const win = ownerWindow(event)
    const options = {
      title: 'Export transactions as CSV',
      defaultPath: defaultFile('wageroute-transactions-DATE.csv'),
      filters: [{ name: 'CSV', extensions: ['csv'] }]
    }
    const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return null

    const snapshot = repo.getSnapshot(db, userId)
    writeFileSync(
      result.filePath,
      transactionsToCsv(snapshot.transactions, snapshot.accounts, snapshot.user.currency),
      'utf8'
    )
    return result.filePath
  })

  ipcMain.handle('data:import', async (event) => {
    const win = ownerWindow(event)
    const options = {
      title: 'Import data',
      properties: ['openFile' as const],
      filters: [{ name: 'Backup or entries', extensions: ['json', 'csv'] }]
    }
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    if (result.canceled || result.filePaths.length === 0) return null

    const path = result.filePaths[0]
    const text = readFileSync(path, 'utf8')
    if (text.length > MAX_IMPORT_BYTES) throw new Error('That file is too large')

    if (/\.csv$/i.test(path)) {
      const parsed = parseEntriesCsv(text)
      if (parsed.entries.length === 0 && parsed.issues.length === 0) {
        throw new Error('That CSV has no entries')
      }
      const merged = mergeEntries(db, userId, parsed.entries)
      const added = emptyImportCounts()
      const skipped = emptyImportCounts()
      added.transactions = merged.added
      skipped.transactions = merged.skipped
      return {
        path,
        format: 'entries',
        exportedAt: '',
        added,
        skipped,
        issues: [...parsed.issues, ...merged.issues]
      }
    }

    const payload = parseBackupJson(text)
    const { added, skipped } = mergeBackup(db, userId, payload)
    return { path, format: 'backup', exportedAt: payload.exportedAt, added, skipped, issues: [] }
  })
}

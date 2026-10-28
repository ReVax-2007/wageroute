import { app, BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import type {
  ImportDroppedRow,
  ImportIssue,
  ImportPreview,
  ImportResult
} from '@shared/api'
import { emptyImportCounts } from '@shared/api'
import { parseEntriesCsv, transactionsToCsv, type CsvEntry } from '@shared/csv'
import { todayISO } from '@shared/dates'
import {
  applyImportAnswers,
  buildAccountMap,
  findImportProblems,
  findUnmappedAccounts,
  IMPORT_TABLES,
  withFileIds,
  type EntryMapping,
  type ImportAnswer,
  type ImportChoice,
  type ImportChoiceTable,
  type ImportContext,
  type ImportProblem,
  type ImportTable
} from '@shared/importRepair'
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
  parseBackupJson,
  type BackupPayload
} from './db/backup'
import { mergeEntries } from './db/entries'
import { seedIfEmpty } from './db/seed'
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

/**
 * A chosen file stays here between the wizard's preview and confirm steps so
 * the renderer only ever hands back a token, never a path it picked itself.
 */
interface PendingImport {
  path: string
  format: 'backup' | 'entries'
  exportedAt: string
  payload?: BackupPayload
  entries?: CsvEntry[]
  parseIssues?: ImportIssue[]
  mappings?: EntryMapping[]
}

const MAX_PENDING_IMPORTS = 8
const pendingImports = new Map<string, PendingImport>()

function holdImport(entry: PendingImport): string {
  const token = randomUUID()
  pendingImports.set(token, entry)
  while (pendingImports.size > MAX_PENDING_IMPORTS) {
    const oldest = pendingImports.keys().next().value
    if (oldest === undefined) break
    pendingImports.delete(oldest)
  }
  return token
}

function takeImport(token: string): PendingImport {
  const pending = pendingImports.get(token)
  if (!pending) throw new Error('That import has expired — pick the file again')
  pendingImports.delete(token)
  return pending
}

async function pickImportFile(win: BrowserWindow | null): Promise<string | null> {
  const options = {
    title: 'Import data',
    properties: ['openFile' as const],
    filters: [{ name: 'Backup or entries', extensions: ['json', 'csv'] }]
  }
  const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
  if (result.canceled || result.filePaths.length === 0) return null
  return result.filePaths[0]
}

function readImportText(path: string): string {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    throw new Error('That file could not be read')
  }
  if (text.length > MAX_IMPORT_BYTES) throw new Error('That file is too large')
  return text
}

/** Ids the database will accept for references: what is already local, plus what the file carries. */
function importContext(
  database: Database.Database,
  localUserId: string,
  payload: BackupPayload
): ImportContext {
  const choices = repo.listImportChoices(database, localUserId)
  const knownIds = {} as Record<ImportTable, Set<string>>
  for (const table of IMPORT_TABLES) knownIds[table] = new Set<string>()
  for (const table of Object.keys(choices) as ImportChoiceTable[]) {
    for (const choice of choices[table]) knownIds[table].add(choice.id)
  }
  return withFileIds({ knownIds, choices, today: todayISO() }, payload.tables)
}

function entryProblem(mapping: EntryMapping, choices: Record<ImportChoiceTable, ImportChoice[]>): ImportProblem {
  return {
    key: `e:${mapping.firstLine}`,
    scope: 'entry',
    table: 'transactions',
    rowIndex: 0,
    line: mapping.firstLine,
    field: {
      column: 'account_id',
      label: 'Account',
      input: 'ref',
      refTable: 'accounts'
    },
    rowLabel: `CSV “${mapping.displayName}” (${mapping.lines} ${mapping.lines === 1 ? 'line' : 'lines'})`,
    reason: `no local account is named “${mapping.displayName}”`,
    fixHint: `Create an account named “${mapping.displayName}” and import again, or point these lines at an existing account.`,
    suggested: choices.accounts[0]?.id ?? ''
  }
}

function entryDropped(mapping: EntryMapping): ImportDroppedRow {
  return {
    rowLabel: `CSV “${mapping.displayName}” (${mapping.lines} ${mapping.lines === 1 ? 'line' : 'lines'})`,
    reason: `no local account is named “${mapping.displayName}”`,
    fixHint: `Create an account named “${mapping.displayName}” and import again, or map the lines next time.`
  }
}

export function registerIpcHandlers(db: Database.Database): void {
  // Resolved per call: data:reset wipes the user row and re-seeds a fresh one,
  // so a value captured once here would go stale.
  const userId = (): string => repo.getLocalUserId(db)

  ipcMain.handle('snapshot:get', () => repo.getSnapshot(db, userId()))
  ipcMain.handle('db:path', () => databasePath())

  ipcMain.handle('account:create', (_event, input: AccountInput) =>
    repo.createAccount(db, userId(), input)
  )
  ipcMain.handle('account:update', (_event, id: unknown, patch: Partial<AccountInput>) =>
    repo.updateAccount(db, userId(), requireId(id), patch)
  )
  ipcMain.handle('account:delete', (_event, id: unknown) =>
    repo.deleteAccount(db, userId(), requireId(id))
  )

  ipcMain.handle('bill:create', (_event, input: BillInput) => repo.createBill(db, userId(), input))
  ipcMain.handle('bill:update', (_event, id: unknown, patch: Partial<BillInput>) =>
    repo.updateBill(db, userId(), requireId(id), patch)
  )
  ipcMain.handle('bill:delete', (_event, id: unknown) => repo.deleteBill(db, userId(), requireId(id)))

  ipcMain.handle('goal:create', (_event, input: GoalInput) => repo.createGoal(db, userId(), input))
  ipcMain.handle('goal:update', (_event, id: unknown, patch: Partial<GoalInput>) =>
    repo.updateGoal(db, userId(), requireId(id), patch)
  )
  ipcMain.handle('goal:delete', (_event, id: unknown) => repo.deleteGoal(db, userId(), requireId(id)))

  ipcMain.handle('transaction:create', (_event, input: TransactionInput) =>
    repo.createTransaction(db, userId(), input)
  )
  ipcMain.handle('transaction:update', (_event, id: unknown, patch: TransactionPatch) =>
    repo.updateTransaction(db, userId(), requireId(id), patch)
  )
  ipcMain.handle('transaction:delete', (_event, id: unknown) =>
    repo.deleteTransaction(db, userId(), requireId(id))
  )

  ipcMain.handle('paycheck:commit', (_event, input: PaycheckDraftInput) =>
    repo.commitPaycheck(db, userId(), input)
  )

  ipcMain.handle('settings:save', (_event, settings: AppSettings) =>
    repo.writeSettings(db, userId(), settingsToRecord(settings))
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

    const payload = buildBackup(db, userId())
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

    const snapshot = repo.getSnapshot(db, userId())
    writeFileSync(
      result.filePath,
      transactionsToCsv(snapshot.transactions, snapshot.accounts, snapshot.user.currency),
      'utf8'
    )
    return result.filePath
  })

  ipcMain.handle('data:preview', async (event) => {
    const path = await pickImportFile(ownerWindow(event))
    if (!path) return null
    const text = readImportText(path)

    if (/\.csv$/i.test(path)) {
      const parsed = parseEntriesCsv(text)
      if (parsed.entries.length === 0 && parsed.issues.length === 0) {
        throw new Error('That CSV has no entries')
      }
      const choices = repo.listImportChoices(db, userId())
      const knownNames = new Set(choices.accounts.map((choice) => choice.label.trim().toLocaleLowerCase()))
      const mappings = findUnmappedAccounts(parsed.entries, knownNames)
      const token = holdImport({
        path,
        format: 'entries',
        exportedAt: '',
        entries: parsed.entries,
        parseIssues: parsed.issues,
        mappings
      })
      const rows = emptyImportCounts()
      rows.transactions = parsed.entries.length
      return {
        token,
        path,
        format: 'entries',
        exportedAt: '',
        fileRows: rows,
        problems: mappings.map((mapping) => entryProblem(mapping, choices)),
        choices
      } satisfies ImportPreview
    }

    const payload = parseBackupJson(text)
    const context = importContext(db, userId(), payload)
    const token = holdImport({ path, format: 'backup', exportedAt: payload.exportedAt, payload })
    const rows = emptyImportCounts()
    for (const table of IMPORT_TABLES) rows[table] = payload.tables[table].length
    return {
      token,
      path,
      format: 'backup',
      exportedAt: payload.exportedAt,
      fileRows: rows,
      problems: findImportProblems(payload.tables, context),
      choices: context.choices
    } satisfies ImportPreview
  })

  ipcMain.handle('data:confirm', (_event, token: unknown, answers: unknown) => {
    const pending = takeImport(requireId(token))
    const list = Array.isArray(answers) ? (answers as ImportAnswer[]) : []
    const added = emptyImportCounts()
    const skipped = emptyImportCounts()

    if (pending.format === 'entries') {
      const mappings = pending.mappings ?? []
      const accountMap = buildAccountMap(mappings, list)
      const unmapped = mappings.filter((mapping) => !(mapping.accountName in accountMap))
      const merged = mergeEntries(db, userId(), pending.entries ?? [], {
        accountMap,
        reportedNames: new Set(unmapped.map((mapping) => mapping.accountName))
      })
      added.transactions = merged.added
      skipped.transactions = merged.skipped
      return {
        path: pending.path,
        format: 'entries',
        exportedAt: '',
        added,
        skipped,
        dropped: unmapped.map((mapping) => entryDropped(mapping)),
        issues: [...(pending.parseIssues ?? []), ...merged.issues]
      } satisfies ImportResult
    }

    const payload = pending.payload
    if (!payload) throw new Error('That import has expired — pick the file again')
    const context = importContext(db, userId(), payload)
    const repaired = applyImportAnswers(
      payload.tables,
      findImportProblems(payload.tables, context),
      list,
      context
    )
    const merged = mergeBackup(db, userId(), { ...payload, tables: repaired.tables })
    return {
      path: pending.path,
      format: 'backup',
      exportedAt: payload.exportedAt,
      added: merged.added,
      skipped: merged.skipped,
      dropped: repaired.dropped,
      issues: merged.issues
    } satisfies ImportResult
  })

  ipcMain.handle('data:reset', () => {
    repo.wipeAllData(db)
    seedIfEmpty(db)
  })
}

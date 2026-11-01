import { app, BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { randomUUID } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'
import { pathToFileURL } from 'node:url'
import type Database from 'better-sqlite3'
import type {
  ImportDroppedRow,
  ImportIssue,
  ImportPreview,
  ImportResult,
  WriteResult
} from '@shared/api'
import { emptyImportCounts } from '@shared/api'
import {
  CHANNELS,
  type Channel,
  type ChannelArgs,
  type ChannelResult
} from '@shared/channels'
import { parseEntriesCsv, transactionsToCsv, type CsvEntry } from '@shared/csv'
import { todayISO } from '@shared/dates'
import { encodeError, RepositoryError } from '@shared/errors'
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
import { parseSettings, settingsToRecord } from '@shared/settings'
import { describeCsvStatement, parseOfxStatement, type StatementInfo } from '@shared/statements'
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
import { SCHEMA_VERSION } from './db/migrations'
import { seedDemoIfEmpty, seedIfEmpty } from './db/seed'
import { writeFileAtomic } from './files'
import * as repo from './db/repositories'

const MAX_IMPORT_BYTES = 64 * 1024 * 1024

function requireId(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error('Invalid id')
  return value
}

/**
 * Only the app's own page may drive the ledger. Without this, any local HTML
 * file that reached the window would inherit `window.api` and could import,
 * reset or read the whole database.
 */
function isTrustedFrame(event: IpcMainInvokeEvent): boolean {
  const devUrl = process.env.ELECTRON_RENDERER_URL
  let url: string
  try {
    url = event.senderFrame?.url ?? ''
  } catch {
    return false
  }
  const page = url.split('#')[0]
  if (devUrl) return page.startsWith(devUrl)
  return page === pathToFileURL(join(__dirname, '../renderer/index.html')).href
}

/**
 * Registers a handler whose thrown errors keep their type across the process
 * boundary: a RepositoryError's code is encoded into the message so preload can
 * rebuild it, and anything else is rethrown untouched.
 *
 * The channel and its payload come from the shared contract, so the two halves
 * of the app cannot disagree about what is sent or returned.
 */
const registeredChannels = new Set<Channel>()

function handle<C extends Channel>(
  channel: C,
  listener: (
    event: IpcMainInvokeEvent,
    ...args: ChannelArgs<C>
  ) => ChannelResult<C> | Promise<ChannelResult<C>>
): void {
  registeredChannels.add(channel)
  ipcMain.handle(channel, async (event, ...args) => {
    if (!isTrustedFrame(event)) throw new Error('That window is not allowed to read this ledger')
    try {
      return await listener(event, ...(args as ChannelArgs<C>))
    } catch (error) {
      if (error instanceof Error) throw new Error(encodeError(error))
      throw error
    }
  })
}

/**
 * Runs a write and returns the tables it touched. The follow-up read happens in
 * the same main-process turn, so no other handler can slip between the write and
 * the patch; if that read still fails the write stands, and the result says so.
 */
function write<T>(
  db: Database.Database,
  userId: () => string,
  parts: readonly repo.SnapshotPart[],
  task: () => T
): WriteResult<T> {
  const value = task()
  try {
    return { value, patch: repo.readSnapshotParts(db, userId(), parts) }
  } catch (error) {
    return {
      value,
      patch: {},
      refreshError: error instanceof Error ? error.message : String(error)
    }
  }
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
  statement?: StatementInfo
  problems?: ImportProblem[]
}

// One wizard, one held file. Keeping older previews alive served no flow and
// let several parsed payloads sit in the main process at once.
const MAX_PENDING_IMPORTS = 1
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
    filters: [{ name: 'Backup, entries or statement', extensions: ['json', 'csv', 'ofx', 'qfx'] }]
  }
  const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
  if (result.canceled || result.filePaths.length === 0) return null
  return result.filePaths[0]
}

function readImportText(path: string): string {
  // Check the file on disk first: reading a FIFO or device node would block or
  // grow without bound before the size guard below ever ran.
  let size: number
  try {
    const stat = statSync(path)
    if (!stat.isFile()) throw new Error('That path is not a file')
    size = stat.size
  } catch {
    throw new Error('That file could not be read')
  }
  if (size > MAX_IMPORT_BYTES) throw new Error('That file is too large')

  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    throw new Error('That file could not be read')
  }
  // `text.length` counts UTF-16 units, so a file of multi-byte characters can
  // pass a guard the disk size already failed.
  if (Buffer.byteLength(text, 'utf8') > MAX_IMPORT_BYTES) throw new Error('That file is too large')
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

function statementRowLabel(mapping: EntryMapping): string {
  return `Statement “${mapping.displayName}” (${mapping.lines} ${mapping.lines === 1 ? 'line' : 'lines'})`
}

/**
 * A statement is one account's history, so every line shares a single answer.
 * Nothing is pre-selected: the account number in the file is not the local
 * account's name, and guessing from it would post money into the wrong place.
 */
function statementProblem(mapping: EntryMapping): ImportProblem {
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
    rowLabel: statementRowLabel(mapping),
    reason: 'a bank statement does not say which local account it belongs to',
    fixHint: 'Pick the account these lines belong to, or leave the statement out.',
    suggested: ''
  }
}

function statementDropped(mapping: EntryMapping): ImportDroppedRow {
  return {
    rowLabel: statementRowLabel(mapping),
    reason: 'you left the statement’s account unmapped',
    fixHint: 'Import the file again and choose the account these lines belong to.'
  }
}

function statementMapping(
  path: string,
  entries: readonly CsvEntry[],
  statement: StatementInfo
): EntryMapping {
  const label = statement.accountLabel
    ? `${statement.bank ? `${statement.bank} ` : ''}account ${statement.accountLabel}`
    : basename(path).replace(/\.[^.]+$/, '')
  return {
    // Blank on purpose: no row names an account, so the merge only resolves
    // these entries through the answer the wizard collects.
    accountName: '',
    displayName: label,
    firstLine: entries[0]?.line ?? 1,
    lines: entries.length
  }
}

export function registerIpcHandlers(db: Database.Database): void {
  registeredChannels.clear()
  // Resolved per call: data:reset wipes the user row and re-seeds a fresh one,
  // so a value captured once here would go stale.
  const userId = (): string => repo.getLocalUserId(db)

  handle('snapshot:get', () => repo.getSnapshot(db, userId()))
  handle('db:path', () => databasePath())
  handle('app:info', () => ({
    version: app.getVersion(),
    schemaVersion: SCHEMA_VERSION,
    electron: process.versions.electron
  }))

  handle('account:create', (_event, input: AccountInput) =>
    write(db, userId, ['accounts', 'goals'], () => repo.createAccount(db, userId(), input))
  )
  handle('account:update', (_event, id: unknown, patch: Partial<AccountInput>) =>
    write(db, userId, ['accounts', 'goals', 'transactions'], () =>
      repo.updateAccount(db, userId(), requireId(id), patch)
    )
  )
  handle('account:delete', (_event, id: unknown, options: unknown) =>
    write(
      db,
      userId,
      ['accounts', 'goals', 'bills', 'transactions', 'billReserves', 'settings'],
      () =>
        repo.deleteAccount(db, userId(), requireId(id), {
          withEntries:
            typeof options === 'object' &&
            options !== null &&
            (options as { withEntries?: unknown }).withEntries === true
        })
    )
  )
  handle('account:archive', (_event, id: unknown, archived: unknown) =>
    write(db, userId, ['accounts', 'goals', 'settings'], () =>
      repo.setAccountArchived(db, userId(), requireId(id), archived === true)
    )
  )
  handle(
    'account:entry-count',
    (_event, id: unknown) => repo.accountEntryCount(db, userId(), requireId(id))
  )

  handle('bill:create', (_event, input: BillInput) =>
    write(db, userId, ['bills'], () => repo.createBill(db, userId(), input))
  )
  handle('bill:update', (_event, id: unknown, patch: Partial<BillInput>) =>
    write(db, userId, ['bills'], () => repo.updateBill(db, userId(), requireId(id), patch))
  )
  handle('bill:delete', (_event, id: unknown) =>
    write(db, userId, ['bills', 'billReserves'], () =>
      repo.deleteBill(db, userId(), requireId(id))
    )
  )

  handle('goal:create', (_event, input: GoalInput) =>
    write(db, userId, ['goals', 'accounts'], () => repo.createGoal(db, userId(), input))
  )
  handle('goal:update', (_event, id: unknown, patch: Partial<GoalInput>) =>
    write(db, userId, ['goals', 'accounts'], () =>
      repo.updateGoal(db, userId(), requireId(id), patch)
    )
  )
  handle('goal:delete', (_event, id: unknown) =>
    write(db, userId, ['goals', 'accounts'], () => repo.deleteGoal(db, userId(), requireId(id)))
  )
  handle('goal:archive', (_event, id: unknown, archived: unknown) =>
    write(db, userId, ['goals'], () =>
      repo.setGoalArchived(db, userId(), requireId(id), archived === true)
    )
  )

  handle('transaction:create', (_event, input: TransactionInput) =>
    write(db, userId, ['transactions', 'accounts', 'goals', 'billReserves'], () =>
      repo.createTransaction(db, userId(), input)
    )
  )
  handle('transaction:update', (_event, id: unknown, patch: TransactionPatch) =>
    write(db, userId, ['transactions', 'accounts', 'goals', 'billReserves'], () =>
      repo.updateTransaction(db, userId(), requireId(id), patch)
    )
  )
  handle('transaction:delete', (_event, id: unknown) =>
    write(db, userId, ['transactions', 'accounts', 'goals', 'billReserves'], () =>
      repo.deleteTransaction(db, userId(), requireId(id))
    )
  )

  handle('paycheck:commit', (_event, input: PaycheckDraftInput) =>
    write(db, userId, ['paychecks', 'transactions', 'accounts', 'goals', 'billReserves'], () =>
      repo.commitPaycheck(db, userId(), input)
    )
  )

  handle('settings:save', (_event, settings: AppSettings) =>
    write(db, userId, ['settings'], () => {
      const record = settingsToRecord(settings)
      for (const [key, value] of Object.entries(record)) {
        if (typeof value !== 'string') {
          throw new RepositoryError('VALIDATION', `That settings save is missing "${key}"`, key)
        }
      }
      // Every field is normalised to what the build can read, except the currency:
      // an unknown code is refused by writeSettings rather than quietly swapped
      // for USD, which would change the ledger's units without saying so.
      const normalised = { ...settingsToRecord(parseSettings(record)), currency: record.currency }
      repo.writeSettings(db, userId(), normalised)
    })
  )

  handle('backup:export', async (event) => {
    const win = ownerWindow(event)
    const options = {
      title: 'Export a full backup',
      defaultPath: defaultFile('wageroute-backup-DATE.json'),
      filters: [{ name: 'JSON backup', extensions: ['json'] }]
    }
    const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return null

    const payload = buildBackup(db, userId())
    // A backup is the user's whole financial history in readable JSON; keep it
    // private to their account rather than inheriting the umask.
    writeFileAtomic(result.filePath, backupToJson(payload), 0o600)
    return result.filePath
  })

  handle('csv:export', async (event) => {
    const win = ownerWindow(event)
    const options = {
      title: 'Export transactions as CSV',
      defaultPath: defaultFile('wageroute-transactions-DATE.csv'),
      filters: [{ name: 'CSV', extensions: ['csv'] }]
    }
    const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return null

    // The grid is capped at 500 rows; an export that silently stopped there
    // would hand back a truncated ledger that looks complete.
    const transactions = repo.listAllTransactions(db, userId())
    const accounts = repo.listAccounts(db, userId())
    const { currency } = repo.getUser(db, userId())
    writeFileAtomic(result.filePath, transactionsToCsv(transactions, accounts, currency), 0o600)
    return result.filePath
  })

  handle('data:preview', async (event) => {
    const path = await pickImportFile(ownerWindow(event))
    if (!path) return null
    const text = readImportText(path)

    const entriesPreview = (
      entries: CsvEntry[],
      issues: ImportIssue[],
      statement?: StatementInfo
    ): ImportPreview => {
      if (entries.length === 0) {
        const detail = issues[0]?.message ? ` (${issues[0].message})` : ''
        throw new Error(
          statement
            ? `That statement has no usable transactions${detail}`
            : `That CSV has no usable entries${detail}`
        )
      }
      const choices = repo.listImportChoices(db, userId())
      const mappings = statement
        ? [statementMapping(path, entries, statement)]
        : findUnmappedAccounts(
            entries,
            new Set(choices.accounts.map((choice) => choice.label.trim().toLocaleLowerCase()))
          )
      const token = holdImport({
        path,
        format: 'entries',
        exportedAt: '',
        entries,
        parseIssues: issues,
        mappings,
        statement
      })
      const rows = emptyImportCounts()
      rows.transactions = entries.length
      return {
        token,
        path,
        format: 'entries',
        exportedAt: '',
        fileRows: rows,
        problems: mappings.map((mapping) =>
          statement ? statementProblem(mapping) : entryProblem(mapping, choices)
        ),
        choices,
        statement,
        issues
      } satisfies ImportPreview
    }

    if (/\.(ofx|qfx)$/i.test(path)) {
      const parsed = parseOfxStatement(text)
      return entriesPreview(parsed.entries, parsed.issues, parsed.statement)
    }

    if (/\.csv$/i.test(path)) {
      const parsed = parseEntriesCsv(text)
      // An Account column means the file describes accounts by name; without
      // one the file is a statement, and the wizard asks which account it is.
      const statement = parsed.hasAccountColumn ? undefined : describeCsvStatement(parsed.entries)
      return entriesPreview(parsed.entries, parsed.issues, statement)
    }

    const payload = parseBackupJson(text)
    const context = importContext(db, userId(), payload)
    // Keep the questions the user was shown. Confirm re-derives them against
    // the live ledger; anything new means the two screens disagree, and a row
    // must not be dropped just because the database changed in between.
    const problems = findImportProblems(payload.tables, context)
    const token = holdImport({
      path,
      format: 'backup',
      exportedAt: payload.exportedAt,
      payload,
      problems
    })
    const rows = emptyImportCounts()
    for (const table of IMPORT_TABLES) rows[table] = payload.tables[table].length
    return {
      token,
      path,
      format: 'backup',
      exportedAt: payload.exportedAt,
      fileRows: rows,
      problems,
      choices: context.choices
    } satisfies ImportPreview
  })

  handle('data:confirm', (_event, token: unknown, answers: unknown) => {
    const pending = takeImport(requireId(token))
    const list = Array.isArray(answers) ? (answers as ImportAnswer[]) : []
    const added = emptyImportCounts()
    const skipped = emptyImportCounts()

    if (pending.format === 'entries') {
      const mappings = pending.mappings ?? []
      const accountMap = buildAccountMap(mappings, list)
      const unmapped = mappings.filter((mapping) => !Object.hasOwn(accountMap, mapping.accountName))
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
        dropped: unmapped.map((mapping) =>
          pending.statement ? statementDropped(mapping) : entryDropped(mapping)
        ),
        issues: [...(pending.parseIssues ?? []), ...merged.issues]
      } satisfies ImportResult
    }

    const payload = pending.payload
    if (!payload) throw new Error('That import has expired — pick the file again')
    const context = importContext(db, userId(), payload)
    const problems = findImportProblems(payload.tables, context)
    const previewed = new Set((pending.problems ?? []).map((problem) => problem.key))
    if (problems.some((problem) => !previewed.has(problem.key))) {
      throw new Error(
        'The ledger changed since you previewed this file — open it again and review the new questions.'
      )
    }
    const repaired = applyImportAnswers(payload.tables, problems, list, context)
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

  handle('data:reset', () =>
    write(
      db,
      userId,
      ['user', 'settings', 'accounts', 'bills', 'goals', 'transactions', 'paychecks', 'billReserves'],
      () => {
        repo.wipeAllData(db)
        // A held import points at the ledger that just disappeared; keeping it
        // would let a stale wizard confirm into the next profile.
        pendingImports.clear()
        // Reset follows the same rule as boot: a development build comes back
        // with the demo profile, a packaged one comes back blank.
        if (app.isPackaged) seedIfEmpty(db)
        else seedDemoIfEmpty(db)
      }
    )
  )

  // A channel the renderer can call but nothing answers would fail only when a
  // user reaches that button; fail at boot instead.
  const missing = CHANNELS.filter((channel) => !registeredChannels.has(channel))
  if (missing.length > 0) {
    throw new Error(`No IPC handler registered for: ${missing.join(', ')}`)
  }
}

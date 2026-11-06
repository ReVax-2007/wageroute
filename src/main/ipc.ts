import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  type IpcMainInvokeEvent,
  type OpenDialogOptions
} from 'electron'
import { randomUUID } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { join, basename } from 'node:path'
import { pathToFileURL } from 'node:url'
import type Database from 'better-sqlite3-multiple-ciphers'
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
import { addDaysISO, isISODate, todayISO } from '@shared/dates'
import {
  passphraseProblem,
  type CustodyMethod,
  type EnableEncryptionRequest,
  type EncryptionStatus,
  type KeyCustodyChange
} from '@shared/encryption'
import { encodeError, RepositoryError } from '@shared/errors'
import { EnvelopeError, parseEnvelope, textIsEnvelope } from '@shared/envelope'
import {
  applyImportAnswers,
  buildAccountMap,
  findImportProblems,
  findUnmappedAccounts,
  IMPORT_TABLES,
  withFileIds,
  type EntryMapping,
  type ImportAnswer,
  type ImportChoiceTable,
  type ImportContext,
  type ImportProblem,
  type ImportTable
} from '@shared/importRepair'
import { parseQif } from '@shared/qif'
import { parseSettings, settingsToRecord } from '@shared/settings'
import {
  describeCsvStatement,
  parseOfxStatement,
  reconcileStatement,
  type StatementInfo,
  type StatementReconciliation
} from '@shared/statements'
import type {
  AccountInput,
  AppSettings,
  BillInput,
  CategoryInput,
  GoalInput,
  LedgerQuery,
  LedgerSort,
  PaycheckDraftInput,
  PlanMoveTarget,
  TransactionInput,
  TransactionKind,
  TransactionPatch,
  TransactionRowsPatch
} from '@shared/types'
import { backupsPath, closeDatabase, databasePath, ledgerDataKey, storageLocation } from './db/connection'
import {
  changeKeyCustody,
  disableEncryption,
  enableEncryption,
  readEncryptionStatus,
  type CustodyChange,
  type DeviceKeychain
} from './db/custody'
import { enrolPasskey } from './passkey-window'
import { deviceCustodyAvailable, openWithDevice, sealForDevice } from './db/device-custody'
import { DB_FILE } from './db/legacy'
import {
  backupFileAside,
  copyKeyFile,
  copyLedgerInto,
  copyLedgerToBackups,
  describeStorageCandidate,
  planStorageMove,
  writeStoragePointer
} from './storage'
import { backupBeforeErase } from './db/maintenance'
import { logCrash, logPath, recentLogTail } from './log'
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
import { exportFileOf, openEnvelopeFileText } from './envelope'
import { isTrustedPageUrl } from './window-security'
import * as repo from './db/repositories'

const MAX_IMPORT_BYTES = 64 * 1024 * 1024

/**
 * A storage switch is only complete when the process starts again in the new
 * folder: the database handle and every handler around it were bound to the old
 * one. The short delay lets the IPC reply leave before the app restarts.
 */
function relaunchSoon(): void {
  setTimeout(() => {
    app.relaunch()
    app.exit(0)
  }, 150)
}

function requireId(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error('Invalid id')
  return value
}

/**
 * The keychain, handed to the custody module rather than imported by it: the
 * ledger code stays free of Electron, and this is the one place that knows
 * `safeStorage` is what sits behind "this computer".
 */
const deviceKeychain: DeviceKeychain = {
  available: deviceCustodyAvailable,
  seal: sealForDevice,
  open: openWithDevice
}

function encryptionFolder(): { dataDirectory: string; ledgerFile: string } {
  return { dataDirectory: storageLocation().directory, ledgerFile: databasePath() }
}

function encryptionStatus(): EncryptionStatus {
  return readEncryptionStatus({
    ...encryptionFolder(),
    deviceAvailable: deviceCustodyAvailable(),
    // Windows Hello is reached by Chromium on its own. macOS would need
    // `app.configureWebAuthn` and an Apple Team ID, which the owner declined, and
    // Linux has no biometric keystore at all (ADR 0031). This only decides whether
    // the button is shown; the ceremony itself is the real test.
    passkeyOffered: process.platform === 'win32'
  })
}

const CUSTODY_METHODS: readonly CustodyMethod[] = ['device', 'passphrase', 'both']

/**
 * Checked on the wire before the ledger is opened at all, because the cheapest
 * way to fail a five-second page rewrite is to mistype the phrase that gates it.
 */
function enableRequestOf(raw: unknown): EnableEncryptionRequest {
  const source = (raw && typeof raw === 'object' ? raw : {}) as Partial<EnableEncryptionRequest>
  const custody = source.custody as CustodyMethod | undefined
  if (!custody || !CUSTODY_METHODS.includes(custody)) {
    throw new RepositoryError('VALIDATION', 'Choose how the key should be held.', 'custody')
  }
  const passphrase = typeof source.passphrase === 'string' ? source.passphrase : ''
  if (custody === 'passphrase' || custody === 'both') {
    const problem = passphraseProblem(passphrase)
    if (problem) throw new RepositoryError('VALIDATION', problem, 'passphrase')
  }
  return { custody, passphrase }
}

function custodyChangeOf(raw: unknown): KeyCustodyChange {
  const source = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const text = (value: unknown): string => (typeof value === 'string' ? value : '')
  const action = text(source.action)
  switch (action) {
    case 'add-device':
    case 'remove-device':
    case 'remove-passphrase':
    case 'remove-pin':
    case 'add-passkey':
    case 'remove-passkey':
      return { action }
    case 'add-passphrase':
      return { action, passphrase: text(source.passphrase) }
    case 'change-passphrase':
      return { action, current: text(source.current), next: text(source.next) }
    case 'add-pin':
      return { action, pin: text(source.pin) }
    case 'change-pin':
      return { action, current: text(source.current), next: text(source.next) }
    default:
      throw new RepositoryError('VALIDATION', 'That is not a way of holding the key.', 'action')
  }
}

/**
 * A transition that failed left the ledger exactly as it was — but this app's
 * handle was closed to attempt it, and every ledger handler is bound to that
 * handle, so the way back is the normal boot path. The reason has to be read
 * before the window goes, which is why this waits for the user.
 */
async function reportEncryptionFailure(
  window: BrowserWindow | null,
  title: string,
  detail: unknown
): Promise<void> {
  const options = {
    type: 'error' as const,
    title,
    message: detail instanceof Error ? detail.message : String(detail),
    detail: 'WageRoute will now restart and open the ledger as it stands on disk.',
    buttons: ['OK']
  }
  await (window ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options))
}

/** A signed whole number of cents; a float here would silently round an adjustment. */
function requireCents(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new RepositoryError('VALIDATION', 'Balance must be a whole number of cents')
  }
  return value
}

/** An ISO calendar date; the statement's own `DTASOF` is already read this way. */
function requireDate(value: unknown): string {
  if (typeof value !== 'string' || !isISODate(value)) {
    throw new RepositoryError('VALIDATION', 'Date must be in YYYY-MM-DD form')
  }
  return value
}

/** A `YYYY-MM` key; a looser value would silently read the wrong month's totals. */
function requireMonth(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) {
    throw new RepositoryError('VALIDATION', 'Month must be in YYYY-MM form')
  }
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
  return isTrustedPageUrl(
    url,
    devUrl,
    pathToFileURL(join(__dirname, '../renderer/index.html')).href
  )
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
 *
 * `rowsOf` is for ledger edits: instead of re-reading the capped 500-row window,
 * the handler names the rows the write changed and the grid merges those.
 */
function write<T>(
  db: Database.Database,
  userId: () => string,
  parts: readonly repo.SnapshotPart[],
  task: () => T,
  rowsOf?: (value: T) => TransactionRowsPatch
): WriteResult<T> {
  const value = task()
  try {
    const patch = repo.readSnapshotParts(db, userId(), parts)
    const rows = rowsOf?.(value)
    return rows ? { value, patch, rows: { transactions: rows } } : { value, patch }
  } catch (error) {
    return {
      value,
      patch: {},
      refreshError: error instanceof Error ? error.message : String(error)
    }
  }
}

function transactionRowsPatch(
  db: Database.Database,
  userId: string,
  id: string,
  remove: readonly string[] = []
): TransactionRowsPatch {
  return {
    upsert: repo.transactionRowsFor(db, userId, id),
    remove: [...remove],
    total: repo.transactionCount(db, userId),
    billPayments: repo.listBillPaymentsThisMonth(db, userId, todayISO().slice(0, 7)),
    billPaymentsHistory: repo.listBillPaymentsSince(
      db,
      userId,
      addDaysISO(todayISO(), -370)
    )
  }
}

function ownerWindow(event: IpcMainInvokeEvent): BrowserWindow | null {
  return BrowserWindow.fromWebContents(event.sender)
}

const LEDGER_SORT_VALUES: readonly LedgerSort[] = [
  'date_desc',
  'date_asc',
  'amount_desc',
  'amount_asc'
]

/**
 * Coerces the renderer's filter into the shape the repository reads. The
 * repository still validates dates and enums; this only guarantees the query
 * builder receives strings and finite numbers instead of whatever arrived.
 */
function ledgerQueryOf(raw: unknown): LedgerQuery {
  const source = (raw && typeof raw === 'object' ? raw : {}) as Partial<LedgerQuery>
  const filter = (source.filter && typeof source.filter === 'object'
    ? source.filter
    : {}) as LedgerQuery['filter']
  const text = (value: unknown): string | null =>
    typeof value === 'string' && value.trim() ? value.trim() : null
  const number = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) ? value : fallback

  return {
    filter: {
      text: text(filter.text) ?? undefined,
      from: text(filter.from),
      to: text(filter.to),
      accountId: text(filter.accountId),
      kind: (text(filter.kind) as TransactionKind | null) ?? null,
      categoryId: text(filter.categoryId)
    },
    sort: LEDGER_SORT_VALUES.includes(source.sort as LedgerSort)
      ? (source.sort as LedgerSort)
      : 'date_desc',
    limit: number(source.limit, 50),
    offset: number(source.offset, 0)
  }
}

function planMoveTargetsOf(raw: unknown): PlanMoveTarget[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return []
    const { allocationId, accountId } = entry as Partial<PlanMoveTarget>
    return typeof allocationId === 'string' && typeof accountId === 'string'
      ? [{ allocationId, accountId }]
      : []
  })
}

function defaultFile(name: string): string {
  // The filename names the owner's day, not the UTC day: an evening export in
  // New York used to be stamped with tomorrow's date.
  return join(app.getPath('documents'), name.replace('DATE', todayISO()))
}

/**
 * A chosen file stays here between the wizard's preview and confirm steps so
 * the renderer only ever hands back a token, never a path it picked itself.
 */
interface PendingImport {
  path: string
  format: 'backup' | 'entries'
  exportedAt: string
  /** A sealed file's text, held until a passphrase turns it into a payload. */
  sealed?: string
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

/**
 * Reads the held file without spending it. The token is retired only once the
 * import lands, so a confirm that throws leaves the wizard able to retry —
 * which is what its "safe to try again" copy promises.
 */
function peekImport(token: string): PendingImport {
  const pending = pendingImports.get(token)
  if (!pending) throw new Error('That import has expired — pick the file again')
  return pending
}

async function pickImportFile(win: BrowserWindow | null): Promise<string | null> {
  const options = {
    title: 'Import data',
    properties: ['openFile' as const],
    filters: [{ name: 'Backup, entries or statement', extensions: ['json', 'csv', 'ofx', 'qfx', 'qif'] }]
  }
  const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
  if (result.canceled || result.filePaths.length === 0) return null
  return result.filePaths[0]
}

/**
 * Read off the main thread: a 64 MiB file would otherwise freeze the window
 * (and every other IPC call) while the disk and UTF-8 decode catch up.
 */
async function readImportText(path: string): Promise<string> {
  // Check the file on disk first: reading a FIFO or device node would block or
  // grow without bound before the size guard below ever ran.
  let size: number
  try {
    const info = await stat(path)
    if (!info.isFile()) throw new Error('That path is not a file')
    size = info.size
  } catch {
    throw new Error('That file could not be read')
  }
  if (size > MAX_IMPORT_BYTES) throw new Error('That file is too large')

  let text: string
  try {
    text = await readFile(path, 'utf8')
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

/**
 * The preview for a backup's JSON text, whether it came from a plain file or
 * from an envelope that has just opened. It fills the entry the token already
 * holds, so the confirm step cannot tell the two readers apart.
 */
function backupPreviewOf(
  database: Database.Database,
  localUserId: string,
  path: string,
  text: string,
  token: string
): ImportPreview {
  const payload = parseBackupJson(text)
  const context = importContext(database, localUserId, payload)
  // Keep the questions the user was shown. Confirm re-derives them against the
  // live ledger; anything new means the two screens disagree, and a row must not
  // be dropped just because the database changed in between.
  const problems = findImportProblems(payload.tables, context)
  pendingImports.set(token, { path, format: 'backup', exportedAt: payload.exportedAt, payload, problems })
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
  }
}

function entryProblem(mapping: EntryMapping): ImportProblem {
  return {
    key: `e:${mapping.firstLine}`,
    scope: 'entry',
    table: 'transactions',
    rowIndex: 0,
    line: mapping.firstLine,
    lines: mapping.lines,
    field: {
      column: 'account_id',
      label: 'Account',
      input: 'ref',
      refTable: 'accounts'
    },
    rowLabel: `CSV “${mapping.displayName}” (${mapping.lines} ${mapping.lines === 1 ? 'line' : 'lines'})`,
    reason: `no local account is named “${mapping.displayName}”`,
    fixHint: `Create an account named “${mapping.displayName}” and import again, or point these lines at an existing account.`,
    // Nothing is pre-selected: a wrong guess would post the whole group into an
    // account the user never chose. An unanswered group is left out and listed.
    suggested: ''
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
    lines: mapping.lines,
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

  handle('app:diagnostics', () => {
    const file = databasePath()
    const counts = emptyImportCounts()
    for (const table of IMPORT_TABLES) {
      const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }
      counts[table] = row.n
    }
    let bytes = 0
    try {
      bytes = statSync(file).size
    } catch {
      // A missing file is itself the diagnosis; zero bytes says so.
    }
    return {
      generatedAt: new Date().toISOString(),
      version: app.getVersion(),
      schemaVersion: SCHEMA_VERSION,
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      packaged: app.isPackaged,
      databasePath: file,
      databaseBytes: bytes,
      encryption: encryptionStatus(),
      backupsPath: backupsPath(),
      logPath: logPath(),
      logTail: recentLogTail(),
      counts
    }
  })

  handle('app:legal', () => {
    // Packaged builds carry both files as resources; a checkout keeps them at
    // the repo root, two levels above out/main.
    const root = app.isPackaged ? process.resourcesPath : join(__dirname, '../..')
    const read = (name: string): string => {
      try {
        return readFileSync(join(root, name), 'utf8')
      } catch {
        return `(${name} is missing from this build)`
      }
    }
    return { license: read('LICENSE'), notices: read('THIRD-PARTY-NOTICES.txt') }
  })

  handle('storage:location', () => storageLocation())

  handle('storage:choose', async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    const options: OpenDialogOptions = {
      title: 'Choose where WageRoute keeps your data',
      buttonLabel: 'Inspect this folder',
      properties: ['openDirectory', 'createDirectory']
    }
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options)
    if (result.canceled || result.filePaths.length === 0) return null
    return describeStorageCandidate(result.filePaths[0])
  })

  handle('storage:apply', async (_event, directory: unknown, mode: unknown) => {
    if (typeof directory !== 'string' || directory.trim() === '') {
      throw new RepositoryError('VALIDATION', 'Pick a folder first.')
    }
    if (mode !== 'adopt' && mode !== 'move' && mode !== 'fresh') {
      throw new RepositoryError('VALIDATION', 'Choose whether to open, move or start fresh.')
    }
    const userData = app.getPath('userData')
    const plan = planStorageMove(userData, directory, mode)
    const from = storageLocation().directory
    if (plan.mode === 'move') {
      // Both copies are required: one in the old folder so a switch can be
      // undone, one in the new folder so it opens with the same ledger.
      await copyLedgerToBackups(db, from)
      await copyLedgerInto(db, plan.directory, ledgerDataKey())
      // A ledger and its key file are two halves of one thing; the new folder
      // needs both or it holds nothing but unreadable bytes. Only a move carries
      // a ledger, so only a move carries a key — `adopt` must not overwrite the
      // key file the folder it is taking over already has.
      copyKeyFile(from, plan.directory)
    }
    writeStoragePointer(userData, plan.directory)
    // The running handle still points at the old file. Stop touching it, then
    // reopen in the new folder through the normal boot path.
    closeDatabase()
    relaunchSoon()
    return { directory: plan.directory, restartRequired: true as const }
  })

  handle('storage:default', async () => {
    const userData = app.getPath('userData')
    if (storageLocation().isDefault) {
      throw new RepositoryError('VALIDATION', 'WageRoute already keeps its data on this computer.')
    }
    // Returning is a move too: the ledger now in use becomes the local one, and
    // the local file it replaces is kept aside first.
    const from = storageLocation().directory
    backupFileAside(join(userData, DB_FILE), userData, 'pre-return')
    await copyLedgerInto(db, userData, ledgerDataKey())
    copyKeyFile(from, userData)
    writeStoragePointer(userData, null)
    closeDatabase()
    relaunchSoon()
    return { directory: userData, restartRequired: true as const }
  })

  handle('encryption:status', () => encryptionStatus())

  handle('encryption:enable', async (event, request: unknown) => {
    const choice = enableRequestOf(request)
    const folder = encryptionFolder()
    // Closed first, because the transition is the only thing allowed to hold the
    // file: while this session keeps it open in WAL, a second connection cannot
    // change the journal mode the rekey needs, and a rekey that half-happens is
    // the failure this whole path is built to avoid.
    closeDatabase()
    try {
      const outcome = enableEncryption({ ...folder, ...choice, keychain: deviceKeychain })
      relaunchSoon()
      return { applied: true, rows: outcome.rows, restartRequired: true as const }
    } catch (error) {
      logCrash('encryption-enable', error)
      await reportEncryptionFailure(ownerWindow(event), 'Encryption did not turn on', error)
      relaunchSoon()
      return { applied: false, rows: 0, restartRequired: true as const }
    }
  })

  handle('encryption:disable', async (event) => {
    const folder = encryptionFolder()
    // Read before the close: the session key is dropped with the handle, and the
    // only way to turn encryption off is to be holding the key it went on with.
    const dataKey = ledgerDataKey()
    closeDatabase()
    try {
      const outcome = disableEncryption({ ...folder, dataKey })
      relaunchSoon()
      return { applied: true, rows: outcome.rows, restartRequired: true as const }
    } catch (error) {
      logCrash('encryption-disable', error)
      await reportEncryptionFailure(ownerWindow(event), 'Encryption did not turn off', error)
      relaunchSoon()
      return { applied: false, rows: 0, restartRequired: true as const }
    }
  })

  handle('encryption:custody', async (event, change: unknown) => {
    // No `closeDatabase`, no restart: re-wrapping the key touches 32 bytes in a
    // sidecar, not a page of the ledger, so the session carries on underneath it.
    const wire = custodyChangeOf(change)
    // A passkey is the one change whose secret is not typed: the ceremony runs
    // here, in its own window, and only its two PRF answers reach the custody code.
    const resolved: CustodyChange =
      wire.action === 'add-passkey' ? { action: 'add-passkey', enrolment: await enrolPasskey(ownerWindow(event)) } : wire
    changeKeyCustody({
      ...encryptionFolder(),
      dataKey: ledgerDataKey(),
      change: resolved,
      keychain: deviceKeychain
    })
    return encryptionStatus()
  })

  handle('user:set-name', (_event, name: unknown) =>
    write(db, userId, ['user'], () => {
      repo.setDisplayName(db, userId(), name)
    })
  )

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
      ['accounts', 'goals', 'bills', 'transactions', 'billReserves', 'paychecks', 'settings'],
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
  handle('account:count-deletion', (_event, id: unknown) =>
    repo.doomedAccountDeletionIds(db, userId(), requireId(id)).length
  )

  handle('bill:create', (_event, input: BillInput) =>
    write(db, userId, ['bills'], () => repo.createBill(db, userId(), input))
  )
  handle('bill:update', (_event, id: unknown, patch: Partial<BillInput>) =>
    write(db, userId, ['bills'], () => repo.updateBill(db, userId(), requireId(id), patch))
  )
  handle('bill:delete', (_event, id: unknown) =>
    // The bill's live payments lose their link, so the ledger has to be
    // re-read: otherwise the grid keeps naming a bill that no longer exists.
    write(db, userId, ['bills', 'billReserves', 'transactions'], () =>
      repo.deleteBill(db, userId(), requireId(id))
    )
  )
  handle('bill:payments', (_event, month: unknown) =>
    repo.listBillPaymentsThisMonth(db, userId(), requireMonth(month))
  )

  handle('bill:count-deletion', (_event, id: unknown) =>
    repo.billDeletionSummary(db, userId(), requireId(id))
  )

  handle('category:create', (_event, input: CategoryInput) =>
    write(db, userId, ['categories'], () => repo.createCategory(db, userId(), input))
  )
  handle('category:update', (_event, id: unknown, patch: Partial<CategoryInput>) =>
    write(db, userId, ['categories', 'transactions'], () =>
      repo.updateCategory(db, userId(), requireId(id), patch)
    )
  )
  handle('category:delete', (_event, id: unknown) =>
    write(db, userId, ['categories', 'transactions'], () =>
      repo.deleteCategory(db, userId(), requireId(id))
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
    write(
      db,
      userId,
      ['accounts', 'goals', 'billReserves', 'categories'],
      () => repo.createTransaction(db, userId(), input),
      (id) => transactionRowsPatch(db, userId(), id)
    )
  )
  handle('transaction:update', (_event, id: unknown, patch: TransactionPatch) => {
    const entryId = requireId(id)
    let sweepsBefore: string[] = []
    return write(
      db,
      userId,
      ['accounts', 'goals', 'billReserves', 'categories'],
      () => {
        sweepsBefore = repo.roundUpSweepIds(db, userId(), entryId)
        repo.updateTransaction(db, userId(), entryId, patch)
      },
      () => {
        const stillLive = new Set(repo.roundUpSweepIds(db, userId(), entryId))
        return transactionRowsPatch(
          db,
          userId(),
          entryId,
          sweepsBefore.filter((sweepId) => !stillLive.has(sweepId))
        )
      }
    )
  })
  handle('transaction:delete', (_event, id: unknown) =>
    write(db, userId, ['transactions', 'accounts', 'goals', 'billReserves'], () =>
      repo.deleteTransaction(db, userId(), requireId(id))
    )
  )
  handle('transaction:delete-many', (_event, ids: unknown) =>
    write(db, userId, ['transactions', 'accounts', 'goals', 'billReserves'], () =>
      repo.deleteTransactions(
        db,
        userId(),
        Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : []
      )
    )
  )
  // A confirmation has to name the rows that go, and only the database can see
  // the twin a transfer hides or the sweep legs a purchase owns.
  handle('transaction:count-deletion', (_event, ids: unknown) =>
    repo.doomedDeletionIds(
      db,
      userId(),
      Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : []
    ).length
  )
  handle('transaction:query', (_event, query: unknown) =>
    repo.queryTransactions(db, userId(), ledgerQueryOf(query))
  )

  handle('paycheck:commit', (_event, input: PaycheckDraftInput) =>
    write(
      db,
      userId,
      ['paychecks', 'transactions', 'accounts', 'goals', 'billReserves', 'categories'],
      () => repo.commitPaycheck(db, userId(), input)
    )
  )

  handle('paycheck:apply', (_event, id: unknown, targets: unknown) =>
    // The transfer rows resolve a "Transfer" category, which may be new.
    write(db, userId, ['transactions', 'accounts', 'paychecks', 'billReserves', 'categories'], () =>
      repo.applyPaycheckPlan(
        db,
        userId(),
        typeof id === 'string' ? id : '',
        planMoveTargetsOf(targets)
      )
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

  handle('backup:export', async (event, passphrase) => {
    // `null` is the plain backup the button has always written. A phrase here is
    // checked by the same rule the ledger's own custody uses, so the two cannot
    // disagree about what counts as a passphrase.
    const sealed = passphrase !== null
    if (sealed) {
      const problem = passphraseProblem(passphrase, 'this export')
      if (problem) throw new RepositoryError('VALIDATION', problem, 'passphrase')
    }

    // Built before the folder is chosen: the file's name carries the moment it
    // was written, and that has to be the same moment the contents say.
    const payload = buildBackup(db, userId())
    const file = exportFileOf(
      backupToJson(payload),
      payload.exportedAt,
      passphrase,
      app.getPath('documents')
    )
    const win = ownerWindow(event)
    const options = {
      title: 'Export a full backup',
      defaultPath: file.defaultPath,
      filters: [{ name: file.filterName, extensions: ['json'] }]
    }
    const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return null

    // A backup is the user's whole financial history, in readable JSON or under
    // one passphrase; either way it is private to their account, not world-readable.
    writeFileAtomic(result.filePath, file.text, 0o600)
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

  handle(
    'statement:reconcile',
    (_event, accountId: unknown, statementCents: unknown, balanceOn: unknown) =>
      write(db, userId, ['accounts', 'transactions', 'categories'], () =>
        // The repository owns the sign rules and the "already agrees" case, so
        // the handler only checks what arrived on the wire.
        repo.reconcileAccountOn(
          db,
          userId(),
          requireId(accountId),
          requireCents(statementCents),
          requireDate(balanceOn)
        )
      )
  )

  handle('data:preview', async (event) => {
    const path = await pickImportFile(ownerWindow(event))
    if (!path) return null
    const text = await readImportText(path)

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
          statement ? statementProblem(mapping) : entryProblem(mapping)
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

    if (/\.qif$/i.test(path)) {
      const parsed = parseQif(text)
      return entriesPreview(parsed.entries, parsed.issues, parsed.statement)
    }

    if (/\.csv$/i.test(path)) {
      const parsed = parseEntriesCsv(text)
      // An Account column means the file describes accounts by name; without
      // one the file is a statement, and the wizard asks which account it is.
      const statement = parsed.hasAccountColumn ? undefined : describeCsvStatement(parsed.entries)
      return entriesPreview(parsed.entries, parsed.issues, statement)
    }

    // A sealed file says so in its header, in the clear. The wizard gets that
    // answer instead of a preview, because nothing inside can be counted — or
    // trusted — until the phrase that opens it is typed.
    if (textIsEnvelope(text)) {
      const header = parseEnvelope(text)
      return {
        sealed: true as const,
        token: holdImport({ path, format: 'backup', exportedAt: header.exportedAt, sealed: text }),
        path,
        exportedAt: header.exportedAt
      }
    }

    return backupPreviewOf(db, userId(), path, text, holdImport({ path, format: 'backup', exportedAt: '' }))
  })

  handle('data:passphrase', (_event, token: unknown, passphrase: unknown) => {
    const id = requireId(token)
    const pending = peekImport(id)
    if (pending.sealed === undefined) {
      throw new RepositoryError('STATE', 'That file is not sealed, so there is nothing to unlock.')
    }
    const phrase = typeof passphrase === 'string' ? passphrase : ''
    let text: string
    try {
      text = openEnvelopeFileText(pending.sealed, phrase)
    } catch (error) {
      // A wrong phrase and a broken file need different answers from the screen:
      // one is typed again into the same box, the other means a different file.
      // The code carries that difference, so the wizard never matches prose.
      if (error instanceof EnvelopeError) {
        throw new RepositoryError(
          error.failure === 'passphrase' ? 'PASSPHRASE' : 'VALIDATION',
          error.message
        )
      }
      throw error
    }
    return backupPreviewOf(db, userId(), pending.path, text, id)
  })

  handle('data:confirm', (_event, token: unknown, answers: unknown) => {
    const id = requireId(token)
    const pending = peekImport(id)
    const finish = <T extends ImportResult>(result: T): T => {
      pendingImports.delete(id)
      return result
    }
    const list = Array.isArray(answers) ? (answers as ImportAnswer[]) : []
    const added = emptyImportCounts()
    const updated = emptyImportCounts()
    const removed = emptyImportCounts()
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
      // The statement's own lines are what should make the two figures agree,
      // so the comparison is made after the merge, against the real ledger.
      const statement = pending.statement
      const statementAccountId = Object.hasOwn(accountMap, '') ? accountMap[''] : undefined
      let reconciliation: StatementReconciliation | undefined
      if (
        statement?.balanceCents != null &&
        statement.balanceOn &&
        statementAccountId
      ) {
        const held = repo.accountBalanceOn(db, userId(), statementAccountId, statement.balanceOn)
        if (held) {
          reconciliation = reconcileStatement({
            accountId: statementAccountId,
            accountName: held.name,
            accountKind: held.kind,
            statementCents: statement.balanceCents,
            ledgerCents: held.balanceCents,
            balanceOn: statement.balanceOn
          })
        }
      }
      return finish({
        path: pending.path,
        format: 'entries',
        exportedAt: '',
        added,
        updated,
        removed,
        skipped,
        dropped: unmapped.map((mapping) =>
          pending.statement ? statementDropped(mapping) : entryDropped(mapping)
        ),
        issues: [...(pending.parseIssues ?? []), ...merged.issues],
        ...(reconciliation ? { reconciliation } : {})
      } satisfies ImportResult)
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
    return finish({
      path: pending.path,
      format: 'backup',
      exportedAt: payload.exportedAt,
      added: merged.added,
      updated: merged.updated,
      removed: merged.removed,
      skipped: merged.skipped,
      dropped: repaired.dropped,
      issues: merged.issues
    } satisfies ImportResult)
  })

  handle('data:reset', () =>
    write(
      db,
      userId,
      ['user', 'settings', 'accounts', 'categories', 'bills', 'goals', 'transactions', 'paychecks', 'billReserves', 'balanceSnapshots'],
      () => {
        // A disclosed last-resort copy, kept beside the pre-upgrade ones. The
        // erase itself is still immediate and complete.
        backupBeforeErase(db, backupsPath())
        repo.wipeAllData(db)
        // A held import points at the ledger that just disappeared; keeping it
        // would let a stale wizard confirm into the next profile.
        pendingImports.clear()
        // Reset follows the same rule as boot: a development build comes back
        // with the demo profile, a packaged one comes back blank.
        if (app.isPackaged) seedIfEmpty(db)
        else seedDemoIfEmpty(db)
        // The new profile has no history yet, so today is day one of the chart.
        repo.recordDailySnapshots(db, userId())
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

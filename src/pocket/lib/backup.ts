import { IMPORT_TABLES, type ImportTable, type ImportTables } from '@shared/importRepair'
import {
  ACCOUNT_KINDS,
  ALLOCATION_BUCKETS,
  BILL_RESERVE_STATES,
  CATEGORY_KINDS,
  FREQUENCIES,
  FUNDING_STRATEGIES,
  GOAL_FUNDING_PACES,
  PLAN_HEALTH,
  TRANSACTION_KINDS
} from './enums'

/**
 * The file the desktop writes. Pocket reads it, keeps it in IndexedDB, and
 * writes the same shape back so the desktop's merge can take the entries added
 * on the phone. Nothing here depends on SQLite: a backup is plain JSON.
 */
export interface PocketBackup {
  format: 'cash-flow-routing-backup'
  version: number
  exportedAt: string
  tables: ImportTables
}

/** The newest schema this build can name; newer files still open, with a note. */
export const KNOWN_BACKUP_VERSION = 12

export const MAX_BACKUP_BYTES = 24 * 1024 * 1024

const TABLE_ORDER: readonly ImportTable[] = IMPORT_TABLES

export class BackupFileError extends Error {
  readonly code = 'BACKUP_FILE'

  constructor(message: string) {
    super(message)
    this.name = 'BackupFileError'
  }
}

function fail(message: string): never {
  throw new BackupFileError(message)
}

export function emptyTables(): ImportTables {
  const tables = {} as ImportTables
  for (const table of TABLE_ORDER) tables[table] = []
  return tables
}

type FieldRule =
  | { column: string; label: string; kind: 'enum'; allowed: ReadonlySet<string> }
  | { column: string; label: string; kind: 'integer' }

function enumRule(column: string, label: string, allowed: ReadonlySet<string>): FieldRule {
  return { column, label, kind: 'enum', allowed }
}

function integerRule(column: string, label: string): FieldRule {
  return { column, label, kind: 'integer' }
}

/**
 * The fields the phone reads directly. A same-version file with an unknown
 * value must be refused rather than coerced: `kind: "brokerage"` silently read
 * as `checking` changes which money is spendable, and a fractional amount is
 * dollars pasted into a cents column.
 */
const RULES: Partial<Record<ImportTable, readonly FieldRule[]>> = {
  accounts: [
    enumRule('kind', 'account kind', ACCOUNT_KINDS),
    integerRule('starting_balance_cents', 'starting balance'),
    integerRule('credit_limit_cents', 'credit limit'),
    integerRule('floor_cents', 'floor'),
    integerRule('sort_order', 'sort order'),
    integerRule('apr_bps', 'APR'),
    integerRule('minimum_payment_cents', 'minimum payment'),
    integerRule('statement_day', 'statement day'),
    integerRule('payment_due_day', 'payment due day'),
    integerRule('last_statement_balance_cents', 'statement balance')
  ],
  transactions: [
    enumRule('kind', 'entry kind', TRANSACTION_KINDS),
    integerRule('amount_cents', 'amount')
  ],
  bills: [
    enumRule('frequency', 'frequency', FREQUENCIES),
    enumRule('funding_strategy', 'funding strategy', FUNDING_STRATEGIES),
    integerRule('amount_cents', 'amount'),
    integerRule('due_day', 'due day'),
    integerRule('funding_paycheck_index', 'paycheck index')
  ],
  goals: [
    enumRule('funding_pace', 'funding pace', GOAL_FUNDING_PACES),
    integerRule('target_cents', 'target'),
    integerRule('priority', 'priority')
  ],
  allocations: [
    enumRule('bucket', 'bucket', ALLOCATION_BUCKETS),
    integerRule('amount_cents', 'amount')
  ],
  paychecks: [
    enumRule('health', 'plan health', PLAN_HEALTH),
    integerRule('amount_cents', 'amount'),
    integerRule('priority_cents', 'priority amount'),
    integerRule('surplus_cents', 'surplus'),
    integerRule('leisure_cents', 'leisure')
  ],
  bill_reserves: [
    enumRule('state', 'state', BILL_RESERVE_STATES),
    enumRule('strategy', 'funding strategy', FUNDING_STRATEGIES),
    integerRule('amount_cents', 'amount'),
    integerRule('due_day', 'due day')
  ],
  categories: [
    enumRule('kind', 'category kind', CATEGORY_KINDS),
    integerRule('sort_order', 'sort order')
  ],
  balance_snapshots: [integerRule('balance_cents', 'balance')]
}

function isWholeNumber(value: unknown): boolean {
  if (typeof value === 'number') return Number.isSafeInteger(value)
  if (typeof value !== 'string') return false
  const trimmed = value.trim()
  return /^[+-]?\d+$/.test(trimmed) && Number.isSafeInteger(Number(trimmed))
}

function show(value: unknown): string {
  const text = typeof value === 'string' ? value : String(value)
  return text.length > 40 ? `${text.slice(0, 37)}…` : text
}

function article(label: string): string {
  return /^[aeiou]/i.test(label) ? 'an' : 'a'
}

function validateRows(
  table: ImportTable,
  rows: readonly Record<string, unknown>[],
  version: number
): void {
  const rules = RULES[table]
  if (!rules) return
  for (const row of rows) {
    for (const rule of rules) {
      const value = row[rule.column]
      if (value === null || value === undefined) continue
      if (rule.kind === 'enum') {
        // A newer schema may add a value this build cannot name; the file still
        // opens with its newer-schema warning instead of being refused.
        if (version > KNOWN_BACKUP_VERSION) continue
        if (typeof value !== 'string' || !rule.allowed.has(value)) {
          fail(`The ${table} list has an unknown ${rule.label} (${show(value)})`)
        }
        continue
      }
      if (!isWholeNumber(value)) {
        fail(`The ${table} list has ${article(rule.label)} ${rule.label} that is not a whole number`)
      }
    }
  }
}

export function parseBackup(text: string): PocketBackup {
  if (text.length > MAX_BACKUP_BYTES) {
    fail('That file is too large to open on a phone')
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    fail('That file is not valid JSON')
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('That file has no ledger in it')
  const candidate = raw as Partial<PocketBackup>
  if (candidate.format !== 'cash-flow-routing-backup') {
    fail('That is not a WageRoute backup')
  }
  if (typeof candidate.version !== 'number' || !Number.isInteger(candidate.version)) {
    fail('Backup has no version number')
  }
  if (candidate.version < 2) fail('Backups this old are not supported')
  const source = candidate.tables
  if (!source || typeof source !== 'object' || Array.isArray(source)) fail('Backup has no tables')

  const tables = emptyTables()
  for (const table of TABLE_ORDER) {
    const rows = (source as Partial<ImportTables>)[table]
    if (rows === undefined) continue
    if (!Array.isArray(rows)) fail(`The ${table} list is not a list`)
    if (rows.length > 200_000) fail(`The ${table} list is too large`)
    for (const row of rows) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) {
        fail(`The ${table} list has a row that is not a record`)
      }
    }
    validateRows(table, rows as Record<string, unknown>[], candidate.version)
    tables[table] = rows as Record<string, unknown>[]
  }

  if (tables.accounts.filter((row) => row.deleted_at == null).length === 0) {
    fail('That backup has no accounts, so there is nothing to show')
  }

  return {
    format: 'cash-flow-routing-backup',
    version: candidate.version,
    exportedAt: typeof candidate.exportedAt === 'string' ? candidate.exportedAt : '',
    tables
  }
}

export function backupToJson(backup: PocketBackup): string {
  return `${JSON.stringify(backup, null, 2)}\n`
}

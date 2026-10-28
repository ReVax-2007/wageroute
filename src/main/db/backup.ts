import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { ImportCounts, ImportIssue } from '@shared/api'
import { IMPORT_TABLES, type ImportTable, type ImportTables } from '@shared/importRepair'
import { SCHEMA_VERSION } from './migrations'

type Db = Database.Database
type SqlValue = string | number | null

export interface BackupPayload {
  format: 'cash-flow-routing-backup'
  version: number
  exportedAt: string
  tables: ImportTables
}

export type BackupTable = ImportTable

const TABLE_LABEL: Record<BackupTable, string> = {
  accounts: 'account',
  bills: 'bill',
  goals: 'goal',
  paychecks: 'paycheck',
  allocations: 'allocation',
  transactions: 'transaction',
  settings: 'setting'
}

/** Column allowlists keep imports parameterised; keys from the file are never interpolated. */
const TABLE_COLUMNS: Record<BackupTable, readonly string[]> = {
  accounts: [
    'id', 'user_id', 'name', 'kind', 'institution', 'starting_balance_cents',
    'credit_limit_cents', 'dedicated_goal_id', 'in_safe_to_spend',
    'is_archived', 'sort_order', 'created_at', 'updated_at',
    'deleted_at', 'revision'
  ],
  bills: [
    'id', 'user_id', 'name', 'amount_cents', 'frequency', 'due_day', 'category',
    'account_id', 'autopay', 'is_active', 'next_due_on', 'created_at', 'updated_at',
    'deleted_at', 'revision'
  ],
  goals: [
    'id', 'user_id', 'name', 'target_cents', 'target_date', 'priority', 'color',
    'account_id', 'is_emergency', 'is_archived', 'created_at', 'updated_at',
    'deleted_at', 'revision'
  ],
  paychecks: [
    'id', 'user_id', 'amount_cents', 'received_on', 'source', 'deposit_account_id',
    'priority_cents', 'surplus_cents', 'leisure_cents', 'health', 'created_at',
    'updated_at', 'deleted_at', 'revision'
  ],
  allocations: [
    'id', 'user_id', 'paycheck_id', 'bucket', 'goal_id', 'label', 'amount_cents',
    'created_at', 'updated_at', 'deleted_at', 'revision'
  ],
  transactions: [
    'id', 'user_id', 'account_id', 'kind', 'amount_cents', 'occurred_on', 'memo',
    'category', 'bill_id', 'goal_id', 'paycheck_id', 'counter_account_id',
    'transfer_group_id', 'created_at', 'updated_at', 'deleted_at', 'revision'
  ],
  settings: ['user_id', 'key', 'value', 'updated_at']
}

const TABLE_ORDER: readonly BackupTable[] = IMPORT_TABLES

/**
 * Columns the schema declares with a DEFAULT, keyed per table. The importer
 * lists every allowlisted column explicitly in its INSERT, so an omitted key
 * would insert NULL and trip the NOT NULL constraint — an explicit value is
 * needed to get the default behaviour. Mirrors the defaults in migrations.ts.
 */
const TABLE_DEFAULTS: Record<BackupTable, Record<string, SqlValue>> = {
  accounts: {
    starting_balance_cents: 0,
    is_archived: 0,
    sort_order: 0
  },
  bills: {
    category: 'Bills',
    autopay: 0,
    is_active: 1
  },
  goals: {
    priority: 100,
    color: '#34D399',
    is_archived: 0,
    is_emergency: 0
  },
  paychecks: {
    source: 'Paycheck',
    priority_cents: 0,
    surplus_cents: 0,
    leisure_cents: 0
  },
  allocations: {},
  transactions: {
    memo: '',
    category: 'Uncategorized'
  },
  settings: {}
}

export function buildBackup(db: Db, userId: string): BackupPayload {
  const tables = {} as BackupPayload['tables']
  for (const table of TABLE_ORDER) {
    tables[table] = db
      .prepare(`SELECT * FROM ${table} WHERE user_id = ?`)
      .all(userId) as Record<string, unknown>[]
  }
  return {
    format: 'cash-flow-routing-backup',
    version: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    tables
  }
}

export function backupToJson(payload: BackupPayload): string {
  return `${JSON.stringify(payload, null, 2)}\n`
}

function fail(message: string): never {
  throw new Error(message)
}

export function parseBackupJson(text: string): BackupPayload {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    fail('That file is not valid JSON')
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('Backup file has no data')
  const candidate = raw as Partial<BackupPayload>
  if (candidate.format !== 'cash-flow-routing-backup') {
    fail('That is not a WageRoute backup')
  }
  if (typeof candidate.version !== 'number' || !Number.isInteger(candidate.version)) {
    fail('Backup has no version number')
  }
  if (candidate.version > SCHEMA_VERSION) {
    fail(`This backup came from a newer version (schema ${candidate.version})`)
  }
  if (candidate.version < 2) fail('Backups older than schema 2 are not supported')
  const source = candidate.tables
  if (!source || typeof source !== 'object' || Array.isArray(source)) fail('Backup has no tables')

  // Partial files are allowed: a file holding only transactions (or only
  // settings) imports exactly that table and leaves the rest untouched.
  const tables = {} as BackupPayload['tables']
  for (const table of TABLE_ORDER) {
    const rows = (source as Partial<BackupPayload['tables']>)[table]
    if (rows === undefined) {
      tables[table] = []
      continue
    }
    if (!Array.isArray(rows)) fail(`The ${table} table is not a list`)
    if (rows.length > 200000) fail(`Backup ${table} table is too large`)
    for (const row of rows) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) {
        fail(`Backup has a malformed row in ${table}`)
      }
    }
    tables[table] = rows as Record<string, unknown>[]
  }

  return {
    format: 'cash-flow-routing-backup',
    version: candidate.version,
    exportedAt: typeof candidate.exportedAt === 'string' ? candidate.exportedAt : '',
    tables
  }
}

function toSqlValue(value: unknown, key: string): SqlValue {
  if (value === undefined) return null
  if (value === null) return null
  if (typeof value === 'string' || typeof value === 'number') return value
  if (typeof value === 'boolean') return value ? 1 : 0
  fail(`Backup has an unsupported value for ${key}`)
}

export interface MergeResult {
  added: ImportCounts
  skipped: ImportCounts
  /** Rows the database refused; every other row in the file still imports. */
  issues: ImportIssue[]
  /** Rows that arrived without an id and were given a fresh UUID. */
  generatedIds: number
}

function emptyCounts(): ImportCounts {
  return {
    accounts: 0,
    bills: 0,
    goals: 0,
    paychecks: 0,
    allocations: 0,
    transactions: 0,
    settings: 0
  }
}

function describeRow(table: BackupTable, row: Record<string, unknown>, index: number): string {
  for (const column of ['name', 'label', 'memo', 'key']) {
    const value = row[column]
    if (typeof value === 'string' && value.trim()) return `${TABLE_LABEL[table]} “${value.trim()}”`
  }
  return `${TABLE_LABEL[table]} row ${index + 1}`
}

function issueOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/^SqliteError: /, '')
}

/**
 * Adds whatever the local database is missing and leaves existing rows alone.
 * Account/paycheck UUIDs are preserved so cross-table links hold, and re-importing
 * the same backup is a no-op. A row the database refuses is reported, not fatal:
 * the wizard has already offered to fix or drop it.
 */
export function mergeBackup(db: Db, userId: string, payload: BackupPayload): MergeResult {
  const added = emptyCounts()
  const skipped = emptyCounts()
  const issues: ImportIssue[] = []
  let generatedIds = 0
  const now = new Date().toISOString()

  db.transaction(() => {
    for (const table of TABLE_ORDER) {
      if (table === 'settings') {
        const insert = db.prepare(
          `INSERT OR IGNORE INTO settings (user_id, key, value, updated_at)
           VALUES (?, ?, ?, ?)`
        )
        payload.tables.settings.forEach((row, index) => {
          if (typeof row.key !== 'string' || row.key.trim().length === 0) {
            issues.push({ table, message: `${describeRow(table, row, index)}: no setting key` })
            return
          }
          const updatedAt =
            typeof row.updated_at === 'string' ? row.updated_at : now
          try {
            const value = toSqlValue(row.value, 'value')
            const result = insert.run(userId, row.key, String(value ?? ''), updatedAt)
            if (result.changes > 0) added.settings += 1
            else skipped.settings += 1
          } catch (error) {
            issues.push({ table, message: `${describeRow(table, row, index)}: ${issueOf(error)}` })
          }
        })
        continue
      }

      const columns = TABLE_COLUMNS[table]
      const insert = db.prepare(
        `INSERT INTO ${table} (${columns.join(', ')})
         VALUES (${columns.map(() => '?').join(', ')})`
      )
      const exists = db.prepare(`SELECT 1 FROM ${table} WHERE id = ? AND user_id = ?`)
      payload.tables[table].forEach((row, index) => {
        const existingId = typeof row.id === 'string' && row.id.length > 0 ? row.id : ''
        const id = existingId || randomUUID()
        if (!existingId) generatedIds += 1
        else if (exists.get(id, userId)) {
          skipped[table] += 1
          return
        }
        const defaults = TABLE_DEFAULTS[table]
        try {
          const values = columns.map((column) => {
            if (column === 'user_id') return userId
            if (column === 'id') return id
            const value = row[column]
            // Hand-written entry files often omit sync metadata and position
            // columns; give every omitted key a sane value instead of NULL.
            if (value === undefined) {
              if (column === 'created_at' || column === 'updated_at') return now
              if (column === 'revision') return 1
              if (column in defaults) return defaults[column]
              return null
            }
            return toSqlValue(value, column)
          })
          insert.run(...values)
          added[table] += 1
        } catch (error) {
          issues.push({ table, message: `${describeRow(table, row, index)}: ${issueOf(error)}` })
        }
      })
    }
  })()

  return { added, skipped, issues, generatedIds }
}

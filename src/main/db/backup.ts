import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3-multiple-ciphers'
import type { ImportCounts, ImportIssue } from '@shared/api'
import { CATEGORY_NAME_MAX, categoryKey, normalizeCategoryName } from '@shared/categories'
import { IMPORT_TABLES, type ImportTable, type ImportTables } from '@shared/importRepair'
import { DEFAULT_SETTINGS, isCurrencyCode, parseSettings, settingsToRecord } from '@shared/settings'
import { incomingWins } from '@shared/tableMerge'
import { SCHEMA_VERSION } from './migrations'
import { reconcileAllBillReserves } from './repo/bills'

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
  balance_snapshots: 'balance snapshot',
  categories: 'category',
  bills: 'bill',
  goals: 'goal',
  paychecks: 'paycheck',
  allocations: 'allocation',
  bill_reserves: 'bill reserve',
  transactions: 'transaction',
  settings: 'setting'
}

/** Column allowlists keep imports parameterised; keys from the file are never interpolated. */
export const TABLE_COLUMNS: Record<BackupTable, readonly string[]> = {
  accounts: [
    'id', 'user_id', 'name', 'kind', 'institution', 'starting_balance_cents',
    'credit_limit_cents', 'apr_bps', 'minimum_payment_cents', 'statement_day',
    'payment_due_day', 'last_statement_balance_cents', 'color',
    'dedicated_goal_id', 'in_safe_to_spend',
    'is_archived', 'is_locked', 'sort_order', 'created_at', 'updated_at',
    'deleted_at', 'revision'
  ],
  balance_snapshots: [
    'id', 'user_id', 'account_id', 'on_date', 'balance_cents',
    'created_at', 'updated_at', 'deleted_at', 'revision'
  ],
  categories: [
    'id', 'user_id', 'name', 'kind', 'color', 'sort_order',
    'created_at', 'updated_at', 'deleted_at', 'revision'
  ],
  bills: [
    'id', 'user_id', 'name', 'amount_cents', 'frequency', 'due_day', 'category',
    'account_id', 'autopay', 'is_active', 'next_due_on', 'funding_strategy',
    'funding_paycheck_index', 'created_at', 'updated_at',
    'deleted_at', 'revision'
  ],
  goals: [
    'id', 'user_id', 'name', 'target_cents', 'target_date', 'priority', 'color',
    'account_id', 'is_emergency', 'is_archived', 'funding_pace', 'created_at', 'updated_at',
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
  bill_reserves: [
    'id', 'user_id', 'bill_id', 'paycheck_id', 'cycle', 'amount_cents', 'state',
    'strategy', 'due_day', 'settled_by', 'created_at', 'updated_at', 'deleted_at',
    'revision'
  ],
  transactions: [
    'id', 'user_id', 'account_id', 'kind', 'amount_cents', 'occurred_on', 'memo',
    'category', 'category_id', 'external_id', 'bill_id', 'goal_id', 'paycheck_id',
    'counter_account_id', 'transfer_group_id', 'split_group_id', 'round_up_source_id',
    'created_at', 'updated_at', 'deleted_at', 'revision'
  ],
  settings: ['user_id', 'key', 'value', 'updated_at']
}

const TABLE_ORDER: readonly BackupTable[] = IMPORT_TABLES

/**
 * Tables that only gain rows once a person has used the ledger. The seeded
 * settings and starter categories are configuration, not history, so they do
 * not make a profile "used" — otherwise the documented erase-then-restore path
 * could never adopt the file's preferences.
 */
const HISTORY_TABLES: readonly BackupTable[] = [
  'accounts',
  'balance_snapshots',
  'bills',
  'goals',
  'paychecks',
  'allocations',
  'bill_reserves',
  'transactions'
]

function hasLedgerHistory(db: Db, userId: string): boolean {
  for (const table of HISTORY_TABLES) {
    const row = db
      .prepare(`SELECT 1 FROM ${table} WHERE user_id = ? LIMIT 1`)
      .get(userId)
    if (row) return true
  }
  return false
}

/**
 * Columns the schema declares with a DEFAULT, keyed per table. The importer
 * lists every allowlisted column explicitly in its INSERT, so an omitted key
 * would insert NULL and trip the NOT NULL constraint — an explicit value is
 * needed to get the default behaviour. Mirrors the defaults in migrations.ts.
 */
export const TABLE_DEFAULTS: Record<BackupTable, Record<string, SqlValue>> = {
  accounts: {
    starting_balance_cents: 0,
    is_archived: 0,
    is_locked: 0,
    sort_order: 0
  },
  balance_snapshots: {},
  categories: {
    kind: 'expense',
    color: '#94A3B8',
    sort_order: 0
  },
  bills: {
    category: 'Bills',
    autopay: 0,
    is_active: 1,
    funding_strategy: 'all_checks'
  },
  goals: {
    priority: 100,
    color: '#34D399',
    is_archived: 0,
    is_emergency: 0,
    funding_pace: 'asap'
  },
  paychecks: {
    source: 'Paycheck',
    priority_cents: 0,
    surplus_cents: 0,
    leisure_cents: 0
  },
  allocations: {},
  bill_reserves: {
    state: 'reserved',
    // Only a file written before v9 lacks these; the merge fills them from the
    // bill's own strategy and due day instead of guessing a claim's history.
    strategy: 'all_checks',
    due_day: 1
  },
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
  // A row for a key no build reads (pre-rename, deleted features) would ride
  // along in every backup and come back on restore; the file carries only keys
  // this build understands.
  const knownKeys = new Set(Object.keys(settingsToRecord(parseSettings({}))))
  tables.settings = tables.settings.filter(
    (row) => typeof row.key === 'string' && knownKeys.has(row.key)
  )
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
  updated: ImportCounts
  removed: ImportCounts
  skipped: ImportCounts
  /** Rows the database refused; every other row in the file still imports. */
  issues: ImportIssue[]
  /** Rows that arrived without an id and were given a fresh UUID. */
  generatedIds: number
}

function emptyCounts(): ImportCounts {
  return {
    accounts: 0,
    balance_snapshots: 0,
    categories: 0,
    bills: 0,
    goals: 0,
    paychecks: 0,
    allocations: 0,
    bill_reserves: 0,
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
 * A file can carry a stamp from the future — a machine with a wrong clock, or a
 * hand-edited file. Keeping it would make every later local edit look older
 * than the imported row once a sync layer reads `updated_at`, which reverses
 * last-write-wins. A future stamp is therefore read as the file's own export
 * time (never later than this merge), which both devices read the same way; a
 * genuine past stamp is preserved because it is the file's own history.
 */
function clampStamp(value: unknown, ceiling: string): unknown {
  if (typeof value !== 'string') return value
  const at = Date.parse(value)
  return Number.isFinite(at) && at > Date.parse(ceiling) ? ceiling : value
}

function isTombstone(row: Record<string, unknown>): boolean {
  const value = row.deleted_at
  return value !== undefined && value !== null && value !== ''
}

/**
 * Adds what the ledger is missing, replaces rows the file holds a newer version
 * of, and applies a newer tombstone as a delete. The comparison is the shared
 * one the phone uses, so an export made on either device lands the same way:
 * `updated_at` decides, `revision` breaks a tie, and a row without a usable
 * stamp cannot overwrite one that has one. Account/paycheck UUIDs are preserved
 * so cross-table links hold, and re-importing the same backup is a no-op.
 */
export function mergeBackup(db: Db, userId: string, payload: BackupPayload): MergeResult {
  const added = emptyCounts()
  const updated = emptyCounts()
  const removed = emptyCounts()
  const skipped = emptyCounts()
  const issues: ImportIssue[] = []
  let generatedIds = 0
  const now = new Date().toISOString()
  const nowTime = Date.parse(now)
  // Rows are capped at when the file was written, not at this import. Both
  // devices read the same file the same way, so a wrong clock in the file
  // cannot make an untouched row outrank a genuine edit on the other device.
  const exportedTime = typeof payload.exportedAt === 'string' ? Date.parse(payload.exportedAt) : Number.NaN
  const ceiling =
    Number.isFinite(exportedTime) && exportedTime < nowTime ? payload.exportedAt : now
  const ceilingTime = Date.parse(ceiling)

  /**
   * A category is identified by its name, not by the UUID the other file
   * happened to mint. Inserting a same-name category as-is trips the unique
   * index (ASCII-cased names) or silently keeps a locale-cased twin, and the
   * restored transactions keep pointing at an id that was never written. The
   * live rows are indexed by {@link categoryKey} so a restore can reuse them.
   */
  const localCategories = new Map<string, { id: string; name: string }>()
  const remapCategory = new Map<string, { id: string; name: string }>()

  /**
   * A file written before v9 has no claim strategy. The bill's own strategy is
   * the best record of how that claim was written, and bills import first.
   */
  const billStrategies = new Map<string, unknown>()
  const billDueDays = new Map<string, unknown>()

  db.transaction(() => {
    const localRows = db
      .prepare('SELECT id, name FROM categories WHERE user_id = ? AND deleted_at IS NULL')
      .all(userId) as { id: string; name: string }[]
    for (const row of localRows) {
      localCategories.set(categoryKey(row.name), { id: row.id, name: row.name })
    }
    const localBills = db
      .prepare('SELECT id, funding_strategy AS strategy, due_day AS dueDay FROM bills WHERE user_id = ?')
      .all(userId) as { id: string; strategy: unknown; dueDay: unknown }[]
    for (const row of localBills) {
      billStrategies.set(row.id, row.strategy)
      billDueDays.set(row.id, row.dueDay)
    }
    const liveBillIds = new Set<string>(
      (
        db
          .prepare('SELECT id FROM bills WHERE user_id = ? AND deleted_at IS NULL')
          .all(userId) as { id: string }[]
      ).map((row) => row.id)
    )
    // A restore into a profile with no history (the erase-then-import path, or
    // a fresh install) adopts the file's settings; any other import keeps the
    // local value. Seeded defaults are not a choice the person made.
    const ledgerIsEmpty = !hasLedgerHistory(db, userId)

    for (const table of TABLE_ORDER) {
      if (table === 'settings') {
        const upsert = db.prepare(
          `INSERT INTO settings (user_id, key, value, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(user_id, key) DO UPDATE SET
             value = excluded.value, updated_at = excluded.updated_at`
        )
        const localValue = db.prepare(
          'SELECT value, updated_at FROM settings WHERE user_id = ? AND key = ?'
        )
        payload.tables.settings.forEach((row, index) => {
          if (typeof row.key !== 'string' || row.key.trim().length === 0) {
            issues.push({ table, message: `${describeRow(table, row, index)}: no setting key` })
            return
          }
          // An old backup carries keys this build deleted. Restoring them would
          // resurrect dead settings that no screen reads and every future
          // export would copy forward again.
          if (!Object.hasOwn(DEFAULT_SETTINGS, row.key)) {
            issues.push({
              table,
              message: `${describeRow(table, row, index)}: “${row.key}” is not a setting this build knows`
            })
            return
          }
          if (row.key === 'currency' && !isCurrencyCode(String(row.value ?? ''))) {
            issues.push({
              table,
              message: `${describeRow(table, row, index)}: “${String(row.value ?? '')}” is not a currency code this build knows`
            })
            return
          }
          const updatedAt =
            typeof row.updated_at === 'string'
              ? String(clampStamp(row.updated_at, ceiling))
              : ceiling
          try {
            const value = toSqlValue(row.value, 'value')
            const text = String(value ?? '')
            const current = localValue.get(userId, row.key) as
              | { value: string; updated_at: string | null }
              | undefined
            // The erase-then-restore path adopts the file's settings because
            // there is no local choice to keep. Anywhere else the newer value
            // wins, so a setting changed on either device travels with it.
            const take =
              ledgerIsEmpty ||
              current === undefined ||
              incomingWins({ updated_at: current.updated_at ?? undefined }, row, nowTime, ceilingTime)
            if (!take) {
              skipped.settings += 1
              return
            }
            if (ledgerIsEmpty) {
              // Seeded defaults are not a choice the person made, so an adopted
              // value reads as restored rather than as an edit on this device.
              upsert.run(userId, row.key, text, updatedAt)
              if (current?.value === text) skipped.settings += 1
              else added.settings += 1
            } else {
              upsert.run(userId, row.key, text, updatedAt)
              if (current) updated.settings += 1
              else added.settings += 1
            }
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
      const updateColumns = columns.slice(2)
      const update = db.prepare(
        `UPDATE ${table} SET ${updateColumns.map((column) => `${column} = ?`).join(', ')}
         WHERE id = ? AND user_id = ?`
      )
      const exists = db.prepare(`SELECT * FROM ${table} WHERE id = ? AND user_id = ?`)
      payload.tables[table].forEach((row, index) => {
        const existingId = typeof row.id === 'string' && row.id.length > 0 ? row.id : ''
        const id = existingId || randomUUID()
        const existing = existingId
          ? (exists.get(id, userId) as Record<string, unknown> | undefined)
          : undefined
        // A file holding an older copy of a row leaves the local edit alone.
        // This is what lets a phone and a computer both be edited offline: the
        // newer of the two wins instead of the later import.
        if (existing && !incomingWins(existing, row, nowTime, ceilingTime)) {
          skipped[table] += 1
          return
        }
        if (!existingId) generatedIds += 1
        let categoryName: string | null = null
        if (table === 'categories') {
          const stated = typeof row.name === 'string' ? normalizeCategoryName(row.name) : ''
          if (stated.length === 0) {
            issues.push({
              table,
              message: `${describeRow(table, row, index)}: no category name`
            })
            return
          }
          if (stated.length > CATEGORY_NAME_MAX) {
            issues.push({
              table,
              message: `${describeRow(table, row, index)}: the name is longer than ${CATEGORY_NAME_MAX} characters`
            })
            return
          }
          categoryName = stated
          const match = localCategories.get(categoryKey(categoryName))
          if (existing) {
            // A rename onto another live name would split reports across two
            // rows with one spelling, so the local name stays and the file is
            // told why. Deleting a category is not a rename and still applies.
            if (!isTombstone(row) && match && match.id !== id) {
              issues.push({
                table,
                message: `${describeRow(table, row, index)}: the name is already used by another category`
              })
              skipped.categories += 1
              return
            }
          } else if (match) {
            if (existingId) remapCategory.set(existingId, match)
            skipped.categories += 1
            return
          }
        }
        // An entry can identify its category by id (v8+) or only by spelling
        // (older files, and rows whose id did not travel). Both must land on the
        // live row, or the report splits one category across two spellings.
        const remappedCategory =
          table === 'transactions'
            ? (typeof row.category_id === 'string'
                ? remapCategory.get(row.category_id)
                : undefined) ??
              (typeof row.category === 'string'
                ? localCategories.get(categoryKey(row.category))
                : undefined)
            : undefined
        // A bill only carries its category's spelling, so a case or accent
        // difference would show two names for one category on two devices.
        const remappedBillCategory =
          table === 'bills' && typeof row.category === 'string'
            ? localCategories.get(categoryKey(row.category))?.name
            : undefined
        // A live claim needs a live bill. If the file's bill was skipped
        // because the local row is a tombstone (or the bill failed to import),
        // inserting the claim would leave reserved money under a bill no screen
        // can show and every later export would carry forward.
        if (
          table === 'bill_reserves' &&
          !isTombstone(row) &&
          !liveBillIds.has(String(row.bill_id ?? ''))
        ) {
          issues.push({
            table,
            message: `${describeRow(table, row, index)}: its bill was deleted or is not in this file`
          })
          return
        }
        const defaults = TABLE_DEFAULTS[table]
        try {
          const values = columns.map((column) => {
            if (column === 'user_id') return userId
            if (column === 'id') return id
            if (table === 'categories' && column === 'name' && categoryName !== null) {
              return categoryName
            }
            if (table === 'bill_reserves' && column === 'strategy') {
              const stated = row.strategy
              if (typeof stated === 'string' && stated.length > 0) return stated
              return billStrategies.get(String(row.bill_id ?? '')) ?? 'all_checks'
            }
            if (table === 'bill_reserves' && column === 'due_day') {
              const stated = row.due_day
              if (stated !== undefined) return toSqlValue(stated, column)
              return billDueDays.get(String(row.bill_id ?? '')) ?? 1
            }
            if (table === 'bill_reserves' && column === 'settled_by') {
              return row.settled_by === undefined ? null : toSqlValue(row.settled_by, column)
            }
            if (table === 'bill_reserves' && column === 'state') {
              const stated = row.state
              return stated === undefined || stated === null || stated === ''
                ? 'reserved'
                : toSqlValue(stated, column)
            }
            if (remappedCategory) {
              if (column === 'category_id') return remappedCategory.id
              if (column === 'category') return remappedCategory.name
            }
            if (column === 'category' && remappedBillCategory !== undefined) {
              return remappedBillCategory
            }
            // An update keeps the day the row was made. Only a new row uses the
            // file's stamp, so an edit on the phone does not rewrite history.
            if (column === 'created_at' && existing?.created_at != null) {
              return toSqlValue(existing.created_at, column)
            }
            const value = row[column]
            // Hand-written entry files often omit sync metadata and position
            // columns; give every omitted key a sane value instead of NULL.
            if (value === undefined) {
              if (column === 'created_at') return ceiling
              // A row with no edit stamp is as old as its creation, not as new
              // as this import: the import time would outrank an edit the other
              // device made before the file was written.
              if (column === 'updated_at') {
                return typeof row.created_at === 'string'
                  ? clampStamp(row.created_at, ceiling)
                  : ceiling
              }
              if (column === 'revision') return 1
              if (column in defaults) return defaults[column]
              return null
            }
            if (column === 'created_at' || column === 'updated_at' || column === 'deleted_at') {
              return toSqlValue(clampStamp(value, ceiling), column)
            }
            return toSqlValue(value, column)
          })
          if (existing) {
            update.run(...values.slice(2), id, userId)
            if (isTombstone(row) && !isTombstone(existing)) removed[table] += 1
            else updated[table] += 1
          } else {
            insert.run(...values)
            added[table] += 1
          }
          if (table === 'categories' && categoryName !== null) {
            const previous =
              typeof existing?.name === 'string'
                ? categoryKey(normalizeCategoryName(existing.name))
                : null
            if (previous) localCategories.delete(previous)
            if (!isTombstone(row)) {
              localCategories.set(categoryKey(categoryName), { id, name: categoryName })
            }
          }
          if (table === 'bills') {
            billStrategies.set(id, row.funding_strategy ?? 'all_checks')
            billDueDays.set(id, row.due_day ?? 1)
            if (isTombstone(row)) liveBillIds.delete(id)
            else liveBillIds.add(id)
          }
        } catch (error) {
          issues.push({ table, message: `${describeRow(table, row, index)}: ${issueOf(error)}` })
        }
      })
    }
    // A partial restore may have brought payments for a bill whose claims were
    // already in the ledger (or the other way round), so derive the claim states
    // from what the merged ledger now holds. Inside the same transaction: if a
    // derivation fails, the whole import rolls back instead of committing rows
    // whose claims were only half replayed.
    reconcileAllBillReserves(db, userId)
  })()

  return { added, updated, removed, skipped, issues, generatedIds }
}

import { IMPORT_TABLES, type ImportTable, type ImportTables } from '@shared/importRepair'

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
export const KNOWN_BACKUP_VERSION = 10

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

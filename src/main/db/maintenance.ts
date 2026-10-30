import type Database from 'better-sqlite3'
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

/**
 * A ledger that fails its own integrity check is not readable, and writing to it
 * makes the damage permanent. Fail closed at open, before any migration runs.
 */
export class DatabaseCorruptError extends Error {
  readonly code = 'DB_CORRUPT'
  constructor(readonly detail: string) {
    super(`The ledger file failed its integrity check: ${detail}`)
    this.name = 'DatabaseCorruptError'
  }
}

export function assertHealthy(db: Database.Database): void {
  let rows: { quick_check: string }[]
  try {
    rows = db.pragma('quick_check') as { quick_check: string }[]
  } catch (error) {
    // A file that is not SQLite at all throws instead of returning rows.
    throw new DatabaseCorruptError(error instanceof Error ? error.message : String(error))
  }
  const problems = rows.map((row) => row.quick_check).filter((value) => value !== 'ok')
  if (problems.length > 0) throw new DatabaseCorruptError(problems.slice(0, 3).join('; '))
}

function stamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
}

/** SQLite string literals cannot be parameterised in VACUUM INTO. */
function quote(path: string): string {
  return `'${path.replace(/'/g, "''")}'`
}

/**
 * A complete, consistent copy taken with VACUUM INTO *before* a migration
 * rewrites the file. Forward-only migrations have no undo, so this is the only
 * way back to the previous schema.
 */
export function backupBeforeUpgrade(
  db: Database.Database,
  directory: string,
  from: number,
  to: number,
  now = new Date()
): string {
  mkdirSync(directory, { recursive: true })
  const file = join(directory, `pre-upgrade-${from}-to-${to}-${stamp(now)}.db`)
  db.exec(`VACUUM INTO ${quote(file)}`)
  prune(directory, 3)
  return file
}

/** Deleted rows are only gone from the indexes until the file is rebuilt. */
export function compact(db: Database.Database): void {
  db.pragma('wal_checkpoint(TRUNCATE)')
  db.exec('VACUUM')
  db.pragma('wal_checkpoint(TRUNCATE)')
}

function prune(directory: string, keep: number): void {
  if (!existsSync(directory)) return
  const copies = readdirSync(directory)
    .filter((name) => name.startsWith('pre-upgrade-') && name.endsWith('.db'))
    .sort()
    .reverse()
  for (const name of copies.slice(keep)) {
    rmSync(join(directory, name), { force: true })
  }
}

import type Database from 'better-sqlite3-multiple-ciphers'
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
 * A fresh file (version 0) has nothing worth copying; a file already at the
 * current version is not rewritten. Everything in between is about to be
 * migrated in place and gets a copy first.
 */
export function needsPreUpgradeBackup(current: number, target: number): boolean {
  return current > 0 && current < target
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
  prune(directory, 'pre-upgrade-', 3)
  return file
}

/**
 * A last-resort copy taken immediately before an erase. Erase is deliberate and
 * the dialog says so, but a mis-click should not be the end of a ledger: the
 * copy is disclosed in the confirmation and pruned like the upgrade copies.
 */
export function backupBeforeErase(
  db: Database.Database,
  directory: string,
  now = new Date()
): string {
  mkdirSync(directory, { recursive: true })
  const file = join(directory, `pre-erase-${stamp(now)}.db`)
  db.exec(`VACUUM INTO ${quote(file)}`)
  prune(directory, 'pre-erase-', 3)
  return file
}

/** A local calendar day, so "once a day" matches the clock the user reads. */
function localDay(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * One copy a day is the difference between "this app has run for months" and
 * "the last week is recoverable". The name carries the local date, and an
 * existing copy for today is left alone so restarting five times does not write
 * five files. Returns the fresh path, or null when today already has a copy.
 */
export function backupDaily(
  db: Database.Database,
  directory: string,
  now = new Date(),
  keep = 7
): string | null {
  mkdirSync(directory, { recursive: true })
  const file = join(directory, `daily-${localDay(now)}.db`)
  if (existsSync(file)) return null
  db.exec(`VACUUM INTO ${quote(file)}`)
  prune(directory, 'daily-', keep)
  return file
}

/** Deleted rows are only gone from the indexes until the file is rebuilt. */
export function compact(db: Database.Database): void {
  db.pragma('wal_checkpoint(TRUNCATE)')
  db.exec('VACUUM')
  db.pragma('wal_checkpoint(TRUNCATE)')
}

function prune(directory: string, prefix: string, keep: number): void {
  if (!existsSync(directory)) return
  const copies = readdirSync(directory)
    .filter((name) => name.startsWith(prefix) && name.endsWith('.db'))
    .sort()
    .reverse()
  for (const name of copies.slice(keep)) {
    rmSync(join(directory, name), { force: true })
  }
}

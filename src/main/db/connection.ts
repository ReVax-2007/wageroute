import Database from 'better-sqlite3'
import { app } from 'electron'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DB_FILE, adoptLegacyDatabase as adoptLegacy, type AdoptionResult } from './legacy'
import { assertHealthy, backupBeforeUpgrade } from './maintenance'
import { migrate, SCHEMA_VERSION } from './migrations'

let instance: Database.Database | null = null

export function databasePath(): string {
  return join(app.getPath('userData'), DB_FILE)
}

/** Raising pre-migration copies live here; `maintenance.ts` keeps the newest three. */
export function backupsPath(): string {
  return join(app.getPath('userData'), 'backups')
}

export function adoptLegacyDatabase(): AdoptionResult {
  return adoptLegacy(app.getPath('appData'), app.getPath('userData'))
}

export function getDatabase(): Database.Database {
  if (instance) return instance

  const file = databasePath()
  mkdirSync(dirname(file), { recursive: true })

  const db = new Database(file)
  // The ledger is readable plaintext; it should at least not be readable by
  // every account on the machine. Best effort — a filesystem may refuse.
  try {
    chmodSync(file, 0o600)
  } catch {
    // No-op: the OS full-disk encryption note in SECURITY.md still applies.
  }
  // WAL keeps reads non-blocking while the UI writes; NORMAL is the right
  // durability tradeoff for a local file that is checkpointed on close.
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 5000')
  // A local ledger is read far more than it is written, and the whole dataset
  // fits in memory for years: keep a 16 MiB page cache, sort in RAM instead of
  // a temp file, and memory-map the file so reads skip the copy.
  db.pragma('cache_size = -16000')
  db.pragma('temp_store = MEMORY')
  db.pragma('mmap_size = 268435456')
  // A deleted row should not survive in a free page: this is a whole financial
  // history in one file, and "erase all data" has to mean it.
  db.pragma('secure_delete = ON')

  try {
    assertHealthy(db)
    // A migration rewrites the file and cannot be undone, so keep a consistent
    // copy of the schema it is about to replace. A fresh file (version 0) has
    // nothing worth copying.
    const current = db.pragma('user_version', { simple: true }) as number
    if (current > 0 && current < SCHEMA_VERSION) {
      backupBeforeUpgrade(db, backupsPath(), current, SCHEMA_VERSION)
    }
    migrate(db)
  } catch (error) {
    db.close()
    throw error
  }
  instance = db
  return db
}

export function closeDatabase(): void {
  instance?.close()
  instance = null
}

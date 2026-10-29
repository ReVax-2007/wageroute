import Database from 'better-sqlite3'
import { app } from 'electron'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DB_FILE, adoptLegacyDatabase as adoptLegacy, type AdoptionResult } from './legacy'
import { migrate } from './migrations'

let instance: Database.Database | null = null

export function databasePath(): string {
  return join(app.getPath('userData'), DB_FILE)
}

export function adoptLegacyDatabase(): AdoptionResult {
  return adoptLegacy(app.getPath('appData'), app.getPath('userData'))
}

export function getDatabase(): Database.Database {
  if (instance) return instance

  const file = databasePath()
  mkdirSync(dirname(file), { recursive: true })

  const db = new Database(file)
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

  try {
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

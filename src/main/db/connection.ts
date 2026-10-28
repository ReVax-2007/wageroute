import Database from 'better-sqlite3'
import { app } from 'electron'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DB_FILE, adoptLegacyDatabase as adoptLegacy } from './legacy'
import { migrate } from './migrations'

let instance: Database.Database | null = null

export function databasePath(): string {
  return join(app.getPath('userData'), DB_FILE)
}

export function adoptLegacyDatabase(): boolean {
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

  migrate(db)
  instance = db
  return db
}

export function closeDatabase(): void {
  instance?.close()
  instance = null
}

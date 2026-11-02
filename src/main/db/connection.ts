import Database from 'better-sqlite3'
import { app, dialog } from 'electron'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { StorageLocationInfo } from '@shared/api'
import { DB_FILE, adoptLegacyDatabase as adoptLegacy, type AdoptionResult } from './legacy'
import { assertHealthy, backupBeforeUpgrade, needsPreUpgradeBackup } from './maintenance'
import { migrate, SCHEMA_VERSION } from './migrations'
import {
  acquireDataLock,
  backupsDirectory,
  releaseDataLock,
  resolveDataDirectory
} from '../storage'

let instance: Database.Database | null = null

export function storageLocation(): StorageLocationInfo {
  const userData = app.getPath('userData')
  const location = resolveDataDirectory(userData)
  return {
    directory: location.directory,
    defaultDirectory: userData,
    backupsDirectory: backupsDirectory(location.directory),
    isDefault: location.isDefault
  }
}

export function databasePath(): string {
  return join(resolveDataDirectory(app.getPath('userData')).directory, DB_FILE)
}

/** Raising pre-migration copies live here; `maintenance.ts` keeps the newest three. */
export function backupsPath(): string {
  return backupsDirectory(resolveDataDirectory(app.getPath('userData')).directory)
}

export function adoptLegacyDatabase(): AdoptionResult {
  return adoptLegacy(app.getPath('appData'), app.getPath('userData'))
}

/**
 * Two machines cannot share a ledger at once. When the heartbeat finds the lock
 * replaced, another WageRoute has taken the folder over; the only safe move is
 * to stop writing and say so rather than overwrite that machine's entries.
 */
function handleLockLost(): void {
  try {
    instance?.close()
  } catch {
    // The file is being closed at the moment the OS says it is gone; nothing
    // else can be done with the handle.
  }
  instance = null
  dialog.showErrorBox(
    'This data folder is now in use elsewhere',
    'Another computer took over the WageRoute data folder after this one stopped updating ' +
      'its lock. WageRoute closed the database here so the two copies cannot overwrite each ' +
      'other. Reopen it when the other computer is finished.'
  )
  app.quit()
}

export function getDatabase(): Database.Database {
  if (instance) return instance

  const location = resolveDataDirectory(app.getPath('userData'))
  const file = join(location.directory, DB_FILE)
  mkdirSync(dirname(file), { recursive: true })
  acquireDataLock(location.directory, handleLockLost)

  try {
    const db = new Database(file)
    // The ledger is readable plaintext; it should at least not be readable by
    // every account on the machine. Best effort — a filesystem may refuse.
    try {
      chmodSync(file, 0o600)
    } catch {
      // No-op: the OS full-disk encryption note in SECURITY.md still applies.
    }
    if (location.isDefault) {
      // WAL keeps reads non-blocking while the UI writes; NORMAL is the right
      // durability tradeoff for a local file that is checkpointed on close.
      db.pragma('journal_mode = WAL')
      db.pragma('synchronous = NORMAL')
      // A local ledger is read far more than it is written, and the whole dataset
      // fits in memory for years: keep a 16 MiB page cache, sort in RAM instead of
      // a temp file, and memory-map the file so reads skip the copy.
      db.pragma('cache_size = -16000')
      db.pragma('temp_store = MEMORY')
      db.pragma('mmap_size = 268435456')
    } else {
      // A network share or a cloud-synced folder does not give SQLite the
      // shared-memory and locking guarantees WAL needs. Rollback journaling with
      // a full sync is slower but is the only mode that survives those
      // filesystems; no mmap, because a cached map can outlive the file.
      db.pragma('journal_mode = DELETE')
      db.pragma('synchronous = FULL')
      db.pragma('cache_size = -16000')
      db.pragma('temp_store = MEMORY')
      db.pragma('mmap_size = 0')
    }
    db.pragma('foreign_keys = ON')
    db.pragma('busy_timeout = 5000')
    // A deleted row should not survive in a free page: this is a whole financial
    // history in one file, and "erase all data" has to mean it.
    db.pragma('secure_delete = ON')

    try {
      assertHealthy(db)
      // A migration rewrites the file and cannot be undone, so keep a consistent
      // copy of the schema it is about to replace. A fresh file (version 0) has
      // nothing worth copying.
      const current = db.pragma('user_version', { simple: true }) as number
      if (needsPreUpgradeBackup(current, SCHEMA_VERSION)) {
        backupBeforeUpgrade(db, backupsPath(), current, SCHEMA_VERSION)
      }
      migrate(db)
    } catch (error) {
      db.close()
      throw error
    }
    instance = db
    return db
  } catch (error) {
    releaseDataLock()
    throw error
  }
}

export function closeDatabase(): void {
  try {
    instance?.close()
  } finally {
    instance = null
    releaseDataLock()
  }
}

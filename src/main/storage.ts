import {
  accessSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeSync
} from 'node:fs'
import { hostname } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { RepositoryError } from '@shared/errors'
import type { StorageCandidate, StorageMoveMode } from '@shared/api'
import { DB_FILE } from './db/legacy'
import { assertHealthy } from './db/maintenance'
import { SCHEMA_VERSION } from './db/migrations'
import { writeFileAtomic } from './files'

/**
 * The ledger can live in the default per-user folder or in one the user picks —
 * a NAS share, an external disk, a cloud-synced folder. That choice is recorded
 * outside the database in `storage.json`, because the app has to know where the
 * database is before it can open it.
 *
 * A shared folder has no real multi-user story: SQLite over SMB/NFS/cloud sync
 * is one writer at a time. `wageroute.lock` names the machine that is writing
 * and carries a heartbeat, so a second machine refuses to open the same ledger
 * instead of silently forking it. The lock is advisory and best effort; the
 * documentation says so.
 */

export const STORAGE_POINTER_FILE = 'storage.json'
export const DATA_LOCK_FILE = 'wageroute.lock'
export const BACKUPS_DIR = 'backups'
const LOCK_HEARTBEAT_MS = 30_000
const LOCK_STALE_MS = 3 * 60_000

export class StorageUnavailableError extends Error {
  readonly code = 'STORAGE_UNAVAILABLE'
  constructor(readonly directory: string, detail: string) {
    super(`${detail} (${directory})`)
    this.name = 'StorageUnavailableError'
  }
}

interface LockInfo {
  token: string
  pid: number
  hostname: string
  startedAt: string
}

export class DataLockedError extends Error {
  readonly code = 'DATA_LOCKED'
  constructor(readonly holder: LockInfo) {
    super(
      `This data folder is in use by another WageRoute on ${holder.hostname} ` +
        `(started ${holder.startedAt}). Close WageRoute there, or wait a few minutes if ` +
        'that computer is no longer running.'
    )
    this.name = 'DataLockedError'
  }
}

export function storagePointerPath(userDataDir: string): string {
  return join(userDataDir, STORAGE_POINTER_FILE)
}

export function backupsDirectory(dataDirectory: string): string {
  return join(dataDirectory, BACKUPS_DIR)
}

interface StoragePointer {
  dataDirectory: string
  updatedAt: string
}

function readPointerFile(path: string): StoragePointer {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    throw new StorageUnavailableError(
      path,
      'The file that records where your data lives could not be read. Fix it or delete it to ' +
        'fall back to this computer’s copy'
    )
  }
  const pointer = raw as Partial<StoragePointer>
  if (typeof pointer?.dataDirectory !== 'string' || !pointer.dataDirectory.trim()) {
    throw new StorageUnavailableError(
      path,
      'The file that records where your data lives has no folder in it. Fix it or delete it to ' +
        'fall back to this computer’s copy'
    )
  }
  return { dataDirectory: pointer.dataDirectory, updatedAt: pointer.updatedAt ?? '' }
}

/**
 * Where the ledger is. The default is the app's own user-data folder; anything
 * recorded in the pointer file is external. A pointer whose folder is missing is
 * an error, not a fallback: opening the local copy instead would fork the data
 * and the user would never see the other half.
 */
export function resolveDataDirectory(userDataDir: string): {
  directory: string
  isDefault: boolean
  pointerPath: string
} {
  const pointerPath = storagePointerPath(userDataDir)
  const fallback = resolve(userDataDir)
  if (!existsSync(pointerPath)) return { directory: fallback, isDefault: true, pointerPath }
  const pointer = readPointerFile(pointerPath)
  const directory = resolve(pointer.dataDirectory)
  if (!existsSync(directory) || !statSync(directory).isDirectory()) {
    throw new StorageUnavailableError(
      pointer.dataDirectory,
      'Your data folder is not available. Reconnect the drive, or delete this file to go back ' +
        'to the copy on this computer'
    )
  }
  return { directory, isDefault: directory === fallback, pointerPath }
}

export function hasCustomDataDirectory(userDataDir: string): boolean {
  return existsSync(storagePointerPath(userDataDir))
}

export function writeStoragePointer(userDataDir: string, dataDirectory: string | null): void {
  const path = storagePointerPath(userDataDir)
  if (dataDirectory === null || resolve(dataDirectory) === resolve(userDataDir)) {
    rmSync(path, { force: true })
    return
  }
  mkdirSync(userDataDir, { recursive: true })
  const pointer: StoragePointer = {
    dataDirectory: resolve(dataDirectory),
    updatedAt: new Date().toISOString()
  }
  writeFileAtomic(path, `${JSON.stringify(pointer, null, 2)}\n`, 0o600)
}

function lockPath(directory: string): string {
  return join(directory, DATA_LOCK_FILE)
}

function readLock(path: string): { info: LockInfo; mtimeMs: number } | null {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<LockInfo>
    if (
      typeof raw.token !== 'string' ||
      typeof raw.pid !== 'number' ||
      typeof raw.hostname !== 'string' ||
      typeof raw.startedAt !== 'string'
    ) {
      return null
    }
    return { info: raw as LockInfo, mtimeMs: statSync(path).mtimeMs }
  } catch {
    return null
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** A lock older than the stale window, or owned by a dead local process, is reusable. */
export function isLockActive(lock: { info: LockInfo; mtimeMs: number }, now = Date.now()): boolean {
  if (now - lock.mtimeMs > LOCK_STALE_MS) return false
  if (lock.info.hostname === hostname()) return pidAlive(lock.info.pid)
  return true
}

let activeLock: {
  directory: string
  path: string
  token: string
  timer: NodeJS.Timeout
} | null = null

/**
 * Takes the folder's writer lock. Called before SQLite opens the file, so a
 * second machine never gets as far as writing pages into a ledger in use.
 *
 * `onLost` fires when the heartbeat finds the lock replaced (another machine
 * took over after a stale window). The caller closes the database at that point;
 * continuing to write would silently overwrite the new owner's work.
 */
export function acquireDataLock(directory: string, onLost?: () => void): void {
  if (activeLock) {
    if (activeLock.directory === resolve(directory)) return
    releaseDataLock()
  }
  mkdirSync(directory, { recursive: true })
  const path = lockPath(directory)
  const existing = readLock(path)
  if (existing && isLockActive(existing)) throw new DataLockedError(existing.info)
  if (existing) rmSync(path, { force: true })

  const info: LockInfo = {
    token: `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    pid: process.pid,
    hostname: hostname(),
    startedAt: new Date().toISOString()
  }
  let fd: number
  try {
    fd = openSync(path, 'wx', 0o600)
  } catch (error) {
    // Another process won the race between the read and the create.
    const raced = readLock(path)
    if (raced) throw new DataLockedError(raced.info)
    throw error
  }
  try {
    writeSync(fd, `${JSON.stringify(info, null, 2)}\n`)
  } finally {
    closeSync(fd)
  }

  const timer = setInterval(() => {
    const current = readLock(path)
    if (!current || current.info.token !== info.token) {
      clearInterval(timer)
      if (activeLock?.token === info.token) {
        activeLock = null
        onLost?.()
      }
      return
    }
    try {
      const now = new Date()
      utimesSync(path, now, now)
    } catch {
      // A transient share outage must not end the session; the next tick retries.
    }
  }, LOCK_HEARTBEAT_MS)
  timer.unref()
  activeLock = { directory: resolve(directory), path, token: info.token, timer }
}

export function releaseDataLock(): void {
  if (!activeLock) return
  const lock = activeLock
  activeLock = null
  clearInterval(lock.timer)
  const current = readLock(lock.path)
  // Only remove the file if it is still ours: a lock taken over by another
  // machine must not be deleted on our way out.
  if (current?.info.token === lock.token) rmSync(lock.path, { force: true })
}

export function inspectLedger(directory: string): { hasLedger: boolean; schemaVersion: number | null } {
  const file = join(directory, DB_FILE)
  if (!existsSync(file)) return { hasLedger: false, schemaVersion: null }
  const db = new Database(file, { readonly: true })
  try {
    const version = db.pragma('user_version', { simple: true })
    return { hasLedger: true, schemaVersion: typeof version === 'number' ? version : null }
  } catch (error) {
    throw new RepositoryError(
      'VALIDATION',
      `${file} is there but cannot be read as a WageRoute ledger: ` +
        (error instanceof Error ? error.message : String(error))
    )
  } finally {
    db.close()
  }
}

function writable(directory: string): void {
  try {
    accessSync(directory, constants.W_OK | constants.X_OK)
  } catch {
    throw new RepositoryError('VALIDATION', `WageRoute cannot write to ${directory}.`)
  }
}

export interface StorageMovePlan {
  directory: string
  mode: StorageMoveMode
  inspection: { hasLedger: boolean; schemaVersion: number | null }
}

/**
 * Everything that can be checked before the app commits to a folder: it exists,
 * it is writable, nobody is writing it, and the chosen mode agrees with what is
 * already there. Copying and switching happen afterwards.
 */
export function planStorageMove(
  userDataDir: string,
  target: string,
  mode: StorageMoveMode,
  now = Date.now()
): StorageMovePlan {
  const directory = resolve(target)
  if (!existsSync(directory) || !statSync(directory).isDirectory()) {
    throw new RepositoryError('VALIDATION', `${directory} is not a folder.`)
  }
  writable(directory)

  const current = resolveDataDirectory(userDataDir).directory
  const same =
    directory === current ||
    (existsSync(current) && realpathSync(directory) === realpathSync(current))
  if (same) throw new RepositoryError('VALIDATION', 'WageRoute is already using that folder.')

  const lock = readLock(lockPath(directory))
  if (lock && isLockActive(lock, now)) throw new DataLockedError(lock.info)

  const inspection = inspectLedger(directory)
  if (mode === 'adopt') {
    if (!inspection.hasLedger) {
      throw new RepositoryError('VALIDATION', 'That folder does not contain a WageRoute ledger.')
    }
    if (inspection.schemaVersion !== null && inspection.schemaVersion > SCHEMA_VERSION) {
      throw new RepositoryError(
        'CONFLICT',
        'That ledger was written by a newer WageRoute. Update this computer before opening it.'
      )
    }
  } else if (mode !== 'move' && mode !== 'fresh') {
    throw new RepositoryError('VALIDATION', `Unknown storage move: ${String(mode)}`)
  } else if (inspection.hasLedger) {
    throw new RepositoryError(
      'CONFLICT',
      'That folder already has a WageRoute ledger. Open it instead, or pick an empty folder.'
    )
  }
  return { directory, mode, inspection }
}

export function describeStorageCandidate(directory: string, now = Date.now()): StorageCandidate {
  const resolved = resolve(directory)
  writable(resolved)
  const inspection = inspectLedger(resolved)
  const lock = readLock(lockPath(resolved))
  const active = lock && isLockActive(lock, now) ? lock.info : null
  return {
    directory: resolved,
    hasLedger: inspection.hasLedger,
    schemaVersion: inspection.schemaVersion,
    locked: active !== null,
    lockedBy: active ? `${active.hostname} · since ${active.startedAt}` : null
  }
}

/**
 * A consistent copy of the open ledger, taken with SQLite's backup API, written
 * beside the target and renamed into place only after it passes an integrity
 * check. The previous bytes of a partially written file never become a ledger.
 */
export async function copyLedgerInto(db: Database.Database, targetDirectory: string): Promise<string> {
  const target = join(targetDirectory, DB_FILE)
  const temporary = join(targetDirectory, `.${DB_FILE}.${process.pid}.tmp`)
  rmSync(temporary, { force: true })
  // Sidecars from an earlier run belong to the bytes being replaced; leaving
  // them would let SQLite replay an old journal over the new file.
  for (const sidecar of ['-wal', '-shm']) rmSync(`${target}${sidecar}`, { force: true })
  try {
    await db.backup(temporary)
    const probe = new Database(temporary)
    try {
      assertHealthy(probe)
    } finally {
      probe.close()
    }
    renameSync(temporary, target)
    return target
  } catch (error) {
    rmSync(temporary, { force: true })
    throw error
  }
}

function stamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
}

function prune(directory: string, prefix: string, keep: number): void {
  const copies = readdirSync(directory)
    .filter((name) => name.startsWith(prefix) && name.endsWith('.db'))
    .sort()
    .reverse()
  for (const name of copies.slice(keep)) rmSync(join(directory, name), { force: true })
}

/** A disclosed safety copy beside the ledger being left, before the pointer moves. */
export async function copyLedgerToBackups(
  db: Database.Database,
  dataDirectory: string,
  now = new Date()
): Promise<string> {
  const directory = backupsDirectory(dataDirectory)
  mkdirSync(directory, { recursive: true })
  const file = join(directory, `pre-move-${stamp(now)}.db`)
  await db.backup(file)
  prune(directory, 'pre-move-', 3)
  return file
}

/**
 * Copies a closed ledger file aside — used before an external ledger is copied
 * back over the local one, so returning home can never erase the local history
 * without leaving a date-stamped copy behind.
 */
export function backupFileAside(
  source: string,
  userDataDir: string,
  prefix: 'pre-return',
  now = new Date()
): string | null {
  if (!existsSync(source)) return null
  const directory = backupsDirectory(userDataDir)
  mkdirSync(directory, { recursive: true })
  const file = join(directory, `${prefix}-${stamp(now)}.db`)
  copyFileSync(source, file)
  prune(directory, `${prefix}-`, 3)
  return file
}

import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync
} from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'

export const DB_FILE = 'wageroute.db'

const LEGACY_DIR = 'Cash Flow Routing'
const LEGACY_DB_FILE = 'cash-flow-routing.db'
const SIDECARS = ['-wal', '-shm'] as const
const SQLITE_HEADER = 'SQLite format 3\u0000'

export interface AdoptionResult {
  /** True when this launch moved a legacy database into place. */
  adopted: boolean
  /** Present when an adoption was attempted and could not be completed. */
  error?: string
}

function hasSqliteHeader(path: string): boolean {
  const fd = openSync(path, 'r')
  try {
    const header = Buffer.alloc(16)
    const read = readSync(fd, header, 0, 16, 0)
    return read === 16 && header.toString('latin1') === SQLITE_HEADER
  } finally {
    closeSync(fd)
  }
}

function removeQuietly(path: string): void {
  try {
    rmSync(path, { force: true })
  } catch {
    // A leftover temp file is harmless; the next launch retries the adoption.
  }
}

/**
 * The app used to be called Cash Flow Routing, which gave it a different
 * userData folder. Move that database (with its WAL) into the new folder on
 * first launch and leave the original untouched.
 *
 * The copy is built under temporary names and only renamed into place once the
 * database passes an integrity check, so a crash mid-copy can never leave a
 * half-written or WAL-less database as the live one. The WAL and shared-memory
 * files are renamed before the main file: if the process dies in between, the
 * next launch sees no live database, clears the stale sidecars and retries.
 */
export function adoptLegacyDatabase(appData: string, userData: string): AdoptionResult {
  const target = join(userData, DB_FILE)
  if (existsSync(target)) return { adopted: false }

  const source = join(appData, LEGACY_DIR, LEGACY_DB_FILE)
  if (!existsSync(source)) return { adopted: false }

  if (!hasSqliteHeader(source)) {
    return {
      adopted: false,
      error: 'The old Cash Flow Routing database is not a readable SQLite file.'
    }
  }

  const staging = `${target}.adopting`
  const staged = [staging, ...SIDECARS.map((suffix) => staging + suffix)]

  try {
    mkdirSync(userData, { recursive: true })
    for (const path of [...staged, ...SIDECARS.map((suffix) => target + suffix)]) {
      removeQuietly(path)
    }

    copyFileSync(source, staging)
    for (const suffix of SIDECARS) {
      if (existsSync(source + suffix)) copyFileSync(source + suffix, staging + suffix)
    }

    if (!hasSqliteHeader(staging)) {
      throw new Error('The copy of the old database could not be read back.')
    }

    // Read-only, so checking the copy cannot checkpoint or change it. WAL
    // frames are visible to a reader, which is exactly what we need to verify.
    const db = new Database(staging, { readonly: true })
    try {
      const result = db.pragma('quick_check', { simple: true })
      if (result !== 'ok') throw new Error(`The old database failed its integrity check (${result}).`)
    } finally {
      db.close()
    }

    for (const suffix of SIDECARS) {
      if (existsSync(staging + suffix)) renameSync(staging + suffix, target + suffix)
    }
    renameSync(staging, target)
    return { adopted: true }
  } catch (error) {
    for (const path of staged) removeQuietly(path)
    return {
      adopted: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

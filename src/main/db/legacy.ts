import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

export const DB_FILE = 'wageroute.db'

const LEGACY_DIR = 'Cash Flow Routing'
const LEGACY_DB_FILE = 'cash-flow-routing.db'

/**
 * The app used to be called Cash Flow Routing, which gave it a different
 * userData folder. Copy that database (with its WAL) into the new folder on
 * first launch and leave the original untouched.
 */
export function adoptLegacyDatabase(appData: string, userData: string): boolean {
  const target = join(userData, DB_FILE)
  if (existsSync(target)) return false

  const source = join(appData, LEGACY_DIR, LEGACY_DB_FILE)
  if (!existsSync(source)) return false

  mkdirSync(userData, { recursive: true })
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(source + suffix)) copyFileSync(source + suffix, target + suffix)
  }
  return true
}

import type { ImportTables } from '@shared/importRepair'
import { looksSealed, type SealedCopy } from './vault'

/** One record holds the whole ledger; a backup is small enough for that. */
export interface StoredLedger {
  tables: ImportTables
  version: number
  /** When this phone opened the file. */
  importedAt: string
  /** When the desktop wrote the file; older records held this in `importedAt`. */
  exportedAt?: string
  sourceName: string
  localIds: string[]
}

/**
 * What the one record holds: the ledger as it was written, or the same fields
 * sealed under this phone's vault.
 *
 * It is one record and one key because there is one ledger, and it is a union
 * rather than a new store because turning the vault on or off has to be a single
 * read-and-write over the data that is already there. A record whose `vault` says
 * which format it is lets that happen without a schema change — and without the
 * plaintext copy ever existing beside the sealed one, even for the moment a write
 * is in flight.
 */
export type StoredCopy = StoredLedger | SealedCopy

const DB_NAME = 'wageroute-pocket'
const DB_VERSION = 1
const STORE = 'ledger'
const KEY = 'current'

let opening: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (opening) return opening
  const attempt = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE)
      }
    }
    request.onsuccess = () => {
      const db = request.result
      // Storage is shared by every tab. If another one ever upgrades the
      // schema, step aside so it can, and open fresh next time.
      db.onversionchange = () => {
        db.close()
        opening = null
      }
      resolve(db)
    }
    request.onerror = () => reject(request.error ?? new Error('Could not open phone storage'))
    request.onblocked = () => reject(new Error('Phone storage is open in another tab'))
  })
  // A rejected promise must not stay cached: the next attempt (a reload, or the
  // user choosing a backup again) deserves a real try at opening storage.
  opening = attempt.catch((error) => {
    opening = null
    throw error
  })
  return opening
}

function run<T>(mode: IDBTransactionMode, task: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(STORE, mode)
        const request = task(transaction.objectStore(STORE))
        let result!: T
        let failure: DOMException | null = null
        request.onsuccess = () => {
          result = request.result
        }
        request.onerror = () => {
          failure = request.error
        }
        // A write is only real once the transaction commits. A quota or disk
        // error can arrive after the request itself reported success, and
        // claiming a save before that leaves the screen ahead of the ledger.
        transaction.oncomplete = () => resolve(result)
        transaction.onerror = () =>
          reject(failure ?? transaction.error ?? new Error('Phone storage failed'))
        transaction.onabort = () =>
          reject(transaction.error ?? failure ?? new Error('Phone storage failed'))
      })
  )
}

/**
 * Read the record without opening anything. A sealed copy stays sealed here: the
 * store is the only place that knows a passphrase was just typed, and a reader that
 * decrypted on its own would be holding a key nobody asked it for.
 */
export async function readLedger(): Promise<StoredCopy | null> {
  const value = await run<StoredCopy | undefined>('readonly', (store) => store.get(KEY))
  if (!value || typeof value !== 'object') return null
  if (looksSealed(value)) return value
  // An object from storage is not a ledger just because it is present: a record
  // missing its rows means this phone has nothing to show.
  if (!('tables' in value) || !value.tables) return null
  return value
}

export async function writeLedger(value: StoredCopy): Promise<void> {
  await run('readwrite', (store) => store.put(value, KEY))
}

export async function deleteLedger(): Promise<void> {
  await run('readwrite', (store) => store.delete(KEY))
}

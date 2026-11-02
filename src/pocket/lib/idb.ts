import type { ImportTables } from '@shared/importRepair'

/** One record holds the whole ledger; a backup is small enough for that. */
export interface StoredLedger {
  tables: ImportTables
  version: number
  importedAt: string
  sourceName: string
  localIds: string[]
}

const DB_NAME = 'wageroute-pocket'
const DB_VERSION = 1
const STORE = 'ledger'
const KEY = 'current'

let opening: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (opening) return opening
  opening = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE)
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Could not open phone storage'))
    request.onblocked = () => reject(new Error('Phone storage is open in another tab'))
  })
  return opening
}

function run<T>(mode: IDBTransactionMode, task: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(STORE, mode)
        const request = task(transaction.objectStore(STORE))
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error ?? new Error('Phone storage failed'))
        transaction.onabort = () => reject(transaction.error ?? new Error('Phone storage failed'))
      })
  )
}

export async function readLedger(): Promise<StoredLedger | null> {
  const value = await run<StoredLedger | undefined>('readonly', (store) => store.get(KEY))
  if (!value || typeof value !== 'object' || !value.tables) return null
  return value
}

export async function writeLedger(value: StoredLedger): Promise<void> {
  await run('readwrite', (store) => store.put(value, KEY))
}

export async function deleteLedger(): Promise<void> {
  await run('readwrite', (store) => store.delete(KEY))
}

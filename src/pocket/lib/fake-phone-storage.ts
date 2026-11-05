/**
 * Node has no IndexedDB, and the phone's store promises that it only says a
 * write happened once the record exists — so a test that wants to prove the
 * ledger landed needs a storage that settles its events on a later microtask,
 * the way a browser does, rather than before the caller has attached handlers.
 * Everything written lands in the returned map.
 */

interface FakeRequest {
  result?: unknown
  onsuccess?: () => void
  onerror?: () => void
  onupgradeneeded?: () => void
  onblocked?: () => void
}

interface FakeTransaction {
  oncomplete?: () => void
  onerror?: () => void
  onabort?: () => void
  error?: null
  objectStore: () => {
    put: (value: unknown, key: string) => FakeRequest
    get: (key: string) => FakeRequest
    delete: (key: string) => FakeRequest
  }
}

function phoneStorage(records: Map<string, unknown>): { open: () => FakeRequest } {
  const settle = (request: FakeRequest, transaction: FakeTransaction): void => {
    queueMicrotask(() => {
      request.onsuccess?.()
      transaction.oncomplete?.()
    })
  }

  const transaction: FakeTransaction = {
    objectStore: () => ({
      put: (value, key) => {
        const request: FakeRequest = {}
        records.set(key, value)
        settle(request, transaction)
        return request
      },
      get: (key) => {
        const request: FakeRequest = { result: records.get(key) }
        settle(request, transaction)
        return request
      },
      delete: (key) => {
        const request: FakeRequest = {}
        records.delete(key)
        settle(request, transaction)
        return request
      }
    })
  }

  const database = {
    // One store, as the phone's own schema has it.
    objectStoreNames: { contains: (name: string) => name === 'ledger' },
    createObjectStore: (name: string) => {
      void name
      return {}
    },
    transaction: () => transaction,
    close: () => undefined
  }

  return {
    open: () => {
      const request: FakeRequest = { result: database }
      queueMicrotask(() => {
        request.onupgradeneeded?.()
        request.onsuccess?.()
      })
      return request
    }
  }
}

export function installFakePhoneStorage(): Map<string, unknown> {
  const records = new Map<string, unknown>()
  Object.defineProperty(globalThis, 'indexedDB', {
    value: phoneStorage(records),
    configurable: true,
    writable: true
  })
  return records
}

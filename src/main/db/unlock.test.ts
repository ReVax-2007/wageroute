import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { encryptLedger, openLedger } from './encryption'
import {
  KeyFileError,
  LEDGER_CIPHER,
  NoCustodyError,
  generateDataKey,
  keyFilePath,
  readKeyFile,
  sealWithPasskey,
  sealWithPassphrase,
  sealWithPin,
  writeKeyFile,
  type DeviceWrap,
  type LedgerKeyFile
} from './ledger-key'
import { migrate } from './migrations'
import {
  LedgerLockedError,
  MissingKeyFileError,
  openLedgerKey,
  unlockLedger,
  type CustodyAttempts
} from './unlock'

const NOW = '2026-01-01T00:00:00.000Z'

/**
 * The launch decision, with the keychain and the prompt both faked. What is being
 * pinned here is the *order* and the refusal cases: a machine with a keychain
 * must never be asked to type, and a machine without one must be told why it is
 * being asked.
 */

function workspace(): string {
  return mkdtempSync(join(tmpdir(), 'wageroute-unlock-'))
}

function withKeyFile(directory: string, file: LedgerKeyFile): string {
  writeKeyFile(directory, file)
  return directory
}

function base(createdAt = '2026-01-01T00:00:00.000Z'): Omit<LedgerKeyFile, 'device' | 'passphrase'> {
  return { version: 1, cipher: LEDGER_CIPHER, createdAt }
}

const keychain = (dataKey: Buffer): NonNullable<CustodyAttempts['device']> => ({
  available: () => true,
  open: () => dataKey
})

const brokenKeychain = (message: string): NonNullable<CustodyAttempts['device']> => ({
  available: () => true,
  open: () => {
    throw new Error(message)
  }
})

const noKeychain: NonNullable<CustodyAttempts['device']> = {
  available: () => false,
  open: () => {
    throw new Error('the app asked the keychain even though it reported none')
  }
}

test('a plaintext ledger has nothing to unlock', async () => {
  const dir = workspace()
  try {
    assert.equal(await unlockLedger(dir, {}), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a device wrap that opens is never followed by a question', async () => {
  const dir = workspace()
  try {
    const key = generateDataKey()
    withKeyFile(dir, {
      ...base(),
      device: { sealed: 'pretend-keychain-blob' },
      passphrase: sealWithPassphrase(key, 'unused-passphrase')
    })
    const result = await unlockLedger(dir, {
      device: keychain(key),
      askForPassphrase: () => {
        throw new Error('the user was asked even though the keychain answered')
      }
    })
    assert.equal(result?.via, 'device')
    assert.equal(result?.attempts, 0)
    assert.deepEqual(result?.dataKey, key)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a keychain that refuses falls through to the passphrase', async () => {
  const dir = workspace()
  try {
    const key = generateDataKey()
    withKeyFile(dir, {
      ...base(),
      device: { sealed: 'blob-from-another-computer' },
      passphrase: sealWithPassphrase(key, 'right-here')
    })
    const asked: { wrong: boolean }[] = []
    const result = await unlockLedger(dir, {
      device: brokenKeychain('the keychain has no such item'),
      askForPassphrase: async (state) => {
        asked.push(state)
        return 'right-here'
      }
    })
    assert.equal(result?.via, 'passphrase')
    assert.deepEqual(result?.dataKey, key)
    // The first question is not a retry, so the prompt must not show an error.
    assert.deepEqual(asked, [{ wrong: false, accepts: { passphrase: true, pin: false } }])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a wrong passphrase is asked again, marked as wrong, and counted', async () => {
  const dir = workspace()
  try {
    const key = generateDataKey()
    withKeyFile(dir, { ...base(), passphrase: sealWithPassphrase(key, 'correct horse') })
    const typed = ['first guess', 'second guess', 'correct horse']
    const states: { wrong: boolean }[] = []
    const result = await unlockLedger(dir, {
      askForPassphrase: async () => {
        states.push({ wrong: states.length > 0 })
        return typed.shift() ?? null
      }
    })
    assert.deepEqual(result?.dataKey, key)
    assert.equal(result?.via, 'passphrase')
    assert.equal(result?.attempts, 3)
    assert.deepEqual(states, [{ wrong: false }, { wrong: true }, { wrong: true }])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('closing the prompt leaves the ledger locked rather than opening anything', async () => {
  const dir = workspace()
  try {
    const key = generateDataKey()
    withKeyFile(dir, { ...base(), passphrase: sealWithPassphrase(key, 'never typed') })
    const before = readFileSync(keyFilePath(dir), 'utf8')
    await assert.rejects(
      () => unlockLedger(dir, { askForPassphrase: async () => null }),
      LedgerLockedError
    )
    // Refusing to type must not change anything: the marker is the only record
    // of custody, and a closed prompt is not an answer.
    assert.equal(readFileSync(keyFilePath(dir), 'utf8'), before)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a passphrase-only ledger on a machine with no prompt says who is missing', async () => {
  const dir = workspace()
  try {
    const key = generateDataKey()
    withKeyFile(dir, { ...base(), passphrase: sealWithPassphrase(key, 'typed somewhere else') })
    await assert.rejects(() => unlockLedger(dir, { device: noKeychain }), LedgerLockedError)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a device-only ledger with no keychain on this machine names both ways out', async () => {
  const dir = workspace()
  try {
    const wrap: DeviceWrap = { sealed: 'sealed-on-another-machine' }
    withKeyFile(dir, { ...base(), device: wrap })
    await assert.rejects(
      () => unlockLedger(dir, { device: noKeychain, askForPassphrase: async () => null }),
      (error: unknown) => {
        assert.ok(error instanceof NoCustodyError)
        assert.match(error.message, /no keychain/)
        // The other ways out are the point of the message: the first phrase is
        // what the key file records, so it must never reach the screen.
        assert.equal(error.message.includes(wrap.sealed), false)
        return true
      }
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a corrupt key file is refused before any passphrase is asked for', async () => {
  const dir = workspace()
  try {
    writeFileSync(keyFilePath(dir), '{ "version": 2 }')
    let asked = 0
    await assert.rejects(
      () =>
        unlockLedger(dir, {
          askForPassphrase: async () => {
            asked += 1
            return 'anything'
          }
        }),
      KeyFileError
    )
    assert.equal(asked, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/** A real schema ledger, encrypted through the same path the app uses. */
function ledgerAt(directory: string, dataKey: Buffer | null): string {
  const file = join(directory, 'wageroute.db')
  const db = openLedger(file, null)
  migrate(db)
  db.prepare(
    `INSERT INTO users (id, display_name, created_at, updated_at) VALUES ('u1', 'Tester', ?, ?)`
  ).run(NOW, NOW)
  db.prepare(
    `INSERT INTO accounts (id, user_id, name, kind, created_at, updated_at)
     VALUES ('a1', 'u1', 'Chequing', 'checking', ?, ?)`
  ).run(NOW, NOW)
  db.prepare(
    `INSERT INTO transactions (id, user_id, account_id, kind, amount_cents, occurred_on, created_at, updated_at)
     VALUES ('t1', 'u1', 'a1', 'expense', 500, '2026-01-05', ?, ?)`
  ).run(NOW, NOW)
  db.close()
  if (dataKey) encryptLedger({ dataDirectory: directory, ledgerFile: file, dataKey })
  return file
}

test('a keyed launch hands back the key and reports nothing restored', async () => {
  const dir = workspace()
  try {
    const key = generateDataKey()
    const file = ledgerAt(dir, key)
    withKeyFile(dir, { ...base(), device: { sealed: 'blob' } })
    const opening = await openLedgerKey(dir, file, { device: keychain(key) })
    assert.deepEqual(opening, {
      state: 'keyed',
      dataKey: key,
      via: 'device',
      attempts: 0,
      restored: false,
      wrecked: undefined
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a key file over a plaintext ledger does not make it unreadable', async () => {
  const dir = workspace()
  try {
    // What a crashed decrypt leaves: the pages went back to plaintext and the
    // marker is still beside them. The ledger is the fact, the marker the promise.
    const key = generateDataKey()
    const file = ledgerAt(dir, null)
    withKeyFile(dir, { ...base(), device: { sealed: 'blob' } })
    assert.deepEqual(await openLedgerKey(dir, file, { device: keychain(key) }), { state: 'plaintext' })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a transition that finished is closed out of the key file on the way past', async () => {
  const dir = workspace()
  try {
    const key = generateDataKey()
    const file = ledgerAt(dir, key)
    withKeyFile(dir, {
      ...base(),
      device: { sealed: 'blob' },
      pending: { direction: 'encrypt', copy: join(dir, 'pre-encrypt-stale.db') }
    })
    writeFileSync(join(dir, 'pre-encrypt-stale.db'), 'the copy the app never got to delete')

    assert.deepEqual(await openLedgerKey(dir, file, { device: keychain(key) }), {
      state: 'keyed',
      dataKey: key,
      via: 'device',
      attempts: 0,
      restored: false,
      wrecked: undefined
    })
    assert.equal(readKeyFile(dir)?.pending, undefined)
    assert.equal(existsSync(join(dir, 'pre-encrypt-stale.db')), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a wrecked ledger with no copy to fall back on is reported and left alone', async () => {
  const dir = workspace()
  try {
    const key = generateDataKey()
    const file = ledgerAt(dir, key)
    const copy = join(dir, 'pre-encrypt-hopeless.db')
    withKeyFile(dir, {
      ...base(),
      device: { sealed: 'blob' },
      pending: { direction: 'encrypt', copy }
    })
    writeFileSync(file, 'z'.repeat(8192))

    assert.deepEqual(await openLedgerKey(dir, file, { device: keychain(key) }), {
      state: 'unrecoverable',
      direction: 'encrypt',
      copy
    })
    // Both files are still there, still as they were: this is the one state from
    // which a human, not the app, has to decide.
    assert.equal(readKeyFile(dir)?.pending?.direction, 'encrypt')
    assert.equal(readFileSync(file).subarray(0, 1).toString(), 'z')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a ciphertext ledger with no key file is named, not handed to the driver', async () => {
  const dir = workspace()
  try {
    const key = generateDataKey()
    const file = ledgerAt(dir, key)
    rmSync(keyFilePath(dir), { force: true })
    const before = readFileSync(file)

    await assert.rejects(
      () =>
        openLedgerKey(dir, file, {
          askForPassphrase: async () => {
            throw new Error('a launch with no key file has nothing to check a phrase against')
          }
        }),
      (error: unknown) => {
        assert.ok(error instanceof MissingKeyFileError)
        // Both files are named, because the advice is to put the pair back together.
        assert.ok(error.message.includes(file))
        assert.ok(error.message.includes(keyFilePath(dir)))
        // The key never reaches the copy that explains the failure.
        assert.equal(error.message.includes(key.toString('base64')), false)
        return true
      }
    )
    assert.deepEqual(readFileSync(file), before)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a plaintext ledger with no key file opens as the plaintext it is', async () => {
  const dir = workspace()
  try {
    const file = ledgerAt(dir, null)
    assert.deepEqual(await openLedgerKey(dir, file, {}), { state: 'plaintext' })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/** ADR 0031: the passkey sits between the keychain and the typed prompt. */
const PRF = Buffer.alloc(32, 9)

function passkeyFile(key: Buffer): LedgerKeyFile {
  return {
    ...base(),
    passphrase: sealWithPassphrase(key, 'right-here'),
    passkey: sealWithPasskey(key, { credentialId: 'c1', rpId: 'localhost', prfSalt: Buffer.alloc(32, 1), prfOutput: PRF })
  }
}

test('a passkey opens the ledger before anything is typed', async () => {
  const dir = workspace()
  try {
    const key = generateDataKey()
    withKeyFile(dir, passkeyFile(key))
    let asked = 0
    const result = await unlockLedger(dir, {
      passkey: async () => PRF,
      askForPassphrase: async () => {
        asked += 1
        return null
      }
    })
    assert.equal(result?.via, 'passkey')
    assert.deepEqual(result?.dataKey, key)
    assert.equal(asked, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a cancelled, failing or wrong passkey falls through to the typed prompt', async () => {
  for (const passkey of [
    async () => null,
    async () => {
      throw new Error('Windows Hello is not set up')
    },
    async () => Buffer.alloc(32, 3)
  ]) {
    const dir = workspace()
    try {
      const key = generateDataKey()
      withKeyFile(dir, passkeyFile(key))
      const result = await unlockLedger(dir, { passkey, askForPassphrase: async () => 'right-here' })
      assert.equal(result?.via, 'passphrase')
      assert.deepEqual(result?.dataKey, key)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
})

test('a PIN typed at the prompt opens a ledger the PIN alone holds, and the prompt is told to ask for one', async () => {
  const dir = workspace()
  try {
    const key = generateDataKey()
    withKeyFile(dir, { ...base(), pin: sealWithPin(key, '482915') })
    const states: unknown[] = []
    const typed = ['482916', '482915']
    const result = await unlockLedger(dir, {
      askForPassphrase: async (state) => {
        states.push(state)
        return typed.shift() ?? null
      }
    })
    assert.equal(result?.via, 'pin')
    assert.deepEqual(result?.dataKey, key)
    assert.deepEqual(states, [
      { wrong: false, accepts: { passphrase: false, pin: true } },
      { wrong: true, accepts: { passphrase: false, pin: true } }
    ])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})


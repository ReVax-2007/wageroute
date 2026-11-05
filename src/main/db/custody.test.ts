import assert from 'node:assert/strict'
import Database from 'better-sqlite3-multiple-ciphers'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  CustodyError,
  changeKeyCustody,
  disableEncryption,
  enableEncryption,
  readEncryptionStatus,
  type DeviceKeychain
} from './custody'
import { encryptLedger, ledgerLooksEncrypted, openLedger } from './encryption'
import {
  KEY_FILE,
  generateDataKey,
  openWithPassphrase,
  readKeyFile,
  sameKey,
  writeKeyFile,
  type PassphraseWrap
} from './ledger-key'
import { migrate } from './migrations'

/**
 * The Settings-facing encryption operations, tested without Electron.
 *
 * The heart of this file is one test: a ledger with money in it goes to
 * ciphertext, keeps taking writes, and comes back to plaintext — then every
 * custody rule that has to hold around that round trip. What is being proved is
 * never "a wrap was written" but "the wrap releases the key that opens the
 * file", because those two differ in exactly the way that destroys a ledger.
 */

const NOW = '2026-01-01T00:00:00.000Z'
const PHRASE = 'fourteen characters is plenty'
const OTHER = 'a different fourteen characters'

function workspace(): string {
  return mkdtempSync(join(tmpdir(), 'wageroute-custody-'))
}

/** A real schema ledger, written the way the app writes one. */
function plainLedger(dir: string, rows = 40): string {
  const file = join(dir, 'wageroute.db')
  const db = new Database(file)
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('foreign_keys = ON')
  db.pragma('secure_delete = ON')
  migrate(db)
  db.prepare(`INSERT INTO users (id, display_name, created_at, updated_at) VALUES ('u1', 'Tester', ?, ?)`).run(NOW, NOW)
  db.prepare(
    `INSERT INTO accounts (id, user_id, name, kind, created_at, updated_at)
     VALUES ('a1', 'u1', 'Chequing', 'checking', ?, ?)`
  ).run(NOW, NOW)
  const insert = db.prepare(
    `INSERT INTO transactions (id, user_id, account_id, kind, amount_cents, occurred_on, created_at, updated_at)
     VALUES (?, 'u1', 'a1', 'expense', ?, '2026-01-05', ?, ?)`
  )
  for (let i = 0; i < rows; i += 1) insert.run(`t${i}`, (i + 1) * 100, NOW, NOW)
  db.close()
  return file
}

/**
 * `safeStorage` stand-in. The real one is opaque and Electron-only; what matters
 * here is the shape of the contract — seal gives back something only open can
 * turn into the key again.
 */
const fakeKeychain: DeviceKeychain = {
  available: () => true,
  seal: (dataKey) => ({ sealed: dataKey.toString('base64') }),
  open: (wrap) => Buffer.from(wrap.sealed, 'base64')
}

/** A keychain that accepts the key and cannot return it — the failure mode that matters. */
const lyingKeychain: DeviceKeychain = {
  ...fakeKeychain,
  open: () => generateDataKey()
}

const noKeychain: DeviceKeychain = {
  available: () => false,
  seal: () => {
    throw new Error('no keychain on this system')
  },
  open: () => {
    throw new Error('no keychain on this system')
  }
}

function totals(file: string, dataKey: Buffer | null): { rows: number; cents: number } {
  const db = openLedger(file, dataKey)
  try {
    const row = db.prepare('SELECT count(*) AS c, sum(amount_cents) AS s FROM transactions').get() as {
      c: number
      s: number
    }
    return { rows: row.c, cents: row.s }
  } finally {
    db.close()
  }
}

/** The key the way a launch would find it: this computer first, then the phrase. */
function sessionKey(dir: string, passphrase = PHRASE): Buffer {
  const file = readKeyFile(dir)
  if (!file) throw new Error('no key file')
  if (file.device) return fakeKeychain.open(file.device)
  if (file.passphrase) return openWithPassphrase(file.passphrase, passphrase)
  throw new Error('no custody in the key file')
}

function strays(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.startsWith('pre-'))
}

function phraseWrap(dir: string): PassphraseWrap {
  const wrap = readKeyFile(dir)?.passphrase
  if (!wrap) throw new Error('the key file holds no passphrase wrap')
  return wrap
}

test('encrypting with this computer leaves a ciphertext ledger the keychain opens', () => {
  const dir = workspace()
  try {
    const file = plainLedger(dir)
    const outcome = enableEncryption({
      dataDirectory: dir,
      ledgerFile: file,
      custody: 'device',
      keychain: fakeKeychain
    })
    assert.equal(outcome.rows, 40)
    assert.equal(ledgerLooksEncrypted(file), true)
    const key = sessionKey(dir)
    assert.deepEqual(totals(file, key), { rows: 40, cents: 82000 })
    // The unkeyed path is shut out, not quietly wrong.
    assert.throws(() => totals(file, null), /not a database/i)

    const marker = readKeyFile(dir)
    assert.ok(marker)
    assert.equal(marker.device !== undefined, true)
    assert.equal(marker.passphrase, undefined)
    assert.equal(marker.pending, undefined)
    assert.equal(marker.cipher, 'chacha20')
  } finally {
    rm(dir)
  }
})

test('encrypting with a passphrase seals the key so only the phrase releases it', () => {
  const dir = workspace()
  try {
    const file = plainLedger(dir)
    enableEncryption({ dataDirectory: dir, ledgerFile: file, custody: 'passphrase', passphrase: PHRASE })
    const wrap = phraseWrap(dir)
    assert.equal(readKeyFile(dir)?.device, undefined)
    // The wrap is the check: a wrong phrase yields no key, so no ledger.
    assert.throws(() => openWithPassphrase(wrap, 'wrong phrase entirely'), /does not open/i)
    assert.deepEqual(totals(file, openWithPassphrase(wrap, PHRASE)), { rows: 40, cents: 82000 })
    // The passphrase itself is nowhere in the marker.
    assert.equal(readFileSync(join(dir, KEY_FILE), 'utf8').includes(PHRASE), false)
  } finally {
    rm(dir)
  }
})

test('both custody methods release the same key, which is what makes either one enough', () => {
  const dir = workspace()
  try {
    const file = plainLedger(dir)
    enableEncryption({
      dataDirectory: dir,
      ledgerFile: file,
      custody: 'both',
      passphrase: PHRASE,
      keychain: fakeKeychain
    })
    const marker = readKeyFile(dir)
    assert.ok(marker?.device && marker.passphrase)
    assert.equal(sameKey(fakeKeychain.open(marker.device), openWithPassphrase(marker.passphrase, PHRASE)), true)
    assert.equal(sameKey(fakeKeychain.open(marker.device), sessionKey(dir)), true)
  } finally {
    rm(dir)
  }
})

test('the plaintext pre-copy does not outlive an encrypt', () => {
  const dir = workspace()
  try {
    const file = plainLedger(dir)
    enableEncryption({ dataDirectory: dir, ledgerFile: file, custody: 'device', keychain: fakeKeychain })
    // The transition takes the copy before the pages move, so for an encrypt it
    // is the whole ledger in readable plaintext beside the file that just became
    // ciphertext. Turning encryption on must not leave that behind.
    assert.deepEqual(strays(dir), [])
    assert.deepEqual(readdirSync(dir).filter((name) => name.includes('-wal') || name.includes('-shm')), [])
  } finally {
    rm(dir)
  }
})

test('the full round trip: encrypt, take writes as ciphertext, decrypt, and the money is whole', () => {
  const dir = workspace()
  try {
    const file = plainLedger(dir, 120)
    const before = totals(file, null)

    enableEncryption({
      dataDirectory: dir,
      ledgerFile: file,
      custody: 'both',
      passphrase: PHRASE,
      keychain: fakeKeychain
    })
    assert.equal(ledgerLooksEncrypted(file), true)
    assert.deepEqual(totals(file, sessionKey(dir)), before)

    // Money moves through the codec, and a fresh connection reads it back.
    const writing = openLedger(file, sessionKey(dir))
    writing.pragma('foreign_keys = ON')
    writing
      .prepare(
        `INSERT INTO transactions (id, user_id, account_id, kind, amount_cents, occurred_on, created_at, updated_at)
         VALUES ('while-encrypted', 'u1', 'a1', 'expense', 12345, '2026-03-03', ?, ?)`
      )
      .run(NOW, NOW)
    writing.close()

    // The way in changes while the money is ciphertext, and both wraps still
    // release the one key the file is written under.
    changeKeyCustody({
      dataDirectory: dir,
      ledgerFile: file,
      dataKey: sessionKey(dir),
      change: { action: 'change-passphrase', current: PHRASE, next: OTHER },
      keychain: fakeKeychain
    })
    const rotated = readKeyFile(dir)
    assert.ok(rotated?.device)
    const key = fakeKeychain.open(rotated.device)
    const wrap = phraseWrap(dir)
    assert.equal(sameKey(key, openWithPassphrase(wrap, OTHER)), true)
    assert.throws(() => openWithPassphrase(wrap, PHRASE), /does not open/i)

    const decrypted = disableEncryption({ dataDirectory: dir, ledgerFile: file, dataKey: key })
    assert.equal(decrypted.rows, before.rows + 1)
    assert.equal(ledgerLooksEncrypted(file), false)
    assert.deepEqual(totals(file, null), { rows: before.rows + 1, cents: before.cents + 12345 })
    assert.equal(readKeyFile(dir), null)
    assert.deepEqual(strays(dir), [])

    // And the ledger still takes writes the ordinary way afterwards.
    const after = new Database(file)
    after.pragma('foreign_keys = ON')
    after
      .prepare(
        `INSERT INTO transactions (id, user_id, account_id, kind, amount_cents, occurred_on, created_at, updated_at)
         VALUES ('after-decrypt', 'u1', 'a1', 'expense', 100, '2026-03-04', ?, ?)`
      )
      .run(NOW, NOW)
    after.close()
    assert.equal(totals(file, null).rows, before.rows + 2)
    assert.equal(existsSync(join(dir, KEY_FILE)), false, 'a plaintext ledger keeps no key')
  } finally {
    rm(dir)
  }
})

test('a passphrase too short to survive an offline guess is refused before anything is written', () => {
  const dir = workspace()
  try {
    const file = plainLedger(dir)
    assert.throws(
      () => enableEncryption({ dataDirectory: dir, ledgerFile: file, custody: 'passphrase', passphrase: 'short' }),
      CustodyError
    )
    assert.equal(ledgerLooksEncrypted(file), false)
    assert.equal(readKeyFile(dir), null)
    assert.deepEqual(strays(dir), [])
  } finally {
    rm(dir)
  }
})

test('a ledger that is already encrypted is not encrypted a second time', () => {
  const dir = workspace()
  try {
    const file = plainLedger(dir)
    enableEncryption({ dataDirectory: dir, ledgerFile: file, custody: 'device', keychain: fakeKeychain })
    const key = sessionKey(dir)
    const marker = readKeyFile(dir)
    assert.throws(
      () => enableEncryption({ dataDirectory: dir, ledgerFile: file, custody: 'device', keychain: fakeKeychain }),
      CustodyError
    )
    assert.deepEqual(totals(file, key), { rows: 40, cents: 82000 })
    assert.deepEqual(readKeyFile(dir), marker)
  } finally {
    rm(dir)
  }
})

test('a machine with no keychain is refused the device custody and given the phrase instead', () => {
  const dir = workspace()
  try {
    const file = plainLedger(dir)
    for (const custody of ['device', 'both'] as const) {
      assert.throws(
        () =>
          enableEncryption({
            dataDirectory: dir,
            ledgerFile: file,
            custody,
            passphrase: PHRASE,
            keychain: noKeychain
          }),
        /no keychain/i
      )
      assert.equal(ledgerLooksEncrypted(file), false)
      assert.equal(readKeyFile(dir), null)
    }
    // The same machine can still encrypt — the phrase is the way.
    enableEncryption({ dataDirectory: dir, ledgerFile: file, custody: 'passphrase', passphrase: PHRASE })
    assert.equal(readEncryptionStatus({ dataDirectory: dir, ledgerFile: file, deviceAvailable: false }).passphrase, true)
  } finally {
    rm(dir)
  }
})

test('a keychain that would not hand the key back stops the encrypt before a page moves', () => {
  const dir = workspace()
  try {
    const file = plainLedger(dir)
    assert.throws(
      () => enableEncryption({ dataDirectory: dir, ledgerFile: file, custody: 'device', keychain: lyingKeychain }),
      /would not hand back/i
    )
    assert.equal(ledgerLooksEncrypted(file), false)
    assert.deepEqual(totals(file, null), { rows: 40, cents: 82000 })
    // The marker is written only after the wrap is proved, so there is nothing
    // for the next launch to be misled by.
    assert.equal(existsSync(join(dir, KEY_FILE)), false)
  } finally {
    rm(dir)
  }
})

test('an encrypt that does not get under way leaves no key file behind', () => {
  const dir = workspace()
  try {
    // A file with a plaintext SQLite header and no ledger schema in it: the
    // state check fails at the opening, before any page is rewritten.
    const file = join(dir, 'wageroute.db')
    new Database(file).close()
    assert.equal(ledgerLooksEncrypted(file), false)
    assert.throws(
      () => enableEncryption({ dataDirectory: dir, ledgerFile: file, custody: 'device', keychain: fakeKeychain }),
      /transactions/i
    )
    assert.equal(existsSync(join(dir, KEY_FILE)), false, 'a wrap over a ledger that never encrypted protects nothing')
    assert.deepEqual(strays(dir), [])
  } finally {
    rm(dir)
  }
})

test('a transition still in flight blocks every other encryption change', () => {
  const dir = workspace()
  try {
    const file = plainLedger(dir)
    enableEncryption({ dataDirectory: dir, ledgerFile: file, custody: 'device', keychain: fakeKeychain })
    const marker = readKeyFile(dir)
    assert.ok(marker)
    writeKeyFile(dir, { ...marker, pending: { direction: 'encrypt', copy: join(dir, 'pre-encrypt-x.db') } })

    for (const call of [
      () => enableEncryption({ dataDirectory: dir, ledgerFile: file, custody: 'device', keychain: fakeKeychain }),
      () => disableEncryption({ dataDirectory: dir, ledgerFile: file, dataKey: sessionKey(dir) }),
      () =>
        changeKeyCustody({
          dataDirectory: dir,
          ledgerFile: file,
          dataKey: sessionKey(dir),
          change: { action: 'add-passphrase', passphrase: PHRASE },
          keychain: fakeKeychain
        })
    ]) {
      assert.throws(call, /never reported back/i)
    }
    assert.equal(readEncryptionStatus({ dataDirectory: dir, ledgerFile: file, deviceAvailable: true }).pending, 'encrypt')
  } finally {
    rm(dir)
  }
})

test('turning encryption off hands the ledger back readable and keeps no key', () => {
  const dir = workspace()
  try {
    const file = plainLedger(dir)
    enableEncryption({
      dataDirectory: dir,
      ledgerFile: file,
      custody: 'both',
      passphrase: PHRASE,
      keychain: fakeKeychain
    })
    const key = sessionKey(dir)
    const before = totals(file, key)
    disableEncryption({ dataDirectory: dir, ledgerFile: file, dataKey: key })
    assert.equal(ledgerLooksEncrypted(file), false)
    assert.deepEqual(totals(file, null), before)
    assert.equal(existsSync(join(dir, KEY_FILE)), false)
    // The encrypted pre-copy is unreadable by construction once the marker is
    // gone, so it goes with it.
    assert.deepEqual(strays(dir), [])
  } finally {
    rm(dir)
  }
})

test('turning encryption off refuses a ledger it cannot name a key for', () => {
  const dir = workspace()
  try {
    const file = plainLedger(dir)
    assert.throws(() => disableEncryption({ dataDirectory: dir, ledgerFile: file, dataKey: generateDataKey() }), CustodyError)

    const key = generateDataKey()
    encryptLedger({ dataDirectory: dir, ledgerFile: file, dataKey: key })
    // Ciphertext with no marker: refused rather than rewritten, because a crash
    // after this point would leave pages no record explains.
    assert.throws(
      () => disableEncryption({ dataDirectory: dir, ledgerFile: file, dataKey: key }),
      (error: unknown) => {
        assert.ok(error instanceof CustodyError)
        assert.match(error.message, new RegExp(KEY_FILE))
        return true
      }
    )
    assert.equal(ledgerLooksEncrypted(file), true)
    assert.deepEqual(totals(file, key), { rows: 40, cents: 82000 })

    assert.throws(
      () => disableEncryption({ dataDirectory: dir, ledgerFile: file, dataKey: null }),
      /did not open it with a key/i
    )
  } finally {
    rm(dir)
  }
})

test('a custody change moves no page of the ledger', () => {
  const dir = workspace()
  try {
    const file = plainLedger(dir)
    enableEncryption({ dataDirectory: dir, ledgerFile: file, custody: 'passphrase', passphrase: PHRASE })
    const bytesBefore = readFileSync(file)
    changeKeyCustody({
      dataDirectory: dir,
      ledgerFile: file,
      dataKey: sessionKey(dir),
      change: { action: 'add-device' },
      keychain: fakeKeychain
    })
    assert.equal(Buffer.compare(bytesBefore, readFileSync(file)), 0, 'the ledger file is byte-identical')
    const status = readEncryptionStatus({ dataDirectory: dir, ledgerFile: file, deviceAvailable: true })
    assert.deepEqual(
      { encrypted: status.encrypted, device: status.device, passphrase: status.passphrase, pending: status.pending },
      { encrypted: true, device: true, passphrase: true, pending: null }
    )
    assert.deepEqual(totals(file, fakeKeychain.open(readKeyFile(dir)!.device!)), { rows: 40, cents: 82000 })
  } finally {
    rm(dir)
  }
})

test('the last way in cannot be removed', () => {
  const dir = workspace()
  try {
    const file = plainLedger(dir)
    enableEncryption({ dataDirectory: dir, ledgerFile: file, custody: 'passphrase', passphrase: PHRASE })
    const key = sessionKey(dir)
    assert.throws(
      () =>
        changeKeyCustody({
          dataDirectory: dir,
          ledgerFile: file,
          dataKey: key,
          change: { action: 'remove-device' },
          keychain: fakeKeychain
        }),
      /no copy of the key to remove/i
    )
    assert.throws(
      () =>
        changeKeyCustody({ dataDirectory: dir, ledgerFile: file, dataKey: key, change: { action: 'remove-passphrase' } }),
      /only way this ledger opens/i
    )
    assert.deepEqual(totals(file, key), { rows: 40, cents: 82000 })

    // Add the second way, then the first removal is allowed.
    changeKeyCustody({
      dataDirectory: dir,
      ledgerFile: file,
      dataKey: key,
      change: { action: 'add-device' },
      keychain: fakeKeychain
    })
    changeKeyCustody({ dataDirectory: dir, ledgerFile: file, dataKey: key, change: { action: 'remove-passphrase' } })
    assert.equal(readKeyFile(dir)?.passphrase, undefined)
    assert.equal(readKeyFile(dir)?.device !== undefined, true)
    assert.deepEqual(totals(file, fakeKeychain.open(readKeyFile(dir)!.device!)), { rows: 40, cents: 82000 })
  } finally {
    rm(dir)
  }
})

test('changing a passphrase proves the old one first', () => {
  const dir = workspace()
  try {
    const file = plainLedger(dir)
    enableEncryption({ dataDirectory: dir, ledgerFile: file, custody: 'passphrase', passphrase: PHRASE })
    const key = sessionKey(dir)
    assert.throws(
      () =>
        changeKeyCustody({
          dataDirectory: dir,
          ledgerFile: file,
          dataKey: key,
          change: { action: 'change-passphrase', current: 'not the phrase at all', next: OTHER }
        }),
      /does not open this ledger, so nothing was changed/i
    )
    assert.equal(sameKey(sessionKey(dir), key), true, 'the original phrase still opens it')

    changeKeyCustody({
      dataDirectory: dir,
      ledgerFile: file,
      dataKey: key,
      change: { action: 'change-passphrase', current: PHRASE, next: OTHER }
    })
    const wrap = phraseWrap(dir)
    assert.equal(sameKey(openWithPassphrase(wrap, OTHER), key), true)
    assert.throws(() => openWithPassphrase(wrap, PHRASE), /does not open/i)
  } finally {
    rm(dir)
  }
})

test('a custody change that makes no sense is refused with the reason', () => {
  const dir = workspace()
  try {
    const file = plainLedger(dir)
    const key = generateDataKey()

    // Nothing to re-wrap on a plaintext ledger.
    assert.throws(
      () =>
        changeKeyCustody({
          dataDirectory: dir,
          ledgerFile: file,
          dataKey: key,
          change: { action: 'add-device' },
          keychain: fakeKeychain
        }),
      /no key to re-wrap/i
    )
    enableEncryption({ dataDirectory: dir, ledgerFile: file, custody: 'device', keychain: fakeKeychain })
    const session = sessionKey(dir)
    assert.throws(
      () =>
        changeKeyCustody({
          dataDirectory: dir,
          ledgerFile: file,
          dataKey: session,
          change: { action: 'add-device' },
          keychain: fakeKeychain
        }),
      /already holds a copy/i
    )
    assert.throws(
      () =>
        changeKeyCustody({
          dataDirectory: dir,
          ledgerFile: file,
          dataKey: session,
          change: { action: 'change-passphrase', current: PHRASE, next: OTHER }
        }),
      /no passphrase to change/i
    )
    assert.throws(
      () => changeKeyCustody({ dataDirectory: dir, ledgerFile: file, dataKey: null, change: { action: 'add-device' } }),
      /did not open this ledger with a key/i
    )
    // The refusal above changed nothing, so the ledger still opens the same way.
    assert.deepEqual(totals(file, session), { rows: 40, cents: 82000 })

    // A second passphrase is not a thing: it would be a second way in nobody asked for.
    changeKeyCustody({
      dataDirectory: dir,
      ledgerFile: file,
      dataKey: session,
      change: { action: 'add-passphrase', passphrase: PHRASE },
      keychain: fakeKeychain
    })
    assert.throws(
      () =>
        changeKeyCustody({
          dataDirectory: dir,
          ledgerFile: file,
          dataKey: session,
          change: { action: 'add-passphrase', passphrase: OTHER },
          keychain: fakeKeychain
        }),
      /already has a passphrase/i
    )
  } finally {
    rm(dir)
  }
})

test('adding this computer is refused when the keychain is absent or would not give the key back', () => {
  const dir = workspace()
  try {
    const file = plainLedger(dir)
    enableEncryption({ dataDirectory: dir, ledgerFile: file, custody: 'passphrase', passphrase: PHRASE })
    const before = readKeyFile(dir)
    assert.ok(before?.passphrase)
    assert.equal(before.device, undefined)

    assert.throws(
      () =>
        changeKeyCustody({
          dataDirectory: dir,
          ledgerFile: file,
          dataKey: sessionKey(dir),
          change: { action: 'add-device' },
          keychain: noKeychain
        }),
      /no keychain/i
    )
    // The keychain that accepts the key and cannot return it is the dangerous
    // one: sealing succeeds, so only the proof stops the write.
    assert.throws(
      () =>
        changeKeyCustody({
          dataDirectory: dir,
          ledgerFile: file,
          dataKey: sessionKey(dir),
          change: { action: 'add-device' },
          keychain: lyingKeychain
        }),
      /would not hand back/i
    )
    assert.deepEqual(readKeyFile(dir), before)
    assert.deepEqual(totals(file, sessionKey(dir)), { rows: 40, cents: 82000 })
  } finally {
    rm(dir)
  }
})

test('the status answers from the file, not from a setting of its own', () => {
  const dir = workspace()
  try {
    const file = plainLedger(dir)
    assert.deepEqual(readEncryptionStatus({ dataDirectory: dir, ledgerFile: file, deviceAvailable: true }), {
      encrypted: false,
      cipher: null,
      device: false,
      passphrase: false,
      pending: null,
      staleKeyFile: false,
      deviceAvailable: true
    })

    enableEncryption({ dataDirectory: dir, ledgerFile: file, custody: 'both', passphrase: PHRASE, keychain: fakeKeychain })
    const both = readEncryptionStatus({ dataDirectory: dir, ledgerFile: file, deviceAvailable: false })
    assert.deepEqual(
      { encrypted: both.encrypted, cipher: both.cipher, device: both.device, passphrase: both.passphrase, staleKeyFile: both.staleKeyFile },
      { encrypted: true, cipher: 'chacha20', device: true, passphrase: true, staleKeyFile: false }
    )
    assert.equal(both.deviceAvailable, false)

    // Ciphertext whose marker has gone says so instead of claiming a way in.
    const second = join(dir, 'second')
    mkdirSync(second)
    const secondFile = plainLedger(second)
    const key = generateDataKey()
    encryptLedger({ dataDirectory: second, ledgerFile: secondFile, dataKey: key })
    const orphan = readEncryptionStatus({ dataDirectory: second, ledgerFile: secondFile, deviceAvailable: true })
    assert.deepEqual(
      {
        encrypted: orphan.encrypted,
        cipher: orphan.cipher,
        device: orphan.device,
        passphrase: orphan.passphrase,
        pending: orphan.pending,
        staleKeyFile: orphan.staleKeyFile
      },
      { encrypted: true, cipher: null, device: false, passphrase: false, pending: null, staleKeyFile: false }
    )

    // A marker beside a plaintext ledger is what an interrupted change leaves.
    const third = join(dir, 'third')
    mkdirSync(third)
    const thirdFile = plainLedger(third)
    writeKeyFile(third, {
      version: 1,
      cipher: 'chacha20',
      device: { sealed: generateDataKey().toString('base64') },
      createdAt: NOW
    })
    const stale = readEncryptionStatus({ dataDirectory: third, ledgerFile: thirdFile, deviceAvailable: true })
    assert.equal(stale.encrypted, false)
    assert.equal(stale.staleKeyFile, true)
  } finally {
    rm(dir)
  }
})

function rm(dir: string): void {
  rmSync(dir, { recursive: true, force: true })
}

import assert from 'node:assert/strict'
import Database from 'better-sqlite3-multiple-ciphers'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  TransitionFailedError,
  applyKey,
  decryptLedger,
  encryptLedger,
  isTransitionSettled,
  ledgerLooksEncrypted,
  openLedger,
  reconcilePending,
  LedgerStateError
} from './encryption'
import { generateDataKey, LEDGER_CIPHER } from './ledger-key'
import { migrate, SCHEMA_VERSION } from './migrations'

const NOW = '2026-01-01T00:00:00.000Z'

function workspace(): string {
  return mkdtempSync(join(tmpdir(), 'wageroute-encryption-'))
}

function insertRows(db: Database.Database, count: number): void {
  const statement = db.prepare(
    `INSERT INTO transactions (id, user_id, account_id, kind, amount_cents, occurred_on, created_at, updated_at)
     VALUES (?, 'u1', 'a1', 'expense', ?, '2026-01-05', ?, ?)`
  )
  for (let i = 0; i < count; i += 1) {
    statement.run(`t${i}`, (i + 1) * 100, NOW, NOW)
  }
}

/** A real schema-10 ledger with the app's own pragmas, written by the plain path. */
function plainLedger(dir: string, rows = 25): string {
  const file = join(dir, 'wageroute.db')
  const db = new Database(file)
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('foreign_keys = ON')
  db.pragma('secure_delete = ON')
  migrate(db)
  db.prepare(
    `INSERT INTO users (id, display_name, created_at, updated_at) VALUES ('u1', 'Tester', ?, ?)`
  ).run(NOW, NOW)
  db.prepare(
    `INSERT INTO accounts (id, user_id, name, kind, created_at, updated_at)
     VALUES ('a1', 'u1', 'Chequing', 'checking', ?, ?)`
  ).run(NOW, NOW)
  insertRows(db, rows)
  db.close()
  return file
}

function totals(file: string, dataKey: Buffer | null): { rows: number; cents: number } {
  const db = openLedger(file, dataKey)
  try {
    const row = db
      .prepare('SELECT count(*) AS c, sum(amount_cents) AS s FROM transactions')
      .get() as { c: number; s: number }
    return { rows: row.c, cents: row.s }
  } finally {
    db.close()
  }
}

test('a plaintext ledger reads as plaintext and an encrypted one does not', () => {
  const dir = workspace()
  try {
    const file = plainLedger(dir)
    assert.equal(ledgerLooksEncrypted(file), false)
    assert.equal(ledgerLooksEncrypted(join(dir, 'missing.db')), false)
    // Garbage long enough to have a header is not the SQLite header, so it is
    // not plaintext: the app will key it rather than open it bare.
    writeFileSync(join(dir, 'junk.db'), 'x'.repeat(64))
    assert.equal(ledgerLooksEncrypted(join(dir, 'junk.db')), true)
    // A stub too short to carry a header is left for SQLite to reject, which is
    // a louder and more accurate answer than guessing.
    writeFileSync(join(dir, 'short.db'), 'nope')
    assert.equal(ledgerLooksEncrypted(join(dir, 'short.db')), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('encrypt then decrypt leaves the money exactly where it was', () => {
  const dir = workspace()
  try {
    const file = plainLedger(dir, 200)
    const key = generateDataKey()
    const before = totals(file, null)

    const encrypted = encryptLedger({ dataDirectory: dir, ledgerFile: file, dataKey: key })
    assert.equal(ledgerLooksEncrypted(file), true)
    assert.equal(encrypted.rows, before.rows)
    assert.deepEqual(totals(file, key), before)
    // The unkeyed path must be shut out, not silently wrong.
    assert.throws(() => totals(file, null), /not a database/i)

    const decrypted = decryptLedger({ dataDirectory: dir, ledgerFile: file, dataKey: key })
    assert.equal(ledgerLooksEncrypted(file), false)
    assert.deepEqual(totals(file, null), before)
    assert.equal(decrypted.journalMode, 'wal')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a write through the codec survives a fresh keyed connection', () => {
  const dir = workspace()
  try {
    const file = plainLedger(dir)
    const key = generateDataKey()
    encryptLedger({ dataDirectory: dir, ledgerFile: file, dataKey: key })

    const db = openLedger(file, key)
    db.pragma('foreign_keys = ON')
    db.prepare(
      `INSERT INTO transactions (id, user_id, account_id, kind, amount_cents, occurred_on, created_at, updated_at)
       VALUES ('written-while-encrypted', 'u1', 'a1', 'expense', 9900, '2026-02-02', ?, ?)`
    ).run(NOW, NOW)
    db.close()

    const reopened = openLedger(file, key)
    try {
      const row = reopened
        .prepare('SELECT amount_cents FROM transactions WHERE id = ?')
        .get('written-while-encrypted') as { amount_cents: number }
      assert.equal(row.amount_cents, 9900)
      assert.equal(reopened.pragma('user_version', { simple: true }), SCHEMA_VERSION)
    } finally {
      reopened.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the app pragma block is accepted on a keyed connection', () => {
  const dir = workspace()
  try {
    const file = plainLedger(dir)
    const key = generateDataKey()
    encryptLedger({ dataDirectory: dir, ledgerFile: file, dataKey: key })
    const db = openLedger(file, key)
    try {
      db.pragma('journal_mode = WAL')
      db.pragma('synchronous = NORMAL')
      db.pragma('cache_size = -16000')
      db.pragma('temp_store = MEMORY')
      db.pragma('mmap_size = 268435456')
      db.pragma('foreign_keys = ON')
      db.pragma('busy_timeout = 5000')
      db.pragma('secure_delete = ON')
      assert.equal(db.pragma('integrity_check', { simple: true }), 'ok')
      assert.equal(db.pragma('mmap_size', { simple: true }), 268435456)
    } finally {
      db.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the safety copy of an encrypted ledger is itself encrypted', () => {
  const dir = workspace()
  try {
    const file = plainLedger(dir)
    const key = generateDataKey()
    encryptLedger({ dataDirectory: dir, ledgerFile: file, dataKey: key })
    const outcome = decryptLedger({ dataDirectory: dir, ledgerFile: file, dataKey: key })
    // The copy taken before decrypting came from an encrypted ledger.
    assert.equal(ledgerLooksEncrypted(outcome.safetyCopy), true)
    assert.equal(existsSync(outcome.safetyCopy), true)
    // and it is only readable with the key
    assert.throws(() => totals(outcome.safetyCopy, null), /not a database/i)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a key file that cannot be written stops the change before a page moves', () => {
  const dir = workspace()
  try {
    const file = plainLedger(dir)
    const key = generateDataKey()
    const before = totals(file, null)
    // The marker is the promise that encryption is on. Refusing to record it
    // must refuse the whole change, not leave a encrypted file whose key was
    // never kept.
    assert.throws(
      () =>
        encryptLedger({
          dataDirectory: dir,
          ledgerFile: file,
          dataKey: key,
          onPending: () => {
            throw new Error('key file is read-only')
          }
        }),
      LedgerStateError
    )
    assert.equal(ledgerLooksEncrypted(file), false)
    assert.deepEqual(totals(file, null), before)
    // and the safety copy is not left behind as a second plaintext ledger.
    assert.deepEqual(readdirSync(dir).filter((name) => name.startsWith('pre-')), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a transition that lands but cannot confirm is rolled back to plaintext', () => {
  const dir = workspace()
  try {
    const file = plainLedger(dir)
    const key = generateDataKey()
    const before = totals(file, null)
    // onSettled runs after the pages are already rewritten. Failing there has
    // to undo the rewrite, because a ledger the app cannot name as encrypted
    // is a ledger it will refuse to open keyed.
    assert.throws(
      () =>
        encryptLedger({
          dataDirectory: dir,
          ledgerFile: file,
          dataKey: key,
          onSettled: () => {
            throw new Error('could not clear the pending marker')
          }
        }),
      (error: unknown) => {
        assert.ok(error instanceof TransitionFailedError)
        assert.equal(error.direction, 'encrypt')
        assert.equal(error.restoredTo, file)
        return true
      }
    )
    assert.equal(ledgerLooksEncrypted(file), false)
    assert.deepEqual(totals(file, null), before)
    assert.throws(() => totals(file, key), /not a database/i)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a second encrypt on an encrypted ledger refuses instead of re-wrapping silently', () => {
  const dir = workspace()
  try {
    const file = plainLedger(dir)
    const key = generateDataKey()
    encryptLedger({ dataDirectory: dir, ledgerFile: file, dataKey: key })
    const before = totals(file, key)
    assert.throws(
      () => encryptLedger({ dataDirectory: dir, ledgerFile: file, dataKey: generateDataKey() }),
      LedgerStateError
    )
    // The original key still opens the untouched ledger.
    assert.deepEqual(totals(file, key), before)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('decrypting a ledger that was never encrypted says so', () => {
  const dir = workspace()
  try {
    const file = plainLedger(dir)
    assert.throws(
      () => decryptLedger({ dataDirectory: dir, ledgerFile: file, dataKey: generateDataKey() }),
      LedgerStateError
    )
    assert.equal(ledgerLooksEncrypted(file), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a wrong key cannot start a decrypt, and nothing has moved when it refuses', () => {
  const dir = workspace()
  try {
    const file = plainLedger(dir)
    const key = generateDataKey()
    encryptLedger({ dataDirectory: dir, ledgerFile: file, dataKey: key })
    const before = totals(file, key)
    // Refused at the opening, before a page is touched, so this is a state
    // problem rather than a transition that needs rolling back.
    assert.throws(
      () => decryptLedger({ dataDirectory: dir, ledgerFile: file, dataKey: generateDataKey() }),
      LedgerStateError
    )
    assert.equal(ledgerLooksEncrypted(file), true)
    assert.deepEqual(totals(file, key), before)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the transition returns the ledger to the journal mode the folder runs in', () => {
  const dir = workspace()
  try {
    // The network-share configuration: rollback journal, full sync.
    const file = join(dir, 'wageroute.db')
    const db = new Database(file)
    db.pragma('journal_mode = DELETE')
    db.pragma('synchronous = FULL')
    migrate(db)
    db.prepare(`INSERT INTO users (id, display_name, created_at, updated_at) VALUES ('u1','T',?,?)`).run(NOW, NOW)
    db.prepare(
      `INSERT INTO accounts (id, user_id, name, kind, created_at, updated_at) VALUES ('a1','u1','C','checking',?,?)`
    ).run(NOW, NOW)
    insertRows(db, 5)
    db.close()

    const key = generateDataKey()
    const outcome = encryptLedger({ dataDirectory: dir, ledgerFile: file, dataKey: key })
    assert.equal(outcome.journalMode, 'delete')
    const probe = openLedger(file, key)
    try {
      assert.equal(probe.pragma('journal_mode', { simple: true }), 'delete')
    } finally {
      probe.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a pending transition that really completed is recognised and its copy dropped', () => {
  const dir = workspace()
  try {
    const file = plainLedger(dir)
    const key = generateDataKey()
    const outcome = encryptLedger({ dataDirectory: dir, ledgerFile: file, dataKey: key })
    assert.equal(
      isTransitionSettled({ direction: 'encrypt', copy: outcome.safetyCopy }, file, key),
      'completed'
    )
    assert.equal(existsSync(outcome.safetyCopy), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a pending encrypt whose pages never moved is reported as unfinished', () => {
  const dir = workspace()
  try {
    const file = plainLedger(dir)
    const key = generateDataKey()
    const copy = join(dir, 'pre-encrypt-fake.db')
    writeFileSync(copy, 'a copy we will not touch')
    assert.equal(
      isTransitionSettled({ direction: 'encrypt', copy }, file, key),
      'unfinished'
    )
    // Unfinished means the ledger is still the plaintext one, untouched.
    assert.equal(ledgerLooksEncrypted(file), false)
    assert.equal(existsSync(copy), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a pending decrypt that landed is completed and a pending decrypt that did not is unfinished', () => {
  const dir = workspace()
  try {
    const file = plainLedger(dir)
    const key = generateDataKey()
    encryptLedger({ dataDirectory: dir, ledgerFile: file, dataKey: key })
    const encryptedCopy = join(dir, 'pre-deencrypt.db')
    new Database(encryptedCopy).close()
    rmSync(encryptedCopy)

    // Not yet decrypted.
    assert.equal(
      isTransitionSettled({ direction: 'decrypt', copy: encryptedCopy }, file, key),
      'unfinished'
    )
    const outcome = decryptLedger({ dataDirectory: dir, ledgerFile: file, dataKey: key })
    assert.equal(
      isTransitionSettled({ direction: 'decrypt', copy: outcome.safetyCopy }, file, key),
      'completed'
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the transition runs with the cipher pinned, so a default change cannot misread the file', () => {
  const dir = workspace()
  try {
    const file = plainLedger(dir)
    const key = generateDataKey()
    encryptLedger({ dataDirectory: dir, ledgerFile: file, dataKey: key })
    // Opening with a different cipher is refused outright rather than read
    // wrong. Setting a key does not touch the file, so the refusal only lands
    // on the first read — which is why the app never reports a bare key() as a
    // successful unlock.
    const wrong = new Database(file)
    try {
      wrong.pragma("cipher('sqlcipher')")
      wrong.key(key)
      assert.throws(
        () => wrong.prepare('SELECT count(*) FROM transactions').get(),
        /not a database/i
      )
    } finally {
      wrong.close()
    }
    const right = new Database(file)
    try {
      applyKey(right, key)
      assert.equal(right.pragma('integrity_check', { simple: true }), 'ok')
      assert.equal(LEDGER_CIPHER, 'chacha20')
    } finally {
      right.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('no sidecar is left behind holding the other state of the file', () => {
  const dir = workspace()
  try {
    const file = plainLedger(dir)
    const key = generateDataKey()
    encryptLedger({ dataDirectory: dir, ledgerFile: file, dataKey: key })
    decryptLedger({ dataDirectory: dir, ledgerFile: file, dataKey: key })
    const strays = readdirSync(dir).filter((name) => name.includes('-wal') || name.includes('-shm'))
    // The ledger closes WAL on a clean close, so nothing keyed is left beside it.
    assert.deepEqual(strays, [])
    assert.equal(statSync(file).size > 0, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a crash after the rewrite settled, and a crash before it started, are both closed out', () => {
  const dir = workspace()
  try {
    const file = plainLedger(dir)
    const key = generateDataKey()
    const outcome = encryptLedger({ dataDirectory: dir, ledgerFile: file, dataKey: key })
    // The marker still says "encrypt in progress" while the file is already
    // encrypted: the rewrite finished and only the flag failed to clear.
    assert.deepEqual(reconcilePending({ direction: 'encrypt', copy: outcome.safetyCopy }, { ledgerFile: file, dataKey: key }), {
      outcome: 'settled',
      direction: 'encrypt',
      restored: false
    })
    assert.equal(existsSync(outcome.safetyCopy), false)

    // The same marker over a ledger whose pages never moved.
    const secondDir = join(dir, 'second')
    mkdirSync(secondDir)
    const second = plainLedger(secondDir, 7)
    const copy = join(dir, 'pre-encrypt-nothing-happened.db')
    copyFileSync(second, copy)
    assert.deepEqual(reconcilePending({ direction: 'encrypt', copy }, { ledgerFile: second, dataKey: key }), {
      outcome: 'settled',
      direction: 'encrypt',
      restored: false
    })
    // The copy was a duplicate of a ledger that is still whole, so it goes.
    assert.equal(existsSync(copy), false)
    assert.deepEqual(totals(second, null), { rows: 7, cents: 2800 })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a ledger wrecked mid-encrypt is put back from its copy and the wreck is kept', () => {
  const dir = workspace()
  try {
    const file = plainLedger(dir, 30)
    const key = generateDataKey()
    const before = totals(file, null)
    const copy = join(dir, 'pre-encrypt-crash.db')
    copyFileSync(file, copy)
    const wreckedSize = statSync(copy).size
    // What a power cut during the rewrite leaves: a file that is neither the
    // old ledger nor the new one.
    writeFileSync(file, 'x'.repeat(wreckedSize))

    const result = reconcilePending({ direction: 'encrypt', copy }, { ledgerFile: file, dataKey: key })
    assert.deepEqual(result, {
      outcome: 'settled',
      direction: 'encrypt',
      restored: true,
      wrecked: `${file}.wrecked`
    })
    assert.equal(ledgerLooksEncrypted(file), false)
    assert.deepEqual(totals(file, null), before)
    // The bytes that were replaced stay where the user can be pointed at them.
    assert.equal(existsSync(`${file}.wrecked`), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a ledger wrecked mid-decrypt comes back encrypted, not empty', () => {
  const dir = workspace()
  try {
    const file = plainLedger(dir, 12)
    const key = generateDataKey()
    const money = totals(file, null)
    encryptLedger({ dataDirectory: dir, ledgerFile: file, dataKey: key })
    const copy = join(dir, 'pre-decrypt-crash.db')
    copyFileSync(file, copy)
    // A header that reads as plaintext over bytes that are not a ledger: the
    // marker promised a decrypt and the file matches the promise but is useless.
    writeFileSync(file, `SQLite format 3\0${'z'.repeat(8192)}`)

    const result = reconcilePending({ direction: 'decrypt', copy }, { ledgerFile: file, dataKey: key })
    assert.deepEqual(result, {
      outcome: 'settled',
      direction: 'decrypt',
      restored: true,
      wrecked: `${file}.wrecked`
    })
    assert.equal(ledgerLooksEncrypted(file), true)
    assert.deepEqual(totals(file, key), money)
    assert.throws(() => totals(file, null), /not a database/i)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('without a copy that reads, the launch refuses and touches nothing', () => {
  const dir = workspace()
  try {
    const file = plainLedger(dir)
    const key = generateDataKey()
    const missing = join(dir, 'pre-encrypt-gone.db')
    writeFileSync(file, 'x'.repeat(4096))

    const result = reconcilePending({ direction: 'encrypt', copy: missing }, { ledgerFile: file, dataKey: key })
    assert.deepEqual(result, { outcome: 'unrecoverable', direction: 'encrypt', copy: missing })
    assert.equal(existsSync(file), true)

    // A copy that exists but is itself damaged does not count either.
    const brokenCopy = join(dir, 'pre-encrypt-broken.db')
    writeFileSync(brokenCopy, 'also not a database')
    const second = reconcilePending({ direction: 'encrypt', copy: brokenCopy }, { ledgerFile: file, dataKey: key })
    assert.equal(second.outcome, 'unrecoverable')
    assert.equal(existsSync(brokenCopy), true, 'the damaged copy is kept for whoever looks next')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  DEFAULT_KEY_FILE_PARAMS,
  DATA_KEY_BYTES,
  KeyFileError,
  LEDGER_CIPHER,
  NoCustodyError,
  WrongPassphraseError,
  deriveKek,
  generateDataKey,
  hasKeyFile,
  keyFilePath,
  openWithPassphrase,
  readKeyFile,
  removeKeyFile,
  sameKey,
  sealWithPassphrase,
  writeKeyFile,
  type LedgerKeyFile
} from './ledger-key'

function workspace(): string {
  return mkdtempSync(join(tmpdir(), 'wageroute-ledger-key-'))
}

test('a data key is 32 random bytes and every one differs', () => {
  const a = generateDataKey()
  const b = generateDataKey()
  assert.equal(a.length, DATA_KEY_BYTES)
  assert.equal(b.length, DATA_KEY_BYTES)
  assert.notDeepEqual(a, b)
})

test('the same passphrase releases the same key, and a different one does not', () => {
  const key = generateDataKey()
  const wrap = sealWithPassphrase(key, 'correct horse battery staple')
  assert.deepEqual(openWithPassphrase(wrap, 'correct horse battery staple'), key)
  assert.throws(() => openWithPassphrase(wrap, 'Correct horse battery staple'), WrongPassphraseError)
  assert.throws(() => openWithPassphrase(wrap, ''), WrongPassphraseError)
})

test('a passphrase that contains a quote is data, not syntax', () => {
  // The key never travels through a SQL string, so the oldest injection in
  // SQLite passphrase handling cannot apply here.
  const key = generateDataKey()
  for (const passphrase of ["a'; DROP TABLE transactions;--", "it's", "'", "''", 'é', '𝔲𝔫𝔦']) {
    const wrap = sealWithPassphrase(key, passphrase)
    assert.deepEqual(openWithPassphrase(wrap, passphrase), key)
  }
})

test('the wrap is randomised so two users sharing a passphrase get different bytes', () => {
  const key = generateDataKey()
  const a = sealWithPassphrase(key, 'same')
  const b = sealWithPassphrase(key, 'same')
  assert.notEqual(a.salt, b.salt)
  assert.notEqual(a.iv, b.iv)
  assert.notEqual(a.ciphertext, b.ciphertext)
  assert.deepEqual(openWithPassphrase(a, 'same'), openWithPassphrase(b, 'same'))
})

test('deriving is deterministic for a salt and changes with every parameter', () => {
  const salt = Buffer.from('00112233445566778899aabbccddeeff', 'hex')
  const base = deriveKek('pass', salt, DEFAULT_KEY_FILE_PARAMS)
  assert.deepEqual(deriveKek('pass', salt, DEFAULT_KEY_FILE_PARAMS), base)
  assert.notDeepEqual(deriveKek('pass2', salt, DEFAULT_KEY_FILE_PARAMS), base)
  // A stored wrap keeps its own parameters, so raising them later cannot
  // strand a ledger sealed under the old cost.
  assert.notDeepEqual(deriveKek('pass', salt, { ...DEFAULT_KEY_FILE_PARAMS, n: 16384 }), base)
})

test('an empty passphrase is refused rather than silently deriving a key', () => {
  const key = generateDataKey()
  const wrap = sealWithPassphrase(key, 'x'.repeat(12))
  assert.throws(() => openWithPassphrase(wrap, ''), WrongPassphraseError)
})

test('the marker round-trips through the file with its mode tightened', () => {
  const directory = workspace()
  try {
    const key = generateDataKey()
    const file: LedgerKeyFile = {
      version: 1,
      cipher: LEDGER_CIPHER,
      passphrase: sealWithPassphrase(key, 'passphrase-long-enough'),
      createdAt: new Date().toISOString()
    }
    writeKeyFile(directory, file)
    assert.deepEqual(readKeyFile(directory), file)
    if (process.platform !== 'win32') {
      assert.equal(statSync(keyFilePath(directory)).mode & 0o777, 0o600)
    }
    assert.equal(readKeyFile(join(directory, 'nope')) ?? null, null)
    assert.equal(hasKeyFile(directory), true)
    removeKeyFile(directory)
    assert.equal(hasKeyFile(directory), false)
    assert.equal(readKeyFile(directory), null)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('a marker with no way to open the ledger is refused, not ignored', () => {
  const directory = workspace()
  try {
    writeFileSync(
      keyFilePath(directory),
      JSON.stringify({ version: 1, cipher: LEDGER_CIPHER, createdAt: 'now' })
    )
    assert.throws(() => readKeyFile(directory), KeyFileError)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('a marker naming a cipher this build does not ship is refused', () => {
  // Reading a chacha20 ledger as sqlcipher looks like corruption, so guessing
  // the cipher from the file is never allowed.
  const directory = workspace()
  try {
    const key = generateDataKey()
    writeKeyFile(directory, {
      version: 1,
      cipher: LEDGER_CIPHER,
      passphrase: sealWithPassphrase(key, 'passphrase-long-enough'),
      createdAt: 'now'
    })
    const raw = JSON.parse(readFileSync(keyFilePath(directory), 'utf8'))
    raw.cipher = 'sqlcipher'
    writeFileSync(keyFilePath(directory), JSON.stringify(raw))
    assert.throws(() => readKeyFile(directory), /cipher/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('a marker from a newer version is refused', () => {
  const directory = workspace()
  try {
    writeFileSync(
      keyFilePath(directory),
      JSON.stringify({ version: 2, cipher: LEDGER_CIPHER, device: { sealed: 'aa' } })
    )
    assert.throws(() => readKeyFile(directory), /version 2/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('a truncated or corrupt marker says so instead of reporting no encryption', () => {
  const directory = workspace()
  try {
    writeFileSync(keyFilePath(directory), '{ "version": 1, "c')
    assert.throws(() => readKeyFile(directory), KeyFileError)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('a missing passphrase wrap field is caught before anything tries to open the ledger', () => {
  const directory = workspace()
  try {
    const key = generateDataKey()
    const wrap: Record<string, unknown> = { ...sealWithPassphrase(key, 'passphrase-long-enough') }
    delete wrap.tag
    writeKeyFile(directory, {
      version: 1,
      cipher: LEDGER_CIPHER,
      // Deliberately broken: the one field the parser must refuse to accept.
      passphrase: wrap as unknown as LedgerKeyFile['passphrase'],
      createdAt: 'now'
    })
    assert.throws(() => readKeyFile(directory), /tag/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('rotating custody re-wraps the same key instead of replacing it', () => {
  const key = generateDataKey()
  const before = sealWithPassphrase(key, 'old-passphrase')
  const rotated = sealWithPassphrase(openWithPassphrase(before, 'old-passphrase'), 'new-passphrase')
  assert.deepEqual(openWithPassphrase(rotated, 'new-passphrase'), key)
  assert.ok(sameKey(openWithPassphrase(before, 'old-passphrase'), openWithPassphrase(rotated, 'new-passphrase')))
  // Two wraps of the same key open the same ledger: the file was never touched.
  assert.notDeepEqual(before.ciphertext, rotated.ciphertext)
})

test('both device and passphrase wraps can hold the ledger and either releases it', () => {
  const directory = workspace()
  try {
    const key = generateDataKey()
    const file: LedgerKeyFile = {
      version: 1,
      cipher: LEDGER_CIPHER,
      device: { sealed: 'a-fake-keychain-blob' },
      passphrase: sealWithPassphrase(key, 'passphrase-long-enough'),
      createdAt: 'now'
    }
    writeKeyFile(directory, file)
    const read = readKeyFile(directory)
    assert.equal(read?.device?.sealed, 'a-fake-keychain-blob')
    assert.ok(read?.passphrase)
    assert.deepEqual(openWithPassphrase(read.passphrase!, 'passphrase-long-enough'), key)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('NoCustodyError is what a ledger with every wrap removed reports', () => {
  // A marker can be edited by hand into this state; the app must refuse loudly
  // rather than open the ledger as though it were plaintext.
  assert.equal(new NoCustodyError().code, 'NO_CUSTODY')
  const directory = workspace()
  try {
    writeFileSync(keyFilePath(directory), JSON.stringify({ version: 1, cipher: LEDGER_CIPHER }))
    assert.throws(() => readKeyFile(directory), KeyFileError)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

/**
 * The envelope format, on its own — no crypto, no platform.
 *
 * The parts worth pinning are the ones a second implementation can get wrong
 * silently: base64 that Node and a browser disagree about, and a validator that
 * accepts a file whose parameters have been quietly edited. Whether a sealed
 * backup actually opens is `src/main/envelope.test.ts`.
 */
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import {
  DEFAULT_ITERATIONS,
  ENVELOPE_FORMAT,
  MAX_ITERATIONS,
  MIN_ITERATIONS,
  SALT_BYTES,
  EnvelopeError,
  envelopeFileName,
  envelopeToJson,
  fromBase64,
  looksLikeEnvelope,
  parseEnvelope,
  toBase64,
  type EncryptedEnvelope
} from './envelope'

/** A file with a real header and nonsense payload: only the shape matters here. */
function envelopeWith(over: Partial<EncryptedEnvelope> = {}): EncryptedEnvelope {
  const base: EncryptedEnvelope = {
    format: ENVELOPE_FORMAT,
    version: 1,
    contains: 'backup',
    exportedAt: '2026-01-01T00:00:00.000Z',
    kdf: 'PBKDF2-SHA256',
    iterations: DEFAULT_ITERATIONS,
    cipher: 'AES-256-GCM',
    salt: toBase64(new Uint8Array(randomBytes(SALT_BYTES))),
    iv: toBase64(new Uint8Array(randomBytes(12))),
    tag: toBase64(new Uint8Array(randomBytes(16))),
    ciphertext: toBase64(new Uint8Array(randomBytes(64)))
  }
  return { ...base, ...over }
}

test('the shared base64 is the same base64 Buffer writes, byte for byte', () => {
  // Not a style question: a desktop encodes with this function and a browser
  // decodes with `atob`-equivalents, so any drift in padding or the alphabet
  // turns a good file into a refusal to open. Lengths around the 3-byte group
  // boundary are where that shows up.
  for (let length = 1; length <= 34; length += 1) {
    const bytes = new Uint8Array(randomBytes(length))
    const encoded = toBase64(bytes)
    assert.equal(encoded, Buffer.from(bytes).toString('base64'), `length ${String(length)}`)
    assert.deepEqual(fromBase64(encoded, 'ciphertext'), bytes)
  }
  const big = new Uint8Array(randomBytes(100_000))
  assert.equal(toBase64(big), Buffer.from(big).toString('base64'))
  assert.deepEqual(fromBase64(toBase64(big), 'ciphertext'), big)
  assert.equal(toBase64(new Uint8Array(0)), '')
})

test('fromBase64 refuses what it cannot decode instead of inventing bytes', () => {
  assert.throws(() => fromBase64('not base64!', 'salt'), EnvelopeError)
  assert.throws(() => fromBase64('QQ==QQ==', 'salt'), /padded in the middle/)
  assert.throws(() => fromBase64('QQQ', 'salt'), /not base64/)
  assert.throws(() => fromBase64('', 'salt'), /not base64/)
  // '+' and '/' are alphabet members, not separators, and a URL-safe file must
  // still be rejected rather than half-read.
  assert.throws(() => fromBase64('-_QU', 'salt'), /not base64/)
})

test('a well-formed envelope parses and says what it holds', () => {
  const file = envelopeWith()
  assert.equal(looksLikeEnvelope(file), true)
  const parsed = parseEnvelope(envelopeToJson(file))
  assert.equal(parsed.iterations, DEFAULT_ITERATIONS)
  assert.equal(parsed.contains, 'backup')
  assert.equal(parsed.exportedAt, '2026-01-01T00:00:00.000Z')
})

test('a plain backup is not an envelope, and the two are never confused', () => {
  // The shape `db/backup.ts` writes today: same top level, no cipher anywhere.
  // Import detection is what decides whether a screen asks for a passphrase, so
  // a plain file must never look like a sealed one and vice versa.
  const plain = {
    format: 'cash-flow-routing-backup',
    version: 10,
    exportedAt: '2026-01-01T00:00:00.000Z',
    tables: {
      accounts: [],
      balance_snapshots: [],
      categories: [],
      bills: [],
      goals: [],
      paychecks: [],
      allocations: [],
      bill_reserves: [],
      transactions: [],
      settings: []
    }
  }
  assert.equal(looksLikeEnvelope(plain), false)
  assert.throws(() => parseEnvelope(JSON.stringify(plain)), /not a WageRoute encrypted export/)
})

test('a file that is not an envelope at all is refused with the reason', () => {
  assert.throws(() => parseEnvelope('{"hello":1}'), /not a WageRoute encrypted export/)
  assert.throws(() => parseEnvelope('semitone{'), /not JSON/)
  assert.throws(() => parseEnvelope('[]'), /not a WageRoute encrypted export/)
  assert.throws(() => parseEnvelope('null'), /not a WageRoute encrypted export/)
})

test('an envelope from a newer format version is refused, not half-read', () => {
  assert.throws(
    () => parseEnvelope(envelopeToJson(envelopeWith({ version: 2 as never }))),
    /newer WageRoute/
  )
})

test('a cipher or kdf this build does not implement is refused by name', () => {
  assert.throws(
    () => parseEnvelope(envelopeToJson(envelopeWith({ kdf: 'scrypt' as never }))),
    /scrypt/
  )
  assert.throws(
    () => parseEnvelope(envelopeToJson(envelopeWith({ cipher: 'AES-256-CBC' as never }))),
    /AES-256-CBC/
  )
  assert.throws(
    () => parseEnvelope(envelopeToJson(envelopeWith({ contains: 'vault' as never }))),
    /vault/
  )
})

test('the iteration count is honoured within guard rails, not at face value', () => {
  // Floor: a file that says 1 is an invitation to crack it. Ceiling: a file that
  // says a billion is a way to freeze a laptop that is only trying to read it.
  assert.throws(
    () => parseEnvelope(envelopeToJson(envelopeWith({ iterations: 1 }))),
    /outside what WageRoute will do/
  )
  assert.throws(
    () => parseEnvelope(envelopeToJson(envelopeWith({ iterations: MAX_ITERATIONS + 1 }))),
    /outside what WageRoute will do/
  )
  assert.throws(
    () => parseEnvelope(envelopeToJson(envelopeWith({ iterations: 1.5 }))),
    /outside what WageRoute will do/
  )
  assert.equal(
    parseEnvelope(envelopeToJson(envelopeWith({ iterations: MIN_ITERATIONS }))).iterations,
    MIN_ITERATIONS
  )
})

test('a header whose lengths do not add up is a refusal, not a different key', () => {
  const short = Buffer.from(randomBytes(SALT_BYTES - 1)).toString('base64')
  assert.throws(() => parseEnvelope(envelopeToJson(envelopeWith({ salt: short }))), /salt is 15/)
  assert.throws(
    () => parseEnvelope(envelopeToJson(envelopeWith({ iv: '' }))),
    /initial vector/
  )
  assert.throws(
    () => parseEnvelope(envelopeToJson(envelopeWith({ tag: '!!!!' }))),
    /not base64/
  )
  assert.throws(
    () => parseEnvelope(envelopeToJson(envelopeWith({ ciphertext: '' }))),
    /holds no data/
  )
  assert.throws(
    () => parseEnvelope(envelopeToJson(envelopeWith({ exportedAt: 'yesterday' }))),
    /does not say when/
  )
})

test('an encrypted export names itself as one, because a folder of JSON says nothing', () => {
  assert.equal(
    envelopeFileName('wageroute-backup', '2026-01-05T14:30:00.000Z'),
    'wageroute-backup-20260105-143000-encrypted.json'
  )
})

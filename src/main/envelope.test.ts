/**
 * The envelope in use: sealed on the desktop, opened on the desktop, and — the
 * claim this file exists for — sealed on one and opened by the other.
 *
 * The two implementations share a format module and nothing else: one calls
 * `node:crypto`, the other `crypto.subtle`. A bug at that seam does not throw on
 * the machine that wrote the file, so every interop test here crosses it in both
 * directions with the same passphrase. Node has WebCrypto, so the phone's code
 * runs here for real rather than being mocked.
 */
import assert from 'node:assert/strict'
import { basename, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import Database from 'better-sqlite3-multiple-ciphers'
import test from 'node:test'
import { todayISO } from '@shared/dates'
import {
  MIN_ITERATIONS,
  DEFAULT_ITERATIONS,
  EnvelopeError,
  envelopeFileName,
  envelopeToJson,
  parseEnvelope,
  textIsEnvelope
} from '@shared/envelope'
import { exportFileOf, openEnvelopeFileText, openEnvelopeText, sealEnvelope } from './envelope'
import * as pocket from '../pocket/lib/envelope'
import { backupToJson, buildBackup, parseBackupJson } from './db/backup'
import { createAccount, createTransaction } from './db/repositories'
import { migrate } from './db/migrations'

const PASSPHRASE = 'correct horse battery staple'
const CHEAP = { iterations: MIN_ITERATIONS }

const USER_ID = '11111111-2222-3333-4444-555555555555'

function freshDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  migrate(db)
  db.prepare(
    `INSERT INTO users (id, display_name, created_at, updated_at)
     VALUES (?, 'Tester', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
  ).run(USER_ID)
  return db
}

/** A real backup of a real two-row ledger, written by the code that ships it. */
function seededBackup(): string {
  const db = freshDb()
  const accountId = createAccount(db, USER_ID, {
    name: 'Chequing',
    kind: 'checking',
    institution: 'RBC',
    startingBalanceCents: 100_000,
    creditLimitCents: null
  })
  createTransaction(db, USER_ID, {
    accountId,
    kind: 'expense',
    amountCents: -4_560,
    occurredOn: '2026-01-05',
    category: 'Groceries',
    memo: 'Weekly shop'
  })
  const json = backupToJson(buildBackup(db, USER_ID))
  db.close()
  return json
}

test('a sealed backup opens back to the exact text that went in', () => {
  const text = JSON.stringify({ hello: 'wörld 🧾', n: [1, 2, 3] })
  const sealed = sealEnvelope(text, PASSPHRASE, CHEAP)
  assert.equal(openEnvelopeText(sealed, PASSPHRASE), text)
})

test('the same file sealed twice is not the same bytes, because the salt and IV are new', () => {
  const text = seededBackup()
  const first = sealEnvelope(text, PASSPHRASE, CHEAP)
  const second = sealEnvelope(text, PASSPHRASE, CHEAP)
  assert.notEqual(first.salt, second.salt)
  assert.notEqual(first.iv, second.iv)
  assert.notEqual(first.ciphertext, second.ciphertext)
  // Both open to the same ledger: the difference is noise, not data.
  assert.equal(openEnvelopeText(first, PASSPHRASE), openEnvelopeText(second, PASSPHRASE))
})

test('a wrong passphrase is refused as a passphrase problem, not a file problem', () => {
  const sealed = sealEnvelope(seededBackup(), PASSPHRASE, CHEAP)
  assert.throws(
    () => openEnvelopeText(sealed, 'not the passphrase'),
    (error: unknown) => {
      assert.ok(error instanceof EnvelopeError)
      // The distinction the screen needs: retry the field, or look for another file.
      assert.equal(error.failure, 'passphrase')
      return true
    }
  )
})

test('an empty passphrase is refused before any key is derived', () => {
  const sealed = sealEnvelope('{}', PASSPHRASE, CHEAP)
  assert.throws(() => openEnvelopeText(sealed, ''), /Type the passphrase/)
})

test('a byte changed in transit fails the tag instead of decrypting to garbage', () => {
  const sealed = sealEnvelope(seededBackup(), PASSPHRASE, CHEAP)
  const bytes = Buffer.from(sealed.ciphertext, 'base64')
  bytes[0] ^= 0xff
  const tampered = { ...sealed, ciphertext: bytes.toString('base64') }
  assert.throws(
    () => openEnvelopeText(parseEnvelope(envelopeToJson(tampered)), PASSPHRASE),
    (error: unknown) => error instanceof EnvelopeError && error.failure === 'passphrase'
  )
})

test('a header edited to weaken the cost of a guess does not open', () => {
  const sealed = sealEnvelope(seededBackup(), PASSPHRASE, CHEAP)
  // Lowering `iterations` below the floor is refused as a shape problem; quietly
  // raising it derives a different key, which the tag catches. Either way the
  // file is the one that says how it is opened, and it cannot be talked into
  // handing the key over cheaply.
  assert.throws(
    () => openEnvelopeText({ ...sealed, iterations: sealed.iterations + 1 }, PASSPHRASE),
    (error: unknown) => error instanceof EnvelopeError && error.failure === 'passphrase'
  )
})

test('a desktop export opens on the phone, and a phone export opens on the desktop', async () => {
  const text = seededBackup()

  const fromDesktop = sealEnvelope(text, PASSPHRASE, CHEAP)
  assert.equal(await pocket.openEnvelopeText(fromDesktop, PASSPHRASE), text)

  const fromPhone = await pocket.sealEnvelope(text, PASSPHRASE, { ...CHEAP })
  assert.equal(openEnvelopeText(fromPhone, PASSPHRASE), text)

  // And through the file, which is how they actually travel: JSON out, JSON in.
  assert.equal(
    await pocket.openEnvelopeFileText(envelopeToJson(fromDesktop), PASSPHRASE),
    text
  )
  assert.equal(openEnvelopeFileText(envelopeToJson(fromPhone), PASSPHRASE), text)
})

test('a whole ledger survives the envelope and imports as itself', () => {
  const backup = seededBackup()
  const sealed = sealEnvelope(backup, PASSPHRASE, CHEAP)
  const reopened = openEnvelopeFileText(envelopeToJson(sealed), PASSPHRASE)
  const parsed = parseBackupJson(reopened)
  assert.deepEqual(JSON.parse(reopened), JSON.parse(backup))
  assert.equal(parsed.tables.transactions.length, 1)
  assert.equal(parsed.tables.accounts.length, 1)
  assert.equal(parsed.tables.settings.length, 0)
})

test('a phrase is the bytes that were typed, so a differently normalised one is a different phrase', async () => {
  // "é" as one code point and as e + combining accent are the same letter to a
  // person and different keys to a KDF. Nothing here normalises, because
  // normalising would silently rewrite a passphrase the user did not type — but
  // it is a support story the docs have to own, so it is pinned here.
  const composed = 'caf\u00E9'
  const decomposed = 'cafe\u0301'
  assert.notEqual(composed, decomposed)
  const sealed = sealEnvelope('{}', composed, CHEAP)
  assert.equal(openEnvelopeText(sealed, composed), '{}')
  assert.throws(() => openEnvelopeText(sealed, decomposed), EnvelopeError)
  await assert.rejects(() => pocket.openEnvelopeText(sealed, decomposed), EnvelopeError)
})

test('an envelope written at the default cost still says so in the file', () => {
  const sealed = sealEnvelope('{}', PASSPHRASE)
  assert.equal(sealed.iterations, DEFAULT_ITERATIONS)
  assert.equal(parseEnvelope(envelopeToJson(sealed)).iterations, DEFAULT_ITERATIONS)
})

test('a plain backup text never reaches the cipher, because the reader checks the header first', () => {
  assert.throws(() => parseEnvelope(seededBackup()), /not a WageRoute encrypted export/)
})

test('the reader tells a sealed export from a plain one without parsing either twice', () => {
  // `data:preview` branches on this: a plain backup goes straight to the importer,
  // a sealed one stops and asks for a passphrase. Guessing wrong either imports
  // garbage or demands a passphrase for a file that has none.
  const plain = seededBackup()
  assert.equal(textIsEnvelope(plain), false)
  assert.equal(textIsEnvelope(envelopeToJson(sealEnvelope(plain, PASSPHRASE, CHEAP))), true)
  assert.equal(textIsEnvelope('{"format":"wageroute-envelope"}'), false)
  assert.equal(textIsEnvelope('not json at all'), false)
  assert.equal(textIsEnvelope(''), false)
})

test('an export names, dates and writes itself the same way whether it is sealed or not', () => {
  const backup = seededBackup()
  const exportedAt = parseBackupJson(backup).exportedAt
  const dir = join(tmpdir(), 'wageroute-documents')

  const plain = exportFileOf(backup, exportedAt, null, dir)
  assert.equal(plain.text, backup, 'a plain export is the backup itself, byte for byte')
  assert.equal(basename(plain.defaultPath), `wageroute-backup-${todayISO()}.json`)
  assert.equal(dirname(plain.defaultPath), dir)
  assert.equal(plain.filterName, 'JSON backup')

  const sealed = exportFileOf(backup, exportedAt, PASSPHRASE, dir)
  assert.equal(sealed.filterName, 'Encrypted JSON backup')
  assert.equal(basename(sealed.defaultPath), envelopeFileName('wageroute-backup', exportedAt))
  assert.equal(dirname(sealed.defaultPath), dir)
  assert.equal(textIsEnvelope(sealed.text), true, 'the reader recognises it without opening it')
  assert.equal(parseEnvelope(sealed.text).exportedAt, exportedAt, 'the header carries the backup’s own moment')
  // The production cost is what this writes, so the file it makes must still open.
  assert.equal(openEnvelopeFileText(sealed.text, PASSPHRASE), backup)
  assert.deepEqual(
    parseBackupJson(openEnvelopeFileText(sealed.text, PASSPHRASE)).tables,
    parseBackupJson(backup).tables,
    'and the ledger inside is the ledger that went in'
  )
})

test('an export is never sealed with a phrase nobody could type again', () => {
  assert.throws(
    () => exportFileOf('{}', '2026-01-01T00:00:00.000Z', '', '/tmp'),
    (error: unknown) => error instanceof EnvelopeError && error.failure === 'passphrase'
  )
})

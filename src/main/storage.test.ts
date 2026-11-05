import assert from 'node:assert/strict'
import test from 'node:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir, hostname } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3-multiple-ciphers'
import { RepositoryError } from '@shared/errors'
import { DB_FILE } from './db/legacy'
import { encryptLedger, ledgerLooksEncrypted, openLedger } from './db/encryption'
import {
  KEY_FILE,
  LEDGER_CIPHER,
  generateDataKey,
  readKeyFile,
  writeKeyFile
} from './db/ledger-key'
import { unlockLedger } from './db/unlock'
import { migrate } from './db/migrations'
import {
  acquireDataLock,
  backupFileAside,
  copyKeyFile,
  copyLedgerInto,
  copyLedgerToBackups,
  DATA_LOCK_FILE,
  DataLockedError,
  describeStorageCandidate,
  inspectLedger,
  isLockActive,
  planStorageMove,
  releaseDataLock,
  resolveDataDirectory,
  StorageUnavailableError,
  storagePointerPath,
  writeStoragePointer
} from './storage'

const NOW = '2026-01-01T00:00:00.000Z'

function workspace(): { root: string; userData: string } {
  const root = mkdtempSync(join(tmpdir(), 'wageroute-storage-'))
  const userData = join(root, 'userData')
  mkdirSync(userData, { recursive: true })
  return { root, userData }
}

function ledgerAt(directory: string, version = 10): Database.Database {
  mkdirSync(directory, { recursive: true })
  const db = new Database(join(directory, DB_FILE))
  db.exec('CREATE TABLE IF NOT EXISTS probe (value TEXT NOT NULL)')
  db.prepare('INSERT INTO probe VALUES (?)').run('kept')
  db.pragma(`user_version = ${version}`)
  return db
}

test.afterEach(() => releaseDataLock())

test('the per-user folder is the default until a pointer names another one', () => {
  const { root, userData } = workspace()
  assert.deepEqual(resolveDataDirectory(userData), {
    directory: userData,
    isDefault: true,
    pointerPath: storagePointerPath(userData)
  })

  const external = join(root, 'external')
  mkdirSync(external)
  writeStoragePointer(userData, external)
  assert.equal(resolveDataDirectory(userData).directory, external)
  assert.equal(resolveDataDirectory(userData).isDefault, false)

  writeStoragePointer(userData, null)
  assert.equal(resolveDataDirectory(userData).isDefault, true)
  assert.equal(existsSync(storagePointerPath(userData)), false)
})

test('a pointer to a folder that is gone stops the app instead of forking data', () => {
  const { root, userData } = workspace()
  writeStoragePointer(userData, join(root, 'unplugged-drive'))
  assert.throws(() => resolveDataDirectory(userData), StorageUnavailableError)
})

test('an unreadable pointer file is reported, not silently ignored', () => {
  const { userData } = workspace()
  writeFileSync(storagePointerPath(userData), '{not json')
  assert.throws(() => resolveDataDirectory(userData), StorageUnavailableError)
})

test('a second writer on the same folder is refused', () => {
  const { userData } = workspace()
  writeFileSync(
    join(userData, DATA_LOCK_FILE),
    JSON.stringify({
      token: 'other-writer',
      pid: process.pid,
      hostname: hostname(),
      startedAt: new Date().toISOString()
    })
  )
  assert.throws(() => acquireDataLock(userData), DataLockedError)
  rmSync(join(userData, DATA_LOCK_FILE))
  acquireDataLock(userData)
  releaseDataLock()
})

test('a lock left by a dead local process is taken over', () => {
  const { userData } = workspace()
  writeFileSync(
    join(userData, DATA_LOCK_FILE),
    JSON.stringify({
      token: 'dead',
      pid: 999_999,
      hostname: hostname(),
      startedAt: '2026-01-01T00:00:00.000Z'
    })
  )
  acquireDataLock(userData)
  const lock = JSON.parse(readFileSync(join(userData, DATA_LOCK_FILE), 'utf8')) as {
    pid: number
  }
  assert.equal(lock.pid, process.pid)
  releaseDataLock()
})

test('an abandoned lock from another computer expires instead of blocking forever', () => {
  const { userData } = workspace()
  const path = join(userData, DATA_LOCK_FILE)
  writeFileSync(
    path,
    JSON.stringify({
      token: 'old',
      pid: 1,
      hostname: 'some-other-machine',
      startedAt: '2026-01-01T00:00:00.000Z'
    })
  )
  const longAgo = new Date(Date.now() - 10 * 60_000)
  utimesSync(path, longAgo, longAgo)

  assert.equal(
    isLockActive({ info: JSON.parse(readFileSync(path, 'utf8')), mtimeMs: longAgo.getTime() }),
    false
  )
  acquireDataLock(userData)
  releaseDataLock()
})

test('inspection reads the schema version without migrating anything', () => {
  const { root } = workspace()
  const directory = join(root, 'shared')
  const db = ledgerAt(directory, 9)
  db.close()
  assert.deepEqual(inspectLedger(directory), { hasLedger: true, schemaVersion: 9 })
  assert.deepEqual(inspectLedger(join(root, 'empty')), { hasLedger: false, schemaVersion: null })
})

test('a move needs an empty folder; adopting needs a ledger', () => {
  const { root, userData } = workspace()
  const empty = join(root, 'empty')
  mkdirSync(empty)
  assert.equal(planStorageMove(userData, empty, 'move').mode, 'move')
  assert.equal(planStorageMove(userData, empty, 'fresh').mode, 'fresh')
  assert.throws(() => planStorageMove(userData, empty, 'adopt'), RepositoryError)

  const taken = join(root, 'taken')
  ledgerAt(taken).close()
  assert.throws(() => planStorageMove(userData, taken, 'move'), RepositoryError)
  assert.equal(planStorageMove(userData, taken, 'adopt').inspection.schemaVersion, 10)
})

test('a ledger from a newer build is refused rather than downgraded', () => {
  const { root, userData } = workspace()
  const newer = join(root, 'newer')
  ledgerAt(newer, 99).close()
  assert.throws(
    () => planStorageMove(userData, newer, 'adopt'),
    (error: unknown) => error instanceof RepositoryError && error.code === 'CONFLICT'
  )
})

test('the folder in use cannot be chosen again', () => {
  const { userData } = workspace()
  assert.throws(
    () => planStorageMove(userData, userData, 'move'),
    (error: unknown) => error instanceof RepositoryError && error.code === 'VALIDATION'
  )
})

test('a candidate says whether it is locked or holds a ledger', () => {
  const { root } = workspace()
  const directory = join(root, 'candidate')
  mkdirSync(directory)
  assert.deepEqual(describeStorageCandidate(directory), {
    directory,
    hasLedger: false,
    schemaVersion: null,
    locked: false,
    lockedBy: null
  })
  acquireDataLock(directory)
  const locked = describeStorageCandidate(directory)
  assert.equal(locked.locked, true)
  assert.match(locked.lockedBy ?? '', /since/)
  releaseDataLock()
})

test('a move copies the ledger, leaves the source, and keeps a safety copy', async () => {
  const { root, userData } = workspace()
  const source = ledgerAt(userData)
  const target = join(root, 'nas')
  mkdirSync(target)

  const safety = await copyLedgerToBackups(source, userData)
  assert.equal(existsSync(safety), true)
  assert.match(safety, /pre-move-/)

  const copied = await copyLedgerInto(source, target, null)
  source.close()
  assert.equal(copied, join(target, DB_FILE))

  const opened = new Database(join(target, DB_FILE), { readonly: true })
  assert.equal(opened.pragma('user_version', { simple: true }), 10)
  assert.equal((opened.prepare('SELECT value FROM probe').get() as { value: string }).value, 'kept')
  opened.close()
  assert.equal(existsSync(join(userData, DB_FILE)), true)
})

test('returning home keeps the local ledger aside before overwriting it', () => {
  const { userData } = workspace()
  const local = ledgerAt(userData)
  local.close()

  const aside = backupFileAside(join(userData, DB_FILE), userData, 'pre-return')
  assert.ok(aside)
  assert.match(aside, /pre-return-/)
  assert.equal(existsSync(aside), true)
  assert.equal(backupFileAside(join(userData, 'missing.db'), userData, 'pre-return'), null)
})

test('a copy that fails leaves no half-written ledger behind', async () => {
  const { root, userData } = workspace()
  const source = ledgerAt(userData)
  const missingTarget = join(root, 'not-there')
  await assert.rejects(() => copyLedgerInto(source, missingTarget, null))
  source.close()
  assert.equal(existsSync(join(missingTarget, DB_FILE)), false)
})

test('a copied ledger never inherits the old sidecars', async () => {
  const { root, userData } = workspace()
  const source = ledgerAt(userData)
  const target = join(root, 'shared')
  mkdirSync(target)
  writeFileSync(join(target, `${DB_FILE}-wal`), 'stale')
  writeFileSync(join(target, `${DB_FILE}-shm`), 'stale')

  await copyLedgerInto(source, target, null)
  source.close()
  assert.equal(existsSync(join(target, `${DB_FILE}-wal`)), false)
  assert.equal(existsSync(join(target, `${DB_FILE}-shm`)), false)
  rmSync(join(target), { recursive: true, force: true })
})

/**
 * The move is the one place a key file has to travel. A ledger and its marker
 * are two halves of one thing, and `copyLedgerInto` can only carry the first:
 * the bytes it writes are ciphertext, and the only copy of the key is the file
 * beside the ledger being left behind. These two tests are that hazard, and the
 * rule that keeps a plaintext folder from growing a key it never had.
 */
test('a move of an encrypted ledger leaves a brick until the key file follows it', async () => {
  const { root, userData } = workspace()
  const ledgerFile = join(userData, DB_FILE)
  const db = new Database(ledgerFile)
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
     VALUES ('t1', 'u1', 'a1', 'expense', 1234, '2026-01-05', ?, ?)`
  ).run(NOW, NOW)
  db.close()

  const dataKey = generateDataKey()
  writeKeyFile(userData, {
    version: 1,
    cipher: LEDGER_CIPHER,
    device: { sealed: dataKey.toString('base64') },
    createdAt: NOW
  })
  encryptLedger({ dataDirectory: userData, ledgerFile, dataKey })
  assert.equal(ledgerLooksEncrypted(ledgerFile), true)

  const target = join(root, 'nas')
  mkdirSync(target)
  const source = openLedger(ledgerFile, dataKey)
  try {
    await copyLedgerInto(source, target, dataKey)
  } finally {
    source.close()
  }

  // Copied as ciphertext, and the key that opens it is not in the new folder.
  assert.equal(ledgerLooksEncrypted(join(target, DB_FILE)), true)
  assert.equal(existsSync(join(target, KEY_FILE)), false)
  const bare = openLedger(join(target, DB_FILE), null)
  try {
    assert.throws(() => bare.prepare('SELECT count(*) FROM transactions').get(), /not a database/i)
  } finally {
    bare.close()
  }

  copyKeyFile(userData, target)
  const unlocked = await unlockLedger(target, {
    device: { available: () => true, open: (wrap) => Buffer.from(wrap.sealed, 'base64') }
  })
  assert.ok(unlocked)
  const moved = openLedger(join(target, DB_FILE), unlocked.dataKey)
  try {
    const row = moved
      .prepare('SELECT sum(amount_cents) AS cents FROM transactions')
      .get() as { cents: number }
    assert.equal(row.cents, 1234)
  } finally {
    moved.close()
  }
  // Both folders keep a way in: the old one is still a readable ledger, which is
  // what makes the move undoable.
  assert.notEqual(readKeyFile(userData), null)
  const stillThere = openLedger(ledgerFile, unlocked.dataKey)
  try {
    const row = stillThere
      .prepare('SELECT sum(amount_cents) AS cents FROM transactions')
      .get() as { cents: number }
    assert.equal(row.cents, 1234)
  } finally {
    stillThere.close()
  }
})

test('a move of a plaintext ledger invents no key file anywhere', () => {
  const { root, userData } = workspace()
  const target = join(root, 'nas')
  mkdirSync(target)
  ledgerAt(userData).close()

  copyKeyFile(userData, target)
  assert.equal(existsSync(join(target, KEY_FILE)), false)
  assert.equal(readKeyFile(target), null)
})

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, truncateSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import test from 'node:test'
import { DB_FILE, adoptLegacyDatabase } from './legacy'

const LEGACY_DIR = 'Cash Flow Routing'
const LEGACY_DB_FILE = 'cash-flow-routing.db'

function workspace(): { root: string; appData: string; userData: string; legacy: string } {
  const root = mkdtempSync(join(tmpdir(), 'wageroute-legacy-'))
  const appData = join(root, 'appData')
  const userData = join(root, 'userData')
  const legacy = join(appData, LEGACY_DIR)
  mkdirSync(legacy, { recursive: true })
  mkdirSync(userData, { recursive: true })
  return { root, appData, userData, legacy: join(legacy, LEGACY_DB_FILE) }
}

function writeDatabase(path: string, rows = 3): void {
  const db = new Database(path)
  try {
    db.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL)')
    const insert = db.prepare('INSERT INTO notes (body) VALUES (?)')
    for (let index = 0; index < rows; index += 1) insert.run(`note ${index}`)
  } finally {
    db.close()
  }
}

function countRows(path: string): number {
  const db = new Database(path, { readonly: true })
  try {
    return (db.prepare('SELECT COUNT(*) AS total FROM notes').get() as { total: number }).total
  } finally {
    db.close()
  }
}

test('a legacy database is copied, checked and left where it was', () => {
  const { root, appData, userData, legacy } = workspace()
  try {
    writeDatabase(legacy)

    const result = adoptLegacyDatabase(appData, userData)

    assert.deepEqual(result, { adopted: true })
    assert.equal(existsSync(legacy), true, 'the original must survive the move')
    assert.equal(existsSync(join(userData, DB_FILE)), true)
    assert.equal(countRows(join(userData, DB_FILE)), 3)
    assert.equal(existsSync(join(userData, `${DB_FILE}.adopting`)), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a live database is never replaced by an older one', () => {
  const { root, appData, userData, legacy } = workspace()
  try {
    writeDatabase(legacy, 8)
    const live = join(userData, DB_FILE)
    writeDatabase(live, 1)
    const before = readFileSync(live)

    assert.deepEqual(adoptLegacyDatabase(appData, userData), { adopted: false })
    assert.deepEqual(readFileSync(live), before)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('nothing happens when the app has never had a legacy database', () => {
  const { root, appData, userData } = workspace()
  try {
    assert.deepEqual(adoptLegacyDatabase(appData, userData), { adopted: false })
    assert.equal(existsSync(join(userData, DB_FILE)), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a file that is not SQLite is refused and the old folder is untouched', () => {
  const { root, appData, userData, legacy } = workspace()
  try {
    writeFileSync(legacy, 'this is not a database')

    const result = adoptLegacyDatabase(appData, userData)

    assert.equal(result.adopted, false)
    assert.match(result.error ?? '', /not a readable SQLite file/)
    assert.equal(existsSync(join(userData, DB_FILE)), false)
    assert.equal(readFileSync(legacy, 'utf8'), 'this is not a database')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a truncated database fails the integrity check and leaves no live file', () => {
  const { root, appData, userData, legacy } = workspace()
  try {
    writeDatabase(legacy, 40)
    // Keep the 16-byte header so the cheap check passes, then cut the pages off.
    truncateSync(legacy, 16)

    const result = adoptLegacyDatabase(appData, userData)

    assert.equal(result.adopted, false)
    assert.ok(result.error)
    assert.equal(existsSync(join(userData, DB_FILE)), false)
    assert.equal(existsSync(join(userData, `${DB_FILE}.adopting`)), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a leftover staging file from an interrupted launch is cleaned up', () => {
  const { root, appData, userData, legacy } = workspace()
  try {
    writeDatabase(legacy, 2)
    writeFileSync(join(userData, `${DB_FILE}.adopting`), 'half a copy')

    const result = adoptLegacyDatabase(appData, userData)

    assert.deepEqual(result, { adopted: true })
    assert.equal(countRows(join(userData, DB_FILE)), 2)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

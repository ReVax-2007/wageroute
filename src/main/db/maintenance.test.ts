import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { assertHealthy, backupBeforeUpgrade, compact, DatabaseCorruptError } from './maintenance'
import { migrate } from './migrations'

function workspace(): string {
  return mkdtempSync(join(tmpdir(), 'wageroute-maintenance-'))
}

function seeded(file: string): Database.Database {
  const db = new Database(file)
  db.pragma('journal_mode = WAL')
  db.pragma('secure_delete = ON')
  migrate(db)
  db.prepare(
    `INSERT INTO users (id, display_name, created_at, updated_at)
     VALUES ('u1', 'Tester', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
  ).run()
  db.prepare(
    `INSERT INTO accounts (id, user_id, name, kind, created_at, updated_at)
     VALUES ('a1', 'u1', 'Chequing', 'checking', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
  ).run()
  return db
}

test('a healthy ledger passes its integrity check', () => {
  const dir = workspace()
  const db = seeded(join(dir, 'ledger.db'))
  assert.doesNotThrow(() => assertHealthy(db))
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

test('a file that is not a database fails the check instead of opening', () => {
  const dir = workspace()
  const file = join(dir, 'not-a-ledger.db')
  writeFileSync(file, 'this is not a database')
  const db = new Database(file)
  assert.throws(() => assertHealthy(db), DatabaseCorruptError)
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

test('an upgrade copy carries every row and keeps only the newest three', () => {
  const dir = workspace()
  const backups = join(dir, 'backups')
  const db = seeded(join(dir, 'ledger.db'))

  const first = backupBeforeUpgrade(db, backups, 6, 7, new Date('2026-10-01T10:00:00Z'))
  assert.ok(existsSync(first))
  const copy = new Database(first, { readonly: true })
  const counted = copy.prepare('SELECT COUNT(*) AS n FROM accounts').get() as { n: number }
  assert.equal(counted.n, 1)
  copy.close()

  for (let day = 2; day <= 5; day += 1) {
    backupBeforeUpgrade(db, backups, 6, 7, new Date(`2026-10-0${day}T10:00:00Z`))
  }
  const kept = readdirSync(backups).sort()
  assert.equal(kept.length, 3)
  assert.equal(kept[2], 'pre-upgrade-6-to-7-20261005-100000.db')

  db.close()
  rmSync(dir, { recursive: true, force: true })
})

test('compacting an erased ledger leaves nothing to read back', () => {
  const dir = workspace()
  const file = join(dir, 'ledger.db')
  const db = seeded(file)
  db.prepare(
    `INSERT INTO transactions
       (id, user_id, account_id, kind, amount_cents, occurred_on, memo, category,
        created_at, updated_at, revision)
     VALUES ('t1', 'u1', 'a1', 'expense', -4200, '2026-03-01',
             'SENTINEL-SECRETMEMO-42', 'Misc', '2026-03-01T00:00:00.000Z',
             '2026-03-01T00:00:00.000Z', 1)`
  ).run()

  db.prepare('DELETE FROM transactions').run()
  compact(db)
  db.close()

  const raw = readFileSync(file).toString('utf8')
  assert.ok(!raw.includes('SENTINEL-SECRETMEMO-42'), 'the erased memo is not in the file')
  rmSync(dir, { recursive: true, force: true })
})

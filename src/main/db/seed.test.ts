import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import test from 'node:test'
import { DEFAULT_CATEGORIES } from '@shared/categories'
import { DEFAULT_SETTINGS } from '@shared/settings'
import { migrate } from './migrations'
import { seedDemoIfEmpty, seedIfEmpty } from './seed'

function freshDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  migrate(db)
  return db
}

function count(db: Database.Database, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get() as { total: number }).total
}

test('a fresh install gets one unnamed user, the default settings and the starter categories', () => {
  const db = freshDb()
  const userId = seedIfEmpty(db)

  assert.equal(count(db, 'users'), 1, 'one local user, never a demo profile')
  const user = db.prepare('SELECT display_name FROM users WHERE id = ?').get(userId) as {
    display_name: string
  }
  assert.equal(user.display_name, '', 'packaged builds ask for a name instead of inventing one')

  const settings = db
    .prepare('SELECT key, value FROM settings WHERE user_id = ?')
    .all(userId) as { key: string; value: string }[]
  assert.equal(settings.length, Object.keys(DEFAULT_SETTINGS).length)
  assert.equal(
    new Set(settings.map((row) => row.key)).size,
    settings.length,
    'every key is written once'
  )
  assert.equal(settings.find((row) => row.key === 'theme')?.value, 'dark')

  assert.equal(count(db, 'categories'), DEFAULT_CATEGORIES.length)
  assert.equal(count(db, 'accounts'), 0, 'a blank start has no accounts to explain away')
  assert.equal(count(db, 'bills'), 0)
  assert.equal(count(db, 'transactions'), 0)
})

test('seeding twice keeps the first user and adds nothing', () => {
  const db = freshDb()
  const first = seedIfEmpty(db)
  const second = seedIfEmpty(db)

  assert.equal(second, first)
  assert.equal(count(db, 'users'), 1)
  assert.equal(count(db, 'categories'), DEFAULT_CATEGORIES.length)
})

test('the demo profile is linked, not a pile of rows', () => {
  const db = freshDb()
  const userId = seedDemoIfEmpty(db)

  assert.equal(count(db, 'users'), 1)
  const user = db.prepare('SELECT display_name FROM users WHERE id = ?').get(userId) as {
    display_name: string
  }
  assert.equal(user.display_name, 'Alex')
  assert.equal(count(db, 'accounts'), 5)
  assert.equal(count(db, 'bills'), 6)
  assert.equal(count(db, 'goals'), 3)
  assert.equal(count(db, 'categories'), DEFAULT_CATEGORIES.length)
  assert.equal(
    (db.prepare('SELECT COUNT(*) AS total FROM settings WHERE user_id = ?').get(userId) as {
      total: number
    }).total,
    Object.keys(DEFAULT_SETTINGS).length
  )

  // Every transfer is written as a pair, so a balance move has two sides.
  const groups = db
    .prepare(
      `SELECT transfer_group_id AS id, COUNT(*) AS legs, SUM(amount_cents) AS total
         FROM transactions
        WHERE transfer_group_id IS NOT NULL
        GROUP BY transfer_group_id`
    )
    .all() as { id: string; legs: number; total: number }[]
  assert.ok(groups.length > 0, 'the demo moves money between accounts')
  for (const group of groups) {
    assert.equal(group.legs, 2, `${group.id} carries both legs`)
    assert.equal(group.total, 0, `${group.id} moves money rather than creating it`)
  }

  assert.equal(
    (db.prepare('SELECT COUNT(*) AS total FROM transactions WHERE transfer_group_id IS NULL').get() as {
      total: number
    }).total,
    count(db, 'transactions') - groups.length * 2,
    'no stray leg sits outside a group'
  )
})

test('seeding the demo twice keeps the first profile', () => {
  const db = freshDb()
  const first = seedDemoIfEmpty(db)
  const rows = count(db, 'transactions')
  const second = seedDemoIfEmpty(db)

  assert.equal(second, first)
  assert.equal(count(db, 'accounts'), 5)
  assert.equal(count(db, 'transactions'), rows)
})

import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import test from 'node:test'
import { migrate } from './migrations'
import { getUser, setDisplayName } from './repo/users'
import { seedIfEmpty } from './seed'

function seeded(): { db: Database.Database; userId: string } {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  migrate(db)
  return { db, userId: seedIfEmpty(db) }
}

test('setting a name trims it and the greeting reads it back', () => {
  const { db, userId } = seeded()
  assert.equal(setDisplayName(db, userId, '  Xavier  '), 'Xavier')
  assert.equal(getUser(db, userId).displayName, 'Xavier')
  db.close()
})

test('an empty name is a real answer and clears the greeting', () => {
  const { db, userId } = seeded()
  setDisplayName(db, userId, 'Xavier')
  assert.equal(setDisplayName(db, userId, '   '), '')
  assert.equal(getUser(db, userId).displayName, '')
  db.close()
})

test('a name longer than sixty characters is refused', () => {
  const { db, userId } = seeded()
  assert.throws(() => setDisplayName(db, userId, 'x'.repeat(61)), /too long/)
  assert.equal(getUser(db, userId).displayName, '')
  db.close()
})

test('a name with a line break is refused so the greeting stays on one line', () => {
  const { db, userId } = seeded()
  assert.throws(() => setDisplayName(db, userId, 'Xavier\nVoet'), /line breaks/)
  assert.throws(() => setDisplayName(db, userId, 'Xavier\tVoet'), /line breaks/)
  db.close()
})

test('a non-string name is refused rather than coerced', () => {
  const { db, userId } = seeded()
  assert.throws(() => setDisplayName(db, userId, 42), /must be text/)
  assert.throws(() => setDisplayName(db, userId, null), /must be text/)
  db.close()
})

test('renaming a missing user is a not-found rather than a silent no-op', () => {
  const { db } = seeded()
  assert.throws(() => setDisplayName(db, 'nobody', 'Xavier'), /missing/)
  db.close()
})

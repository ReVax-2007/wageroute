import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import test from 'node:test'
import { mergeBackup, type BackupPayload } from '../main/db/backup'
import { migrate, SCHEMA_VERSION } from '../main/db/migrations'

const USER_ID = '11111111-2222-3333-4444-555555555555'

function freshDb(): Database.Database {
  const db = new Database(':memory:')
  migrate(db)
  db.prepare(
    `INSERT INTO users (id, display_name, created_at, updated_at)
     VALUES (?, 'Tester', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
  ).run(USER_ID)
  return db
}

function payload(tables: Partial<BackupPayload['tables']>): BackupPayload {
  return {
    format: 'cash-flow-routing-backup',
    version: SCHEMA_VERSION,
    exportedAt: '2026-01-01T00:00:00.000Z',
    tables: {
      accounts: [],
      bills: [],
      goals: [],
      paychecks: [],
      allocations: [],
      transactions: [],
      settings: [],
      ...tables
    }
  }
}

test('rows missing schema-defaulted columns import with the column default, not NULL', () => {
  const db = freshDb()
  const result = mergeBackup(
    db,
    USER_ID,
    payload({
      accounts: [
        {
          id: 'acc-1',
          user_id: USER_ID,
          name: 'Checking',
          kind: 'checking',
          created_at: '2026-02-01T00:00:00.000Z',
          updated_at: '2026-02-01T00:00:00.000Z'
        }
      ],
      bills: [
        {
          id: 'bill-1',
          user_id: USER_ID,
          name: 'Rent',
          amount_cents: 120000,
          frequency: 'monthly',
          due_day: 1,
          account_id: 'acc-1',
          next_due_on: '2026-03-01',
          created_at: '2026-02-01T00:00:00.000Z',
          updated_at: '2026-02-01T00:00:00.000Z'
        }
      ],
      goals: [
        {
          id: 'goal-1',
          user_id: USER_ID,
          name: 'Emergency fund',
          target_cents: 60000,
          created_at: '2026-02-01T00:00:00.000Z',
          updated_at: '2026-02-01T00:00:00.000Z'
        }
      ],
      paychecks: [
        {
          id: 'pay-1',
          user_id: USER_ID,
          amount_cents: 250000,
          received_on: '2026-02-15',
          health: 'covered',
          deposit_account_id: 'acc-1',
          created_at: '2026-02-15T00:00:00.000Z',
          updated_at: '2026-02-15T00:00:00.000Z'
        }
      ],
      transactions: [
        {
          id: 'txn-1',
          user_id: USER_ID,
          account_id: 'acc-1',
          kind: 'expense',
          amount_cents: 4500,
          occurred_on: '2026-02-16',
          created_at: '2026-02-16T00:00:00.000Z',
          updated_at: '2026-02-16T00:00:00.000Z'
        }
      ]
    })
  )

  assert.equal(result.added.accounts, 1)
  assert.equal(result.added.bills, 1)
  assert.equal(result.added.goals, 1)
  assert.equal(result.added.paychecks, 1)
  assert.equal(result.added.transactions, 1)

  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get('acc-1') as Record<string, unknown>
  assert.equal(account.sort_order, 0)
  assert.equal(account.is_archived, 0)
  assert.equal(account.starting_balance_cents, 0)
  assert.equal(account.credit_limit_cents, null)
  assert.equal(account.revision, 1)

  const bill = db.prepare('SELECT * FROM bills WHERE id = ?').get('bill-1') as Record<string, unknown>
  assert.equal(bill.category, 'Bills')
  assert.equal(bill.autopay, 0)
  assert.equal(bill.is_active, 1)

  const goal = db.prepare('SELECT * FROM goals WHERE id = ?').get('goal-1') as Record<string, unknown>
  assert.equal(goal.priority, 100)
  assert.equal(goal.color, '#34D399')
  assert.equal(goal.is_emergency, 0)

  const paycheck = db.prepare('SELECT * FROM paychecks WHERE id = ?').get('pay-1') as Record<string, unknown>
  assert.equal(paycheck.source, 'Paycheck')
  assert.equal(paycheck.priority_cents, 0)
  assert.equal(paycheck.surplus_cents, 0)
  assert.equal(paycheck.leisure_cents, 0)

  const txn = db.prepare('SELECT * FROM transactions WHERE id = ?').get('txn-1') as Record<string, unknown>
  assert.equal(txn.memo, '')
  assert.equal(txn.category, 'Uncategorized')
  assert.equal(txn.transfer_group_id, null)
})

test('rows that already carry values keep them; timestamps still fill in when missing', () => {
  const db = freshDb()
  mergeBackup(
    db,
    USER_ID,
    payload({
      accounts: [
        {
          id: 'acc-2',
          user_id: USER_ID,
          name: 'Savings',
          kind: 'savings',
          sort_order: 7,
          is_archived: 1,
          created_at: '2026-02-01T00:00:00.000Z'
        }
      ]
    })
  )

  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get('acc-2') as Record<string, unknown>
  assert.equal(account.sort_order, 7)
  assert.equal(account.is_archived, 1)
  assert.equal(typeof account.updated_at, 'string')
  assert.ok((account.updated_at as string).length > 0)

  const again = mergeBackup(
    db,
    USER_ID,
    payload({
      accounts: [
        {
          id: 'acc-2',
          user_id: USER_ID,
          name: 'Savings',
          kind: 'savings',
          created_at: '2026-02-01T00:00:00.000Z',
          updated_at: '2026-02-01T00:00:00.000Z'
        }
      ]
    })
  )
  assert.equal(again.skipped.accounts, 1)
  assert.equal(again.added.accounts, 0)
  assert.equal(account.sort_order, 7)
})

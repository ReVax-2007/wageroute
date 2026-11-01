import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { parseBackupJson } from '../main/db/backup'
import { SCHEMA_VERSION } from '../main/db/migrations'

const here = dirname(fileURLToPath(import.meta.url))

test('examples/backup.example.json parses as a valid backup', () => {
  const text = readFileSync(join(here, '../../examples/backup.example.json'), 'utf8')
  const payload = parseBackupJson(text)
  assert.equal(payload.format, 'cash-flow-routing-backup')
  assert.equal(payload.version, SCHEMA_VERSION)
  assert.equal(payload.tables.accounts.length, 2)
  assert.equal(payload.tables.balance_snapshots.length, 2)
  assert.equal(payload.tables.categories.length, 3)
  assert.equal(payload.tables.bills.length, 2)
  assert.equal(payload.tables.goals.length, 1)
  assert.equal(payload.tables.paychecks.length, 1)
  assert.equal(payload.tables.allocations.length, 3)
  assert.equal(payload.tables.bill_reserves.length, 1)
  assert.equal(payload.tables.transactions.length, 4)
  assert.equal(payload.tables.settings.length, 3)
})

test('the example keeps its cross-table links intact', () => {
  const text = readFileSync(join(here, '../../examples/backup.example.json'), 'utf8')
  const { tables } = parseBackupJson(text)
  const accountIds = new Set(tables.accounts.map((row) => row.id))
  const categoryIds = new Set(tables.categories.map((row) => row.id))
  const billIds = new Set(tables.bills.map((row) => row.id))
  const goalIds = new Set(tables.goals.map((row) => row.id))
  const paycheckIds = new Set(tables.paychecks.map((row) => row.id))

  for (const snapshot of tables.balance_snapshots) {
    assert.ok(accountIds.has(snapshot.account_id), `snapshot ${snapshot.on_date} links to an account in the file`)
  }

  for (const account of tables.accounts) {
    if (account.dedicated_goal_id !== null) {
      assert.ok(goalIds.has(account.dedicated_goal_id), `${account.name} dedicates to a goal in the file`)
    }
  }
  for (const goal of tables.goals) {
    if (goal.account_id !== null) assert.ok(accountIds.has(goal.account_id), `goal ${goal.name} links to an account`)
  }
  for (const bill of tables.bills) assert.ok(accountIds.has(bill.account_id), `bill ${bill.name} links to an account`)
  for (const txn of tables.transactions) {
    assert.ok(accountIds.has(txn.account_id), `txn ${txn.memo} links to an account`)
    if (txn.category_id !== null) {
      assert.ok(categoryIds.has(txn.category_id), `txn ${txn.memo} links to a category in the file`)
    }
    if (txn.bill_id !== null) assert.ok(billIds.has(txn.bill_id), `txn ${txn.memo} links to a bill`)
    if (txn.paycheck_id !== null) assert.ok(paycheckIds.has(txn.paycheck_id), `txn ${txn.memo} links to a paycheck`)
    if (txn.counter_account_id !== null) assert.ok(accountIds.has(txn.counter_account_id), `txn ${txn.memo} links a counter-account`)
  }
  for (const allocation of tables.allocations) {
    assert.ok(paycheckIds.has(allocation.paycheck_id), `allocation ${allocation.label} links to a paycheck`)
  }
  for (const reserve of tables.bill_reserves) {
    assert.ok(billIds.has(reserve.bill_id), 'reserve links to a bill in the file')
    assert.ok(paycheckIds.has(reserve.paycheck_id), 'reserve links to a paycheck in the file')
  }
})

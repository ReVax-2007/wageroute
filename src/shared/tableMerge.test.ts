import assert from 'node:assert/strict'
import test from 'node:test'
import type { ImportTables } from './importRepair'
import { describeMerge, mergeTables, type MergeCounts } from './tableMerge'

const NOW = '2026-11-02T12:00:00.000Z'

function tables(overrides: Partial<ImportTables> = {}): ImportTables {
  return {
    accounts: [],
    balance_snapshots: [],
    categories: [],
    bills: [],
    goals: [],
    paychecks: [],
    allocations: [],
    bill_reserves: [],
    transactions: [],
    settings: [],
    ...overrides
  }
}

function row(id: string, updatedAt: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    user_id: 'user-1',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: updatedAt,
    deleted_at: null,
    revision: 1,
    ...extra
  }
}

function total(counts: MergeCounts, part: 'added' | 'updated' | 'removed' | 'kept'): number {
  return Object.values(counts[part]).reduce((sum, value) => sum + value, 0)
}

test('a row this copy does not have is added', () => {
  const result = mergeTables(
    tables(),
    tables({ bills: [row('bill-1', '2026-10-01T00:00:00.000Z', { name: 'Rent' })] }),
    NOW
  )
  assert.equal(result.tables.bills.length, 1)
  assert.equal(total(result.counts, 'added'), 1)
  assert.equal(describeMerge(result.counts), '1 new')
})

test('an older copy of a row leaves the local edit alone', () => {
  const local = tables({
    bills: [row('bill-1', '2026-10-20T00:00:00.000Z', { name: 'Rent', amount_cents: 130000 })]
  })
  const incoming = tables({
    bills: [row('bill-1', '2026-10-01T00:00:00.000Z', { name: 'Rent', amount_cents: 120000 })]
  })
  const result = mergeTables(local, incoming, NOW)
  assert.equal(result.tables.bills[0].amount_cents, 130000)
  assert.equal(total(result.counts, 'kept'), 1)
  assert.equal(total(result.counts, 'updated'), 0)
})

test('a newer copy of a row replaces the local one', () => {
  const local = tables({
    bills: [row('bill-1', '2026-10-01T00:00:00.000Z', { name: 'Rent', amount_cents: 120000 })]
  })
  const incoming = tables({
    bills: [row('bill-1', '2026-10-20T00:00:00.000Z', { name: 'Rent', amount_cents: 130000 })]
  })
  const result = mergeTables(local, incoming, NOW)
  assert.equal(result.tables.bills[0].amount_cents, 130000)
  assert.equal(total(result.counts, 'updated'), 1)
  assert.equal(describeMerge(result.counts), '1 changed')
})

test('the revision breaks a tie between two edits in the same millisecond', () => {
  const stamp = '2026-10-20T00:00:00.000Z'
  const local = tables({ goals: [row('goal-1', stamp, { name: 'Trip', revision: 2 })] })
  const incoming = tables({ goals: [row('goal-1', stamp, { name: 'Trip 2027', revision: 3 })] })
  const result = mergeTables(local, incoming, NOW)
  assert.equal(result.tables.goals[0].name, 'Trip 2027')
  assert.equal(total(result.counts, 'updated'), 1)
})

test('a newer tombstone removes a row and an older live copy cannot revive it', () => {
  const local = tables({ transactions: [row('txn-1', '2026-10-10T00:00:00.000Z', { amount_cents: -500 })] })
  const deleted = tables({
    transactions: [
      row('txn-1', '2026-10-20T00:00:00.000Z', {
        amount_cents: -500,
        deleted_at: '2026-10-20T00:00:00.000Z',
        revision: 2
      })
    ]
  })
  const removed = mergeTables(local, deleted, NOW)
  assert.equal(removed.tables.transactions[0].deleted_at, '2026-10-20T00:00:00.000Z')
  assert.equal(total(removed.counts, 'removed'), 1)

  const older = tables({ transactions: [row('txn-1', '2026-10-10T00:00:00.000Z', { amount_cents: -500 })] })
  const kept = mergeTables(removed.tables, older, NOW)
  assert.equal(kept.tables.transactions[0].deleted_at, '2026-10-20T00:00:00.000Z')
  assert.equal(total(kept.counts, 'updated'), 0)
})

test('a tombstone for a row this copy never had is stored so its id is taken', () => {
  const incoming = tables({
    bills: [row('bill-gone', '2026-10-20T00:00:00.000Z', { deleted_at: '2026-10-20T00:00:00.000Z' })]
  })
  const result = mergeTables(tables(), incoming, NOW)
  assert.equal(result.tables.bills.length, 1)
  assert.equal(result.tables.bills[0].deleted_at, '2026-10-20T00:00:00.000Z')
  assert.equal(total(result.counts, 'added'), 1)
  assert.equal(total(result.counts, 'removed'), 0)

  const older = tables({ bills: [row('bill-gone', '2026-10-10T00:00:00.000Z', { name: 'Late copy' })] })
  const kept = mergeTables(result.tables, older, NOW)
  assert.equal(kept.tables.bills[0].deleted_at, '2026-10-20T00:00:00.000Z')
  assert.equal(kept.tables.bills[0].name, undefined)
})

test('a live row newer than a tombstone can come back', () => {
  const local = tables({
    bills: [row('bill-1', '2026-10-20T00:00:00.000Z', { deleted_at: '2026-10-20T00:00:00.000Z' })]
  })
  const incoming = tables({
    bills: [row('bill-1', '2026-10-25T00:00:00.000Z', { name: 'Rent again', revision: 3 })]
  })
  const result = mergeTables(local, incoming, NOW)
  assert.equal(result.tables.bills[0].deleted_at, null)
  assert.equal(result.tables.bills[0].name, 'Rent again')
  assert.equal(total(result.counts, 'updated'), 1)
})

test('a file row with no usable stamp cannot overwrite a local row', () => {
  const local = tables({ accounts: [row('acc-1', '2026-10-20T00:00:00.000Z', { name: 'Checking' })] })
  const incoming = tables({ accounts: [{ id: 'acc-1', name: 'Overwritten' }] })
  const result = mergeTables(local, incoming, NOW)
  assert.equal(result.tables.accounts[0].name, 'Checking')
  assert.equal(total(result.counts, 'updated'), 0)
})

test('a future stamp is read as now and cannot outrank later local edits', () => {
  const local = tables({ bills: [row('bill-1', '2026-11-01T00:00:00.000Z', { name: 'Local' })] })
  const incoming = tables({
    bills: [row('bill-1', '2099-01-01T00:00:00.000Z', { name: 'From a wrong clock' })]
  })
  const result = mergeTables(local, incoming, NOW)
  // The incoming row is clamped to NOW, which is still later than the local
  // edit, so it wins once — and the next local edit (stamped after NOW) wins.
  assert.equal(result.tables.bills[0].name, 'From a wrong clock')
  const later = tables({
    bills: [row('bill-1', '2026-11-02T12:01:00.000Z', { name: 'Edited after' })]
  })
  const second = mergeTables(result.tables, later, '2026-11-02T12:02:00.000Z')
  assert.equal(second.tables.bills[0].name, 'Edited after')
})

test('settings merge by key and newer value', () => {
  const local = tables({
    settings: [
      { user_id: 'user-1', key: 'currency', value: 'USD', updated_at: '2026-10-01T00:00:00.000Z' }
    ]
  })
  const incoming = tables({
    settings: [
      { user_id: 'user-1', key: 'currency', value: 'EUR', updated_at: '2026-10-20T00:00:00.000Z' },
      { user_id: 'user-1', key: 'theme', value: 'light', updated_at: '2026-10-20T00:00:00.000Z' }
    ]
  })
  const result = mergeTables(local, incoming, NOW)
  assert.equal(result.tables.settings.find((setting) => setting.key === 'currency')?.value, 'EUR')
  assert.equal(result.tables.settings.find((setting) => setting.key === 'theme')?.value, 'light')
  assert.equal(result.counts.updated.settings, 1)
  assert.equal(result.counts.added.settings, 1)
})

test('a new category with a name this copy already has is linked, not duplicated', () => {
  const local = tables({
    categories: [row('cat-local', '2026-10-01T00:00:00.000Z', { name: 'Housing', kind: 'expense' })]
  })
  const incoming = tables({
    categories: [row('cat-remote', '2026-10-20T00:00:00.000Z', { name: 'housing', kind: 'expense' })],
    transactions: [
      row('txn-1', '2026-10-20T00:00:00.000Z', {
        category: 'housing',
        category_id: 'cat-remote',
        amount_cents: -1000
      })
    ]
  })
  const result = mergeTables(local, incoming, NOW)
  assert.equal(result.tables.categories.length, 1)
  const transaction = result.tables.transactions[0]
  assert.equal(transaction.category_id, 'cat-local')
  assert.equal(transaction.category, 'Housing')
  assert.match(result.warnings.join(' '), /already exists on this device/)
})

test('a rename onto another live category name is refused with a reason', () => {
  const local = tables({
    categories: [
      row('cat-1', '2026-10-01T00:00:00.000Z', { name: 'Food', kind: 'expense' }),
      row('cat-2', '2026-10-01T00:00:00.000Z', { name: 'Travel', kind: 'expense' })
    ]
  })
  const incoming = tables({
    categories: [row('cat-2', '2026-10-20T00:00:00.000Z', { name: 'Food', kind: 'expense' })]
  })
  const result = mergeTables(local, incoming, NOW)
  assert.equal(result.tables.categories.find((category) => category.id === 'cat-2')?.name, 'Travel')
  assert.match(result.warnings.join(' '), /rename was not applied/)
})

test('an update keeps the day the row was made on this device', () => {
  const local = tables({
    bills: [row('bill-1', '2026-10-01T00:00:00.000Z', { name: 'Rent', amount_cents: 120000 })]
  })
  const incoming = tables({
    bills: [
      row('bill-1', '2026-10-20T00:00:00.000Z', {
        name: 'Rent',
        amount_cents: 130000,
        created_at: '2025-03-01T00:00:00.000Z'
      })
    ]
  })
  const result = mergeTables(local, incoming, NOW)
  assert.equal(result.tables.bills[0].amount_cents, 130000)
  assert.equal(
    result.tables.bills[0].created_at,
    '2026-01-01T00:00:00.000Z',
    'the file cannot rewrite when this ledger first saw the row'
  )
})

test('a category renamed by the file no longer answers to its old name', () => {
  const local = tables({
    categories: [row('cat-food', '2026-10-01T00:00:00.000Z', { name: 'Food', kind: 'expense' })]
  })
  const incoming = tables({
    categories: [
      row('cat-food', '2026-10-10T00:00:00.000Z', { name: 'Groceries', kind: 'expense' }),
      // A different row that genuinely needs the now-free name.
      row('cat-new', '2026-10-10T00:00:00.000Z', { name: 'Food', kind: 'expense' })
    ],
    transactions: [
      row('txn-1', '2026-10-10T00:00:00.000Z', {
        category: 'Food',
        category_id: 'cat-new',
        amount_cents: -900
      })
    ]
  })
  const result = mergeTables(local, incoming, NOW)
  const names = result.tables.categories.map((category) => category.name).sort()
  assert.deepEqual(names, ['Food', 'Groceries'], 'both names exist, on two different rows')
  const food = result.tables.categories.find((category) => category.name === 'Food')
  assert.equal(food?.id, 'cat-new')
  assert.equal(result.tables.transactions[0].category_id, 'cat-new')
})

test('a deleted category stops answering to its name', () => {
  const local = tables({
    categories: [row('cat-food', '2026-10-01T00:00:00.000Z', { name: 'Food', kind: 'expense' })]
  })
  const incoming = tables({
    categories: [
      row('cat-food', '2026-10-10T00:00:00.000Z', {
        name: 'Food',
        kind: 'expense',
        deleted_at: '2026-10-10T00:00:00.000Z'
      }),
      row('cat-fresh', '2026-10-10T00:00:00.000Z', { name: 'Food', kind: 'expense' })
    ]
  })
  const result = mergeTables(local, incoming, NOW)
  const live = result.tables.categories.filter((category) => !category.deleted_at)
  assert.equal(live.length, 1)
  assert.equal(live[0].id, 'cat-fresh', 'the new row is added rather than linked to the tombstone')
})

test('a setting this build does not know is refused by the phone too', () => {
  const local = tables({
    settings: [{ key: 'theme', value: 'light', updated_at: '2026-10-01T00:00:00.000Z' }]
  })
  const incoming = tables({
    settings: [
      { key: 'theme', value: 'dark', updated_at: '2026-10-20T00:00:00.000Z' },
      { key: 'leisurePercent', value: '10', updated_at: '2026-10-20T00:00:00.000Z' },
      { key: 'currency', value: 'XYZ', updated_at: '2026-10-20T00:00:00.000Z' }
    ]
  })
  const result = mergeTables(local, incoming, NOW)
  const keys = result.tables.settings.map((setting) => setting.key)
  assert.deepEqual(keys, ['theme'])
  assert.equal(result.tables.settings[0].value, 'dark')
  assert.match(result.warnings.join(' '), /leisurePercent/)
  assert.match(result.warnings.join(' '), /not a currency code/)
})

test('a row with no stamp is as old as its creation, not as new as the import', () => {
  const incoming = tables({
    transactions: [
      {
        id: 'txn-1',
        user_id: 'user-1',
        account_id: 'acc-1',
        kind: 'expense',
        amount_cents: -500,
        created_at: '2026-01-15T00:00:00.000Z'
      }
    ]
  })
  const result = mergeTables(tables(), incoming, NOW)
  assert.equal(result.tables.transactions[0].updated_at, '2026-01-15T00:00:00.000Z')
  assert.equal(result.tables.transactions[0].revision, 1)
})

test('the same file read on two devices clamps a broken stamp the same way', () => {
  const incoming = tables({
    bills: [row('bill-1', '2099-01-01T00:00:00.000Z', { name: 'Rent', amount_cents: 1000 })]
  })
  const first = mergeTables(tables(), incoming, '2026-11-02T12:00:00.000Z', '2026-11-02T10:00:00.000Z')
  const second = mergeTables(tables(), incoming, '2026-11-05T09:00:00.000Z', '2026-11-02T10:00:00.000Z')
  assert.equal(first.tables.bills[0].updated_at, '2026-11-02T10:00:00.000Z')
  assert.equal(second.tables.bills[0].updated_at, first.tables.bills[0].updated_at)
})

test('a row without an id is reported rather than silently dropped', () => {
  const incoming = tables({
    transactions: [{ account_id: 'acc-1', kind: 'expense', amount_cents: -500 }]
  })
  const result = mergeTables(tables(), incoming, NOW)
  assert.equal(result.tables.transactions.length, 0)
  assert.match(result.warnings.join(' '), /transactions list had no id/)
})

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_CATEGORIES,
  categoryKey,
  defaultCategoryKind,
  spendingByCategory
} from './categories'
import type { Category } from './types'

const TS = '2026-01-01T00:00:00.000Z'

function category(id: string, name: string, color: string | null = null): Category {
  return { id, userId: 'u', name, kind: 'expense', color, sortOrder: 0, createdAt: TS } as Category
}

const GROCERIES = category('cat-groceries', 'Groceries', '#FBBF24')
const DINING = category('cat-dining', 'Dining', '#FB923C')

test('the starter list has one Uncategorized fallback and unique names', () => {
  const keys = DEFAULT_CATEGORIES.map((seed) => categoryKey(seed.name))
  assert.equal(new Set(keys).size, keys.length, 'no duplicate starter category')
  assert.equal(keys[0], 'uncategorized', 'the fallback is first')
})

test('names compare case-insensitively and ignore surrounding space', () => {
  assert.equal(categoryKey('  Dining  '), categoryKey('dining'))
  assert.equal(categoryKey('Eating   Out'), 'eating out', 'inner runs collapse')
})

test('a transaction kind suggests the matching category kind', () => {
  assert.equal(defaultCategoryKind('income'), 'income')
  assert.equal(defaultCategoryKind('expense'), 'expense')
  assert.equal(defaultCategoryKind('bill_payment'), 'expense')
  assert.equal(defaultCategoryKind('transfer'), 'transfer')
  assert.equal(defaultCategoryKind('goal_funding'), 'transfer')
  assert.equal(defaultCategoryKind('adjustment'), 'other')
})

test('spending groups by category row and ranks the biggest first', () => {
  const rows = [
    { categoryId: GROCERIES.id, category: 'Groceries', kind: 'expense' as const, amountCents: -4_000, occurredOn: '2026-10-02' },
    { categoryId: GROCERIES.id, category: 'Groceries', kind: 'expense' as const, amountCents: -1_000, occurredOn: '2026-10-09' },
    { categoryId: DINING.id, category: 'Dining', kind: 'expense' as const, amountCents: -6_500, occurredOn: '2026-10-10' }
  ]
  const spend = spendingByCategory({ transactions: rows, categories: [GROCERIES, DINING], month: '2026-10' })

  assert.deepEqual(
    spend.map((row) => [row.name, row.totalCents, row.count]),
    [
      ['Dining', 6_500, 1],
      ['Groceries', 5_000, 2]
    ]
  )
})

test('a row without a category row still appears under its own text', () => {
  const rows = [
    { categoryId: null, category: 'Pet care', kind: 'expense' as const, amountCents: -2_500, occurredOn: '2026-10-03' },
    { categoryId: null, category: '  ', kind: 'expense' as const, amountCents: -700, occurredOn: '2026-10-04' }
  ]
  const spend = spendingByCategory({ transactions: rows, categories: [], month: '2026-10' })

  assert.deepEqual(
    spend.map((row) => [row.name, row.totalCents]),
    [
      ['Pet care', 2_500],
      ['Uncategorized', 700]
    ]
  )
})

test('only this month and only spending kinds count', () => {
  const rows = [
    { categoryId: GROCERIES.id, category: 'Groceries', kind: 'expense' as const, amountCents: -1_000, occurredOn: '2026-09-30' },
    { categoryId: GROCERIES.id, category: 'Groceries', kind: 'bill_payment' as const, amountCents: -2_000, occurredOn: '2026-10-01' },
    { categoryId: GROCERIES.id, category: 'Groceries', kind: 'income' as const, amountCents: 90_000, occurredOn: '2026-10-01' },
    { categoryId: GROCERIES.id, category: 'Groceries', kind: 'transfer' as const, amountCents: -40_000, occurredOn: '2026-10-01' }
  ]
  const spend = spendingByCategory({ transactions: rows, categories: [GROCERIES], month: '2026-10' })
  assert.deepEqual(
    spend.map((row) => [row.name, row.totalCents]),
    [['Groceries', 2_000]],
    'income and transfers are moves, not spending'
  )
})

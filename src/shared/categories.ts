import type { Category, CategoryKind, TransactionKind } from './types'

export const CATEGORY_NAME_MAX = 60

export interface CategorySeed {
  name: string
  kind: CategoryKind
  color: string
}

/**
 * The starter list. Names are matched case-insensitively against what a user
 * already has, so an upgrade never duplicates a category the ledger used.
 * "Uncategorized" is deliberately first: it is the fallback the ledger writes.
 */
export const DEFAULT_CATEGORIES: readonly CategorySeed[] = [
  { name: 'Uncategorized', kind: 'other', color: '#64748B' },
  { name: 'Income', kind: 'income', color: '#34D399' },
  { name: 'Housing', kind: 'expense', color: '#60A5FA' },
  { name: 'Groceries', kind: 'expense', color: '#FBBF24' },
  { name: 'Dining', kind: 'expense', color: '#FB923C' },
  { name: 'Transport', kind: 'expense', color: '#A78BFA' },
  { name: 'Utilities', kind: 'expense', color: '#22D3EE' },
  { name: 'Insurance', kind: 'expense', color: '#F472B6' },
  { name: 'Health', kind: 'expense', color: '#F87171' },
  { name: 'Shopping', kind: 'expense', color: '#C084FC' },
  { name: 'Subscriptions', kind: 'expense', color: '#818CF8' },
  { name: 'Entertainment', kind: 'expense', color: '#FACC15' },
  { name: 'Bills', kind: 'expense', color: '#94A3B8' },
  { name: 'Savings', kind: 'transfer', color: '#2DD4BF' },
  { name: 'Investing', kind: 'transfer', color: '#38BDF8' },
  { name: 'Debt', kind: 'transfer', color: '#FB7185' },
  { name: 'Transfer', kind: 'transfer', color: '#7DD3FC' },
  { name: 'Adjustment', kind: 'other', color: '#94A3B8' }
]

export function normalizeCategoryName(name: string): string {
  return name.trim().replace(/\s+/g, ' ')
}

/** The comparison key: categories that differ only by case are the same row. */
export function categoryKey(name: string): string {
  return normalizeCategoryName(name).toLocaleLowerCase()
}

export function defaultCategoryKind(kind: TransactionKind): CategoryKind {
  if (kind === 'income') return 'income'
  if (kind === 'transfer' || kind === 'goal_funding' || kind === 'investment') return 'transfer'
  if (kind === 'adjustment') return 'other'
  return 'expense'
}

/** Kinds whose money is spending; goals, investments and transfers are moves. */
const SPENDING_KINDS: readonly TransactionKind[] = ['expense', 'bill_payment']

export interface CategorySpend {
  key: string
  name: string
  color: string | null
  totalCents: number
  count: number
}

interface SpendRow {
  categoryId: string | null
  category: string
  kind: TransactionKind
  amountCents: number
  occurredOn: string
}

/**
 * Spending for one calendar month grouped by category. Rows without a category
 * row still appear under their legacy text, so a ledger imported before schema
 * 8 never hides money from the answer.
 */
export function spendingByCategory(input: {
  transactions: readonly SpendRow[]
  categories: readonly Category[]
  month: string
}): CategorySpend[] {
  const byId = new Map(input.categories.map((category) => [category.id, category]))
  const totals = new Map<string, CategorySpend>()

  for (const row of input.transactions) {
    if (!SPENDING_KINDS.includes(row.kind)) continue
    if (!row.occurredOn.startsWith(input.month)) continue
    const amount = Math.abs(row.amountCents)
    if (amount === 0) continue

    const category = row.categoryId ? byId.get(row.categoryId) : undefined
    const name = category?.name ?? (row.category.trim() || 'Uncategorized')
    const key = category?.id ?? `text:${categoryKey(name)}`
    const existing = totals.get(key)
    if (existing) {
      existing.totalCents += amount
      existing.count += 1
    } else {
      totals.set(key, {
        key,
        name,
        color: category?.color ?? null,
        totalCents: amount,
        count: 1
      })
    }
  }

  return [...totals.values()].sort(
    (a, b) => b.totalCents - a.totalCents || a.name.localeCompare(b.name)
  )
}

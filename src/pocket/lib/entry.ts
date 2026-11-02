import type { ImportTables } from '@shared/importRepair'
import { isISODate, todayISO } from '@shared/dates'
import { normalizeSignedCents } from '@shared/kinds'
import { flag, isLive, text, type Row } from './rows'

export type EntryKind = 'expense' | 'income'

export interface EntryDraft {
  accountId: string
  kind: EntryKind
  /** Always a positive amount; the kind decides the sign on the row. */
  amountCents: number
  occurredOn: string
  memo: string
  categoryId: string | null
  categoryName: string
}

export class EntryError extends Error {
  readonly code = 'ENTRY'

  constructor(message: string) {
    super(message)
    this.name = 'EntryError'
  }
}

/**
 * One entry, in the same columns the desktop writes. Pocket only appends plain
 * expenses and income: a bill payment would need a claim settled beside it, and
 * a merge cannot see a delete, so this stays the one kind that survives a trip
 * back to the desktop honestly.
 */
export function createEntryRow(tables: ImportTables, draft: EntryDraft): Row {
  const account = tables.accounts.find(
    (row) => isLive(row) && text(row, 'id') === draft.accountId
  )
  if (!account) throw new EntryError('Pick an account for this entry')
  if (!Number.isFinite(draft.amountCents) || draft.amountCents <= 0) {
    throw new EntryError('Enter an amount greater than zero')
  }
  if (draft.amountCents > 10_000_000_000) {
    throw new EntryError('That amount is too large to record')
  }
  if (!isISODate(draft.occurredOn)) throw new EntryError('Pick a real date')
  if (draft.occurredOn > todayISO()) throw new EntryError('That date is in the future')

  const category = draft.categoryId
    ? tables.categories.find(
        (row) => isLive(row) && text(row, 'id') === draft.categoryId
      )
    : undefined
  const categoryName =
    (category ? text(category, 'name') : '') || draft.categoryName.trim() || 'Uncategorized'
  const now = new Date().toISOString()

  return {
    id: crypto.randomUUID(),
    user_id: text(account, 'user_id'),
    account_id: draft.accountId,
    kind: draft.kind,
    amount_cents: normalizeSignedCents(draft.kind, draft.amountCents),
    occurred_on: draft.occurredOn,
    memo: draft.memo.trim() || categoryName,
    category: categoryName,
    category_id: category ? text(category, 'id') : null,
    external_id: null,
    bill_id: null,
    goal_id: null,
    paycheck_id: null,
    counter_account_id: null,
    transfer_group_id: null,
    round_up_source_id: null,
    created_at: now,
    updated_at: now,
    deleted_at: null,
    revision: 1
  }
}

/** Accounts a new entry may land in, newest sort order first is not useful here. */
export function entryAccounts(tables: ImportTables): Row[] {
  return tables.accounts.filter(
    (row) => isLive(row) && text(row, 'kind') !== 'credit' && !flag(row, 'is_archived')
  )
}

export function entryCategories(tables: ImportTables, kind: EntryKind): Row[] {
  return tables.categories.filter(
    (row) => isLive(row) && (text(row, 'kind') === kind || text(row, 'kind') === 'other')
  )
}

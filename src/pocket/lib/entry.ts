import { categoryKey } from '@shared/categories'
import type { ImportTables } from '@shared/importRepair'
import { flag, isLive, text, type Row } from './rows'

/**
 * The pickers every Pocket form offers. They list the same rows the desktop's
 * dialogs do — every live account, every bill, every un-archived goal — because
 * a phone form that hides a credit card cannot pay a card bill.
 */

export function entryAccounts(tables: ImportTables): Row[] {
  // Archived and locked accounts take no new money (ADR 0034).
  return tables.accounts.filter(
    (row) => isLive(row) && !flag(row, 'is_archived') && !flag(row, 'is_locked')
  )
}

export function entryCategories(tables: ImportTables): Row[] {
  return tables.categories.filter(isLive)
}

/** A paused bill is still payable by hand, so the picker lists every live one. */
export function entryBills(tables: ImportTables): Row[] {
  return tables.bills.filter(isLive)
}

export function entryGoals(tables: ImportTables): Row[] {
  return tables.goals.filter((row) => isLive(row) && !flag(row, 'is_archived'))
}

/**
 * A typed category name that matches one already used adopts it rather than
 * minting a near-duplicate, which is what the desktop does with its datalist.
 */
export function categoryMatch(tables: ImportTables | null, typed: string): Row | undefined {
  const key = categoryKey(typed)
  if (!tables || !key) return undefined
  return tables.categories.find((row) => isLive(row) && categoryKey(text(row, 'name')) === key)
}

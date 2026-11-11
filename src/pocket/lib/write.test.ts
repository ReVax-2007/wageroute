import assert from 'node:assert/strict'
import test from 'node:test'
import { todayISO } from '@shared/dates'
import { RepositoryError } from '@shared/errors'
import type { ImportTables } from '@shared/importRepair'
import type { AccountInput, BillInput, CategoryInput, GoalInput } from '@shared/types'
import { emptyTables } from './backup'
import { cents, flag, isLive, nullableText, text } from './rows'
import {
  accountEntryCount,
  billDeletionSummary,
  billPaidThisMonthCents,
  createAccount,
  createBill,
  createCategory,
  createEntry,
  createGoal,
  createSplitTransfer,
  deleteAccount,
  deleteBill,
  deleteCategory,
  deleteEntries,
  deleteGoal,
  doomedAccountEntryIds,
  insertedEntryIds,
  ledgerUserId,
  patchAccount,
  patchBill,
  patchCategory,
  patchEntry,
  patchGoal,
  payBill,
  reconcileAllBillClaims,
  requireLiveRow,
  setAccountArchived,
  setGoalArchived,
  stampAfter
} from './write'

const USER = 'u-test'

function lifecycle(columns: Record<string, unknown>): Record<string, unknown> {
  const now = '2026-11-01T09:00:00.000Z'
  return { user_id: USER, created_at: now, updated_at: now, deleted_at: null, revision: 1, ...columns }
}

function account(id: string, columns: Record<string, unknown>): Record<string, unknown> {
  return lifecycle({ id, name: id, kind: 'checking', is_archived: 0, ...columns })
}

/** A small ledger with one of each kind, a bill, a goal and a category. */
function ledger(): ImportTables {
  const tables = emptyTables()
  tables.accounts = [
    account('chk', { name: 'Everyday', kind: 'checking', in_safe_to_spend: 1 }),
    account('sav', { name: 'Savings', kind: 'savings', in_safe_to_spend: 1 }),
    account('card', { name: 'Visa', kind: 'credit', in_safe_to_spend: 0, credit_limit_cents: 400_000 })
  ]
  tables.categories = [
    lifecycle({ id: 'cat-bills', name: 'Bills', kind: 'expense', color: null, sort_order: 0 })
  ]
  tables.bills = [
    lifecycle({
      id: 'rent',
      name: 'Rent',
      amount_cents: 120_000,
      frequency: 'monthly',
      due_day: 1,
      category: 'Bills',
      account_id: 'chk',
      autopay: 0,
      is_active: 1,
      next_due_on: null,
      funding_strategy: 'all_checks',
      funding_paycheck_index: null
    })
  ]
  tables.goals = [
    lifecycle({
      id: 'car',
      name: 'Car',
      target_cents: 500_000,
      target_date: null,
      priority: 1,
      color: '#34D399',
      account_id: null,
      is_emergency: 0,
      is_archived: 0,
      funding_pace: 'asap'
    })
  ]
  return tables
}

/**
 * The ledger with one cheque that wrote a claim: the walk needs the cheque's
 * date to know whether the money was in the account when the payment left.
 */
function withClaim(tables: ImportTables, amountCents = 120_000): ImportTables {
  const cycle = todayISO().slice(0, 7)
  return {
    ...tables,
    paychecks: [
      ...tables.paychecks,
      lifecycle({
        id: 'pay-1',
        amount_cents: 320_000,
        received_on: `${cycle}-01`,
        source: 'Paycheck',
        deposit_account_id: 'chk',
        priority_cents: 0,
        surplus_cents: 0,
        leisure_cents: 0,
        health: 'covered'
      })
    ],
    bill_reserves: [
      ...tables.bill_reserves,
      lifecycle({
        id: 'claim-1',
        bill_id: 'rent',
        paycheck_id: 'pay-1',
        cycle,
        amount_cents: amountCents,
        state: 'reserved',
        strategy: 'all_checks',
        due_day: 1,
        settled_by: null
      })
    ]
  }
}

function rowOf(tables: ImportTables, id: string): Record<string, unknown> {
  for (const rows of Object.values(tables)) {
    const row = rows.find((candidate) => text(candidate, 'id') === id)
    if (row) return row
  }
  throw new Error(`no row with id ${id}`)
}

function entries(tables: ImportTables): Record<string, unknown>[] {
  return tables.transactions.filter(isLive)
}

function refusal(action: () => unknown): RepositoryError {
  try {
    action()
  } catch (error) {
    assert.ok(error instanceof RepositoryError, `expected a RepositoryError, got ${String(error)}`)
    return error
  }
  throw new Error('the write was accepted')
}

test('the phone needs a ledger before it can stamp a row', () => {
  assert.equal(ledgerUserId(ledger()), USER)
  assert.equal(refusal(() => ledgerUserId(emptyTables())).message, 'This phone has no ledger to write to')
  assert.equal(refusal(() => ledgerUserId(emptyTables())).code, 'STATE')
})

test('a phone edit always looks newer than the row it replaces', () => {
  const future = '2999-01-01T00:00:00.000Z'
  const stamped = stampAfter({ updated_at: future, revision: 4 }, '2026-11-02T00:00:00.000Z')
  assert.ok(Date.parse(stamped.updated_at) > Date.parse(future), 'the stamp never goes backwards')
  assert.equal(stamped.revision, 5)

  const fresh = stampAfter(undefined, '2026-11-02T00:00:00.000Z')
  assert.equal(fresh.updated_at, '2026-11-02T00:00:00.000Z')
  assert.equal(fresh.revision, 1)
})

test('a bill keeps the desktop defaults and a patch only moves what it names', () => {
  const tables = ledger()
  const input: BillInput = {
    name: '  Internet  ',
    amountCents: 6900,
    frequency: 'monthly',
    dueDay: 15,
    category: '',
    accountId: 'chk',
    autopay: true,
    isActive: true,
    nextDueOn: null,
    fundingStrategy: 'all_checks',
    fundingPaycheckIndex: null
  }
  const created = createBill(tables, input)
  const bill = rowOf(created.tables, created.id)
  assert.equal(text(bill, 'name'), 'Internet')
  assert.equal(cents(bill, 'amount_cents'), 6_900)
  assert.equal(text(bill, 'category'), 'Bills', 'a blank category lands on the desktop default')
  assert.equal(flag(bill, 'autopay'), true)
  assert.equal(cents(bill, 'revision'), 1)
  assert.equal(nullableText(bill, 'account_id'), 'chk')

  const patched = patchBill(created.tables, created.id, { amountCents: 7500 })
  const after = rowOf(patched, created.id)
  assert.equal(cents(after, 'amount_cents'), 7_500)
  assert.equal(text(after, 'name'), 'Internet', 'a patch cannot blank a column the form did not show')
  assert.equal(text(after, 'frequency'), 'monthly')
  assert.ok(cents(after, 'revision') === 2, 'the patch moved the counter up')

  assert.equal(refusal(() => patchBill(patched, 'gone', { name: 'x' })).message, 'That record no longer exists')
  assert.equal(refusal(() => createBill(patched, { ...input, dueDay: 32 })).message, 'Due day must be a whole number from 1 to 31')
  assert.match(refusal(() => createBill(patched, { ...input, accountId: 'gone' })).message, /Account not found/)
})

test('a paused bill keeps its history and delete hands the payments back', () => {
  const tables = ledger()
  const paid = payBill(tables, 'rent')
  const entryId = paid.id
  assert.equal(cents(rowOf(paid.tables, entryId), 'amount_cents'), -120_000)
  assert.equal(nullableText(rowOf(paid.tables, entryId), 'bill_id'), 'rent')
  assert.equal(text(rowOf(paid.tables, entryId), 'kind'), 'bill_payment')

  const second = refusal(() => payBill(paid.tables, 'rent'))
  assert.equal(second.code, 'STATE')
  assert.equal(second.message, 'This bill is already paid for the month')

  const stopped = patchBill(paid.tables, 'rent', { isActive: false })
  assert.equal(flag(rowOf(stopped, 'rent'), 'is_active'), false)

  const removed = deleteBill(stopped, 'rent')
  const entry = rowOf(removed, entryId)
  assert.equal(nullableText(entry, 'bill_id'), null, 'a live payment must not point at a tombstone')
  assert.equal(text(entry, 'kind'), 'expense')
  assert.equal(isLive(rowOf(removed, 'rent')), false)
  assert.match(refusal(() => deleteBill(removed, 'rent')).message, /That record no longer exists/)
})

test('the bill question counts the set-asides that go and the payments that stay', () => {
  const tables = ledger()
  const paid = payBill(tables, 'rent')
  const withReserve: ImportTables = {
    ...paid.tables,
    bill_reserves: [
      ...paid.tables.bill_reserves,
      lifecycle({
        id: 'res-1',
        bill_id: 'rent',
        paycheck_id: 'pay-1',
        cycle: todayISO().slice(0, 7),
        amount_cents: 120_000,
        state: 'reserved',
        strategy: 'all_checks',
        due_day: 1,
        settled_by: null
      })
    ]
  }
  assert.deepEqual(billDeletionSummary(withReserve, 'rent'), {
    reserves: 1,
    linkedEntries: 1
  })

  const removed = deleteBill(withReserve, 'rent')
  assert.equal(
    removed.bill_reserves.filter(isLive).length,
    0,
    'every set-aside the question named is retired'
  )
  assert.equal(
    entries(removed).filter((row) => nullableText(row, 'bill_id') === 'rent').length,
    0,
    'the payment it named lets go of the tombstone'
  )
  assert.equal(entries(removed).length, 1, 'and stays in the ledger as an ordinary expense')
})

test('marking a bill paid takes whatever the month still owes', () => {
  const tables = ledger()
  const part = createEntry(tables, {
    accountId: 'chk',
    kind: 'bill_payment',
    amountCents: -40_000,
    occurredOn: todayISO(),
    memo: 'Part of rent',
    category: 'Bills',
    billId: 'rent'
  })
  assert.equal(billPaidThisMonthCents(part.tables, 'rent', todayISO()), 40_000)

  const rest = payBill(part.tables, 'rent')
  assert.equal(cents(rowOf(rest.tables, rest.id), 'amount_cents'), -80_000)
  assert.equal(billPaidThisMonthCents(rest.tables, 'rent', todayISO()), 120_000)

  // Money paid against a different bill never counts towards this one.
  const other = createBill(rest.tables, {
    name: 'Phone',
    amountCents: 4500,
    frequency: 'monthly',
    dueDay: 20,
    category: 'Bills',
    accountId: 'chk',
    autopay: false,
    isActive: true,
    nextDueOn: null,
    fundingStrategy: 'all_checks',
    fundingPaycheckIndex: null
  })
  assert.equal(billPaidThisMonthCents(other.tables, other.id, todayISO()), 0)
  assert.match(refusal(() => payBill(other.tables, 'gone')).message, /That bill no longer exists/)
  assert.equal(
    refusal(() => payBill(other.tables, 'rent', { occurredOn: '2999-01-01' })).message,
    'That date is in the future'
  )
})

test('a category name is shared, never duplicated', () => {
  const tables = ledger()
  const input: CategoryInput = { name: '  groceries  ', kind: 'expense', color: null }
  const created = createCategory(tables, input)
  assert.equal(text(rowOf(created.tables, created.id), 'name'), 'groceries', 'trimming only')
  assert.equal(cents(rowOf(created.tables, created.id), 'sort_order'), 1)

  const same = createCategory(created.tables, { name: 'Groceries', kind: 'expense', color: null })
  assert.equal(same.id, created.id, 'case alone does not make a second category')
  assert.equal(same.tables.categories.length, created.tables.categories.length)

  assert.equal(
    refusal(() => patchCategory(same.tables, created.id, { name: 'Bills' })).message,
    'A category with that name already exists'
  )
  assert.equal(refusal(() => createCategory(same.tables, { name: '', kind: 'expense' })).message, 'Category name is required')
  assert.match(refusal(() => createCategory(same.tables, { name: 'Fun', kind: 'loan' as never })).message, /Invalid category kind/)
})

test('deleting a category leaves the entries standing', () => {
  const tables = ledger()
  const spent = createEntry(tables, {
    accountId: 'chk',
    kind: 'expense',
    amountCents: 1200,
    occurredOn: todayISO(),
    memo: 'Coffee',
    category: 'Bills',
    categoryId: 'cat-bills'
  })
  const removed = deleteCategory(spent.tables, 'cat-bills')
  assert.equal(nullableText(rowOf(removed, spent.id), 'category_id'), null)
  assert.equal(isLive(rowOf(removed, 'cat-bills')), false)
  assert.equal(text(rowOf(removed, spent.id), 'category'), 'Bills', 'the entry keeps its label')
})

test('a goal records its pace and the accounts that hold its money', () => {
  const tables = ledger()
  const input: GoalInput = {
    name: 'Holiday',
    targetCents: 250_000,
    targetDate: '2027-06-01',
    priority: 3,
    color: 'var(--leisure)',
    accountId: 'sav',
    isEmergency: false,
    fundingPace: 'by_date',
    fundingAccountIds: ['sav']
  }
  const created = createGoal(tables, input)
  const goal = rowOf(created.tables, created.id)
  assert.equal(text(goal, 'funding_pace'), 'by_date')
  assert.equal(text(goal, 'target_date'), '2027-06-01')
  assert.equal(cents(goal, 'priority'), 3)
  assert.equal(nullableText(goal, 'account_id'), 'sav')
  assert.equal(nullableText(rowOf(created.tables, 'sav'), 'dedicated_goal_id'), created.id)

  const unassigned = patchGoal(created.tables, created.id, { fundingAccountIds: [] })
  assert.equal(nullableText(rowOf(unassigned, 'sav'), 'dedicated_goal_id'), null)

  assert.equal(refusal(() => createGoal(unassigned, { ...input, targetCents: 0 })).message, 'Goal target cannot be zero')
  assert.match(refusal(() => patchGoal(unassigned, 'gone', { name: 'x' })).message, /Goal not found/)

  const archived = setGoalArchived(unassigned, created.id, true)
  assert.equal(flag(rowOf(archived, created.id), 'is_archived'), true)
  const back = setGoalArchived(archived, created.id, false)
  assert.equal(flag(rowOf(back, created.id), 'is_archived'), false)

  const spent = createEntry(back, {
    accountId: 'chk',
    kind: 'goal_funding',
    amountCents: 5000,
    occurredOn: todayISO(),
    memo: 'Holiday money',
    category: 'Transfer',
    goalId: created.id
  })
  const removed = deleteGoal(spent.tables, created.id)
  assert.equal(isLive(rowOf(removed, created.id)), false)
  // The funding stays: it is money that moved, whatever happens to the plan.
  assert.equal(nullableText(rowOf(removed, spent.id), 'goal_id'), created.id)
})

test('an account carries the credit details the desktop shows', () => {
  const tables = ledger()
  const input: AccountInput = {
    name: 'Store card',
    kind: 'credit',
    institution: '  ',
    startingBalanceCents: -12_000,
    creditLimitCents: 200_000,
    color: 'var(--debt)',
    dedicatedGoalId: null,
    inSafeToSpend: false,
    aprBps: 2_399,
    minimumPaymentCents: 2_500,
    statementDay: 3,
    paymentDueDay: 23,
    lastStatementBalanceCents: 12_000,
    sortOrder: 2
  }
  const created = createAccount(tables, input)
  const row = rowOf(created.tables, created.id)
  assert.equal(text(row, 'kind'), 'credit')
  assert.equal(nullableText(row, 'institution'), null, 'a blank institution is no institution')
  assert.equal(cents(row, 'starting_balance_cents'), -12_000)
  assert.equal(cents(row, 'apr_bps'), 2_399)
  assert.equal(cents(row, 'statement_day'), 3)
  assert.equal(flag(row, 'in_safe_to_spend'), false)
  assert.equal(cents(row, 'sort_order'), 2)

  const renamed = patchAccount(created.tables, created.id, { name: 'Shop card' })
  assert.equal(text(rowOf(renamed, created.id), 'name'), 'Shop card')
  assert.equal(cents(rowOf(renamed, created.id), 'apr_bps'), 2_399, 'the patch left the rate alone')

  assert.equal(
    refusal(() => patchAccount(renamed, created.id, { statementDay: 32 })).message,
    'Statement day must be a whole number from 1 to 31'
  )
  assert.match(refusal(() => createAccount(renamed, { ...input, dedicatedGoalId: 'gone' })).message, /Goal not found/)
})

test('archiving or deleting the round-up destination stops the sweeps', () => {
  const tables = ledger()
  tables.settings = [
    lifecycle({ id: 'roundUpEnabled', key: 'roundUpEnabled', value: 'true' }),
    lifecycle({ id: 'roundUpAccountId', key: 'roundUpAccountId', value: 'sav' }),
    lifecycle({ id: 'roundUpToCents', key: 'roundUpToCents', value: '100' })
  ]
  const purchase = createEntry(tables, {
    accountId: 'chk',
    kind: 'expense',
    amountCents: 12_345,
    occurredOn: todayISO(),
    memo: 'Groceries',
    category: 'Food'
  })
  assert.equal(entries(purchase.tables).length, 3, 'the purchase plus a paired sweep')

  const archived = setAccountArchived(purchase.tables, 'sav', true)
  assert.equal(
    text(rowOf(archived, 'roundUpEnabled'), 'value'),
    'false',
    'a sweep with nowhere to land is switched off'
  )
  assert.equal(refusal(() => createEntry(archived, {
    accountId: 'sav',
    kind: 'expense',
    amountCents: 1000,
    occurredOn: todayISO(),
    memo: '',
    category: 'Misc'
  })).message, 'That account is archived — restore it before using it here')

  const removed = deleteAccount(archived, 'sav', { withEntries: true })
  assert.equal(isLive(rowOf(removed, 'sav')), false)
  assert.equal(
    text(rowOf(removed, 'roundUpAccountId'), 'value'),
    'sav',
    'the destination stays written; the switch is what matters'
  )
  assert.equal(
    text(rowOf(removed, 'roundUpEnabled'), 'value'),
    'false',
    'and it stays off, so the next purchase sweeps nowhere'
  )
})

test('an account with entries is archived, not quietly emptied', () => {
  const tables = ledger()
  const spent = createEntry(tables, {
    accountId: 'card',
    kind: 'expense',
    amountCents: 5000,
    occurredOn: todayISO(),
    memo: 'Fuel',
    category: 'Travel'
  })
  assert.equal(accountEntryCount(spent.tables, 'card'), 1)

  const blocked = refusal(() => deleteAccount(spent.tables, 'card'))
  assert.equal(blocked.code, 'CONFLICT')
  assert.match(blocked.message, /still has entries/)

  const emptied = deleteAccount(spent.tables, 'card', { withEntries: true })
  assert.equal(entries(emptied).length, 0)
  assert.equal(isLive(rowOf(emptied, 'card')), false)
  assert.equal(nullableText(rowOf(emptied, 'rent'), 'account_id'), 'chk')
  assert.equal(refusal(() => deleteAccount(emptied, 'card')).message, 'Account not found')
})

test('a bill or goal pointed at a deleted account lets go of it', () => {
  const tables = ledger()
  const wired = patchGoal(tables, 'car', { accountId: 'sav' })
  const removed = deleteAccount(wired, 'sav')
  assert.equal(nullableText(rowOf(removed, 'car'), 'account_id'), null)
  assert.equal(nullableText(rowOf(removed, 'rent'), 'account_id'), 'chk')
})

test('the account question counts the rows in the other accounts too', () => {
  const tables = ledger()
  tables.settings = [
    lifecycle({ id: 'roundUpEnabled', key: 'roundUpEnabled', value: 'true' }),
    lifecycle({ id: 'roundUpAccountId', key: 'roundUpAccountId', value: 'sav' }),
    lifecycle({ id: 'roundUpToCents', key: 'roundUpToCents', value: '100' })
  ]
  const moved = createEntry(tables, {
    accountId: 'chk',
    kind: 'transfer',
    amountCents: 30_000,
    occurredOn: todayISO(),
    memo: 'To savings',
    category: 'Transfer',
    counterAccountId: 'sav'
  })
  const bought = createEntry(moved.tables, {
    accountId: 'chk',
    kind: 'expense',
    amountCents: 4_530,
    occurredOn: todayISO(),
    memo: 'Coffee beans',
    category: 'Food'
  })

  // Everyday holds three rows; the transfer's twin and the sweep's landing leg
  // stand in Savings and leave with them.
  assert.equal(accountEntryCount(bought.tables, 'chk'), 3)
  assert.equal(doomedAccountEntryIds(bought.tables, 'chk').size, 5)

  const removed = deleteAccount(bought.tables, 'chk', { withEntries: true })
  assert.equal(entries(removed).length, 0, 'no half-pair or lone sweep is left behind')
})

test('the phone refuses a transfer out of a card with the desktop’s sentence', () => {
  const tables = ledger()
  const refused = refusal(() =>
    createEntry(tables, {
      accountId: 'card',
      kind: 'transfer',
      amountCents: 5_000,
      occurredOn: todayISO(),
      memo: '',
      category: 'Transfer',
      counterAccountId: 'chk'
    })
  )
  assert.equal(refused.code, 'VALIDATION')
  assert.match(refused.message, /can’t be transferred out of a credit card/)

  const paid = createEntry(tables, {
    accountId: 'chk',
    kind: 'transfer',
    amountCents: 5_000,
    occurredOn: todayISO(),
    memo: '',
    category: 'Debt',
    counterAccountId: 'card'
  })
  assert.deepEqual(
    entries(paid.tables).map((row) => [text(row, 'account_id'), cents(row, 'amount_cents')]),
    [
      ['chk', -5_000],
      ['card', 5_000]
    ]
  )
})

test('a transfer keeps the category name the person typed, as the desktop does', () => {
  const moved = createEntry(ledger(), {
    accountId: 'chk',
    kind: 'transfer',
    amountCents: 37,
    occurredOn: todayISO(),
    memo: 'Coffee change',
    category: 'Round-up',
    counterAccountId: 'sav'
  })
  const legs = entries(moved.tables)
  assert.deepEqual(
    legs.map((leg) => text(leg, 'category')),
    ['Round-up', 'Round-up']
  )
  assert.ok(
    moved.tables.categories.some((row) => isLive(row) && text(row, 'name') === 'Round-up'),
    'the new name becomes a category the desktop will list'
  )
})

test('a transfer is two legs the phone cannot pull apart', () => {
  const tables = ledger()
  const moved = createEntry(tables, {
    accountId: 'chk',
    kind: 'transfer',
    amountCents: 20_000,
    occurredOn: todayISO(),
    memo: 'To savings',
    category: 'Transfer',
    counterAccountId: 'sav'
  })
  const legs = entries(moved.tables)
  assert.equal(legs.length, 2)
  const out = legs[0]!
  const inLeg = legs[1]!
  assert.equal(nullableText(out, 'transfer_group_id'), nullableText(inLeg, 'transfer_group_id'))
  assert.equal(cents(out, 'amount_cents'), -20_000)
  assert.equal(cents(inLeg, 'amount_cents'), 20_000)
  assert.equal(nullableText(out, 'counter_account_id'), 'sav')
  assert.equal(nullableText(inLeg, 'counter_account_id'), 'chk')

  const group = nullableText(out, 'transfer_group_id')!
  const resized = patchEntry(moved.tables, text(out, 'id'), { amountCents: 25_000 })
  const pair = entries(resized).filter((row) => nullableText(row, 'transfer_group_id') === group)
  assert.equal(cents(pair[0]!, 'amount_cents'), -25_000)
  assert.equal(cents(pair[1]!, 'amount_cents'), 25_000, 'both legs move together')
  assert.equal(
    text(pair[1]!, 'category'),
    'Transfer',
    'both legs carry the label the phone wrote for the pair'
  )

  assert.equal(
    refusal(() => patchEntry(resized, text(out, 'id'), { accountId: 'card' })).message,
    'Paired transfers keep their accounts — delete and re-enter to change them'
  )

  const gone = deleteEntries(resized, [text(inLeg, 'id')])
  assert.equal(gone.removed.length, 2, 'a leg takes its twin with it')
  assert.equal(entries(gone.tables).length, 0)
})

test('a round-up is the purchase’s, not the sweep’s to edit', () => {
  const tables = ledger()
  tables.settings = [
    lifecycle({ id: 'roundUpEnabled', key: 'roundUpEnabled', value: 'true' }),
    lifecycle({ id: 'roundUpAccountId', key: 'roundUpAccountId', value: 'sav' }),
    lifecycle({ id: 'roundUpToCents', key: 'roundUpToCents', value: '100' })
  ]
  const purchase = createEntry(tables, {
    accountId: 'chk',
    kind: 'expense',
    amountCents: 4_530,
    occurredOn: todayISO(),
    memo: 'Coffee beans',
    category: 'Food'
  })
  const sweeps = entries(purchase.tables).filter(
    (row) => nullableText(row, 'round_up_source_id') === purchase.id
  )
  assert.equal(sweeps.length, 2)
  assert.equal(cents(sweeps[0]!, 'amount_cents'), -70)
  assert.equal(cents(sweeps[1]!, 'amount_cents'), 70)
  assert.equal(text(sweeps[0]!, 'memo'), 'Round-up · Coffee beans')

  assert.equal(
    refusal(() => patchEntry(purchase.tables, text(sweeps[0], 'id'), { amountCents: 500 })).message,
    'This is a round-up sweep — edit the purchase it came from instead'
  )

  // An edit states the sign the way the stored row does; the desktop refuses a
  // positive amount on an expense rather than guessing at it.
  assert.equal(
    refusal(() => patchEntry(purchase.tables, purchase.id, { amountCents: 1_230 })).message,
    'An expense must be a negative amount'
  )

  // Rounding the purchase to 12.30 means a new sweep: the old pair goes, a fresh
  // one takes its place, and the purchase keeps the memo the user typed.
  const bigger = patchEntry(purchase.tables, purchase.id, { amountCents: -1_230 })
  const live = entries(bigger)
  assert.equal(live.length, 3, 'one purchase and one new pair')
  assert.equal(cents(rowOf(bigger, purchase.id), 'amount_cents'), -1_230)
  const fresh = live.filter((row) => nullableText(row, 'round_up_source_id') === purchase.id)
  assert.equal(fresh.length, 2)
  assert.deepEqual(
    [cents(fresh[0]!, 'amount_cents'), cents(fresh[1]!, 'amount_cents')],
    [-70, 70],
    '12.30 rounds up to 13.00'
  )

  const deleted = deleteEntries(bigger, [purchase.id])
  assert.equal(deleted.removed.length, 3, 'the purchase takes both of its sweeps')
})

test('an entry retyped to a kind that cannot carry its link drops it', () => {  const tables = ledger()
  const payment = createEntry(tables, {
    accountId: 'chk',
    kind: 'bill_payment',
    amountCents: 120_000,
    occurredOn: todayISO(),
    memo: 'Rent',
    category: 'Bills',
    billId: 'rent'
  })
  const asIncome = patchEntry(payment.tables, payment.id, { kind: 'income', amountCents: 120_000 })
  const row = rowOf(asIncome, payment.id)
  assert.equal(nullableText(row, 'bill_id'), null)
  assert.equal(cents(row, 'amount_cents'), 120_000)

  assert.equal(
    refusal(() => patchEntry(asIncome, payment.id, { kind: 'transfer' })).message,
    'Transfers need two accounts — delete this entry and record a transfer instead'
  )
  assert.equal(
    refusal(() => patchEntry(asIncome, payment.id, { amountCents: -1 })).message,
    'Income must be a positive amount'
  )
  assert.equal(requireLiveRow(asIncome, 'transactions', payment.id).id, payment.id)
})

test('a lone leg from an old backup stays a transfer until it is re-entered', () => {
  const tables = ledger()
  tables.transactions = [
    lifecycle({
      id: 'lone',
      account_id: 'chk',
      kind: 'transfer',
      amount_cents: -8_000,
      occurred_on: '2026-10-04',
      memo: 'Old move',
      category: 'Income',
      category_id: null,
      bill_id: null,
      goal_id: null,
      paycheck_id: null,
      counter_account_id: 'sav',
      transfer_group_id: null,
      round_up_source_id: null
    })
  ]
  assert.equal(
    refusal(() => patchEntry(tables, 'lone', { kind: 'expense' })).message,
    'Paired transfers keep their kind — delete and re-enter to change it'
  )

  const renamed = patchEntry(tables, 'lone', { memo: 'Older move' })
  assert.equal(text(rowOf(renamed, 'lone'), 'memo'), 'Older move')
  assert.equal(cents(rowOf(renamed, 'lone'), 'amount_cents'), -8_000, 'the sign it stored is its own')

  const removed = deleteEntries(renamed, ['lone'])
  assert.equal(removed.removed.length, 1, 'with no twin to take, only the row goes')
})

test('a transfer leaves both of its legs on this phone', () => {
  const tables = ledger()
  const moved = createEntry(tables, {
    accountId: 'chk',
    kind: 'transfer',
    amountCents: 30_000,
    occurredOn: todayISO(),
    memo: 'To savings',
    category: 'Transfer',
    counterAccountId: 'sav'
  })
  const created = insertedEntryIds(tables, moved.tables)
  assert.equal(created.length, 2, 'the leg out and the leg in')
  assert.ok(created.includes(moved.id), 'the writer still hands back one of them')
  assert.deepEqual(
    created.slice().sort(),
    entries(moved.tables).map((row) => text(row, 'id')).sort(),
    'and the phone owns every row the form posted'
  )
})

test('a purchase that rounds up brings its sweep with it', () => {
  const tables = ledger()
  tables.settings = [
    lifecycle({ id: 'roundUpEnabled', key: 'roundUpEnabled', value: 'true' }),
    lifecycle({ id: 'roundUpAccountId', key: 'roundUpAccountId', value: 'sav' }),
    lifecycle({ id: 'roundUpToCents', key: 'roundUpToCents', value: '100' })
  ]
  const purchase = createEntry(tables, {
    accountId: 'chk',
    kind: 'expense',
    amountCents: 4_530,
    occurredOn: todayISO(),
    memo: 'Coffee beans',
    category: 'Food'
  })
  assert.equal(insertedEntryIds(tables, purchase.tables).length, 3)
})

test('an edit or a delete claims no new row', () => {
  const tables = ledger()
  const spent = createEntry(tables, {
    accountId: 'card',
    kind: 'expense',
    amountCents: 5_000,
    occurredOn: todayISO(),
    memo: 'Fuel',
    category: 'Travel'
  })
  assert.equal(insertedEntryIds(tables, spent.tables).length, 1)

  const renamed = patchEntry(spent.tables, spent.id, { memo: 'Fuel top-up' })
  assert.deepEqual(insertedEntryIds(spent.tables, renamed), [], 'a row that was here stays somebody else\'s')

  const gone = deleteEntries(renamed, [spent.id]).tables
  assert.deepEqual(insertedEntryIds(renamed, gone), [])
})

test('a bill or a goal added here is not counted as an entry', () => {
  const tables = ledger()
  const bill = createBill(tables, {
    name: 'Internet',
    amountCents: 6_900,
    frequency: 'monthly',
    dueDay: 15,
    category: '',
    accountId: 'chk',
    autopay: true,
    isActive: true,
    nextDueOn: null,
    fundingStrategy: 'all_checks',
    fundingPaycheckIndex: null
  })
  assert.deepEqual(insertedEntryIds(tables, bill.tables), [], 'the screens count these against the ledger')

  const goal = createGoal(bill.tables, {
    name: 'Holiday',
    targetCents: 250_000,
    targetDate: '2027-06-01',
    priority: 3,
    color: 'var(--leisure)',
    accountId: 'sav',
    isEmergency: false,
    fundingPace: 'asap',
    fundingAccountIds: []
  })
  assert.deepEqual(insertedEntryIds(bill.tables, goal.tables), [])
})

test('paying a bill here settles the claim the cheque left open', () => {
  const paid = payBill(withClaim(ledger()), 'rent')
  const claim = rowOf(paid.tables, 'claim-1')
  assert.equal(text(claim, 'state'), 'paid')
  assert.equal(nullableText(claim, 'settled_by'), paid.id)
  assert.equal(cents(claim, 'revision'), 2, 'the claim moved, so this phone has a newer copy to export')
})

test('deleting the payment here reopens the claim it had settled', () => {
  const paid = payBill(withClaim(ledger()), 'rent')
  const removed = deleteEntries(paid.tables, [paid.id])
  const claim = rowOf(removed.tables, 'claim-1')
  assert.equal(text(claim, 'state'), 'reserved', 'a bill is not paid by a row that left the ledger')
  assert.equal(nullableText(claim, 'settled_by'), null)
  assert.equal(cents(claim, 'revision'), 3)
})

test('a part payment holds the claim open and rewrites nothing', () => {
  const tables = withClaim(ledger())
  const part = createEntry(tables, {
    accountId: 'chk',
    kind: 'bill_payment',
    amountCents: -40_000,
    occurredOn: todayISO(),
    memo: 'Part of rent',
    category: 'Bills',
    billId: 'rent'
  })
  const claim = rowOf(part.tables, 'claim-1')
  assert.equal(text(claim, 'state'), 'reserved')
  assert.equal(cents(claim, 'revision'), 1, 'an unchanged claim keeps the computer’s copy instead of being shouted over in a merge')
})

test('cutting a payment back reopens the claim it closed', () => {
  const paid = payBill(withClaim(ledger()), 'rent')
  const trimmed = patchEntry(paid.tables, paid.id, { amountCents: -20_000 })
  assert.equal(text(rowOf(trimmed, 'claim-1'), 'state'), 'reserved')
})

test('an edit that carries its category writes the row it was shown', () => {
  // The phone's entry sheet sends the category with every save, so a patch that
  // resolves a category must not take the pre-edit rows back with it.
  const paid = payBill(withClaim(ledger()), 'rent')
  const edited = patchEntry(paid.tables, paid.id, {
    amountCents: -6_000,
    occurredOn: todayISO(),
    accountId: 'chk',
    kind: 'bill_payment',
    memo: 'Rent',
    category: 'Bills',
    categoryId: null
  })
  const row = rowOf(edited, paid.id)
  assert.equal(cents(row, 'amount_cents'), -6_000)
  assert.equal(cents(row, 'revision'), 2)
  assert.equal(text(rowOf(edited, 'claim-1'), 'state'), 'reserved')
})

test('deleting the account that held the payment takes the settlement back', () => {
  const paid = payBill(withClaim(ledger()), 'rent')
  const removed = deleteAccount(paid.tables, 'chk', { withEntries: true })
  assert.equal(text(rowOf(removed, 'claim-1'), 'state'), 'reserved')
})

test('opening a file replays the payments the phone made after it was written', () => {
  // The claim arrives holding the state the computer derived before this phone's
  // payment existed, so the merged ledger must be re-derived, not trusted.
  const paid = payBill(ledger(), 'rent')
  const merged = reconcileAllBillClaims(withClaim(paid.tables))
  assert.equal(text(rowOf(merged, 'claim-1'), 'state'), 'paid')
})

test('reconciling a ledger that already agrees leaves every row exactly as it was', () => {
  const paid = payBill(withClaim(ledger()), 'rent')
  assert.deepEqual(reconcileAllBillClaims(paid.tables).bill_reserves, paid.tables.bill_reserves)
})

test('a split transfer writes every line as a pair, or nothing', () => {
  const tables = ledger()
  const written = createSplitTransfer(tables, {
    sourceAccountId: 'chk',
    viaAccountId: 'sav',
    occurredOn: todayISO(),
    lines: [
      { accountId: 'sav', amountCents: 100_00 },
      { accountId: 'card', amountCents: 40_00, category: 'Debt' }
    ]
  })
  const rows = entries(written.tables)
  assert.equal(rows.length, 4, 'the hop into savings and the card payment, two legs each')
  assert.deepEqual(
    rows
      .filter((row) => cents(row, 'amount_cents') < 0)
      .map((row) => [text(row, 'account_id'), nullableText(row, 'counter_account_id'), cents(row, 'amount_cents')]),
    [
      ['chk', 'sav', -140_00],
      ['sav', 'card', -40_00]
    ]
  )
  assert.equal(nullableText(rowOf(written.tables, written.id), 'counter_account_id'), 'sav')
  assert.deepEqual(insertedEntryIds(tables, written.tables).length, 4)

  // A refusal on the second line throws before any table is handed back.
  const refused = refusal(() =>
    createSplitTransfer(tables, {
      sourceAccountId: 'chk',
      viaAccountId: 'card',
      occurredOn: todayISO(),
      lines: [{ accountId: 'sav', amountCents: 10_00 }]
    })
  )
  assert.match(refused.message, /can’t be transferred out of a credit card/)
  assert.equal(entries(tables).length, 0, 'the ledger it started from is untouched')
})

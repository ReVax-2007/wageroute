import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import test from 'node:test'
import { addDaysISO, todayISO } from '@shared/dates'
import { mergeEntries } from './entries'
import { migrate } from './migrations'
import {
  accountEntryCount,
  commitPaycheck,
  createAccount,
  createBill,
  createGoal,
  createTransaction,
  deleteAccount,
  deleteTransaction,
  getSnapshot,
  listAccounts,
  listBills,
  listImportChoices,
  listTransactions,
  readSettings,
  setAccountArchived,
  transactionRowsFor,
  updateTransaction,
  updateGoal,
  writeSettings
} from './repositories'

const USER_ID = '11111111-2222-3333-4444-555555555555'

function freshDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  migrate(db)
  db.prepare(
    `INSERT INTO users (id, display_name, created_at, updated_at)
     VALUES (?, 'Tester', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
  ).run(USER_ID)
  return db
}

function account(db: Database.Database, name: string, kind = 'checking'): string {
  return createAccount(db, USER_ID, {
    name,
    kind: kind as never,
    institution: '',
    startingBalanceCents: 0,
    creditLimitCents: null
  })
}

function entry(
  db: Database.Database,
  accountId: string,
  input: { kind?: string; amountCents: number; counterAccountId?: string }
): string {
  return createTransaction(db, USER_ID, {
    accountId,
    kind: (input.kind ?? 'expense') as never,
    amountCents: input.amountCents,
    occurredOn: '2026-03-01',
    category: 'Misc',
    memo: 'test',
    counterAccountId: input.counterAccountId ?? null
  })
}

test('the repository writes the sign its kind demands', () => {
  const db = freshDb()
  const chequing = account(db, 'Chequing')

  entry(db, chequing, { kind: 'expense', amountCents: 4_200 })
  entry(db, chequing, { kind: 'income', amountCents: -90_000 })

  const amounts = listTransactions(db, USER_ID).map((row) => row.amountCents)
  assert.deepEqual(amounts.sort((a, b) => a - b), [-4_200, 90_000])
})

test('turning a single entry into a transfer is refused', () => {
  const db = freshDb()
  const chequing = account(db, 'Chequing')
  account(db, 'Savings', 'savings')
  const id = entry(db, chequing, { amountCents: -1_000 })

  assert.throws(() => updateTransaction(db, USER_ID, id, { kind: 'transfer' }), /need two accounts/)
})

test('a transfer leg keeps its account and kind, and edits mirror onto its twin', () => {
  const db = freshDb()
  const chequing = account(db, 'Chequing')
  const savings = account(db, 'Savings', 'savings')
  account(db, 'Credit', 'credit')
  const outId = entry(db, chequing, {
    kind: 'transfer',
    amountCents: -25_000,
    counterAccountId: savings
  })

  assert.throws(
    () => updateTransaction(db, USER_ID, outId, { accountId: account(db, 'Credit', 'credit') }),
    /Paired transfers keep their accounts/
  )

  updateTransaction(db, USER_ID, outId, { amountCents: 30_000 })
  const legs = listTransactions(db, USER_ID)
    .filter((row) => row.kind === 'transfer')
    .map((row) => row.amountCents)
    .sort((a, b) => a - b)
  assert.deepEqual(legs, [-30_000, 30_000])
})

test('an account with entries cannot be deleted without saying so', () => {
  const db = freshDb()
  const chequing = account(db, 'Chequing')
  entry(db, chequing, { amountCents: -1_500 })

  assert.equal(accountEntryCount(db, USER_ID, chequing), 1)
  assert.throws(() => deleteAccount(db, USER_ID, chequing), /still has entries/)

  deleteAccount(db, USER_ID, chequing, { withEntries: true })
  assert.equal(accountEntryCount(db, USER_ID, chequing), 0)
  assert.equal(listAccounts(db, USER_ID).length, 0)
})

test('deleting an account with entries takes both legs of its transfers', () => {
  const db = freshDb()
  const chequing = account(db, 'Chequing')
  const savings = account(db, 'Savings', 'savings')
  entry(db, chequing, { kind: 'transfer', amountCents: -40_000, counterAccountId: savings })

  deleteAccount(db, USER_ID, chequing, { withEntries: true })

  assert.deepEqual(listTransactions(db, USER_ID), [])
  assert.equal(accountEntryCount(db, USER_ID, savings), 0, 'the other leg goes too')
})

test('archiving keeps an account and its history out of the working totals', () => {
  const db = freshDb()
  const chequing = account(db, 'Chequing')
  entry(db, chequing, { amountCents: -2_500 })

  setAccountArchived(db, USER_ID, chequing, true)

  const [archived] = listAccounts(db, USER_ID)
  assert.equal(archived?.isArchived, true)
  assert.equal(archived?.balanceCents, -2_500, 'the history still adds up')
  assert.equal(listTransactions(db, USER_ID).length, 1)
})

test('a CSV row whose sign contradicts its kind is reported, not written', () => {
  const db = freshDb()
  account(db, 'Chequing')

  const result = mergeEntries(db, USER_ID, [
    {
      line: 2,
      occurredOn: '2026-03-04',
      accountName: 'Chequing',
      institution: null,
      kind: 'expense',
      category: 'Misc',
      memo: 'wrong way round',
      amountCents: 9_900,
      externalId: null
    },
    {
      line: 3,
      occurredOn: '2026-03-05',
      accountName: 'Chequing',
      institution: null,
      kind: 'expense',
      category: 'Misc',
      memo: 'fine',
      amountCents: -9_900,
      externalId: null
    }
  ])

  assert.equal(result.added, 1)
  assert.equal(result.issues.length, 1)
  assert.match(result.issues[0]?.message ?? '', /row 2: An expense must be a negative amount/)
})

test('an archived goal gets no slice of a paycheck', () => {
  const db = freshDb()
  const chequing = account(db, 'Chequing')
  const goalId = createGoal(db, USER_ID, {
    name: 'New laptop',
    targetCents: 200_000,
    targetDate: null,
    priority: 1,
    color: '#38BDF8',
    accountId: null,
    isEmergency: false
  })
  db.prepare('UPDATE goals SET is_archived = 1 WHERE id = ?').run(goalId)

  const { plan } = commitPaycheck(db, USER_ID, {
    incomeCents: 400_000,
    receivedOn: '2026-03-15',
    source: 'Paycheck',
    depositAccountId: chequing,
    payCadence: 'semimonthly',
    splits: { savingsPercent: 0, investmentPercent: 0, goalsPercent: 0, debtPercent: 0 },
    wholeDollarBuckets: false
  })

  assert.ok(plan)
  assert.equal(plan.goalFundings.length, 0)
  assert.equal(getSnapshot(db, USER_ID).goals[0]?.fundedCents, 0)
})

test('an impossible calendar date is refused on write', () => {
  const db = freshDb()
  const chequing = account(db, 'Chequing')

  assert.throws(
    () =>
      createTransaction(db, USER_ID, {
        accountId: chequing,
        kind: 'expense',
        amountCents: 4_200,
        occurredOn: '2026-02-31',
        category: 'Misc',
        memo: 'impossible',
        counterAccountId: null
      }),
    /YYYY-MM-DD/
  )
  assert.equal(listTransactions(db, USER_ID).length, 0)
})

test('updating a goal that does not exist changes nothing', () => {
  const db = freshDb()
  const chequing = account(db, 'Chequing')

  assert.throws(
    () =>
      updateGoal(db, USER_ID, 'missing-goal', {
        name: 'Ghost',
        fundingAccountIds: [chequing]
      }),
    /Goal not found/
  )
  const pointer = db
    .prepare('SELECT dedicated_goal_id FROM accounts WHERE id = ?')
    .get(chequing) as { dedicated_goal_id: string | null }
  assert.equal(pointer.dedicated_goal_id, null, 'no dangling pointer was written')
})

test('an archived account cannot receive a new entry', () => {
  const db = freshDb()
  const chequing = account(db, 'Chequing')
  setAccountArchived(db, USER_ID, chequing, true)

  assert.throws(() => entry(db, chequing, { amountCents: -500 }), /archived/)
  assert.equal(listTransactions(db, USER_ID).length, 0)
})

test('a row that is not a transfer cannot carry a destination account', () => {
  const db = freshDb()
  const chequing = account(db, 'Chequing')
  const savings = account(db, 'Savings', 'savings')

  assert.throws(
    () => entry(db, chequing, { amountCents: -500, counterAccountId: savings }),
    /Only a transfer/
  )
  assert.equal(listTransactions(db, USER_ID).length, 0)
})

test('a round-up sweep memo stays inside the memo limit', () => {
  const db = freshDb()
  const chequing = account(db, 'Chequing')
  const savings = account(db, 'Savings', 'savings')
  writeSettings(db, USER_ID, {
    roundUpEnabled: 'true',
    roundUpAccountId: savings,
    roundUpToCents: '100'
  })

  createTransaction(db, USER_ID, {
    accountId: chequing,
    kind: 'expense',
    amountCents: -1_001,
    occurredOn: '2026-03-01',
    category: 'Misc',
    memo: 'm'.repeat(240),
    counterAccountId: null
  })

  const sweeps = listTransactions(db, USER_ID).filter((row) => row.memo.startsWith('Round-up'))
  assert.equal(sweeps.length, 2, 'both legs of the sweep posted')
  for (const sweep of sweeps) {
    assert.ok(sweep.memo.length <= 240)
    assert.ok(sweep.memo.endsWith('…'))
  }
})

test('cash on hand leaves money dated in the future out of the pool', () => {
  const db = freshDb()
  const chequing = account(db, 'Chequing')
  db.prepare('UPDATE accounts SET starting_balance_cents = 10000 WHERE id = ?').run(chequing)

  createTransaction(db, USER_ID, {
    accountId: chequing,
    kind: 'expense',
    amountCents: -1_000,
    occurredOn: addDaysISO(todayISO(), -3),
    category: 'Misc',
    memo: 'already spent',
    counterAccountId: null
  })
  createTransaction(db, USER_ID, {
    accountId: chequing,
    kind: 'income',
    amountCents: 5_000,
    occurredOn: addDaysISO(todayISO(), 20),
    category: 'Misc',
    memo: 'payday later',
    counterAccountId: null
  })

  const [row] = listAccounts(db, USER_ID)
  assert.equal(row?.balanceCents, 14_000, 'the ledger balance counts every entry')
  assert.equal(row?.cashCents, 9_000, 'only settled money is spendable today')
})

test('the snapshot says how many entries exist beyond the grid cap', () => {
  const db = freshDb()
  const chequing = account(db, 'Chequing')
  for (let index = 0; index < 3; index += 1) {
    entry(db, chequing, { amountCents: -(index + 1) })
  }

  const snapshot = getSnapshot(db, USER_ID)
  assert.equal(snapshot.transactions.length, 3)
  assert.equal(snapshot.transactionTotal, 3)
  assert.equal(listTransactions(db, USER_ID, 2).length, 2, 'the grid query is capped')
  assert.equal(getSnapshot(db, USER_ID).transactionTotal, 3, 'the count is not')
})

test('editing or deleting a row that is gone reports it instead of pretending', () => {
  const db = freshDb()
  assert.throws(() => updateTransaction(db, USER_ID, 'missing', { memo: 'ghost' }), /Entry not found/)
  assert.throws(() => deleteTransaction(db, USER_ID, 'missing'), /Entry not found/)
})

test('an edited amount cannot be zero, and the row keeps what it had', () => {
  const db = freshDb()
  const chequing = account(db, 'Chequing')
  const id = entry(db, chequing, { amountCents: -2_500 })

  assert.throws(() => updateTransaction(db, USER_ID, id, { amountCents: 0 }), /Amount cannot be zero/)
  assert.equal(listTransactions(db, USER_ID)[0]?.amountCents, -2_500)
})

test('losing the round-up destination turns the sweep off, and restoring it stays off', () => {
  const db = freshDb()
  const savings = account(db, 'Savings', 'savings')
  writeSettings(db, USER_ID, {
    roundUpEnabled: 'true',
    roundUpAccountId: savings,
    roundUpToCents: '100'
  })

  setAccountArchived(db, USER_ID, savings, true)
  assert.equal(readSettings(db, USER_ID).roundUpEnabled, 'false', 'archiving stopped the sweep')

  writeSettings(db, USER_ID, { roundUpEnabled: 'true' })
  setAccountArchived(db, USER_ID, savings, false)
  assert.equal(readSettings(db, USER_ID).roundUpEnabled, 'true', 'restoring leaves the flag alone')

  deleteAccount(db, USER_ID, savings)
  assert.equal(readSettings(db, USER_ID).roundUpEnabled, 'false', 'deleting stopped it again')
})

test('archiving an account that is not the sweep destination leaves the sweep on', () => {
  const db = freshDb()
  const chequing = account(db, 'Chequing')
  const savings = account(db, 'Savings', 'savings')
  writeSettings(db, USER_ID, {
    roundUpEnabled: 'true',
    roundUpAccountId: savings,
    roundUpToCents: '100'
  })

  setAccountArchived(db, USER_ID, chequing, true)
  assert.equal(readSettings(db, USER_ID).roundUpEnabled, 'true')
})

test('a bill day and a paycheck slot outside their ranges are refused', () => {
  const db = freshDb()
  const base = {
    name: 'Rent',
    amountCents: 185_000,
    frequency: 'monthly' as const,
    dueDay: 1,
    category: 'Housing',
    accountId: null,
    autopay: false,
    isActive: true,
    nextDueOn: null
  }

  const clamped = createBill(db, USER_ID, { ...base, dueDay: 99 })
  const dueDay = db.prepare('SELECT due_day FROM bills WHERE id = ?').get(clamped) as {
    due_day: number
  }
  assert.equal(dueDay.due_day, 31, 'a day past the month end clamps instead of inventing one')

  assert.throws(
    () => createBill(db, USER_ID, { ...base, dueDay: Number.NaN }),
    /Due day must be a number/
  )
  assert.throws(
    () =>
      createBill(db, USER_ID, {
        ...base,
        fundingStrategy: 'specific_check',
        fundingPaycheckIndex: 7
      }),
    /1st through the 4th/
  )
  assert.equal(listBills(db, USER_ID).length, 1)
})

test('the import wizard sees every account, not a capped slice', () => {
  const db = freshDb()
  for (let index = 0; index < 205; index += 1) account(db, `Account ${index}`)

  const choices = listImportChoices(db, USER_ID)
  assert.equal(choices.accounts.length, 205)
  assert.ok(choices.accounts.some((choice) => choice.label === 'Account 204'))
})

test('an account flag and a sort order must be real values, not strings', () => {
  const db = freshDb()
  assert.throws(
    () =>
      createAccount(db, USER_ID, {
        name: 'Cash',
        kind: 'cash',
        institution: '',
        startingBalanceCents: 0,
        inSafeToSpend: 'false' as never
      }),
    /true or false/
  )
  assert.throws(
    () =>
      createAccount(db, USER_ID, {
        name: 'Cash',
        kind: 'cash',
        institution: '',
        startingBalanceCents: 0,
        sortOrder: 'first' as never
      }),
    /Sort order must be a number/
  )
  assert.equal(listAccounts(db, USER_ID).length, 0)
})

test('imported text is cleaned to the limits the app itself enforces', () => {
  const db = freshDb()
  account(db, 'Chequing')

  const result = mergeEntries(db, USER_ID, [
    {
      line: 4,
      occurredOn: '2026-03-04',
      accountName: 'Chequing',
      institution: null,
      kind: 'expense',
      category: 'C'.repeat(80),
      memo: `bad\u0000memo ${'x'.repeat(300)}`,
      amountCents: -1_000,
      externalId: null
    }
  ])

  assert.equal(result.added, 1)
  assert.match(result.issues[0]?.message ?? '', /row 4: .*trimmed/)
  const [row] = listTransactions(db, USER_ID)
  assert.equal(row?.memo.length, 240)
  assert.equal(row?.category.length, 60)
  assert.ok(!row?.memo.includes('\u0000'))
})


test('a ledger edit names its own row instead of re-reading the window', () => {
  const db = freshDb()
  const checking = account(db, 'Chequing')
  const id = entry(db, checking, { amountCents: -1_000 })

  const rows = transactionRowsFor(db, USER_ID, id)
  assert.deepEqual(
    rows.map((row) => row.id),
    [id]
  )
})

test('a transfer edit brings both legs back', () => {
  const db = freshDb()
  const checking = account(db, 'Chequing')
  const savings = account(db, 'Savings', 'savings')
  const outId = entry(db, checking, {
    kind: 'transfer',
    amountCents: 5_000,
    counterAccountId: savings
  })

  const rows = transactionRowsFor(db, USER_ID, outId)
  assert.equal(rows.length, 2)
  assert.deepEqual(
    new Set(rows.map((row) => row.accountId)),
    new Set([checking, savings])
  )
})

test('a round-up sweep comes back with the purchase that made it', () => {
  const db = freshDb()
  const checking = account(db, 'Chequing')
  const savings = account(db, 'Savings', 'savings')
  writeSettings(db, USER_ID, {
    roundUpEnabled: '1',
    roundUpAccountId: savings,
    roundUpToCents: '100'
  })
  const purchaseId = entry(db, checking, { amountCents: -1_040 })

  const rows = transactionRowsFor(db, USER_ID, purchaseId)
  assert.deepEqual(
    new Set(rows.map((row) => row.id)),
    new Set([
      purchaseId,
      ...listTransactions(db, USER_ID)
        .filter((row) => row.kind === 'transfer')
        .map((row) => row.id)
    ])
  )
  assert.equal(rows.length, 3, 'the purchase and both sweep legs')
})

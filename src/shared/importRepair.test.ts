import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applyImportAnswers,
  buildAccountMap,
  findImportProblems,
  findUnmappedAccounts,
  IMPORT_TABLES,
  withFileIds,
  type ImportAnswer,
  type ImportChoice,
  type ImportChoiceTable,
  type ImportContext,
  type ImportTables
} from './importRepair'

function emptyTables(): ImportTables {
  const tables = {} as ImportTables
  for (const table of IMPORT_TABLES) tables[table] = []
  return tables
}

/** The account map has a null prototype on purpose, so expectations must too. */
function nullMap(entries: Record<string, string>): Record<string, string> {
  return Object.assign(Object.create(null) as Record<string, string>, entries)
}

const ACCOUNT_CHOICES: ImportChoice[] = [
  { id: 'acc-checking', label: 'Everyday checking' },
  { id: 'acc-cash', label: 'Cash' }
]

function context(overrides: Partial<ImportContext> = {}): ImportContext {
  const choices: Record<ImportChoiceTable, ImportChoice[]> = {
    accounts: ACCOUNT_CHOICES,
    categories: [],
    bills: [],
    goals: [{ id: 'goal-1', label: 'Emergency fund' }],
    paychecks: [{ id: 'pay-1', label: '2026-02-15 · Paycheck' }]
  }
  const knownIds = {} as Record<string, Set<string>>
  for (const table of IMPORT_TABLES) knownIds[table] = new Set<string>()
  for (const table of Object.keys(choices) as ImportChoiceTable[]) {
    for (const choice of choices[table]) knownIds[table].add(choice.id)
  }
  return { knownIds, choices, today: '2026-03-01', ...overrides }
}

test('a complete backup needs nothing from the wizard', () => {
  const tables = emptyTables()
  tables.accounts.push({
    id: 'acc-checking',
    name: 'Everyday checking',
    kind: 'checking',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z'
  })
  tables.transactions.push({
    id: 'txn-1',
    account_id: 'acc-checking',
    kind: 'expense',
    amount_cents: 4500,
    occurred_on: '2026-02-16'
  })

  assert.deepEqual(findImportProblems(tables, context()), [])
})

test('missing, invalid and dangling values each become one question', () => {
  const tables = emptyTables()
  tables.bills.push({ id: 'bill-1', name: 'Rent', frequency: 'fortnightly', due_day: 45 })
  tables.transactions.push({
    id: 'txn-1',
    account_id: 'acc-nope',
    kind: 'expense',
    amount_cents: 'twelve',
    occurred_on: 'yesterday',
    counter_account_id: 'acc-also-nope'
  })

  const problems = findImportProblems(tables, context())
  const keys = problems.map((problem) => problem.key)

  assert.ok(keys.includes('b:bills:0:amount_cents'), 'missing bill amount is asked for')
  assert.ok(keys.includes('b:bills:0:frequency'), 'bad frequency is asked for')
  assert.ok(keys.includes('b:bills:0:due_day'), 'out-of-range due_day is asked for')
  assert.ok(keys.includes('b:transactions:0:account_id'), 'dangling account is asked for')
  assert.ok(keys.includes('b:transactions:0:amount_cents'), 'non-numeric amount is asked for')
  assert.ok(keys.includes('b:transactions:0:occurred_on'), 'bad date is asked for')
  assert.ok(
    keys.includes('b:transactions:0:counter_account_id'),
    'a dangling nullable reference is offered as clear-or-repoint'
  )
  assert.equal(new Set(keys).size, keys.length, 'each question is unique')

  const amount = problems.find((problem) => problem.key === 'b:bills:0:amount_cents')
  assert.equal(amount?.field.input, 'money')
  assert.match(amount?.fixHint ?? '', /amount_cents/)
  assert.equal(
    problems.find((problem) => problem.key === 'b:transactions:0:occurred_on')?.suggested,
    '2026-03-01',
    'dates default to today'
  )
})

test('nullable references may stay absent, required ones cannot', () => {
  const tables = emptyTables()
  tables.goals.push({ id: 'goal-1', name: 'Emergency fund', target_cents: 60000 })
  tables.allocations.push({
    id: 'alloc-1',
    label: 'Rent',
    bucket: 'priority',
    amount_cents: 120000
  })

  const problems = findImportProblems(tables, context())
  assert.deepEqual(
    problems.map((problem) => problem.key),
    ['b:allocations:0:paycheck_id'],
    'a goal with no linked account is fine, an allocation with no paycheck is not'
  )
})

test('answers repair rows, and a row nobody answered is dropped instead of thrown', () => {
  const tables = emptyTables()
  tables.bills.push({ id: 'bill-1', name: 'Rent', frequency: 'fortnightly', due_day: 45 })
  const problems = findImportProblems(tables, context())

  const answers: ImportAnswer[] = [
    { key: 'b:bills:0:amount_cents', value: '1250.50', skip: false },
    { key: 'b:bills:0:frequency', value: 'monthly', skip: false },
    { key: 'b:bills:0:due_day', value: '45', skip: true }
  ]
  const repaired = applyImportAnswers(tables, problems, answers, context())

  assert.equal(repaired.tables.bills.length, 0, 'skipping one field drops the whole row')
  assert.equal(repaired.dropped.length, 1)
  assert.match(repaired.dropped[0].reason, /skipped on request/)
  assert.match(repaired.dropped[0].fixHint, /due_day/)

  const allAnswered = applyImportAnswers(
    tables,
    problems,
    [
      ...answers.filter((answer) => answer.key !== 'b:bills:0:due_day'),
      { key: 'b:bills:0:due_day', value: '1', skip: false }
    ],
    context()
  )
  assert.equal(allAnswered.tables.bills.length, 1)
  assert.equal(allAnswered.tables.bills[0].amount_cents, 125050)
  assert.equal(allAnswered.tables.bills[0].frequency, 'monthly')
  assert.deepEqual(allAnswered.dropped, [])
})

test('an answer that is still invalid drops the row with the validation message', () => {
  const tables = emptyTables()
  tables.bills.push({ id: 'bill-1', name: 'Rent', frequency: 'monthly', due_day: 1 })
  const problems = findImportProblems(tables, context())

  const result = applyImportAnswers(
    tables,
    problems,
    [{ key: 'b:bills:0:amount_cents', value: 'zero', skip: false }],
    context()
  )
  assert.equal(result.tables.bills.length, 0)
  assert.match(result.dropped[0].reason, /is not an amount/)
})

test('a blank required answer drops the row rather than reaching the database', () => {
  const tables = emptyTables()
  tables.bills.push({ id: 'bill-1', name: '', amount_cents: 1, frequency: 'monthly', due_day: 1 })
  const problems = findImportProblems(tables, context())

  const result = applyImportAnswers(tables, problems, [], context())
  assert.equal(result.tables.bills.length, 0)
  assert.match(result.dropped[0].reason, /left blank/)
})

test('clearing a nullable reference is an answer, not a drop', () => {
  const tables = emptyTables()
  tables.transactions.push({
    id: 'txn-1',
    account_id: 'acc-checking',
    kind: 'expense',
    amount_cents: 100,
    occurred_on: '2026-02-16',
    counter_account_id: 'acc-nope'
  })
  const problems = findImportProblems(tables, withFileIds(context(), tables))

  const result = applyImportAnswers(
    tables,
    problems,
    [{ key: 'b:transactions:0:counter_account_id', value: '', skip: false }],
    context()
  )
  assert.equal(result.tables.transactions.length, 1)
  assert.equal(result.tables.transactions[0].counter_account_id, null)
  assert.deepEqual(result.dropped, [])
})

test('rows inside the same file satisfy each other’s references', () => {
  const tables = emptyTables()
  tables.paychecks.push({
    id: 'pay-new',
    amount_cents: 250000,
    received_on: '2026-02-15',
    health: 'covered'
  })
  tables.allocations.push({
    id: 'alloc-1',
    paycheck_id: 'pay-new',
    label: 'Rental bond',
    bucket: 'goal',
    amount_cents: 50000
  })

  assert.deepEqual(findImportProblems(tables, withFileIds(context(), tables)), [])
})

test('the same reference looks dangling until the file’s own ids are added', () => {
  const tables = emptyTables()
  tables.allocations.push({
    id: 'alloc-1',
    paycheck_id: 'pay-new',
    label: 'Rental bond',
    bucket: 'goal',
    amount_cents: 50000
  })

  const problems = findImportProblems(tables, context())
  assert.equal(problems.length, 1)
  assert.equal(problems[0].reason, 'paycheck is not valid (pay-new)')
})

test('unmatched CSV account names collapse into one question each', () => {
  const entries = [
    { line: 3, accountName: 'Chase Freedom' },
    { line: 8, accountName: 'chase freedom ' },
    { line: 11, accountName: 'Everyday checking' }
  ]
  const mappings = findUnmappedAccounts(entries, new Set(['everyday checking']))

  assert.equal(mappings.length, 1)
  assert.equal(mappings[0].lines, 2, 'both spellings are one question')
  assert.equal(mappings[0].firstLine, 3)
  assert.equal(mappings[0].accountName, 'chase freedom')

  const map = buildAccountMap(mappings, [
    { key: 'e:3', value: 'acc-checking', skip: false },
    { key: 'e:99', value: 'acc-cash', skip: false }
  ])
  assert.deepEqual(map, nullMap({ 'chase freedom': 'acc-checking' }))

  assert.deepEqual(buildAccountMap(mappings, [{ key: 'e:3', value: '', skip: true }]), nullMap({}))
})

test('an account name that collides with Object.prototype is not mistaken for a mapping', () => {
  const entries = [
    { line: 1, accountName: 'constructor' },
    { line: 2, accountName: '__proto__' }
  ]
  const map = buildAccountMap(
    findUnmappedAccounts(entries, new Set()),
    [
      { key: 'e:1', value: 'acc-1', skip: false },
      { key: 'e:2', value: 'acc-2', skip: false }
    ]
  )
  assert.equal(map['constructor'], 'acc-1')
  assert.equal(map['__proto__'], 'acc-2')
  assert.equal(Object.getPrototypeOf(map), null)
})

test('the accounts and goals reference cycle restores in one pass', () => {
  const tables = emptyTables()
  tables.accounts.push({
    id: 'acc-1',
    name: 'Emergency Savings',
    kind: 'savings',
    dedicated_goal_id: 'goal-1',
    in_safe_to_spend: 0
  })
  tables.goals.push({ id: 'goal-1', name: 'Emergency fund', target_cents: 60000, account_id: 'acc-1' })

  assert.deepEqual(findImportProblems(tables, withFileIds(context(), tables)), [])
})

test('a dedicated account pointing at a goal that is not there is asked for', () => {
  const tables = emptyTables()
  tables.accounts.push({
    id: 'acc-1',
    name: 'Emergency Savings',
    kind: 'savings',
    dedicated_goal_id: 'goal-gone'
  })
  const problems = findImportProblems(tables, withFileIds(context(), tables))
  assert.deepEqual(
    problems.map((problem) => problem.key),
    ['b:accounts:0:dedicated_goal_id']
  )

  const result = applyImportAnswers(
    tables,
    problems,
    [{ key: 'b:accounts:0:dedicated_goal_id', value: '', skip: false }],
    context()
  )
  assert.equal(result.tables.accounts.length, 1)
  assert.equal(result.tables.accounts[0].dedicated_goal_id, null)
})

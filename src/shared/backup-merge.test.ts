import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import test from 'node:test'
import { parseEntriesCsv, type CsvEntry } from '@shared/csv'
import { buildBackup, mergeBackup, type BackupPayload } from '../main/db/backup'
import { mergeEntries } from '../main/db/entries'
import { migrate, SCHEMA_VERSION } from '../main/db/migrations'
import {
  buildAccountMap,
  findUnmappedAccounts,
  type EntryMapping,
  type ImportAnswer
} from './importRepair'

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
  assert.equal(account.color, null, 'no colour chosen means the account type still paints it')
  assert.equal(account.revision, 1)

  const bill = db.prepare('SELECT * FROM bills WHERE id = ?').get('bill-1') as Record<string, unknown>
  assert.equal(bill.category, 'Bills')
  assert.equal(bill.autopay, 0)
  assert.equal(bill.is_active, 1)
  assert.equal(bill.funding_strategy, 'all_checks', 'a pre-v5 bill keeps the spread it always had')
  assert.equal(bill.funding_paycheck_index, null)

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

test('one unusable row is reported instead of aborting the import', () => {
  const db = freshDb()
  const result = mergeBackup(
    db,
    USER_ID,
    payload({
      accounts: [
        {
          id: 'acc-ok',
          user_id: USER_ID,
          name: 'Good account',
          kind: 'checking',
          created_at: '2026-02-01T00:00:00.000Z',
          updated_at: '2026-02-01T00:00:00.000Z'
        },
        {
          id: 'acc-bad',
          user_id: USER_ID,
          name: 'Impossible account',
          kind: 'crypto',
          created_at: '2026-02-01T00:00:00.000Z',
          updated_at: '2026-02-01T00:00:00.000Z'
        }
      ],
      transactions: [
        {
          id: 'txn-orphan',
          user_id: USER_ID,
          account_id: 'acc-missing',
          kind: 'expense',
          amount_cents: 100,
          occurred_on: '2026-02-16'
        },
        {
          // No id at all: the importer mints one rather than refusing the row.
          user_id: USER_ID,
          account_id: 'acc-ok',
          kind: 'expense',
          amount_cents: 250,
          occurred_on: '2026-02-17'
        }
      ]
    })
  )

  assert.equal(result.added.accounts, 1, 'the valid account still imports')
  assert.equal(result.added.transactions, 1, 'the valid transaction still imports')
  assert.equal(result.generatedIds, 1)
  assert.equal(result.issues.length, 2)
  assert.match(
    result.issues.find((issue) => issue.message.includes('Impossible account'))?.message ?? '',
    /CHECK constraint failed/
  )
  assert.match(
    result.issues.find((issue) => issue.message.includes('transaction row 1'))?.message ?? '',
    /FOREIGN KEY constraint failed/
  )
})

test('a settings row without a key is skipped, not fatal', () => {
  const db = freshDb()
  const result = mergeBackup(
    db,
    USER_ID,
    payload({
      settings: [
        { user_id: USER_ID, key: 'theme', value: 'dark' },
        { user_id: USER_ID, value: 'orphan' }
      ]
    })
  )

  assert.equal(result.added.settings, 1)
  assert.equal(result.issues.length, 1)
  assert.match(result.issues[0].message, /no setting key/)
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

const CSV = [
  'date,account,kind,category,description,amount',
  '2026-02-03,Coffee Shop,expense,Food,Latte,-5.40',
  '2026-02-04,Everyday Cheque,expense,Food,Bread,-3.00'
].join('\n')

function localAccounts(db: Database.Database): { id: string; name: string }[] {
  return db.prepare('SELECT id, name FROM accounts WHERE user_id = ?').all(USER_ID) as {
    id: string
    name: string
  }[]
}

function unmappedNames(db: Database.Database, entries: CsvEntry[]): EntryMapping[] {
  const knownNames = new Set(
    localAccounts(db).map((account) => account.name.trim().toLocaleLowerCase())
  )
  return findUnmappedAccounts(entries, knownNames)
}

/** What the main process derives from the wizard's answers: a name map plus the names left out. */
function mappingFromAnswer(
  db: Database.Database,
  entries: CsvEntry[],
  answer: ImportAnswer
): { accountMap: Record<string, string>; reportedNames: Set<string> } {
  const mappings = unmappedNames(db, entries)
  const accountMap = buildAccountMap(mappings, [answer])
  const unmapped = mappings.filter((mapping) => !(mapping.accountName in accountMap))
  return { accountMap, reportedNames: new Set(unmapped.map((mapping) => mapping.accountName)) }
}

test('a CSV account name mapped in the wizard lands on the account chosen there', () => {
  const db = freshDb()
  mergeBackup(
    db,
    USER_ID,
    payload({ accounts: [{ id: 'acc-cheque', user_id: USER_ID, name: 'Everyday Cheque', kind: 'checking' }] })
  )

  const parsed = parseEntriesCsv(CSV)
  const [first] = unmappedNames(db, parsed.entries)
  const { accountMap, reportedNames } = mappingFromAnswer(db, parsed.entries, {
    key: `e:${first.firstLine}`,
    value: 'acc-cheque',
    skip: false
  })
  const merged = mergeEntries(db, USER_ID, parsed.entries, { accountMap, reportedNames })

  assert.equal(merged.added, 2)
  assert.deepEqual(merged.issues, [])
  const posting = db
    .prepare('SELECT account_id FROM transactions WHERE memo = ?')
    .get('Latte') as { account_id: string }
  assert.equal(posting.account_id, 'acc-cheque')
})

test('a CSV row nobody maps is left out once, and the rest still imports', () => {
  const db = freshDb()
  mergeBackup(
    db,
    USER_ID,
    payload({ accounts: [{ id: 'acc-cheque', user_id: USER_ID, name: 'Everyday Cheque', kind: 'checking' }] })
  )

  const parsed = parseEntriesCsv(CSV)
  const [first] = unmappedNames(db, parsed.entries)
  const { accountMap, reportedNames } = mappingFromAnswer(db, parsed.entries, {
    key: `e:${first.firstLine}`,
    value: '',
    skip: true
  })
  const merged = mergeEntries(db, USER_ID, parsed.entries, { accountMap, reportedNames })

  assert.equal(merged.added, 1)
  // The wizard already reported the name once, so the importer stays quiet about it.
  assert.deepEqual(merged.issues, [])
})

test('a mapping whose account disappeared reports the row instead of aborting', () => {
  const db = freshDb()
  mergeBackup(
    db,
    USER_ID,
    payload({ accounts: [{ id: 'acc-cheque', user_id: USER_ID, name: 'Everyday Cheque', kind: 'checking' }] })
  )

  const parsed = parseEntriesCsv(CSV)
  const merged = mergeEntries(db, USER_ID, parsed.entries, {
    accountMap: { 'coffee shop': 'acc-deleted' },
    reportedNames: new Set<string>()
  })

  assert.equal(merged.added, 1)
  assert.equal(merged.issues.length, 1)
  assert.match(merged.issues[0].message, /no longer exists/)
})

test('a dedicated account and its goal survive an export/import round trip', () => {
  const db = freshDb()
  const result = mergeBackup(
    db,
    USER_ID,
    payload({
      accounts: [
        {
          id: 'acc-1',
          user_id: USER_ID,
          name: 'Emergency Savings',
          kind: 'savings',
          dedicated_goal_id: 'goal-1',
          in_safe_to_spend: 0
        }
      ],
      goals: [
        {
          id: 'goal-1',
          user_id: USER_ID,
          name: 'Emergency fund',
          target_cents: 600_000,
          account_id: 'acc-1'
        }
      ]
    })
  )

  assert.deepEqual(result.issues, [], 'the accounts and goals cycle must not be refused')
  assert.equal(result.added.accounts, 1)
  assert.equal(result.added.goals, 1)

  const restored = db
    .prepare('SELECT dedicated_goal_id, in_safe_to_spend FROM accounts WHERE id = ?')
    .get('acc-1') as { dedicated_goal_id: string | null; in_safe_to_spend: number | null }
  assert.equal(restored.dedicated_goal_id, 'goal-1')
  assert.equal(restored.in_safe_to_spend, 0, 'an explicit opt-out must not import as NULL')

  const reExported = buildBackup(db, USER_ID)
  assert.equal(reExported.tables.accounts[0].dedicated_goal_id, 'goal-1')
  assert.equal(reExported.tables.accounts[0].in_safe_to_spend, 0)
})

import assert from 'node:assert/strict'
import Database from 'better-sqlite3-multiple-ciphers'
import test from 'node:test'
import { parseEntriesCsv, type CsvEntry } from '@shared/csv'
import { buildBackup, mergeBackup, TABLE_COLUMNS, TABLE_DEFAULTS, type BackupPayload } from '../main/db/backup'
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

/** `exportedAt` is when the file was written; rows stamped later are read as this. */
function payload(
  tables: Partial<BackupPayload['tables']>,
  exportedAt = '2026-01-01T00:00:00.000Z'
): BackupPayload {
  return {
    format: 'cash-flow-routing-backup',
    version: SCHEMA_VERSION,
    exportedAt,
    tables: {
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

test('a setting this build no longer has is reported, not restored', () => {
  const db = freshDb()
  const result = mergeBackup(
    db,
    USER_ID,
    payload({
      settings: [
        { user_id: USER_ID, key: 'theme', value: 'dark' },
        { user_id: USER_ID, key: 'leisurePercent', value: '10' }
      ]
    })
  )

  assert.equal(result.added.settings, 1, 'the key this build reads still imports')
  assert.equal(result.skipped.settings, 0, 'the stale key is refused, not counted as already present')
  assert.equal(result.issues.length, 1)
  assert.match(result.issues[0].message, /“leisurePercent” is not a setting this build knows/)
  const stale = db
    .prepare('SELECT COUNT(*) AS total FROM settings WHERE key = ?')
    .get('leisurePercent') as { total: number }
  assert.equal(stale.total, 0)
})

test('a restore leaves settings the file does not carry alone', () => {
  const db = freshDb()
  db.prepare(
    `INSERT INTO settings (user_id, key, value, updated_at)
     VALUES (?, 'theme', 'light', '2026-01-01T00:00:00.000Z')`
  ).run(USER_ID)

  const result = mergeBackup(
    db,
    USER_ID,
    payload({ settings: [{ user_id: USER_ID, key: 'savingsPercent', value: '35' }] })
  )

  assert.equal(result.added.settings, 1)
  const rows = db
    .prepare('SELECT key, value FROM settings WHERE user_id = ? ORDER BY key')
    .all(USER_ID) as { key: string; value: string }[]
  assert.deepEqual(rows, [
    { key: 'savingsPercent', value: '35' },
    { key: 'theme', value: 'light' }
  ])
})

test('the backup allowlist names every column the schema declares', () => {
  const db = freshDb()
  for (const table of Object.keys(TABLE_COLUMNS) as (keyof typeof TABLE_COLUMNS)[]) {
    const columns = TABLE_COLUMNS[table]
    const declared = (
      db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
    ).map((column) => column.name)
    assert.deepEqual(
      [...columns].sort(),
      [...declared].sort(),
      `${table}: a column added to the schema must join the allowlist or backups lose it`
    )
    for (const key of Object.keys(TABLE_DEFAULTS[table])) {
      assert.ok(columns.includes(key), `${table}.${key} is defaulted but not importable`)
    }
  }
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

test('a stamp from the future is clamped to the file’s export time, a real past stamp survives', () => {
  const db = freshDb()
  mergeBackup(
    db,
    USER_ID,
    payload({
      accounts: [
        {
          id: 'acc-future',
          user_id: USER_ID,
          name: 'Wrong clock',
          kind: 'checking',
          created_at: '2099-01-01T00:00:00.000Z',
          updated_at: '2099-01-01T00:00:00.000Z'
        },
        {
          id: 'acc-past',
          user_id: USER_ID,
          name: 'Real history',
          kind: 'savings',
          created_at: '2025-06-01T00:00:00.000Z',
          updated_at: '2025-06-01T00:00:00.000Z'
        }
      ],
      transactions: [
        {
          id: 'txn-future',
          user_id: USER_ID,
          account_id: 'acc-past',
          kind: 'expense',
          amount_cents: 500,
          occurred_on: '2026-02-16',
          created_at: '2026-02-16T00:00:00.000Z',
          updated_at: '2026-02-16T00:00:00.000Z',
          deleted_at: '2099-01-01T00:00:00.000Z'
        }
      ],
      settings: [
        {
          user_id: USER_ID,
          key: 'savingsPercent',
          value: '15',
          updated_at: '2099-01-01T00:00:00.000Z'
        }
      ]
    })
  )
  // Every device that opens this file reads the 2099 row as the same instant,
  // so two imports cannot disagree about which copy is newer.
  const future = db
    .prepare('SELECT created_at, updated_at FROM accounts WHERE id = ?')
    .get('acc-future') as { created_at: string; updated_at: string }
  for (const stamp of [future.created_at, future.updated_at]) {
    assert.equal(stamp, '2026-01-01T00:00:00.000Z', `${stamp} is the file's export time, not 2099`)
  }

  const past = db
    .prepare('SELECT created_at, updated_at FROM accounts WHERE id = ?')
    .get('acc-past') as { created_at: string; updated_at: string }
  assert.equal(past.created_at, '2025-06-01T00:00:00.000Z')
  assert.equal(past.updated_at, '2025-06-01T00:00:00.000Z')

  const tombstone = db
    .prepare('SELECT deleted_at FROM transactions WHERE id = ?')
    .get('txn-future') as { deleted_at: string }
  assert.equal(tombstone.deleted_at, '2026-01-01T00:00:00.000Z', 'a future tombstone is clamped too')

  const saved = db
    .prepare("SELECT updated_at FROM settings WHERE user_id = ? AND key = 'savingsPercent'")
    .get(USER_ID) as { updated_at: string }
  assert.equal(saved.updated_at, '2026-01-01T00:00:00.000Z', 'a setting written in 2099 lands at export')
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

test('a restored category that matches a local name reuses that row, not a twin', () => {
  const db = freshDb()
  const insert = db.prepare(
    `INSERT INTO categories (id, user_id, name, kind, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, 'expense', ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
  )
  insert.run('local-groceries', USER_ID, 'Groceries', 0)
  insert.run('local-cafe', USER_ID, 'Café', 1)

  const result = mergeBackup(
    db,
    USER_ID,
    payload({
      accounts: [{ id: 'acc-1', user_id: USER_ID, name: 'Chequing', kind: 'checking' }],
      categories: [
        { id: 'file-groceries', user_id: USER_ID, name: 'GROCERIES', kind: 'expense' },
        { id: 'file-cafe', user_id: USER_ID, name: 'CAFÉ', kind: 'expense' }
      ],
      transactions: [
        {
          id: 'txn-groceries',
          user_id: USER_ID,
          account_id: 'acc-1',
          kind: 'expense',
          amount_cents: -500,
          occurred_on: '2026-02-03',
          category: 'GROCERIES',
          category_id: 'file-groceries'
        },
        {
          id: 'txn-cafe',
          user_id: USER_ID,
          account_id: 'acc-1',
          kind: 'expense',
          amount_cents: -700,
          occurred_on: '2026-02-04',
          category: 'CAFÉ',
          category_id: 'file-cafe'
        }
      ]
    })
  )

  assert.equal(result.added.categories, 0, 'both names already exist locally')
  assert.equal(result.skipped.categories, 2)
  assert.deepEqual(result.issues, [], 'a name already present is not a failed row')

  const categories = db
    .prepare('SELECT id, name FROM categories WHERE user_id = ? ORDER BY name')
    .all(USER_ID) as { id: string; name: string }[]
  assert.deepEqual(
    categories.map((row) => row.id),
    ['local-cafe', 'local-groceries'],
    'the local rows are kept and no duplicate is inserted'
  )
  const links = db
    .prepare(
      `SELECT t.id, c.id AS categoryId FROM transactions t
       JOIN categories c ON c.id = t.category_id
       ORDER BY t.id`
    )
    .all() as { id: string; categoryId: string }[]
  assert.deepEqual(links, [
    { id: 'txn-cafe', categoryId: 'local-cafe' },
    { id: 'txn-groceries', categoryId: 'local-groceries' }
  ])
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

test('a restored reserve takes its bill’s strategy unless the file states one', () => {
  const db = freshDb()
  const result = mergeBackup(
    db,
    USER_ID,
    payload({
      accounts: [
        { id: 'acc-1', user_id: USER_ID, name: 'Chequing', kind: 'checking' }
      ],
      bills: [
        {
          id: 'bill-1',
          user_id: USER_ID,
          name: 'Rent',
          amount_cents: 120000,
          frequency: 'monthly',
          due_day: 30,
          account_id: 'acc-1',
          funding_strategy: 'last_check'
        }
      ],
      paychecks: [
        {
          id: 'pay-1',
          user_id: USER_ID,
          amount_cents: 500000,
          received_on: '2026-01-31',
          source: 'Paycheck',
          health: 'covered'
        }
      ],
      bill_reserves: [
        {
          id: 'res-1',
          user_id: USER_ID,
          bill_id: 'bill-1',
          paycheck_id: 'pay-1',
          cycle: '2026-01',
          amount_cents: 120000,
          state: 'reserved'
        },
        {
          id: 'res-2',
          user_id: USER_ID,
          bill_id: 'bill-1',
          paycheck_id: 'pay-1',
          cycle: '2026-02',
          amount_cents: 120000,
          state: 'reserved',
          strategy: 'first_check'
        }
      ]
    })
  )

  assert.deepEqual(result.issues, [])
  const rows = db
    .prepare('SELECT id, strategy, due_day, settled_by FROM bill_reserves ORDER BY id')
    .all()
  assert.deepEqual(rows, [
    { id: 'res-1', strategy: 'last_check', due_day: 30, settled_by: null },
    { id: 'res-2', strategy: 'first_check', due_day: 30, settled_by: null }
  ])
})

test('a restored reserve keeps the due day the file states', () => {
  const db = freshDb()
  const result = mergeBackup(
    db,
    USER_ID,
    payload({
      accounts: [{ id: 'acc-1', user_id: USER_ID, name: 'Chequing', kind: 'checking' }],
      bills: [
        {
          id: 'bill-1',
          user_id: USER_ID,
          name: 'Rent',
          amount_cents: 120000,
          frequency: 'monthly',
          due_day: 1,
          account_id: 'acc-1'
        }
      ],
      paychecks: [
        {
          id: 'pay-1',
          user_id: USER_ID,
          amount_cents: 500000,
          received_on: '2026-01-31',
          source: 'Paycheck',
          health: 'covered'
        }
      ],
      bill_reserves: [
        {
          id: 'res-1',
          user_id: USER_ID,
          bill_id: 'bill-1',
          paycheck_id: 'pay-1',
          cycle: '2026-01',
          amount_cents: 120000,
          state: 'reserved',
          due_day: 28
        }
      ]
    })
  )

  assert.deepEqual(result.issues, [])
  assert.equal(
    (db.prepare('SELECT due_day FROM bill_reserves WHERE id = ?').get('res-1') as { due_day: number })
      .due_day,
    28
  )
})

test('a category without a name is reported instead of stored blank', () => {
  const db = freshDb()
  const result = mergeBackup(
    db,
    USER_ID,
    payload({
      categories: [{ id: 'cat-1', user_id: USER_ID, kind: 'expense' }]
    })
  )

  assert.equal(result.added.categories, 0)
  assert.equal(result.issues.length, 1)
  assert.match(result.issues[0].message, /no category name/)
  assert.equal(
    (db.prepare('SELECT COUNT(*) AS count FROM categories').get() as { count: number }).count,
    0
  )
})

test('a category name longer than the ledger allows is reported, not imported', () => {
  const db = freshDb()
  const result = mergeBackup(
    db,
    USER_ID,
    payload({
      categories: [
        { id: 'cat-1', user_id: USER_ID, name: 'x'.repeat(61), kind: 'expense' }
      ]
    })
  )

  assert.equal(result.added.categories, 0)
  assert.equal(result.issues.length, 1)
  assert.match(result.issues[0].message, /longer than 60 characters/)
  assert.equal(
    (db.prepare('SELECT COUNT(*) AS count FROM categories').get() as { count: number }).count,
    0
  )
})

test('a transaction that names its category only by spelling links to the live row', () => {
  const db = freshDb()
  db.prepare(
    `INSERT INTO categories (id, user_id, name, kind, color, created_at, updated_at, revision)
     VALUES ('cat-live', ?, 'Café', 'expense', NULL,
             '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 1)`
  ).run(USER_ID)
  const result = mergeBackup(
    db,
    USER_ID,
    payload({
      accounts: [{ id: 'acc-1', user_id: USER_ID, name: 'Chequing', kind: 'checking' }],
      transactions: [
        {
          id: 'tx-1',
          user_id: USER_ID,
          account_id: 'acc-1',
          kind: 'expense',
          amount_cents: -1200,
          occurred_on: '2026-03-02',
          category: 'CAFÉ'
        }
      ]
    })
  )

  assert.deepEqual(result.issues, [])
  const row = db
    .prepare('SELECT category, category_id FROM transactions WHERE id = ?')
    .get('tx-1') as { category: string; category_id: string }
  assert.equal(row.category, 'Café', 'the local spelling wins')
  assert.equal(row.category_id, 'cat-live', 'the entry links to the live row')
})

function setting(db: Database.Database, key: string): string | undefined {
  const row = db
    .prepare('SELECT value FROM settings WHERE user_id = ? AND key = ?')
    .get(USER_ID, key) as { value: string } | undefined
  return row?.value
}

test('a restore into an empty ledger adopts the file’s settings', () => {
  const db = freshDb()
  // What a fresh install leaves behind: the default value, chosen by nobody.
  db.prepare(
    `INSERT INTO settings (user_id, key, value, updated_at)
     VALUES (?, 'savingsPercent', '20', '2026-01-01T00:00:00.000Z')`
  ).run(USER_ID)

  const result = mergeBackup(
    db,
    USER_ID,
    payload({
      settings: [
        { user_id: USER_ID, key: 'savingsPercent', value: '35' },
        { user_id: USER_ID, key: 'payCadence', value: 'monthly' }
      ]
    })
  )

  assert.equal(result.added.settings, 2, 'the file’s values are the ledger’s first values')
  assert.equal(setting(db, 'savingsPercent'), '35')
  assert.equal(setting(db, 'payCadence'), 'monthly')
  assert.equal(result.skipped.settings, 0)
})

test('an import into a ledger with history keeps the local settings', () => {
  const db = freshDb()
  mergeBackup(
    db,
    USER_ID,
    payload({
      accounts: [{ id: 'acc-1', user_id: USER_ID, name: 'Chequing', kind: 'checking' }]
    })
  )
  db.prepare(
    `INSERT INTO settings (user_id, key, value, updated_at)
     VALUES (?, 'savingsPercent', '20', '2026-01-01T00:00:00.000Z')`
  ).run(USER_ID)

  const result = mergeBackup(
    db,
    USER_ID,
    payload({ settings: [{ user_id: USER_ID, key: 'savingsPercent', value: '35' }] })
  )

  assert.equal(result.skipped.settings, 1)
  assert.equal(result.added.settings, 0)
  assert.equal(setting(db, 'savingsPercent'), '20', 'an account means this ledger is in use')
})

test('a live claim under a deleted bill is reported instead of held forever', () => {
  const db = freshDb()
  db.prepare(
    `INSERT INTO accounts (id, user_id, name, kind, sort_order, is_archived,
       starting_balance_cents, created_at, updated_at, revision)
     VALUES ('acc-1', ?, 'Chequing', 'checking', 0, 0, 0,
             '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 1)`
  ).run(USER_ID)
  db.prepare(
    `INSERT INTO bills (id, user_id, name, amount_cents, frequency, due_day, category,
       account_id, autopay, is_active, funding_strategy, created_at, updated_at,
       deleted_at, revision)
     VALUES ('bill-1', ?, 'Rent', 120000, 'monthly', 1, 'Bills', 'acc-1', 0, 1,
             'all_checks', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z',
             '2026-01-02T00:00:00.000Z', 2)`
  ).run(USER_ID)

  const result = mergeBackup(
    db,
    USER_ID,
    payload({
      bills: [
        {
          id: 'bill-1',
          user_id: USER_ID,
          name: 'Rent',
          amount_cents: 120000,
          frequency: 'monthly',
          due_day: 1,
          account_id: 'acc-1'
        }
      ],
      paychecks: [
        {
          id: 'pay-1',
          user_id: USER_ID,
          amount_cents: 500000,
          received_on: '2026-01-31',
          health: 'covered'
        }
      ],
      bill_reserves: [
        {
          id: 'res-1',
          user_id: USER_ID,
          bill_id: 'bill-1',
          paycheck_id: 'pay-1',
          cycle: '2026-02',
          amount_cents: 120000
        }
      ]
    })
  )

  assert.equal(result.skipped.bills, 1, 'the local tombstone is not resurrected')
  assert.equal(result.added.paychecks, 1)
  assert.equal(result.added.bill_reserves, 0, 'money is not held under a bill no screen can show')
  assert.equal(result.issues.length, 1)
  assert.match(result.issues[0].message, /bill was deleted or is not in this file/)
})

test('a claim whose funding cheque is a tombstone still reconciles with its payment', () => {
  const db = freshDb()
  db.prepare(
    `INSERT INTO accounts (id, user_id, name, kind, sort_order, is_archived,
       starting_balance_cents, created_at, updated_at, revision)
     VALUES ('acc-1', ?, 'Chequing', 'checking', 0, 0, 0,
             '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 1)`
  ).run(USER_ID)
  db.prepare(
    `INSERT INTO bills (id, user_id, name, amount_cents, frequency, due_day, category,
       account_id, autopay, is_active, funding_strategy, created_at, updated_at, revision)
     VALUES ('bill-1', ?, 'Rent', 120000, 'monthly', 1, 'Bills', 'acc-1', 0, 1,
             'all_checks', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 1)`
  ).run(USER_ID)
  db.prepare(
    `INSERT INTO paychecks (id, user_id, amount_cents, received_on, source,
       deposit_account_id, priority_cents, surplus_cents, leisure_cents, health,
       created_at, updated_at, deleted_at, revision)
     VALUES ('pay-1', ?, 500000, '2026-10-24', 'Paycheck', 'acc-1', 0, 0, 0,
             'covered', '2026-10-24T00:00:00.000Z', '2026-10-24T00:00:00.000Z',
             '2026-10-24T00:00:00.000Z', 2)`
  ).run(USER_ID)

  const result = mergeBackup(
    db,
    USER_ID,
    payload({
      bill_reserves: [
        {
          id: 'res-1',
          user_id: USER_ID,
          bill_id: 'bill-1',
          paycheck_id: 'pay-1',
          cycle: '2026-10',
          amount_cents: 120000
        }
      ],
      transactions: [
        {
          id: 'txn-rent',
          user_id: USER_ID,
          account_id: 'acc-1',
          kind: 'bill_payment',
          amount_cents: -120000,
          occurred_on: '2026-10-25',
          bill_id: 'bill-1'
        }
      ]
    })
  )

  assert.deepEqual(result.issues, [])
  const claim = db
    .prepare('SELECT state, settled_by FROM bill_reserves WHERE id = ?')
    .get('res-1') as { state: string; settled_by: string | null }
  assert.equal(claim.state, 'paid', 'the money already left; the claim must not read reserved')
  assert.equal(claim.settled_by, 'txn-rent')
})

test('a reserve row with no state lands reserved', () => {
  const db = freshDb()
  const result = mergeBackup(
    db,
    USER_ID,
    payload({
      bills: [
        {
          id: 'bill-1',
          user_id: USER_ID,
          name: 'Rent',
          amount_cents: 120000,
          frequency: 'monthly',
          due_day: 1
        }
      ],
      paychecks: [
        {
          id: 'pay-1',
          user_id: USER_ID,
          amount_cents: 500000,
          received_on: '2026-01-31',
          health: 'covered'
        }
      ],
      bill_reserves: [
        {
          id: 'res-1',
          user_id: USER_ID,
          bill_id: 'bill-1',
          paycheck_id: 'pay-1',
          cycle: '2026-02',
          amount_cents: 120000
        }
      ]
    })
  )

  assert.deepEqual(result.issues, [])
  assert.equal(
    (db.prepare('SELECT state FROM bill_reserves WHERE id = ?').get('res-1') as { state: string })
      .state,
    'reserved'
  )
})

test('a replay failure rolls the whole import back', () => {
  const db = freshDb()
  db.exec(
    `CREATE TRIGGER refuse_res_2 BEFORE UPDATE ON bill_reserves
     WHEN NEW.id = 'res-2'
     BEGIN SELECT RAISE(ABORT, 'refused'); END`
  )

  assert.throws(() =>
    mergeBackup(
      db,
      USER_ID,
      payload({
        bills: [
          {
            id: 'bill-1',
            user_id: USER_ID,
            name: 'Rent',
            amount_cents: 120000,
            frequency: 'monthly',
            due_day: 1
          },
          {
            id: 'bill-2',
            user_id: USER_ID,
            name: 'Phone',
            amount_cents: 6500,
            frequency: 'monthly',
            due_day: 18
          }
        ],
        paychecks: [
          {
            id: 'pay-1',
            user_id: USER_ID,
            amount_cents: 500000,
            received_on: '2026-01-31',
            health: 'covered'
          }
        ],
        bill_reserves: [
          {
            id: 'res-1',
            user_id: USER_ID,
            bill_id: 'bill-1',
            paycheck_id: 'pay-1',
            cycle: '2026-02',
            amount_cents: 120000,
            state: 'paid'
          },
          {
            id: 'res-2',
            user_id: USER_ID,
            bill_id: 'bill-2',
            paycheck_id: 'pay-1',
            cycle: '2026-02',
            amount_cents: 6500,
            state: 'paid'
          }
        ]
      })
    )
  )

  const count = (table: string): number =>
    (db.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get() as { total: number }).total
  assert.equal(count('bills'), 0, 'the rows are not left behind without their replayed claims')
  assert.equal(count('paychecks'), 0)
  assert.equal(count('bill_reserves'), 0)
})

function accountRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'acc-1',
    user_id: USER_ID,
    name: 'Chequing',
    kind: 'checking',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    revision: 1,
    ...overrides
  }
}

test('a newer row from the file replaces the local copy and is counted as updated', () => {
  const db = freshDb()
  mergeBackup(db, USER_ID, payload({ accounts: [accountRow()] }))

  const result = mergeBackup(
    db,
    USER_ID,
    payload(
      {
        accounts: [
          accountRow({
            name: 'Everyday Cheque',
            starting_balance_cents: 25000,
            updated_at: '2026-02-01T00:00:00.000Z',
            revision: 2
          })
        ]
      },
      '2026-02-15T00:00:00.000Z'
    )
  )

  assert.equal(result.added.accounts, 0)
  assert.equal(result.updated.accounts, 1)
  assert.equal(result.skipped.accounts, 0)
  const saved = db.prepare('SELECT name, starting_balance_cents FROM accounts WHERE id = ?').get('acc-1') as {
    name: string
    starting_balance_cents: number
  }
  assert.equal(saved.name, 'Everyday Cheque')
  assert.equal(saved.starting_balance_cents, 25000)
})

test('an older row from the file leaves a newer local edit alone', () => {
  const db = freshDb()
  mergeBackup(
    db,
    USER_ID,
    payload(
      { accounts: [accountRow({ name: 'Edited here', updated_at: '2026-03-01T00:00:00.000Z' })] },
      '2026-03-05T00:00:00.000Z'
    )
  )

  const result = mergeBackup(
    db,
    USER_ID,
    payload(
      {
        accounts: [accountRow({ name: 'From the file', updated_at: '2026-02-01T00:00:00.000Z' })]
      },
      '2026-02-05T00:00:00.000Z'
    )
  )

  assert.equal(result.updated.accounts, 0)
  assert.equal(result.skipped.accounts, 1)
  const saved = db.prepare('SELECT name, updated_at FROM accounts WHERE id = ?').get('acc-1') as {
    name: string
    updated_at: string
  }
  assert.equal(saved.name, 'Edited here')
  assert.equal(saved.updated_at, '2026-03-01T00:00:00.000Z')
})

test('a newer tombstone deletes the row, and an older copy cannot bring it back', () => {
  const db = freshDb()
  mergeBackup(db, USER_ID, payload({ accounts: [accountRow()] }))

  const removed = mergeBackup(
    db,
    USER_ID,
    payload(
      {
        accounts: [
          accountRow({
            deleted_at: '2026-02-01T00:00:00.000Z',
            updated_at: '2026-02-01T00:00:00.000Z',
            revision: 2
          })
        ]
      },
      '2026-02-05T00:00:00.000Z'
    )
  )

  assert.equal(removed.removed.accounts, 1)
  assert.equal(removed.updated.accounts, 0)
  const tombstone = db.prepare('SELECT deleted_at FROM accounts WHERE id = ?').get('acc-1') as {
    deleted_at: string | null
  }
  assert.equal(tombstone.deleted_at, '2026-02-01T00:00:00.000Z')

  const older = mergeBackup(db, USER_ID, payload({ accounts: [accountRow()] }))
  assert.equal(older.skipped.accounts, 1)
  const still = db.prepare('SELECT deleted_at FROM accounts WHERE id = ?').get('acc-1') as {
    deleted_at: string | null
  }
  assert.equal(still.deleted_at, '2026-02-01T00:00:00.000Z')
})

test('a newer setting from the file replaces the local value', () => {
  const db = freshDb()
  mergeBackup(db, USER_ID, payload({ accounts: [accountRow()] }))
  db.prepare(
    `INSERT INTO settings (user_id, key, value, updated_at)
     VALUES (?, 'savingsPercent', '20', '2026-01-01T00:00:00.000Z')`
  ).run(USER_ID)

  const result = mergeBackup(
    db,
    USER_ID,
    payload(
      {
        settings: [
          {
            user_id: USER_ID,
            key: 'savingsPercent',
            value: '35',
            updated_at: '2026-02-01T00:00:00.000Z'
          }
        ]
      },
      '2026-02-05T00:00:00.000Z'
    )
  )

  assert.equal(result.updated.settings, 1)
  assert.equal(setting(db, 'savingsPercent'), '35')
})

test('a rename onto another live category name is refused instead of splitting reports', () => {
  const db = freshDb()
  db.prepare(
    `INSERT INTO categories (id, user_id, name, kind, created_at, updated_at)
     VALUES ('cat-food', ?, 'Food', 'expense', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
  ).run(USER_ID)
  db.prepare(
    `INSERT INTO categories (id, user_id, name, kind, created_at, updated_at)
     VALUES ('cat-travel', ?, 'Travel', 'expense', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
  ).run(USER_ID)

  const result = mergeBackup(
    db,
    USER_ID,
    payload(
      {
        categories: [
          {
            id: 'cat-travel',
            user_id: USER_ID,
            name: 'Food',
            kind: 'expense',
            created_at: '2026-01-01T00:00:00.000Z',
            updated_at: '2026-02-01T00:00:00.000Z'
          }
        ]
      },
      '2026-02-05T00:00:00.000Z'
    )
  )

  assert.equal(result.updated.categories, 0)
  assert.equal(result.skipped.categories, 1)
  assert.match(result.issues[0].message, /already used by another category/)
  const saved = db.prepare('SELECT name FROM categories WHERE id = ?').get('cat-travel') as {
    name: string
  }
  assert.equal(saved.name, 'Travel')
})

test('a newer edit keeps the day this ledger first saw the row', () => {
  const db = freshDb()
  mergeBackup(
    db,
    USER_ID,
    payload(
      { accounts: [accountRow({ created_at: '2025-03-01T00:00:00.000Z' })] },
      '2025-04-01T00:00:00.000Z'
    )
  )

  mergeBackup(
    db,
    USER_ID,
    payload(
      {
        accounts: [
          accountRow({
            name: 'Renamed here',
            created_at: '2026-01-01T00:00:00.000Z',
            updated_at: '2026-02-01T00:00:00.000Z',
            revision: 2
          })
        ]
      },
      '2026-02-10T00:00:00.000Z'
    )
  )

  const saved = db
    .prepare('SELECT name, created_at FROM accounts WHERE id = ?')
    .get('acc-1') as { name: string; created_at: string }
  assert.equal(saved.name, 'Renamed here')
  assert.equal(saved.created_at, '2025-03-01T00:00:00.000Z', 'an edit does not rewrite the creation day')
})

test('a row with no edit stamp takes its creation day, not the import time', () => {
  const db = freshDb()
  mergeBackup(
    db,
    USER_ID,
    payload({
      accounts: [
        {
          id: 'acc-old',
          user_id: USER_ID,
          name: 'Old account',
          kind: 'savings',
          created_at: '2025-06-01T00:00:00.000Z'
        }
      ]
    })
  )

  const saved = db
    .prepare('SELECT created_at, updated_at, revision FROM accounts WHERE id = ?')
    .get('acc-old') as { created_at: string; updated_at: string; revision: number }
  assert.equal(saved.created_at, '2025-06-01T00:00:00.000Z')
  assert.equal(saved.updated_at, '2025-06-01T00:00:00.000Z')
  assert.equal(saved.revision, 1)
})

test('a bill takes the local spelling of its category', () => {
  const db = freshDb()
  mergeBackup(
    db,
    USER_ID,
    payload({
      accounts: [accountRow()],
      categories: [
        { id: 'cat-housing', user_id: USER_ID, name: 'Housing', kind: 'expense' }
      ]
    })
  )

  mergeBackup(
    db,
    USER_ID,
    payload({
      categories: [
        { id: 'cat-remote', user_id: USER_ID, name: 'housing', kind: 'expense' }
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
          category: 'housing',
          next_due_on: '2026-03-01'
        }
      ]
    })
  )

  const bill = db.prepare('SELECT category FROM bills WHERE id = ?').get('bill-1') as {
    category: string
  }
  assert.equal(bill.category, 'Housing', 'one category must not read as two spellings')
})

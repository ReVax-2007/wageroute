import assert from 'node:assert/strict'
import test from 'node:test'
import { parseCsv, parseCsvRows, parseEntriesCsv, toCsv, transactionsToCsv } from './csv'

test('quoted cells keep their commas, quotes and newlines', () => {
  const rows = parseCsv('a,"b,c","say ""hi""","two\r\nlines"\r\n')
  assert.deepEqual(rows, [['a', 'b,c', 'say "hi"', 'two\r\nlines']])
})

test('a row reports the physical line it starts on, even after quoted newlines', () => {
  const rows = parseCsvRows('a,b\r\n"two\r\nlines",c\r\nd,e\r\n')
  assert.deepEqual(
    rows.map((row) => row.line),
    [1, 2, 4]
  )
  assert.deepEqual(rows[1]?.cells, ['two\r\nlines', 'c'])
})

test('an unclosed quote fails the import and names the line it starts on', () => {
  const text = 'Date,Account,Amount\r\n2026-01-01,Chequing,10\r\n2026-01-02,Chequing,"12\r\n'
  assert.throws(
    () => parseCsv(text),
    /unclosed quote that starts on line 3 — fix the file and try again/
  )
})

test('an entries file that omits the sign gets it from the kind', () => {
  const text = [
    'Date,Account,Kind,Amount',
    '2026-01-05,Chequing,expense,42.50',
    '2026-01-06,Chequing,income,1800',
    '2026-01-07,Chequing,adjustment,-15'
  ].join('\n')
  const { entries, issues } = parseEntriesCsv(text)

  assert.deepEqual(issues, [])
  assert.deepEqual(
    entries.map((entry) => entry.amountCents),
    [-4250, 180000, -1500]
  )
})

test('a kind-less row still lands on the sign its amount implies', () => {
  const { entries } = parseEntriesCsv('Date,Account,Amount\n2026-02-01,Chequing,25\n')
  assert.equal(entries[0]?.kind, 'income')
  assert.equal(entries[0]?.amountCents, 2500)
})

test('a transfer row is refused instead of importing half a movement', () => {
  const { entries, issues } = parseEntriesCsv(
    'Date,Account,Kind,Amount\n2026-03-01,Chequing,transfer,500\n'
  )
  assert.equal(entries.length, 0)
  assert.match(issues[0]?.message ?? '', /transfer/)
})

test('the writer escapes what the reader expects to unescape', () => {
  const once = toCsv([
    ['Date', 'Description'],
    ['2026-04-01', 'Coffee, "large"']
  ])
  assert.deepEqual(parseCsv(once), [
    ['Date', 'Description'],
    ['2026-04-01', 'Coffee, "large"']
  ])
})

test('one day above 12 settles the date order for the whole file', () => {
  const { entries, issues } = parseEntriesCsv(
    [
      'Date,Account,Amount',
      '31/12/2026,Chequing,-10',
      '03/04/2026,Chequing,-11',
      '2026/12/07,Chequing,-12'
    ].join('\n')
  )
  assert.deepEqual(issues, [])
  assert.deepEqual(
    entries.map((entry) => entry.occurredOn),
    ['2026-12-31', '2026-04-03', '2026-12-07'],
    'a day above 12 proves the file is day-first, so 03/04 is 3 April'
  )
})

test('dates that cannot prove their order are read month-first and say so', () => {
  const { entries, issues } = parseEntriesCsv(
    ['Date,Account,Amount', '03/04/2026,Chequing,-10', '05/06/2026,Chequing,-11'].join('\n')
  )
  assert.deepEqual(
    entries.map((entry) => entry.occurredOn),
    ['2026-03-04', '2026-05-06']
  )
  assert.equal(issues.length, 1)
  assert.match(issues[0]?.message ?? '', /ambiguous; read as month\/day/)
  assert.equal(issues[0]?.line, 2)
})

test('an export-import round trip drops the apostrophe the writer added', () => {
  const csv = transactionsToCsv(
    [
      {
        occurredOn: '2026-04-01',
        accountName: '=Chequing',
        accountId: 'a1',
        kind: 'expense',
        category: 'Misc',
        memo: '=HYPERLINK("http://evil.example","click")',
        amountCents: -1250
      } as never
    ],
    [],
    'USD'
  )
  const { entries, issues } = parseEntriesCsv(csv)
  assert.deepEqual(issues, [])
  assert.equal(entries[0]?.accountName, '=Chequing')
  assert.equal(entries[0]?.memo, '=HYPERLINK("http://evil.example","click")')
})

test('a memo that genuinely starts with an apostrophe keeps it', () => {
  const { entries } = parseEntriesCsv(
    'Date,Account,Amount,Description\n2026-04-01,Chequing,-10,\'not a formula\n'
  )
  assert.equal(entries[0]?.memo, "'not a formula")
})

test('a kind a spreadsheet would mistake for an object member is not a kind', () => {
  const { entries } = parseEntriesCsv(
    'Date,Account,Kind,Amount\n2026-04-01,Chequing,constructor,-10\n'
  )
  assert.equal(entries[0]?.kind, 'expense', 'an unknown kind falls back to the amount sign')
  assert.equal(entries[0]?.amountCents, -1000)
})

test('an entry row reports the line it came from, not its position after parsing', () => {
  const { issues } = parseEntriesCsv(
    [
      'Date,Account,Amount,Description',
      '2026-01-01,Chequing,10,"note\r\nwrapped"',
      'nonsense,Chequing,10,'
    ].join('\n')
  )
  assert.equal(issues.length, 1)
  assert.match(issues[0]?.message ?? '', /row 4 has an unreadable date/)
})

test('a description a spreadsheet would treat as a formula is defused', () => {
  const csv = transactionsToCsv(
    [
      {
        occurredOn: '2026-04-01',
        accountName: 'Chequing',
        accountId: 'a1',
        kind: 'expense',
        category: '=SUM(A1:A9)',
        memo: '=HYPERLINK("http://evil.example","click")',
        amountCents: -1250
      } as never
    ],
    [{ id: 'a1', institution: '@Bank' } as never],
    'USD'
  )
  const [, row] = parseCsv(csv)
  assert.equal(row?.[1], 'Chequing')
  assert.equal(row?.[2], "'@Bank")
  assert.equal(row?.[4], "'=SUM(A1:A9)")
  assert.ok(row?.[5]?.startsWith("'=HYPERLINK"), 'the memo is prefixed, not executed')
  assert.equal(row?.[6], '-12.50', 'amounts stay machine-readable')
})

test('an export keeps the bank name even when the account is no longer listed', () => {
  const csv = transactionsToCsv(
    [
      {
        occurredOn: '2026-04-01',
        accountName: 'Closed account',
        accountId: 'gone',
        accountInstitution: 'Tangerine',
        kind: 'expense',
        category: 'Misc',
        memo: '',
        amountCents: -100
      } as never
    ],
    [],
    'USD'
  )
  const [, row] = parseCsv(csv)
  assert.equal(row?.[2], 'Tangerine', 'the joined institution stands in for the missing account')
})

test('a bank export that splits Debit and Credit needs no Account column', () => {
  const { entries, issues, hasAccountColumn } = parseEntriesCsv(
    [
      'Transaction Date,Description,Debit,Credit',
      '2026-05-02,Coffee,4.25,',
      '2026-05-03,Payroll,,2500.00'
    ].join('\n')
  )

  assert.equal(hasAccountColumn, false)
  assert.deepEqual(issues, [])
  assert.deepEqual(
    entries.map((entry) => [entry.accountName, entry.amountCents, entry.kind]),
    [
      ['', -425, 'expense'],
      ['', 250_000, 'income']
    ]
  )
})

test('a row claiming both a debit and a credit is refused, not netted', () => {
  const { entries, issues } = parseEntriesCsv(
    'Date,Description,Debit,Credit\n2026-05-04,Broken,1.00,2.00\n'
  )

  assert.equal(entries.length, 0)
  assert.match(issues[0]?.message ?? '', /both a debit and a credit/)
})

test('an amount-only CSV is a statement, and an empty Amount row still reports', () => {
  const parsed = parseEntriesCsv('Date,Description,Amount\n2026-05-05,One,10\n2026-05-06,Two,\n')

  assert.equal(parsed.hasAccountColumn, false)
  assert.equal(parsed.entries.length, 1)
  assert.match(parsed.issues[0]?.message ?? '', /no usable amount/)
})

test('a CSV with an Account column still resolves names as entries', () => {
  const parsed = parseEntriesCsv(
    'Date,Account,Debit,Credit\n2026-05-07,Chequing,9.99,\n2026-05-08,Chequing,,20\n'
  )

  assert.equal(parsed.hasAccountColumn, true)
  assert.deepEqual(
    parsed.entries.map((entry) => [entry.accountName, entry.amountCents]),
    [
      ['Chequing', -999],
      ['Chequing', 2000]
    ]
  )
})

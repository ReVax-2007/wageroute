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

test('a slashed date that cannot be month-first is read day-first', () => {
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
    ['2026-12-31', '2026-03-04', '2026-12-07'],
    'a day above 12 settles the order; otherwise the US default stands'
  )
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

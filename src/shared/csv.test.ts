import assert from 'node:assert/strict'
import test from 'node:test'
import { parseCsv, parseEntriesCsv, toCsv } from './csv'

test('quoted cells keep their commas, quotes and newlines', () => {
  const rows = parseCsv('a,"b,c","say ""hi""","two\r\nlines"\r\n')
  assert.deepEqual(rows, [['a', 'b,c', 'say "hi"', 'two\r\nlines']])
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

import assert from 'node:assert/strict'
import test from 'node:test'
import { parseQif } from './qif'

const BANK = `!Account
NEveryday Checking
TBank
^
!Type:Bank
D10/05/2026
T-42.50
PCOFFEE SHOP
Mcold brew
LFood/Dining
^
D10/07/2026
T2,500.00
PPAYROLL
LIncome
^
D10/10/2026
T-500.00
PTO SAVINGS
L[Savings]
^
D10/12/2026
T0.00
PZERO
^
D10/15/2026
T-120.00
PGROCERY
SGroceries
SGifts
^
`

test('a QIF reads its signed rows, its category and its own account name', () => {
  const { entries, issues, statement } = parseQif(BANK)

  assert.equal(statement.kind, 'qif')
  assert.equal(statement.accountLabel, 'Everyday Checking')
  assert.equal(statement.bank, null)
  assert.equal(statement.balanceCents, null)
  assert.equal(statement.notes.length, 1)
  assert.match(statement.notes[0] ?? '', /no closing balance/)
  assert.equal(statement.from, '2026-10-05')
  assert.equal(statement.to, '2026-10-15')

  assert.deepEqual(
    entries.map((entry) => [entry.occurredOn, entry.amountCents, entry.kind, entry.category]),
    [
      ['2026-10-05', -4250, 'expense', 'Food/Dining'],
      ['2026-10-07', 250_000, 'income', 'Income'],
      ['2026-10-15', -12_000, 'expense', 'Uncategorized']
    ]
  )
  assert.equal(entries[0]?.memo, 'COFFEE SHOP — cold brew')
  assert.equal(entries[0]?.accountName, '', 'the wizard asks which local account this is')

  assert.deepEqual(
    issues.map((issue) => issue.message),
    [
      'statement line 17 is a transfer — import a JSON backup to keep both legs',
      'statement line 22 has no usable amount'
    ]
  )
})

test('a split record imports once for its total and keeps a shared category', () => {
  const { entries } = parseQif(`!Type:Bank
D10/15/2026
T-90.00
PGROCERY
LFood
SGroceries
SFood
^
`)
  assert.equal(entries.length, 1)
  assert.equal(entries[0]?.amountCents, -9000)
  assert.equal(entries[0]?.category, 'Food', 'one category across every split is kept')
})

test('one date order is proved for the whole QIF before any row is read', () => {
  const { entries } = parseQif(`!Type:Bank
D31/12/2026
T-10.00
PDAY FIRST
^
D03/04/2026
T-20.00
PSECOND
^
`)
  assert.deepEqual(
    entries.map((entry) => entry.occurredOn),
    ['2026-12-31', '2026-04-03']
  )
})

test('a card QIF needs no account block, and an apostrophe year still reads', () => {
  const { entries, statement } = parseQif(`!Type:CCard
D10/09'2026
T-25.00
PSTORE
^
`)
  assert.equal(entries[0]?.occurredOn, '2026-10-09')
  assert.equal(entries[0]?.amountCents, -2500)
  assert.equal(statement.accountLabel, null)
})

test('a QIF naming two accounts is refused rather than poured into one', () => {
  assert.throws(
    () =>
      parseQif(`!Account
NChecking
TBank
^
!Type:Bank
D10/05/2026
T-5.00
PONE
^
!Account
NSavings
TBank
^
!Type:Bank
D10/06/2026
T-6.00
PTWO
^
`),
    /holds 2 accounts \(Checking, Savings\) — export one account at a time/
  )
})

test('an investment QIF says why it cannot import', () => {
  assert.throws(
    () =>
      parseQif(`!Type:Invst
D10/05/2026
NBuy
YFUNDX
I10.00
Q10
T-100.00
^
`),
    /investment activity, which WageRoute cannot import/
  )
})

test('a file with no records is refused', () => {
  assert.throws(() => parseQif('!Type:Cat\nNGroceries\n^\n'), /has no transactions/)
})

test('a mixed file imports its cash and reports the investment records it leaves out', () => {
  const { entries, issues } = parseQif(`!Type:Bank
D10/05/2026
T-5.00
PONE
^
!Type:Invst
D10/06/2026
NBuy
YFUNDX
T-100.00
^
D10/07/2026
NSell
YFUNDY
T100.00
^
`)
  assert.equal(entries.length, 1)
  assert.equal(entries[0]?.amountCents, -500)
  assert.deepEqual(issues, [
    { line: 7, message: '2 investment records were not imported — a QIF imports cash rows only' }
  ])
})

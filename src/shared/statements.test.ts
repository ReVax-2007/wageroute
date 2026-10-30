import assert from 'node:assert/strict'
import test from 'node:test'
import { describeCsvStatement, parseOfxStatement } from './statements'

const SGML = `OFXHEADER:100
DATA:OFXSGML
VERSION:102
SECURITY:NONE
ENCODING:USASCII

<OFX>
<SIGNONMSGSRSV1><SONRS><STATUS><CODE>0</CODE></STATUS>
<DTSERVER>20260201120000</DTSERVER><LANGUAGE>ENG</LANGUAGE>
<FI><ORG>Chase</ORG><FID>10898</FID></FI></SONRS></SIGNONMSGSRSV1>
<BANKMSGSRSV1><STMTTRNRS><TRNUID>1</TRNUID>
<STMTRS><CURDEF>USD</CURDEF>
<BANKACCTFROM><BANKID>021000021</BANKID><ACCTID>1234567890</ACCTID><ACCTTYPE>CHECKING</ACCTTYPE></BANKACCTFROM>
<BANKTRANLIST><DTSTART>20260101</DTSTART><DTEND>20260131</DTEND>
<STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20260105120000.000[-5:EST]</DTPOSTED><TRNAMT>-4.25</TRNAMT><FITID>abc</FITID><NAME>COFFEE SHOP</NAME><MEMO>Coffee &amp; bagel</MEMO></STMTTRN>
<STMTTRN><TRNTYPE>DIRECTDEP</TRNTYPE><DTPOSTED>20260107</DTPOSTED><TRNAMT>2500.00</TRNAMT><FITID>def</FITID><NAME>PAYROLL</NAME></STMTTRN>
<STMTTRN><TRNTYPE>XFER</TRNTYPE><DTPOSTED>20260110</DTPOSTED><TRNAMT>-500.00</TRNAMT><FITID>ghi</FITID><NAME>TRANSFER TO SAVINGS</NAME></STMTTRN>
</BANKTRANLIST>
<LEDGERBAL><BALAMT>1995.75</BALAMT><DTASOF>20260131</DTASOF></LEDGERBAL>
</STMTRS></STMTTRNRS></BANKMSGSRSV1>
</OFX>
`

const XML = `<?xml version="1.0" encoding="UTF-8"?>
<OFX>
  <BANKMSGSRSV1><STMTTRNRS><STMTRS>
    <CURDEF>EUR</CURDEF>
    <BANKACCTFROM><BANKID>BANK</BANKID><ACCTID>NL12</ACCTID></BANKACCTFROM>
    <BANKTRANLIST>
      <STMTTRN>
        <TRNTYPE>CREDIT</TRNTYPE>
        <DTPOSTED>20260228</DTPOSTED>
        <TRNAMT>12.34</TRNAMT>
        <NAME>REFUND</NAME>
      </STMTTRN>
    </BANKTRANLIST>
    <LEDGERBAL><BALAMT>-3.50</BALAMT><DTASOF>20260228</DTASOF></LEDGERBAL>
  </STMTRS></STMTTRNRS></BANKMSGSRSV1>
</OFX>
`

test('an SGML statement reads its signed lines and refuses the transfer', () => {
  const { entries, issues, statement } = parseOfxStatement(SGML)

  assert.equal(entries.length, 2)
  assert.deepEqual(
    entries.map((entry) => [entry.occurredOn, entry.amountCents, entry.kind]),
    [
      ['2026-01-05', -425, 'expense'],
      ['2026-01-07', 250_000, 'income']
    ]
  )
  assert.equal(entries[0]?.memo, 'COFFEE SHOP — Coffee & bagel')
  assert.equal(entries[0]?.accountName, '')
  assert.equal(entries[0]?.institution, 'Chase')
  assert.equal(issues.length, 1)
  assert.match(issues[0]?.message ?? '', /statement line 3 is a transfer/)
  assert.deepEqual(statement, {
    kind: 'ofx',
    bank: 'Chase',
    accountLabel: '••••7890',
    currency: 'USD',
    from: '2026-01-05',
    to: '2026-01-07',
    balanceCents: 199_575,
    balanceOn: '2026-01-31'
  })
})

test('an XML statement reads closing tags without leaking the timezone', () => {
  const { entries, statement } = parseOfxStatement(XML)

  assert.equal(entries.length, 1)
  assert.equal(entries[0]?.occurredOn, '2026-02-28')
  assert.equal(entries[0]?.amountCents, 1234)
  assert.equal(entries[0]?.memo, 'REFUND')
  assert.equal(statement.currency, 'EUR')
  assert.equal(statement.accountLabel, 'NL12')
  assert.equal(statement.balanceCents, -350)
})

test('an impossible OFX date is reported, not rolled into the next month', () => {
  const { entries, issues } = parseOfxStatement(
    '<OFX><BANKTRANLIST><STMTTRN><DTPOSTED>20260231</DTPOSTED><TRNAMT>-1.00</TRNAMT></STMTTRN></BANKTRANLIST></OFX>'
  )

  assert.equal(entries.length, 0)
  assert.match(issues[0]?.message ?? '', /unreadable date/)
})

test('a statement with no transaction block is refused outright', () => {
  assert.throws(() => parseOfxStatement('<OFX></OFX>'), /no transactions/)
})

test('a CSV with no Account column is described by its own lines', () => {
  const info = describeCsvStatement([
    {
      line: 2,
      occurredOn: '2026-03-09',
      accountName: '',
      institution: 'Monzo',
      kind: 'expense',
      category: 'Uncategorized',
      memo: 'Lunch',
      amountCents: -1200
    },
    {
      line: 3,
      occurredOn: '2026-03-02',
      accountName: '',
      institution: null,
      kind: 'income',
      category: 'Uncategorized',
      memo: 'Refund',
      amountCents: 500
    }
  ])

  assert.equal(info.kind, 'csv')
  assert.equal(info.bank, 'Monzo')
  assert.equal(info.accountLabel, null)
  assert.equal(info.from, '2026-03-02')
  assert.equal(info.to, '2026-03-09')
  assert.equal(info.balanceCents, null)
})

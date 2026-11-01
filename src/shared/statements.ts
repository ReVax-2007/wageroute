import type { CsvEntry, CsvIssue } from './csv'
import { isISODate } from './dates'
import { parseMoneyToCents } from './money'

/**
 * What a statement says about itself. The importer prints this above the file's
 * lines so the numbers can be checked against the paper statement, but it never
 * writes any of it: only the transactions land.
 */
export interface StatementInfo {
  kind: 'ofx' | 'csv'
  /** Institution or bank name, when the file names one. */
  bank: string | null
  /** Last four digits of the account number, masked; null when unknown. */
  accountLabel: string | null
  currency: string | null
  /** Range actually covered by the transactions that will import. */
  from: string | null
  to: string | null
  /** Closing balance the statement claims, shown for comparison only. */
  balanceCents: number | null
  balanceOn: string | null
}

export interface StatementParse {
  entries: CsvEntry[]
  issues: CsvIssue[]
  statement: StatementInfo
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'"
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, code: string) => {
    if (code.startsWith('#')) {
      const hex = code[1]?.toLowerCase() === 'x'
      const point = hex ? Number.parseInt(code.slice(2), 16) : Number(code.slice(1))
      // Control characters are stripped later anyway; keep the text readable.
      if (!Number.isFinite(point) || point < 32 || point > 0x10ffff) return whole
      return String.fromCodePoint(point)
    }
    return ENTITIES[code.toLowerCase()] ?? whole
  })
}

/**
 * OFX 1.x is SGML: a value ends at the next tag with no closing tag of its own.
 * OFX 2.x is XML with `</TAG>`. Reading up to the next `<` handles both.
 */
function tagValue(block: string, tag: string): string | null {
  const match = new RegExp(`<${tag}>\\s*([^<]*)`, 'i').exec(block)
  const value = match?.[1]?.trim()
  return value ? decodeEntities(value) : null
}

/** The first aggregate block is enough: a file holds one account per statement. */
function aggregateBlock(text: string, tag: string): string {
  const start = new RegExp(`<${tag}>`, 'i').exec(text)
  if (!start) return ''
  return text.slice(start.index, start.index + 500)
}

function ofxDate(raw: string | null): string | null {
  if (!raw) return null
  // DTPOSTED is YYYYMMDD followed by an optional time and timezone.
  const match = /^(\d{4})(\d{2})(\d{2})/.exec(raw.trim())
  if (!match) return null
  const iso = `${match[1]}-${match[2]}-${match[3]}`
  return isISODate(iso) ? iso : null
}

/**
 * A statement's account number is not needed to import and should not be held
 * in memory longer than the wizard is open, so only the last four digits survive.
 */
function maskAccount(id: string | null): string | null {
  if (!id) return null
  const cleaned = id.replace(/[^0-9a-z]/gi, '')
  if (!cleaned) return null
  return cleaned.length <= 4 ? cleaned : `••••${cleaned.slice(-4)}`
}

function transactionBlocks(text: string): string[] {
  const pattern = /<STMTTRN>([\s\S]*?)(?=<STMTTRN>|<\/STMTTRN>|<\/BANKTRANLIST>|$)/gi
  return [...text.matchAll(pattern)].map((match) => match[1])
}

/**
 * Reads an OFX 1.x (SGML) or OFX 2.x/QFX (XML) bank or credit-card statement.
 *
 * The sign is taken from the file, because a statement is the bank's own record
 * of direction. Transfers are refused like a CSV transfer: one leg cannot be
 * reconstructed into a paired movement inside the ledger.
 */
export function parseOfxStatement(text: string): StatementParse {
  const blocks = transactionBlocks(text)
  if (blocks.length === 0) {
    throw new Error('That file has no transactions — is it an OFX or QFX statement?')
  }

  const accountBlock = aggregateBlock(text, 'BANKACCTFROM') || aggregateBlock(text, 'CCACCTFROM')
  const accountId = tagValue(accountBlock, 'ACCTID')
  const bankId = tagValue(accountBlock, 'BANKID')
  const bank = tagValue(aggregateBlock(text, 'FI'), 'ORG') ?? bankId
  const currency = tagValue(text, 'CURDEF')
  const ledger = aggregateBlock(text, 'LEDGERBAL')
  const balanceCents = parseMoneyToCents(tagValue(ledger, 'BALAMT') ?? '')
  const balanceOn = ofxDate(tagValue(ledger, 'DTASOF'))

  const entries: CsvEntry[] = []
  const issues: CsvIssue[] = []

  blocks.forEach((block, index) => {
    const ordinal = index + 1
    const occurredOn = ofxDate(tagValue(block, 'DTPOSTED'))
    if (!occurredOn) {
      issues.push({ line: ordinal, message: `statement line ${ordinal} has an unreadable date` })
      return
    }

    const amountCents = parseMoneyToCents(tagValue(block, 'TRNAMT') ?? '')
    if (amountCents === null || amountCents === 0) {
      issues.push({ line: ordinal, message: `statement line ${ordinal} has no usable amount` })
      return
    }

    const type = (tagValue(block, 'TRNTYPE') ?? '').toUpperCase()
    if (type === 'XFER' || type === 'TRANSFER') {
      issues.push({
        line: ordinal,
        message: `statement line ${ordinal} is a transfer — import a JSON backup to keep both legs`
      })
      return
    }

    const name = tagValue(block, 'NAME') ?? ''
    const memo = tagValue(block, 'MEMO') ?? ''
    const description =
      name && memo && !memo.toLocaleLowerCase().startsWith(name.toLocaleLowerCase())
        ? `${name} — ${memo}`
        : name || memo
    // FITID is the bank's stable id for the line; importing the same statement
    // twice recognises it instead of duplicating the month.
    const fitId = tagValue(block, 'FITID')

    entries.push({
      line: ordinal,
      occurredOn,
      // A statement belongs to one account, and the wizard asks which local
      // account that is; no row carries a name to match against.
      accountName: '',
      institution: bank,
      kind: amountCents > 0 ? 'income' : 'expense',
      category: 'Uncategorized',
      memo: description,
      amountCents,
      externalId: fitId ? fitId.slice(0, 120) : null
    })
  })

  const dates = entries.map((entry) => entry.occurredOn).sort()
  return {
    entries,
    issues,
    statement: {
      kind: 'ofx',
      bank,
      accountLabel: maskAccount(accountId),
      currency,
      from: dates[0] ?? null,
      to: dates.at(-1) ?? null,
      balanceCents,
      balanceOn
    }
  }
}

/** Describes an account-less CSV (a bank export with no Account column). */
export function describeCsvStatement(entries: readonly CsvEntry[]): StatementInfo {
  const dates = entries.map((entry) => entry.occurredOn).sort()
  const institution = entries.find((entry) => entry.institution)?.institution ?? null
  return {
    kind: 'csv',
    bank: institution,
    accountLabel: null,
    currency: null,
    from: dates[0] ?? null,
    to: dates.at(-1) ?? null,
    balanceCents: null,
    balanceOn: null
  }
}

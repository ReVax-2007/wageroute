import type { CsvEntry, CsvIssue } from './csv'
import { isISODate } from './dates'
import { parseMoneyToCents } from './money'
import type { AccountKind } from './types'

/**
 * What a statement says about itself. The importer prints this above the file's
 * lines so the numbers can be checked against the paper statement, but it never
 * writes any of it: only the transactions land.
 */
export interface StatementInfo {
  kind: 'ofx' | 'csv' | 'qif'
  /** Institution or bank name, when the file names one. */
  bank: string | null
  /** Last four digits of the account number, masked, or a QIF's account name. */
  accountLabel: string | null
  currency: string | null
  /** Range actually covered by the transactions that will import. */
  from: string | null
  to: string | null
  /** Closing balance the statement claims, shown for comparison only. */
  balanceCents: number | null
  balanceOn: string | null
  /** What the file does not give the ledger, said before the lines are read. */
  notes: string[]
}

export interface StatementParse {
  entries: CsvEntry[]
  issues: CsvIssue[]
  statement: StatementInfo
}

/**
 * A statement's closing balance in the ledger's own sign. A card statement
 * prints what is owed as a positive number while the ledger stores debt as a
 * negative balance; cash, savings and investment accounts keep the file's sign.
 */
export function ledgerStatementCents(balanceCents: number, accountKind: AccountKind): number {
  return accountKind === 'credit' ? -Math.abs(balanceCents) : balanceCents
}

/** What one statement's closing balance says about the account it belongs to. */
export interface StatementReconciliation {
  accountId: string
  accountName: string
  accountKind: AccountKind
  /** The day the bank closed the statement on. */
  balanceOn: string
  /** The statement's closing balance, in the ledger's sign. */
  statementCents: number
  /** What the account held on that day once the statement's lines landed. */
  ledgerCents: number
  /** `statementCents − ledgerCents`: the adjustment that would make them agree. */
  differenceCents: number
}

/**
 * Compares the bank's own closing figure with the ledger on the day it closed.
 * The comparison is made after the import, because the statement's own lines
 * are what should bring the two together.
 */
export function reconcileStatement(input: {
  accountId: string
  accountName: string
  accountKind: AccountKind
  statementCents: number
  ledgerCents: number
  balanceOn: string
}): StatementReconciliation {
  const statementCents = ledgerStatementCents(input.statementCents, input.accountKind)
  return {
    accountId: input.accountId,
    accountName: input.accountName,
    accountKind: input.accountKind,
    balanceOn: input.balanceOn,
    statementCents,
    ledgerCents: input.ledgerCents,
    differenceCents: statementCents - input.ledgerCents
  }
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
  const pattern =
    /<STMTTRN>([\s\S]*?)(?=<STMTTRN>|<\/STMTTRN>|<\/BANKTRANLIST>|<\/INVBANKTRAN>|<\/INVTRANLIST>|<\/STMTRS>|<BUY|<SELL|<INCOME|<REINVEST|<JRNLSEC|<TRANSFER|<MARGININTEREST|$)/gi
  return [...text.matchAll(pattern)].map((match) => match[1])
}

function lineOf(text: string, index: number | undefined): number {
  if (index === undefined || index < 0) return 1
  return text.slice(0, index).split('\n').length
}

const SECURITY_AGGREGATES =
  /<(BUYMF|BUYOPT|BUYOTHER|BUYDEBT|BUYSTOCK|BUY|SELLMF|SELLOPT|SELLOTHER|SELLDEBT|SELLSTOCK|SELL|REINVEST|INCOME|JRNLSEC|JRNLFUND|TRANSFER|MARGININTEREST|CLOSUREOPT|RETOFCAP|SPLIT)>/gi

/** What kind of statement the file holds decides where its closing figure lives. */
function ofxFlavour(text: string): 'bank' | 'loan' | 'investment' {
  if (/<INVSTMTRS>/i.test(text)) return 'investment'
  if (/<LOANSTMTRS>/i.test(text)) return 'loan'
  return 'bank'
}

/**
 * Reads an OFX 1.x (SGML) or OFX 2.x/QFX (XML) bank, credit-card, loan or
 * investment statement.
 *
 * The sign is taken from the file, because a statement is the bank's own record
 * of direction. Transfers are refused like a CSV transfer: one leg cannot be
 * reconstructed into a paired movement inside the ledger. An investment
 * statement's cash movements import; its securities activity and holdings do
 * not, and the wizard says so instead of losing them silently.
 */
export function parseOfxStatement(text: string): StatementParse {
  const blocks = transactionBlocks(text)
  if (blocks.length === 0) {
    throw new Error('That file has no transactions — is it an OFX or QFX statement?')
  }

  const flavour = ofxFlavour(text)
  const accountBlock =
    aggregateBlock(text, 'BANKACCTFROM') ||
    aggregateBlock(text, 'CCACCTFROM') ||
    aggregateBlock(text, 'LOANACCTFROM') ||
    aggregateBlock(text, 'INVACCTFROM')
  const accountId = tagValue(accountBlock, 'ACCTID')
  const bankId = tagValue(accountBlock, 'BANKID') ?? tagValue(accountBlock, 'BROKERID')
  const bank = tagValue(aggregateBlock(text, 'FI'), 'ORG') ?? bankId
  const currency = tagValue(text, 'CURDEF')
  // A loan's `LOANBAL` is outstanding principal and an investment's `INVBAL`
  // is cash plus holdings; neither is the account's balance, so only a
  // `LEDGERBAL` is ever compared with the ledger.
  const ledger = flavour === 'investment' ? '' : aggregateBlock(text, 'LEDGERBAL')
  const balanceCents = parseMoneyToCents(tagValue(ledger, 'BALAMT') ?? '')
  const balanceOn = ofxDate(tagValue(ledger, 'DTASOF'))

  const notes: string[] = []
  if (flavour === 'investment') {
    notes.push('Only cash movements import from an investment statement.')
  } else if (flavour === 'loan' && balanceCents === null) {
    notes.push(
      "This loan statement's outstanding principal is not an account balance, so no closing figure is compared."
    )
  }

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

  if (flavour === 'investment') {
    const securities = [...text.matchAll(SECURITY_AGGREGATES)]
    if (securities.length > 0) {
      issues.push({
        line: lineOf(text, securities[0]?.index),
        message:
          securities.length === 1
            ? '1 securities entry was not imported — WageRoute records cash movements, not securities'
            : `${securities.length} securities entries were not imported — WageRoute records cash movements, not securities`
      })
    }
    const holdings = [...text.matchAll(/<(POSMF|POSSTOCK|POSDEBT|POSOPT|POSOTHER)>/gi)]
    if (holdings.length > 0) {
      issues.push({
        line: lineOf(text, holdings[0]?.index),
        message:
          holdings.length === 1
            ? '1 holding in the file was not imported — only cash movements land in the ledger'
            : `${holdings.length} holdings in the file were not imported — only cash movements land in the ledger`
      })
    }
  }

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
      balanceOn,
      notes
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
    balanceOn: null,
    notes: []
  }
}

/**
 * The heading the wizard puts above the file's own claims. A QIF is not a bank
 * statement and should not be described as one.
 */
export function statementLabel(info: StatementInfo): string {
  return info.kind === 'qif' ? 'QIF file' : 'Bank statement'
}

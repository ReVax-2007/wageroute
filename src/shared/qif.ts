import type { CsvEntry, CsvIssue } from './csv'
import { detectDateOrder, normalizeDate } from './csv'
import { parseMoneyToCents } from './money'
import type { StatementParse } from './statements'

/**
 * QIF is a flat, line-oriented format: every line starts with a one-letter code
 * and the record ends at `^`. It carries no institution, no account number and
 * no closing date, so a QIF import is checked by its lines alone.
 */

type Section = 'bank' | 'account' | 'skip' | 'investment'

interface Record {
  fields: Map<string, string[]>
  splits: string[]
  /** 1-based line the record started on, for the review list. */
  line: number
}

function sectionFor(type: string | null): Section {
  const value = (type ?? '').trim().toLocaleLowerCase()
  if (value === 'invst') return 'investment'
  if (
    value === 'cat' ||
    value === 'class' ||
    value === 'memorized' ||
    value === 'prices' ||
    value === 'payee' ||
    value === 'budget' ||
    value === 'security'
  ) {
    return 'skip'
  }
  return 'bank'
}

function joinDescription(payee: string, memo: string): string {
  if (payee && memo && !memo.toLocaleLowerCase().startsWith(payee.toLocaleLowerCase())) {
    return `${payee} — ${memo}`
  }
  return payee || memo
}

/** Splits are a Quicken budgeting nicety; one purchase stays one ledger row. */
function splitCategory(splits: readonly string[]): string | null {
  const named = [
    ...new Set(
      splits.map((category) => category.trim()).filter((category) => category && !category.startsWith('['))
    )
  ]
  return named.length === 1 ? (named[0] ?? null) : null
}

/**
 * Reads a Quicken Interchange Format file. Only a single account's cash, bank
 * or card history imports: a file naming several accounts is refused, because
 * every line would otherwise land in one account chosen by a guess, and an
 * investment section is reported instead of being silently dropped.
 */
export function parseQif(text: string): StatementParse {
  const lines = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n')
  const issues: CsvIssue[] = []
  const entries: CsvEntry[] = []
  const accounts: string[] = []
  let section: Section = 'skip'
  let investmentRows = 0
  let firstInvestmentLine = 0

  // The file's date order has to be known before the first record is read, so
  // the same rule as a CSV applies: scan every slashed date once, up front.
  const dateOrder = detectDateOrder(
    lines.filter((line) => line.startsWith('D')).map((line) => line.slice(1).replace(/'/g, '/'))
  )

  const flush = (record: Record): void => {
    if (record.fields.size === 0) return

    if (section === 'account') {
      const name = record.fields.get('N')?.[0]?.trim() ?? ''
      if (name) accounts.push(name)
      return
    }
    if (section === 'investment') {
      investmentRows += 1
      if (firstInvestmentLine === 0) firstInvestmentLine = record.line
      return
    }
    if (section !== 'bank') return

    const ordinal = record.line
    const date = normalizeDate((record.fields.get('D')?.[0] ?? '').replace(/'/g, '/'), dateOrder)
    if (!date) {
      issues.push({ line: ordinal, message: `statement line ${ordinal} has an unreadable date` })
      return
    }

    const amountCents = parseMoneyToCents(record.fields.get('T')?.[0] ?? '')
    if (amountCents === null || amountCents === 0) {
      issues.push({ line: ordinal, message: `statement line ${ordinal} has no usable amount` })
      return
    }

    const listed = record.fields.get('L')?.[0]?.trim() ?? ''
    if (listed.startsWith('[')) {
      issues.push({
        line: ordinal,
        message: `statement line ${ordinal} is a transfer — import a JSON backup to keep both legs`
      })
      return
    }

    entries.push({
      line: ordinal,
      occurredOn: date,
      // A QIF describes one account's history; the wizard asks which local
      // account that is, so no row carries a name to match against.
      accountName: '',
      institution: null,
      kind: amountCents > 0 ? 'income' : 'expense',
      category: listed || splitCategory(record.splits) || 'Uncategorized',
      memo: joinDescription(
        record.fields.get('P')?.[0]?.trim() ?? '',
        record.fields.get('M')?.[0]?.trim() ?? ''
      ),
      amountCents,
      externalId: null
    })
  }

  let record: Record = { fields: new Map(), splits: [], line: 1 }
  lines.forEach((raw, index) => {
    const trimmed = raw.trimEnd()
    if (!trimmed) return
    const code = trimmed[0] ?? ''

    if (code === '!') {
      const header = trimmed.slice(1).trim()
      if (/^account$/i.test(header)) section = 'account'
      else if (/^type:/i.test(header)) section = sectionFor(header.slice(5))
      return
    }

    if (code === '^') {
      flush(record)
      if (section === 'account') {
        // `!Account` names the account its transactions belong to; the block's
        // `T` field is the only place a file without `!Type:` states the kind.
        section = sectionFor(record.fields.get('T')?.[0] ?? '')
      }
      record = { fields: new Map(), splits: [], line: index + 2 }
      return
    }

    const value = trimmed.slice(1)
    if (record.fields.size === 0 && record.splits.length === 0) record.line = index + 1
    if (code === 'S') {
      record.splits.push(value)
      return
    }
    if (code === 'E' || code === '$' || code === '%') return
    const list = record.fields.get(code)
    if (list) list.push(value)
    else record.fields.set(code, [value])
  })
  flush(record)

  const uniqueAccounts = [...new Set(accounts)]
  if (uniqueAccounts.length > 1) {
    throw new Error(
      `That QIF holds ${uniqueAccounts.length} accounts (${uniqueAccounts.join(', ')}) — export one account at a time`
    )
  }
  if (entries.length === 0 && investmentRows > 0) {
    throw new Error(
      'That QIF holds investment activity, which WageRoute cannot import — export your cash account instead'
    )
  }
  if (entries.length === 0) {
    throw new Error('That QIF has no transactions — is it a Quicken export?')
  }
  if (investmentRows > 0) {
    issues.push({
      line: firstInvestmentLine,
      message: `${investmentRows} investment ${investmentRows === 1 ? 'record was' : 'records were'} not imported — a QIF imports cash rows only`
    })
  }

  const dates = entries.map((entry) => entry.occurredOn).sort()
  return {
    entries,
    issues,
    statement: {
      kind: 'qif',
      bank: null,
      accountLabel: uniqueAccounts[0] ?? null,
      currency: null,
      from: dates[0] ?? null,
      to: dates.at(-1) ?? null,
      balanceCents: null,
      balanceOn: null,
      notes: ['A QIF carries no closing balance, so nothing is compared with the ledger.']
    }
  }
}

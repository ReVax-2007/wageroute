import { normalizeSignedCents } from './kinds'
import { centsToEditable, parseMoneyToCents } from './money'
import type { Account, TransactionKind, TransactionRow } from './types'

function escapeCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

export function toCsv(rows: readonly (readonly string[])[]): string {
  return rows.map((row) => row.map(escapeCell).join(',')).join('\r\n')
}

export interface CsvSourceRow {
  /** First physical line of the row in the source file, 1-based. */
  line: number
  cells: string[]
}

/** RFC 4180-style reader: quoted cells may hold commas, quotes and newlines. */
export function parseCsvRows(text: string): CsvSourceRow[] {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const rows: CsvSourceRow[] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  let line = 1
  let rowStartLine = 1
  let quoteStartLine = 1

  const endField = (): void => {
    row.push(field)
    field = ''
  }
  const endRow = (): void => {
    endField()
    if (row.some((cell) => cell.trim() !== '')) rows.push({ line: rowStartLine, cells: row })
    row = []
    rowStartLine = line
  }

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          field += '"'
          index += 1
        } else {
          quoted = false
        }
      } else {
        if (char === '\n') line += 1
        field += char
      }
      continue
    }
    if (char === '"' && field === '') {
      quoted = true
      quoteStartLine = line
    } else if (char === ',') {
      endField()
    } else if (char === '\r') {
      if (source[index + 1] === '\n') index += 1
      line += 1
      endRow()
    } else if (char === '\n') {
      line += 1
      endRow()
    } else {
      field += char
    }
  }

  // An unclosed quote would silently fold every remaining row into one field,
  // so the import has to fail loudly instead of dropping rows.
  if (quoted) {
    throw new Error(
      `That CSV has an unclosed quote that starts on line ${quoteStartLine} — fix the file and try again`
    )
  }
  if (field !== '' || row.length > 0) endRow()
  return rows
}

export function parseCsv(text: string): string[][] {
  return parseCsvRows(text).map((row) => row.cells)
}

export interface CsvEntry {
  line: number
  occurredOn: string
  accountName: string
  institution: string | null
  kind: TransactionKind
  category: string
  memo: string
  amountCents: number
}

export interface CsvIssue {
  line: number
  message: string
}

export interface CsvEntryParse {
  entries: CsvEntry[]
  issues: CsvIssue[]
  /** False when the file is a bank statement with no Account column. */
  hasAccountColumn: boolean
}

const COLUMN_ALIASES = {
  date: ['date', 'occurred on', 'occurred_on', 'posted', 'posting date', 'date posted', 'transaction date'],
  account: ['account', 'account name', 'account_name'],
  institution: ['institution', 'bank', 'financial institution'],
  kind: ['kind', 'type', 'transaction type'],
  category: ['category'],
  memo: ['description', 'memo', 'note', 'notes', 'details', 'transaction details'],
  amount: ['amount', 'value'],
  debit: ['debit', 'debit amount', 'withdrawal', 'withdrawals', 'money out'],
  credit: ['credit', 'credit amount', 'deposit', 'deposits', 'money in']
} as const

type EntryColumn = keyof typeof COLUMN_ALIASES

const TRANSACTION_KINDS: readonly TransactionKind[] = [
  'income',
  'expense',
  'bill_payment',
  'transfer',
  'goal_funding',
  'investment',
  'adjustment'
]

const KIND_ALIASES: Record<string, TransactionKind> = {
  income: 'income',
  deposit: 'income',
  credit: 'income',
  expense: 'expense',
  debit: 'expense',
  withdrawal: 'expense',
  purchase: 'expense',
  payment: 'expense',
  bill_payment: 'bill_payment',
  bill: 'bill_payment',
  transfer: 'transfer',
  goal_funding: 'goal_funding',
  savings: 'goal_funding',
  investment: 'investment',
  adjustment: 'adjustment'
}

function normalizeHeader(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ')
}

function findColumns(row: readonly string[]): Partial<Record<EntryColumn, number>> {
  const columns: Partial<Record<EntryColumn, number>> = {}
  row.forEach((cell, index) => {
    const header = normalizeHeader(cell)
    for (const column of Object.keys(COLUMN_ALIASES) as EntryColumn[]) {
      if (columns[column] === undefined && (COLUMN_ALIASES[column] as readonly string[]).includes(header)) {
        columns[column] = index
      }
    }
  })
  return columns
}

function normalizeDate(raw: string): string | null {
  const text = raw.trim()
  let year: number
  let month: number
  let day: number

  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text)
  const slashed = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text)
  const yearFirst = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(text)

  if (iso) {
    year = Number(iso[1])
    month = Number(iso[2])
    day = Number(iso[3])
  } else if (slashed) {
    const first = Number(slashed[1])
    const second = Number(slashed[2])
    // A day above 12 cannot be a month, so the file is day-first (UK/EU).
    // Both components 12 or under stay month-first, matching the US default.
    if (first > 12 && second <= 12) {
      day = first
      month = second
    } else {
      month = first
      day = second
    }
    year = Number(slashed[3])
  } else if (yearFirst) {
    year = Number(yearFirst[1])
    month = Number(yearFirst[2])
    day = Number(yearFirst[3])
  } else {
    return null
  }

  const date = new Date(Date.UTC(year, month - 1, day))
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null
  }
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

function normalizeKind(raw: string, amountCents: number): TransactionKind {
  const key = raw.trim().toLowerCase().replace(/[\s-]+/g, '_')
  if (key && KIND_ALIASES[key]) return KIND_ALIASES[key]
  if (key && (TRANSACTION_KINDS as readonly string[]).includes(key)) {
    return key as TransactionKind
  }
  return amountCents > 0 ? 'income' : 'expense'
}

/**
 * Reads an entries file — the transactions CSV this app exports, or a similar
 * bank export. A file without an Account column is a bank statement: its rows
 * come back with no account name, and the wizard asks which account they
 * belong to instead of guessing.
 */
export function parseEntriesCsv(text: string): CsvEntryParse {
  const rows = parseCsvRows(text)
  let headerIndex = -1
  let columns: Partial<Record<EntryColumn, number>> = {}

  for (let index = 0; index < Math.min(rows.length, 10); index += 1) {
    const found = findColumns(rows[index].cells)
    const hasMoney =
      found.amount !== undefined || found.debit !== undefined || found.credit !== undefined
    if (found.date !== undefined && hasMoney) {
      headerIndex = index
      columns = found
      break
    }
  }

  if (headerIndex === -1) {
    throw new Error('That CSV needs a Date column and an Amount or Debit/Credit column')
  }

  const hasAccountColumn = columns.account !== undefined
  const entries: CsvEntry[] = []
  const issues: CsvIssue[] = []

  for (let index = headerIndex + 1; index < rows.length; index += 1) {
    const row = rows[index].cells
    const line = rows[index].line
    const cell = (column: EntryColumn): string => {
      const position = columns[column]
      return position === undefined ? '' : (row[position] ?? '').trim()
    }

    const occurredOn = normalizeDate(cell('date'))
    if (!occurredOn) {
      issues.push({ line, message: `row ${line} has an unreadable date` })
      continue
    }

    const accountName = cell('account')
    if (hasAccountColumn && !accountName) {
      issues.push({ line, message: `row ${line} has no account name` })
      continue
    }

    // A bank statement either states one signed amount or splits the direction
    // across Debit and Credit columns. Exactly one of those is fillable.
    const stated = cell('amount')
    const debit = cell('debit')
    const credit = cell('credit')
    let amountCents: number | null
    if (stated !== '') {
      amountCents = parseMoneyToCents(stated)
    } else if (debit !== '' && credit !== '') {
      issues.push({ line, message: `row ${line} has both a debit and a credit` })
      continue
    } else if (debit !== '') {
      const cents = parseMoneyToCents(debit)
      amountCents = cents === null ? null : -Math.abs(cents)
    } else if (credit !== '') {
      const cents = parseMoneyToCents(credit)
      amountCents = cents === null ? null : Math.abs(cents)
    } else {
      amountCents = null
    }
    if (amountCents === null || amountCents === 0) {
      issues.push({ line, message: `row ${line} has no usable amount` })
      continue
    }

    const kind = normalizeKind(cell('kind'), amountCents)
    if (kind === 'transfer') {
      issues.push({ line, message: `row ${line} is a transfer — import a JSON backup to keep both legs` })
      continue
    }

    const institution = cell('institution')

    entries.push({
      line,
      occurredOn,
      accountName,
      institution: institution || null,
      kind,
      category: cell('category') || 'Uncategorized',
      memo: cell('memo'),
      // A file that states the kind but writes an unsigned amount is common;
      // the kind decides the sign so an expense can never import as income.
      amountCents: normalizeSignedCents(kind, amountCents)
    })
  }

  return { entries, issues, hasAccountColumn }
}

export function transactionsToCsv(
  transactions: readonly TransactionRow[],
  accounts: readonly Account[],
  currency: string
): string {
  const institutionById = new Map(accounts.map((account) => [account.id, account.institution ?? '']))
  const rows: string[][] = [
    ['Date', 'Account', 'Institution', 'Kind', 'Category', 'Description', 'Amount', 'Currency']
  ]

  for (const transaction of transactions) {
    rows.push([
      transaction.occurredOn,
      defuseFormula(transaction.accountName),
      defuseFormula(institutionById.get(transaction.accountId) ?? transaction.accountInstitution ?? ''),
      transaction.kind,
      defuseFormula(transaction.category),
      defuseFormula(transaction.memo),
      centsToEditable(transaction.amountCents),
      currency
    ])
  }

  return toCsv(rows)
}

/**
 * A spreadsheet opens a cell that starts with these as a formula, so a memo of
 * `=HYPERLINK(...)` would become a live link. Text columns only: amounts and
 * dates start with `-` or a digit and must stay machine-readable.
 */
function defuseFormula(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value
}

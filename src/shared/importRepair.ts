import { parseMoneyToCents } from './money'

export type ImportTable =
  | 'accounts'
  | 'bills'
  | 'goals'
  | 'paychecks'
  | 'allocations'
  | 'bill_reserves'
  | 'transactions'
  | 'settings'

export const IMPORT_TABLES: readonly ImportTable[] = [
  'accounts',
  'bills',
  'goals',
  'paychecks',
  'allocations',
  'bill_reserves',
  'transactions',
  'settings'
]

export type ImportTables = Record<ImportTable, Record<string, unknown>[]>

export type ImportChoiceTable = 'accounts' | 'bills' | 'goals' | 'paychecks'

export interface ImportChoice {
  id: string
  label: string
}

export type RepairInput = 'text' | 'money' | 'integer' | 'date' | 'enum' | 'ref'

export interface FieldSpec {
  column: string
  label: string
  input: RepairInput
  options?: readonly string[]
  /** Inclusive lower bound, in cents for money fields. */
  min?: number
  max?: number
  refTable?: ImportChoiceTable
  /** Nullable references can be cleared instead of pointed at something. */
  nullable?: boolean
}

const KIND_ACCOUNT = ['checking', 'savings', 'cash', 'investment', 'credit']
const KIND_FREQUENCY = ['weekly', 'biweekly', 'semimonthly', 'monthly', 'quarterly', 'annual']
const KIND_HEALTH = ['covered', 'tight', 'shortfall']
const KIND_BUCKET = ['priority', 'savings', 'investment', 'goal', 'debt', 'leisure']
const KIND_RESERVE = ['reserved', 'paid']
const KIND_TRANSACTION = [
  'income',
  'expense',
  'bill_payment',
  'transfer',
  'goal_funding',
  'investment',
  'adjustment'
]

/**
 * Columns with no schema default: SQLite rejects NULL for these and CHECK
 * rejects the values outside the range, so the wizard has to ask for them.
 * Columns that do have a default are filled silently by the importer.
 */
const REQUIRED_FIELDS: Record<ImportTable, readonly FieldSpec[]> = {
  accounts: [
    { column: 'name', label: 'Account name', input: 'text' },
    { column: 'kind', label: 'Account type', input: 'enum', options: KIND_ACCOUNT }
  ],
  bills: [
    { column: 'name', label: 'Bill name', input: 'text' },
    { column: 'amount_cents', label: 'Bill amount', input: 'money', min: 1 },
    { column: 'frequency', label: 'How often', input: 'enum', options: KIND_FREQUENCY },
    { column: 'due_day', label: 'Day of month', input: 'integer', min: 1, max: 31 }
  ],
  goals: [
    { column: 'name', label: 'Goal name', input: 'text' },
    { column: 'target_cents', label: 'Target amount', input: 'money', min: 1 }
  ],
  paychecks: [
    { column: 'amount_cents', label: 'Gross pay', input: 'money', min: 1 },
    { column: 'received_on', label: 'Pay date', input: 'date' },
    { column: 'health', label: 'Paycheck status', input: 'enum', options: KIND_HEALTH }
  ],
  allocations: [
    { column: 'label', label: 'Allocation label', input: 'text' },
    { column: 'bucket', label: 'Bucket', input: 'enum', options: KIND_BUCKET },
    { column: 'amount_cents', label: 'Allocated amount', input: 'money', min: 0 }
  ],
  bill_reserves: [
    { column: 'cycle', label: 'Reserve month', input: 'text' },
    { column: 'amount_cents', label: 'Reserved amount', input: 'money', min: 0 },
    { column: 'state', label: 'Reserve state', input: 'enum', options: KIND_RESERVE }
  ],
  transactions: [
    { column: 'kind', label: 'Transaction type', input: 'enum', options: KIND_TRANSACTION },
    { column: 'amount_cents', label: 'Amount', input: 'money' },
    { column: 'occurred_on', label: 'Date', input: 'date' }
  ],
  settings: [
    { column: 'key', label: 'Setting key', input: 'text' },
    { column: 'value', label: 'Setting value', input: 'text' }
  ]
}

/** Foreign keys, so a row pointing at something that does not exist can be redirected. */
const REFERENCE_FIELDS: Record<ImportTable, readonly FieldSpec[]> = {
  accounts: [
    { column: 'dedicated_goal_id', label: 'Dedicated goal', input: 'ref', refTable: 'goals', nullable: true }
  ],
  bills: [
    { column: 'account_id', label: 'Posting account', input: 'ref', refTable: 'accounts', nullable: true }
  ],
  goals: [
    { column: 'account_id', label: 'Linked account', input: 'ref', refTable: 'accounts', nullable: true }
  ],
  paychecks: [
    { column: 'deposit_account_id', label: 'Deposit account', input: 'ref', refTable: 'accounts', nullable: true }
  ],
  allocations: [
    { column: 'paycheck_id', label: 'Paycheck', input: 'ref', refTable: 'paychecks', nullable: false },
    { column: 'goal_id', label: 'Goal', input: 'ref', refTable: 'goals', nullable: true }
  ],
  bill_reserves: [
    { column: 'bill_id', label: 'Bill', input: 'ref', refTable: 'bills', nullable: false },
    { column: 'paycheck_id', label: 'Paycheck', input: 'ref', refTable: 'paychecks', nullable: false }
  ],
  transactions: [
    { column: 'account_id', label: 'Posting account', input: 'ref', refTable: 'accounts', nullable: false },
    { column: 'bill_id', label: 'Bill', input: 'ref', refTable: 'bills', nullable: true },
    { column: 'goal_id', label: 'Goal', input: 'ref', refTable: 'goals', nullable: true },
    { column: 'paycheck_id', label: 'Paycheck', input: 'ref', refTable: 'paychecks', nullable: true },
    { column: 'counter_account_id', label: 'Other side', input: 'ref', refTable: 'accounts', nullable: true }
  ],
  settings: []
}

const TABLE_NOUN: Record<ImportTable, string> = {
  accounts: 'account',
  bills: 'bill',
  goals: 'goal',
  paychecks: 'paycheck',
  allocations: 'allocation',
  bill_reserves: 'bill reserve',
  transactions: 'transaction',
  settings: 'setting'
}

export interface ImportProblem {
  /** Stable key the answer refers back to: `b:<table>:<rowIndex>:<column>` or `e:<line>`. */
  key: string
  scope: 'backup' | 'entry'
  table: ImportTable
  rowIndex: number
  line?: number
  field: FieldSpec
  /** Which row this is, for display. */
  rowLabel: string
  reason: string
  /** How to repair it in the source file instead, shown when the row is dropped. */
  fixHint: string
  suggested: string
}

export interface ImportAnswer {
  key: string
  /** Raw text from the wizard, or a choice id for references. Empty clears a nullable reference. */
  value: string
  skip: boolean
}

export interface ImportContext {
  /** Every id the database will accept: rows already local plus rows in this file. */
  knownIds: Record<ImportTable, Set<string>>
  choices: Record<ImportChoiceTable, ImportChoice[]>
  today: string
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

/**
 * Adds the ids this file creates itself, because a row may point at another row
 * in the same file that is imported first.
 */
export function withFileIds(base: ImportContext, tables: ImportTables): ImportContext {
  const knownIds = {} as Record<ImportTable, Set<string>>
  for (const table of IMPORT_TABLES) knownIds[table] = new Set(base.knownIds[table])
  for (const table of IMPORT_TABLES) {
    for (const row of tables[table] ?? []) {
      if (typeof row.id === 'string' && row.id) knownIds[table].add(row.id)
    }
  }
  return { knownIds, choices: base.choices, today: base.today }
}

function isEmpty(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '')
}

function rowLabelOf(table: ImportTable, row: Record<string, unknown>, index: number): string {
  for (const column of ['name', 'label', 'memo', 'key']) {
    const value = row[column]
    if (typeof value === 'string' && value.trim()) return `${TABLE_NOUN[table]} “${value.trim()}”`
  }
  const id = row.id
  if (typeof id === 'string' && id.trim()) return `${TABLE_NOUN[table]} ${id.slice(0, 8)}`
  return `${TABLE_NOUN[table]} row ${index + 1}`
}

function reasonFor(spec: FieldSpec, missing: boolean, value: unknown): string {
  if (missing) return `${spec.label.toLowerCase()} is missing`
  if (typeof value === 'object' || typeof value === 'boolean') {
    return `${spec.label.toLowerCase()} is not a plain value`
  }
  return `${spec.label.toLowerCase()} is not valid (${String(value)})`
}

function hintFor(spec: FieldSpec, table: ImportTable): string {
  const named = `Set "${spec.column}" on that ${TABLE_NOUN[table]}`
  switch (spec.input) {
    case 'money':
      return `${named} to an amount in dollars and cents${spec.min === 1 ? ' above zero' : ''}, e.g. 125.50.`
    case 'integer':
      return `${named} to a whole number between ${spec.min} and ${spec.max}.`
    case 'enum':
      return `${named} to one of: ${spec.options?.join(', ')}.`
    case 'date':
      return `${named} to a date as YYYY-MM-DD.`
    case 'ref':
      return spec.nullable
        ? `${named} to an existing ${spec.refTable?.slice(0, -1)}, or leave it empty.`
        : `${named} to the id of an existing ${spec.refTable?.slice(0, -1)}.`
    default:
      return `${named} to a value for ${spec.label.toLowerCase()}.`
  }
}

function suggestionFor(spec: FieldSpec, context: ImportContext): string {
  if (spec.input === 'date') return context.today
  if (spec.input === 'ref' && !spec.nullable && spec.refTable) {
    return context.choices[spec.refTable][0]?.id ?? ''
  }
  return ''
}

function refIsKnown(spec: FieldSpec, value: unknown, context: ImportContext): boolean {
  const id = typeof value === 'string' ? value : ''
  return spec.refTable !== undefined && context.knownIds[spec.refTable].has(id)
}

/**
 * Everything the wizard still needs to ask about before this file can import.
 * Pure: the same file and database always produce the same problems, which is
 * how the main process re-derives them when the answers come back.
 */
export function findImportProblems(
  tables: ImportTables,
  context: ImportContext
): ImportProblem[] {
  const problems: ImportProblem[] = []

  const push = (
    table: ImportTable,
    row: Record<string, unknown>,
    index: number,
    spec: FieldSpec,
    missing: boolean,
    value: unknown
  ) => {
    problems.push({
      key: `b:${table}:${index}:${spec.column}`,
      scope: 'backup',
      table,
      rowIndex: index,
      field: spec,
      rowLabel: rowLabelOf(table, row, index),
      reason: reasonFor(spec, missing, value),
      fixHint: hintFor(spec, table),
      suggested: suggestionFor(spec, context)
    })
  }

  for (const table of IMPORT_TABLES) {
    const rows = tables[table] ?? []
    rows.forEach((row, index) => {
      for (const spec of REQUIRED_FIELDS[table]) {
        const value = row[spec.column]
        if (isEmpty(value)) {
          push(table, row, index, spec, true, value)
          continue
        }
        const verdict = validateFieldValue(spec, value, context)
        if (!verdict.ok) push(table, row, index, spec, false, value)
      }
      for (const spec of REFERENCE_FIELDS[table]) {
        const value = row[spec.column]
        if (isEmpty(value)) {
          // A nullable reference simply stays empty; a required one needs asking.
          if (!spec.nullable) push(table, row, index, spec, true, value)
          continue
        }
        if (typeof value === 'string' && refIsKnown(spec, value, context)) continue
        push(table, row, index, spec, false, value)
      }
    })
  }

  return problems
}

export type FieldVerdict = { ok: true; value: string | number | null } | { ok: false; message: string }

/** Turns a value from the file (or the wizard's text box) into something SQLite accepts. */
export function validateFieldValue(spec: FieldSpec, raw: unknown, context: ImportContext): FieldVerdict {
  if (spec.input === 'ref') {
    if (isEmpty(raw)) {
      return spec.nullable ? { ok: true, value: null } : { ok: false, message: `${spec.label} needs a value` }
    }
    const id = typeof raw === 'string' ? raw : ''
    if (!spec.refTable || !context.knownIds[spec.refTable].has(id)) {
      return { ok: false, message: `That ${spec.refTable?.slice(0, -1)} does not exist` }
    }
    return { ok: true, value: id }
  }

  if (raw === undefined || raw === null) {
    return { ok: false, message: `${spec.label} is missing` }
  }

  const text = typeof raw === 'string' ? raw : typeof raw === 'number' ? String(raw) : ''
  if (typeof raw === 'object' || typeof raw === 'boolean') {
    return { ok: false, message: `${spec.label} is not a plain value` }
  }

  switch (spec.input) {
    case 'text': {
      const trimmed = String(raw).trim()
      return trimmed ? { ok: true, value: trimmed } : { ok: false, message: `${spec.label} is empty` }
    }
    case 'money': {
      const cents = parseMoneyToCents(String(raw))
      if (cents === null) return { ok: false, message: `${spec.label} is not an amount` }
      if (spec.min !== undefined && cents < spec.min) {
        return { ok: false, message: `${spec.label} must be at least ${spec.min / 100}` }
      }
      return { ok: true, value: cents }
    }
    case 'integer': {
      const number = Number(String(raw).trim())
      if (!Number.isInteger(number)) return { ok: false, message: `${spec.label} must be a whole number` }
      if (spec.min !== undefined && number < spec.min) return { ok: false, message: `${spec.label} must be ${spec.min} or more` }
      if (spec.max !== undefined && number > spec.max) return { ok: false, message: `${spec.label} must be ${spec.max} or less` }
      return { ok: true, value: number }
    }
    case 'date': {
      const iso = String(raw).trim()
      if (!DATE_PATTERN.test(iso) || Number.isNaN(Date.parse(iso))) {
        return { ok: false, message: `${spec.label} must look like 2026-01-31` }
      }
      return { ok: true, value: iso }
    }
    case 'enum': {
      const option = String(raw).trim()
      if (!spec.options?.includes(option)) {
        return { ok: false, message: `${spec.label} must be one of ${spec.options?.join(', ')}` }
      }
      return { ok: true, value: option }
    }
  }
}

export interface DroppedRow {
  rowLabel: string
  /** Why this row was left out, naming every problem on it. */
  reason: string
  /** How to repair the same row in the source file for a later import. */
  fixHint: string
}

export interface RepairedImport {
  tables: ImportTables
  dropped: DroppedRow[]
}

/**
 * Applies wizard answers to a parsed backup. A row whose answer is missing or
 * still invalid is dropped with an explanation instead of throwing, so the rest
 * of the file always lands. Problems are re-derived by the caller with the same
 * inputs, which is what makes these `table:index` keys safe to rely on.
 */
export function applyImportAnswers(
  tables: ImportTables,
  problems: readonly ImportProblem[],
  answers: readonly ImportAnswer[],
  context: ImportContext
): RepairedImport {
  const problemByKey = new Map(problems.map((problem) => [problem.key, problem]))
  const rowKeyOf = (problem: ImportProblem): string => `${problem.table}:${problem.rowIndex}`

  const edits = new Map<string, Record<string, unknown>>()
  const drops = new Map<string, DroppedRow>()

  const markDropped = (problem: ImportProblem, reason: string): void => {
    const rowKey = rowKeyOf(problem)
    const existing = drops.get(rowKey)
    if (existing) existing.reason = `${existing.reason}; ${reason}`
    else drops.set(rowKey, { rowLabel: problem.rowLabel, reason, fixHint: problem.fixHint })
    edits.delete(rowKey)
  }

  for (const answer of answers) {
    const problem = problemByKey.get(answer.key)
    if (!problem) continue
    if (answer.skip) {
      markDropped(problem, `${problem.reason} — skipped on request`)
      continue
    }
    const verdict = validateFieldValue(problem.field, answer.value, context)
    if (!verdict.ok) {
      markDropped(problem, `${problem.reason} — ${verdict.message}`)
      continue
    }
    const patch = edits.get(rowKeyOf(problem)) ?? {}
    patch[problem.field.column] = verdict.value
    edits.set(rowKeyOf(problem), patch)
  }

  // Problems nobody answered at all must not reach the database either.
  const answered = new Set(answers.map((answer) => answer.key))
  for (const problem of problems) {
    if (!answered.has(problem.key) && !drops.has(rowKeyOf(problem))) {
      markDropped(problem, `${problem.reason} — left blank`)
    }
  }

  const out = {} as ImportTables
  for (const table of IMPORT_TABLES) {
    const kept: Record<string, unknown>[] = []
    ;(tables[table] ?? []).forEach((row, index) => {
      const rowKey = `${table}:${index}`
      if (drops.has(rowKey)) return
      const patch = edits.get(rowKey)
      kept.push(patch ? Object.assign({}, row, patch) : row)
    })
    out[table] = kept
  }

  return { tables: out, dropped: [...drops.values()] }
}

/** Account names from a CSV that no local account matched, grouped for one prompt each. */
export interface EntryMapping {
  /** Matched on the trimmed lowercase name, the same way entries.ts resolves it. */
  accountName: string
  displayName: string
  firstLine: number
  lines: number
}

export function findUnmappedAccounts(
  entries: { line: number; accountName: string }[],
  knownNames: Set<string>
): EntryMapping[] {
  const byName = new Map<string, EntryMapping>()
  for (const entry of entries) {
    const name = entry.accountName.trim().toLocaleLowerCase()
    if (!name || knownNames.has(name)) continue
    const existing = byName.get(name)
    if (existing) {
      existing.lines += 1
      continue
    }
    byName.set(name, {
      accountName: name,
      displayName: entry.accountName.trim(),
      firstLine: entry.line,
      lines: 1
    })
  }
  return [...byName.values()]
}

export function buildAccountMap(
  mappings: readonly EntryMapping[],
  answers: readonly ImportAnswer[]
): Record<string, string> {
  const byLine = new Map(mappings.map((mapping) => [`e:${mapping.firstLine}`, mapping]))
  // Null prototype: an account literally named "constructor" must not match
  // Object.prototype when the caller asks whether it was mapped.
  const map: Record<string, string> = Object.create(null) as Record<string, string>
  for (const answer of answers) {
    const mapping = byLine.get(answer.key)
    if (!mapping || answer.skip || !answer.value) continue
    map[mapping.accountName] = answer.value
  }
  return map
}

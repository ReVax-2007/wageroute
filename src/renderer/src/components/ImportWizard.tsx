import { useEffect, useMemo, useState, type ChangeEvent } from 'react'
import { Download } from 'lucide-react'
import type { ImportCounts } from '@shared/api'
import type { ImportAnswer, ImportProblem, ImportTable } from '@shared/importRepair'
import { formatMoney } from '@shared/money'
import type { StatementInfo } from '@shared/statements'
import { useFinanceStore } from '../store/useFinanceStore'
import { Button, Field, Modal } from './ui'

const STEPS = [
  { id: 1, label: 'Choose file' },
  { id: 2, label: 'Missing info' },
  { id: 3, label: 'Review' }
] as const

type RowState = 'repaired' | 'skipped' | 'empty'

interface RowDecision {
  key: string
  label: string
  /** The table this row lands in, so the review can subtract skipped rows. */
  table: ImportTable
  state: RowState
  reasons: string[]
  fixHints: string[]
  problems: ImportProblem[]
}

function fileNameOf(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}

function rowKeyOf(problem: ImportProblem): string {
  return problem.scope === 'entry' ? `${problem.key}` : `${problem.table}:${problem.rowIndex}`
}

function describeFiles(rows: ImportCounts): string {
  const parts = (Object.entries(rows) as [keyof ImportCounts, number][])
    .filter(([, count]) => count > 0)
    .map(([table, count]) => `${count} ${table.replace(/s$/, '')}${count === 1 ? '' : 's'}`)
  return parts.length > 0 ? parts.join(' · ') : 'no rows'
}

/** What the bank's own file claims, printed so it can be checked against the paper. */
function statementSummary(info: StatementInfo): string {
  const parts: string[] = []
  if (info.bank) parts.push(info.bank)
  if (info.accountLabel) parts.push(`account ${info.accountLabel}`)
  if (info.from && info.to) parts.push(`${info.from} → ${info.to}`)
  if (info.balanceCents !== null) {
    const on = info.balanceOn ? ` on ${info.balanceOn}` : ''
    parts.push(`closing balance ${formatMoney(info.balanceCents, info.currency ?? 'USD')}${on}`)
  }
  return parts.join(' · ')
}

/**
 * Groups the wizard's questions by row: one row can be missing several things,
 * and dropping it should be reported once with every reason attached.
 */
function decisionsFor(
  problems: readonly ImportProblem[],
  draft: Record<string, { value: string; skip: boolean }>
): Map<string, RowDecision> {
  const rows = new Map<string, RowDecision>()

  for (const problem of problems) {
    const key = rowKeyOf(problem)
    const answer = draft[problem.key]
    const value = (answer?.value ?? problem.suggested).trim()
    // A blank reference is only an answer when the column may be NULL.
    const state: RowState = answer?.skip
      ? 'skipped'
      : value === '' && !(problem.field.input === 'ref' && problem.field.nullable)
        ? 'empty'
        : 'repaired'

    const existing = rows.get(key)
    if (!existing) {
      rows.set(key, {
        key,
        label: problem.rowLabel,
        table: problem.table,
        state,
        reasons: [problem.reason],
        fixHints: [problem.fixHint],
        problems: [problem]
      })
      continue
    }
    existing.reasons.push(problem.reason)
    existing.fixHints.push(problem.fixHint)
    existing.problems.push(problem)
    // The worst verdict for the row wins: one unanswered field drops the whole row.
    if (state === 'empty' || (state === 'skipped' && existing.state === 'repaired')) {
      existing.state = state
    }
  }

  return rows
}

export function ImportWizard() {
  const preview = useFinanceStore((state) => state.importPreview)
  const step = useFinanceStore((state) => state.importStep)
  const busy = useFinanceStore((state) => state.busy)
  const goStep = useFinanceStore((state) => state.goImportStep)
  const closeImport = useFinanceStore((state) => state.closeImport)
  const runImport = useFinanceStore((state) => state.runImport)
  const [draft, setDraft] = useState<Record<string, { value: string; skip: boolean }>>({})
  const [importError, setImportError] = useState<string | null>(null)
  const token = preview?.token

  useEffect(() => {
    setDraft({})
    setImportError(null)
  }, [token])

  const problems = preview?.problems ?? []
  const decisions = useMemo(() => decisionsFor(problems, draft), [problems, draft])
  const rows = [...decisions.values()]
  const repaired = rows.filter((row) => row.state === 'repaired')
  const skipped = rows.filter((row) => row.state === 'skipped')
  const empty = rows.filter((row) => row.state === 'empty')
  const leftOut = [...skipped, ...empty]

  if (!preview) return null

  const currentStep = step === 'fix' ? 2 : 3
  // A CSV question covers every line that shares an account name, not one row.
  const isLines = preview.format === 'entries'
  const oneNoun = isLines ? 'line' : 'row'
  const manyNoun = isLines ? 'lines' : 'rows'
  const leaveOutLabel = isLines ? 'Leave these lines out' : 'Leave this row out'
  const fillInLabel = isLines ? 'Fill these lines in instead' : 'Fill this row in instead'
  const leftOutNote = isLines ? 'you chose to leave them out' : 'you chose to leave it out'
  const parseIssues = preview.issues ?? []
  // A statement with no account chosen would write nothing, so the confirm
  // waits for an answer instead of producing an empty import.
  const statementNeedsAccount = preview.statement !== undefined && empty.length > 0

  // The review must promise only what will actually be written: rows the user
  // left out are subtracted from the file's own totals.
  const survivingRows: ImportCounts = { ...preview.fileRows }
  for (const row of leftOut) {
    if (survivingRows[row.table] > 0) survivingRows[row.table] -= 1
  }

  const setAnswer = (problem: ImportProblem, value: string): void => {
    setDraft((state) => ({
      ...state,
      [problem.key]: { value, skip: state[problem.key]?.skip ?? false }
    }))
  }

  const setSkip = (row: RowDecision, skip: boolean): void => {
    setDraft((state) => {
      const next = { ...state }
      for (const problem of row.problems) {
        next[problem.key] = { value: state[problem.key]?.value ?? problem.suggested, skip }
      }
      return next
    })
  }

  const answers = (): ImportAnswer[] =>
    problems.map((problem) => ({
      key: problem.key,
      value: draft[problem.key]?.value ?? problem.suggested,
      skip: draft[problem.key]?.skip ?? false
    }))

  const editor = (problem: ImportProblem) => {
    const { field } = problem
    const value = draft[problem.key]?.value ?? problem.suggested

    if (field.input === 'enum' || field.input === 'ref') {
      const choices =
        field.input === 'ref' ? (preview.choices[field.refTable ?? 'accounts'] ?? []) : []
      return (
        <select
          className="select"
          value={value}
          onChange={(event) => setAnswer(problem, event.target.value)}
        >
          <option value="">
            {field.input === 'ref' && field.nullable
              ? 'Leave unlinked'
              : `Choose ${field.label.toLowerCase()}…`}
          </option>
          {field.input === 'enum'
            ? field.options?.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))
            : choices.map((choice) => (
                <option key={choice.id} value={choice.id}>
                  {choice.label}
                </option>
              ))}
        </select>
      )
    }

    if (field.input === 'date') {
      return (
        <input
          className="input"
          type="date"
          value={value}
          onChange={(event: ChangeEvent<HTMLInputElement>) => setAnswer(problem, event.target.value)}
        />
      )
    }

    return (
      <input
        className="input"
        value={value}
        inputMode={field.input === 'money' || field.input === 'integer' ? 'decimal' : undefined}
        placeholder={field.input === 'money' ? '125.50' : ''}
        onChange={(event: ChangeEvent<HTMLInputElement>) => setAnswer(problem, event.target.value)}
      />
    )
  }

  const isSkipped = (row: RowDecision): boolean => row.problems.some((problem) => draft[problem.key]?.skip)

  /** How an answer reads back to the user on the review step. */
  const displayOf = (problem: ImportProblem): string => {
    const value = (draft[problem.key]?.value ?? problem.suggested).trim()
    if (problem.field.input === 'ref') {
      const options = preview.choices[problem.field.refTable ?? 'accounts'] ?? []
      return options.find((choice) => choice.id === value)?.label ?? (value || 'left unlinked')
    }
    return value
  }

  return (
    <Modal
      wide
      title="Import your data"
      subtitle={`${fileNameOf(preview.path)} · ${
        preview.statement
          ? 'bank statement'
          : preview.format === 'entries'
            ? 'entry list'
            : 'WageRoute backup'
      }`}
      onClose={closeImport}
      footer={
        <>
          <Button variant="quiet" onClick={closeImport}>
            Cancel
          </Button>
          {currentStep === 2 && problems.length > 0 && (
            <Button onClick={() => goStep('review')}>Review import</Button>
          )}
          {currentStep === 3 && problems.length > 0 && (
            <Button onClick={() => goStep('fix')}>Back to missing info</Button>
          )}
          <Button
            variant="primary"
            disabled={busy || statementNeedsAccount}
            icon={<Download size={15} />}
            onClick={async () => {
              setImportError(null)
              const failure = await runImport(answers())
              if (failure) setImportError(failure)
            }}
          >
            {busy ? 'Importing…' : 'Import'}
          </Button>
        </>
      }
    >
      <nav className="wizard-rail" aria-label="Import steps">
        {STEPS.map((entry) => {
          const state =
            entry.id < currentStep ? 'done' : entry.id === currentStep ? 'active' : 'todo'
          const label = (
            <>
              <span className="wizard-step-number">{entry.id}</span>
              <span>{entry.label}</span>
            </>
          )
          // Only the current step and a step you can return to are focusable;
          // nothing here reopens the file picker and discards the draft.
          if (entry.id === currentStep) {
            return (
              <span key={entry.id} className={`wizard-step-chip ${state}`} aria-current="step">
                {label}
              </span>
            )
          }
          if (entry.id === 2 && currentStep === 3 && problems.length > 0) {
            return (
              <button
                key={entry.id}
                type="button"
                className={`wizard-step-chip ${state}`}
                onClick={() => goStep('fix')}
              >
                {label}
              </button>
            )
          }
          return (
            <span key={entry.id} className={`wizard-step-chip ${state}`}>
              {label}
            </span>
          )
        })}
      </nav>

      <div className="wizard-step" key={currentStep}>
        {preview.statement && (
          <p className="wizard-hint">
            <strong>Bank statement</strong> · {statementSummary(preview.statement)}
          </p>
        )}
        {parseIssues.length > 0 && (
          <div className="import-review-list">
            <strong>Left out while reading</strong>
            {parseIssues.map((issue, index) => (
              <p className="import-review-row" key={`${issue.line ?? 'file'}-${index}`}>
                {issue.message}
              </p>
            ))}
          </div>
        )}
        {currentStep === 2 && (
          <>
            <p className="wizard-hint">
              {`These ${manyNoun} lack something the ledger needs. Fill each one in and it imports as repaired; leave one out and the rest of the file still lands.`}
            </p>
            {rows.map((row) => (
              <div className="import-problem" key={row.key}>
                <div className="import-problem-head">
                  <strong>{row.label}</strong>
                  <span className="import-problem-reason">{row.reasons.join(' · ')}</span>
                </div>
                {isSkipped(row) ? (
                  <p className="import-problem-hint">{row.fixHints.join(' ')}</p>
                ) : (
                  row.problems.map((problem) => (
                    <Field
                      key={problem.key}
                      label={problem.field.label}
                      hint={
                        problem.field.input === 'money'
                          ? 'Dollars and cents: 12.34 means $12.34, not 1,234'
                          : undefined
                      }
                    >
                      {editor(problem)}
                    </Field>
                  ))
                )}
                <div className="import-problem-actions">
                  <Button size="sm" onClick={() => setSkip(row, !isSkipped(row))}>
                    {isSkipped(row) ? fillInLabel : leaveOutLabel}
                  </Button>
                </div>
              </div>
            ))}
          </>
        )}

        {currentStep === 3 && (
          <>
            <p className="wizard-hint">
              Importing <strong>{describeFiles(survivingRows)}</strong> from{' '}
              {fileNameOf(preview.path)}. Everything already in this app stays exactly as it is —
              the import only adds what is missing.
            </p>
            {busy && (
              <p className="wizard-hint" role="status">
                Writing to the local database… large backups can take a moment.
              </p>
            )}
            {importError && (
              <p className="form-error" role="alert">
                {importError} Nothing was half-written: imports either land together or not at
                all, so it is safe to try again.
              </p>
            )}
            {repaired.length > 0 && (
              <div className="import-review-list">
                <strong>{isLines ? 'Lines you mapped' : 'Rows you filled in'}</strong>
                {repaired.map((row) => (
                  <p className="import-review-row" key={row.key}>
                    <strong>{row.label}</strong>
                    {row.problems.map((problem) => (
                      <span key={problem.key}>
                        {' '}
                        · {problem.field.label.toLowerCase()}: “{displayOf(problem)}”
                      </span>
                    ))}
                  </p>
                ))}
              </div>
            )}
            {leftOut.length > 0 && (
              <div className="import-review-list">
                <strong>Not imported</strong>
                {leftOut.map((row) => (
                  <p className="import-review-row" key={row.key}>
                    <strong>{row.label}</strong> — {row.reasons.join(', ')}
                    {row.state === 'skipped' ? ` — ${leftOutNote}` : ' — nothing was filled in'}.{' '}
                    {row.fixHints.join(' ')}
                  </p>
                ))}
              </div>
            )}
            {empty.length > 0 && (
              <p className="form-error">
                {empty.length === 1
                  ? `1 ${oneNoun} is still incomplete. Fill it in, or it will be skipped.`
                  : `${empty.length} ${manyNoun} are still incomplete. Fill them in, or they will be skipped.`}
              </p>
            )}
            {leftOut.length > 0 && (
              <p className="wizard-hint">
                Importing this file again after fixing what was left out is safe: records that
                already landed are recognised and skipped.
              </p>
            )}
          </>
        )}
      </div>
    </Modal>
  )
}

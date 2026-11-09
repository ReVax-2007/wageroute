import { useMemo, useState } from 'react'
import { Pencil, Plus } from 'lucide-react'
import {
  cardOwedCents,
  cardPaymentSources,
  countsInSafeToSpend
} from '@shared/accounts'
import {
  ADJUST_MODES,
  adjustmentPresetsFor,
  resolveAdjustBalance,
  type AdjustMode,
  type AdjustmentReason
} from '@shared/adjustments'
import { formatDateLabel, todayISO } from '@shared/dates'
import { accountDeletionWords, archiveVsDeleteHint } from '@shared/deletion'
import { centsToEditable, formatMoney, parseMoneyToCents } from '@shared/money'
import type { AccountKind, AccountWithBalance } from '@shared/types'
import { validateAccountForm, type AccountFormProblems } from '@shared/writeRules'
import {
  ACCOUNT_KIND_LABEL,
  accountDisplayBalanceCents,
  cardStatus,
  cashOnHand,
  creditAvailableCents,
  creditOwedCents
} from '../../renderer/src/lib/finance'
import { Field } from '../components/Field'
import { DeleteConfirm } from '../components/DeleteConfirm'
import { MoneyInput, PercentInput } from '../components/MoneyInput'
import { Sheet } from '../components/Sheet'
import { useSheetSave } from '../components/useSheetSave'
import { pocketView } from '../lib/compute'
import { usePocket, useSnapshot } from '../lib/store'
import {
  createAccount,
  createEntry,
  deleteAccount,
  doomedAccountEntryIds,
  patchAccount,
  setAccountArchived
} from '../lib/write'

const KINDS: AccountKind[] = ['checking', 'savings', 'cash', 'credit', 'investment']

// The same eight colours, in the same order, as the desktop's palette. The rows
// store `var(--name)` so both devices paint the swatch from their own tokens.
const ACCOUNT_COLORS = [
  { name: 'Blue', value: 'var(--savings)' },
  { name: 'Green', value: 'var(--accent)' },
  { name: 'Amber', value: 'var(--goal)' },
  { name: 'Pink', value: 'var(--leisure)' },
  { name: 'Violet', value: 'var(--investment)' },
  { name: 'Orange', value: 'var(--debt)' },
  { name: 'Sand', value: 'var(--dot-cash)' },
  { name: 'Slate', value: '#94A3B8' }
]

/** The one word under a balance that says what the number is. */
function balanceLabel(account: AccountWithBalance): string {
  if (account.kind === 'credit') return 'owed'
  if (account.kind === 'investment') return 'value'
  if (account.kind === 'cash') return 'cash'
  return 'available'
}

function accountColor(account: AccountWithBalance): string {
  return account.color ?? 'var(--text-muted)'
}

function creditUsedPercent(account: AccountWithBalance): number | null {
  if (account.kind !== 'credit' || account.creditLimitCents === null) return null
  if (account.creditLimitCents <= 0) return null
  return Math.min(
    100,
    Math.round((accountDisplayBalanceCents(account) / account.creditLimitCents) * 100)
  )
}

type SafeToSpendChoice = 'auto' | 'in' | 'out'

function safeToSpendChoice(account: AccountWithBalance | null): SafeToSpendChoice {
  if (!account || account.inSafeToSpend === null) return 'auto'
  return account.inSafeToSpend ? 'in' : 'out'
}

function choiceToFlag(choice: SafeToSpendChoice): boolean | null {
  return choice === 'auto' ? null : choice === 'in'
}

interface AccountForm {
  name: string
  kind: AccountKind
  institution: string
  startingBalance: string
  creditLimit: string
  apr: string
  minimumPayment: string
  lastStatementBalance: string
  statementDay: string
  paymentDueDay: string
  dedicatedGoalId: string
  safeToSpend: SafeToSpendChoice
  color: string
}

function formFor(account: AccountWithBalance | null): AccountForm {
  return {
    name: account?.name ?? '',
    kind: account?.kind ?? 'checking',
    institution: account?.institution ?? '',
    // The opening balance is what the account held before any entry here, so an
    // existing account shows it as the app stored it, never as today's balance.
    startingBalance: account ? centsToEditable(Math.abs(account.startingBalanceCents)) : '',
    creditLimit:
      account && account.creditLimitCents !== null ? centsToEditable(account.creditLimitCents) : '',
    apr: account && account.aprBps !== null ? String(Number((account.aprBps / 100).toFixed(2))) : '',
    minimumPayment:
      account && account.minimumPaymentCents !== null
        ? centsToEditable(account.minimumPaymentCents)
        : '',
    statementDay:
      account?.statementDay !== null && account?.statementDay !== undefined
        ? String(account.statementDay)
        : '',
    paymentDueDay:
      account?.paymentDueDay !== null && account?.paymentDueDay !== undefined
        ? String(account.paymentDueDay)
        : '',
    lastStatementBalance:
      account && account.lastStatementBalanceCents !== null
        ? centsToEditable(account.lastStatementBalanceCents)
        : '',
    dedicatedGoalId: account?.dedicatedGoalId ?? '',
    safeToSpend: safeToSpendChoice(account),
    color: account?.color ?? ''
  }
}

function AccountFormSheet({
  account,
  onClose
}: {
  account: AccountWithBalance | null
  onClose: () => void
}) {
  const snapshot = useSnapshot()
  const add = usePocket((state) => state.add)
  const edit = usePocket((state) => state.edit)
  const institutions = useMemo(
    () =>
      [
        ...new Set(
          (snapshot?.accounts ?? [])
            .filter((item) => !item.isArchived)
            .map((item) => item.institution)
            .filter((name): name is string => !!name)
        )
      ].sort(),
    [snapshot]
  )
  const goals = useMemo(
    () => (snapshot?.goals ?? []).filter((goal) => !goal.isArchived),
    [snapshot]
  )
  const [form, setForm] = useState<AccountForm>(() => formFor(account))
  const [fieldErrors, setFieldErrors] = useState<AccountFormProblems>({})
  const { saving, error, run } = useSheetSave(onClose)

  const isCredit = form.kind === 'credit'
  const clearField = (field: keyof AccountFormProblems) =>
    setFieldErrors((current) => ({ ...current, [field]: undefined }))

  const submit = async () => {
    const { problems, parsed } = validateAccountForm(form)
    setFieldErrors(problems)
    if (!parsed) return

    const purposeFields = {
      dedicatedGoalId: form.dedicatedGoalId || null,
      inSafeToSpend: choiceToFlag(form.safeToSpend),
      color: form.color || null
    }
    // Terms only mean something on a card; switching a draft away from credit
    // must not leave the old numbers behind.
    const terms = isCredit
      ? {
          aprBps: parsed.aprBps,
          minimumPaymentCents: parsed.minimumPaymentCents,
          statementDay: parsed.statementDay,
          paymentDueDay: parsed.paymentDueDay,
          lastStatementBalanceCents: parsed.lastStatementBalanceCents
        }
      : {
          aprBps: null,
          minimumPaymentCents: null,
          statementDay: null,
          paymentDueDay: null,
          lastStatementBalanceCents: null
        }

    // A credit card's opening balance is money owed, stored as a negative balance.
    const startingBalanceCents = isCredit
      ? -Math.abs(parsed.startingBalanceCents)
      : parsed.startingBalanceCents

    await run(() =>
      account
        ? edit(
            (current) =>
              patchAccount(current, account.id, {
                name: parsed.name,
                kind: form.kind,
                institution: form.institution.trim(),
                creditLimitCents: isCredit ? parsed.creditLimitCents : null,
                ...terms,
                ...purposeFields
              }),
            'Account saved on this phone.'
          )
        : add(
            (current) =>
              createAccount(current, {
                name: parsed.name,
                kind: form.kind,
                institution: form.institution.trim(),
                startingBalanceCents,
                creditLimitCents: isCredit ? parsed.creditLimitCents : null,
                ...terms,
                ...purposeFields
              }),
            'Account saved on this phone.'
          )
    )
  }

  return (
    <Sheet
      title={account ? 'Edit account' : 'Add an account'}
      hint={
        account
          ? 'Current balances are corrected with an adjustment entry, so the opening balance stays put.'
          : 'Use the name on your statement, then tag the bank it belongs to.'
      }
      onClose={onClose}
    >
      <Field label="Account name" error={fieldErrors.name}>
        <input
          className="input"
          autoFocus
          maxLength={60}
          value={form.name}
          placeholder="Tangerine Chequing"
          onChange={(event) => {
            clearField('name')
            setForm({ ...form, name: event.target.value })
          }}
        />
      </Field>

      <Field label="Bank or institution" hint="Group accounts by where they live">
        <input
          className="input"
          list="pocket-institution-options"
          value={form.institution}
          placeholder="Tangerine"
          onChange={(event) => setForm({ ...form, institution: event.target.value })}
        />
        <datalist id="pocket-institution-options">
          {institutions.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
      </Field>

      <Field
        label="Type"
        hint={
          account
            ? 'Fixed once an account exists — its history was recorded in this type'
            : undefined
        }
      >
        <select
          className="input"
          value={form.kind}
          disabled={Boolean(account)}
          onChange={(event) => setForm({ ...form, kind: event.target.value as AccountKind })}
        >
          {KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {ACCOUNT_KIND_LABEL[kind]}
            </option>
          ))}
        </select>
      </Field>

      {!account && (
        <Field
          label={isCredit ? 'Balance owed today' : 'Starting balance'}
          hint={
            isCredit
              ? 'Enter the amount you owe, not a negative number'
              : 'The balance before any entries in this app'
          }
          error={fieldErrors.startingBalance}
        >
          <MoneyInput
            value={form.startingBalance}
            placeholder={isCredit ? '420.00' : '2,450.00'}
            onValueChange={(startingBalance) => {
              clearField('startingBalance')
              setForm({ ...form, startingBalance })
            }}
          />
        </Field>
      )}

      {isCredit && (
        <>
          <div className="field-grid">
            <Field label="Credit limit" hint="Total credit the bank gives you" error={fieldErrors.creditLimit}>
              <MoneyInput
                value={form.creditLimit}
                placeholder="5,000.00"
                onValueChange={(creditLimit) => {
                  clearField('creditLimit')
                  setForm({ ...form, creditLimit })
                }}
              />
            </Field>
            <Field label="APR" hint="Annual rate, as printed" error={fieldErrors.apr}>
              <PercentInput
                value={form.apr}
                placeholder="20.99"
                onValueChange={(apr) => {
                  clearField('apr')
                  setForm({ ...form, apr })
                }}
              />
            </Field>
            <Field label="Minimum payment" hint="What the bank asks for" error={fieldErrors.minimumPayment}>
              <MoneyInput
                value={form.minimumPayment}
                placeholder="25.00"
                onValueChange={(minimumPayment) => {
                  clearField('minimumPayment')
                  setForm({ ...form, minimumPayment })
                }}
              />
            </Field>
            <Field
              label="Last statement balance"
              hint="What the statement says you owe"
              error={fieldErrors.lastStatementBalance}
            >
              <MoneyInput
                value={form.lastStatementBalance}
                placeholder="420.00"
                onValueChange={(lastStatementBalance) => {
                  clearField('lastStatementBalance')
                  setForm({ ...form, lastStatementBalance })
                }}
              />
            </Field>
            <Field label="Statement closes on" hint="Day of the month" error={fieldErrors.statementDay}>
              <input
                className="input"
                inputMode="numeric"
                value={form.statementDay}
                placeholder="18"
                onChange={(event) => {
                  clearField('statementDay')
                  setForm({ ...form, statementDay: event.target.value })
                }}
              />
            </Field>
            <Field label="Payment due on" hint="Day of the month" error={fieldErrors.paymentDueDay}>
              <input
                className="input"
                inputMode="numeric"
                value={form.paymentDueDay}
                placeholder="8"
                onChange={(event) => {
                  clearField('paymentDueDay')
                  setForm({ ...form, paymentDueDay: event.target.value })
                }}
              />
            </Field>
          </div>
          <p className="fine">
            The cycle and APR drive the card's due date and the payoff estimate. Days near the end of
            the month clamp to the last day of shorter months. To change what you owe, record an
            adjustment entry instead — the opening balance stays put.
          </p>
        </>
      )}

      <Field
        label="Mine only for"
        hint="Leave as Nothing in particular to keep it a general account"
      >
        <select
          className="input"
          value={form.dedicatedGoalId}
          onChange={(event) => setForm({ ...form, dedicatedGoalId: event.target.value })}
        >
          <option value="">Nothing in particular</option>
          {goals.map((goal) => (
            <option key={goal.id} value={goal.id}>
              {goal.name}
            </option>
          ))}
        </select>
      </Field>
      {form.dedicatedGoalId !== '' ? (
        <p className="fine">
          This account's balance <em>is</em> the goal's progress — money parked here is spent when
          the goal is funded, so it no longer counts as savings.
        </p>
      ) : null}

      <Field
        label="Count as spending money"
        hint={
          form.dedicatedGoalId !== ''
            ? 'Accounts tied to a goal are left out by default'
            : 'Default follows the account type; investments are never included by default'
        }
      >
        <select
          className="input"
          value={form.safeToSpend}
          onChange={(event) =>
            setForm({ ...form, safeToSpend: event.target.value as SafeToSpendChoice })
          }
        >
          <option value="auto">Automatic</option>
          <option value="in">Always count it</option>
          <option value="out">Never count it</option>
        </select>
      </Field>

      <div className="field">
        <span>Colour</span>
        <div className="swatches">
          <button
            type="button"
            aria-label="Automatic colour"
            aria-pressed={form.color === ''}
            className={form.color === '' ? 'swatch swatch-auto active' : 'swatch swatch-auto'}
            onClick={() => setForm({ ...form, color: '' })}
          />
          {ACCOUNT_COLORS.map((colour) => (
            <button
              key={colour.name}
              type="button"
              aria-label={`Use the ${colour.name} colour`}
              aria-pressed={form.color === colour.value}
              className={form.color === colour.value ? 'swatch active' : 'swatch'}
              style={{ background: colour.value }}
              onClick={() => setForm({ ...form, color: colour.value })}
            />
          ))}
        </div>
      </div>

      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="sheet-actions">
        <button type="button" className="button" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="button primary" disabled={saving} onClick={submit}>
          {saving ? 'Saving…' : account ? 'Save account' : 'Add account'}
        </button>
      </div>
    </Sheet>
  )
}

/**
 * What a card balance should read, entered the way the bank states it. The three
 * answers — amount owed, room left, share of the limit in use — are resolved by
 * the same shared function the desktop dialog uses, so both devices post the
 * one adjustment entry that reaches the same target.
 */
function AdjustBalanceSheet({
  account,
  currency,
  onClose
}: {
  account: AccountWithBalance
  currency: string
  onClose: () => void
}) {
  const add = usePocket((state) => state.add)
  const edit = usePocket((state) => state.edit)
  const { saving, error, setError, run } = useSheetSave(onClose)
  const isCredit = account.kind === 'credit'
  const owedCents = cardOwedCents(account)
  const limitCents = account.creditLimitCents
  const availableCents = limitCents === null ? null : limitCents - owedCents
  const usedPercent =
    limitCents !== null && limitCents > 0
      ? Math.round((owedCents / limitCents) * 1000) / 10
      : null
  const canUseCreditModes = isCredit && limitCents !== null && limitCents > 0
  const presets = adjustmentPresetsFor(account.kind)
  const [mode, setMode] = useState<AdjustMode>('owed')
  const [reason, setReason] = useState<AdjustmentReason>('correction')
  const [value, setValue] = useState(centsToEditable(owedCents))
  const [occurredOn, setOccurredOn] = useState(todayISO())

  const resolved = resolveAdjustBalance(
    { kind: account.kind, balanceCents: account.balanceCents, creditLimitCents: limitCents },
    { mode, value, reason }
  )
  const preset = resolved.preset

  const seedFor = (next: AdjustMode): string => {
    if (next === 'available') return centsToEditable(availableCents ?? 0)
    if (next === 'percent') return usedPercent === null ? '' : String(usedPercent)
    return centsToEditable(owedCents)
  }

  const submit = () => {
    const { problem, targetBalanceCents, deltaCents } = resolved
    if (problem !== null || targetBalanceCents === null || deltaCents === null) {
      setError(problem ?? 'Enter a balance')
      return
    }
    if (deltaCents === 0) {
      void run(() => edit((current) => current, 'That balance is already correct.'))
      return
    }
    void run(() =>
      add(
        (current) =>
          createEntry(current, {
            accountId: account.id,
            kind: 'adjustment',
            amountCents: deltaCents,
            occurredOn,
            memo: preset.memo,
            category: preset.category
          }),
        reason === 'correction' ? 'Balance adjusted.' : `${preset.memo} recorded.`
      )
    )
  }

  return (
    <Sheet
      title={`Adjust ${account.name}`}
      hint="Posts one adjustment entry, so the change stays visible in the ledger."
      onClose={onClose}
    >
      {canUseCreditModes ? (
        <Field label="Adjust by" hint="Three ways to say the same thing about a card">
          <select
            className="input"
            value={mode}
            onChange={(event) => {
              const next = event.target.value as AdjustMode
              setMode(next)
              setValue(seedFor(next))
              setError(null)
            }}
          >
            {ADJUST_MODES.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </Field>
      ) : null}

      <Field label="What changed?" hint={preset.hint}>
        <select
          className="input"
          value={reason}
          onChange={(event) => {
            setReason(event.target.value as AdjustmentReason)
            setError(null)
          }}
        >
          {presets.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </Field>

      <Field
        label={
          mode === 'available'
            ? 'Available credit now'
            : mode === 'percent'
              ? 'Utilization now'
              : isCredit
                ? 'Amount owed now'
                : 'Balance now'
        }
        hint={
          mode === 'percent'
            ? 'Share of the limit in use, for example 42.5'
            : isCredit && mode === 'owed'
              ? 'Enter a negative amount if the card is overpaid'
              : undefined
        }
      >
        {mode === 'percent' ? (
          <PercentInput value={value} onValueChange={setValue} />
        ) : (
          <MoneyInput allowNegative={mode === 'owed'} value={value} onValueChange={setValue} />
        )}
      </Field>

      <Field label="Date">
        <input
          className="input"
          type="date"
          value={occurredOn}
          onChange={(event) => setOccurredOn(event.target.value)}
        />
      </Field>

      {resolved.owedAfterCents !== null &&
      resolved.availableAfterCents !== null &&
      resolved.usedPercentAfter !== null ? (
        <p className="fine">
          After saving: {formatMoney(resolved.owedAfterCents, currency)} owed ·{' '}
          {formatMoney(resolved.availableAfterCents, currency)} available ·{' '}
          {resolved.usedPercentAfter}% used
        </p>
      ) : null}
      <p className="fine">
        Recorded as “{preset.memo}” · {preset.category}
      </p>
      <p className="fine">
        {isCredit
          ? owedCents < 0
            ? `Credit on the card: ${formatMoney(-owedCents, currency)}`
            : `Current owed: ${formatMoney(owedCents, currency)}${
                limitCents !== null ? ` · limit ${formatMoney(limitCents, currency)}` : ''
              }`
          : `Current balance: ${formatMoney(owedCents, currency)}`}
        {isCredit && limitCents === null
          ? ' · add a credit limit to adjust by available credit or utilization'
          : ''}
      </p>

      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="sheet-actions">
        <button type="button" className="button" disabled={saving} onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="button primary" disabled={saving} onClick={submit}>
          {saving ? 'Posting…' : 'Post adjustment'}
        </button>
      </div>
    </Sheet>
  )
}

/**
 * Paying a card is a transfer, not an expense: cash leaves one account and the
 * debt drops in the other, so neither device double-counts the payment.
 */
function PayCardSheet({
  card,
  currency,
  onClose
}: {
  card: AccountWithBalance
  currency: string
  onClose: () => void
}) {
  const snapshot = useSnapshot()
  const add = usePocket((state) => state.add)
  const { saving, error, setError, run } = useSheetSave(onClose)
  const sources = cardPaymentSources(snapshot?.accounts ?? [])
  const owed = accountDisplayBalanceCents(card)
  const creditCents = Math.max(0, -cardOwedCents(card))
  const [fromId, setFromId] = useState(sources[0]?.id ?? '')
  const [amount, setAmount] = useState(centsToEditable(owed))
  const [occurredOn, setOccurredOn] = useState(todayISO())

  const submit = () => {
    if (!fromId) {
      setError('Choose the account the money leaves from')
      return
    }
    const typed = parseMoneyToCents(amount)
    if (typed === null || typed <= 0) {
      setError('Enter a payment amount')
      return
    }
    void run(() =>
      add(
        (current) =>
          createEntry(current, {
            accountId: fromId,
            counterAccountId: card.id,
            kind: 'transfer',
            amountCents: typed,
            occurredOn,
            memo: `Payment · ${card.name}`,
            category: 'Debt'
          }),
        'Card payment recorded.'
      )
    )
  }

  return (
    <Sheet
      title={`Pay ${card.name}`}
      hint="Recorded as a transfer: cash leaves one account and the card balance falls."
      onClose={onClose}
    >
      {sources.length > 0 ? (
        <Field label="Pay from">
          <select
            className="input"
            value={fromId}
            onChange={(event) => {
              setFromId(event.target.value)
              setError(null)
            }}
          >
            {sources.map((account) => (
              <option key={account.id} value={account.id}>
                {account.name}
              </option>
            ))}
          </select>
        </Field>
      ) : null}
      <Field label="Amount">
        <MoneyInput value={amount} onValueChange={setAmount} />
      </Field>
      <Field label="Date">
        <input
          className="input"
          type="date"
          value={occurredOn}
          onChange={(event) => setOccurredOn(event.target.value)}
        />
      </Field>

      <p className="fine">
        {creditCents > 0
          ? `The card is overpaid by ${formatMoney(creditCents, currency)}.`
          : `Owed today: ${formatMoney(owed, currency)}`}
      </p>
      {sources.length === 0 ? (
        <p className="form-error" role="alert">
          No spendable account is available. Add or restore a checking, savings or cash account
          before paying this card.
        </p>
      ) : null}
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="sheet-actions">
        <button type="button" className="button" disabled={saving} onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="button primary"
          disabled={saving || sources.length === 0}
          onClick={submit}
        >
          {saving ? 'Recording…' : 'Record payment'}
        </button>
      </div>
    </Sheet>
  )
}

function AccountSheet({
  account,
  currency,
  onEdit,
  onAdjust,
  onPayCard,
  onRequestDelete,
  onClose
}: {
  account: AccountWithBalance
  currency: string
  onEdit: () => void
  onAdjust: () => void
  onPayCard: () => void
  onRequestDelete: () => void
  onClose: () => void
}) {
  const snapshot = useSnapshot()
  const edit = usePocket((state) => state.edit)
  const { saving, error, run } = useSheetSave(onClose)
  const displayCents = accountDisplayBalanceCents(account)
  const goalName = snapshot?.goals.find((goal) => goal.id === account.dedicatedGoalId)?.name
  const used = creditUsedPercent(account)
  const available =
    account.creditLimitCents === null
      ? null
      : Math.max(0, account.creditLimitCents - displayCents)
  const card = snapshot
    ? cardStatus({ account, transactions: snapshot.transactions, todayISO: todayISO() })
    : null

  return (
    <Sheet
      title={account.name}
      hint={`${ACCOUNT_KIND_LABEL[account.kind]}${account.institution ? ` · ${account.institution}` : ''}`}
      onClose={onClose}
    >
      <dl className="facts">
        <div>
          <dt>{balanceLabel(account)}</dt>
          <dd>{formatMoney(displayCents, currency)}</dd>
        </div>
        <div>
          <dt>Opening balance</dt>
          <dd>{formatMoney(Math.abs(account.startingBalanceCents), currency)}</dd>
        </div>
        {account.kind === 'credit' && account.creditLimitCents !== null ? (
          <>
            <div>
              <dt>Credit limit</dt>
              <dd>{formatMoney(account.creditLimitCents, currency)}</dd>
            </div>
            <div>
              <dt>Available</dt>
              <dd>{available === null ? '—' : formatMoney(available, currency)}</dd>
            </div>
            <div>
              <dt>Used</dt>
              <dd>{used === null ? '—' : `${used}%`}</dd>
            </div>
          </>
        ) : null}
        {account.aprBps !== null ? (
          <div>
            <dt>APR</dt>
            <dd>{(account.aprBps / 100).toFixed(2).replace(/\.?0+$/, '')}%</dd>
          </div>
        ) : null}
        {account.minimumPaymentCents !== null ? (
          <div>
            <dt>Minimum payment</dt>
            <dd>{formatMoney(account.minimumPaymentCents, currency)}</dd>
          </div>
        ) : null}
        {card ? (
          <>
            <div>
              <dt>Statement closes</dt>
              <dd>{formatDateLabel(card.closesOn)}</dd>
            </div>
            <div>
              <dt>Payment due</dt>
              <dd>{formatDateLabel(card.dueOn)}</dd>
            </div>
            {card.amountDueCents !== null ? (
              <div>
                <dt>{card.amountDueCents > 0 ? 'Due now' : 'Statement'}</dt>
                <dd>{card.amountDueCents > 0 ? formatMoney(card.amountDueCents, currency) : 'paid'}</dd>
              </div>
            ) : null}
            {card.payoffMonths !== null ? (
              <div>
                <dt>At the minimum</dt>
                <dd>
                  {card.payoffMonths} mo · {formatMoney(card.payoffInterestCents, currency)} interest
                </dd>
              </div>
            ) : account.minimumPaymentCents !== null && displayCents > 0 ? (
              <div>
                <dt>At the minimum</dt>
                <dd>Never clears it</dd>
              </div>
            ) : null}
          </>
        ) : null}
        {goalName ? (
          <div>
            <dt>Mine only for</dt>
            <dd>{goalName}</dd>
          </div>
        ) : null}
        <div>
          <dt>Spending money</dt>
          <dd>
            {account.inSafeToSpend === null
              ? countsInSafeToSpend(account)
                ? 'Counted automatically'
                : 'Left out automatically'
              : account.inSafeToSpend
                ? 'Always counted'
                : 'Never counted'}
          </dd>
        </div>
        <div>
          <dt>State</dt>
          <dd>{account.isArchived ? 'Archived' : 'Active'}</dd>
        </div>
      </dl>

      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="card-actions">
        {!account.isArchived ? (
          <>
            <button type="button" className="button compact" disabled={saving} onClick={onAdjust}>
              Adjust balance
            </button>
            {account.kind === 'credit' ? (
              <button type="button" className="button compact" disabled={saving} onClick={onPayCard}>
                Pay this card
              </button>
            ) : null}
          </>
        ) : null}
        <button type="button" className="button compact" disabled={saving} onClick={onEdit}>
          <Pencil size={15} aria-hidden="true" /> Edit
        </button>
        <button
          type="button"
          className="button compact"
          disabled={saving}
          onClick={() =>
            void run(() =>
              edit(
                (current) => setAccountArchived(current, account.id, !account.isArchived),
                account.isArchived ? 'Account restored.' : 'Account archived.'
              )
            )
          }
        >
          {account.isArchived ? 'Bring back' : 'Archive'}
        </button>
        <button
          type="button"
          className="button danger compact"
          disabled={saving}
          onClick={onRequestDelete}
        >
          Remove
        </button>
      </div>
      <p className="fine">
        Archiving stops the account counting toward balances and Safe to Spend, but every entry stays
        in the ledger and the account can be brought back.
      </p>
    </Sheet>
  )
}

export function Accounts() {
  const snapshot = useSnapshot()
  const tables = usePocket((state) => state.tables)
  const edit = usePocket((state) => state.edit)
  const [opened, setOpened] = useState<AccountWithBalance | null>(null)
  const [form, setForm] = useState<AccountWithBalance | 'new' | null>(null)
  const [adjusting, setAdjusting] = useState<AccountWithBalance | null>(null)
  const [paying, setPaying] = useState<AccountWithBalance | null>(null)
  const [pendingDelete, setPendingDelete] = useState<AccountWithBalance | null>(null)
  if (!snapshot) return null

  const view = pocketView(snapshot)
  const currency = view.settings.currency
  const active = snapshot.accounts.filter((account) => !account.isArchived)
  const archived = snapshot.accounts.filter((account) => account.isArchived)
  const owed = creditOwedCents(active)
  const available = creditAvailableCents(active)
  const cards = active.filter((account) => account.kind === 'credit').length
  // Re-read the account after every commit, so the sheet shows the money the
  // change moved rather than the figures it was opened with.
  const openedAccount = opened
    ? snapshot.accounts.find((account) => account.id === opened.id) ?? opened
    : null
  const deleteDoomed = pendingDelete ? (tables ? doomedAccountEntryIds(tables, pendingDelete.id).size : null) : null
  const deleteWords = pendingDelete
    ? accountDeletionWords(pendingDelete.name, deleteDoomed)
    : null

  return (
    <div className="screen">
      <header className="screen-head">
        <div>
          <span className="eyebrow">Total wealth</span>
          <p className="hero-number">{formatMoney(view.wealthCents, currency)}</p>
        </div>
        <button type="button" className="button primary compact" onClick={() => setForm('new')}>
          <Plus size={17} aria-hidden="true" /> Add
        </button>
      </header>
      <p className="muted small">
        {formatMoney(cashOnHand(active), currency)} you have
        {cards > 0
          ? ` · ${formatMoney(owed, currency)} owed on ${
              cards === 1 ? '1 card' : `${cards} cards`
            } · ${formatMoney(available, currency)} room left.`
          : '.'}
      </p>

      {active.length === 0 ? (
        <p className="empty-line">
          Add the accounts you actually move money through. You can rename them or fix a balance
          later.
        </p>
      ) : (
        <ul className="list">
          {active.map((account) => {
            const displayCents = accountDisplayBalanceCents(account)
            const used = creditUsedPercent(account)
            const dedicated = account.dedicatedGoalId
              ? (snapshot.goals.find((goal) => goal.id === account.dedicatedGoalId)?.name ??
                'a removed goal')
              : null
            return (
              <li key={account.id} className="goal-card">
                <button
                  type="button"
                  className="goal-head tap"
                  onClick={() => setOpened(account)}
                  aria-label={`${account.name}, ${ACCOUNT_KIND_LABEL[account.kind]}, ${formatMoney(displayCents, currency)} ${balanceLabel(account)}`}
                >
                  <span className="goal-dot" style={{ background: accountColor(account) }} aria-hidden="true" />
                  <div className="row-main">
                    <span className="row-title">{account.name}</span>
                    <span className="muted small">
                      {ACCOUNT_KIND_LABEL[account.kind]}
                      {account.institution ? ` · ${account.institution}` : ''}
                      {dedicated ? ` · only for ${dedicated}` : ''}
                    </span>
                  </div>
                  <div className="row-end">
                    <span className={account.kind === 'credit' ? 'amount owed' : 'amount'}>
                      {formatMoney(displayCents, currency)}
                    </span>
                    <span className="muted small">
                      {account.kind === 'credit' || account.balanceCents >= 0
                        ? balanceLabel(account)
                        : 'negative balance'}
                    </span>
                  </div>
                </button>
                {used !== null ? (
                  <>
                    <div className="bar" aria-hidden="true">
                      <span
                        style={{
                          width: `${used}%`,
                          background: account.color ?? 'var(--debt)'
                        }}
                      />
                    </div>
                    <div className="goal-foot">
                      <span className="muted small">{used}% used</span>
                      <span className="muted small">
                        {account.creditLimitCents !== null
                          ? `limit ${formatMoney(account.creditLimitCents, currency)}`
                          : ''}
                      </span>
                    </div>
                  </>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}

      {archived.length > 0 ? (
        <section className="section">
          <header className="section-head">
            <h2>Archived</h2>
            <span className="muted small">{archived.length}</span>
          </header>
          <ul className="list">
            {archived.map((account) => (
              <li key={account.id} className="row-card settled">
                <button
                  type="button"
                  className="row-main tap"
                  onClick={() => setOpened(account)}
                  aria-label={`${account.name}, ${ACCOUNT_KIND_LABEL[account.kind]}, archived, ${formatMoney(accountDisplayBalanceCents(account), currency)} ${balanceLabel(account)}`}
                >
                  <span className="row-title">{account.name}</span>
                  <span className="muted small">{ACCOUNT_KIND_LABEL[account.kind]} · archived</span>
                </button>
                <div className="row-end">
                  <span className={account.kind === 'credit' ? 'amount owed' : 'amount'}>
                    {formatMoney(accountDisplayBalanceCents(account), currency)}
                  </span>
                  <span className="muted small">{balanceLabel(account)}</span>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <p className="fine">
        Balances come from your entries, so fixing one records a change instead of quietly
        overwriting it. Card balances count as money owed, never as cash.
      </p>

      {openedAccount ? (
        <AccountSheet
          account={openedAccount}
          currency={currency}
          onEdit={() => {
            setForm(openedAccount)
            setOpened(null)
          }}
          onAdjust={() => {
            setAdjusting(openedAccount)
            setOpened(null)
          }}
          onPayCard={() => {
            setPaying(openedAccount)
            setOpened(null)
          }}
          onRequestDelete={() => setPendingDelete(openedAccount)}
          onClose={() => setOpened(null)}
        />
      ) : null}

      {adjusting ? (
        <AdjustBalanceSheet
          account={
            snapshot.accounts.find((account) => account.id === adjusting.id) ?? adjusting
          }
          currency={currency}
          onClose={() => setAdjusting(null)}
        />
      ) : null}

      {paying ? (
        <PayCardSheet
          card={snapshot.accounts.find((account) => account.id === paying.id) ?? paying}
          currency={currency}
          onClose={() => setPaying(null)}
        />
      ) : null}

      {pendingDelete && deleteWords ? (
        <DeleteConfirm
          title={deleteWords.title}
          hint={archiveVsDeleteHint}
          detail={deleteWords.body}
          confirmLabel={deleteWords.confirmLabel}
          onCancel={() => setPendingDelete(null)}
          onDone={() => {
            setPendingDelete(null)
            setOpened(null)
          }}
          altAction={{
            label: 'Archive instead',
            run: () =>
              edit(
                (current) => setAccountArchived(current, pendingDelete.id, true),
                'Account archived.'
              )
          }}
          remove={() =>
            edit(
              (current) => deleteAccount(current, pendingDelete.id, { withEntries: true }),
              // The same sentence the computer's toast uses. The number belonged
              // in the question, which named it before this ran; repeating a
              // count here would be the one place the two devices disagree.
              'Account and its entries removed.'
            )
          }
        />
      ) : null}

      {form ? (
        <AccountFormSheet account={form === 'new' ? null : form} onClose={() => setForm(null)} />
      ) : null}
    </div>
  )
}

import { useMemo, useState } from 'react'
import {
  ArrowRightLeft,
  CreditCard,
  Landmark,
  Pencil,
  Plus,
  SlidersHorizontal,
  Trash2
} from 'lucide-react'
import { todayISO } from '@shared/dates'
import { centsToEditable, formatMoney, parseMoneyToCents } from '@shared/money'
import type { AccountInput, AccountKind, AccountWithBalance } from '@shared/types'
import {
  Button,
  Card,
  EmptyState,
  Field,
  IconButton,
  Modal,
  Money,
  Progress
} from '../components/ui'
import {
  ACCOUNT_KIND_LABEL,
  accountDisplayBalanceCents,
  cashOnHand,
  creditAvailableCents,
  creditOwedCents
} from '../lib/finance'
import { useFinanceStore } from '../store/useFinanceStore'

const KINDS: AccountKind[] = ['checking', 'savings', 'cash', 'credit', 'investment']

export function Accounts() {
  const snapshot = useFinanceStore((state) => state.snapshot)
  const settings = useFinanceStore((state) => state.settings)
  const deleteAccount = useFinanceStore((state) => state.deleteAccount)
  const [editing, setEditing] = useState<AccountWithBalance | 'new' | null>(null)
  const [adjusting, setAdjusting] = useState<AccountWithBalance | null>(null)
  const [paying, setPaying] = useState<AccountWithBalance | null>(null)

  const active = useMemo(
    () => (snapshot?.accounts ?? []).filter((account) => !account.isArchived),
    [snapshot]
  )

  const groups = useMemo(() => {
    const byInstitution = new Map<string, AccountWithBalance[]>()
    for (const account of active) {
      const key = account.institution || 'No bank assigned'
      const list = byInstitution.get(key) ?? []
      list.push(account)
      byInstitution.set(key, list)
    }
    return [...byInstitution.entries()].sort(([a], [b]) => a.localeCompare(b))
  }, [active])

  if (!snapshot) return null

  const currency = settings.currency
  const cash = cashOnHand(active)
  const owed = creditOwedCents(active)
  const available = creditAvailableCents(active)
  const creditCards = active.filter((account) => account.kind === 'credit').length

  const remove = (account: AccountWithBalance) => {
    if (
      window.confirm(
        `Remove "${account.name}"? Its entries stay in the ledger, and the account stops counting toward your balances.`
      )
    ) {
      void deleteAccount(account.id)
    }
  }

  return (
    <>
      <header className="page-head">
        <div>
          <p className="eyebrow">Accounts</p>
          <h1 className="page-title">Every bank, one ledger</h1>
          <p className="page-sub">
            Name each account and tag the bank it lives at — Tangerine, Wealthsimple, whoever.
            Balances come from entries, so a correction is always an adjustment, never a quiet
            overwrite.
          </p>
        </div>
        <Button variant="primary" icon={<Plus size={16} />} onClick={() => setEditing('new')}>
          Add account
        </Button>
      </header>

      <div className="account-summary">
        <article className="summary-tile">
          <span className="stat-label">Cash across accounts</span>
          <p className="stat-value">
            <Money cents={cash} currency={currency} compact />
          </p>
          <span className="stat-hint">Checking, savings and cash</span>
        </article>
        <article className="summary-tile">
          <span className="stat-label">Credit owed</span>
          <p className="stat-value">
            <Money cents={owed} currency={currency} compact />
          </p>
          <span className="stat-hint">
            {creditCards === 1 ? '1 card tracked' : `${creditCards} cards tracked`}
          </span>
        </article>
        <article className="summary-tile">
          <span className="stat-label">Available credit</span>
          <p className="stat-value">
            <Money cents={available} currency={currency} compact />
          </p>
          <span className="stat-hint">Sum of remaining limits</span>
        </article>
      </div>

      {groups.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Landmark size={20} />}
            title="No accounts yet"
            body="Add the accounts you actually move money through. You can rename them or change their balance later."
            action={
              <Button variant="primary" onClick={() => setEditing('new')}>
                Add your first account
              </Button>
            }
          />
        </Card>
      ) : (
        <div className="bank-grid">
          {groups.map(([institution, accounts]) => {
            const owedHere = creditOwedCents(accounts)
            const cashHere = cashOnHand(accounts)
            return (
              <section key={institution} className="card bank-card">
                <header className="bank-head">
                  <div className="bank-name">
                    <Landmark size={16} />
                    <h2>{institution}</h2>
                  </div>
                  <span className="bank-total">
                    {owedHere > 0
                      ? `${formatMoney(cashHere, currency)} cash · ${formatMoney(owedHere, currency)} owed`
                      : formatMoney(cashHere, currency)}
                  </span>
                </header>

                <ul className="account-list">
                  {accounts.map((account) => {
                    const isCredit = account.kind === 'credit'
                    const displayCents = accountDisplayBalanceCents(account)
                    const limit = account.creditLimitCents
                    const usedPercent =
                      isCredit && limit && limit > 0
                        ? Math.min(100, Math.round((displayCents / limit) * 100))
                        : 0

                    return (
                      <li key={account.id} className="account-row bank-row">
                        <span className={`account-dot kind-${account.kind}`} />
                        <div className="account-name">
                          <span className="cell-strong">{account.name}</span>
                          <span className="account-meta">
                            {ACCOUNT_KIND_LABEL[account.kind]}
                            {isCredit && limit !== null
                              ? ` · limit ${formatMoney(limit, currency)}`
                              : ''}
                          </span>
                          {isCredit && limit !== null && limit > 0 && (
                            <span className="credit-meter">
                              <Progress value={displayCents} max={limit} />
                              <span>{usedPercent}% used</span>
                            </span>
                          )}
                        </div>
                        <div className="account-figures">
                          <Money
                            cents={displayCents}
                            currency={currency}
                            className={
                              !isCredit && account.balanceCents < 0
                                ? 'account-balance negative'
                                : 'account-balance'
                            }
                          />
                          <span className="account-meta">{isCredit ? 'owed' : 'available'}</span>
                        </div>
                        <div className="account-actions">
                          {isCredit && (
                            <IconButton label="Pay this card" onClick={() => setPaying(account)}>
                              <ArrowRightLeft size={14} />
                            </IconButton>
                          )}
                          <IconButton
                            label="Adjust balance"
                            onClick={() => setAdjusting(account)}
                          >
                            <SlidersHorizontal size={14} />
                          </IconButton>
                          <IconButton label="Edit account" onClick={() => setEditing(account)}>
                            <Pencil size={14} />
                          </IconButton>
                          <IconButton label="Remove account" danger onClick={() => remove(account)}>
                            <Trash2 size={14} />
                          </IconButton>
                        </div>
                      </li>
                    )
                  })}
                </ul>
              </section>
            )
          })}
        </div>
      )}

      <p className="footnote">
        Credit card balances count as money owed, never as cash. Paying a card records a transfer,
        so the cash leaves one account and the debt falls in the other.
      </p>

      {editing !== null && (
        <AccountDialog
          account={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
      {adjusting && (
        <AdjustBalanceDialog account={adjusting} onClose={() => setAdjusting(null)} />
      )}
      {paying && <PayCardDialog card={paying} onClose={() => setPaying(null)} />}
    </>
  )
}

function AccountDialog({
  account,
  onClose
}: {
  account: AccountWithBalance | null
  onClose: () => void
}) {
  const accounts = useFinanceStore((state) => state.snapshot?.accounts ?? [])
  const createAccount = useFinanceStore((state) => state.createAccount)
  const updateAccount = useFinanceStore((state) => state.updateAccount)

  const institutions = useMemo(
    () =>
      [...new Set(accounts.map((item) => item.institution).filter((name): name is string => !!name))].sort(),
    [accounts]
  )

  const [form, setForm] = useState({
    name: account?.name ?? '',
    kind: (account?.kind ?? 'checking') as AccountKind,
    institution: account?.institution ?? '',
    startingBalance: account ? centsToEditable(Math.abs(account.startingBalanceCents)) : '',
    creditLimit:
      account && account.creditLimitCents !== null
        ? centsToEditable(account.creditLimitCents)
        : ''
  })
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const isCredit = form.kind === 'credit'

  const submit = async () => {
    if (!form.name.trim()) {
      setError('Give the account a name')
      return
    }

    const limitTyped = form.creditLimit.trim() ? parseMoneyToCents(form.creditLimit) : null
    if (form.creditLimit.trim() && limitTyped === null) {
      setError('Credit limit must be a number')
      return
    }

    setSaving(true)
    if (account) {
      await updateAccount(account.id, {
        name: form.name.trim(),
        kind: form.kind,
        institution: form.institution.trim(),
        creditLimitCents: isCredit ? limitTyped : null
      })
    } else {
      const startingTyped = form.startingBalance.trim()
        ? parseMoneyToCents(form.startingBalance)
        : 0
      if (startingTyped === null) {
        setSaving(false)
        setError('Starting balance must be a number')
        return
      }
      const input: AccountInput = {
        name: form.name.trim(),
        kind: form.kind,
        institution: form.institution.trim(),
        // A credit card's opening balance is money owed, stored as a negative balance.
        startingBalanceCents: isCredit ? -Math.abs(startingTyped) : startingTyped,
        creditLimitCents: isCredit ? limitTyped : null
      }
      await createAccount(input)
    }
    setSaving(false)
    onClose()
  }

  return (
    <Modal
      title={account ? 'Edit account' : 'Add an account'}
      subtitle={
        account
          ? 'Current balances are corrected with an adjustment entry, so the opening balance stays put.'
          : 'Use the name on your statement, then tag the bank it belongs to.'
      }
      onClose={onClose}
      footer={
        <>
          <Button variant="quiet" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={saving}>
            {account ? 'Save account' : 'Add account'}
          </Button>
        </>
      }
    >
      <div className="form-grid">
        <Field label="Account name" wide>
          <input
            className="input"
            autoFocus
            value={form.name}
            placeholder="Tangerine Chequing"
            onChange={(event) => setForm({ ...form, name: event.target.value })}
          />
        </Field>
        <Field label="Bank or institution" hint="Group accounts by where they live">
          <input
            className="input"
            list="institution-options"
            value={form.institution}
            placeholder="Tangerine"
            onChange={(event) => setForm({ ...form, institution: event.target.value })}
          />
          <datalist id="institution-options">
            {institutions.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
        </Field>
        <Field label="Type">
          <select
            className="select"
            value={form.kind}
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
          >
            <input
              className="input"
              inputMode="decimal"
              value={form.startingBalance}
              placeholder={isCredit ? '420.00' : '2,450.00'}
              onChange={(event) => setForm({ ...form, startingBalance: event.target.value })}
            />
          </Field>
        )}

        {isCredit && (
          <Field label="Credit limit" hint="Used for the utilization meter">
            <input
              className="input"
              inputMode="decimal"
              value={form.creditLimit}
              placeholder="5,000.00"
              onChange={(event) => setForm({ ...form, creditLimit: event.target.value })}
            />
          </Field>
        )}
      </div>

      {error && <p className="form-error">{error}</p>}
    </Modal>
  )
}

function AdjustBalanceDialog({
  account,
  onClose
}: {
  account: AccountWithBalance
  onClose: () => void
}) {
  const settings = useFinanceStore((state) => state.settings)
  const adjustAccountBalance = useFinanceStore((state) => state.adjustAccountBalance)
  const isCredit = account.kind === 'credit'
  const [value, setValue] = useState(
    centsToEditable(accountDisplayBalanceCents(account))
  )
  const [occurredOn, setOccurredOn] = useState(todayISO())
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const submit = async () => {
    const typed = parseMoneyToCents(value)
    if (typed === null) {
      setError('Enter a balance')
      return
    }
    const target = isCredit ? -Math.abs(typed) : typed
    setSaving(true)
    await adjustAccountBalance(account, target, occurredOn)
    setSaving(false)
    onClose()
  }

  return (
    <Modal
      title={`Adjust ${account.name}`}
      subtitle="This posts one adjustment entry, so the change stays visible in the ledger."
      onClose={onClose}
      footer={
        <>
          <Button variant="quiet" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={saving}>
            Post adjustment
          </Button>
        </>
      }
    >
      <div className="form-grid">
        <Field label={isCredit ? 'Amount owed now' : 'Balance now'}>
          <input
            className="input"
            autoFocus
            inputMode="decimal"
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
        </Field>
        <Field label="Date">
          <input
            className="input"
            type="date"
            value={occurredOn}
            onChange={(event) => setOccurredOn(event.target.value)}
          />
        </Field>
      </div>
      <p className="field-hint">
        Current {isCredit ? 'owed' : 'balance'}:{' '}
        {formatMoney(accountDisplayBalanceCents(account), settings.currency)}
      </p>
      {error && <p className="form-error">{error}</p>}
    </Modal>
  )
}

function PayCardDialog({ card, onClose }: { card: AccountWithBalance; onClose: () => void }) {
  const snapshot = useFinanceStore((state) => state.snapshot)
  const settings = useFinanceStore((state) => state.settings)
  const createTransaction = useFinanceStore((state) => state.createTransaction)
  const sources = (snapshot?.accounts ?? []).filter(
    (account) =>
      account.kind !== 'credit' && account.kind !== 'investment' && !account.isArchived
  )
  const owed = accountDisplayBalanceCents(card)

  const [fromId, setFromId] = useState(sources[0]?.id ?? '')
  const [amount, setAmount] = useState(centsToEditable(owed))
  const [occurredOn, setOccurredOn] = useState(todayISO())
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const submit = async () => {
    if (!fromId) {
      setError('Choose the account the money leaves from')
      return
    }
    const typed = parseMoneyToCents(amount)
    if (typed === null || typed <= 0) {
      setError('Enter a payment amount')
      return
    }
    setSaving(true)
    await createTransaction({
      accountId: fromId,
      counterAccountId: card.id,
      kind: 'transfer',
      amountCents: typed,
      occurredOn,
      memo: `Payment · ${card.name}`,
      category: 'Credit payment'
    })
    setSaving(false)
    onClose()
  }

  return (
    <Modal
      title={`Pay ${card.name}`}
      subtitle="Recorded as a transfer: cash leaves one account and the card balance falls."
      onClose={onClose}
      footer={
        <>
          <Button variant="quiet" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={saving}>
            Record payment
          </Button>
        </>
      }
    >
      <div className="form-grid">
        <Field label="Pay from">
          <select
            className="select"
            value={fromId}
            onChange={(event) => setFromId(event.target.value)}
          >
            {sources.map((account) => (
              <option key={account.id} value={account.id}>
                {account.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Amount">
          <input
            className="input"
            autoFocus
            inputMode="decimal"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
          />
        </Field>
        <Field label="Date">
          <input
            className="input"
            type="date"
            value={occurredOn}
            onChange={(event) => setOccurredOn(event.target.value)}
          />
        </Field>
      </div>
      <p className="field-hint">
        <CreditCard size={13} /> Owed today: {formatMoney(owed, settings.currency)}
      </p>
      {error && <p className="form-error">{error}</p>}
    </Modal>
  )
}

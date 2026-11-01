import { useMemo, useState } from 'react'
import {
  Archive,
  ArrowRightLeft,
  Landmark,
  Pencil,
  Plus,
  RotateCcw,
  SlidersHorizontal,
  Trash2
} from 'lucide-react'
import { countsInSafeToSpend, totalWealthCents } from '@shared/accounts'
import { formatMoney } from '@shared/money'
import type { AccountWithBalance } from '@shared/types'
import { Button, Card, EmptyState, IconButton, Money, Progress } from '../components/ui'
import { AccountDialog } from '../components/dialogs/AccountDialog'
import { RemoveAccountDialog } from '../components/dialogs/RemoveAccountDialog'
import { AdjustBalanceDialog } from '../components/dialogs/AdjustBalanceDialog'
import { PayCardDialog } from '../components/dialogs/PayCardDialog'
import {
  ACCOUNT_KIND_LABEL,
  accountDisplayBalanceCents,
  cashOnHand,
  creditAvailableCents,
  creditOwedCents
} from '../lib/finance'
import { useFinanceStore } from '../store/useFinanceStore'

export function Accounts() {
  const snapshot = useFinanceStore((state) => state.snapshot)
  const settings = useFinanceStore((state) => state.settings)
  const archiveAccount = useFinanceStore((state) => state.archiveAccount)
  const [editing, setEditing] = useState<AccountWithBalance | 'new' | null>(null)
  const [adjusting, setAdjusting] = useState<AccountWithBalance | null>(null)
  const [paying, setPaying] = useState<AccountWithBalance | null>(null)
  const [removing, setRemoving] = useState<AccountWithBalance | null>(null)

  const active = useMemo(
    () => (snapshot?.accounts ?? []).filter((account) => !account.isArchived),
    [snapshot]
  )
  const archived = useMemo(
    () => (snapshot?.accounts ?? []).filter((account) => account.isArchived),
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

  const goalNames = useMemo(
    () => new Map((snapshot?.goals ?? []).map((goal) => [goal.id, goal.name])),
    [snapshot]
  )

  if (!snapshot) return null

  const currency = settings.currency
  const cash = cashOnHand(active)
  const owed = creditOwedCents(active)
  const available = creditAvailableCents(active)
  const creditCards = active.filter((account) => account.kind === 'credit').length
  const wealth = totalWealthCents(snapshot.accounts)

  const remove = (account: AccountWithBalance) => setRemoving(account)

  return (
    <>
      <header className="page-head">
        <div>
          <p className="eyebrow">Accounts</p>
          <h1 className="page-title" tabIndex={-1}>Every bank, one ledger</h1>
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
          <span className="stat-label">Total wealth</span>
          <p className="stat-value">
            <Money cents={wealth} currency={currency} compact />
          </p>
          <span className="stat-hint">Everything you own, debts taken off</span>
        </article>
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
                      ? cashHere > 0
                        ? `${formatMoney(cashHere, currency)} cash · ${formatMoney(owedHere, currency)} owed`
                        : `${formatMoney(owedHere, currency)} owed`
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
                        <span
                          className={`account-dot kind-${account.kind}`}
                          style={account.color ? { background: account.color } : undefined}
                        />
                        <div className="account-name">
                          <span className="cell-strong" title={account.name}>
                            {account.name}
                          </span>
                          <span className="account-meta">
                            {ACCOUNT_KIND_LABEL[account.kind]}
                            {isCredit && limit !== null
                              ? ` · limit ${formatMoney(limit, currency)}`
                              : ''}
                            {account.dedicatedGoalId !== null
                              ? ` · only for ${goalNames.get(account.dedicatedGoalId) ?? 'a removed goal'}`
                              : ''}
                            {!countsInSafeToSpend(account) && !account.isArchived
                              ? ' · not safe to spend'
                              : ''}
                          </span>
                          {isCredit && limit !== null && limit > 0 && (
                            <span className="credit-meter">
                              <Progress
                                value={displayCents}
                                max={limit}
                                label={`${account.name} credit used`}
                              />
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
                          <span className="account-meta">
                            {isCredit
                              ? 'owed'
                              : account.kind === 'investment'
                                ? 'value'
                                : account.kind === 'cash'
                                  ? 'cash'
                                  : 'available'}
                          </span>
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
                          <IconButton
                            label={`Archive ${account.name}`}
                            onClick={() => void archiveAccount(account.id, true)}
                          >
                            <Archive size={14} />
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

      {archived.length > 0 && (
        <Card
          title="Archived accounts"
          subtitle="Kept for their history and left out of every total. Restore one to use it again."
        >
          <ul className="account-list">
            {archived.map((account) => (
              <li key={account.id} className="account-row">
                <Archive size={15} className="muted" />
                <div className="account-name">
                  <span className="cell-strong" title={account.name}>
                    {account.name}
                  </span>
                  <span className="account-meta">
                    {ACCOUNT_KIND_LABEL[account.kind]} · archived
                  </span>
                </div>
                <div className="account-figures">
                  <Money cents={account.balanceCents} currency={currency} />
                </div>
                <IconButton
                  label={`Restore ${account.name}`}
                  onClick={() => void archiveAccount(account.id, false)}
                >
                  <RotateCcw size={14} />
                </IconButton>
              </li>
            ))}
          </ul>
        </Card>
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
      {removing && <RemoveAccountDialog account={removing} onClose={() => setRemoving(null)} />}
    </>
  )
}

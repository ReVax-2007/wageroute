import { useEffect, useMemo, useState } from 'react'
import {
  ArrowRight,
  ArrowRightLeft,
  Plus,
  Trash2
} from 'lucide-react'
import { formatDateLabel, todayISO } from '@shared/dates'
import { entryDeletionWords } from '@shared/deletion'
import { CREDIT_CARD_SOURCE_REFUSAL } from '@shared/writeRules'
import { centsToEditable, currencySymbol, formatMoney, parseMoneyToCents } from '@shared/money'
import type { AccountWithBalance, TransactionRow } from '@shared/types'
import { CategoryInput } from '../components/CategoryInput'
import {
  Button,
  Card,
  EmptyState,
  Field,
  IconButton,
  Money,
  MoneyInput,
  Segmented
} from '../components/ui'
import { DataTable } from '../components/DataTable'
import { accountDisplayBalanceCents } from '../lib/finance'
import { useFinanceStore } from '../store/useFinanceStore'
import { SplitTransferForm } from './SplitTransferForm'

const QUICK_AMOUNTS = [50_00, 100_00, 250_00, 500_00]

function previewBalance(
  account: AccountWithBalance | undefined,
  deltaCents: number
): { displayCents: number; label: string } {
  if (!account) return { displayCents: 0, label: 'available' }
  const isCredit = account.kind === 'credit'
  const newRaw = account.balanceCents + deltaCents
  if (isCredit) {
    return { displayCents: Math.max(0, -newRaw), label: 'owed' }
  }
  return { displayCents: newRaw, label: 'available' }
}

export function Transfers() {
  const snapshot = useFinanceStore((state) => state.snapshot)
  const currency = useFinanceStore((state) => state.settings.currency)
  const createTransaction = useFinanceStore((state) => state.createTransaction)
  const deleteTransaction = useFinanceStore((state) => state.deleteTransaction)
  const countEntryDeletion = useFinanceStore((state) => state.countEntryDeletion)
  const askConfirm = useFinanceStore((state) => state.askConfirm)
  const queryTransactions = useFinanceStore((state) => state.queryTransactions)
  const go = useFinanceStore((state) => state.go)

  const activeAccounts = useMemo(
    () => (snapshot?.accounts ?? []).filter((account) => !account.isArchived),
    [snapshot]
  )

  // Money only leaves an account that holds it; a card is paid by moving into it.
  const sourceAccounts = useMemo(
    () => activeAccounts.filter((account) => account.kind !== 'credit'),
    [activeAccounts]
  )

  const accountMap = useMemo(
    () => new Map((snapshot?.accounts ?? []).map((account) => [account.id, account])),
    [snapshot]
  )

  const [fromId, setFromId] = useState<string>('')
  const [toId, setToId] = useState<string>('')
  const [amount, setAmount] = useState<string>('')
  const [occurredOn, setOccurredOn] = useState<string>(todayISO())
  const [memo, setMemo] = useState<string>('')
  // Kept between transfers, so a run of round-ups is labelled once.
  const [category, setCategory] = useState<{ name: string; id: string | null }>({
    name: 'Transfer',
    id: null
  })
  const [mode, setMode] = useState<'single' | 'split'>('single')
  const [saving, setSaving] = useState<boolean>(false)
  const [error, setError] = useState<string | null>(null)
  const [recentTransfers, setRecentTransfers] = useState<TransactionRow[]>([])

  // Keep the selection on live accounts: the source on one that can send money,
  // the destination on any other.
  useEffect(() => {
    const source = sourceAccounts.find((a) => a.id === fromId) ?? sourceAccounts[0]
    if (!source) return
    if (source.id !== fromId) setFromId(source.id)
    if (!toId || !accountMap.has(toId) || toId === source.id) {
      const next = activeAccounts.find((a) => a.id !== source.id)
      if (next) setToId(next.id)
    }
  }, [activeAccounts, sourceAccounts, accountMap, fromId, toId])

  // Load recent transfers
  useEffect(() => {
    let cancelled = false
    void queryTransactions({
      filter: { kind: 'transfer' },
      sort: 'date_desc',
      limit: 50,
      offset: 0
    })
      .then((page) => {
        if (cancelled) return
        const seen = new Set<string>()
        const list: TransactionRow[] = []
        for (const row of page.rows) {
          const key = row.transferGroupId ?? row.id
          if (!seen.has(key)) {
            seen.add(key)
            // Use the outgoing leg (amountCents < 0) as the primary record
            const outLeg = page.rows.find(
              (r) => (r.transferGroupId ?? r.id) === key && r.amountCents < 0
            )
            list.push(outLeg ?? row)
          }
        }
        setRecentTransfers(list)
      })
      .catch(() => {
        if (!cancelled) setRecentTransfers([])
      })
    return () => {
      cancelled = true
    }
  }, [snapshot?.transactions, queryTransactions])

  const fromAccount = accountMap.get(fromId)
  const toAccount = accountMap.get(toId)
  const amountCents = parseMoneyToCents(amount) ?? 0

  const swapAccounts = () => {
    setFromId(toId)
    setToId(fromId)
  }

  const handleQuickAdd = (deltaCents: number) => {
    const currentCents = parseMoneyToCents(amount) ?? 0
    setAmount(centsToEditable(currentCents + deltaCents))
  }

  const submit = async () => {
    setError(null)
    if (!fromId || !toId) {
      setError('Choose both accounts')
      return
    }
    if (fromId === toId) {
      setError('Choose two different accounts')
      return
    }
    if (fromAccount?.kind === 'credit') {
      setError(CREDIT_CARD_SOURCE_REFUSAL)
      return
    }
    if (amountCents <= 0) {
      setError('Enter a transfer amount')
      return
    }
    if (!fromAccount || !toAccount) {
      setError('Selected account was not found')
      return
    }

    setSaving(true)
    try {
      const ok = await createTransaction({
        accountId: fromId,
        counterAccountId: toId,
        kind: 'transfer',
        amountCents,
        occurredOn,
        memo: memo.trim() || `Transfer to ${toAccount.name}`,
        category: category.name.trim() || 'Transfer',
        categoryId: category.name.trim() ? category.id : null
      })
      if (ok) {
        setAmount('')
        setMemo('')
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not record transfer')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (row: TransactionRow) => {
    const doomed = await countEntryDeletion([row.id])
    const words = entryDeletionWords(doomed, {
      isTransferLeg: true,
      memo: row.memo || undefined
    })
    const ok = await askConfirm({
      title: words.title,
      body: words.body,
      confirmLabel: words.confirmLabel,
      danger: true
    })
    if (ok) {
      await deleteTransaction(row.id)
    }
  }

  if (activeAccounts.length < 2 || sourceAccounts.length === 0) {
    return (
      <>
        <header className="page-head">
          <div>
            <p className="eyebrow">Transfers</p>
            <h1 className="page-title" tabIndex={-1}>Move money between accounts</h1>
            <p className="page-sub">
              Transfer funds in a single movement. Both accounts update together without recording separate entries.
            </p>
          </div>
        </header>
        <Card>
          <EmptyState
            icon={<ArrowRightLeft size={24} />}
            title="Need at least two accounts"
            body="You need two active accounts, and at least one that is not a credit card, to move money between them."
            action={
              <Button variant="primary" icon={<Plus size={16} />} onClick={() => go('accounts')}>
                Add an account
              </Button>
            }
          />
        </Card>
      </>
    )
  }

  const fromPreview = previewBalance(fromAccount, -amountCents)
  const toPreview = previewBalance(toAccount, amountCents)
  const toOwedCents = toAccount ? accountDisplayBalanceCents(toAccount) : 0
  const fromCashCents = fromAccount && fromAccount.kind !== 'credit' ? fromAccount.balanceCents : 0

  return (
    <>
      <header className="page-head">
        <div>
          <p className="eyebrow">Transfers</p>
          <h1 className="page-title" tabIndex={-1}>Move money between accounts</h1>
          <p className="page-sub">
            Transfer funds in a single movement. Both accounts update together without recording separate entries.
          </p>
        </div>
      </header>

      <div className="transfer-layout">
        <section className="transfer-main">
          <Card
            title="New transfer"
            subtitle={
              mode === 'split'
                ? 'Send one amount to several accounts and see the total to move'
                : 'Choose the source and destination accounts to move funds in one step'
            }
            actions={
              <Segmented
                label="Transfer to"
                value={mode}
                onChange={setMode}
                options={[
                  { value: 'single', label: 'One account' },
                  { value: 'split', label: 'Several accounts' }
                ]}
              />
            }
          >
            {mode === 'split' ? (
              <SplitTransferForm
                activeAccounts={activeAccounts}
                sourceAccounts={sourceAccounts}
                currency={currency}
              />
            ) : (
              <div className="transfer-card">
                <div className="transfer-accounts-grid">
                  <Field label="From account">
                    <select
                      className="select"
                      value={fromId}
                      onChange={(event) => setFromId(event.target.value)}
                    >
                      {sourceAccounts.map((account) => (
                        <option key={account.id} value={account.id}>
                          {account.name} (
                          {account.kind === 'credit'
                            ? `${formatMoney(accountDisplayBalanceCents(account), currency)} owed`
                            : `${formatMoney(account.balanceCents, currency)} avail`}
                          )
                        </option>
                      ))}
                    </select>
                  </Field>

                  <div className="transfer-swap-container">
                    <button
                      type="button"
                      className="transfer-swap-btn"
                      title={
                        toAccount?.kind === 'credit'
                          ? 'A credit card can only receive a transfer'
                          : 'Swap from and to accounts'
                      }
                      aria-label="Swap accounts"
                      disabled={toAccount?.kind === 'credit'}
                      onClick={swapAccounts}
                    >
                      <ArrowRightLeft size={16} />
                    </button>
                  </div>

                  <Field label="To account">
                    <select
                      className="select"
                      value={toId}
                      onChange={(event) => setToId(event.target.value)}
                    >
                      {activeAccounts.map((account) => (
                        <option key={account.id} value={account.id}>
                          {account.name} (
                          {account.kind === 'credit'
                            ? `${formatMoney(accountDisplayBalanceCents(account), currency)} owed`
                            : `${formatMoney(account.balanceCents, currency)} avail`}
                          )
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>

                {fromAccount && toAccount && (
                  <div className="transfer-preview-box">
                    <div className="transfer-preview-acc">
                      <span className="transfer-preview-name">
                        <span
                          className={`account-dot kind-${fromAccount.kind}`}
                          style={fromAccount.color ? { background: fromAccount.color } : undefined}
                        />
                        {fromAccount.name}
                      </span>
                      <span className="transfer-preview-bal">
                        Now: {formatMoney(accountDisplayBalanceCents(fromAccount), currency)}{' '}
                        {fromAccount.kind === 'credit' ? 'owed' : 'avail'}
                      </span>
                      {amountCents > 0 && (
                        <span className="transfer-preview-diff negative">
                          After: {formatMoney(fromPreview.displayCents, currency)}{' '}
                          {fromPreview.label} (-{formatMoney(amountCents, currency)})
                        </span>
                      )}
                    </div>

                    <div className="transfer-preview-arrow">
                      <ArrowRight size={18} />
                    </div>

                    <div className="transfer-preview-acc">
                      <span className="transfer-preview-name">
                        <span
                          className={`account-dot kind-${toAccount.kind}`}
                          style={toAccount.color ? { background: toAccount.color } : undefined}
                        />
                        {toAccount.name}
                      </span>
                      <span className="transfer-preview-bal">
                        Now: {formatMoney(accountDisplayBalanceCents(toAccount), currency)}{' '}
                        {toAccount.kind === 'credit' ? 'owed' : 'avail'}
                      </span>
                      {amountCents > 0 && (
                        <span className="transfer-preview-diff positive">
                          After: {formatMoney(toPreview.displayCents, currency)}{' '}
                          {toPreview.label} (+{formatMoney(amountCents, currency)})
                        </span>
                      )}
                    </div>
                  </div>
                )}

                <div className="form-grid">
                  <Field label="Amount to transfer">
                    <MoneyInput
                      autoFocus
                      value={amount}
                      placeholder="0.00"
                      onValueChange={setAmount}
                    />
                    <div className="transfer-chips">
                      {QUICK_AMOUNTS.map((quickCents) => (
                        <button
                          key={quickCents}
                          type="button"
                          className="transfer-chip"
                          onClick={() => handleQuickAdd(quickCents)}
                        >
                          +{currencySymbol(currency)}{(quickCents / 100).toLocaleString()}
                        </button>
                      ))}
                      {toAccount?.kind === 'credit' && toOwedCents > 0 && (
                        <button
                          type="button"
                          className="transfer-chip preset-action"
                          onClick={() => setAmount(centsToEditable(toOwedCents))}
                        >
                          Pay card ({formatMoney(toOwedCents, currency)})
                        </button>
                      )}
                      {fromCashCents > 0 && (
                        <button
                          type="button"
                          className="transfer-chip preset-action"
                          onClick={() => setAmount(centsToEditable(fromCashCents))}
                        >
                          All cash ({formatMoney(fromCashCents, currency)})
                        </button>
                      )}
                    </div>
                  </Field>

                  <Field label="Transfer date">
                    <input
                      className="input"
                      type="date"
                      value={occurredOn}
                      onChange={(event) => setOccurredOn(event.target.value)}
                    />
                  </Field>
                </div>

                <div className="form-grid">
                  <Field
                    label="Category"
                    hint="Pick one you use, or type a new one like Round-up"
                  >
                    <CategoryInput
                      listId="transfer-category-options"
                      value={category.name}
                      placeholder="Transfer"
                      onChange={(name, id) => setCategory({ name, id })}
                    />
                  </Field>

                  <Field label="Description" hint="Optional, saved on both accounts">
                    <input
                      className="input"
                      value={memo}
                      placeholder={toAccount ? `Transfer to ${toAccount.name}` : 'Transfer'}
                      onChange={(event) => setMemo(event.target.value)}
                    />
                  </Field>
                </div>

                {amountCents > 0 && fromAccount && toAccount && fromId !== toId && (
                  <div className="transfer-summary-box">
                    <ArrowRightLeft size={16} />
                    <span>
                      Moving <strong>{formatMoney(amountCents, currency)}</strong> from{' '}
                      <strong>{fromAccount.name}</strong> into <strong>{toAccount.name}</strong> on{' '}
                      <strong>{formatDateLabel(occurredOn)}</strong>.
                    </span>
                  </div>
                )}

                {error && <div className="form-error">{error}</div>}

                <div>
                  <Button
                    variant="primary"
                    icon={<ArrowRightLeft size={16} />}
                    disabled={saving || amountCents <= 0 || fromId === toId}
                    onClick={submit}
                  >
                    {saving
                      ? 'Recording transfer…'
                      : amountCents > 0
                        ? `Transfer ${formatMoney(amountCents, currency)} now`
                        : 'Record transfer'}
                  </Button>
                </div>
              </div>
            )}
          </Card>
        </section>

        <section className="transfer-side">
          <Card
            title="Recent transfers"
            subtitle={`${recentTransfers.length} ${
              recentTransfers.length === 1 ? 'transfer' : 'transfers'
            } recorded`}
          >
            {recentTransfers.length === 0 ? (
              <EmptyState
                icon={<ArrowRightLeft size={20} />}
                title="No transfers recorded yet"
                body="Transfers you make between your accounts will appear here."
              />
            ) : (
              <DataTable
                caption="Recent transfers"
                columns={[
                  { key: 'date', label: 'Date' },
                  { key: 'route', label: 'Route' },
                  { key: 'amount', label: 'Amount', className: 'right' },
                  { key: 'actions', label: '', className: 'right' }
                ]}
              >
                {recentTransfers.map((item) => {
                  const sourceName = item.accountName
                  const destAccount = item.counterAccountId
                    ? accountMap.get(item.counterAccountId)
                    : null
                  const destName = destAccount?.name ?? 'Account'
                  const magnitude = Math.abs(item.amountCents)

                  return (
                    <tr key={item.id}>
                      <td className="num muted">{formatDateLabel(item.occurredOn)}</td>
                      <td>
                        <div className="transfer-route-cell">
                          <span>{sourceName}</span>
                          <span className="transfer-route-arrow">➔</span>
                          <span>{destName}</span>
                        </div>
                        <div className="cell-sub">
                          {[item.category, item.memo].filter(Boolean).join(' · ')}
                        </div>
                      </td>
                      <td className="right">
                        <Money cents={magnitude} currency={currency} className="cell-strong" />
                      </td>
                      <td className="right">
                        <IconButton
                          label="Delete transfer"
                          danger
                          onClick={() => void handleDelete(item)}
                        >
                          <Trash2 size={14} />
                        </IconButton>
                      </td>
                    </tr>
                  )
                })}
              </DataTable>
            )}
          </Card>
        </section>
      </div>
    </>
  )
}

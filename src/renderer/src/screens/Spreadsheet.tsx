import { useMemo, useState } from 'react'
import { Plus, Sheet } from 'lucide-react'
import { todayISO } from '@shared/dates'
import { parseMoneyToCents } from '@shared/money'
import { projectUpcoming } from '@shared/projections'
import type { TransactionInput, TransactionKind } from '@shared/types'
import { Button, Field, Modal, Segmented } from '../components/ui'
import { ProjectionsGrid } from '../components/ProjectionsGrid'
import { TransactionsGrid } from '../components/TransactionsGrid'
import { activeBills, TRANSACTION_KIND_LABEL } from '../lib/finance'
import { useFinanceStore } from '../store/useFinanceStore'

type SheetTab = 'ledger' | 'projections'

const KINDS = Object.keys(TRANSACTION_KIND_LABEL) as TransactionKind[]
const HORIZON_DAYS = 90

export function Spreadsheet() {
  const snapshot = useFinanceStore((state) => state.snapshot)
  const settings = useFinanceStore((state) => state.settings)
  const [tab, setTab] = useState<SheetTab>('ledger')
  const [adding, setAdding] = useState(false)

  const projections = useMemo(() => {
    if (!snapshot) return []
    return projectUpcoming({
      bills: activeBills(snapshot.bills),
      goals: snapshot.goals,
      fromISO: todayISO(),
      horizonDays: HORIZON_DAYS
    })
  }, [snapshot])

  if (!snapshot) return null
  const currency = settings.currency

  return (
    <>
      <header className="page-head">
        <div>
          <p className="eyebrow">Spreadsheet</p>
          <h1 className="page-title">Every number, one grid</h1>
          <p className="page-sub">
            Click a cell to edit it in place. Dates, accounts, categories and amounts all write
            straight to the local ledger.
          </p>
        </div>
        <Button variant="primary" icon={<Plus size={16} />} onClick={() => setAdding(true)}>
          Add entry
        </Button>
      </header>

      <section className="card sheet-card">
        <header className="sheet-toolbar">
          <Segmented<SheetTab>
            value={tab}
            onChange={setTab}
            options={[
              { value: 'ledger', label: `Transactions (${snapshot.transactions.length})` },
              {
                value: 'projections',
                label: `Next ${HORIZON_DAYS} days (${projections.length})`
              }
            ]}
          />
          <span className="sheet-hint">
            {tab === 'ledger'
              ? 'Double-click a cell to edit · Delete rows with the trash icon'
              : 'Read-only forecast of bills and goal deadlines'}
          </span>
        </header>

        <div className="grid-host">
          {tab === 'ledger' ? (
            snapshot.transactions.length === 0 ? (
              <div className="empty">
                <div className="empty-icon">
                  <Sheet size={20} />
                </div>
                <h3>No entries yet</h3>
                <p>Add an expense, a transfer or an adjustment to start the ledger.</p>
                <Button variant="primary" onClick={() => setAdding(true)}>
                  Add your first entry
                </Button>
              </div>
            ) : (
              <TransactionsGrid
                rows={snapshot.transactions}
                accounts={snapshot.accounts}
                currency={currency}
              />
            )
          ) : (
            <ProjectionsGrid rows={projections} currency={currency} />
          )}
        </div>
      </section>

      {adding && <EntryDialog onClose={() => setAdding(false)} />}
    </>
  )
}

function EntryDialog({ onClose }: { onClose: () => void }) {
  const snapshot = useFinanceStore((state) => state.snapshot)
  const createTransaction = useFinanceStore((state) => state.createTransaction)

  const accounts = (snapshot?.accounts ?? []).filter((account) => !account.isArchived)
  const [form, setForm] = useState({
    occurredOn: todayISO(),
    accountId: accounts[0]?.id ?? '',
    counterAccountId: '',
    kind: 'expense' as TransactionKind,
    amount: '',
    category: 'Misc',
    memo: ''
  })
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const submit = async () => {
    const typed = parseMoneyToCents(form.amount)
    if (!form.accountId) {
      setError('Pick an account')
      return
    }
    if (typed === null || typed === 0) {
      setError('Enter an amount')
      return
    }
    if (form.kind === 'transfer') {
      if (!form.counterAccountId) {
        setError('Choose the destination account')
        return
      }
      if (form.counterAccountId === form.accountId) {
        setError('Choose two different accounts')
        return
      }
    }

    // Amounts are stored as signed cents; the kind decides the default direction.
    const magnitude = Math.abs(typed)
    const amountCents =
      form.kind === 'income'
        ? magnitude
        : form.kind === 'adjustment'
          ? typed
          : -magnitude

    const input: TransactionInput = {
      accountId: form.accountId,
      kind: form.kind,
      amountCents,
      occurredOn: form.occurredOn,
      category: form.category.trim() || 'Misc',
      memo: form.memo.trim(),
      counterAccountId: form.kind === 'transfer' ? form.counterAccountId : null
    }

    setSaving(true)
    await createTransaction(input)
    setSaving(false)
    onClose()
  }

  const signHint =
    form.kind === 'income'
      ? 'Recorded as money in, even if you type a minus sign.'
      : form.kind === 'adjustment'
        ? 'Keeps the sign you type: negative lowers the balance.'
        : form.kind === 'transfer'
          ? 'Moves the amount from this account to the one below.'
          : 'Recorded as money out, even if you type a minus sign.'

  return (
    <Modal
      title="Add a ledger entry"
      subtitle="Manual entry only — nothing is imported from a bank."
      onClose={onClose}
      footer={
        <>
          <Button variant="quiet" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={saving}>
            Add entry
          </Button>
        </>
      }
    >
      <div className="form-grid">
        <Field label="Date">
          <input
            className="input"
            type="date"
            value={form.occurredOn}
            onChange={(event) => setForm({ ...form, occurredOn: event.target.value })}
          />
        </Field>
        <Field label="Account">
          <select
            className="select"
            value={form.accountId}
            onChange={(event) => setForm({ ...form, accountId: event.target.value })}
          >
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Kind">
          <select
            className="select"
            value={form.kind}
            onChange={(event) =>
              setForm({ ...form, kind: event.target.value as TransactionKind })
            }
          >
            {KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {TRANSACTION_KIND_LABEL[kind]}
              </option>
            ))}
          </select>
        </Field>
        {form.kind === 'transfer' && (
          <Field label="To account" hint="The other side of the transfer">
            <select
              className="select"
              value={form.counterAccountId}
              onChange={(event) => setForm({ ...form, counterAccountId: event.target.value })}
            >
              <option value="">Choose an account…</option>
              {accounts
                .filter((account) => account.id !== form.accountId)
                .map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.name}
                  </option>
                ))}
            </select>
          </Field>
        )}
        <Field label="Amount" hint={signHint}>
          <input
            className="input"
            autoFocus
            inputMode="decimal"
            value={form.amount}
            placeholder="42.50"
            onChange={(event) => setForm({ ...form, amount: event.target.value })}
          />
        </Field>
        <Field label="Category">
          <input
            className="input"
            value={form.category}
            onChange={(event) => setForm({ ...form, category: event.target.value })}
          />
        </Field>
        <Field label="Description" hint="Shown in the ledger and the dashboard feed">
          <input
            className="input"
            value={form.memo}
            placeholder="Groceries"
            onChange={(event) => setForm({ ...form, memo: event.target.value })}
          />
        </Field>
      </div>

      {error && <p className="form-error">{error}</p>}
    </Modal>
  )
}

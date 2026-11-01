import { useMemo, useState } from 'react'
import { Landmark, Plus, Sheet } from 'lucide-react'
import { todayISO } from '@shared/dates'
import { projectUpcoming } from '@shared/projections'
import { Button, EmptyState, Segmented } from '../components/ui'
import { EntryDialog } from '../components/dialogs/EntryDialog'
import { ProjectionsGrid } from '../components/ProjectionsGrid'
import { TransactionsGrid } from '../components/TransactionsGrid'
import { activeBills } from '../lib/finance'
import { useFinanceStore } from '../store/useFinanceStore'

type SheetTab = 'ledger' | 'projections'

const HORIZON_DAYS = 90

export function Spreadsheet() {
  const snapshot = useFinanceStore((state) => state.snapshot)
  const settings = useFinanceStore((state) => state.settings)
  const go = useFinanceStore((state) => state.go)
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
  const shown = snapshot.transactions.length
  const hidden = Math.max(0, snapshot.transactionTotal - shown)
  const liveAccounts = snapshot.accounts.filter((account) => !account.isArchived)

  return (
    <>
      <header className="page-head">
        <div>
          <p className="eyebrow">Spreadsheet</p>
          <h1 className="page-title" tabIndex={-1}>Every number, one grid</h1>
          <p className="page-sub">
            {tab === 'ledger'
              ? 'Double-click a cell to edit it in place. Dates, accounts, categories and amounts write straight to the local ledger.'
              : `A read-only forecast of the next ${HORIZON_DAYS} days of bills and goal deadlines, built from your own numbers.`}
          </p>
        </div>
        <Button
          variant="primary"
          icon={<Plus size={16} />}
          onClick={() => setAdding(true)}
          disabled={liveAccounts.length === 0}
          title={liveAccounts.length === 0 ? 'Add an account before recording an entry' : undefined}
        >
          Add entry
        </Button>
      </header>

      <section className="card sheet-card">
        <header className="sheet-toolbar">
          <Segmented<SheetTab>
            label="Spreadsheet view"
            value={tab}
            onChange={setTab}
            options={[
              {
                value: 'ledger',
                label:
                  hidden > 0
                    ? `Transactions (newest ${shown} of ${snapshot.transactionTotal})`
                    : `Transactions (${shown})`
              },
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

        {tab === 'ledger' && hidden > 0 && (
          <p className="sheet-note">
            The grid shows the newest {shown} entries; {hidden} older{' '}
            {hidden === 1 ? 'entry is' : 'entries are'} not listed here. They are still counted in
            every balance and included in a CSV export and a backup.
          </p>
        )}

        <div className="grid-host">
          {tab === 'ledger' ? (
            liveAccounts.length === 0 ? (
              <EmptyState
                icon={<Landmark size={20} />}
                title="Add an account first"
                body="Every ledger entry belongs to an account, so the grid stays empty until there is one to record against."
                action={
                  <Button variant="primary" onClick={() => go('accounts')}>
                    Add your first account
                  </Button>
                }
              />
            ) : snapshot.transactions.length === 0 ? (
              <EmptyState
                icon={<Sheet size={20} />}
                title="No entries yet"
                body="Add an expense, a transfer or an adjustment to start the ledger."
                action={
                  <Button variant="primary" onClick={() => setAdding(true)}>
                    Add your first entry
                  </Button>
                }
              />
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

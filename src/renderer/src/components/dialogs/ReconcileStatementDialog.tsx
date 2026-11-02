import { formatMoney } from '@shared/money'
import { Button, Modal } from '../ui'
import { useFinanceStore } from '../../store/useFinanceStore'

/**
 * The statement's closing balance and the ledger rarely disagree for a good
 * reason, so the import asks once, with the figures, and offers the single
 * adjustment that would settle it. Nothing is posted without this answer.
 */
export function ReconcileStatementDialog() {
  const reconciliation = useFinanceStore((state) => state.reconciliation)
  const currency = useFinanceStore((state) => state.settings.currency)
  const busy = useFinanceStore((state) => state.busy)
  const dismiss = useFinanceStore((state) => state.dismissReconciliation)
  const reconcile = useFinanceStore((state) => state.reconcileStatement)

  if (!reconciliation) return null

  const { accountName, accountKind, balanceOn, statementCents, ledgerCents, differenceCents } =
    reconciliation
  const lower = differenceCents > 0
  const gap = formatMoney(Math.abs(differenceCents), currency)

  return (
    <Modal
      title="Check this against your statement"
      subtitle={`${accountName} · closed ${balanceOn}`}
      onClose={dismiss}
      footer={
        <>
          <Button variant="quiet" onClick={dismiss}>
            Leave it
          </Button>
          <Button
            variant="primary"
            disabled={busy}
            onClick={() => void reconcile(reconciliation)}
          >
            {busy ? 'Posting…' : `Post ${gap} adjustment`}
          </Button>
        </>
      }
    >
      <div className="form-grid">
        <p className="wizard-hint">
          The statement closes at <strong>{formatMoney(statementCents, currency)}</strong>. Your
          ledger holds <strong>{formatMoney(ledgerCents, currency)}</strong> on that day, so your
          ledger is{' '}
          <strong>
            {gap} {lower ? 'lower' : 'higher'}
          </strong>
          .
        </p>
        <p className="field-hint">
          Posting one adjustment dated {balanceOn} makes the two agree. Anything you recorded after
          that day is left alone.
          {accountKind === 'credit'
            ? ' A credit account holds what you owe as a negative balance.'
            : ''}
        </p>
      </div>
    </Modal>
  )
}

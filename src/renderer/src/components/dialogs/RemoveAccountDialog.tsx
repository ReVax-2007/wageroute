import { useEffect, useState } from 'react'
import type { AccountWithBalance } from '@shared/types'
import { Button, Modal } from '../ui'
import { useFinanceStore } from '../../store/useFinanceStore'
import { useDialogSave } from '../useDialogSave'

export function RemoveAccountDialog({
  account,
  onClose
}: {
  account: AccountWithBalance
  onClose: () => void
}) {
  const deleteAccount = useFinanceStore((state) => state.deleteAccount)
  const archiveAccount = useFinanceStore((state) => state.archiveAccount)
  const accountEntryCount = useFinanceStore((state) => state.accountEntryCount)
  const [entries, setEntries] = useState<number | null>(null)
  const { saving, error, setError, run } = useDialogSave(onClose)

  useEffect(() => {
    let live = true
    void accountEntryCount(account.id).then((count) => {
      if (live) setEntries(count)
    })
    return () => {
      live = false
    }
  }, [account.id, accountEntryCount])

  const archive = async () => {
    const ok = await run(() => archiveAccount(account.id, true))
    if (!ok) setError('The account could not be archived. The reason is in the notification.')
  }
  const remove = async () => {
    const ok = await run(() => deleteAccount(account.id, true))
    if (!ok) setError('The account could not be removed. The reason is in the notification.')
  }

  const entryWord = entries === 1 ? '1 entry' : `${entries ?? '…'} entries`

  return (
    <Modal
      title={`Remove ${account.name}?`}
      subtitle="Archiving keeps every entry and can be undone. Deleting with its entries cannot."
      onClose={onClose}
      footer={
        <>
          <Button variant="quiet" onClick={onClose} autoFocus>
            Cancel
          </Button>
          {entries !== null && entries > 0 && (
            <Button variant="danger" onClick={remove} disabled={saving}>
              Delete account and {entryWord}
            </Button>
          )}
          {entries === 0 && (
            <Button variant="danger" onClick={remove} disabled={saving}>
              Delete account
            </Button>
          )}
          <Button variant="primary" onClick={archive} disabled={saving}>
            Archive instead
          </Button>
        </>
      }
    >
      <p>
        Archiving stops the account counting toward balances and Safe to Spend, but its{' '}
        {entries === null ? 'entries' : entryWord} stay in the ledger and it can be restored from
        the Archived list. Deleting removes the account and everything recorded in it from every
        total.
      </p>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </Modal>
  )
}

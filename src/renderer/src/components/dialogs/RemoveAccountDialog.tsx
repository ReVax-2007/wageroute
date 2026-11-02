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
  const [countFailed, setCountFailed] = useState(false)
  const { saving, error, setError, run } = useDialogSave(onClose)

  useEffect(() => {
    let live = true
    void accountEntryCount(account.id)
      .then((count) => {
        if (live) setEntries(count)
      })
      // The count labels the button; a failed read must not pretend the account
      // is empty. Say the count is unknown and keep deletion available, since
      // the ledger still goes with the account either way.
      .catch(() => {
        if (live) setCountFailed(true)
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
          {countFailed && (
            <Button variant="danger" onClick={remove} disabled={saving}>
              Delete account and its entries
            </Button>
          )}
          <Button variant="primary" onClick={archive} disabled={saving}>
            Archive instead
          </Button>
        </>
      }
    >
      <p>
        Archiving stops the account counting toward balances and Safe to Spend, but every entry
        stays in the ledger and the account can be restored from the Archived list.
      </p>
      <p>
        {countFailed
          ? 'The number of entries could not be read. Deleting removes the account and everything recorded in it from every total.'
          : `Deleting removes the account and ${
              entries === null ? 'everything recorded in it' : `its ${entryWord}`
            } from every total.`}
      </p>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </Modal>
  )
}

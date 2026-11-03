import { useEffect, useState } from 'react'
import type { AccountWithBalance } from '@shared/types'
import { accountDeletionWords, archiveVsDeleteHint } from '@shared/deletion'
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
  const countAccountDeletion = useFinanceStore((state) => state.countAccountDeletion)
  const [doomed, setDoomed] = useState<number | null | undefined>(undefined)
  const { saving, error, setError, run } = useDialogSave(onClose)

  useEffect(() => {
    let live = true
    // The ledger answers how many rows would leave, because the account's own
    // rows are not all of them: a transfer's twin and a purchase's sweep can
    // stand in another account and go with them.
    void countAccountDeletion(account.id).then((count) => {
      if (live) setDoomed(count)
    })
    return () => {
      live = false
    }
  }, [account.id, countAccountDeletion])

  const archive = async () => {
    const ok = await run(() => archiveAccount(account.id, true))
    if (!ok) setError('The account could not be archived. The reason is in the notification.')
  }
  const remove = async () => {
    const ok = await run(() => deleteAccount(account.id, true))
    if (!ok) setError('The account could not be removed. The reason is in the notification.')
  }

  const words = accountDeletionWords(account.name, doomed ?? null)
  // Until the count lands the question has no number, so neither its sentence
  // nor its button may guess one — or fall through to the read-failed wording,
  // which promises every linked row without having measured a one.
  const counting = doomed === undefined

  return (
    <Modal
      title={words.title}
      subtitle={archiveVsDeleteHint}
      onClose={onClose}
      footer={
        <>
          <Button variant="quiet" onClick={onClose} autoFocus>
            Cancel
          </Button>
          {/* While the count is on its way the question cannot name a number, so
              it waits rather than offering a delete it has not measured. */}
          <Button variant="danger" onClick={remove} disabled={saving || counting}>
            {counting ? 'Counting…' : words.confirmLabel}
          </Button>
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
      <p>{counting ? 'Counting what this removes…' : words.body}</p>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </Modal>
  )
}

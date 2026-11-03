/**
 * The question both devices ask before an entry leaves the ledger.
 *
 * `doomed` is every live row the delete retires — the rows the person picked,
 * plus the twin a transfer hides and the sweep legs a rounded-up purchase
 * owns. Counting the selection instead would promise one row and take three, so
 * each device measures the doomed set from its own copy of the ledger (SQLite on
 * the computer, the imported ledger on the phone) and hands the number here.
 */
export interface DeletionWords {
  title: string
  body: string
  confirmLabel: string
}

export function entryDeletionWords(
  doomed: number,
  options: { isTransferLeg?: boolean; memo?: string } = {}
): DeletionWords {
  const count = Math.max(1, Math.trunc(doomed))
  const memo = options.memo?.trim() ?? ''

  if (options.isTransferLeg) {
    return {
      title: 'Delete both legs of this transfer?',
      body: `“${memo || 'This transfer'}” is one movement of money; removing it also removes the matching leg.`,
      confirmLabel: 'Delete'
    }
  }
  if (count > 1) {
    return {
      title: `Delete ${count} entries?`,
      body: `${count} entries disappear from the ledger and every balance they touch. A purchase takes the round-up it caused, and a transfer takes its matching leg.`,
      confirmLabel: `Delete ${count}`
    }
  }
  return {
    title: 'Delete this entry?',
    body: memo
      ? `“${memo}” disappears from the ledger and every balance it touches.`
      : 'The entry disappears from the ledger and every balance it touches.',
    confirmLabel: 'Delete'
  }
}

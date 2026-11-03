/**
 * The questions both devices ask before a row leaves the ledger.
 *
 * `doomed` is every live row the delete retires — the rows the person picked,
 * plus the twin a transfer hides and the sweep legs a rounded-up purchase
 * owns. Counting the selection instead would promise one row and take three, so
 * each device measures the doomed set from its own copy of the ledger (SQLite on
 * the computer, the imported ledger on the phone) and hands the number here.
 *
 * One module owns the wording for every destructive question, so a sentence
 * cannot say one thing on a phone and another on the computer.
 */
export interface DeletionWords {
  title: string
  body: string
  confirmLabel: string
}

/**
 * Both devices ask the account question under this line: the two ways to lose an
 * account differ only in whether the rows come with it, and a phone should not
 * phrase that differently from the computer.
 */
export const archiveVsDeleteHint =
  'Archiving keeps every entry and can be undone. Deleting with its entries cannot.'

/**
 * Entry counts are written the way every other entry count in the app is —
 * grouped for the reader — so a question never says `1,234` where Home says
 * `1,234` and the button says `1234`.
 */
function grouped(count: number): string {
  return Math.max(0, Math.trunc(count)).toLocaleString()
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
      title: `Delete ${grouped(count)} entries?`,
      body: `${grouped(count)} entries disappear from the ledger and every balance they touch. A purchase takes the round-up it caused, and a transfer takes its matching leg.`,
      confirmLabel: `Delete ${grouped(count)}`
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

/**
 * Deleting an account retires more rows than the account holds: a transfer's twin
 * and a purchase's sweep legs can stand in other accounts and go with it. `doomed`
 * is that total, or null when the ledger could not be asked, in which case the
 * question says it does not know rather than guessing.
 */
export function accountDeletionWords(name: string, doomed: number | null): DeletionWords {
  if (doomed === null) {
    return {
      title: `Remove ${name}?`,
      body: 'Deleting removes the account and every entry recorded in it or linked to it from every total.',
      confirmLabel: 'Delete account and its entries'
    }
  }
  const count = Math.max(0, Math.trunc(doomed))
  if (count === 0) {
    return {
      title: `Remove ${name}?`,
      body: 'Deleting removes the account from every total. Nothing is recorded in it.',
      confirmLabel: 'Delete account'
    }
  }
  return {
    title: `Remove ${name}?`,
    body: `Deleting removes the account and ${count === 1 ? '1 entry' : `${grouped(count)} entries`} from every total.`,
    confirmLabel:
      count === 1 ? 'Delete account and 1 entry' : `Delete account and ${grouped(count)} entries`
  }
}

/**
 * A bill is not the only row it owns. Its set-asides are retired with it, while
 * the rows recorded against it stay in the ledger and simply stop proving it —
 * so the question names both numbers instead of saying "history" and leaving the
 * person to guess which rows move and which stay. The second count is every live
 * row linked to the bill, because that is exactly what the write releases; it is
 * not called a payment count, since a linked entry can be an adjustment.
 */
export function billDeletionWords(
  name: string,
  summary: { reserves: number; linkedEntries: number } | null
): DeletionWords {
  const stays = 'Paused bills stay on this page; this removes the bill itself.'
  if (!summary) {
    return {
      title: `Delete “${name}”?`,
      body: `Any set-asides it has go with it, and any entries recorded against it stay in the ledger without it. ${stays}`,
      confirmLabel: 'Delete bill'
    }
  }
  const reserves = Math.max(0, Math.trunc(summary.reserves))
  const linked = Math.max(0, Math.trunc(summary.linkedEntries))

  const reservePart =
    reserves === 0
      ? 'Nothing is set aside for it'
      : reserves === 1
        ? 'Its set-aside goes with it'
        : `Its ${grouped(reserves)} set-asides go with it`
  const linkPart =
    linked === 0
      ? 'nothing is recorded against it'
      : linked === 1
        ? '1 entry recorded against it stays in the ledger without the bill'
        : `its ${grouped(linked)} entries recorded against it stay in the ledger without the bill`

  return {
    title: `Delete “${name}”?`,
    body: `${reservePart}, and ${linkPart}. ${stays}`,
    confirmLabel: 'Delete bill'
  }
}

/** The fund is a plan, not money: what was already moved stays where it is. */
export function goalDeletionWords(name: string): DeletionWords {
  return {
    title: `Delete “${name}”?`,
    body: 'The fund disappears for good. Money already moved into the ledger stays in its accounts and history.',
    confirmLabel: 'Delete goal'
  }
}

/** How much of each kind of row a whole ledger holds. */
export interface LedgerCounts {
  accounts: number
  bills: number
  goals: number
  paychecks: number
  entries: number
}

function counted(count: number, singular: string, plural: string): string {
  const n = Math.max(0, Math.trunc(count))
  return `${n.toLocaleString()} ${n === 1 ? singular : plural}`
}

/**
 * Erasing the computer's ledger is the one destructive question with no twin on
 * the other device, so it lives here rather than in a screen: the numbers come
 * from the snapshot the renderer was handed, which counts every live row rather
 * than the 500-entry window the grid can show.
 */
export function eraseAllWords(counts: LedgerCounts): DeletionWords {
  return {
    title: 'Erase all data?',
    body: `This deletes ${counted(counts.entries, 'ledger entry', 'ledger entries')}, ${counted(counts.accounts, 'account', 'accounts')}, ${counted(counts.bills, 'bill', 'bills')}, ${counted(counts.goals, 'goal', 'goals')} and ${counted(counts.paychecks, 'paycheck', 'paychecks')} from the live database, and resets settings to their defaults.`,
    confirmLabel: 'Erase everything'
  }
}

/**
 * Forgetting the phone drops only this browser's copy, so the number that
 * matters is how much of it exists nowhere else. `phoneOnly` counts the rows the
 * phone wrote itself — but a row it wrote may already have travelled to the
 * computer in a backup, and this device cannot know which, so the sentence names
 * what is at risk and tells the person to export rather than claiming the
 * computer has never seen them.
 */
export function phoneCopyWords(entries: number, phoneOnly: number): DeletionWords {
  const total = Math.max(0, Math.trunc(entries)).toLocaleString()
  const here = Math.max(0, Math.trunc(phoneOnly))
  return {
    title: 'Forget this phone?',
    body:
      here > 0
        ? `${total} entries live in this browser and leave with it, including ${counted(
            here,
            'entry',
            'entries'
          )} this phone wrote. Export a backup before forgetting if any of them has not reached your computer yet — this browser is the only copy the app can see. Nothing on your computer changes.`
        : `${total} entries live in this browser and leave with it — every one of them a copy of your computer's ledger, which does not change.`,
    confirmLabel: 'Delete from this phone'
  }
}

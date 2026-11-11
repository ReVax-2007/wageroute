import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  accountDeletionWords,
  billDeletionWords,
  entryDeletionWords,
  eraseAllWords,
  goalDeletionWords,
  phoneCopyWords
} from './deletion'

test('a single entry is asked for on its own, by name', () => {
  const words = entryDeletionWords(1, { memo: 'Coffee' })
  assert.equal(words.title, 'Delete this entry?')
  assert.equal(words.body, '“Coffee” disappears from the ledger and every balance it touches.')
  assert.equal(words.confirmLabel, 'Delete')
})

test('an entry with no description still gets a readable question', () => {
  assert.equal(
    entryDeletionWords(1, { memo: '   ' }).body,
    'The entry disappears from the ledger and every balance it touches.'
  )
})

test('a delete that takes more rows says how many', () => {
  const words = entryDeletionWords(3)
  assert.equal(words.title, 'Delete 3 entries?')
  assert.match(words.body, /^3 entries disappear from the ledger/)
  assert.match(words.body, /round-up/)
  assert.equal(words.confirmLabel, 'Delete 3')
})

test('a transfer leg names both legs', () => {
  const words = entryDeletionWords(2, { isTransferLeg: true, memo: 'To savings' })
  assert.equal(words.title, 'Delete both legs of this transfer?')
  assert.equal(
    words.body,
    '“To savings” is one movement of money; removing it also removes the matching leg.'
  )
  assert.equal(
    entryDeletionWords(2, { isTransferLeg: true, memo: '' }).body,
    '“This transfer” is one movement of money; removing it also removes the matching leg.'
  )
})

test('the count is rounded to a number the ledger can lose', () => {
  assert.equal(entryDeletionWords(0).title, 'Delete this entry?')
  assert.equal(entryDeletionWords(-4).title, 'Delete this entry?')
  assert.equal(entryDeletionWords(2.7).title, 'Delete 2 entries?')
})

test('an empty account is offered on its own', () => {
  const words = accountDeletionWords('Card', 0)
  assert.equal(words.title, 'Remove Card?')
  assert.equal(words.body, 'Deleting removes the account from every total. Nothing is recorded in it.')
  assert.equal(words.confirmLabel, 'Delete account')
})

test('an account names every row it retires, not only its own', () => {
  assert.equal(
    accountDeletionWords('Card', 1).confirmLabel,
    'Delete account and 1 entry'
  )
  const three = accountDeletionWords('Card', 3)
  assert.equal(three.body, 'Deleting removes the account and 3 entries from every total.')
  assert.equal(three.confirmLabel, 'Delete account and 3 entries')
})

test('an account the ledger could not count admits it does not know', () => {
  const words = accountDeletionWords('Card', null)
  assert.match(words.body, /every entry recorded in it or linked to it/)
  assert.doesNotMatch(`${words.body}${words.confirmLabel}`, /\d/)
  assert.equal(words.confirmLabel, 'Delete account and its entries')
})

test('a bill separates the set-asides that go from the entries that stay', () => {
  const words = billDeletionWords('Rent', { reserves: 2, linkedEntries: 1 })
  assert.equal(words.title, 'Delete “Rent”?')
  assert.equal(
    words.body,
    'Its 2 set-asides go with it, and 1 entry recorded against it stays in the ledger without the bill. Paused bills stay on this page; this removes the bill itself.'
  )
  assert.equal(words.confirmLabel, 'Delete bill')
})

test('a bill with no money behind it says so in order', () => {
  assert.equal(
    billDeletionWords('Gym', { reserves: 0, linkedEntries: 0 }).body,
    'Nothing is set aside for it, and nothing is recorded against it. Paused bills stay on this page; this removes the bill itself.'
  )
  assert.match(
    billDeletionWords('Rent', { reserves: 1, linkedEntries: 3 }).body,
    /Its set-aside goes with it, and its 3 entries recorded against it stay/
  )
})

test('a bill the ledger could not count admits what it does not know', () => {
  const body = billDeletionWords('Rent', null).body
  assert.match(body, /^Any set-asides it has go with it, and any entries recorded against it stay/)
  // A failed read cannot claim the bill has set-asides, so no clause may assume
  // a number exists.
  assert.doesNotMatch(body, /\d/)
})

test('a goal says the plan leaves and the money stays', () => {
  const words = goalDeletionWords('Holiday')
  assert.equal(words.title, 'Delete “Holiday”?')
  assert.match(words.body, /Money already moved into the ledger stays/)
  assert.equal(words.confirmLabel, 'Delete goal')
})

test('erasing the computer names the rows it empties, in singular where one stands', () => {
  assert.equal(
    eraseAllWords({ accounts: 2, bills: 1, goals: 3, paychecks: 0, entries: 47 }).body,
    'This deletes 47 ledger entries, 2 accounts, 1 bill, 3 goals and 0 paychecks from the live database, and resets settings to their defaults.'
  )
  assert.equal(
    eraseAllWords({ accounts: 1, bills: 1, goals: 1, paychecks: 1, entries: 1 }).body,
    'This deletes 1 ledger entry, 1 account, 1 bill, 1 goal and 1 paycheck from the live database, and resets settings to their defaults.'
  )
  assert.equal(eraseAllWords({ accounts: 0, bills: 0, goals: 0, paychecks: 0, entries: 0 }).title, 'Erase all data?')
})

test('forgetting the phone warns about the rows it wrote, not about what the computer saw', () => {
  assert.equal(
    phoneCopyWords(12, 0).body,
    "12 entries live in this browser and leave with it — every one of them a copy of your computer's ledger, which does not change."
  )
  const one = phoneCopyWords(12, 1)
  assert.equal(one.title, 'Forget this phone?')
  assert.match(one.body, /including 1 entry this phone wrote/)
  assert.match(one.body, /Export a backup before forgetting/)
  assert.equal(one.confirmLabel, 'Delete from this phone')
  // The phone cannot know whether a row it wrote already travelled to the
  // computer in a backup, so the sentence may not claim it did not.
  assert.doesNotMatch(one.body, /never seen/)
  assert.match(phoneCopyWords(12, 7).body, /including 7 entries this phone wrote/)
})

test('a leg of a split transfer counts every transfer the split wrote', () => {
  const words = entryDeletionWords(6, { isTransferLeg: true, memo: 'Transfer to Savings' })
  assert.equal(words.title, 'Delete 6 entries?')
  assert.equal(words.confirmLabel, 'Delete 6')
  assert.match(words.body, /split transfer takes every transfer it wrote/)
})

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { entryDeletionWords } from './deletion'

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

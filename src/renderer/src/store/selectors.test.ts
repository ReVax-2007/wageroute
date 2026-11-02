import assert from 'node:assert/strict'
import test from 'node:test'
import type { BillPaymentTotal, Snapshot } from '@shared/types'
import { selectUnpaidWallCents } from './selectors'

function snapshotWith(payments: BillPaymentTotal[]): { snapshot: Snapshot } {
  return {
    snapshot: {
      bills: [
        {
          id: 'rent',
          name: 'Rent',
          amountCents: 120_000,
          frequency: 'monthly',
          isActive: true
        }
      ],
      billPaymentsThisMonth: payments
    } as unknown as Snapshot
  }
}

test('an unpaid bill stays on the wall', () => {
  assert.equal(selectUnpaidWallCents(snapshotWith([])), 120_000)
})

test('a bill paid from a spendable account releases its part of the wall', () => {
  assert.equal(
    selectUnpaidWallCents(
      snapshotWith([{ billId: 'rent', paidCents: 120_000, creditCents: 0 }])
    ),
    0
  )
})

test('a bill paid on a credit card stays withheld: the pool never fell', () => {
  assert.equal(
    selectUnpaidWallCents(
      snapshotWith([{ billId: 'rent', paidCents: 120_000, creditCents: 120_000 }])
    ),
    120_000
  )
})

test('only the card-funded part stays withheld when a bill is paid from both', () => {
  assert.equal(
    selectUnpaidWallCents(
      snapshotWith([{ billId: 'rent', paidCents: 120_000, creditCents: 60_000 }])
    ),
    60_000
  )
})

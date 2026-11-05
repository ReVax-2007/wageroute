import assert from 'node:assert/strict'
import test from 'node:test'
import { deriveClaimStates, type ClaimFact, type PaymentFact } from './claims'

/** A $120 monthly claim for November, written by a cheque that arrived on the 1st. */
function claim(overrides: Partial<ClaimFact> = {}): ClaimFact {
  return {
    id: 'claim-1',
    cycle: '2026-11',
    amountCents: 12_000,
    state: 'reserved',
    settledBy: null,
    dueDay: 1,
    receivedOn: '2026-11-01',
    createdAt: '2026-11-01T09:00:00.000Z',
    frequency: 'monthly',
    ...overrides
  }
}

function payment(overrides: Partial<PaymentFact> = {}): PaymentFact {
  return {
    id: 'pay-1',
    occurredOn: '2026-11-03',
    amountCents: -12_000,
    createdAt: '2026-11-03T09:00:00.000Z',
    ...overrides
  }
}

/** The walk is a replay, so a settled row is fed back as the state it now holds. */
function withState(rows: ClaimFact[], outcomes: ReturnType<typeof deriveClaimStates>): ClaimFact[] {
  return rows.map((row) => {
    const outcome = outcomes.find((candidate) => candidate.id === row.id)!
    return { ...row, state: outcome.state, settledBy: outcome.settledBy }
  })
}

test('a payment that covers a claim settles it and names itself as the one that did', () => {
  const [outcome] = deriveClaimStates([claim()], [payment()])
  assert.deepEqual(
    { state: outcome?.state, settledBy: outcome?.settledBy, changed: outcome?.changed },
    { state: 'paid', settledBy: 'pay-1', changed: true }
  )
})

test('a part payment holds the claim open and gives no credit for the money it took', () => {
  const [half] = deriveClaimStates([claim()], [payment({ amountCents: -4_000 })])
  assert.equal(half?.state, 'reserved')
  assert.equal(half?.settledBy, null)
  assert.equal(half?.changed, false, 'the row already says this, so a caller must not rewrite it')

  const [closed] = deriveClaimStates([claim()], [
    payment({ id: 'pay-1', amountCents: -4_000 }),
    payment({ id: 'pay-2', occurredOn: '2026-11-04', amountCents: -8_000 })
  ])
  assert.equal(closed?.state, 'paid')
  assert.equal(closed?.settledBy, 'pay-2', 'the payment that filled the gap is the one that settled it')
})

test('overpaying one claim never reaches into the next', () => {
  const outcomes = deriveClaimStates(
    [
      claim({ id: 'claim-1', cycle: '2026-10', receivedOn: '2026-09-28' }),
      claim({ id: 'claim-2', cycle: '2026-11', receivedOn: '2026-10-01' })
    ],
    [payment({ occurredOn: '2026-10-05', amountCents: -20_000 })]
  )
  assert.deepEqual(
    outcomes.map((outcome) => [outcome.id, outcome.state, outcome.settledBy]),
    [
      ['claim-1', 'paid', 'pay-1'],
      ['claim-2', 'reserved', null]
    ],
    'October is closed and November still holds its own money'
  )
})

test('a refund takes back the coverage it came from', () => {
  const settled = deriveClaimStates([claim()], [payment()])
  const after = deriveClaimStates(withState([claim()], settled), [
    payment(),
    payment({ id: 'pay-2', occurredOn: '2026-11-09', amountCents: 12_000 })
  ])
  assert.equal(after[0]?.state, 'reserved', 'the promise is owed again')
  assert.equal(after[0]?.settledBy, null)
  assert.equal(after[0]?.changed, true)
})

test('a cheque that had not arrived when the money left cannot settle', () => {
  const [outcome] = deriveClaimStates(
    [claim({ receivedOn: '2026-11-20' })],
    [payment({ occurredOn: '2026-11-03' })]
  )
  assert.equal(outcome?.state, 'reserved')
})

test('a cheque dated after the due day carries its money into the next occurrence', () => {
  // A claim January's 31st cheque wrote is really holding the bill due 1 February,
  // so February's payment reaches back to it.
  const carried = deriveClaimStates(
    [claim({ cycle: '2026-01', receivedOn: '2026-01-31', dueDay: 1 })],
    [payment({ occurredOn: '2026-02-02' })]
  )
  assert.deepEqual(
    { state: carried[0]?.state, settledBy: carried[0]?.settledBy },
    { state: 'paid', settledBy: 'pay-1' }
  )

  // The same claim written by a cheque that arrived before its due day belongs to
  // its own month: a payment a month late cannot be the money that settled it.
  const gated = deriveClaimStates(
    [claim({ cycle: '2026-01', receivedOn: '2026-01-15', dueDay: 20 })],
    [payment({ occurredOn: '2026-02-02' })]
  )
  assert.equal(gated[0]?.state, 'reserved')
})

test('a bill paid a few times a year clears every slice its cheques held', () => {
  const outcomes = deriveClaimStates(
    [
      claim({ id: 'claim-1', cycle: '2026-10', amountCents: 10_000, receivedOn: '2026-10-01', frequency: 'quarterly' }),
      claim({ id: 'claim-2', cycle: '2026-11', amountCents: 10_000, receivedOn: '2026-11-01', frequency: 'quarterly', dueDay: 28 })
    ],
    [payment({ id: 'pay-1', occurredOn: '2026-11-27', amountCents: -20_000 })]
  )
  assert.deepEqual(
    outcomes.map((outcome) => [outcome.id, outcome.state]),
    [
      ['claim-1', 'paid'],
      ['claim-2', 'paid']
    ],
    'the leftover skips the due-day gate: the October cheque was already holding it'
  )
})

test('the order the rows arrive in cannot choose which claim gets settled', () => {
  const claims = [
    claim({ id: 'claim-1', cycle: '2026-10', receivedOn: '2026-09-28' }),
    claim({ id: 'claim-2', cycle: '2026-11', receivedOn: '2026-11-01' })
  ]
  const payments = [
    payment({ id: 'pay-1', occurredOn: '2026-11-04', amountCents: -12_000 }),
    payment({ id: 'pay-2', occurredOn: '2026-11-05', amountCents: -12_000 })
  ]
  const forward = deriveClaimStates(claims, payments)
  const backward = deriveClaimStates([...claims].reverse(), [...payments].reverse())
  assert.deepEqual(backward, forward)
})

test('a ledger with no claims has nothing to derive', () => {
  assert.deepEqual(deriveClaimStates([], [payment()]), [])
})

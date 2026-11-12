import assert from 'node:assert/strict'
import test from 'node:test'
import { dueBillPrompts, type PromptBill } from './billPrompts'
import { deriveClaimStates, type ClaimFact } from './claims'
import { billVariance, creditedPaymentCents } from './variableBills'

/** ADR 0036: a variable bill's amount is an estimate, cleared by one payment of any size. */

const GAS = { amountCents: 7_000, isVariable: true }
const RENT = { amountCents: 7_000, isVariable: false }

test('a spend on a variable bill counts as at least its estimate', () => {
  assert.equal(creditedPaymentCents(GAS, -5_100), -7_000, 'cheaper: counts as the estimate')
  assert.equal(creditedPaymentCents(GAS, -7_000), -7_000)
  assert.equal(creditedPaymentCents(GAS, -8_500), -8_500, 'dearer: counts as what it was')
})

test('a fixed bill and a refund pass through unchanged', () => {
  assert.equal(creditedPaymentCents(RENT, -5_100), -5_100)
  assert.equal(creditedPaymentCents(GAS, 1_000), 1_000, 'a refund returns what it returned')
  assert.equal(creditedPaymentCents(GAS, 0), 0)
})

test('the variance names what is free again or how far over it went', () => {
  assert.deepEqual(billVariance(7_000, 5_100), { underCents: 1_900, overCents: 0 })
  assert.deepEqual(billVariance(7_000, 8_500), { underCents: 0, overCents: 1_500 })
  assert.deepEqual(billVariance(7_000, 7_000), { underCents: 0, overCents: 0 })
})

function gasClaim(overrides: Partial<ClaimFact> = {}): ClaimFact {
  return {
    id: 'claim-gas',
    cycle: '2026-11',
    amountCents: 7_000,
    state: 'reserved',
    settledBy: null,
    dueDay: 15,
    receivedOn: '2026-11-01',
    createdAt: '2026-11-01T09:00:00.000Z',
    frequency: 'monthly',
    ...overrides
  }
}

const pay = (amountCents: number, id = 'pay-1') => ({
  id,
  occurredOn: '2026-11-10',
  amountCents,
  createdAt: `2026-11-10T09:00:00.000Z`
})

test('a $51 payment closes a $70 variable claim, but not a fixed one', () => {
  const [variable] = deriveClaimStates([gasClaim()], [pay(-5_100)], GAS)
  assert.equal(variable.state, 'paid')
  assert.equal(variable.settledBy, 'pay-1')

  const [fixed] = deriveClaimStates([gasClaim()], [pay(-5_100)], RENT)
  assert.equal(fixed.state, 'reserved', 'a part payment on a fixed bill still holds the claim')
  const [unspecified] = deriveClaimStates([gasClaim()], [pay(-5_100)])
  assert.equal(unspecified.state, 'reserved', 'no bill passed reads as fixed, as before')
})

test('a cheque-split variable month is closed whole by its one payment', () => {
  const claims = [
    gasClaim({ id: 'a', amountCents: 3_500 }),
    gasClaim({ id: 'b', amountCents: 3_500, receivedOn: '2026-11-08', createdAt: '2026-11-08T09:00:00.000Z' })
  ]
  const outcomes = deriveClaimStates(claims, [pay(-5_100)], GAS)
  assert.deepEqual(outcomes.map((outcome) => outcome.state), ['paid', 'paid'])
})

test('a refund of a variable payment takes back what it returned, as on a fixed bill', () => {
  const [partly] = deriveClaimStates(
    [gasClaim()],
    [pay(-5_100), { ...pay(1_000, 'refund'), occurredOn: '2026-11-12' }],
    GAS
  )
  assert.equal(partly.state, 'reserved', 'the claim reopens for the $10 handed back')
})

function promptBill(isVariable: boolean): PromptBill {
  return {
    id: 'gas',
    name: 'Gas',
    amountCents: 7_000,
    frequency: 'monthly',
    dueDay: 5,
    nextDueOn: null,
    category: 'Transport',
    accountId: 'acc',
    isActive: true,
    autopay: false,
    isVariable
  }
}

test('the prompt goes quiet after one cheaper payment on a variable bill only', () => {
  const payments = [{ billId: 'gas', occurredOn: '2026-11-05', amountCents: -5_100 }]
  const today = '2026-11-09'
  assert.deepEqual(dueBillPrompts({ bills: [promptBill(true)], payments, todayISO: today }), [])
  const [fixed] = dueBillPrompts({ bills: [promptBill(false)], payments, todayISO: today })
  assert.equal(fixed.paidCents, 5_100, 'a fixed bill still asks for the rest')
})

test('an unpaid variable prompt says it is variable and offers the estimate', () => {
  const [prompt] = dueBillPrompts({ bills: [promptBill(true)], payments: [], todayISO: '2026-11-09' })
  assert.equal(prompt.isVariable, true)
  assert.equal(prompt.amountCents - prompt.paidCents, 7_000)
})

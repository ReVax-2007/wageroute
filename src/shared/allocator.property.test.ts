import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildAllocationPlan,
  type AllocatorBill,
  type AllocatorGoal,
  type AllocationPlan
} from './allocator'
import type { BillFundingStrategy, Frequency, PayCadence } from './types'

const FREQUENCIES: readonly Frequency[] = [
  'weekly',
  'biweekly',
  'semimonthly',
  'monthly',
  'quarterly',
  'annual'
]
const CADENCES: readonly PayCadence[] = ['weekly', 'biweekly', 'semimonthly', 'monthly']
const STRATEGIES: readonly BillFundingStrategy[] = [
  'all_checks',
  'closest_due_date',
  'specific_check',
  'first_check',
  'last_check'
]
const DATES = ['2026-01-01', '2026-01-15', '2026-01-31', '2026-02-14', '2026-12-31', null]

/** Deterministic generator: a failure reproduces from the seed, not a rerun. */
function generator(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
    return state / 4_294_967_296
  }
}

function randomInput(random: () => number): Parameters<typeof buildAllocationPlan>[0] {
  const int = (max: number): number => Math.floor(random() * max)
  const pick = <T>(values: readonly T[]): T => values[int(values.length)]

  const bills: AllocatorBill[] = Array.from({ length: int(6) }, (_, index) => ({
    id: `bill-${index}`,
    name: `Bill ${index}`,
    amountCents: 1 + int(200_000),
    frequency: pick(FREQUENCIES),
    dueDay: 1 + int(31),
    fundingStrategy: pick(STRATEGIES),
    fundingPaycheckIndex: 1 + int(4)
  }))
  const reservedBillIds = bills.filter(() => random() < 0.5).map((bill) => bill.id)

  const goals: AllocatorGoal[] = Array.from({ length: int(5) }, (_, index) => {
    const targetCents = 1 + int(500_000)
    return {
      id: `goal-${index}`,
      name: `Goal ${index}`,
      targetCents,
      fundedCents: int(targetCents + 50_000),
      priority: 1 + int(5),
      targetDate: pick(DATES),
      fundedFrom: random() < 0.25 ? 'account' : 'allocations'
    }
  })

  return {
    // Negative and zero income are legal inputs to the screen; the plan must
    // clamp them rather than produce a negative allocation.
    incomeCents: int(2_000_001) - 1_000,
    payCadence: pick(CADENCES),
    paycheckDate: pick(DATES),
    payAnchorDate: pick(DATES),
    reservedBillIds,
    bills,
    goals,
    splits: {
      savingsPercent: int(101),
      investmentPercent: int(101),
      goalsPercent: int(101),
      debtPercent: int(101)
    },
    wholeDollarBuckets: random() < 0.5
  }
}

function allocated(plan: AllocationPlan): number {
  return (
    plan.priorityFundedCents +
    plan.savingsCents +
    plan.investmentCents +
    plan.goalsCents +
    plan.debtCents +
    plan.leisureCents
  )
}

test('the allocation invariant holds for random inputs', () => {
  const random = generator(0x5eed_1e55)

  for (let run = 0; run < 500; run += 1) {
    const input = randomInput(random)
    const plan = buildAllocationPlan(input)
    const expectedIncome = Math.max(0, Math.round(input.incomeCents))
    const label = `run ${run}`

    assert.equal(plan.incomeCents, expectedIncome, label)
    assert.equal(allocated(plan), plan.incomeCents, `every cent is allocated (${label})`)
    assert.ok(plan.priorityFundedCents <= plan.priorityRequiredCents, label)
    assert.equal(
      plan.goalsCents,
      plan.goalFundings.reduce((total, funding) => total + funding.amountCents, 0),
      `goal fundings sum to the goal bucket (${label})`
    )
    assert.ok(plan.goalFundings.every((funding) => funding.amountCents <= funding.needCents), label)

    for (const cents of [
      plan.priorityFundedCents,
      plan.savingsCents,
      plan.investmentCents,
      plan.goalsCents,
      plan.debtCents,
      plan.leisureCents
    ]) {
      assert.ok(Number.isInteger(cents) && cents >= 0, `no negative or fractional bucket (${label})`)
    }

    if (plan.shortfallCents > 0) {
      assert.equal(plan.surplusCents, 0, label)
      assert.equal(
        plan.savingsCents + plan.investmentCents + plan.goalsCents + plan.debtCents + plan.leisureCents,
        0,
        `a shortfall funds nothing else (${label})`
      )
    }

    if (input.wholeDollarBuckets && plan.shortfallCents === 0) {
      for (const cents of [plan.savingsCents, plan.investmentCents, plan.debtCents]) {
        assert.equal(cents % 100, 0, `whole-dollar bucket (${label})`)
      }
      assert.ok(
        plan.goalFundings.every((funding) => funding.amountCents % 100 === 0),
        `whole-dollar goal line (${label})`
      )
    }
  }
})

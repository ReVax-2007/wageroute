import { monthlyEquivalentCents, reservePerPaycheckCents } from './cadence'
import { clampPercent, floorToDollarCents, percentOf } from './money'
import type { Frequency, GoalFundingSource, PayCadence, PlanHealth } from './types'

export interface AllocatorBill {
  id: string
  name: string
  amountCents: number
  frequency: Frequency
}

export interface AllocatorGoal {
  id: string
  name: string
  targetCents: number
  fundedCents: number
  priority: number
  targetDate: string | null
  /**
   * 'account' means a dedicated account's balance already is the progress, so
   * writing an allocation row against it would be invisible. Those goals are
   * skipped and their share of the budget falls through to savings.
   */
  fundedFrom?: GoalFundingSource
}

export interface AllocatorSplits {
  savingsPercent: number
  investmentPercent: number
  goalsPercent: number
  debtPercent: number
}

export interface AllocatorInput {
  incomeCents: number
  payCadence: PayCadence
  bills: readonly AllocatorBill[]
  goals: readonly AllocatorGoal[]
  splits: AllocatorSplits
  wholeDollarBuckets?: boolean
}

export type PlanWarning =
  | { code: 'shortfall'; shortfallCents: number }
  | { code: 'splits_scaled'; requestedCents: number; availableCents: number }
  | { code: 'goal_overflow'; overflowCents: number }
  | { code: 'no_bills' }
  | { code: 'no_goals' }
  | { code: 'tight_margin'; leisureCents: number }

export interface PriorityReserve {
  billId: string
  name: string
  reserveCents: number
  monthlyCents: number
}

export interface GoalFunding {
  goalId: string
  name: string
  amountCents: number
  needCents: number
}

export interface AllocationPlan {
  incomeCents: number
  payCadence: PayCadence
  priorityRequiredCents: number
  priorityFundedCents: number
  shortfallCents: number
  surplusCents: number
  savingsCents: number
  investmentCents: number
  goalsCents: number
  debtCents: number
  leisureCents: number
  priorityReserves: PriorityReserve[]
  goalFundings: GoalFunding[]
  splits: AllocatorSplits
  health: PlanHealth
  warnings: PlanWarning[]
}

/**
 * Pure, deterministic paycheck router.
 *
 * Invariant: priorityFunded + savings + investment + goals + debt + leisure === income.
 * The Priority Wall is funded first and is never touched by the split maths;
 * leisure is the residual, so the plan can never over-allocate.
 */
export function buildAllocationPlan(input: AllocatorInput): AllocationPlan {
  const incomeCents = Math.max(0, Math.round(input.incomeCents))
  const warnings: PlanWarning[] = []
  const splits: AllocatorSplits = {
    savingsPercent: clampPercent(input.splits.savingsPercent),
    investmentPercent: clampPercent(input.splits.investmentPercent),
    goalsPercent: clampPercent(input.splits.goalsPercent),
    debtPercent: clampPercent(input.splits.debtPercent)
  }

  const priorityReserves = input.bills.map<PriorityReserve>((bill) => ({
    billId: bill.id,
    name: bill.name,
    reserveCents: reservePerPaycheckCents(bill.amountCents, bill.frequency, input.payCadence),
    monthlyCents: monthlyEquivalentCents(bill.amountCents, bill.frequency)
  }))

  const priorityRequiredCents = priorityReserves.reduce((total, line) => total + line.reserveCents, 0)
  const priorityFundedCents = Math.min(priorityRequiredCents, incomeCents)
  const shortfallCents = priorityRequiredCents - priorityFundedCents
  const surplusCents = incomeCents - priorityFundedCents

  if (input.bills.length === 0) warnings.push({ code: 'no_bills' })

  if (shortfallCents > 0) {
    warnings.push({ code: 'shortfall', shortfallCents })
    return {
      incomeCents,
      payCadence: input.payCadence,
      priorityRequiredCents,
      priorityFundedCents,
      shortfallCents,
      surplusCents: 0,
      savingsCents: 0,
      investmentCents: 0,
      goalsCents: 0,
      debtCents: 0,
      leisureCents: 0,
      priorityReserves,
      goalFundings: [],
      splits,
      health: 'shortfall',
      warnings
    }
  }

  const desired = [
    percentOf(surplusCents, splits.savingsPercent),
    percentOf(surplusCents, splits.investmentPercent),
    percentOf(surplusCents, splits.goalsPercent),
    percentOf(surplusCents, splits.debtPercent)
  ]
  const requestedCents = desired[0] + desired[1] + desired[2] + desired[3]

  let scaled = desired
  if (requestedCents > surplusCents) {
    scaled = scaleToTarget(desired, surplusCents)
    warnings.push({ code: 'splits_scaled', requestedCents, availableCents: surplusCents })
  }

  let savingsCents = scaled[0]
  let investmentCents = scaled[1]
  let goalBudget = scaled[2]
  let debtCents = scaled[3]

  const allocatableGoals = input.goals.filter((goal) => goal.fundedFrom !== 'account')

  const goalsByNeed = [...allocatableGoals]
    .filter((goal) => goal.targetCents > goal.fundedCents)
    .sort(
      (a, b) =>
        a.priority - b.priority ||
        (a.targetDate ?? '9999-12-31').localeCompare(b.targetDate ?? '9999-12-31') ||
        a.name.localeCompare(b.name)
    )

  const goalFundings: GoalFunding[] = []
  for (const goal of goalsByNeed) {
    if (goalBudget <= 0) break
    const needCents = goal.targetCents - goal.fundedCents
    const amountCents = Math.min(needCents, goalBudget)
    goalFundings.push({ goalId: goal.id, name: goal.name, amountCents, needCents })
    goalBudget -= amountCents
  }

  if (goalBudget > 0) {
    savingsCents += goalBudget
    warnings.push(
      allocatableGoals.length === 0
        ? { code: 'no_goals' }
        : { code: 'goal_overflow', overflowCents: goalBudget }
    )
  }

  if (input.wholeDollarBuckets) {
    savingsCents = floorToDollarCents(savingsCents)
    investmentCents = floorToDollarCents(investmentCents)
    debtCents = floorToDollarCents(debtCents)
    for (const funding of goalFundings) {
      funding.amountCents = floorToDollarCents(funding.amountCents)
    }
  }

  const activeFundings = goalFundings.filter((funding) => funding.amountCents > 0)
  const goalsCents = activeFundings.reduce((total, funding) => total + funding.amountCents, 0)

  let leisureCents = surplusCents - savingsCents - investmentCents - goalsCents - debtCents
  if (leisureCents < 0) {
    savingsCents += leisureCents
    leisureCents = 0
  }

  const tightThreshold = Math.round(incomeCents * 0.1)
  const health: PlanHealth =
    incomeCents === 0 || leisureCents < tightThreshold ? 'tight' : 'covered'
  if (health === 'tight') warnings.push({ code: 'tight_margin', leisureCents })

  return {
    incomeCents,
    payCadence: input.payCadence,
    priorityRequiredCents,
    priorityFundedCents,
    shortfallCents,
    surplusCents,
    savingsCents,
    investmentCents,
    goalsCents,
    debtCents,
    leisureCents,
    priorityReserves,
    goalFundings: activeFundings,
    splits,
    health,
    warnings
  }
}

/**
 * Shrinks three buckets to fit a smaller target, using largest-remainder
 * apportionment so the cents still add up exactly.
 */
function scaleToTarget(values: readonly number[], target: number): number[] {
  const total = values.reduce((sum, value) => sum + value, 0)
  if (total <= target) return [...values]

  const exact = values.map((value) => (value * target) / total)
  const floored = exact.map((value) => Math.floor(value))
  let remainder = target - floored.reduce((sum, value) => sum + value, 0)

  const order = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction)

  for (let i = 0; remainder > 0 && i < order.length; i += 1, remainder -= 1) {
    floored[order[i].index] += 1
  }

  return floored
}

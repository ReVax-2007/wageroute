import { addDaysISO, advanceByFrequency, nextDueDateISO } from './dates'
import type { Frequency } from './types'

export interface ProjectionBill {
  id: string
  name: string
  category: string
  amountCents: number
  frequency: Frequency
  dueDay: number
  nextDueOn: string | null
}

export interface ProjectionGoal {
  id: string
  name: string
  targetDate: string | null
  remainingCents: number
}

export interface ProjectionRow {
  id: string
  date: string
  type: 'bill' | 'goal'
  name: string
  category: string
  amountCents: number
}

export interface ProjectionInput {
  bills: readonly ProjectionBill[]
  goals: readonly ProjectionGoal[]
  fromISO: string
  horizonDays: number
}

export function projectUpcoming(input: ProjectionInput): ProjectionRow[] {
  const endISO = addDaysISO(input.fromISO, input.horizonDays)
  const rows: ProjectionRow[] = []

  for (const bill of input.bills) {
    const anchor =
      bill.nextDueOn && bill.nextDueOn >= input.fromISO
        ? bill.nextDueOn
        : nextDueDateISO(bill.dueDay, input.fromISO)

    let cursor = anchor
    let guard = 0
    while (cursor <= endISO && guard < 400) {
      rows.push({
        id: `${bill.id}:${cursor}`,
        date: cursor,
        type: 'bill',
        name: bill.name,
        category: bill.category,
        amountCents: bill.amountCents
      })
      cursor = advanceByFrequency(cursor, bill.frequency)
      guard += 1
    }
  }

  for (const goal of input.goals) {
    if (!goal.targetDate || goal.remainingCents <= 0) continue
    if (goal.targetDate < input.fromISO || goal.targetDate > endISO) continue
    rows.push({
      id: `goal:${goal.id}`,
      date: goal.targetDate,
      type: 'goal',
      name: goal.name,
      category: 'Goal target',
      amountCents: goal.remainingCents
    })
  }

  return rows.sort(
    (a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name)
  )
}

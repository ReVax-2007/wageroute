import assert from 'node:assert/strict'
import test from 'node:test'
import {
  billFundingReserveCents,
  closestCheckIndexToDue,
  fundingCheckIndex,
  monthlyEquivalentCents,
  paycheckIndexInMonth,
  reachableCheckIndexes,
  reservePerPaycheckCents
} from './cadence'
import type { PayCadence } from './types'

const CADENCES: PayCadence[] = ['weekly', 'biweekly', 'semimonthly', 'monthly']

test('a paycheck is placed in its month slot by day of month', () => {
  assert.equal(paycheckIndexInMonth('2026-03-05', 'weekly'), 1)
  assert.equal(paycheckIndexInMonth('2026-03-14', 'weekly'), 2)
  assert.equal(paycheckIndexInMonth('2026-03-31', 'weekly'), 5)
  assert.equal(paycheckIndexInMonth('2026-03-14', 'biweekly'), 1)
  assert.equal(paycheckIndexInMonth('2026-03-15', 'biweekly'), 2, 'day 15 is closer to the 21st')
  assert.equal(paycheckIndexInMonth('2026-03-16', 'biweekly'), 2)
  assert.equal(paycheckIndexInMonth('2026-03-29', 'biweekly'), 3)
  assert.equal(paycheckIndexInMonth('2026-03-15', 'semimonthly'), 1)
  assert.equal(paycheckIndexInMonth('2026-03-16', 'semimonthly'), 2)
  assert.equal(paycheckIndexInMonth('2026-03-20', 'monthly'), 1)
})

test('the check closest to a due day is the nearest slot, ties going earlier', () => {
  assert.equal(closestCheckIndexToDue(1, 'biweekly'), 1)
  assert.equal(closestCheckIndexToDue(18, 'biweekly'), 2)
  assert.equal(closestCheckIndexToDue(14, 'biweekly'), 1, 'the 7th and 21st are both 7 days away')
  assert.equal(closestCheckIndexToDue(31, 'weekly'), 5)
  assert.equal(closestCheckIndexToDue(9, 'monthly'), 1, 'a monthly paycheck is always the one')
})

test('only slots that exist every month can be offered', () => {
  assert.deepEqual(reachableCheckIndexes('monthly'), [1])
  assert.deepEqual(reachableCheckIndexes('semimonthly'), [1, 2])
  assert.deepEqual(reachableCheckIndexes('biweekly'), [1, 2])
  assert.deepEqual(reachableCheckIndexes('weekly'), [1, 2, 3, 4])
})

test('a target beyond the guaranteed slots is clamped, never dropped', () => {
  for (const cadence of CADENCES) {
    const last = reachableCheckIndexes(cadence).at(-1) as number
    const clamped = fundingCheckIndex({
      cadence,
      dueDay: 1,
      fundingStrategy: 'specific_check',
      fundingPaycheckIndex: 9
    })
    assert.equal(clamped, last, `${cadence} never leaves a bill unfunded`)
    assert.equal(
      fundingCheckIndex({
        cadence,
        dueDay: 1,
        fundingStrategy: 'first_check'
      }),
      1
    )
    assert.equal(
      fundingCheckIndex({
        cadence,
        dueDay: 1,
        fundingStrategy: 'all_checks',
        fundingPaycheckIndex: 3
      }),
      null
    )
  }
})

test('a single-check strategy carries the month, not one instance of the bill', () => {
  const weeklyBill = { amountCents: 5000, frequency: 'weekly' as const }
  const monthCents = monthlyEquivalentCents(weeklyBill.amountCents, weeklyBill.frequency)
  assert.equal(monthCents, 21_667, 'a $50 weekly bill is $216.67 a month')

  const onFundingCheck = billFundingReserveCents({
    ...weeklyBill,
    cadence: 'biweekly',
    dueDay: 5,
    fundingStrategy: 'closest_due_date',
    paycheckDate: '2026-03-06'
  })
  assert.equal(onFundingCheck, 21_667, 'one check asks the whole month, not the $50 instance')

  const onOtherCheck = billFundingReserveCents({
    ...weeklyBill,
    cadence: 'biweekly',
    dueDay: 5,
    fundingStrategy: 'closest_due_date',
    paycheckDate: '2026-03-20'
  })
  assert.equal(onOtherCheck, 0, 'the other check asks nothing, so the month is not paid twice')
})

test('every strategy reserves the same total across a month', () => {
  for (const cadence of CADENCES) {
    const slots = reachableCheckIndexes(cadence)
    const dates = slots.map(
      (slot) => `2026-03-${String(dayOfSlot(cadence, slot)).padStart(2, '0')}`
    )
    for (const strategy of [
      'all_checks',
      'closest_due_date',
      'first_check',
      'specific_check',
      'last_check'
    ] as const) {
      // One bill has one funding target; the month is the set of paychecks around it.
      const target = strategy === 'specific_check' ? slots.at(-1) ?? 1 : null
      let monthTotal = 0
      for (const date of dates) {
        monthTotal += billFundingReserveCents({
          amountCents: 120_000,
          frequency: 'monthly',
          cadence,
          dueDay: 3,
          fundingStrategy: strategy,
          fundingPaycheckIndex: target,
          paycheckDate: date
        })
      }
      const monthOwed =
        strategy === 'all_checks'
          ? slots.reduce(
              (total, _) => total + reservePerPaycheckCents(120_000, 'monthly', cadence),
              0
            )
          : monthlyEquivalentCents(120_000, 'monthly')
      assert.ok(
        Math.abs(monthTotal - monthOwed) <= slots.length,
        `${cadence}/${strategy} adds up to the month it owes, got ${monthTotal} vs ${monthOwed}`
      )
    }
  }
})

/** A representative date for each guaranteed paycheck slot of the month. */
function dayOfSlot(cadence: PayCadence, slot: number): number {
  if (cadence === 'monthly') return 10
  if (cadence === 'weekly') return slot * 7 - 3
  return slot === 1 ? 5 : 20
}

test('the last check is the final slot every month is guaranteed to have', () => {
  assert.equal(
    fundingCheckIndex({ cadence: 'monthly', dueDay: 10, fundingStrategy: 'last_check' }),
    1,
    'a monthly payday has one check, which is both first and last'
  )
  assert.equal(
    fundingCheckIndex({ cadence: 'semimonthly', dueDay: 10, fundingStrategy: 'last_check' }),
    2
  )
  assert.equal(
    fundingCheckIndex({ cadence: 'biweekly', dueDay: 10, fundingStrategy: 'last_check' }),
    2,
    'a third biweekly check exists in some months only, so it can never carry a bill'
  )
  assert.equal(
    fundingCheckIndex({ cadence: 'weekly', dueDay: 10, fundingStrategy: 'last_check' }),
    4
  )
})

test('a bill on the last check reserves there and nowhere else', () => {
  const bill = {
    amountCents: 120_000,
    frequency: 'monthly' as const,
    cadence: 'biweekly' as const,
    dueDay: 28,
    fundingStrategy: 'last_check' as const
  }
  assert.equal(billFundingReserveCents({ ...bill, paycheckDate: '2026-03-05' }), 0)
  assert.equal(billFundingReserveCents({ ...bill, paycheckDate: '2026-03-19' }), 120_000)
  assert.equal(
    billFundingReserveCents({ ...bill, paycheckDate: '2026-03-31' }),
    reservePerPaycheckCents(120_000, 'monthly', 'biweekly'),
    'without a payday anchor a third check carries the spread, never nothing'
  )

  // With an anchor the third October check is genuinely extra: the two
  // guaranteed slots already carried the month.
  assert.equal(
    billFundingReserveCents({
      ...bill,
      paycheckDate: '2026-10-16',
      payAnchorDate: '2026-10-02'
    }),
    120_000
  )
  assert.equal(
    billFundingReserveCents({
      ...bill,
      paycheckDate: '2026-10-30',
      payAnchorDate: '2026-10-02'
    }),
    0,
    'the optional third check neither funds nor double-pays'
  )
})

test('without a paycheck date the reserve falls back to the spread, never the clock', () => {
  const input = {
    amountCents: 120_000,
    frequency: 'monthly' as const,
    cadence: 'biweekly' as const,
    dueDay: 1,
    fundingStrategy: 'first_check' as const
  }
  assert.equal(billFundingReserveCents(input), reservePerPaycheckCents(120_000, 'monthly', 'biweekly'))
  assert.equal(
    billFundingReserveCents({ ...input, paycheckDate: null }),
    billFundingReserveCents({ ...input, paycheckDate: null }),
    'the same call twice gives the same number'
  )
})

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  bpsToCents,
  centsToBps,
  distributeCents,
  formatBps,
  parsePercentToBps,
  resolveSplitShares,
  restOnLine,
  splitEvenly,
  splitTotalBalance,
  splitTotalProblem
} from './splitTotal'

const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0)

test('$500 split evenly three ways is 166.67, 166.67, 166.66 and says which line gave a cent', () => {
  const even = splitEvenly(500_00, 3)
  assert.deepEqual(even.cents, [166_67, 166_67, 166_66])
  assert.equal(sum(even.cents), 500_00)
  assert.deepEqual(even.adjustments, [{ index: 2, deltaCents: -1 }])
})

test('an even split that divides cleanly needs no adjustment', () => {
  assert.deepEqual(splitEvenly(300_00, 3), { cents: [100_00, 100_00, 100_00], adjustments: [] })
  assert.deepEqual(splitEvenly(0, 3).cents, [0, 0, 0])
  assert.deepEqual(splitEvenly(10_00, 0).cents, [])
})

test('even splits always add up to the total to the cent', () => {
  for (const total of [1, 2, 99, 100_01, 500_00, 1_234_567]) {
    for (let lines = 1; lines <= 20; lines += 1) {
      const { cents } = splitEvenly(total, lines)
      assert.equal(sum(cents), total, `${total} over ${lines}`)
      assert.ok(Math.max(...cents) - Math.min(...cents) <= 1)
    }
  }
})

test('weights share leftover cents by largest remainder, ties to the earlier line', () => {
  // 10¢ by 1:1:1 → 3.33 each; the one spare cent goes to the first line.
  assert.deepEqual(distributeCents(10, [1, 1, 1]).cents, [4, 3, 3])
  // 10¢ by 1:2 → 3.33 and 6.67; the bigger remainder takes the cent.
  assert.deepEqual(distributeCents(10, [1, 2]).cents, [3, 7])
  assert.deepEqual(distributeCents(10, [0, 0]).cents, [0, 0])
})

test('percents that add up to 100% land exactly on the total', () => {
  const thirds = resolveSplitShares(500_00, [
    { kind: 'bps', bps: 33_33 },
    { kind: 'bps', bps: 33_33 },
    { kind: 'bps', bps: 33_34 }
  ])
  assert.deepEqual(thirds.cents, [166_65, 166_65, 166_70])
  assert.equal(sum(thirds.cents), 500_00)

  // A tiny total is where plain rounding would lose a cent: 3 + 3 + 3 = 9.
  const tiny = resolveSplitShares(10, [
    { kind: 'bps', bps: 33_33 },
    { kind: 'bps', bps: 33_33 },
    { kind: 'bps', bps: 33_34 }
  ])
  assert.equal(sum(tiny.cents), 10)
  assert.deepEqual(tiny.adjustments, [{ index: 2, deltaCents: 1 }], "the largest share takes the spare cent")

  for (const total of [1, 7, 99, 12_345, 500_00, 987_654_32]) {
    const shares = [12_50, 37_50, 17_17, 32_83].map((bps) => ({ kind: 'bps' as const, bps }))
    assert.equal(sum(resolveSplitShares(total, shares).cents), total, `total ${total}`)
  }
})

test('amount lines keep their cents beside percent lines', () => {
  const mixed = resolveSplitShares(500_00, [
    { kind: 'cents', cents: 100_00 },
    { kind: 'bps', bps: 40_00 },
    { kind: 'bps', bps: 40_00 }
  ])
  assert.deepEqual(mixed.cents, [100_00, 200_00, 200_00])
  // Percent lines follow the total when it changes; amount lines do not.
  assert.deepEqual(
    resolveSplitShares(600_00, [
      { kind: 'cents', cents: 100_00 },
      { kind: 'bps', bps: 50_00 }
    ]).cents,
    [100_00, 300_00]
  )
})

test('the balance and the problem tell under from over from exact', () => {
  assert.deepEqual(splitTotalBalance(500_00, [200_00, 250_00]), { allocatedCents: 450_00, leftCents: 50_00 })
  assert.deepEqual(splitTotalBalance(500_00, [300_00, 250_00]), { allocatedCents: 550_00, leftCents: -50_00 })
  assert.equal(splitTotalProblem(500_00, [200_00, 250_00]), '$50.00 is still to place')
  assert.equal(splitTotalProblem(500_00, [300_00, 250_00]), 'The lines are $50.00 over the total')
  assert.equal(splitTotalProblem(500_00, [166_67, 166_67, 166_66]), null)
  assert.equal(splitTotalProblem(0, [10_00]), 'Enter the total to move')
  assert.equal(splitTotalProblem(500_00, [500_00, 1]), 'The lines are $0.01 over the total')
})

test('the rest goes on one line, and an over total comes off it', () => {
  assert.equal(restOnLine(500_00, [200_00, 100_00, 0], 2), 200_00)
  assert.equal(restOnLine(500_00, [200_00, 350_00, 0], 1), 300_00)
  assert.equal(restOnLine(500_00, [600_00, 0], 1), 0, 'never below zero')
})

test('percent ↔ cents round in integer cents', () => {
  assert.equal(bpsToCents(500_00, 33_33), 166_65)
  assert.equal(bpsToCents(500_00, 100_00), 500_00)
  assert.equal(centsToBps(500_00, 166_67), 33_33)
  assert.equal(centsToBps(0, 166_67), 0)
})

test('typed percents read like the allocator field, capped at 100%', () => {
  assert.equal(parsePercentToBps('33.33'), 33_33)
  assert.equal(parsePercentToBps('12,5'), 12_50)
  assert.equal(parsePercentToBps('40%'), 40_00)
  assert.equal(parsePercentToBps('250'), 100_00)
  assert.equal(parsePercentToBps(''), null)
  assert.equal(parsePercentToBps('.'), null)
  assert.equal(formatBps(33_33), '33.33')
  assert.equal(formatBps(12_50), '12.5')
  assert.equal(formatBps(50_00), '50')
  assert.equal(formatBps(5), '0.05')
})

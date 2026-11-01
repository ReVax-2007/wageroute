import assert from 'node:assert/strict'
import test from 'node:test'
import type { Account, BalanceSnapshot } from './types'
import { netWorthSeries } from './history'

const TS = '2026-01-01T00:00:00.000Z'

function account(id: string): Account {
  return { id } as Account
}

function snapshot(accountId: string, onDate: string, balanceCents: number): BalanceSnapshot {
  return { id: `${accountId}:${onDate}`, accountId, onDate, balanceCents, createdAt: TS } as BalanceSnapshot
}

test('a quiet day carries the last known balance forward instead of dropping out', () => {
  const points = netWorthSeries({
    snapshots: [
      snapshot('a', '2026-10-01', 100_000),
      snapshot('b', '2026-10-01', 25_000),
      snapshot('a', '2026-10-04', 80_000)
    ],
    accounts: [account('a'), account('b')],
    untilISO: '2026-10-05'
  })

  assert.deepEqual(
    points.map((point) => [point.onDate, point.netWorthCents]),
    [
      ['2026-10-01', 125_000],
      ['2026-10-02', 125_000],
      ['2026-10-03', 125_000],
      ['2026-10-04', 105_000],
      ['2026-10-05', 105_000]
    ]
  )
})

test('an account only counts from the day it was first seen', () => {
  const points = netWorthSeries({
    snapshots: [snapshot('a', '2026-10-01', 50_000), snapshot('b', '2026-10-03', 10_000)],
    accounts: [account('a'), account('b')],
    untilISO: '2026-10-03'
  })
  assert.deepEqual(
    points.map((point) => [point.onDate, point.netWorthCents, point.accountCount]),
    [
      ['2026-10-01', 50_000, 1],
      ['2026-10-02', 50_000, 1],
      ['2026-10-03', 60_000, 2]
    ]
  )
})

test('snapshots for accounts the caller left out are ignored', () => {
  const points = netWorthSeries({
    snapshots: [snapshot('a', '2026-10-01', 50_000), snapshot('archived', '2026-10-02', 999_999)],
    accounts: [account('a')],
    untilISO: '2026-10-02'
  })
  assert.deepEqual(
    points.map((point) => [point.onDate, point.netWorthCents]),
    [
      ['2026-10-01', 50_000],
      ['2026-10-02', 50_000]
    ]
  )
})

test('no snapshots is an empty series, not a fake flat line', () => {
  assert.deepEqual(
    netWorthSeries({ snapshots: [], accounts: [account('a')], untilISO: '2026-10-05' }),
    []
  )
})

test('a long history is sampled but the newest day survives exactly', () => {
  const snapshots: BalanceSnapshot[] = []
  for (let day = 0; day < 120; day += 1) {
    const iso = new Date(Date.UTC(2026, 0, 1 + day)).toISOString().slice(0, 10)
    snapshots.push(snapshot('a', iso, 100_000 + day))
  }
  const last = snapshots[snapshots.length - 1].onDate
  const points = netWorthSeries({
    snapshots,
    accounts: [account('a')],
    untilISO: last,
    maxPoints: 30
  })

  assert.ok(points.length <= 31, 'the cap is respected with the occasional extra point')
  const newest = points[points.length - 1]
  assert.equal(newest.onDate, last)
  assert.equal(newest.netWorthCents, 100_119, 'the last point is the real balance')
})

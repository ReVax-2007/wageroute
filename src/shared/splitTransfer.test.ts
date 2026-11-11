import assert from 'node:assert/strict'
import test from 'node:test'
import { RepositoryError } from './errors'
import {
  SPLIT_TRANSFER_MAX_LINES,
  planSplitTransfer,
  splitTransferProblem,
  splitTransferSizes,
  splitTransferTotalCents,
  summarizeSplit,
  type SplitAccount
} from './splitTransfer'
import type { SplitTransferInput } from './types'
import { CREDIT_CARD_SOURCE_REFUSAL } from './writeRules'

const ACCOUNTS: Record<string, SplitAccount> = {
  a1: { kind: 'checking', name: 'Bank A chequing' },
  b1: { kind: 'checking', name: 'Bank B chequing' },
  b2: { kind: 'savings', name: 'Bank B savings' },
  b3: { kind: 'savings', name: 'Bank B travel' },
  visa: { kind: 'credit', name: 'Visa' }
}
const lookup = (id: string): SplitAccount | undefined => ACCOUNTS[id]

function split(overrides: Partial<SplitTransferInput> = {}): SplitTransferInput {
  return {
    sourceAccountId: 'a1',
    viaAccountId: null,
    occurredOn: '2026-11-10',
    lines: [
      { accountId: 'b1', amountCents: 100_00 },
      { accountId: 'b2', amountCents: 250_50 },
      { accountId: 'b3', amountCents: 75_25 }
    ],
    ...overrides
  }
}

test('the total is every line added up in integer cents', () => {
  assert.equal(splitTransferTotalCents(split().lines), 425_75)
  // A blank or half-typed line adds nothing rather than poisoning the sum.
  assert.equal(
    splitTransferTotalCents([
      { accountId: 'b1', amountCents: 10 },
      { accountId: 'b2', amountCents: 0 },
      { accountId: 'b3', amountCents: Number.NaN },
      { accountId: 'b3', amountCents: -5 }
    ]),
    10
  )
})

test('without a via account each line is one transfer from the source', () => {
  const plan = planSplitTransfer(split(), lookup)
  assert.deepEqual(
    plan.map((t) => [t.accountId, t.counterAccountId, t.amountCents, t.kind]),
    [
      ['a1', 'b1', 100_00, 'transfer'],
      ['a1', 'b2', 250_50, 'transfer'],
      ['a1', 'b3', 75_25, 'transfer']
    ]
  )
  assert.equal(plan[0].category, 'Transfer', 'a blank category files the line under Transfer')
  assert.equal(plan[0].memo, 'Transfer to Bank B chequing')
  assert.ok(plan.every((t) => t.occurredOn === '2026-11-10'))
})

test('through a via account the total lands there first and the rest moves on', () => {
  const plan = planSplitTransfer(
    split({
      viaAccountId: 'b1',
      lines: [
        { accountId: 'b1', amountCents: 100_00, category: 'Spending', memo: 'Monthly move' },
        { accountId: 'b2', amountCents: 250_50, category: 'Savings', categoryId: 'cat-sav' },
        { accountId: 'b3', amountCents: 75_25, memo: 'Trip' }
      ]
    }),
    lookup
  )
  assert.deepEqual(
    plan.map((t) => [t.accountId, t.counterAccountId, t.amountCents]),
    [
      ['a1', 'b1', 425_75],
      ['b1', 'b2', 250_50],
      ['b1', 'b3', 75_25]
    ]
  )
  // The share that stays lends the first leg its label.
  assert.equal(plan[0].category, 'Spending')
  assert.equal(plan[0].memo, 'Monthly move')
  assert.deepEqual([plan[1].category, plan[1].categoryId], ['Savings', 'cat-sav'])
  assert.equal(plan[2].memo, 'Trip')
})

test('a category id never rides without its name', () => {
  const plan = planSplitTransfer(
    split({ lines: [{ accountId: 'b1', amountCents: 5_00, category: '  ', categoryId: 'stale' }] }),
    lookup
  )
  assert.deepEqual([plan[0].category, plan[0].categoryId], ['Transfer', null])
})

test('the refusals name what is wrong', () => {
  const cases: [Partial<SplitTransferInput>, string | RegExp][] = [
    [{ sourceAccountId: '' }, 'Choose the account the money leaves from'],
    [{ sourceAccountId: 'visa' }, CREDIT_CARD_SOURCE_REFUSAL],
    [{ viaAccountId: 'visa' }, CREDIT_CARD_SOURCE_REFUSAL],
    [{ viaAccountId: 'a1' }, /different account than it leaves/],
    [{ sourceAccountId: 'gone' }, 'Account not found'],
    [{ lines: [] }, /at least one account/],
    [{ lines: [{ accountId: '', amountCents: 5 }] }, 'Choose an account on every line'],
    [{ lines: [{ accountId: 'a1', amountCents: 5 }] }, /back to the account it leaves/],
    [
      {
        lines: [
          { accountId: 'b1', amountCents: 5 },
          { accountId: 'b1', amountCents: 6 }
        ]
      },
      'Each account can appear on one line only'
    ],
    [{ lines: [{ accountId: 'b1', amountCents: 0 }] }, 'Enter an amount on every line'],
    [{ lines: [{ accountId: 'b1', amountCents: 1.5 }] }, 'Enter an amount on every line'],
    [
      {
        lines: Array.from({ length: SPLIT_TRANSFER_MAX_LINES + 1 }, () => ({
          accountId: 'b1',
          amountCents: 1
        }))
      },
      /at most/
    ]
  ]
  for (const [overrides, expected] of cases) {
    const problem = splitTransferProblem(split(overrides), lookup)
    if (typeof expected === 'string') assert.equal(problem, expected, JSON.stringify(overrides))
    else assert.match(problem ?? '', expected, JSON.stringify(overrides))
    assert.throws(
      () => planSplitTransfer(split(overrides), lookup),
      (error: unknown) => error instanceof RepositoryError && error.code === 'VALIDATION'
    )
  }
})

test('paying a card is a line like any other', () => {
  const plan = planSplitTransfer(
    split({ lines: [{ accountId: 'visa', amountCents: 300_00 }] }),
    lookup
  )
  assert.deepEqual([plan[0].accountId, plan[0].counterAccountId], ['a1', 'visa'])
  assert.equal(splitTransferProblem(split(), lookup), null)
})

test('a split reads back as its source, its accounts and what left the source', () => {
  const leg = (accountId: string, amountCents: number, pair: string) => ({
    accountId,
    amountCents,
    transferGroupId: pair,
    splitGroupId: 'split-1'
  })
  // Through b1: a1 → b1 for the total, then b1 → b2 and b1 → b3.
  const legs = [
    leg('a1', -150_00, 'p1'),
    leg('b1', 150_00, 'p1'),
    leg('b1', -100_00, 'p2'),
    leg('b2', 100_00, 'p2'),
    leg('b1', -25_00, 'p3'),
    leg('b3', 25_00, 'p3')
  ]
  assert.deepEqual(summarizeSplit(legs), {
    sourceAccountId: 'a1',
    destinationIds: ['b1', 'b2', 'b3'],
    totalCents: 150_00
  })
  assert.equal(splitTransferSizes(legs).get('split-1'), 3)
  assert.equal(splitTransferSizes([{ ...legs[0], splitGroupId: null }]).size, 0)
})

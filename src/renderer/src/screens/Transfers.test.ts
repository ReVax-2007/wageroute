import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement, act } from 'react'
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true })
const { window } = dom

function exposeGlobal(name: string, value: unknown): void {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
}

exposeGlobal('window', window)
exposeGlobal('document', window.document)
exposeGlobal('navigator', window.navigator)
exposeGlobal('HTMLElement', window.HTMLElement)
exposeGlobal('HTMLInputElement', window.HTMLInputElement)
exposeGlobal('HTMLSelectElement', window.HTMLSelectElement)
exposeGlobal('Element', window.Element)
exposeGlobal('Node', window.Node)
exposeGlobal('Event', window.Event)
exposeGlobal('KeyboardEvent', window.KeyboardEvent)
exposeGlobal('MouseEvent', window.MouseEvent)
exposeGlobal('getComputedStyle', window.getComputedStyle.bind(window))
exposeGlobal('requestAnimationFrame', window.requestAnimationFrame.bind(window))
exposeGlobal('cancelAnimationFrame', window.cancelAnimationFrame.bind(window))
exposeGlobal('IS_REACT_ACT_ENVIRONMENT', true)
window.HTMLElement.prototype.getClientRects = () =>
  [{ width: 1, height: 1, top: 0, left: 0, bottom: 1, right: 1, x: 0, y: 0 }] as unknown as DOMRectList

const ACCOUNT_1 = {
  id: 'acc-chequing',
  userId: 'user-1',
  name: 'Chequing',
  kind: 'checking' as const,
  institution: 'Bank A',
  startingBalanceCents: 245000,
  creditLimitCents: null,
  color: null,
  dedicatedGoalId: null,
  inSafeToSpend: null,
  isArchived: false,
  sortOrder: 0,
  aprBps: null,
  minimumPaymentCents: null,
  statementDay: null,
  paymentDueDay: null,
  lastStatementBalanceCents: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  deletedAt: null,
  revision: 1,
  balanceCents: 245000,
  cashCents: 245000
}

const ACCOUNT_2 = {
  id: 'acc-savings',
  userId: 'user-1',
  name: 'High Interest Savings',
  kind: 'savings' as const,
  institution: 'Bank B',
  startingBalanceCents: 1000000,
  creditLimitCents: null,
  color: null,
  dedicatedGoalId: null,
  inSafeToSpend: null,
  isArchived: false,
  sortOrder: 1,
  aprBps: null,
  minimumPaymentCents: null,
  statementDay: null,
  paymentDueDay: null,
  lastStatementBalanceCents: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  deletedAt: null,
  revision: 1,
  balanceCents: 1000000,
  cashCents: 1000000
}

function makeSnapshot(accounts = [ACCOUNT_1, ACCOUNT_2]) {
  return {
    user: {
      id: 'user-1',
      email: null,
      displayName: 'Tester',
      currency: 'USD',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      deletedAt: null,
      revision: 1
    },
    settings: {},
    accounts,
    bills: [],
    goals: [],
    categories: [],
    transactions: 2,
    transactionTotal: 2,
    billPaymentsThisMonth: [],
    billPayments: [],
    paychecks: [],
    paycheckTotal: 0,
    billReserves: [],
    balanceSnapshots: []
  }
}

test('Transfers screen requires at least two accounts', async () => {
  const { useFinanceStore } = await import('../store/useFinanceStore')
  const { parseSettings } = await import('@shared/settings')
  const { Transfers } = await import('./Transfers')
  const { createRoot } = await import('react-dom/client')

  useFinanceStore.setState({
    snapshot: makeSnapshot([ACCOUNT_1]) as never,
    settings: parseSettings({ currency: 'USD' }),
    queryTransactions: async () => ({ rows: [], total: 0 })
  })

  const host = window.document.createElement('div')
  window.document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(createElement(Transfers))
  })

  assert.match(host.textContent ?? '', /Need at least two accounts/)
  root.unmount()
  host.remove()
})

test('Transfers screen mounts with accounts and records a transfer in one step', async () => {
  const { useFinanceStore } = await import('../store/useFinanceStore')
  const { parseSettings } = await import('@shared/settings')
  const { Transfers } = await import('./Transfers')
  const { createRoot } = await import('react-dom/client')

  const createdTransactions: unknown[] = []

  useFinanceStore.setState({
    snapshot: makeSnapshot([ACCOUNT_1, ACCOUNT_2]) as never,
    settings: parseSettings({ currency: 'USD' }),
    createTransaction: async (input) => {
      createdTransactions.push(input)
      return true
    },
    queryTransactions: async () => ({
      rows: [
        {
          id: 'tx-1',
          userId: 'user-1',
          accountId: ACCOUNT_1.id,
          counterAccountId: ACCOUNT_2.id,
          transferGroupId: 'grp-1',
          kind: 'transfer',
          amountCents: -5000,
          occurredOn: '2026-11-04',
          memo: 'Savings boost',
          category: 'Transfer',
          categoryId: null,
          externalId: null,
          billId: null,
          goalId: null,
          paycheckId: null,
          createdAt: '2026-11-04T00:00:00.000Z',
          updatedAt: '2026-11-04T00:00:00.000Z',
          deletedAt: null,
          revision: 1,
          accountName: ACCOUNT_1.name,
          accountInstitution: ACCOUNT_1.institution,
          billName: null,
          goalName: null
        }
      ],
      total: 1
    })
  })

  const host = window.document.createElement('div')
  window.document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(createElement(Transfers))
  })

  assert.match(host.textContent ?? '', /New transfer/)
  assert.match(host.textContent ?? '', /Chequing/)
  assert.match(host.textContent ?? '', /High Interest Savings/)
  assert.match(host.textContent ?? '', /Savings boost/)

  assert.match(host.textContent ?? '', /Transfer · Savings boost/, 'a recent transfer shows its category')

  // Label it the way the person files these
  const categoryBox = host.querySelector<HTMLInputElement>('input[list="transfer-category-options"]')
  assert.ok(categoryBox, 'the transfer form has a category box')
  assert.equal(categoryBox.value, 'Transfer')
  await act(async () => {
    const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
    setValue.call(categoryBox, 'Round-up')
    categoryBox.dispatchEvent(new window.Event('input', { bubbles: true }))
  })

  // Click quick add +$50 chip
  const quick50 = [...host.querySelectorAll('button')].find(
    (el) => el.textContent?.trim() === '+$50'
  )
  assert.ok(quick50, 'Quick $50 button exists')
  await act(async () => {
    quick50.click()
  })

  // Submit transfer button
  const submitBtn = [...host.querySelectorAll('button')].find(
    (el) => el.textContent?.includes('Transfer') && el.textContent?.includes('50')
  )
  assert.ok(submitBtn, 'Submit transfer button is active with amount')

  await act(async () => {
    submitBtn.click()
  })

  assert.equal(createdTransactions.length, 1)
  const recorded = createdTransactions[0] as {
    accountId: string
    counterAccountId: string
    kind: string
    amountCents: number
    category: string
    categoryId: string | null
  }
  assert.equal(recorded.accountId, ACCOUNT_1.id)
  assert.equal(recorded.counterAccountId, ACCOUNT_2.id)
  assert.equal(recorded.kind, 'transfer')
  assert.equal(recorded.amountCents, 5000)
  assert.equal(recorded.category, 'Round-up')
  assert.equal(recorded.categoryId, null, 'a new name has no row yet; the ledger makes one')

  root.unmount()
  host.remove()
})

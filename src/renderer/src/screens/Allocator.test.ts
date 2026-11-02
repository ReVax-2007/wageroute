import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement, act } from 'react'
import { JSDOM } from 'jsdom'

// The allocator writes settings and a paycheck as one action from the user's
// point of view, so the failure path is checked against a real DOM: a split
// that could not be saved must not leave a routed paycheck behind.
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

const ACCOUNT = {
  id: 'acc-chequing',
  userId: 'user-1',
  name: 'Chequing',
  kind: 'checking' as const,
  institution: null,
  startingBalanceCents: 0,
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
  balanceCents: 0,
  cashCents: 0
}

function snapshot() {
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
    accounts: [ACCOUNT],
    bills: [],
    goals: [],
    categories: [],
    transactions: [],
    transactionTotal: 0,
    billPaymentsThisMonth: [],
    billPayments: [],
    paychecks: [],
    paycheckTotal: 0,
    billReserves: [],
    balanceSnapshots: []
  }
}

async function mount() {
  const { useFinanceStore } = await import('../store/useFinanceStore')
  const { parseSettings } = await import('@shared/settings')
  const { Allocator } = await import('./Allocator')
  const { createRoot } = await import('react-dom/client')

  const commits: unknown[] = []
  useFinanceStore.setState({
    allocatorOpen: true,
    snapshot: snapshot() as never,
    settings: parseSettings({}),
    busy: false,
    saveSettings: async () => false,
    commitPaycheck: async (input) => {
      commits.push(input)
      return true
    }
  })

  const host = window.document.createElement('div')
  window.document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(createElement(Allocator))
  })

  const button = (label: string) =>
    [...host.querySelectorAll('button')].find(
      (element) => element.textContent?.trim() === label
    ) as HTMLButtonElement | undefined
  const routeButton = () =>
    [...host.querySelectorAll('button')].find((element) =>
      element.textContent?.trim().startsWith('Route ')
    ) as HTMLButtonElement | undefined

  const enterIncome = async (value: string): Promise<void> => {
    const input = host.querySelector('.income-input') as HTMLInputElement
    const setValue = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value'
    )?.set
    await act(async () => {
      setValue?.call(input, value)
      input.dispatchEvent(new window.Event('input', { bubbles: true }))
    })
  }

  return { host, button, routeButton, enterIncome, commits, root, useFinanceStore }
}

test('a split that cannot be saved stops the paycheck instead of routing it anyway', async () => {
  const { host, button, routeButton, enterIncome, commits } = await mount()

  await enterIncome('5000')
  await act(async () => {
    button('Subtract the wall')?.click()
  })
  await act(async () => {
    button('Distribute the surplus')?.click()
  })

  const route = routeButton()
  assert.ok(route, 'the final step offers the route action')
  await act(async () => {
    route.click()
  })

  assert.equal(commits.length, 0, 'no paycheck is written when the split was not saved')
  assert.match(
    host.querySelector('[role="alert"]')?.textContent ?? '',
    /not routed — this split could not be saved/
  )
})

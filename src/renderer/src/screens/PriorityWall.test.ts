import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement, act } from 'react'
import { JSDOM } from 'jsdom'
import { todayISO } from '@shared/dates'

// The wall speaks for money the user cannot touch, so its chips are checked
// against a real DOM: one paid instalment must not make a month read "paid"
// while another cheque's claim is still reserved.
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

const TS = '2026-01-01T00:00:00.000Z'
const BILL_ID = 'bill-rent'
const MONTH = todayISO().slice(0, 7)

function bill() {
  return {
    id: BILL_ID,
    userId: 'user-1',
    name: 'Rent',
    amountCents: 120_000,
    frequency: 'monthly' as const,
    dueDay: 15,
    category: 'Housing',
    accountId: 'acc-chequing',
    autopay: false,
    isActive: true,
    nextDueOn: null,
    fundingStrategy: 'all_checks' as const,
    fundingPaycheckIndex: null,
    createdAt: TS,
    updatedAt: TS,
    deletedAt: null,
    revision: 1
  }
}

function reserve(state: 'paid' | 'reserved', amountCents: number) {
  return {
    id: `res-${state}-${amountCents}`,
    userId: 'user-1',
    billId: BILL_ID,
    paycheckId: 'pay-1',
    cycle: MONTH,
    amountCents,
    state,
    strategy: 'all_checks' as const,
    dueDay: 15,
    settledBy: state === 'paid' ? 'tx-1' : null,
    createdAt: TS,
    updatedAt: TS,
    deletedAt: null,
    revision: 1
  }
}

function snapshot(reserves: ReturnType<typeof reserve>[], paidCents = 0) {
  return {
    user: null,
    settings: {},
    accounts: [],
    bills: [bill()],
    goals: [],
    categories: [],
    transactions: [],
    transactionTotal: 0,
    billPaymentsThisMonth: paidCents > 0 ? [{ billId: BILL_ID, paidCents, creditCents: 0 }] : [],
    billPayments: [],
    paychecks: [],
    paycheckTotal: 0,
    billReserves: reserves,
    balanceSnapshots: []
  }
}

async function mount(
  reserves: ReturnType<typeof reserve>[],
  paidCents = 0,
  billPatch: Partial<ReturnType<typeof bill>> = {}
) {
  const { useFinanceStore } = await import('../store/useFinanceStore')
  const { parseSettings } = await import('@shared/settings')
  const { PriorityWall } = await import('./PriorityWall')
  const { createRoot } = await import('react-dom/client')

  useFinanceStore.setState({
    snapshot: {
      ...snapshot(reserves, paidCents),
      bills: [{ ...bill(), ...billPatch }]
    } as never,
    // The anchor makes the next check land today, so the month under test is
    // the month the wall reads its claims from.
    settings: parseSettings({
      payCadence: 'biweekly',
      payAnchorDate: todayISO()
    }),
    busy: false
  })

  const host = window.document.createElement('div')
  window.document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(createElement(PriorityWall))
  })
  return { host, root }
}

function wallText(host: HTMLElement): string {
  const row = [...host.querySelectorAll('tbody tr')].find((tr) =>
    tr.textContent?.includes('Rent')
  )
  return row?.textContent ?? ''
}

test('one paid instalment does not make an open month read paid', async () => {
  const { host, root } = await mount([reserve('paid', 60_000), reserve('reserved', 60_000)], 60_000)
  assert.equal(
    host.querySelectorAll('tbody').length,
    1,
    'DataTable owns the body; a nested tbody is invalid markup'
  )
  const text = wallText(host)
  assert.match(text, /Reserved this month/, 'money is still set aside for the month')
  assert.doesNotMatch(text, /Paid this month/)
  assert.match(
    host.textContent ?? '',
    /\$600\.00 reserved this month · \$600\.00 paid/,
    'the hint reports both sums rather than folding paid into reserved'
  )
  await act(async () => root.unmount())
})

test('a month with nothing open reads paid', async () => {
  const { host, root } = await mount([reserve('paid', 120_000)], 120_000)
  const text = wallText(host)
  assert.match(text, /Paid this month/)
  assert.doesNotMatch(text, /Reserved this month/)
  await act(async () => root.unmount())
})

test('the next check keeps only what the month still owes', async () => {
  const { host, root } = await mount([reserve('reserved', 30_000)], 60_000)
  const row = [...host.querySelectorAll('tbody tr')].find((tr) =>
    tr.textContent?.includes('Rent')
  )
  const cells = [...(row?.querySelectorAll('td') ?? [])]
  assert.equal(
    cells[1]?.textContent?.trim(),
    '$300.00',
    'a $600 cash payment and a $300 claim leave $300 for the next check'
  )
  await act(async () => root.unmount())
})

test('a bill already covered this month asks for nothing', async () => {
  const { host, root } = await mount([reserve('paid', 120_000)], 120_000)
  const row = [...host.querySelectorAll('tbody tr')].find((tr) =>
    tr.textContent?.includes('Rent')
  )
  const cells = [...(row?.querySelectorAll('td') ?? [])]
  assert.match(cells[1]?.textContent ?? '', /^\$0\.00/, 'the next check has nothing left to do')
  assert.match(cells[1]?.textContent ?? '', /Nothing more due/)
  assert.doesNotMatch(cells[1]?.textContent ?? '', /check of the month/)
  await act(async () => root.unmount())
})

test('a paused bill reserves nothing on the next check', async () => {
  const { host, root } = await mount([], 0, { isActive: false })
  const row = [...host.querySelectorAll('tbody tr')].find((tr) =>
    tr.textContent?.includes('Rent')
  )
  const cells = [...(row?.querySelectorAll('td') ?? [])]
  assert.match(cells[1]?.textContent ?? '', /^\$0\.00/)
  assert.match(cells[1]?.textContent ?? '', /Paused/)
  await act(async () => root.unmount())
})

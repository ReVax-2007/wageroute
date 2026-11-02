import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement, act } from 'react'
import { JSDOM } from 'jsdom'
import { addDaysISO, addMonthsISO, formatMonthLong, todayISO } from '@shared/dates'
import { dueBillPrompts } from '@shared/billPrompts'
import type { Snapshot, TransactionInput } from '@shared/types'

// The prompt row is a form: whether a date control appears and which date it
// posts are DOM behaviour, so it runs against a real DOM.
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

const NOW = new Date()
const TODAY = todayISO(NOW)

// A quarterly series anchored four months back has its latest occurrence a
// month or so ago: always an earlier month, whatever day the suite runs on.
const LATE_ANCHOR = addMonthsISO(TODAY, -4)

function bill(
  id: string,
  name: string,
  nextDueOn: string,
  frequency: Snapshot['bills'][number]['frequency'] = 'quarterly',
  dueDay = 15
): Snapshot['bills'][number] {
  return {
    id,
    userId: 'u1',
    name,
    amountCents: 5_000,
    frequency,
    dueDay,
    category: 'Housing',
    accountId: 'a1',
    autopay: false,
    isActive: true,
    nextDueOn,
    fundingStrategy: 'closest_due_date',
    fundingPaycheckIndex: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    deletedAt: null,
    revision: 1
  } as Snapshot['bills'][number]
}

function snapshotWith(bills: Snapshot['bills']): Snapshot {
  return {
    user: { id: 'u1', displayName: 'Tester' },
    settings: {},
    accounts: [
      {
        id: 'a1',
        userId: 'u1',
        name: 'Chequing',
        kind: 'checking',
        isArchived: false
      }
    ],
    bills,
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
  } as unknown as Snapshot
}

function typeInto(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
  assert.ok(setter, 'jsdom exposes the native value setter')
  setter.call(input, value)
  input.dispatchEvent(new window.Event('input', { bubbles: true }))
}

async function mount(
  snapshot: Snapshot,
  sent: TransactionInput[]
): Promise<{ unmount: () => void }> {
  const { createRoot } = await import('react-dom/client')
  const { useFinanceStore } = await import('../store/useFinanceStore')
  const { BillPrompts } = await import('./BillPrompts')
  useFinanceStore.setState({
    snapshot,
    snoozedPrompts: [],
    pending: {},
    createTransaction: async (input) => {
      sent.push(input)
      return true
    }
  })

  const container = window.document.createElement('div')
  window.document.body.append(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(createElement(BillPrompts))
  })
  return {
    unmount: () => {
      act(() => root.unmount())
      container.remove()
    }
  }
}

test('a bill from an earlier month asks when it left and posts that date', async () => {
  const sent: TransactionInput[] = []
  const bills = [bill('late', 'Water', LATE_ANCHOR)]
  const expectedDue = dueBillPrompts({ bills, payments: [], todayISO: TODAY })[0].dueOn
  assert.notEqual(expectedDue.slice(0, 7), TODAY.slice(0, 7), 'the fixture is from another month')

  const mounted = await mount(snapshotWith(bills), sent)
  try {
    const row = window.document.querySelector('.prompt-row')
    assert.ok(row, 'the past-due bill is shown')
    const date = row.querySelector('input[type="date"]') as HTMLInputElement | null
    assert.ok(date, 'a prompt from an earlier month asks for the real date')
    assert.equal(date.value, expectedDue, 'it starts on the due date')
    assert.equal(date.max, TODAY, 'a payment cannot be dated in the future')

    await act(async () => typeInto(date, TODAY))
    assert.match(window.document.body.textContent ?? '', new RegExp(`Counts in ${formatMonthLong(TODAY)}`))

    const confirm = [...row.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Yes, it cleared'
    ) as HTMLButtonElement
    await act(async () => confirm.click())

    assert.equal(sent.length, 1)
    assert.equal(sent[0].occurredOn, TODAY, 'the chosen date is the one posted')
    assert.equal(sent[0].billId, 'late')
    assert.equal(sent[0].accountId, 'a1')
    assert.equal(sent[0].amountCents, -5_000)
  } finally {
    mounted.unmount()
  }
})

test('a bill due this month posts its due date without asking', async () => {
  // On the 1st there is no earlier day in the current month, so the case does
  // not exist that day; every other day exercises the row that hides the input.
  if (NOW.getDate() === 1) return
  const sent: TransactionInput[] = []
  const due = addDaysISO(TODAY, -1)
  const bills = [bill('recent', 'Internet', due, 'monthly', Number(due.slice(8, 10)))]
  const mounted = await mount(snapshotWith(bills), sent)
  try {
    const row = window.document.querySelector('.prompt-row')
    assert.ok(row)
    assert.equal(row.querySelector('input[type="date"]'), null, 'no date question for this month')

    const confirm = [...row.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Yes, it cleared'
    ) as HTMLButtonElement
    await act(async () => confirm.click())

    assert.equal(sent.length, 1)
    assert.equal(sent[0].occurredOn, due)
  } finally {
    mounted.unmount()
  }
})

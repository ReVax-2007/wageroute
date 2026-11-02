import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement, act } from 'react'
import { JSDOM } from 'jsdom'
import type { Snapshot, TransactionInput } from '@shared/types'

// Which picker the entry dialog shows, and which link it posts, is DOM
// behaviour, so this runs against a real DOM with a recorder for the write.
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

function snapshot(): Snapshot {
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
    bills: [
      {
        id: 'b1',
        userId: 'u1',
        name: 'Water',
        amountCents: 5_000,
        frequency: 'monthly',
        dueDay: 15,
        category: 'Utilities',
        accountId: 'a1',
        autopay: false,
        isActive: true,
        nextDueOn: null,
        deletedAt: null
      }
    ],
    goals: [
      {
        id: 'g1',
        userId: 'u1',
        name: 'Vacation',
        targetCents: 100_000,
        targetDate: null,
        priority: 100,
        color: '#34D399',
        accountId: null,
        isEmergency: false,
        isArchived: false
      }
    ],
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

function choose(select: HTMLSelectElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set
  assert.ok(setter, 'jsdom exposes the native value setter')
  setter.call(select, value)
  select.dispatchEvent(new window.Event('change', { bubbles: true }))
}

async function mount(
  sent: TransactionInput[],
  closed: { count: number }
): Promise<{ unmount: () => void }> {
  const { createRoot } = await import('react-dom/client')
  const { useFinanceStore } = await import('../../store/useFinanceStore')
  const { EntryDialog } = await import('./EntryDialog')
  useFinanceStore.setState({
    snapshot: snapshot(),
    pending: {},
    createTransaction: async (input: TransactionInput) => {
      sent.push(input)
      return true
    }
  })

  const container = window.document.createElement('div')
  window.document.body.append(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(
      createElement(EntryDialog, {
        onClose: () => {
          closed.count += 1
        }
      })
    )
  })
  return {
    unmount: () => {
      act(() => root.unmount())
      container.remove()
    }
  }
}

function field(label: string): Element | null {
  return (
    [...window.document.querySelectorAll('.field')].find(
      (node) => node.querySelector('.field-label')?.textContent?.trim() === label
    ) ?? null
  )
}

function addButton(): HTMLButtonElement {
  const button = [...window.document.querySelectorAll('button')].find(
    (node) => node.textContent?.trim() === 'Add entry'
  )
  assert.ok(button, 'the dialog offers Add entry')
  return button as HTMLButtonElement
}

test('a bill payment asks for the bill and posts the link', async () => {
  const sent: TransactionInput[] = []
  const closed = { count: 0 }
  const mounted = await mount(sent, closed)
  try {
    const kind = field('Kind')?.querySelector('select') as HTMLSelectElement
    await act(async () => choose(kind, 'bill_payment'))

    const bill = field('Bill')?.querySelector('select') as HTMLSelectElement | null
    assert.ok(bill, 'a bill payment shows a bill picker')
    assert.equal(field('Goal'), null, 'the goal picker belongs to goal funding')

    await act(async () => typeInto(
      window.document.querySelector('input[inputmode="decimal"]') as HTMLInputElement,
      '50'
    ))
    await act(async () => addButton().click())
    assert.match(window.document.body.textContent ?? '', /Choose the bill this payment covers/)
    assert.equal(sent.length, 0)

    // Changing the kind while the dialog is still open drops the link, so a
    // stale bill cannot ride along. Choose the bill first, or the empty value
    // below would prove nothing.
    await act(async () => choose(bill, 'b1'))
    await act(async () => choose(kind, 'expense'))
    assert.equal(field('Bill'), null, 'the picker disappears with the kind')
    await act(async () => choose(kind, 'bill_payment'))
    const cleared = field('Bill')?.querySelector('select') as HTMLSelectElement | null
    assert.ok(cleared, 'the picker returns for the bill-payment kind')
    assert.equal(cleared.value, '', 'the cleared link does not come back with the picker')

    await act(async () => choose(cleared, 'b1'))
    await act(async () => addButton().click())

    assert.equal(sent.length, 1)
    assert.equal(sent[0].kind, 'bill_payment')
    assert.equal(sent[0].billId, 'b1')
    assert.equal(sent[0].goalId, null)
    assert.equal(sent[0].amountCents, -5_000, 'a bill payment is money out')
    assert.equal(closed.count, 1, 'the dialog closes after a successful write')
  } finally {
    mounted.unmount()
  }
})

test('goal funding asks for the goal and posts it', async () => {
  const sent: TransactionInput[] = []
  const closed = { count: 0 }
  const mounted = await mount(sent, closed)
  try {
    const kind = field('Kind')?.querySelector('select') as HTMLSelectElement
    await act(async () => choose(kind, 'goal_funding'))

    const goal = field('Goal')?.querySelector('select') as HTMLSelectElement | null
    assert.ok(goal, 'goal funding shows a goal picker')
    await act(async () => typeInto(
      window.document.querySelector('input[inputmode="decimal"]') as HTMLInputElement,
      '20'
    ))
    await act(async () => choose(goal, 'g1'))
    await act(async () => addButton().click())

    assert.equal(sent.length, 1)
    assert.equal(sent[0].kind, 'goal_funding')
    assert.equal(sent[0].goalId, 'g1')
    assert.equal(sent[0].billId, null)
    assert.equal(sent[0].amountCents, -2_000)
  } finally {
    mounted.unmount()
  }
})

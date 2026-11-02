import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement, act } from 'react'
import { JSDOM } from 'jsdom'

// The dialog is the only place a user sees the imported statement's closing
// balance next to their own, so its figures and both answers are checked
// against a real DOM rather than assumed from the code that fills them in.
const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true })
const { window } = dom

function exposeGlobal(name: string, value: unknown): void {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
}

exposeGlobal('window', window)
exposeGlobal('document', window.document)
exposeGlobal('navigator', window.navigator)
exposeGlobal('HTMLElement', window.HTMLElement)
exposeGlobal('Element', window.Element)
exposeGlobal('Node', window.Node)
exposeGlobal('Event', window.Event)
exposeGlobal('KeyboardEvent', window.KeyboardEvent)
exposeGlobal('MouseEvent', window.MouseEvent)
exposeGlobal('getComputedStyle', window.getComputedStyle.bind(window))
exposeGlobal('requestAnimationFrame', window.requestAnimationFrame.bind(window))
exposeGlobal('cancelAnimationFrame', window.cancelAnimationFrame.bind(window))
exposeGlobal('IS_REACT_ACT_ENVIRONMENT', true)

function visibleRects(): DOMRectList {
  return [{ width: 1, height: 1, top: 0, left: 0, bottom: 1, right: 1, x: 0, y: 0 }] as unknown as DOMRectList
}

window.HTMLElement.prototype.getClientRects = visibleRects

const checkingGap = {
  accountId: '01920000-0000-7000-8000-000000000001',
  accountName: 'Everyday Checking',
  accountKind: 'checking' as const,
  balanceOn: '2026-10-31',
  statementCents: 230000,
  ledgerCents: 225000,
  differenceCents: 5000
}

const cardGap = {
  ...checkingGap,
  accountId: '01920000-0000-7000-8000-000000000002',
  accountName: 'Everyday Card',
  accountKind: 'credit' as const,
  statementCents: -187500,
  ledgerCents: -175000,
  differenceCents: -12500
}

async function mount() {
  const calls: unknown[][] = []
  Object.defineProperty(window, 'api', {
    value: {
      reconcileStatement: async (...args: unknown[]) => {
        calls.push(args)
        return { value: 0, patch: {} }
      }
    },
    configurable: true,
    writable: true
  })

  const { useFinanceStore } = await import('../../store/useFinanceStore')
  const { ReconcileStatementDialog } = await import('./ReconcileStatementDialog')
  const { createRoot } = await import('react-dom/client')

  const host = window.document.createElement('div')
  window.document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(createElement(ReconcileStatementDialog))
  })

  const text = () => host.textContent ?? ''
  const button = (label: string) =>
    [...host.querySelectorAll('button')].find(
      (element) => element.textContent?.trim() === label
    ) as HTMLButtonElement | undefined

  return { useFinanceStore, text, button, calls, root, host }
}

test('the dialog names both balances and the side the ledger is on', async () => {
  const { useFinanceStore, text, button, host } = await mount()

  useFinanceStore.setState({ reconciliation: null })
  assert.equal(text(), '', 'nothing is shown until an import disagrees')

  await act(async () => {
    useFinanceStore.setState({ reconciliation: checkingGap })
  })

  const body = text()
  assert.match(body, /Everyday Checking · closed 2026-10-31/)
  assert.match(body, /The statement closes at \$2,300\.00/)
  assert.match(body, /\$2,250\.00.*on that day, so your ledger is \$50\.00 lower/)
  assert.match(body, /Posting one adjustment dated 2026-10-31/)
  assert.doesNotMatch(body, /negative balance/, 'only a card account gets the sign hint')

  await act(async () => {
    button('Leave it')?.click()
  })
  assert.equal(useFinanceStore.getState().reconciliation, null)
  assert.equal(host.textContent, '')
})

test('a card account reads the debt as negative and posting sends the ledger sign once', async () => {
  const { useFinanceStore, text, button, calls, host } = await mount()

  await act(async () => {
    useFinanceStore.setState({ reconciliation: cardGap })
  })

  const body = text()
  assert.match(body, /-\$1,875\.00/)
  assert.match(body, /-\$1,750\.00 on that day, so your ledger is \$125\.00 higher/)
  assert.match(body, /A credit account holds what you owe as a negative balance\./)

  await act(async () => {
    button('Post $125.00 adjustment')?.click()
  })

  assert.deepEqual(calls, [[cardGap.accountId, -187500, '2026-10-31']])
  assert.equal(useFinanceStore.getState().reconciliation, null)
  assert.equal(host.textContent, '')
})

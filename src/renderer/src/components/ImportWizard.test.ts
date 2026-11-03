import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement, act } from 'react'
import { JSDOM } from 'jsdom'
import { emptyImportCounts, type ImportPreview } from '@shared/api'
import type { ImportChoice, ImportChoiceTable, ImportProblem } from '@shared/importRepair'

// The wizard is a form: its answers, disabled state and review text are DOM
// behaviour, so it runs against a real DOM rather than a stand-in for one.
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

const CHOICES: Record<ImportChoiceTable, ImportChoice[]> = {
  accounts: [],
  categories: [],
  bills: [],
  goals: [],
  paychecks: []
}

function previewOf(overrides: Partial<ImportPreview> = {}): ImportPreview {
  const fileRows = emptyImportCounts()
  fileRows.transactions = 1
  return {
    token: 'token-1',
    path: '/tmp/backup.json',
    format: 'backup',
    exportedAt: '2026-02-03T10:00:00.000Z',
    fileRows,
    problems: [],
    choices: CHOICES,
    ...overrides
  }
}

const AMOUNT_PROBLEM: ImportProblem = {
  key: 'b:transactions:0:amount_cents',
  scope: 'backup',
  table: 'transactions',
  rowIndex: 0,
  field: { column: 'amount_cents', label: 'Amount', input: 'money' },
  rowLabel: 'Entry row 1',
  reason: 'the amount is missing',
  fixHint: 'Write the amount in the source file.',
  suggested: ''
}

const MEMO_PROBLEM: ImportProblem = {
  key: 'b:transactions:1:memo',
  scope: 'backup',
  table: 'transactions',
  rowIndex: 1,
  field: { column: 'memo', label: 'Memo', input: 'text' },
  rowLabel: 'Entry row 2',
  reason: 'the memo is missing',
  fixHint: 'Write the memo in the source file.',
  suggested: ''
}

function typeInto(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
  assert.ok(setter, 'jsdom exposes the native value setter')
  setter.call(input, value)
  input.dispatchEvent(new window.Event('input', { bubbles: true }))
}

function importButton(): HTMLButtonElement {
  const buttons = [...window.document.querySelectorAll('button')] as HTMLButtonElement[]
  const button = buttons.find((candidate) => candidate.textContent?.trim() === 'Import')
  assert.ok(button, 'the footer offers Import')
  return button
}

async function mount(
  preview: ImportPreview,
  step: 'fix' | 'review' = preview.problems.length > 0 ? 'fix' : 'review'
): Promise<{ unmount: () => void }> {
  const { createRoot } = await import('react-dom/client')
  const { useFinanceStore } = await import('../store/useFinanceStore')
  const { ImportWizard } = await import('./ImportWizard')
  useFinanceStore.setState({
    importPreview: preview,
    importStep: step,
    busy: false
  })

  const container = window.document.createElement('div')
  window.document.body.append(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(createElement(ImportWizard))
  })
  return {
    unmount: () => {
      act(() => root.unmount())
      container.remove()
    }
  }
}

test('an answer that fails validation is named and keeps Import disabled', async () => {
  const mounted = await mount(previewOf({ problems: [AMOUNT_PROBLEM] }))
  try {
    assert.equal(importButton().disabled, false, 'a blank answer is incomplete, not invalid')

    const input = window.document.querySelector('.import-problem input.input') as HTMLInputElement
    assert.ok(input)
    await act(async () => typeInto(input, 'twelve'))
    assert.match(
      window.document.querySelector('.field-error')?.textContent ?? '',
      /not an amount/
    )
    assert.equal(importButton().disabled, true)

    await act(async () => typeInto(input, '12.50'))
    assert.equal(window.document.querySelector('.field-error'), null, 'a good answer clears the error')
    assert.equal(importButton().disabled, false)
  } finally {
    mounted.unmount()
  }
})

test('the review explains an empty row once, and a skipped row as a choice', async () => {
  const mounted = await mount(previewOf({ problems: [AMOUNT_PROBLEM, MEMO_PROBLEM] }))
  try {
    const leaveOut = [...window.document.querySelectorAll('button')].filter(
      (button) => button.textContent?.trim() === 'Leave this row out'
    ) as HTMLButtonElement[]
    assert.equal(leaveOut.length, 2, 'each row offers its own leave-out button')
    await act(async () => leaveOut[1].click())

    const review = [...window.document.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Review import'
    ) as HTMLButtonElement
    await act(async () => review.click())

    const text = window.document.body.textContent ?? ''
    const occurrences = (needle: string): number => text.split(needle).length - 1

    assert.equal(occurrences('Entry row 1'), 1, 'the empty row is explained once')
    assert.ok(text.includes('1 row is still incomplete: “Entry row 1”'), 'the alert names it')
    assert.ok(text.includes('Use Back to missing info to fill it in'))
    assert.doesNotMatch(text, /nothing was filled in/)

    assert.ok(text.includes('Not imported'), 'a deliberate skip keeps its own list')
    assert.equal(occurrences('Entry row 2'), 1)
    assert.ok(text.includes('you chose to leave it out'))
  } finally {
    mounted.unmount()
  }
})

test('the review tells a backup merge apart from an append-only import', async () => {
  const backup = await mount(previewOf())
  try {
    const text = window.document.body.textContent ?? ''
    assert.ok(
      text.includes('A row already here is replaced only when the file holds a newer version of it'),
      'a newer copy in the file does replace the local row, so the review must say so'
    )
    assert.doesNotMatch(text, /the import only adds what is missing/)
  } finally {
    backup.unmount()
  }

  const lines = await mount(previewOf({ format: 'entries' }))
  try {
    assert.match(
      window.document.body.textContent ?? '',
      /the import only adds what is missing/,
      'statement lines are still added, never rewritten'
    )
  } finally {
    lines.unmount()
  }
})

test('the review names the file’s export date and flags one from the future', async () => {
  const format = (iso: string): string =>
    new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(Date.parse(iso))

  const past = await mount(previewOf())
  try {
    const text = window.document.body.textContent ?? ''
    assert.ok(text.includes(`made ${format('2026-02-03T10:00:00.000Z')}`), 'a real date is printed')
    assert.doesNotMatch(text, /future/)
  } finally {
    past.unmount()
  }

  const future = await mount(previewOf({ exportedAt: '2099-01-01T00:00:00.000Z' }))
  try {
    const text = window.document.body.textContent ?? ''
    assert.ok(
      text.includes(
        `made ${format('2099-01-01T00:00:00.000Z')} (a future date, so it is read as today)`
      )
    )
  } finally {
    future.unmount()
  }
})

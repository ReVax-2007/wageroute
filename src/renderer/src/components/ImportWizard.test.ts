import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement, act } from 'react'
import { JSDOM } from 'jsdom'
import { emptyImportCounts, type ImportNeedsPassphrase, type ImportPreview } from '@shared/api'
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

const SEALED: ImportNeedsPassphrase = {
  sealed: true,
  token: 'token-sealed',
  path: '/tmp/wageroute-backup-20260203-100000-encrypted.json',
  exportedAt: '2026-02-03T10:00:00.000Z'
}

function buttonWith(label: string): HTMLButtonElement {
  const button = [...window.document.querySelectorAll('button')].find(
    (candidate) => candidate.textContent?.trim() === label
  ) as HTMLButtonElement
  assert.ok(button, `the panel offers ${label}`)
  return button
}

function phraseInput(): HTMLInputElement {
  const input = window.document.querySelector('.unlock-row input.input') as HTMLInputElement
  assert.ok(input, 'the panel asks for a passphrase')
  return input
}

/** The sealed file's screen, with the main process replaced by an answer about the phrase. */
async function mountSealed(
  supplyPassphrase: (token: string, passphrase: string) => Promise<ImportPreview>
): Promise<{ unmount: () => void }> {
  const { createRoot } = await import('react-dom/client')
  const { useFinanceStore } = await import('../store/useFinanceStore')
  const { ImportWizard } = await import('./ImportWizard')
  Object.defineProperty(window, 'api', {
    value: { supplyPassphrase },
    configurable: true,
    writable: true
  })
  useFinanceStore.setState({ importPreview: SEALED, importStep: 'fix', busy: false })

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
      useFinanceStore.setState({ importPreview: null, importStep: 'fix' })
    }
  }
}

async function press(label: string): Promise<void> {
  await act(async () => {
    buttonWith(label).click()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function refusal(code: string, message: string): Error {
  return new Error(`[[wageroute:${code}]] ${message}`)
}

test('a sealed file stops the wizard at the passphrase and shows no rows', async () => {
  const calls: [string, string][] = []
  const mounted = await mountSealed(async (token, passphrase) => {
    calls.push([token, passphrase])
    return previewOf()
  })
  try {
    const text = window.document.body.textContent ?? ''
    const made = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(
      Date.parse(SEALED.exportedAt)
    )
    assert.ok(text.includes('Open an encrypted backup'))
    assert.ok(
      text.includes('wageroute-backup-20260203-100000-encrypted.json'),
      'it names the file it is holding'
    )
    assert.ok(text.includes(`written ${made}`), 'the header date is readable before the file opens')
    assert.equal(buttonWith('Open it').disabled, true, 'nothing can be opened with no phrase typed')
    assert.equal(
      [...window.document.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Import'),
      false,
      'an unread file cannot be imported'
    )

    await act(async () => typeInto(phraseInput(), 'correct horse battery staple'))
    assert.equal(buttonWith('Open it').disabled, false)
    await press('Open it')

    assert.deepEqual(calls, [['token-sealed', 'correct horse battery staple']])
    assert.equal(window.document.querySelector('.unlock-row'), null, 'the preview replaces the box')
    assert.ok(
      [...window.document.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Import'),
      'and the import is offered once the rows are counted'
    )
  } finally {
    mounted.unmount()
  }
})

test('a wrong phrase is retried in the same box, but a file that is not one is not', async () => {
  const wrong = await mountSealed(async () => {
    throw refusal(
      'PASSPHRASE',
      'That passphrase does not open this file, or the file has been changed since it was written.'
    )
  })
  try {
    await act(async () => typeInto(phraseInput(), 'not the phrase'))
    await press('Open it')
    assert.match(
      window.document.querySelector('.field-error')?.textContent ?? '',
      /does not open this file/
    )
    assert.ok(
      (window.document.body.textContent ?? '').includes('Open an encrypted backup'),
      'the box stays so the phrase can be typed again'
    )
    assert.equal(buttonWith('Open it').disabled, false)
    assert.equal(
      window.document.querySelector('.form-error'),
      null,
      'a wrong phrase is not a broken file, so it must not be reported as one'
    )

    await act(async () => typeInto(phraseInput(), 'typed again'))
    assert.equal(window.document.querySelector('.field-error'), null, 'typing clears the refusal')
  } finally {
    wrong.unmount()
  }

  const broken = await mountSealed(async () => {
    throw refusal('VALIDATION', 'This is not a WageRoute encrypted export.')
  })
  try {
    await act(async () => typeInto(phraseInput(), 'anything'))
    await press('Open it')
    assert.match(
      window.document.querySelector('.form-error')?.textContent ?? '',
      /not a problem the passphrase can fix/
    )
  } finally {
    broken.unmount()
  }
})

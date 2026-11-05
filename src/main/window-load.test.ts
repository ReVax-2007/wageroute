import assert from 'node:assert/strict'
import test from 'node:test'
import { MAX_LOAD_RETRIES, LOAD_TIMEOUT_MS, nextLoadAction, watchDocumentLoad, type LoadEvent } from './window-load'

/**
 * The window is the app. If its own document does not arrive, the ledger can be
 * open and healthy and the user still sees a blank frame — and until this module
 * existed, nothing in the main process noticed. These pins are the two rules that
 * must not be guesswork: how many times to try again, and what does not count.
 */

const finished: LoadEvent = { kind: 'finished' }
const mainFailed: LoadEvent = { kind: 'failed', mainFrame: true, code: -102, description: 'ERR_CONNECTION_REFUSED (-102)' }
const aborted: LoadEvent = { kind: 'failed', mainFrame: true, code: -3, description: 'ERR_ABORTED (-3)' }
const subFailed: LoadEvent = { kind: 'failed', mainFrame: false, code: -6, description: 'ERR_FILE_NOT_FOUND (-6)' }
const silent: LoadEvent = { kind: 'silent' }

function harness(options: { timeoutMs?: number; maxRetries?: number } = {}) {
  const armed: { ms: number; run: () => void }[] = []
  const seen: { reloads: number; notices: string[]; reports: string[] } = { reloads: 0, notices: [], reports: [] }
  let onFinish: (() => void) | null = null
  let onFail: ((event: LoadEvent) => void) | null = null

  watchDocumentLoad(
    {
      onFinish: (listen) => {
        onFinish = listen
      },
      onFail: (listen) => {
        onFail = listen
      }
    },
    {
      reload: () => {
        seen.reloads += 1
      },
      notice: (reason) => seen.notices.push(reason),
      report: (reason) => seen.reports.push(reason)
    },
    {
      timeoutMs: options.timeoutMs ?? 1000,
      maxRetries: options.maxRetries ?? 2,
      schedule: (ms, run) => {
        const entry = { ms, run }
        armed.push(entry)
        return () => {
          const index = armed.indexOf(entry)
          if (index >= 0) armed.splice(index, 1)
        }
      }
    }
  )

  return {
    seen,
    armedCount: () => armed.length,
    fire: () => armed[armed.length - 1]?.run(),
    finish: () => onFinish?.(),
    fail: (event: LoadEvent) => onFail?.(event)
  }
}

test('a screen that arrives ends the watch', () => {
  const w = harness()
  assert.equal(w.armedCount(), 1, 'the clock is armed before the first load is even asked for')
  w.finish()
  assert.equal(w.armedCount(), 0)
  assert.equal(w.seen.reloads, 0)
  assert.equal(w.seen.reports.length, 0)
})

test('a load that never reports anything is retried, then said out loud', () => {
  const w = harness({ timeoutMs: 1000, maxRetries: 2 })
  w.fire()
  assert.equal(w.seen.reloads, 1)
  assert.equal(w.seen.notices.length, 1)
  assert.match(w.seen.notices[0], /retry 1 of 2/)
  assert.equal(w.armedCount(), 1, 'the retry is itself watched')

  w.fire()
  assert.equal(w.seen.reloads, 2)
  w.fire()
  assert.equal(w.seen.reports.length, 1, 'a blank window must not be retried forever')
  assert.match(w.seen.reports[0], /no screen after 1000ms after 2 retries/)
  assert.equal(w.armedCount(), 0)

  w.fail(mainFailed)
  assert.equal(w.seen.reports.length, 1, 'the user is told once')
  assert.equal(w.seen.reloads, 2, 'and nothing is reloaded after that')
})

test('a load that stops with an error is retried without waiting for the clock', () => {
  const w = harness()
  w.fail(mainFailed)
  assert.equal(w.seen.reloads, 1)
  assert.match(w.seen.notices[0], /load failed: ERR_CONNECTION_REFUSED \(-102\)/)
  w.fail(mainFailed)
  assert.equal(w.seen.reloads, 2)
  w.fail(mainFailed)
  assert.equal(w.seen.reports.length, 1)
  assert.match(w.seen.reports[0], /ERR_CONNECTION_REFUSED \(-102\)/)
})

test('a load this module replaced is not a failure', () => {
  const w = harness()
  w.fire()
  assert.equal(w.seen.reloads, 1)
  // Retrying a document that was still on its way aborts it, and that abort is
  // this retry's own doing — counting it would turn a slow page into a report.
  w.fail(aborted)
  assert.equal(w.seen.reloads, 1, 'an abort does not spend another retry')
  assert.equal(w.seen.notices.length, 1)
  assert.equal(w.seen.reports.length, 0)
  assert.equal(w.armedCount(), 1, 'the retried load is still watched')
  w.finish()
  assert.equal(w.seen.reports.length, 0)
})

test('a resource that did not load is not the screen and does not reload it', () => {
  const w = harness()
  w.fail(subFailed)
  assert.equal(w.seen.reloads, 0)
  assert.equal(w.seen.notices.length, 0)
  assert.equal(w.seen.reports.length, 0)
  assert.equal(w.armedCount(), 1, 'the document is still expected')
  w.finish()
  assert.equal(w.armedCount(), 0)
})

test('a load that recovers after a retry is not reported', () => {
  const w = harness()
  w.fire()
  assert.equal(w.seen.reloads, 1)
  w.finish()
  assert.equal(w.armedCount(), 0, 'the recovered load leaves no clock running')
  w.fire()
  assert.equal(w.seen.reports.length, 0)
  assert.equal(w.seen.reloads, 1)
})

test('the retry limit is two, and it is the same for both kinds of silence and error', () => {
  assert.equal(MAX_LOAD_RETRIES, 2)
  assert.equal(LOAD_TIMEOUT_MS, 12_000)
  assert.deepEqual(
    [0, 1, 2, 3].map((retries) => nextLoadAction(silent, retries)),
    ['retry', 'retry', 'report', 'report']
  )
  assert.deepEqual(
    [0, 1, 2].map((retries) => nextLoadAction(mainFailed, retries)),
    ['retry', 'retry', 'report']
  )
  assert.deepEqual(
    [0, 1, 2].map((retries) => nextLoadAction(subFailed, retries)),
    ['none', 'none', 'none']
  )
  assert.deepEqual(
    [0, 1, 2].map((retries) => nextLoadAction(aborted, retries)),
    ['none', 'none', 'none']
  )
  assert.equal(nextLoadAction(finished, 0), 'none')
})

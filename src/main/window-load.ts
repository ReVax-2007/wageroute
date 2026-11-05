/**
 * Reacting to a WageRoute screen that never arrives.
 *
 * Both of the app's windows are the whole product: a window whose own document
 * does not load leaves the user in front of a blank frame while the ledger may be
 * open and healthy underneath it. Before this module nothing in the main process
 * noticed. The only two signals Electron gives for that are `did-fail-load` — a
 * load that stopped with an error, which includes one that was aborted — and the
 * absence of `did-finish-load`, which covers the load that simply never reported
 * anything. Both are watched here, and both end in the same two steps: try the
 * load again, and if it still will not come, say so in the log file and to the
 * user instead of holding a blank window.
 *
 * A sub-resource failure is deliberately ignored. A missing font or icon is not a
 * blank screen, and reloading the document over it would throw away the screen
 * the user is looking at.
 *
 * Nothing here reaches Electron: the events are handed in as listeners and the
 * actions as functions, so the retry limit — the part that must not be guesswork —
 * is testable on its own.
 */

export const LOAD_TIMEOUT_MS = 12_000
export const MAX_LOAD_RETRIES = 2

export type LoadEvent =
  | { kind: 'finished' }
  | { kind: 'failed'; mainFrame: boolean; code: number; description: string }
  | { kind: 'silent' }

export type LoadAction = 'none' | 'retry' | 'report'

/**
 * Chromium's `ERR_ABORTED`: a navigation was replaced before it finished, which is
 * exactly what this module's own retry does to a load still in flight. Counting it
 * as a failure would let one slow-but-live page abort itself twice and end in a
 * report about a screen that was on its way. The retry re-arms the clock, so a
 * window that genuinely never fills is still caught by the silence.
 */
const ERR_ABORTED = -3

/**
 * What to do about one load event. `retries` counts the retries already spent, so
 * the first failure of a document is retry 1 of `maxRetries` and the one after the
 * limit is a report.
 */
export function nextLoadAction(
  event: LoadEvent,
  retries: number,
  maxRetries: number = MAX_LOAD_RETRIES
): LoadAction {
  if (event.kind === 'finished') return 'none'
  if (event.kind === 'failed' && (!event.mainFrame || event.code === ERR_ABORTED)) return 'none'
  return retries >= maxRetries ? 'report' : 'retry'
}

export interface LoadSignals {
  /** Register the listener for the document having arrived. */
  onFinish(listen: () => void): void
  /** Register the listener for a load that stopped with an error. */
  onFail(listen: (event: LoadEvent) => void): void
}

export interface LoadActions {
  /** Start the load again. */
  reload(): void
  /** One line for the log file about a retry that is happening. */
  notice(reason: string): void
  /** The retries are spent: tell the user. */
  report(reason: string): void
}

export interface LoadWatchOptions {
  timeoutMs?: number
  maxRetries?: number
  /** Injectable so a test can drive the clock; the default is the real one. */
  schedule?: (ms: number, run: () => void) => () => void
}

function realSchedule(ms: number, run: () => void): () => void {
  const timer = setTimeout(run, ms)
  return () => clearTimeout(timer)
}

/**
 * Watch one window's document load. Call this before the load it is meant to
 * cover; every retry re-arms the clock, and the window reports at most once.
 */
export function watchDocumentLoad(
  signals: LoadSignals,
  actions: LoadActions,
  options: LoadWatchOptions = {}
): void {
  const timeoutMs = options.timeoutMs ?? LOAD_TIMEOUT_MS
  const maxRetries = options.maxRetries ?? MAX_LOAD_RETRIES
  const schedule = options.schedule ?? realSchedule
  let retries = 0
  let disarm: (() => void) | null = null
  let reported = false

  const arm = (): void => {
    disarm?.()
    disarm = schedule(timeoutMs, () => respond({ kind: 'silent' }, `no screen after ${timeoutMs}ms`))
  }

  const respond = (event: LoadEvent, detail: string): void => {
    const action = nextLoadAction(event, retries, maxRetries)
    if (action === 'none') {
      if (event.kind === 'finished') {
        disarm?.()
        disarm = null
      }
      return
    }
    disarm?.()
    disarm = null
    if (reported) return
    if (action === 'retry') {
      retries += 1
      actions.notice(`document load retry ${retries} of ${maxRetries}: ${detail}`)
      actions.reload()
      arm()
      return
    }
    reported = true
    actions.report(`${detail} after ${retries} retr${retries === 1 ? 'y' : 'ies'}`)
  }

  signals.onFinish(() => respond({ kind: 'finished' }, 'the screen arrived'))
  signals.onFail((event) => {
    if (event.kind !== 'failed') return
    respond(event, `load failed: ${event.description}`)
  })
  arm()
}

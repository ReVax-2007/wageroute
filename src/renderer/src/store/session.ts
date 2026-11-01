import type { StateCreator } from 'zustand'
import type { FinanceState, SessionSlice } from './types'

let noticeTimer: ReturnType<typeof setTimeout> | undefined

/**
 * Everything about what the window is showing, with no database in sight. The
 * only link outward is `notify`, which the data slice calls after a write.
 */
export const createSessionSlice: StateCreator<FinanceState, [], [], SessionSlice> = (
  set,
  get
) => ({
  screen: 'dashboard',
  allocatorOpen: false,
  confirmRequest: null,
  notice: null,
  snoozedPrompts: [],

  go: (screen) => set({ screen }),

  askConfirm: (request) =>
    new Promise<boolean>((resolve) => {
      // Two questions cannot share one dialog; the one already open, if any,
      // is answered "no" rather than left hanging.
      get().confirmRequest?.resolve(false)
      set({ confirmRequest: { ...request, resolve } })
    }),

  resolveConfirm: (ok) => {
    const request = get().confirmRequest
    set({ confirmRequest: null })
    request?.resolve(ok)
  },

  openAllocator: () => set({ allocatorOpen: true }),
  closeAllocator: () => set({ allocatorOpen: false }),

  // Snoozing is per occurrence, not per bill: a skipped cycle should not hide
  // the next month's prompt.
  snoozePrompt: (key) =>
    set((state) =>
      state.snoozedPrompts.includes(key)
        ? state
        : { snoozedPrompts: [...state.snoozedPrompts, key] }
    ),
  unsnoozePrompt: (key) =>
    set((state) => ({
      snoozedPrompts: state.snoozedPrompts.filter((item) => item !== key)
    })),

  notify: (text, tone = 'success') => {
    if (noticeTimer) clearTimeout(noticeTimer)
    set({ notice: { text, tone } })
    // Successes are transient; an error stays until it is read or dismissed.
    noticeTimer = tone === 'error' ? undefined : setTimeout(() => set({ notice: null }), 4200)
  },

  pauseNotice: () => {
    if (noticeTimer) clearTimeout(noticeTimer)
    noticeTimer = undefined
  },

  resumeNotice: () => {
    if (noticeTimer) clearTimeout(noticeTimer)
    if (!get().notice || get().notice?.tone === 'error') return
    noticeTimer = setTimeout(() => set({ notice: null }), 4200)
  },

  dismissNotice: () => {
    if (noticeTimer) clearTimeout(noticeTimer)
    noticeTimer = undefined
    set({ notice: null })
  }
})

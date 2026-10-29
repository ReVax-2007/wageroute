# 0014. One dialog, one focus model

- **Status:** Accepted
- **Date:** 2026-10-29
- **Deciders:** Project owner
- **Related:** [ADR 0013](0013-a-route-is-a-plan-not-a-movement.md), [FEATURES.md](../FEATURES.md), [ARCHITECTURE.md](../ARCHITECTURE.md)

## Context

WageRoute grew seven dialogs — account, bill, goal, entry, erase-data, the first-run prompt and the allocator wizard — and each one implemented its own idea of "a dialog". Some closed on Escape, some did not. None trapped Tab, so a keyboard user could tab into the sidebar behind the overlay and operate a screen they could not see. None returned focus on close, so after dismissing a form focus fell to `<body>` and the next Tab restarted at the top of the window. The page behind stayed scrollable under most of them. Screen readers got a dialog with `aria-label` set from a prop while the visible `<h2>` carried no id, so the same string existed twice and neither element described the other.

The audit treated this as one defect with many faces rather than seven separate nits: the problems share a cause — a dialog was a styled `<div>`, not a behaviour. Fixing each caller separately would have reproduced the same five mistakes in the next dialog anyone adds.

An earlier attempt in this batch made it worse before it got better: capturing the "return focus here" element inside `useEffect` recorded the input that React's `autoFocus` had already moved focus to, so closing a dialog returned focus to a field that no longer existed. That bug is the reason the capture below happens during render.

## Decision

### One hook, used by every dialog

`useDialog(onClose, active = true)` in `src/renderer/src/components/ui.tsx` owns the whole lifecycle:

- **Focus entry.** On open, focus moves into the panel — the first visible `input`, `select` or `textarea` in the dialog body, otherwise the panel itself — unless focus is already inside it.
- **Focus trap.** Tab and Shift+Tab cycle through the panel's visible focusable elements, wrapping at both ends. A panel with no focusable children focuses itself.
- **Escape closes.** The handler ignores everything else.
- **Scroll lock.** `body.style.overflow` is set to `hidden` and the previous value restored on close; `document.documentElement` gains `.dialog-open` so the workspace's own scrollbar can be suppressed too.
- **Focus return.** The element that had focus when the dialog opened gets it back on close.

The return target is captured **during render**, not in an effect: `document.activeElement` is read while `active` transitions from false to true, which is before React commits `autoFocus`. A dialog that mounts once and opens later (the allocator) captures on that transition via a `wasActive` ref; a dialog that mounts when it opens captures on mount. Without this, the input React focused first becomes the "trigger" and focus is restored to a node that is about to unmount.

### Backdrop dismissal requires the press to start outside

`backdropHandlers(onClose)` records whether `mousedown` landed on the backdrop itself and closes only if the matching `click` did too. Dragging inside a text field and releasing over the backdrop — which happens whenever someone selects text and overshoots — can no longer discard the form.

### A busy dialog refuses to close

The allocator passes `closeIfIdle`, which does nothing while a route is saving, to Escape, the backdrop and the close button. A write cannot be hidden halfway through; it either lands or shows its error.

### The visible heading is the accessible name

`Modal` generates ids with `useId` and sets `aria-labelledby` to its `<h2>` and, when a subtitle exists, `aria-describedby` to that paragraph. The allocator panel does the same inline. The `aria-label` copy of the title is gone, so the name a screen reader announces is the text a sighted user reads, and there is exactly one of it.

### The toast is a live region with an explicit dismiss control

Success is `role="status"`; an error is `role="alert"` and does not auto-expire. Hover or focus pauses the timer. Dismissal is a labelled 26px button (**Dismiss notification**) rather than the whole toast surface, because the surface also carries selectable text that people copy out of error messages.

## Consequences

### Positive

- Every dialog now behaves the same way, including dialogs written after this decision: the behaviour lives in one place, and a caller that forgets `useDialog` looks different from every other caller.
- Keyboard and screen-reader users get a name, an entry point, a boundary and a way back — the four things a modal has to provide.
- The toast fix removes a data-loss-shaped annoyance (accidentally dismissing an error while selecting it) and a lost-form annoyance (a drag ending outside the panel).

### Negative

- **The hook owns global listeners while a dialog is open.** `document` keydown, body overflow and a document class are all shared state; two dialogs open at once would fight. The app never does that today (the allocator's confirm prompt is a `window.confirm`, not a second React dialog), but a future stacked dialog needs the hook to track a stack.
- **The focus trap is a hand-written approximation.** It reads `getClientRects()` to skip hidden elements, which is right for this app but not a full implementation of the `inert`/`<dialog>` semantics. Shadow DOM and `<details>` edge cases are not handled.
- **Render-phase `document` access** makes `useDialog` depend on a browser environment; it is guarded with `typeof document !== 'undefined'` but would need a different shape under SSR. The app has no SSR and will not acquire one.

### Neutral

- No schema change, no IPC change, no data-model change. This is renderer behaviour only.
- Native `window.confirm` is deliberately left alone for destructive confirmations: it traps focus and restores it correctly by virtue of being the OS dialog, and replacing it would be a visual-consistency project, not an accessibility fix.

## Alternatives considered

### Use the native `<dialog>` element and `showModal()`

Rejected for this batch: `<dialog>` gives focus trapping and an inert background for free, but it also brings its own top-layer stacking, `::backdrop` styling, and a different close lifecycle (`close` event, `returnValue`) that the store's async saves do not map onto cleanly. It is the better long-term answer and remains open; the hook is a small, testable surface that a `<dialog>` migration could replace wholesale without touching any caller's form.

### Add a focus-trap library (`focus-trap-react`, `react-aria`)

Rejected: one dependency to reimplement forty lines, and it would still not answer the questions that actually caused the bugs here — when to capture the return target, and whether a backdrop click was a drag. The repository's dependency budget is deliberately small (see [SECURITY.md](../SECURITY.md)).

### Fix each dialog in place

Rejected: the failure mode was duplication. Seven copies of a trap would drift, and the eighth dialog would copy whichever version its author happened to open first.

## References

- [src/renderer/src/components/ui.tsx](../../src/renderer/src/components/ui.tsx) — `useDialog`, `backdropHandlers`, `Modal`, `Toast`
- [src/renderer/src/screens/Allocator.tsx](../../src/renderer/src/screens/Allocator.tsx) — `useDialog(closeIfIdle, open)`, `aria-labelledby`
- [src/renderer/src/store/useFinanceStore.ts](../../src/renderer/src/store/useFinanceStore.ts) — `notify`, `pauseNotice`, `resumeNotice`, `dismissNotice`
- [src/renderer/src/App.tsx](../../src/renderer/src/App.tsx) — skip link and focusable workspace

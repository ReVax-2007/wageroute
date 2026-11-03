# 0025 — The phone writes through the desktop's own rules

**Status:** Accepted (2026-11-02)

## Context

[ADR 0024](0024-two-copies-merge-by-time.md) made a backup merge in both directions, so an edit made anywhere could finally reach the other copy. It did not give the phone anything to edit: Bills, Goals and Entries were read-only, and the only write the PWA had was an entry pad that added or removed a row. The request behind it was explicit — the phone should work "exactly and in tandem with" the desktop.

The desktop's guards sit in its repositories, next to the SQL: `assertText`, `signedAmountCents`, `requireAccount`, the archived-account refusal, the round-up sweep that must not be edited, the paired transfer whose accounts may not move, the claim a payment settles. Duplicating those sentences in `src/pocket` would produce two lists that drift apart within a batch — and the drift is invisible, because the phone's own tests would pass against its own copy. A wrong amount on the phone is still money on the computer after the next import.

There is also a browser limit worth stating. The phone has no transaction: it reads the whole ledger out of IndexedDB, rebuilds a row set in memory, and writes it back in one `put`. Anything that would have rolled back in SQLite has to be refused before the first row changes.

## Decision

**One pure module holds the write rules, and both apps call it. The phone's writers mirror the desktop's semantics, not its SQL.**

1. **`src/shared/writeRules.ts` is the single validation core.** Pure, no Electron, no `better-sqlite3`, no DOM: enums, trim/required/length caps, cents and APR and due-day ranges, date form, the sign rules, the internal category aliases, and `RepositoryError` codes. The desktop's repository helpers re-export from it; Pocket's writer imports it directly. A sentence typed by a user appears from one place on both devices.
2. **`src/pocket/lib/write.ts` mirrors each repository's *observable* behaviour.** Same row written, same columns changed, same refusal, same cascade: pausing or deleting a bill hands its payments back to plain expenses, paying a bill writes the same `bill_payment` the prompt would, deleting a goal releases the accounts dedicated to it, deleting an account refuses while entries remain unless they go too, a transfer edits both legs, and a round-up sweep refuses edits and is retired with its purchase.
3. **A field the form does not send is not a column in the patch.** The desktop builds its `UPDATE` from the keys present, so `undefined` leaves a column alone and only `null` clears it. Pocket's `patchRow` filters `undefined` out for the same reason; without that filter every partial save blanked the columns the sheet did not show. A blank text field still means "clear it", which is why a whitespace-only value counts as absent.
4. **Refusals land before anything is written.** Each writer takes the current tables and returns new ones, so a rule violated halfway through throws while the phone still holds the ledger it had. The store commits only after the writer returns.
5. **Stamps follow the desktop's arithmetic.** `stampAfter` never moves a timestamp backwards and always bumps `revision`, so a merge on either side sees a genuinely newer row (ADR 0024) rather than a tie.
6. **Destructive taps ask first, in the desktop's words.** Deleting a bill, a goal or an entry on the phone opens the same question the desktop's confirm dialog shows for the same row — including the sentences about payment history, the month's set-aside and the other leg of a transfer — with *Keep it* as the default action.
7. **What the phone will not do stays out of reach.** Paychecks, allocations, reserves, the routing plan and settings are desktop actions; the phone has no writer for them, so it cannot half-write one.

## Consequences

- A rule change is one edit, and both devices get it. Two defects surfaced while writing the tests for this: a partial patch that blanked every untouched column, and a text field of spaces that refused the whole save instead of clearing the column. Both were in the shared layer, so the desktop was fixed by the same change.
- The phone is a peer for the records a person actually corrects away from the computer: bills, goals, entries, and — through the goal sheet — which accounts fund a goal and where its money lands.
- The writers cover accounts and categories too, but the phone's Accounts and Categories screens do not yet expose editors for them. The writers are tested; the UI is the next batch.
- Parity is asserted by tests that name the desktop's sentences: `src/shared/writeRules.test.ts` pins every refusal message, and `src/pocket/lib/write.test.ts` pins the row each writer leaves behind. A divergence fails a test rather than surprising a user.
- The phone can now corrupt its own copy the way the desktop can corrupt its database — a wrong edit is stored, not refused by a human. The merge gives no undo, so the two-step confirm and the fact that the desktop still holds the export remain the safety net.
- More of the desktop's semantics are duplicated than the shared module alone covers: each Pocket writer restates its repository's cascade in row-set terms. The tests are what keep the two honest.

## Alternatives rejected

- **Copy the sentences into Pocket.** Fast, and it works until the first rule changes. The two lists would disagree silently, and the disagreement would be about money.
- **Run the desktop repositories in the browser.** They are written against `better-sqlite3` statements — `prepare().run()`, `revision = revision + 1` in SQL — and shipping a WASM SQLite into a static PWA buys a copy of the database the phone cannot export as the same file.
- **Give the phone its own weaker rules.** A phone edit that skips a guard is a row the desktop then refuses to import, or accepts and mis-routes. The point of the batch is that the phone is not a second-rate editor.
- **Ship a sync service so one server owns the writes.** Local-first, no account, no server: the same reasoning as ADR 0024.
- **Delete on the first tap because the sheet already says what a delete does.** A thumb on a 6-inch screen hits the red button at the edge of the sheet; the desktop asks, so the phone asks.

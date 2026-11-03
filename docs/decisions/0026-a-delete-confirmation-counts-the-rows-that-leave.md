# 0026 — A delete confirmation counts the rows that leave, and both devices say it from one place

**Status:** Accepted (2026-11-03)

## Context

A ledger row is not always one movement of money. A transfer is two rows sharing a `transfer_group_id`; a purchase that rounds up is the purchase plus two sweep rows carrying it as `round_up_source_id`. Deleting one row therefore deletes several, and the repository has known that since Batch 40 — `deleteTransactions` expands the selection before it writes and returns the number of live rows that actually went, which is what the toast prints.

The question asked *before* the write did not know it. The desktop's dialog printed the number of rows ticked, so a $12.34 purchase that swept twice was confirmed as one row and then removed three: the confirmation understated a destructive, irreversible action, and the honest number only appeared after the money was gone. The phone got the same case right from Batch 47 because its writer holds the whole table copy in memory and can expand the set locally.

The desktop cannot do that, and the obvious fixes are all wrong:

- **Count from what the screen holds.** The spreadsheet displays one page of a query; the store snapshot carries `SNAPSHOT_TRANSACTION_LIMIT` rows. A sweep leg outside that window is invisible, so the count would be short in exactly the case that matters.
- **Put the link on the row type.** `Transaction` and `TransactionRow` (`src/shared/types.ts`) carry `transferGroupId` but no `roundUpSourceId`; `TRANSACTION_SELECT` and the page query never read the column. Adding it means touching the read model, the CSV/Pocket row mapping and the parity tests — a much larger change than the question needs, and it would still leave the screen counting from a partial view.
- **Ask after the write.** Then the person learns what was destroyed only once it is destroyed.

Meanwhile the same sentence existed in two hand-written copies: the desktop's dialogs and the phone's `Ledger` sheet spelled out near-identical strings independently, which is how [ADR 0025](0025-the-phone-writes-through-the-desktops-own-rules.md) described the wording and how drift begins.

## Decision

**A confirmation counts what leaves the ledger, gets that number from the database, and both devices say it out of one shared module.**

1. **`doomedDeletionIds` is the one expansion.** In `src/main/db/repo/transactions.ts` it returns the live rows a delete retires: the ids given, every leg sharing their transfer group, and every row carrying one of them as its round-up source — de-duplicated, and restricted to rows that exist and are not already tombstoned. `deleteTransactions` calls it instead of inlining the same walk, so the promise and the write cannot drift apart.
2. **The count crosses a read-only channel.** `transaction:count-deletion` declares `[string[]] → number` in `src/shared/channels.ts`, is handled in `src/main/ipc.ts` against the same user, and reaches the renderer as `countEntryDeletion`. Reads that answer a question about the ledger belong to the process that owns the ledger; the renderer's window onto it is partial by design.
3. **The store queues the read and keeps a floor.** `countEntryDeletion` runs through the write queue, so a question cannot be answered from a ledger that has not yet taken the edits the screen already made. If the read fails it returns the size of the selection — not a guess but a proven lower bound, because a delete never retires fewer rows than the ones it was pointed at.
4. **`src/shared/deletion.ts` owns the words.** `entryDeletionWords(count, { isTransferLeg, memo })` returns the title, body and confirm label together. Three callers use it — the spreadsheet's bulk bar, the grid's row button, the phone's entry sheet — and the phone's inline ternaries are gone. A count that is not a usable number is clamped, so the app cannot offer *Delete 0 entries?*.
5. **Screens show the number the write will report.** The confirmation and the toast must agree, or the confirmation is decoration.

## Consequences

- Deleting a rounded-up purchase now asks *Delete 3 entries?* with a **Delete 3** button on both devices, and a transfer leg asks about both legs on both.
- The phone's confirm button pluralises for the first time; the phone keeps one sentence the desktop does not have — the row's amount and date, and that the removal travels with the next export — because that is true on a device whose ledger leaves the phone only through a file.
- The read model is untouched: no new column, no `roundUpSourceId` on `Transaction`. If a future screen needs to *show* the link rather than count it, that change is still open.
- Parity is pinned by tests rather than by review: `src/shared/deletion.test.ts` fixes the sentences, and `src/main/db/ledger-guards.test.ts` asserts that the count promised before a mixed delete equals the number `deleteTransactions` reports after it — including an overlapping selection counted once and a lone sweep taking its sibling.
- Every future destructive confirmation follows the same shape: ask the database what would leave, phrase it from the shared module, and never let the screen's own window stand in for the ledger.

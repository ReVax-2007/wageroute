# 0016. A bill is a rule, not a row

- **Status:** Accepted
- **Date:** 2026-10-31
- **Deciders:** Project owner
- **Related:** [ADR 0008](0008-one-check-carries-the-month.md), [ADR 0012](0012-the-wall-remembers-its-claims.md), [FEATURES.md](../FEATURES.md)

## Context

A bill is stored once: amount, frequency, due day, account and autopay flag. The occurrences it produces are never written to the database ahead of time. Prompts, projections and the Priority Wall each need to know which dates a bill lands on, and three separate date calculations would eventually disagree about February, about a due day of 31, or about a weekly bill that crosses a month boundary.

The alternative — materialising every future occurrence as a row — was rejected during the wall redesign, but the rule behind that rejection has never been written down, and the audit found two places where the same bill was counted twice because one path assumed a stored occurrence and another recomputed it.

## Decision

**A bill row is the rule. Occurrences are computed, never stored.**

- `next_due_on` on the bill is a cache for display and ordering; it is not the source of truth for "what is due". Every consumer calls the same pure functions in `src/shared/occurrences.ts` and `src/shared/billPrompts.ts` with an explicit `today`.
- The due date is clamped to a real calendar day: a bill due on the 31st falls on the 30th in April, and on the 28th or 29th in February. A clamped date never rolls into the next month.
- Weekly and annual bills are supported; a bill's cycle is anchored on its stored due day, not on the day it was created.
- Prompts ask about one occurrence: the most recent due date on or before today, skipped when it falls today, with a five-day payment window. Confirming writes a `bill_payment` for the remainder the ledger has not already matched — never for the full amount again.
- The Priority Wall reserves against upcoming occurrences but records only a **claim** (`bill_reserves`, ADR 0012). It never writes a transaction and never creates a second copy of the bill.
- Pausing a bill stops future reservations; it does not delete past occurrences or past claims.

## Consequences

### Positive

- One pure function decides dates, so prompts, projections and the wall cannot drift apart, and a date bug is fixed once.
- No background job or "generate the next twelve months" step exists to fail. Launching the app after a month away produces the correct prompts immediately.
- The ledger holds only what happened. A bill that was never paid leaves no phantom rows to clean up.

### Negative

- **Changing a bill rewrites history that was only ever computed.** Editing the amount or the due day changes what the wall says about months already reserved, unless a reserve row already froze that month's claim (ADR 0012). The UI warns that future figures change; the past is not preserved as a snapshot.
- **The date functions are load-bearing.** They are tested, but a new consumer that computes its own dates reintroduces the bug this ADR removes.
- There is no per-occurrence "skipped" record: skipping a month is a pause on the bill, not a tombstone for one date.

### Neutral

- Autopay bills are posted at launch by `postDueAutopay`, which pays only the unpaid remainder of the current cycle. That is a ledger movement initiated by a stored rule, not a stored occurrence list.
- No schema change in this decision; `next_due_on` is an optimisation, not a contract.

## Alternatives considered

### Materialise twelve months of occurrences on save

Rejected: every bill edit becomes a migration of future rows, a long absence produces stale rows, and the database becomes a projection of a rule that is cheaper to evaluate on demand.

### A separate `bill_occurrences` table updated by a scheduler

Rejected for the same reason plus a new failure mode: a scheduler that did not run is indistinguishable from a bill with no future occurrence.

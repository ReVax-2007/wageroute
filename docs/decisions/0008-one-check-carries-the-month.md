# 0008. One paycheck carries the month

- **Status:** Accepted
- **Date:** 2026-10-28
- **Deciders:** Project owner
- **Supersedes:** the single "spread the year over every paycheck" reserve rule for bills that opt out of it
- **Related:** [ADR 0002](0002-integer-cents.md), [ADR 0007](0007-dedicated-accounts-balance-is-progress.md), [DATA-MODEL.md](../DATA-MODEL.md), [FEATURES.md](../FEATURES.md)

## Context

The Priority Wall shipped with one reserve rule: take a bill's cost per year and divide it by the number of paychecks per year, then hold that back from every check. Over a full year the rule is exact — a $50.00 **weekly** bill on **biweekly** pay reserves `50 × 52 / 26 = $100` per check and collects `$100 × 26 = $2,600`, precisely the bill's annual cost. What it cannot express is "this one paycheck pays this bill": the obligation only ever arrives smeared across the whole year. The same wall row already prints the monthly figure as `2 600 / 12 = $216.67`, so the two halves of one screen answer two different questions and there was no way to make a single check carry the month.

The unreleased working-tree draft that tried to add per-check funding got the arithmetic wrong in two ways, and neither number reached a release:

- it reserved the single bill *instance* falling on the chosen check — **$50** — against a $216.67 monthly obligation, **77% short**, because a weekly bill has roughly five instances a month while pay does not come weekly;
- answering "is this the funding check?" from `new Date()` when the caller had no paycheck date made the same input produce different reserves on different days, so a plan computed for a stored paycheck could not be reproduced.

This record exists because the fix is a change of model, not a bug fix: the year spread stays as one of four options, and the other three move the *whole month's* obligation onto one identified check.

The owner was explicit about the shape of the fix and about the options they wanted, in this order: **1. closest to the due date, 2. choose specific paycheck to fund, 3. reserve from all paychecks, 4. first check of every month.** The ordering is the owner's and is preserved verbatim in the dropdown, numbered so the list reads as an answer to "which paycheck pays this bill?".

## Decision

### The month is the unit of obligation; the strategy only picks the collector

`billFundingReserveCents(bill, cadence, paycheckDate)` returns what **one** paycheck must hold back:

| Strategy | On the funding check | On every other check |
| --- | --- | --- |
| `all_checks` | `reservePerPaycheckCents` (year ÷ paychecks) | same |
| `closest_due_date` | `monthlyEquivalentCents` (the whole month) | `0` |
| `first_check` | `monthlyEquivalentCents` | `0` |
| `specific_check` | `monthlyEquivalentCents` on `funding_paycheck_index` | `0` |

The three single-check strategies move money; they never multiply it. Summed over a month they equal the same monthly obligation `all_checks` reaches by spreading, which is now an asserted property (`every strategy reserves the same total across a month`) instead of a hope. This is what makes the two summary figures on the wall honest at the same time: *locked every month* and *reserved per paycheck* answer different questions and add up to the same month.

### Which check is which is a calendar approximation, stated as one

WageRoute knows the date printed on a paycheck, not the employer's payday table. Slots are therefore day-of-month ranges, and the two views of a slot share one table so they cannot drift:

- `CHECK_SLOT_ANCHORS` — monthly `16`; semimonthly `8, 23`; biweekly `7, 21, 30`; weekly `4, 11, 18, 25, 30`;
- `paycheckIndexInMonth(date, cadence)` maps a date into those same ranges, so a payday that drifts a few days stays in the slot it belongs to;
- `closestCheckIndexToDue(dueDay, cadence)` is the nearest anchor, **ties going to the earlier slot**, so a bill due the 14th on semimonthly pay is funded by the 1st check rather than coin-flipped.

### Only slots that exist every month can be chosen

Biweekly pay produces a 3rd check in some months and weekly a 5th. A bill assigned to an optional slot would silently stop reserving in the months that do not contain it, so `GUARANTEED_CHECKS_PER_MONTH` (monthly 1, semimonthly 2, biweekly 2, weekly 4) bounds both the UI list and the write path: `reachableCheckIndexes` feeds the "Which paycheck?" dropdown and `fundingCheckIndex` **clamps** any stored index into range. Clamping rather than dropping means a bill can never end up with no responsible check.

### Never read the clock

The draft fell back to the current date when a caller had no paycheck date, which put the wall clock inside a pure module. A single-check strategy without a paycheck date now falls back to the spread. The function is pure in its inputs: the same call twice gives the same number, and a stored paycheck can be re-planned months later.

### Persisted as schema version 5, defaulting to yesterday's behaviour

`bills.funding_strategy TEXT NOT NULL DEFAULT 'all_checks'` and `bills.funding_paycheck_index INTEGER` (nullable). Every released bill lands on `all_checks`, which is arithmetically identical to the pre-v5 rule, so upgrading a database moves no number. `accounts.color` (nullable) rides in the same migration.

### The UI says which check pays, and never claims twice

The bill dialog shows a live derived line — "Reserves the whole month's obligation on the 2nd paycheck, closest to the due day" — and hides the "Which paycheck?" field for cadences with only one slot. A wall row funded by one check prints its monthly figure in the per-paycheck column with a **"Nth check only"** sub-label, so a $216.67 cell cannot be misread as a recurring deduction.

## Consequences

### Positive

- The draft's under-collection is closed by design rather than by a patch: a single-check strategy carries the *month*, never the *instance*, so paying the bill can no longer outrun reserving it.
- Routing became reproducible. No clock, no hidden global state; the plan depends only on the paycheck being routed.
- Four honest options in the order the owner asked for, with the label that names the mechanism rather than a slogan.
- Existing data is untouched by the migration and existing numbers are untouched by the default.

### Negative

- **Per-paycheck reserves are lumpy by design.** Under `first_check` the 1st check of the month funds several bills at once and the 2nd funds none. That is the point, but it makes the wizard's step-2 total depend on the date entered in step 1, and a user comparing two paychecks will see different wall numbers for the same bill set.
- **Slot maths is an approximation of a payday calendar**, not a calendar. A biweekly pay cycle anchored to a Friday can put a real paycheck on the 15th, which this model reads as slot 2; if the user's mental model says slot 1, the bill is funded a fortnight late. The model is documented rather than hidden, and `all_checks` remains the default for anyone whose paydays genuinely drift.
- **A weekly cadence can never fund on its 5th check.** The clamp protects the obligation but ignores a real check when it exists; the month's money is collected by the 4th instead.
- **Rounding is tolerated, not eliminated.** Spreading then summing integer cents can differ from one monthly charge by a cent or two per month; the test asserts `|monthTotal − monthOwed| ≤ slots`.
- **`monthlyEquivalentCents` on one check can exceed the paycheck itself**, turning a previously covered wall into a shortfall on that specific date. Visible in step 2 and reported as a shortfall rather than smoothed away.

### Neutral

- `due_day` still does not move money by itself; it only chooses the nearest slot. Nothing schedules a payment date, because WageRoute remains a reservation model.
- The strategy is per bill and per user; there is no default-on-cadence rule, no history of changes, and no interaction with `autopay` (an autopaid bill still reserves on the chosen check).
- Goals, emergency funding and the surplus splits are untouched: the strategy changes only which paycheck carries the wall slice.

## Alternatives considered

### Reserve the bill instance that falls in the paycheck

Rejected: it is the arithmetic in the unreleased draft — $50 on one check against a $216.67 monthly obligation, 77% short — because pay cadence and bill cadence do not share a period.

### Store a full payday calendar per bill

Rejected as bookkeeping the owner would have to maintain. The app has the pay cadence and the date on the paycheck being routed; a calendar table would need a source of truth it does not have.

### Derive the slot from `due_day` and the paycheck date by day arithmetic

Rejected: it needs the actual pay cycle anchor (which Friday the first cheque fell on), and guessing it from a single date re-introduces the drift the clamping avoids.

### Drop an out-of-range `funding_paycheck_index` instead of clamping

Rejected: dropping leaves a bill with no responsible check, i.e. silently unfunded. Clamping keeps the obligation collected by a check that always exists.

### Keep `new Date()` for callers without a date

Rejected: it made plans unreproducible and made a pure module depend on the wall clock. The fallback is now the spread, which is stable and conservative.

## References

- [src/shared/cadence.ts](../../src/shared/cadence.ts) — `CHECK_SLOT_ANCHORS`, `GUARANTEED_CHECKS_PER_MONTH`, `paycheckIndexInMonth`, `closestCheckIndexToDue`, `reachableCheckIndexes`, `fundingCheckIndex`, `billFundingReserveCents`
- [src/shared/cadence.test.ts](../../src/shared/cadence.test.ts) — slot placement, tie-breaks, clamping, the $50-weekly → $216.67 figure, the month-total invariant per strategy, the no-clock fallback
- [src/shared/allocator.ts](../../src/shared/allocator.ts) — `paycheckDate` threaded into the plan
- [src/main/db/migrations.ts](../../src/main/db/migrations.ts) — `SCHEMA_V5`
- [src/renderer/src/screens/PriorityWall.tsx](../../src/renderer/src/screens/PriorityWall.tsx) — the four numbered options, the conditional "Which paycheck?" field, the derived hint and the "Nth check only" sub-label

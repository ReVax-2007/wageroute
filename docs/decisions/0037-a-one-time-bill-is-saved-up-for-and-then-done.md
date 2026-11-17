# 0037. A one-time bill is saved up for, and then it is done

- **Status:** Accepted
- **Date:** 2026-11-17
- **Deciders:** Project owner
- **Related:** [ADR 0008](0008-one-check-carries-the-month.md), [ADR 0012](0012-the-wall-remembers-its-claims.md), [ADR 0016](0016-a-bill-is-a-rule-not-a-row.md), [ADR 0028](0028-both-devices-derive-a-bills-set-aside-from-its-payments.md), [ADR 0036](0036-a-variable-bill-is-cleared-by-what-it-came-to.md), [FEATURES.md](../FEATURES.md#one-time-bills)

## Context

The owner's words: "make a single time bill (runs only once) for example buying new tires, or things of the sort."

Every bill was a series. `Frequency` named six cadences, the recurrence engine projected each one forever, and everything that turned a bill into money did it through `monthlyEquivalentCents`: Left to spend withheld the month's smoothed share, a cheque reserved its share of the month (ADR 0008), a claim belonged to one calendar month (ADR 0012), and a month's payments released that month only. A $900 tire purchase entered as an "annual" bill would be asked for again next year, would set aside $75 a month instead of the $450 a month two months out needs, and once paid would be back on the wall the next month.

## Decision

**A bill can be due once (`frequency = 'once'`, schema 14). Its date is `next_due_on`, it is saved up for by the paychecks before that date, and the payment that covers it makes it done for good.**

1. **One more frequency, not a second kind of row.** `'once'` joins the `Frequency` union and the `bills.frequency` CHECK. The date lives in the existing `next_due_on`, which is required for a one-time bill on both devices (`assertBillSchedule` in `src/shared/writeRules.ts`); `due_day` is that date's day, so every reader that only knows a day still lands on it. Adding a value to the union made the compiler find every table keyed by frequency; the rest were found by reading every caller of the cadence and occurrence functions.
2. **It has no recurring share.** `BILL_PERIODS_PER_YEAR.once` is `0`, so `monthlyEquivalentCents` and `reservePerPaycheckCents` read it as zero and the "every month" figures stay what they say. What a one-time bill asks for comes from its date instead, in `src/shared/oneTimeBills.ts`, through the same two entry points every bill already goes through:
   - **A cheque** (`billFundingReserveCents` → `oneTimeReserveCents`) sets aside what is still open — the amount less what was paid and what earlier cheques' open claims hold — divided by the cheques left before the due date (`chequesUntilDue`, counted forward on the pay cycle). $900 two months out on semimonthly pay is four cheques of $225, not one of $900. A cheque after the date carries everything still open. Funding strategies do not apply: they choose a cheque *of the month*, and this bill is not monthly.
   - **Left to spend** (`unpaidMonthlyWallCents` → `oneTimeSetAsideCents`) holds the share the saving-up has reached by this month, spread evenly from the month the bill was written to the month it is due, less what was paid in cash: $300, $600, then $900. A recurring bill's share is released each month because the next occurrence asks for it again; a one-time bill has no next occurrence, so releasing it would leave the due month to find the whole amount at once.
3. **Its cycle is its whole life.** Wherever a recurring bill is read for one month, a one-time bill is read for every month (`inBillCycle`): `listBillPaymentsThisMonth` (and Pocket's snapshot and `billPaidThisMonthCents`) sum all of its payments, `claimsThisMonthFor`, the Allocator preview and the Bills screen count its open claims from any month, `recordBillReserves` caps all of its claims at the one amount, and the claim walk treats it like a quarterly or annual bill, so one payment settles the claims of every month the saving-up wrote. A deposit paid in September and the rest in October add up to one paid bill.
4. **Done is derived, never stored.** A one-time bill is done when its payments, counted by the variable-bill rule (ADR 0036), cover the amount (`isOneTimeBillDone`). Nothing writes a "done" column, so a payment typed on the phone makes the bill done on both devices after a merge, and deleting the payment reopens it — the same reasoning as ADR 0028. `activeBills` now takes the month's payment totals and leaves done bills out, which removes them from the plan, Left to spend, projections, the **Did these clear?** card, Home's upcoming list and the Allocator in one place.
5. **It is never rolled forward.** The occurrence engine gives a one-time bill exactly one date. `nextBillOccurrence` answers with that date even after it has passed, so an unpaid one reads overdue (Home says *Nd overdue*, the Bills row carries **Overdue**, Pocket's state is `overdue` and stays in Due soon) instead of becoming next month's bill. The prompt card asks about it after its date with every payment ever linked counted, and autopay posts it once: the payment it posts covers the bill, so nothing is due again.
6. **The screens.** The bill dialog (desktop and Pocket) offers **One time**, which swaps the due day for a **Due on** date, replaces the funding schedule with one sentence, and starts a new one-time bill with autopay off. The Bills row reads *$900.00 · One time · due Jan 15*, its per-cheque figure says *Spread to the due date*, and a **Pay** action opens the variable bill's dialog with the open amount filled in. Paid one-time bills move to a **Done** card on the desktop and a **Done** list on Pocket, where they can still be opened, edited or deleted.

## Consequences

- A purchase planned months ahead is saved up for evenly and never comes back once paid, on both devices, with no stored state the two could disagree about.
- Existing bills are untouched: a recurring bill's every figure goes through the same code with the same inputs. The one shared change, `activeBills` needing payment totals, was a signature change the compiler enforced at every caller.
- **The cheque count is a calendar estimate on twice-a-month and monthly pay.** WageRoute has no payday anchor for those cadences, so `chequesUntilDue` steps 15 days (or a month) from the cheque's own date and can be one off. That only moves money between cheques: each cheque re-divides what is still open, and the last cheque before the date usually takes the rest.
- **A one-time bill paid on a card stops being withheld once it is done.** A recurring card payment stays withheld until the month ends; a done one-time bill leaves the plan at once, and the card's own balance carries the debt.
- The "Bills every month" and "Average per paycheck" summaries do not include one-time bills; the per-paycheck column and the next-cheque total do.
- Changing a recurring bill to one time (or back) re-reads its payments under the new cycle, like any bill edit (ADR 0016). Stored claims keep their state until the next payment or import replays them (ADR 0028).

### Data

- Schema 14 rebuilds `bills` to widen the `frequency` CHECK with `'once'`, the way schema 6 widened `funding_strategy`: enforcement suspended, same columns and ids, `PRAGMA foreign_key_check` before commit. Every existing bill, claim and payment is unchanged; the migration is forward-only.
- Backups write version 14 and carry a one-time bill as `frequency: "once"` with its `next_due_on`. Older builds refuse a version-14 file as newer. Pocket names version 14 as known.

## Alternatives considered

### A `due_on` column and an `is_one_time` flag beside a recurring frequency

Rejected: every reader that switches on `frequency` would have kept treating the bill as monthly unless it also checked the flag — a parallel path the compiler could not find.

### Store "done" (or switch the bill off) when it is paid

Rejected: the write paths that pay a bill are many (entry dialog, prompt card, autopay, Pocket, imports, merges), and every one of them would have to set and unset it. A stored flag also merges by revision, so the phone and the computer could disagree about a bill whose payments they agree on.

### Withhold the whole amount from the day the bill is written

Rejected: Left to spend would drop by $900 for a purchase two months out, which says the money is gone when it is not, and the cheques would still be spreading it.

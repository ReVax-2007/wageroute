# 0012. The Priority Wall remembers its claims

- **Status:** Accepted
- **Date:** 2026-10-29
- **Deciders:** Project owner
- **Related:** [ADR 0008](0008-one-check-carries-the-month.md), [ADR 0011](0011-the-pay-cycle-is-a-setting.md), [ADR 0013](0013-a-route-is-a-plan-not-a-movement.md), [DATA-MODEL.md](../DATA-MODEL.md)

## Context

The Priority Wall computed everything it showed from the current snapshot: bills, the pay cadence and the newest paychecks. It could say what a *typical* cheque reserves, but it could not say what this month's cheques had already claimed. That produced three defects the 2026-10-29 audit recorded separately and which share one cause:

- **A second cheque re-reserved the same single-check bill.** A bill on "first check of every month" was reserved on the 5th and again on the 20th, so the wall over-stated what was spoken for and the allocator under-funded savings by the bill's amount every month.
- **A bill payment did not change the wall.** Logging rent moved the ledger but left the wall saying the bill was still owed; the only way to reconcile was to read the ledger by hand.
- **"Paid this month" did not exist.** There was no state to render, so the wall traded in forecasts only.

There was no place to store the one fact at issue: *which cheque claimed which bill for which month*. Deriving it from transactions was possible only for bills whose payments were tagged with a `bill_id`, and the audit found the app's own prompts and many imported rows were not.

## Decision

### A `bill_reserves` row per bill per month is the receipt

Schema 7 adds `bill_reserves`:

| Column | Meaning |
| --- | --- |
| `bill_id` | the wall row that was claimed |
| `paycheck_id` | the cheque whose route wrote the claim |
| `cycle` | `YYYY-MM`, the month the money is for |
| `amount_cents` | the claim, in the same per-check arithmetic the wall prints |
| `state` | `reserved` or `paid` |
| `strategy` | added in schema 9: the funding strategy in force when the cheque wrote the claim |
| `due_day` | added in schema 9: the bill's due day when the claim was written |
| `settled_by` | added in schema 9: the transaction that closed the claim, or `NULL` |

The cycle is the **calendar month**, not the pay period. `monthlyEquivalentCents` already normalises every frequency to a month, and a pay period that straddles two months would make "this month's bills" ambiguous on the wall. A bill claimed in March is a March claim even if the cheque landed on 31 March.

A route writes rows only when the plan is fully funded (`plan.shortfallCents === 0`). A shortfalling cheque records **no** claims: the wall must not print a receipt for money it never covered, and the next cheque gets a clean retry. This is the same honesty rule as the shortfall banner, applied to storage.

Reserves are rows, not derived state, so they travel in exports and through the import wizard. `TABLE_COLUMNS`, `TABLE_DEFAULTS` and the importer's allowlist were extended in the same commit; a backup taken before v7 restores with an empty reserve table, which is the truthful reading — that build never recorded one.

### State moves with the payment, in both directions

- `createTransaction` with a `bill_id` and kind `bill_payment` or `expense` closes the claims its amount fully covers, oldest first. A claim is never part-paid: 60,000 against two 60,000 instalments closes one, and 60,000 against a single 120,000 claim closes nothing.
- `deleteTransaction` sets back to `reserved` every row that payment closed.
- `updateTransaction` re-opens the old month and closes the new one when the date, amount or kind changed, so moving a payment from March to April never leaves March looking settled.
- A payment dated in a later cycle first tries that cycle's claim, but only if the cheque that wrote it was received on or before the payment. Any amount left settles the earliest open earlier claims it fully covers, restricted to claims whose funding cheque fell **after** the bill's due day in their own cycle (`settleEarlierBillReserve`), so a January cheque's claim does not sit "reserved" for the rest of the ledger's life once the bill is paid in February. The day test is the carry rule, and it is not limited to `last_check`: a monthly `first_check` cheque on 31 January funds a bill due 1 February exactly the same way. It compares against the claim's stored `due_day`, so editing the bill later cannot rewrite an old carry. A mid-month cheque funds its own month, so a payment moved from March to April leaves March owed; a payment can never close more claim value than it paid, and the commit backstop skips a payment that already closed something so the same money is never spent twice. The older row keeps its own cycle; only its state flips, and `settled_by` names the payment so the flip can be undone exactly.
- Deleting or moving a payment re-opens only rows linked to it (`settled_by`), plus a pre-v9 row with no link: the month it left first, then the earlier carried claim the old rule closed. A claim another live payment closed stays paid.
- `deleteBill` soft-deletes the bill's claims in the same transaction.

Every transition is a state flip on an existing row. A second cheque in the same month writes only the remainder: `recordBillReserves` caps the month's **open** claims at the bill's monthly equivalent, so a strategy switch can leave two receipts for one month but their sum never exceeds the obligation. Only open claims count, so a claim already closed by a card charge does not block cash the pool still owes.

### The allocator is told which bills are already claimed

`claimsThisMonthFor(db, userId, cycle)` returns the month's open claims as `{ billId, amountCents, strategy }`, and `buildAllocationPlan` receives them as `monthClaims`. Every claim made this month reduces the month's remaining need, whatever strategy wrote it, so a second cheque reserves only what the first did not. A cheque still never sets aside more than its normal share: when the month remains partly paid rather than claimed, the remainder is divided across the guaranteed cheques still to come, not across the ones that already passed — a payment between two semimonthly cheques leaves the whole remainder to the last cheque.

Schema 9 records the strategy so each row is a faithful receipt, but the subtraction no longer has to special-case it. Filtering by the bill's *current* strategy was wrong in both directions: switching a carried bill to `all_checks` after the first cheque left it unclaimed and reserved the month twice, while switching a spread bill to a single-check strategy lost the instalment already reserved. Counting every claim, and capping the month's total at the bill, makes the remainder follow from the rows actually written under any sequence of switches.

### The anchor is a date, not a parsed label

`settings.payAnchorDate` stores **one real payday**. `nextPaydayISO` projects weekly and biweekly slots from it, so the wall's next-check date, the "Reserved on the next check" column and the third-check-in-a-month case all agree with the calendar. The payday *label* from [ADR 0011](0011-the-pay-cycle-is-a-setting.md) stays free text and display-only: the anchor is structured because formulas read it, and the label is not because they must not.

Without an anchor the wall falls back to day-of-month slots, and a bill whose due day lands outside the guaranteed slots spreads its monthly equivalent instead of reserving nothing. With an anchor, a third check in a month funds nothing extra — it is surplus, which is what the user sees in their bank.

## Consequences

### Positive

- The wall can now answer "what has this month already taken?" instead of only "what does a cheque usually take?", and a payment is visible on the wall the moment it is logged.
- A second cheque stops over-reserving. The bug was arithmetic, not presentation, so fixing it changed what the allocator leaves for savings.
- Payment edits and deletions cannot leave a stale claim, because all four transactions that touch a bill payment move the same row.
- The reserve table is a plain data table with `deleted_at` and `revision`, so it inherits backup, import, wipe and merge behaviour instead of needing parallel code.

### Negative

- **A claim is not an account balance.** The wall says $1,200 is reserved; the chequing account still holds it. Nothing moves money, and the UI now says so ([ADR 0013](0013-a-route-is-a-plan-not-a-movement.md)). A user who reads "reserved" as "in a separate pot" will be wrong, and the copy is the only defence.
- **Claims are per month, not per statement period.** A bill paid on 3 March for a 28 February due date closes March's claim, because the ledger date is what the user entered. That is consistent with the cycle rule and still occasionally surprising.
- **Changing a bill's amount does not rewrite past claims.** The stored claim is what the cheque was told to reserve; the wall's forward projection uses the new amount. The two can disagree for the current month until the next cheque.
- **A shortfall leaves the month unclaimed.** If the user routes a short cheque and then a second short cheque, neither records a claim even though together they cover the wall. The retry policy is per cheque, and fixing it would mean deciding which cheque owns a partial claim — a model this batch deliberately did not take on.
- **A claim closes whole or not at all.** There is no partial settlement column, so a payment smaller than a claim leaves the claim open (conservative: the wall keeps reserving what is still owed), and a payment that covers several instalments closes them all. Making a claim divisible would need a settlement amount per payment and a join, which the shortfall defect did not justify.

### Neutral

- Backup format version rises to 7 because `SCHEMA_VERSION` does, and `bill_reserves` is added to the table list. Old files import with an empty table.
- Schema 9 adds `strategy`, `due_day` and `settled_by` to the table and raises the backup version to 9. A restored row without a stated strategy or due day takes its bill's values, falling back to `all_checks` and `1`; that is the only reading available for files written before the columns existed. The v9 migration backfills live rows the same way, so no amount or state changes.
- The migration deletes three settings rows no released build read; schema 7 therefore has one visible side effect outside the new table, documented in the changelog.
- `idx_transactions_user_date` is rebuilt in the same migration so the month query used to compute the cycle stays indexed.

## Alternatives considered

### Derive claims from transactions instead of storing them

Rejected: it works only for payments tagged with a `bill_id`, and the audit found untagged payments in the app's own prompt flow and in imported data. A claim would silently vanish whenever a user logged a bill payment without linking it, which is exactly the state the wall exists to prevent.

### One claim per bill, not per month

Rejected: a yearly bill and a monthly bill have different cadences, and the wall's question is always "what is spoken for this month". A single row would have to be rewritten each month and could not answer "was March covered?".

### Record claims even on a shortfall, proportionally

Rejected for now. Proportional claims need an owner per cheque and a rule for two partial cheques in one month; both are a larger model than the defect requires. Recording nothing keeps the wall honest and the next cheque effective.

### Let the reserve write move money into a dedicated account

Rejected: the app has no per-bill account, transfers are paired ledger rows, and creating them would change balances the user never asked to change. The wall is arithmetic over a plan; [ADR 0013](0013-a-route-is-a-plan-not-a-movement.md) records that boundary.

## References

- [src/main/db/migrations.ts](../../src/main/db/migrations.ts) — `SCHEMA_V7`, `bill_reserves`, the rebuilt ledger index, the settings cleanup; `SCHEMA_V9`, the claim strategy, due-day snapshot and settlement link
- [src/main/db/repositories.ts](../../src/main/db/repositories.ts) — `recordBillReserves`, `claimsThisMonthFor`, `settleBillReserveForPayment`, `settleEarlierBillReserves`, `reopenBillReservesSettledBy`, the lifecycle paths, `commitPaycheck`
- [src/main/db/reserves.test.ts](../../src/main/db/reserves.test.ts) — reserved → paid → re-opened, no double claim, no receipt on shortfall, duplicate guard, bill deletion, a cheque after the due day carrying into the next month under any strategy, a payment dated before the new cheque settling the carry, the delete re-opening exactly that carry, a strategy switch in either direction preserving the month's remainder, one payment closing only the instalments it covers, a short payment leaving its claim open, a card-closed claim not blocking the cash reserve, a legacy carry re-open, and a due-day edit not rewriting an old carry
- [src/shared/occurrences.ts](../../src/shared/occurrences.ts) — the recurrence engine the wall and prompts share
- [src/shared/cadence.ts](../../src/shared/cadence.ts) — `payAnchorDate`, `nextPaydayISO`, `billFundingReserveCents`
- [src/renderer/src/screens/PriorityWall.tsx](../../src/renderer/src/screens/PriorityWall.tsx) — reserve chips, next-check column, anchor footnote

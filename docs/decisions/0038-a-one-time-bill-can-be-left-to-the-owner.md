# 0038. A one-time bill can be left to the owner

- **Status:** Accepted
- **Date:** 2026-11-25
- **Deciders:** Project owner
- **Related:** [ADR 0036](0036-a-variable-bill-is-cleared-by-what-it-came-to.md), [ADR 0037](0037-a-one-time-bill-is-saved-up-for-and-then-done.md), [FEATURES.md](../FEATURES.md#one-time-bills)

## Context

The owner's words: "i want bills that can be payed in parts but only once … im gift shopping for my family and will buy in parts and not everything at once", and then: "i dont want it to come out of pays, it is just like modifying the cost of the gas bill for example. but dont take it out of pay. leave it to me."

A one-time bill (ADR 0037) is saved up for: every cheque before its date sets a share aside, and Left to spend holds what the saving-up has reached. For gift shopping the owner wants a budget to spend against and a running total of what is spent, with no paycheck asked to fund it and nothing held back in Left to spend: they manage the money themselves.

## Decision

**A one-time bill can be left to the owner: `bills.from_paychecks = 0` (schema 15). The bill form offers it as *Save up for it from my paychecks*, ticked by default.**

1. **One rule, `leftToOwner(bill)`** in `src/shared/oneTimeBills.ts`: a one-time bill with `fromPaychecks === false`. A recurring bill ignores the flag, and a missing flag (a row or file from before schema 15) saves up, as every bill did.
2. **Nothing is set aside or held back.** `billFundingReserveCents` asks nothing of a cheque for it (so the paycheck wizard and the commit write no claim), and `unpaidMonthlyWallCents` holds nothing for it in Left to spend. The Bills row shows $0.00 per paycheck and *Left to you*; Pocket's sheet says *left to you, nothing set aside from paychecks*.
3. **Everything else stays a one-time bill.** It keeps its date, its overdue state and its place in projections. Purchases are recorded with **Pay** in parts, and the bill is done when they cover the amount or when the last one closes it at what was spent (ADR 0037 addendum).
4. **Both devices.** Pocket reads and writes the column, and its backup reader knows version 15. A backup carries `from_paychecks`, and a file without it imports as saving up.

## Consequences

- A new forward-only migration (v15, `ALTER TABLE … ADD COLUMN from_paychecks INTEGER NOT NULL DEFAULT 1`), so an upgraded ledger cannot be opened by 1.4.0, and a version-15 backup is refused there.
- The money for a bill left to the owner is not protected by Left to spend: spending it elsewhere first is the owner's call. That is the point of the option, and the form says so.

## Alternatives considered

### Reuse "Amount varies"
Rejected: a variable bill is still saved up for, and one payment of any size clears it (ADR 0036). Gifts need neither.

### A new funding strategy value
Rejected: strategies choose *which* cheque of the month funds a recurring bill and do not apply to one-time bills (ADR 0037); `funding_strategy` also has a CHECK that would need a table rebuild to widen, where an added column needs none.

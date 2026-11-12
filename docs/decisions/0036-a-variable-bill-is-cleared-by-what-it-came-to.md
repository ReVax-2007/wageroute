# 0036. A variable bill is cleared by what it came to

- **Status:** Accepted
- **Date:** 2026-11-12
- **Deciders:** Project owner
- **Related:** [ADR 0012](0012-the-wall-remembers-its-claims.md), [ADR 0016](0016-a-bill-is-a-rule-not-a-row.md), [ADR 0025](0025-the-phone-writes-through-the-desktops-own-rules.md), [ADR 0028](0028-both-devices-derive-a-bills-set-aside-from-its-payments.md), [ADR 0035](0035-a-floor-is-money-the-app-will-not-offer.md), [FEATURES.md](../FEATURES.md#variable-bills)

## Context

The owner's words: "i want a variable bill that i set to 70$ for example and then can re-adjust the bill when it clears. for gas, since the price isnt always the same, i want to be able to easily say, yes it passed, and it was say 51$ instead of the 70$ we have set to the side."

A bill had one amount and every reader treated it as a debt to be paid in full. A $51 payment against a $70 bill was a *part payment*: the claim stayed `reserved` (ADR 0028 settles a claim only when payments cover it), Safe to Spend kept withholding the other $19, the "Did it clear?" card came back asking for "the rest", and autopay would have posted the $19 on the next launch. For a fixed bill that is right. For gas it is wrong: the bill has cleared and there is no rest.

## Decision

**A bill can be marked variable (`bills.is_variable`, schema 13). Its amount is an estimate, and one payment of any size clears the occurrence it was made for.**

1. **Paychecks set the estimate aside**, exactly as for any bill. Nothing about reserving, funding strategies or claims changes; the flag only changes how payments are *counted*.
2. **The rule is one function, applied to each ledger row before anything sums it.** `creditedPaymentCents` in `src/shared/variableBills.ts`: a spend on a variable bill counts as `max(actual, estimate)`; a refund, and every row on a fixed bill, counts as it is. Every reader that turns payments into "paid" goes through it:
   - the claim walk (`deriveClaimStates`, now given the bill), so a $51 payment settles the $70 claim on both devices;
   - the month's paid totals — `listBillPaymentsThisMonth` on the computer (the same rule written as SQL, pinned by tests) and the phone's snapshot and `billPaidThisMonthCents`;
   - the "Did it clear?" prompt (`dueBillPrompts`), so a cleared variable bill stops asking.
   A row-level rule rather than a month-level one is what keeps a weekly variable bill honest: each week's payment clears that week's estimate, not the whole month.
3. **The difference goes back to Left to spend that month.** Safe to Spend withholds `monthly bill − paid`, so counting the $51 payment as $70 releases the whole $70 hold while the account only lost $51: the $19 is spendable again with no extra entry, transfer or adjustment. The claim is settled rather than shrunk, so nothing is carried into next month. This is the reading of ADR 0016 that adds no stored state: the bill stays a rule, the ledger stays what happened, and the release is derived.
4. **An overage is allowed and is simply what it was.** An $85 payment counts as $85, the hold is released, and Left to spend drops by the extra $15 because the account lost $85. The screens say "$15 over the estimate".
5. **A card payment frees only the difference.** The credit part of the month's total stays the plain amount, so a $51 card charge keeps $51 withheld for the card and frees $19, the same way a fixed bill on a card keeps its cash held.
6. **The screens show both figures.** `BillPaymentTotal` gains `actualCents`, the plain sum, next to `paidCents`, the credited one. The Bills screen and Pocket show "Came to $51 · $19 under, back to Left to spend" (or "over the estimate") for a bill that lands at most once a month, and a running "paid so far" for a weekly one, whose month is not finished.
7. **Clearing is one click.** The "Did it clear?" card, the Bills screen's new **It cleared** action (variable bills only) and Pocket's **It cleared** each show an amount field filled with the estimate; confirming unchanged posts the estimate. Fixed bills keep their screens and buttons exactly as before; Pocket's `payBill` ignores a typed amount on a fixed bill.
8. **Autopay never posts a guess.** `postDueAutopay` skips variable bills. The ledger holds what happened (ADR 0016), and an estimate is not a fact; a posted estimate would also be indistinguishable later from a payment the owner confirmed. The bill stays on the "Did it clear?" card past its due date, marked *autopay*, with the estimate filled in, so it is still one click.

## Consequences

- A cheaper bill reads paid at once on both devices, its set-aside is released, and the reminder goes quiet — from the card, the Bills screen, Pocket or an ordinary ledger entry linked to the bill.
- Editing a variable payment's amount afterwards (the spreadsheet or Pocket's ledger) is also a re-adjustment: the claim stays settled and Safe to Spend follows the new figure.
- **A refund takes back what it returned, not the estimate.** A $10 refund of a $51 payment reopens $10 of the $70 claim, exactly as it would on a fixed bill. Undoing a whole variable payment is a delete, not a refund. This keeps the rule per-row and identical in SQL and TypeScript; refunds on bill payments only arrive through imports anyway (ADR 0028).
- **A second payment in the same month is a second occurrence's worth.** On a monthly variable bill that is an overage the screens show; it cannot be read as "the rest of a part payment", because a variable bill has none.
- Turning the flag on or off re-reads past months under the new rule, like any other bill edit (ADR 0016, *Negative*). Stored claims keep their state until the next payment or import replays them (ADR 0028).

### Data

- Schema 13: `bills.is_variable INTEGER NOT NULL DEFAULT 0 CHECK (is_variable IN (0,1))`. Every existing bill is fixed; the migration is forward-only.
- Backups write version 13 and carry `is_variable`; a file from version 2–12 has no key and every bill in it reads as fixed on both devices. Pocket names version 13 as known.

## Alternatives considered

### Shrink the claim to the actual and leave the rest reserved

Rejected: the $19 would stay held for a bill that has cleared, and the owner asked for it back. Carrying it forward as a credit toward next month needs a stored balance per bill — a second ledger the rest of the app would have to read.

### Record the difference as an adjustment or a refund row

Rejected: it writes a movement that never happened, and the account balance would stop matching the bank.

### Change the bill's amount to what it came to

Rejected: the estimate is what next month should set aside; one cheap fill-up should not lower it, and editing a bill rewrites the months already computed (ADR 0016).

### Post the estimate on autopay and let the owner correct it

Rejected: an uncorrected estimate looks exactly like a confirmed payment, and the balance would be wrong until someone noticed.

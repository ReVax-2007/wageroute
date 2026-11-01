# 0013. A route is a plan, not a movement

- **Status:** Accepted
- **Date:** 2026-10-29
- **Amended:** 2026-11-01 — **Move this plan** turns a route into transfers on request (see *Amended*).
- **Deciders:** Project owner
- **Related:** [ADR 0012](0012-the-wall-remembers-its-claims.md), [DATA-MODEL.md](../DATA-MODEL.md), [FEATURES.md](../FEATURES.md)

## Context

The allocator takes a deposit and splits it across the Priority Wall, savings, investments, debt, goals and leisure. The numbers it produces look like instructions — "put $420 in savings" — but the app has no connection to a bank and moves nothing. Until this batch the screen did not say so: step 3 showed a plan and a **Route it** button, and the only hint that nothing would leave the chequing account was the absence of a transfer row afterwards.

The audit filed this as a truth problem rather than a missing feature. The owner's instruction for the batch was to fix what the audit found, not to build banking integration, so the fork was:

1. **Make the plan honest** — say in words that a route records a plan against the deposit.
2. **Make the plan produce movements** — create paired transfers from the deposit to each destination account.

Option 2 collides with the data model. The data model ([DATA-MODEL.md](../DATA-MODEL.md)) defines a transfer as two ledger rows: one negative on the source, one positive on the destination. The allocator's destinations are *buckets* (savings, investment, debt, leisure) and *goals*, and a goal may be funded by an account ([ADR 0007](0007-dedicated-accounts-balance-is-progress.md)) or by nothing at all. There is no destination account for a bucket, and a goal with no bound account has nowhere to send money. Creating transfers would require inventing accounts the user never made, or quietly moving only the goals that happen to have one — both of which make the ledger assert a movement the user did not perform.

## Decision

### The allocator states what it does

Step 3 of the wizard, beside the plan, now reads: WageRoute records this plan against the deposit; it does not move money between accounts or pay bills. The wall's own copy uses the same vocabulary — *reserved* means claimed in arithmetic, not set aside in a separate balance. The **Route it** action still records the paycheck and its allocation lines, so the plan is kept and the history is real.

### A reserve is a claim, not a transfer

[ADR 0012](0012-the-wall-remembers-its-claims.md) stores a `bill_reserves` row instead of writing a transfer. The row says "this cheque has claimed this bill for this month"; it does not change any account balance. That keeps the wall's arithmetic and the ledger's balances independent, which is what the user's actual bank does: the money is still in chequing until the bill is paid, and the bill payment is the ledger entry that moves it.

### Marking a bill paid logs the payment, never a second plan

The chronology prompt's **Yes, it cleared** writes a `bill_payment` transaction against the chosen account for the **remainder** of the bill (`amount − already matched`), so confirming a part-paid bill cannot double-post it. That is a real ledger movement, initiated by the user stating what happened, not by the app deciding to pay something.

### Duplicate deposits are confirmed explicitly

Routing the same amount, date and account twice is refused by the repository; the wizard detects the match and shows a warning before submission. Only after **Route it anyway** is `allowDuplicate` passed. A double-click or a re-entry can no longer reserve the wall twice, and a genuine second deposit of the same size on the same day remains expressible.

### Amended 2026-11-01: the plan has an explicit second step

The rejection of automatic transfers below still holds — routing must not invent a destination. What changed is that the user can now ask for the movement, line by line. **Move this plan** on the dashboard lists the routed lines that have a real destination (debt, savings, investments, and goals with their own account), lets the user pick or confirm the destination account, and posts one paired transfer per line, dated today and carrying the paycheck id. Priority Wall and guilt-free money are not offered; they stay where they are. Applying the same plan twice moves nothing the second time, because a line is recognised by the transfer that already exists for that paycheck, source and destination. A goal with no bound account still has nowhere to send money, so the dialog tells the user to give it one rather than choosing an account for them.

The route itself remains a plan. The dashboard's **Move this plan** is the deliberate act that turns it into ledger rows, and the ledger remains a record of what the user says happened.

## Consequences

### Positive

- The screen no longer implies a bank transfer it cannot make, and the word *reserved* is defined where it is used.
- Keeping reserves out of the ledger means the app never has to choose between "the wall says $1,200 is set aside" and "the account balance says it is not".
- The duplicate guard closes a real double-route path without taking away the legitimate same-day case.

### Negative

- **The user still has to move the money.** WageRoute can now record the movement (**Move this plan**), but recording a transfer is not moving money at the bank. A user who expects the balances to change on their bank's side will still find out otherwise; the app's ledger is the record, not the bank.
- **The plan and the ledger can drift.** If the user moves a different amount than the plan said, nothing reconciles the two; the wall keeps its claim and the account keeps its balance. The batch does not add a "planned vs actual" report.
- **The copy is load-bearing.** "Reserved" is honest only because the UI explains it; a future screen that uses the word without the explanation will reintroduce the confusion this ADR removes.

### Neutral

- No schema change beyond [ADR 0012](0012-the-wall-remembers-its-claims.md); this decision is copy, prompt arithmetic and one repository guard.
- The allocator's plan remains a pure function in `src/shared/allocator.ts`, so the honesty change did not touch its tests.

## Alternatives considered

### Create paired transfers from the deposit to each funded account

Rejected: buckets have no account, unbounded goals have nowhere to go, and inventing destination accounts would make the ledger claim movements the user never made. It is a banking-integration feature, not a truth fix, and it needs its own ADR and its own destination model.

### Leave the copy alone and document the behaviour in the manual

Rejected: the audit's finding was that the screen itself over-promised. Documentation does not fix a screen, and the allocator is the screen where the promise is strongest.

### Block routing until the user confirms every transfer manually

Rejected: it turns a planning tool into a checklist and punishes the normal case (a user who moves money themselves, routinely) to protect the rare case (a user who assumed the app would).

## References

- [src/renderer/src/screens/Allocator.tsx](../../src/renderer/src/screens/Allocator.tsx) — step-3 honesty copy, duplicate warning, `allowDuplicate`
- [src/main/db/repositories.ts](../../src/main/db/repositories.ts) — duplicate guard in `commitPaycheck`, remainder-aware `createTransaction` path used by the prompt
- [src/renderer/src/components/BillPrompts.tsx](../../src/renderer/src/components/BillPrompts.tsx) — "already matched", "Yes, log the rest"
- [DATA-MODEL.md](../DATA-MODEL.md) — a transfer is stored as two rows that must keep their sign

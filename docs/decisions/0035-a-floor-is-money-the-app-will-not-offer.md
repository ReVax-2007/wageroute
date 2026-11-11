# 0035. A floor is money the app will not offer

- **Status:** Accepted
- **Date:** 2026-11-10
- **Deciders:** Project owner
- **Related:** [ADR 0007](0007-dedicated-accounts-balance-is-progress.md), [ADR 0013](0013-a-route-is-a-plan-not-a-movement.md), [ADR 0025](0025-the-phone-writes-through-the-desktops-own-rules.md), [ADR 0034](0034-a-locked-account-is-frozen-money.md), [FEATURES.md](../FEATURES.md#account-floor), [DATA-MODEL.md](../DATA-MODEL.md)

## Context

The owner keeps a minimum in an account: "my account cant go under 90$ and i want to make sure that it doesnt say i can spend 200$ if i have 200$, it would say 110$ usable. this is an entirely optional thing, that could be any number or not there."

Every screen that says what can be spent or moved read the full balance. The owner had to remember the minimum and subtract it in their head, which is the arithmetic the app exists to do.

## Decision

- **A new nullable column, `accounts.floor_cents`** (schema 12). `NULL` is "no floor" and is what every existing account gets. A floor is any whole number of cents from 0 up; 0 is a floor (it stops the app offering an overdraft) and is different from none.
- **Only checking, savings and cash accounts take one** (`FLOOR_KINDS` in `src/shared/writeRules.ts`). A credit card's equivalent is its credit limit, which it already has. An investment account is not money the app routes or spends from. Both devices store `NULL` when a write names one of those kinds, so switching a draft to a card clears the floor, and `accountFloorCents` ignores a floor found on any other kind (for example in a hand-edited file).
- **Usable = balance − floor, never below zero** (`usableCents` in `src/shared/accounts.ts`). An account without a floor reads exactly as before, overdraft included. Every place that says what can be spent or moved uses it and shows the floor beside it, as "$110.00 usable · $90.00 floor": the Safe to Spend pool on both devices (against settled cash, not next week's paycheck), the account rows on Dashboard, Accounts and Pocket, the Transfers and split-transfer pickers and their "after" lines, the entry dialog, Pay card, the goal funding pickers, and Pocket's equivalents.
- **The floor never hides money.** Balances, the ledger, total wealth, the wealth buckets and cash on hand all read the full balance. A goal fed by a dedicated account keeps its full balance as progress (ADR 0007); the floor is shown next to it, not taken out of it.
- **The owner is asked, not refused.** An entry, transfer, split, card payment, bill payment or plan move the owner starts that would leave an account under its floor shows one question on both devices (`floorBreachQuestion`): where the account lands, its floor, and **Save anyway** or Cancel. Money coming in is never a breach, and landing exactly on the floor is allowed. The repositories accept the write: the floor is the owner's preference about their own money, and a bank can legitimately take an account under it (a fee, a cheque that cleared late).
- **The app's own moves respect it strictly.** A round-up sweep that would take the spending account under its floor is skipped, on both devices, because there is nobody to ask at that moment and a sweep is a nicety. The paycheck allocator only writes a plan (ADR 0013) and moves no money, so it needs no rule; moving the plan is the owner's action and asks like any other.

## Consequences

- Safe to Spend drops by the floors of the spendable accounts. Dashboard and Pocket Home say how much: "(after $90.00 kept as floors)".
- Schema 12 is a forward-only migration. Backups write version 12 and carry `floor_cents`; a file from before it reads as no floor. Merges treat it like any other account column (newest revision wins), so a floor set on the phone reaches the computer on the next import. A build from before this change ignores the column and offers the full balance again.
- Edits made in the spreadsheet grid (changing an existing entry's amount) do not ask. The question is on the paths that create money movements; an edit corrects a record that already exists.
- A floor is not a lock. It does not stop the owner, the bank or an imported statement from taking the account lower; it stops the app from suggesting it.

## Alternatives considered

- **Refuse writes below the floor, like a lock.** Rejected: the owner said it is "entirely optional", the bank does not enforce it, and refusing would make a real fee or a late cheque impossible to record.
- **Subtract the floor from the stored balance or from net worth.** Rejected: the money is there. Hiding it would bring back the "small balance" stress ADR 0007 removed.
- **A floor on credit cards as a minimum owed.** Rejected: a card's limit already says how far it can go, and a second number would mean two different things on one screen.

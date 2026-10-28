# 0007. A dedicated account's balance *is* the goal's progress

- **Status:** Accepted
- **Date:** 2026-10-28
- **Deciders:** Project owner
- **Supersedes:** the "progress is never a balance" rule stated in [FEATURES.md](../FEATURES.md) and [DATA-MODEL.md](../DATA-MODEL.md), for dedicated accounts only
- **Related:** [ADR 0002](0002-integer-cents.md), [ADR 0004](0004-sync-ready-schema.md), [ADR 0006](0006-import-wizard-asks-instead-of-failing.md), [DATA-MODEL.md](../DATA-MODEL.md), [ARCHITECTURE.md](../ARCHITECTURE.md)

## Context

Since the first release, sinking-fund progress has been computed one way only: the sum of `allocations` rows written when a paycheck is routed. Account balances were deliberately excluded — "moving the money is still your job". That rule is load-bearing in the code, and it is also the rule the owner hit in real use.

The reported symptom: money sitting in a savings account named Emergency showed **nothing** on the Sinking funds screen. Nothing was broken — no allocation row existed, so progress was zero, while the bank balance was real. Two other effects came from the same design:

- Safe to Spend subtracted funded goals from *cash on hand*, so a savings account that was clearly not spending money still looked spendable, and investment accounts were invisible in the calculation;
- the whole picture was missing. The owner: "give me a total wealth place, it stresses me out looking and seeing a small balance knowing i have more money".

The owner was offered the conservative option — keep the invariant and add an explicit "claim this balance into the goal once" action — and chose the other path in terms: **balance IS the progress**. This record exists because that choice breaks a documented invariant, and the break has consequences the code cannot enforce.

## Decision

### A dedicated account is a pointer on the account, not a foreign key

Migration v4 adds `accounts.dedicated_goal_id TEXT` with **no declared `REFERENCES`**, plus a partial index. `goals.account_id` already references `accounts`, so a declared key would make the two tables cyclic and **no static insert order could restore a backup** — `TABLE_ORDER` writes accounts before goals, and a real constraint would reject every dedicated account on import. The value is instead validated in the repository (`requireGoal`), which is the same trade-off v3 accepted for `transactions.transfer_group_id` (see [ADR 0004](0004-sync-ready-schema.md)).

`deleteGoal` clears `dedicated_goal_id` on every account pointing at the goal, inside the same transaction as the soft delete, so a dangling pointer cannot survive an archive.

### The balance replaces the allocation total

`listGoals` still computes the allocation sum, then overrides it per goal:

```
fundedFrom === 'account' ? max(0, sum of live dedicated balances) : allocationCents
```

A goal is `fundedFrom: 'account'` when it has **at least one** live, non-archived account dedicated to it; several accounts may feed one goal and their balances add. Progress therefore moves with every entry that touches those accounts, reads `0` rather than negative when an account is overdrawn, and reverts to the allocation total the moment the last dedicated account is archived or detached. Names are grouped in JavaScript rather than `GROUP_CONCAT` so a comma in an account name survives the label.

### Account-funded goals are skipped by the allocator

Writing an `allocations` row against a goal whose progress comes from a balance produces a row that is invisible on every screen. `buildAllocationPlan` filters `fundedFrom !== 'account'` before funding goals; the unspent goal budget falls through to savings along the existing leftover path, and `no_goals` is now reported when *no goal is allocatable*, not merely when the user has none.

### Safe to Spend is a per-account tri-state, not a kind rule

Migration v4 adds `accounts.in_safe_to_spend INTEGER CHECK (it IS NULL OR it IN (0,1))`. `NULL` means "derive from `kind`", so every pre-v4 row keeps its old behaviour and an explicit choice is distinguishable from never having been asked. `countsInSafeToSpend` is the single rule; `safeToSpendPoolCents` replaces cash-on-hand as the pool the Wall and the pool-funded goals are subtracted from.

**A dedicated account is excluded from the pool by default, and its goal's progress is excluded from the deduction.** Both halves are needed. Leaving the money out of the pool stops it being spendable; leaving it *in* the goals deduction as well would subtract it a second time, because it was never there to subtract — with a $1,200 checking account, a $4,200 dedicated savings account and no bills, that version reported Safe to Spend as **−$3,000** instead of $1,200. `poolEarmarkedGoalsCents` keeps the deduction for allocation-funded goals, whose money genuinely still sits in the pool. An explicit `in_safe_to_spend` wins over the default in both directions.

### Total wealth is the whole ledger view

`totalWealthCents` sums every live account balance. Credit balances are already stored negative ([ADR 0002](0002-integer-cents.md)), so they subtract without special-casing. `wealthBuckets` splits the same sum into Cash / Saved for goals / Invested / Credit owed, and the buckets are tested to partition the total exactly, so no cent can be counted in two buckets. It appears on the Dashboard as a strip under Safe to spend, in the Accounts summary and in the sidebar.

## Consequences

### Positive

- **What the owner asked for.** Money parked "only for this" reads as progress on that goal, immediately, with no bookkeeping ritual.
- **The double count is closed by default**, not by construction: dedicated accounts leave the spendable pool, their goals leave the goal deduction, and the allocator leaves the goal budget. `in_safe_to_spend = 1` on a dedicated account puts the pool half back on purpose, and this feature has no way to know that the money is the same money.
- **Both models coexist without touching existing rows.** Migration v4 is two nullable columns; every pre-existing account keeps its old semantics.
- **Rules stay pure and testable.** `countsInSafeToSpend`, `safeToSpendPoolCents`, `poolEarmarkedGoalsCents`, `totalWealthCents`, `wealthBuckets` and the allocator filter are functions with direct tests; the SQL side is tested against real in-memory SQLite.
- **The anxiety number is visible everywhere the small number is.**

### Negative

- **The one-line invariant is gone.** "Goal progress comes from allocations, never from balances" no longer holds unconditionally, and two funding rules now share one screen. A goal card labelled with account names and a goal card showing a routed total are different objects that look the same.
- **Progress can go backwards silently.** Spending from a dedicated account lowers the goal with no warning, no confirmation and no lock. Nothing marks the account as off-limits at the point of spend.
- **Progress now depends on ledger completeness.** An external transfer into the dedicated account that was never entered in WageRoute is invisible; conversely a routed allocation that was never actually transferred is now ignored. The number reads the ledger, so an incomplete ledger is a wrong goal.
- **Allocation rows for a dedicated goal become dead data.** They are excluded from the display, not deleted or migrated, so a goal that gains a dedicated account appears to lose the history of what was routed into it.
- **Safe to Spend now needs two different goal totals.** All goal money (`selectFundedGoalsCents`, for the meter measured against cash) and pool-funded goal money (`poolEarmarkedGoalsCents`, for the deduction). The first draft used the all-goals number for both and deducted dedicated money twice: $1,200 in checking plus $4,200 in a dedicated savings account showed Safe to Spend as **−$3,000**. It was caught by driving the built app over CDP, not by the type checker or the tests, because the composition lives in a selector and each half was individually correct.
- **`emergencyCoverageMonths` and Safe to Spend shift for anyone who dedicates an account**, including the emergency fund the calculator itself creates.
- **A v4 backup will not open in an older build.** `parseBackupJson` rejects `version > SCHEMA_VERSION`, so exporting from this build and importing into v1.0.2 is refused by design, not by accident.
- **No downgrade path.** v4 has no reverse migration; installing an older build after opening the database leaves the extra columns ignored, which is survivable but untested.
- **The UI has no component tests.** The account dialog's new controls, the goal funding-source chip and the wealth strip were verified by driving a built app over CDP against a disposable profile — a one-time manual walk, not a test that re-runs. A future change to that markup can break these surfaces without anything failing.

### Neutral

- The `in_safe_to_spend` column is per-account and per-user; there is no global setting, no per-currency rule, and no history of the choice.
- A goal may still have `goals.account_id` (the account it is *paid out of*) independently of any account dedicated to it. The two links mean different things and are not cross-validated.
- `starting_balance_cents` remains the only non-entry source of a balance; dedicating an account does not re-baseline it.

## Alternatives considered

### Claim the balance once, then let allocations rule (recommended by the agent)

Rejected outright by the owner. It preserves the invariant and produces the "emergency money shows zero" behaviour that started this. Any variant of "sweep into the goal" — a button, a wizard step, a top-up row — keeps a manual step between the bank and the screen, which is exactly the gap being complained about.

### Declare `dedicated_goal_id TEXT REFERENCES goals(id)`

Rejected: creates an `accounts` ↔ `goals` cycle, so `TABLE_ORDER` cannot restore a backup that uses the feature at all. Verified by the round-trip test in `src/shared/backup-merge.test.ts`, which depends on there being no constraint.

### Put the pointer on the goal (`goals.dedicated_account_id`)

Rejected. One goal often has two accounts (an emergency savings account and a cash stash), a goal-to-one-account shape cannot express that, and the owner asked for the choice to live in the **account** menu — "an option in the menu for THIS ACCOUNT IS MEANT ONLY FOR THIS".

### Store the funded amount on the goal row and update it on every entry

Rejected as denormalisation that can drift. Reading the balance keeps one source of truth; a cached column would need triggers or a write path in every entry mutation.

### A separate `goal_topups` table

Rejected. It re-adds the manual step, and would still have to reconcile against a real balance to answer "how much is actually there".

### Treat dedicated accounts as spendable and let the user manage overlap

Rejected. It double counts in the Safe-to-spend maths and produced the negative-figure class of bug the app already suffers from; the default excludes them and the user may override per account.

## References

- [src/main/db/migrations.ts](../../src/main/db/migrations.ts) — `SCHEMA_V4` and the reasoning recorded beside it
- [src/shared/accounts.ts](../../src/shared/accounts.ts) — `countsInSafeToSpend`, `safeToSpendPoolCents`, `poolEarmarkedGoalsCents`, `totalWealthCents`, `wealthBuckets`
- [src/shared/allocator.ts](../../src/shared/allocator.ts) — `AllocatorGoal.fundedFrom` and the allocatable filter
- [src/main/db/repositories.ts](../../src/main/db/repositories.ts) — `requireGoal`, `listGoals` progress override, `deleteGoal` detach, `flagColumn`
- [src/shared/accounts.test.ts](../../src/shared/accounts.test.ts) — pool, wealth, bucket-partition and allocator rules
- [src/main/db/dedicated-accounts.test.ts](../../src/main/db/dedicated-accounts.test.ts) — round-trip, replace-not-add, archive release, goal removal detach
- [src/renderer/src/screens/Accounts.tsx](../../src/renderer/src/screens/Accounts.tsx) — "Mine only for" and the Safe-to-spend tri-state
- [src/renderer/src/screens/Dashboard.tsx](../../src/renderer/src/screens/Dashboard.tsx) — the total wealth strip

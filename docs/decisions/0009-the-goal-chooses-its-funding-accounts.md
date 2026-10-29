# 0009. The goal chooses its funding accounts

- **Status:** Accepted
- **Date:** 2026-10-28
- **Deciders:** Project owner
- **Supersedes:** `settings.emergencyAccountIds`, the per-user list of account ids that the emergency card kept in settings, and the account dialog being the only place the link could be set
- **Related:** [ADR 0002](0002-integer-cents.md), [ADR 0007](0007-dedicated-accounts-balance-is-progress.md), [ADR 0008](0008-one-check-carries-the-month.md), [DATA-MODEL.md](../DATA-MODEL.md), [FEATURES.md](../FEATURES.md)

## Context

[ADR 0007](0007-dedicated-accounts-balance-is-progress.md) established that a dedicated account's balance *is* the goal's progress, and stored the pointer on the account (`accounts.dedicated_goal_id`). It also gave the emergency card its own list of account ids in settings, `emergencyAccountIds`, so the emergency fund could be pointed at several accounts without going through the account screen one at a time. Two things went wrong with that shape.

The first was reported with a screenshot. The Sinking funds screen showed money from accounts that had nothing to do with the emergency fund counted towards the emergency cadence — "there should only be one account that contributes to the 'Emergency' or at least an option to select one or multiple that contain the Emergency allocated funds". The list in settings answered the second half of that sentence but not the first: it lived on a different screen from the goal it described, so the set was not visible while looking at the goal, could not be seen at all from any other goal, and had no relationship to the per-goal dedicated accounts. Two sources of truth for one number.

The second was the label. The option that opens a multi-select was rendered with the owner's own complaint text as its literal label, which reads as a sentence rather than a control ("select many accounts" was the correction asked for).

The owner was then asked where the relation should live and answered: **the goal picks its accounts, one or several.** That answer is this decision. It is not a UI rearrangement — it moves ownership of the funding relation from settings to the goal, and the code had to follow in three places at once.

## Decision

### One relation, stored on the account, written from the goal

`accounts.dedicated_goal_id` remains the only stored form of the relation. The goal screen writes it; the account screen writes the same column from the other side. There is no second table and no second column. `settings.emergencyAccountIds` was deleted outright rather than deprecated: no released build ever wrote that key, so keeping it would have meant reconciling a dead setting against the live relation forever. `parseSettings` reads a fixed set of keys from the settings table, so a row an older draft left behind is simply ignored, and nothing sends it any more.

`GoalInput.fundingAccountIds` carries the intent across IPC:

- **omitted** — leave the existing binders alone. Used by every goal edit that is not about funding;
- **an empty array** — release every binder. This is a real choice and is distinguishable from "not asked";
- **a list of ids** — this is exactly the set that funds the goal.

Three states, not two, because a partial patch and a deliberate clearance are different requests and the renderer cannot express the second with `undefined`.

### The whole save is one transaction

`createGoal` and `updateGoal` run `applyFundingAccounts` inside the same `db.transaction` as the goal row write. The function clears every current binder first, then re-points each requested account:

```
UPDATE accounts SET dedicated_goal_id = NULL WHERE dedicated_goal_id = ? AND user_id = ? AND deleted_at IS NULL
UPDATE accounts SET dedicated_goal_id = ?   WHERE id = ? AND user_id = ? AND deleted_at IS NULL AND is_archived = 0
```

The second statement is checked for `changes === 0` and throws `Archived accounts cannot fund a goal`, and an unknown id throws in `requireAccount` before it. Because both run inside the transaction, a rejected account rolls the entire save back rather than leaving a goal half-bound — which is the behaviour the tests assert (`unknown account rolls back`). A newly created goal therefore cannot exist with a target and no funding set, and a failed binding cannot leave some ticked accounts pointing at the goal and others not.

There is no ordering problem to solve: `dedicated_goal_id` deliberately carries no declared foreign key ([ADR 0007](0007-dedicated-accounts-balance-is-progress.md)), so pointing an account at a goal created in the same transaction is legal at the moment it is written.

### Several accounts are allowed; the common case is one

Progress remains `max(0, sum of live dedicated balances)` — ADR 0007's rule is unchanged, and this decision only changes who may set it. The picker is a single dropdown by default, because one funding account is what most goals have, with a **"Let several accounts add up together"** checkbox that swaps it for a tick list. An account that already funds a *different* goal is labelled `(funds That Goal)` in both views, so moving an account is a visible decision rather than a silent steal; the clear-then-repoint above means the previous goal genuinely loses it.

The label was the owner's wording request, and it names the mechanism (several accounts add up) instead of the complaint.

### Nothing else about a goal is inferred from its funders

**Deposit account** (`goals.account_id`) stays an independent, informational link — where the finished lump gets spent — and is never written by the funding picker. The two are not cross-validated, exactly as ADR 0007 recorded. A goal flagged `is_emergency` is still just a goal with a marker; being the emergency fund no longer confers any account set of its own.

## Consequences

### Positive

- **One place to look.** The set of accounts behind a number is visible on the card showing that number, and the card lists each contributing account with its own balance, so the sum is never a black box.
- **The same relation from both screens.** The account dialog's "Mine only for" pointer and the goal's **Funded by** picker read and write one column; they cannot disagree.
- **Atomic saves.** Goal row and binders commit or roll back together; the archived and unknown-account cases are tested against real in-memory SQLite.
- **No dead settings key.** The settings allowlist no longer carries an emergency account list, and the emergency card does not need to keep one.
- **Other goals stop absorbing emergency money.** Since the emergency fund is one goal among several and each goal owns its own binder set, an account ticked for the emergency fund is not counted towards a different goal's cadence.

### Negative

- **An account can still fund only one goal at a time.** `dedicated_goal_id` is a single column, so ticking an account that belongs to another goal moves it. This is intended, and documented as invariant 11 in [DATA-MODEL.md](../DATA-MODEL.md), but it means the picker is also a steal and the UI has to say so.
- **Three-state patch semantics are easy to get wrong.** A caller that means "clear" and passes `undefined` instead of `[]` leaves the binders untouched. The distinction lives in a comment and in the IPC type, not in the database.
- **`emergencyAccountIds` is gone with no migration.** Any draft database that had written it simply stops reading it; the accounts keep whatever `dedicated_goal_id` they have, so an id that was only ever in settings and never dedicated does show as unbound. No released build was ever able to write that key, so no user data is affected.
- **The relation is invisible outside the goal screen until it is set.** A goal with no funders reads its allocation total and gives no hint that accounts exist which could fund it.
- **The renderer picker has no component test.** Dropdown/tick-list switching, the `(funds That Goal)` label and the pause copy were verified by driving a built app over CDP against a disposable profile — a one-time manual walk, not a test that re-runs.

### Neutral

- The picker lists savings, checking and cash accounts. Credit and investment accounts are not offered as funders, which is a UI rule, not a database constraint.
- Archiving or deleting a goal detaches its binders (ADR 0007's `deleteGoal` behaviour is unchanged); archiving an account releases it from the progress sum without needing the goal to be re-saved.
- Several funders add together, so a goal fed by two accounts shows one number; there is no per-account target or split percentage.

## Alternatives considered

### Keep `settings.emergencyAccountIds` as the emergency source of truth

Rejected. It is a second answer to a question the goal already answers, it lives on a different screen from the number it produces, and it cannot be expressed for any non-emergency goal. The owner's report of unrelated money appearing in the emergency cadence came from that split.

### A `goal_funding_accounts` join table

Rejected. It would allow one account to fund several goals, which is precisely the ambiguity being removed — an emergency savings account is the same dollars as a holiday goal. It also re-introduces the backup restore-order problem that the nullable pointer avoids ([ADR 0007](0007-dedicated-accounts-balance-is-progress.md)).

### Put the pointer on the goal (`goals.dedicated_account_id`)

Rejected, and rejected once already in ADR 0007. One goal often has two accounts (an emergency savings account plus a cash stash); a goal-to-one-account shape cannot express that, and it would make "several accounts add up together" impossible without a second table.

### Let the account dialog remain the only editor

Rejected as the state before this change. Setting the relation requires visiting each account in turn, never shows the goal's own set, and cannot release "all but one" in a single action.

### Store a per-account percentage of the goal

Rejected. The balances already decide the split, so a percentage would be a second number that can drift from the money.

## References

- [src/shared/types.ts](../../src/shared/types.ts) — `GoalInput.fundingAccountIds`, `GoalWithProgress.dedicatedAccounts`
- [src/main/db/repositories.ts](../../src/main/db/repositories.ts) — `applyFundingAccounts`, `createGoal`, `updateGoal`, `deleteGoal`
- [src/shared/settings.ts](../../src/shared/settings.ts) — `parseSettings`, the fixed set of keys a draft `emergencyAccountIds` row can no longer reach
- [src/main/db/dedicated-accounts.test.ts](../../src/main/db/dedicated-accounts.test.ts) — created-then-tick, re-save releases, tick moves, unknown account rolls back, archived refused
- [src/renderer/src/screens/Goals.tsx](../../src/renderer/src/screens/Goals.tsx) — `FundingAccountsPicker` (dropdown, multi tick list, `(funds That Goal)` label), the goal card funder list, the emergency card picker and pause copy
- [docs/DATA-MODEL.md](../DATA-MODEL.md) — invariant 11, one account funds one goal

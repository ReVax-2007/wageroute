# 0021. A goal carries its own pace

- **Status:** Accepted
- **Date:** 2026-11-02
- **Deciders:** Project owner
- **Related:** [ADR 0007](0007-dedicated-accounts-balance-is-progress.md), [ADR 0009](0009-the-goal-chooses-its-funding-accounts.md), [DATA-MODEL.md](../DATA-MODEL.md), [FEATURES.md](../FEATURES.md)

## Context

The allocator treats a sinking fund as a standing claim on every paycheck's goal slice. It sorts goals by priority and target date and funds each remaining need until the slice is used up. There was one escape hatch: a global pause on the emergency fund (`emergencyActive`), and it applied only to that goal.

The owner's report was concrete: sinking funds were "causing problems with paychecks, and taking money out even if not needed". A goal the user did not want funded this month still consumed the slice; a goal with a distant target date was drained as fast as the slice allowed; and the only way to stop either was to remove the goal or reduce the global goal percentage, which changed every other goal too. The owner chose the option "give user option for what to do" — the behaviour has to be a property of each goal, not a global switch.

## Decision

**Each goal stores its own funding pace, `goals.funding_pace` (schema 10).**

| Pace | What the allocator does |
| --- | --- |
| `asap` | Takes as much of the remaining need as the goal slice allows — the pre-v10 behaviour |
| `by_date` | Caps this paycheck at `ceil(remaining / checksLeft)`, where `checksLeft` is the number of pay periods between the paycheck date and `target_date` |
| `paused` | Removes the goal from the eligible list entirely; target, progress and card stay intact |

- The default is `asap` and the migration writes it to every existing goal, so an upgraded database routes exactly the same money as schema 9 on the same cheque.
- `by_date` needs a target date. A goal with no date falls back to `asap` rather than inventing a deadline.
- The pace is enforced in the shared allocator (`paceAllowanceCents`), not in the screen, so the plan, the preview and the recorded allocations cannot disagree.
- `paused` is separate from `is_archived` ([ADR 0015](0015-archive-is-not-delete.md)): an archived goal is gone from activity and pickers, while a paused goal is visible and keeps everything except paycheck funding.
- The existing emergency switch keeps its meaning. `emergencyActive` remains the emergency card's own pause control and is reflected in the emergency goal's pace; there is no second, conflicting flag on the goal row.

## Alternatives considered

- **A per-goal amount instead of a pace.** The owner would type "fund $X this month", which asks the user to do the allocator's arithmetic and goes stale the next cheque.
- **A global "fund goals" toggle.** It repeats the emergency switch's limitation: pausing one goal would pause all of them.
- **Inferring the pace from the target date.** Treating every dated goal as `by_date` would silently change the allocations of existing goals on upgrade, contrary to the additive-migration rule ([ADR 0003](0003-additive-imports.md)); a goal dated far away may still deserve to be filled first for interest or safety.

## Consequences

- A user can stop a goal draining a paycheck without deleting it or touching the global split.
- A dated goal can arrive on time without taking more than its share now, which also leaves more of the goal slice for lower-priority goals.
- `by_date` is a *cap*, not a guarantee: if the paycheck's goal slice is smaller than the allowance, or other goals consume it first, the goal falls short of its date. The card keeps showing the monthly pace so the gap is visible.
- Pausing a goal may move money to savings, investments or debt on the next cheque; the plan preview says so before anything is recorded.
- Schema 10 is forward-only and additive; a v9 backup restores into it with every goal defaulting to `asap`.

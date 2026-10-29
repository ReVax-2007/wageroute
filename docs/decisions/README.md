# Architecture decision records

Short, dated records of the choices that are expensive to reverse. Each ADR states the context, the decision, the consequences and the alternatives that were rejected. When a decision changes, add a new ADR that supersedes the old one; do not rewrite history.

| ADR | Decision | Status |
| --- | --- | --- |
| [0001](0001-local-first-desktop.md) | Local-first desktop app with no backend | Accepted |
| [0002](0002-integer-cents.md) | Store money as integer cents | Accepted |
| [0003](0003-additive-imports.md) | Imports add data; they never replace it | Accepted |
| [0004](0004-sync-ready-schema.md) | Prepare the schema for sync without implementing sync | Accepted as preparation only |
| [0005](0005-wageroute-rename.md) | Rename to WageRoute and adopt legacy data | Accepted |
| [0006](0006-import-wizard-asks-instead-of-failing.md) | Imports ask instead of failing: preview/confirm wizard with per-row repair | Accepted |
| [0007](0007-dedicated-accounts-balance-is-progress.md) | A dedicated account's balance is the goal's progress | Accepted |
| [0008](0008-one-check-carries-the-month.md) | One paycheck can carry a whole month's bill obligation | Accepted |
| [0009](0009-the-goal-chooses-its-funding-accounts.md) | The goal chooses its funding accounts, one or several | Accepted |
| [0011](0011-the-pay-cycle-is-a-setting.md) | The pay cycle is a setting, and its last check is guaranteed | Accepted |
| [0012](0012-the-wall-remembers-its-claims.md) | The Priority Wall remembers its claims: `bill_reserves`, per month, reserved → paid | Accepted |
| [0013](0013-a-route-is-a-plan-not-a-movement.md) | A route is a plan, not a movement: the app never moves money | Accepted |

Number `0010` is reserved for the still-undecided "restore from file" mode (replace rather than merge); do not use it for another decision. The gap in the sequence is deliberate.

[ADR 0008](0008-one-check-carries-the-month.md) and [ADR 0009](0009-the-goal-chooses-its-funding-accounts.md) both change what a released screen means, so neither is a bug fix: 0008 replaces one reserve rule with four, and 0009 moves the funding relation off settings and onto the goal. Both shipped together with schema version 5 (PR #16, `100bc65`). [ADR 0011](0011-the-pay-cycle-is-a-setting.md) adds the fifth collector, makes the pay cycle editable in Settings, and carries schema version 6. [ADR 0012](0012-the-wall-remembers-its-claims.md) adds `bill_reserves` and carries schema version 7; [ADR 0013](0013-a-route-is-a-plan-not-a-movement.md) records the boundary between a plan and a ledger movement that 0012 depends on.

## Conventions

- **Status** is one of `Proposed`, `Accepted`, `Superseded by ADR NNNN`, `Deprecated`.
- **Date** is the date the decision was accepted, in `YYYY-MM-DD`.
- An ADR describes the decision at the time it was made. Later changes belong in a new ADR, even if the old one is edited for typos.
- Implementation details live in the reference docs ([ARCHITECTURE.md](../ARCHITECTURE.md), [DATA-MODEL.md](../DATA-MODEL.md), [DEPLOYMENT.md](../DEPLOYMENT.md)); the ADR explains *why*.

# 0011. The pay cycle is a setting, and its last check is guaranteed

- **Status:** Accepted
- **Date:** 2026-10-29
- **Deciders:** Project owner
- **Extends:** [ADR 0008](0008-one-check-carries-the-month.md) — a fifth collector, and the cycle it collects on becomes editable
- **Related:** [ADR 0002](0002-integer-cents.md), [DATA-MODEL.md](../DATA-MODEL.md), [FEATURES.md](../FEATURES.md), [DEVELOPMENT.md](../DEVELOPMENT.md)

## Context

[ADR 0008](0008-one-check-carries-the-month.md) gave a bill four ways to choose the paycheck that carries its month. Three things were still missing once it shipped:

- **No "last check" option.** A bill due on the 28th is naturally paid from the last check before it, and the four existing options could only reach that check by *closest to the due date* (which moves with the due day) or by naming a slot by hand (which the user has to recompute when the cadence changes).
- **The cycle was only editable in the allocator.** `payCadence` was written when a paycheck was routed, from inside step 1 of the wizard, so the wall could not be configured without routing a paycheck, and there was nowhere to say *which days* the user is actually paid. The owner asked for "label payday/pay frequency" directly.
- **The split controls could over-allocate.** Four independent 0–100 inputs could total 400%. The allocator scaled the excess away with largest-remainder apportionment and the wizard disabled **Route** with "Splits exceed 100%", but both are after-the-fact: the user could still type a number that could not be honoured, and the slider let them.

The owner's instruction was one batch: *"add a last check of the month (or depending on when user gets payed (add feature to label payday/pay frequency too) to go to closest), allow to add a default account for paychecks, for routing the surplus set max to 100% (can't select more of another account to route to if there is no remaining space)"*.

## Decision

### "Last check" means the last **guaranteed** check, not the calendar's last one

Biweekly pay produces a 3rd check in some months and weekly a 5th. A bill funded on a slot that does not exist in a given month would silently go unreserved for that month — the same failure [ADR 0008](0008-one-check-carries-the-month.md) clamped out of the "Which paycheck?" list. So `last_check` resolves to `GUARANTEED_CHECKS_PER_MONTH[cadence]`:

| Cadence | Slots a month is guaranteed | `last_check` funds on |
| --- | --- | --- |
| Monthly | 1 | 1st |
| Semimonthly | 2 | 2nd |
| Biweekly | 2 | 2nd |
| Weekly | 4 | 4th |

In a biweekly month with three checks, the bill is funded on the **second** and the third carries nothing. That is a deliberate loss of "the last cheque I actually got" in exchange for "the bill is funded in February", which matches the whole point of the reserve: the obligation must be collected, not merely scheduled. The dialog hint says so in words — "the last check your pay cycle is guaranteed to have every month" — rather than leaving the user to discover it.

The option is listed fifth, after the owner's original four, so the numbering they asked for in [ADR 0008](0008-one-check-carries-the-month.md) is unchanged.

### The enum widened, so schema 6 rebuilds `bills`

`funding_strategy` is a `CHECK`ed column. SQLite cannot alter a CHECK constraint, so migration 6 copies `bills`, drops the old table and renames — the same rebuild shape as migration 2 for `allocations`. The difference is that `transactions.bill_id` **references** `bills(id)`, and this SQLite build (better-sqlite3's bundled engine, with `foreign_keys = OFF`) still rewrites that `REFERENCES` clause during `ALTER TABLE … RENAME`, pointing the ledger at the renamed-away table and then failing at `DROP`. The recipe that works — and the one `migrate()` now encodes — is:

1. `PRAGMA foreign_keys = OFF` **and** `PRAGMA legacy_alter_table = ON`, both **outside** the transaction, because both pragmas are no-ops inside one;
2. inside a transaction: rename, create, copy by id, drop, recreate `idx_bills_sync`;
3. run `PRAGMA foreign_key_check` **inside** the transaction and throw on any violation, so a bad copy rolls back instead of committing a broken ledger;
4. restore both pragmas in `finally`.

The migration is declared `rebuildsReferencedTable`, a flag that makes the runner suspend referential enforcement for exactly that step. `src/main/db/migrations.test.ts` pins the behaviour: rows, defaults and the index survive; `last_check` is accepted and `sometimes` is not; a bill still cannot be deleted while a transaction references it; and a pre-seeded dangling `bill_id` makes `migrate()` throw, roll back to version 5, restore enforcement and leave `bills` un-widened.

No column is added, no default changes, and every stored strategy stays what it was — so an upgraded database moves no number.

### The pay cycle is a Settings card; the label never does arithmetic

Settings → **Paycheck** edits `payCadence`, a free-text `paydayLabel` (`"15th and last day"`) and `defaultDepositAccountId`. The cadence is the same key the wall and the allocator read; moving its editor does not fork the value. The label is **display only** — it appears on the wall's reserved-per-paycheck hint and in the allocator's step-1 hint, and no formula reads it. It is not parsed into dates on purpose: a parser would have to guess at "last day", "every other Friday" and "15th and 30th", and a wrong guess would move money silently. A label that cannot move money cannot be wrong about it.

The default deposit account is preselect-only. The allocator resolves it as *the chosen non-archived account, else the first non-archived checking account, else the first non-archived account*, so a pointer to an archived or deleted account degrades to the old behaviour instead of blocking a paycheck. The selection is not treated as a write of the deposit: the route still records whichever account the payload names.

### The split cap is enforced by the control, not after it

Each of the four split rows is capped at **100 minus the other three**. With debt at 90 the other three sliders stop at 10, and typing 100 into savings snaps to 10. Space freed by lowering one bucket is immediately available to the others, so the cap never strands the user.

The existing guards stay: the domain layer still clamps each value to 0–100, the allocator still scales with largest-remainder when a *caller* asks for more than 100, and the wizard still disables **Route** with "Splits exceed 100%". Those paths now cover state the UI cannot create — settings imported or hand-written above 100% — rather than state the user typed a moment ago.

## Consequences

### Positive

- A bill due near the end of the month can be funded by the last check without naming a slot, and stays funded in short months.
- The pay cycle is configurable where users look for it, and the payday label makes the wall's cadence line read like the user's own calendar without becoming a second source of truth.
- The allocator stops offering a 100%-plus plan it would only have scaled back, so the number the user types is the number that routes.
- The v6 rebuild is now a tested recipe with an in-transaction foreign-key gate; the next CHECK widening on a referenced table has a working pattern instead of a rediscovery.

### Negative

- **`last_check` is not "the last cheque you received".** In a three-check biweekly month it funds on the second. A user who reads the label literally will be surprised once a quarter; the hint is written to prevent that, but it is a real gap between the label and the mechanics.
- **The payday label can drift from reality** with no warning, because nothing validates it against routed paycheck dates. It is honest only as long as the user keeps it current.
- **A table rebuild is the riskiest migration shape this app has.** It is guarded, tested and rolls back, but the window in which `foreign_keys` is off belongs to the whole process, not to the statement — `migrate()` restores it in `finally` and the app does no other work concurrently, which is the reason it is acceptable here.
- **The split cap changes what the UI can express.** A user who genuinely wanted savings 60 / investment 60 can no longer type it; they will get 60 / 40. The old behaviour (type it, watch it scale) was arguably more informative about the allocator's rule, and is now only visible to hand-edited settings.

### Neutral

- The repository layer validates `funding_strategy` against its own list; that list had to grow with the enum. It did not at first, and the CDP walk found a bill dialog that accepted "Last check of every month" and then silently kept the old strategy because the write path rejected the value before the CHECK constraint ever saw it. Two lists for one enum is the cost of validating at the boundary; the migration test now covers the database side and the walk covered the IPC side.
- No backup column was added, so `TABLE_DEFAULTS` and the importer's allowlist are unchanged by v6. Backup format version rises to 6 purely because `SCHEMA_VERSION` does.
- Goals, safe-to-spend and total wealth are untouched; the batch changes which check funds a bill and where the cycle is edited, not what anything is worth.

## Alternatives considered

### Make `last_check` the calendar's last check, optional slots included

Rejected: it reintroduces exactly the failure [ADR 0008](0008-one-check-carries-the-month.md) clamped away — a bill that reserves in January and not in February. The reserve model's promise is that the month is collected once, every month.

### Store the actual payday dates instead of a label

Rejected for now: it would need an import path, a drift rule and a calendar UI, and every consumer would then have to decide what to do when the stored dates run out. The cadence plus a display label answers "which check?" today; a real calendar is a larger feature that should be decided on its own.

### Validate the payday label against routed paychecks

Rejected: it turns a caption into a constraint, and a mismatched label would either block routing or produce a warning the user cannot silence without lying to the app. A label that is only a label cannot be wrong about money.

### Keep the allocator's scale-down as the only guard on splits

Rejected: it is the correct mathematical backstop and a poor input rule. The user sees a plan that differs from the percentages they typed and has to read the warning to learn why. Capping the control makes the constraint visible while the number is being chosen.

### Add `last_check` by rewriting the CHECK in place

Not possible in SQLite; there is no `ALTER TABLE … DROP CONSTRAINT`. The rebuild is the only route, and the ADR records how to do it on a referenced table safely.

## References

- [src/shared/cadence.ts](../../src/shared/cadence.ts) — `GUARANTEED_CHECKS_PER_MONTH`, `fundingCheckIndex`, `FUNDING_STRATEGY_LABEL`
- [src/shared/cadence.test.ts](../../src/shared/cadence.test.ts) — the last slot per cadence, "reserves there and nowhere else", the month-total invariant extended to five strategies
- [src/main/db/migrations.ts](../../src/main/db/migrations.ts) — `SCHEMA_V6`, `rebuildsReferencedTable`, the pragma handling in `migrate()`
- [src/main/db/migrations.test.ts](../../src/main/db/migrations.test.ts) — the rebuild, the rejection cases and the dangling-pointer rollback
- [src/main/db/repositories.ts](../../src/main/db/repositories.ts) — `BILL_FUNDING_STRATEGIES`
- [src/shared/settings.ts](../../src/shared/settings.ts) — `paydayLabel`, `defaultDepositAccountId`
- [src/renderer/src/screens/Settings.tsx](../../src/renderer/src/screens/Settings.tsx) — the Paycheck card
- [src/renderer/src/screens/Allocator.tsx](../../src/renderer/src/screens/Allocator.tsx) — `capFor`, `maxPercent`, the default-deposit fallback chain

# 0003. Imports add data; they never replace it

- **Status:** Accepted; amended by [ADR 0024](0024-two-copies-merge-by-time.md), which applies a newer copy of an existing row
- **Date:** 2026-10-27
- **Deciders:** Project owner
- **Supersedes:** none
- **Related:** [IMPORT-EXPORT.md](../IMPORT-EXPORT.md), [ADR 0001](0001-local-first-desktop.md), [ADR 0004](0004-sync-ready-schema.md), [ADR 0006](0006-import-wizard-asks-instead-of-failing.md) (keeps this decision's additive intent; replaces its fail-the-file behaviour on a defective row with an interactive per-row repair)

## Context

WageRoute has no sync. Data moves between machines by exporting and importing files, and users also bring in data that did not originate from a WageRoute backup at all: a CSV exported from a bank, a hand-built JSON file with a subset of transactions, or a backup from another person's ledger.

The obvious model is “restore”: replace the local database with the file. That is dangerous and often wrong here:

- the file may be a **partial** export (only transactions, only settings);
- the local ledger may already contain entries the file does not know about;
- a user may be importing into a ledger that is not empty, not into a fresh profile;
- the same file may be imported twice by accident;
- bank CSVs contain entries, not accounts, goals, paychecks or settings;
- “restore” implies destructive intent that a user may not have.

The owner explicitly framed the operation as an **add**, not a **RESTORE**. The design follows that.

## Decision

An import **merges** data into the existing ledger. It never deletes, truncates or replaces unrelated rows, and there is still no replace-the-database mode ([ADR 0010](0010-there-is-no-replace-mode.md)). [ADR 0024](0024-two-copies-merge-by-time.md) amends one point: a copy of an existing row from the file does replace the local row when it is newer.

### JSON backups

- The file may contain any subset of the ten tables (`accounts`, `balance_snapshots`, `categories`, `bills`, `goals`, `paychecks`, `allocations`, `bill_reserves`, `transactions`, `settings`). An absent table is treated as empty and leaves the local table untouched.
- Rows are merged by UUID. An id the local ledger does not hold is added — including a tombstone, so the id is taken and a later file cannot bring that row back under it. An id it does hold is replaced only when the file's copy is newer: `updated_at` decides, `revision` breaks a tie, and an older or equal copy is left alone.
- Account and paycheck UUIDs are preserved so cross-table links remain valid. A claim for a bill that is not live locally is reported and left out rather than inserted dangling; any other database refusal is recorded as an issue and the rest of the file still imports.
- Insert order is `accounts → balance_snapshots → categories → bills → goals → paychecks → allocations → bill_reserves → transactions → settings`, so references exist before they are used.
- Settings merge per key with the same newer rule. A key this build does not know, or a currency it cannot use, is refused with a reason. Into a profile with no history — a fresh install or the erase-then-restore path — the file's settings are adopted, because seeded defaults are not a choice the person made.
- Missing sync metadata on hand-written rows gets a safe default: `created_at` becomes the file's export time, `updated_at` falls back to `created_at`, `revision` becomes 1, and known v2-era missing columns get documented fallbacks. A stamp later than the file's export time is read as that export time, not as this device's clock.
- Categories are matched by name, so a file row whose name this profile already uses is linked to the local row instead of being added as a twin; a rename onto another live name is refused with a reason.
- The whole merge runs in one transaction. A refused row or a caught per-row error leaves the rest of the file in place; an unexpected failure rolls the whole import back.
- Re-importing a file that has already been merged is a no-op: every row is left as it is.

### CSV entries

- A CSV is an **entries-only** import. It does not create accounts, bills, goals or paychecks.
- Each row becomes a new transaction with a **new UUID**. Account rows are matched by name, narrowed by institution when both match; links to bills, goals, paychecks and counter-accounts are left `NULL`.
- Round-up is **not** applied. Imports are direct inserts, not spending events.
- Transfers are skipped with an issue message; pairing them automatically would require guessing the other leg.
- Deduplication uses a fingerprint of `[accountId, kind, amountCents, occurredOn, memo, category]`. A matching existing row is skipped; a changed memo defeats the match and can create a duplicate.
- The file is still bounded by the 64 MiB cap and parsed with the RFC 4180-style reader.

### UI and reporting

- The action is called **Import data**, not “Restore”.
- The result reports per-table `added`, `updated`, `removed` and `skipped` counts, plus issues (line number and reason).
- A refused row is reported; the rest of the file still imports. An unexpected failure applies none of it.

## Consequences

### Positive

- **Safe by default.** Importing the wrong file, or importing twice, does not wipe the ledger.
- **Partial files work.** A transactions-only export, a settings-only file and a hand-built entries file are all valid.
- **Idempotent for backups.** The same UUID set can be replayed without duplicates.
- **Composable.** A user can consolidate two machines by importing either ledger into the other; the result is the union, with the newer copy of any shared row winning.
- **No destructive confirmation dialog.** Nothing is ever deleted wholesale, so the risk of a mis-click is lower.
- **CSV path is useful for real bank exports**, which are entry lists rather than app backups.

### Negative

- **It is not a restore.** Importing an old backup into a ledger that has diverged will not undo newer local edits or a newer local delete. Missing rows are added, but older copies are left alone. The result is not a point-in-time snapshot.
- **An older file cannot correct a newer edit.** The newer copy of a row wins on either side, so to change a row, edit it here or import a file whose copy is newer.
- **Conflicting edits are silent.** If both machines edited the same row, one version wins by stamp and the other is not shown; there is no conflict dialog.
- **Tombstones are imported.** A row deleted on the source — including one this ledger never held — is stored with `deleted_at` set, so it stays hidden and its id is taken. “Deleted” data can therefore travel in backups.
- **Duplicate accounts are possible.** IDs are authoritative, not names; two accounts with the same name and institution can coexist if their IDs differ.
- **A refused link costs the row, not the file.** A claim whose bill is not present locally is left out with a reason; a dangling link is never written.
- **CSV dedupe is heuristic.** A genuinely new purchase that is identical to an existing row (same account, kind, amount, date, memo and category) can be skipped as if it were a re-import, while editing a memo or category makes the same economic event look new.
- **No provenance.** There is no signature, checksum or source marker per row. Imported data is indistinguishable from locally entered data after the fact.
- **Large imports still cost time and disk.** The caps bound the damage but do not make a 200,000-row table instant.

### Neutral

- The backup format marker remains `cash-flow-routing-backup` for compatibility, even though the app is now WageRoute.
- Settings that are absent from the file are not reset; existing values remain.
- The import summary is informational; there is no undo command. The recovery path is a database copy or a known-good backup.

## Alternatives considered

### Destructive restore (replace the database)

Rejected. It is a different operation with a much higher blast radius, and it breaks the common case of importing a partial file. If a true restore is needed, the documented path is to quit the app and copy a database file into place, keeping the old one in a quarantine folder.

### Upsert by ID (insert or update)

Rejected here, later adopted with a guard. Plain upsert would let an old file overwrite newer local edits. [ADR 0024](0024-two-copies-merge-by-time.md) keeps the insert-or-update shape but applies the file's row only when its own stamp is newer, so an older file still cannot revert an edit. Conflict semantics remain "the newer copy wins", with no per-field merge.

### Replace-by-table (clear the table, then insert)

Rejected. It destroys local rows that are not in the file, which is exactly the failure this decision is designed to prevent.

### Merge by name or fingerprint for JSON

Rejected. UUIDs already provide stable identity for app-generated rows. Name matching is ambiguous (two “Savings” accounts, renamed institutions) and fingerprint matching is already heuristic in the CSV path. Applying heuristics to structural rows would create silent merges that are hard to explain.

### Remote sync instead of files

Not adopted. It would change the trust model, require an identity and conflict policy, and contradict the local-first decision ([ADR 0001](0001-local-first-desktop.md)). Files remain the transport.

## References

- [src/main/db/backup.ts](../../src/main/db/backup.ts) — allowlists, fallbacks, merge order, newer-wins by id, settings merge, category relink
- [src/shared/tableMerge.ts](../../src/shared/tableMerge.ts) — the shared newer-wins comparison and the phone's merge
- [src/main/db/entries.ts](../../src/main/db/entries.ts) — CSV entry merge, new UUIDs, fingerprint dedupe
- [src/shared/csv.ts](../../src/shared/csv.ts) — parser, aliases, dates, kinds, export
- [src/main/ipc.ts](../../src/main/ipc.ts) — import dialog, size cap, result shape
- [IMPORT-EXPORT.md](../IMPORT-EXPORT.md) — formats, semantics, worked examples and limits

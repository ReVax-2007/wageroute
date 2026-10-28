# 0003. Imports add data; they never replace it

- **Status:** Accepted
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

An import **merges** data into the existing ledger. It never deletes, truncates or replaces unrelated rows.

### JSON backups

- The file may contain any subset of the seven tables. An absent table is treated as empty and leaves the local table untouched.
- Rows are inserted only if their UUID does not already exist for the local user. Existing IDs are skipped, not updated.
- Account and paycheck UUIDs are preserved so cross-table links remain valid. Links to rows that are absent locally fail the foreign-key check and abort the transaction.
- Insert order is `accounts → bills → goals → paychecks → allocations → transactions → settings`, so references exist before they are used.
- Settings use `INSERT OR IGNORE`: if a key already exists locally, the local value wins. Unknown keys are stored but ignored by the UI.
- Missing sync metadata on hand-written rows gets a safe default: `created_at`/`updated_at` become now, `revision` becomes 1, and known v2-era missing columns get documented fallbacks.
- The whole merge runs in one transaction. Any failure rolls back every row from that import.
- Re-importing the same file is a no-op: every row is skipped by ID.

### CSV entries

- A CSV is an **entries-only** import. It does not create accounts, bills, goals or paychecks.
- Each row becomes a new transaction with a **new UUID**. Account rows are matched by name, narrowed by institution when both match; links to bills, goals, paychecks and counter-accounts are left `NULL`.
- Round-up is **not** applied. Imports are direct inserts, not spending events.
- Transfers are skipped with an issue message; pairing them automatically would require guessing the other leg.
- Deduplication uses a fingerprint of `[accountId, kind, amountCents, occurredOn, memo, category]`. A matching existing row is skipped; a changed memo defeats the match and can create a duplicate.
- The file is still bounded by the 64 MiB cap and parsed with the RFC 4180-style reader.

### UI and reporting

- The action is called **Import data**, not “Restore”.
- The result reports per-table `added` and `skipped` counts, plus CSV issues (line number and reason).
- Import errors are shown without partially applying the file.

## Consequences

### Positive

- **Safe by default.** Importing the wrong file, or importing twice, does not wipe the ledger.
- **Partial files work.** A transactions-only export, a settings-only file and a hand-built entries file are all valid.
- **Idempotent for backups.** The same UUID set can be replayed without duplicates.
- **Composable.** A user can consolidate two machines by importing one ledger into the other; the result is the union.
- **No destructive confirmation dialog.** The operation is additive, so the risk of a mis-click is lower.
- **CSV path is useful for real bank exports**, which are entry lists rather than app backups.

### Negative

- **It is not a restore.** Importing an old backup into a ledger that has diverged will not remove newer rows, undo deletions, or revert edits. The result is a union, not a point-in-time snapshot.
- **Existing rows cannot be corrected by import.** There is no upsert. To change an imported row, edit it in the UI or delete it locally (soft delete) before importing a replacement with a new ID.
- **Divergent ledgers never converge.** If both machines edited the same account, import keeps both versions of the affected rows under different IDs or skips one version entirely. There is no conflict resolution.
- **Tombstones are imported.** A row deleted on the source is inserted with `deleted_at` set, so it stays hidden. “Deleted” data can therefore travel in backups.
- **Duplicate accounts are possible.** IDs are authoritative, not names; two accounts with the same name and institution can coexist if their IDs differ.
- **Foreign-key strictness cuts both ways.** A partial file that references a bill or paycheck not present locally aborts the entire import. That is safer than dangling links but less forgiving.
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

Rejected for now. It would let an old file overwrite newer local edits and would make “import” silently destructive in a different way. It also complicates conflict semantics without solving divergence. A future sync layer may need revision-based conflict handling; that is a separate decision ([ADR 0004](0004-sync-ready-schema.md)).

### Replace-by-table (clear the table, then insert)

Rejected. It destroys local rows that are not in the file, which is exactly the failure this decision is designed to prevent.

### Merge by name or fingerprint for JSON

Rejected. UUIDs already provide stable identity for app-generated rows. Name matching is ambiguous (two “Savings” accounts, renamed institutions) and fingerprint matching is already heuristic in the CSV path. Applying heuristics to structural rows would create silent merges that are hard to explain.

### Remote sync instead of files

Not adopted. It would change the trust model, require an identity and conflict policy, and contradict the local-first decision ([ADR 0001](0001-local-first-desktop.md)). Files remain the transport.

## References

- [src/main/db/backup.ts](../../src/main/db/backup.ts) — allowlists, fallbacks, merge order, skip-by-ID, settings insert-or-ignore
- [src/main/db/entries.ts](../../src/main/db/entries.ts) — CSV entry merge, new UUIDs, fingerprint dedupe
- [src/shared/csv.ts](../../src/shared/csv.ts) — parser, aliases, dates, kinds, export
- [src/main/ipc.ts](../../src/main/ipc.ts) — import dialog, size cap, result shape
- [IMPORT-EXPORT.md](../IMPORT-EXPORT.md) — formats, semantics, worked examples and limits

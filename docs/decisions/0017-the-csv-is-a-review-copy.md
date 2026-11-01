# 0017. The CSV is a review copy, not a backup

- **Status:** Accepted
- **Date:** 2026-10-31
- **Deciders:** Project owner
- **Related:** [ADR 0003](0003-additive-imports.md), [ADR 0010](0010-there-is-no-replace-mode.md), [IMPORT-EXPORT.md](../IMPORT-EXPORT.md)

## Context

WageRoute offers two exports: a JSON backup that carries every table, and a transactions CSV for opening the ledger in a spreadsheet. The CSV has repeatedly been mistaken for the backup — its name is friendlier, and a spreadsheet is what many users actually want. It cannot be one: a transfer is two ledger rows with a shared group id, a category is a link and a label, and settings and reserves have no row-per-transaction shape at all.

The audit asked for the contract to be written down: what the CSV contains, what import accepts, how the 500-row screen cap relates to the export, and how formula injection is prevented.

## Decision

### Export

- The CSV is a **whole-ledger** export. It is not capped at the 500 rows the on-screen grid shows; a truncated "backup" that looks complete is worse than no export.
- One row per transaction, oldest first. Paired transfers appear as two rows, each carrying its own account and a signed amount; the pairing is not reconstructable from the file.
- Columns are text-first: memo, category, account and institution. Amounts are the only numeric cells, so a spreadsheet adds them without a currency symbol in the way.
- **Formula injection is prevented on write.** A text cell that begins with `=`, `+`, `-`, `@`, a tab or a carriage return is prefixed with an apostrophe, so opening the file evaluates nothing.
- The file is private: written with mode `0600` where the platform has POSIX modes, atomically, and read back and hashed before the export reports success.
- The file carries neither the currency code nor the links between records. Those live in the JSON backup.

### Import

- A CSV is accepted only as an **entry list or a bank statement**, never as a restore.
  - A bank statement is OFX/QFX or a CSV with no Account column; it is read as one account's history and the wizard asks which account it belongs to.
  - Otherwise the file is read as entries with Debit/Credit (or signed) amounts, and any column mapping problem becomes a question in the wizard rather than a failed import.
- Import is additive (ADR 0003). Rows without a reference can be added twice if the same file is imported twice; bank lines that carry a `FITID` or reference are deduplicated by `external_id`.
- A transfer exported as two rows imports back as two independent entries, not as one paired transfer. The JSON backup is the way to preserve pairing.

## Consequences

### Positive

- Users get a file that behaves like a spreadsheet and a backup that behaves like a backup, with the difference stated in the UI and in the docs.
- Formula injection is handled at the only boundary where user text becomes a file a spreadsheet will execute.
- The export is complete and verified, so "it exported" means the whole ledger is there and readable.

### Negative

- **The CSV is not round-trippable for the whole model.** Settings, reserves, goal links and transfer pairing are lost by design. A user who treats it as a backup loses structure, not just formatting.
- The apostrophe prefix is visible in a text editor; it is removed by the spreadsheet, which is the audience.
- Changing the column order is a breaking change for anyone with a saved spreadsheet import; it needs a version note, not a silent edit.

### Neutral

- The screen's 500-row cap is a read-model limit (ADR 0018), not an export limit.
- No schema change.

## Alternatives considered

### Export one row per transfer, with both account names

Rejected: it makes the file easier to read and harder to import, because the importer would have to recognise the two-account shape and decide whether to create a paired transfer. Exporting exactly what the ledger stores keeps both directions predictable.

### Refuse CSV export and point at JSON only

Rejected: the CSV is genuinely useful for review and for moving entries between tools, and the risk it poses is addressed by copy and by the injection guard.

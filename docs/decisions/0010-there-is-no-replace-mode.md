# 0010. There is no replace-mode restore

- **Status:** Accepted; amended by [ADR 0024](0024-two-copies-merge-by-time.md), which lets a newer copy of an existing row replace the local one without adding a replace-mode
- **Date:** 2026-10-31
- **Deciders:** Project owner
- **Related:** [ADR 0003](0003-additive-imports.md), [ADR 0017](0017-the-csv-is-a-review-copy.md), [IMPORT-EXPORT.md](../IMPORT-EXPORT.md)

## Context

The decision log reserved number 0010 for a "restore from file" mode: an import that wipes the ledger and writes the backup in its place, so a user can get back to exactly the state the file describes. The reservation stayed empty because replace-mode is the most dangerous button in a local app: it destroys live data by design, and every other import path in WageRoute is deliberately additive ([ADR 0003](0003-additive-imports.md)).

The choice has to be made explicitly. Either the app grows a second import mode with its own confirmation and safety copies, or the additive rule is declared final and the recovery story is built around it.

## Decision

**There is no replace-mode restore. An import merges row by row and never wipes the ledger.**

- `backup:import` merges rows into the local ledger: new rows are inserted, an existing row is replaced only when the file's copy is newer ([ADR 0024](0024-two-copies-merge-by-time.md)), and a row the file omits is never dropped.
- Settings merge per key with the same newer rule. Into a profile with no history (a fresh install or the erase-then-restore path) the file's settings are adopted, because the local ones are untouched seeded defaults.
- A backup restored onto a *different, clean* profile reconstructs that ledger exactly, because every row is new.
- Restoring onto a dirty profile keeps both ledgers. It is not promoted as a way to "undo" recent work; the backup is a recovery artifact, not a snapshot you can jump back to.
- The only replace path is **Erase all data…** in Settings, then import. The erase writes a last-resort `pre-erase` copy of the live database to the app's `backups` folder (newest three kept) before wiping, and the dialog says so. It never silently discards data it did not just copy.
- Exports are atomic and verified: written to a temporary file, flushed, renamed, then read back and hashed, so a backup that reports success is a backup that was actually written.

## Consequences

### Positive

- One import semantics across backups, entries CSVs and bank statements: no row is dropped merely because the file omits it. A delete or edit the file records as newer is applied, and that is the only way an import removes something.
- A mistaken import leaves the ledger in place. At worst it applies a newer copy of a row or a newer delete, both visible in the ledger and reversible by editing; it cannot un-erase a whole ledger because it never replaces one.
- No second confirmation flow, no "type the file name to continue" ceremony, and no way to reach destructive replacement through the import wizard.

### Negative

- **"Restore" is not a time machine.** A user who wants the ledger exactly as it was last Tuesday must erase first and accept losing everything newer than the backup. The UI must not pretend otherwise.
- **Merged ledgers can be confusing.** Importing someone else's backup or an old copy of your own leaves two histories side by side. `external_id` stops the same bank line being added twice, but hand-entered rows have no reference and can duplicate.
- A future "replace" feature would need its own ADR: this one closes the question for the import path, not for a dedicated restore screen.

### Neutral

- The reserved number is now used; the sequence has no gap.
- No schema or IPC change. The behaviour described here is what the code already does.

## Alternatives considered

### Replace mode with a typed confirmation

Rejected. Typed confirmation defends against a mis-click, not against a user who believes the backup is newer than it is. Every wrong decision in that flow is unrecoverable, while every wrong decision in the merge flow is visible in the ledger and reversible by editing or deleting rows.

### Import into a new profile instead of the live one

Rejected for now: there is one local profile per app installation, so "a new profile" means renaming the database file by hand. The row-by-row merge plus erase covers the real cases without adding a profile manager.

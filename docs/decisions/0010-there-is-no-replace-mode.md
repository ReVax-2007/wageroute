# 0010. There is no replace-mode restore

- **Status:** Accepted
- **Date:** 2026-10-31
- **Deciders:** Project owner
- **Related:** [ADR 0003](0003-additive-imports.md), [ADR 0017](0017-the-csv-is-a-review-copy.md), [IMPORT-EXPORT.md](../IMPORT-EXPORT.md)

## Context

The decision log reserved number 0010 for a "restore from file" mode: an import that wipes the ledger and writes the backup in its place, so a user can get back to exactly the state the file describes. The reservation stayed empty because replace-mode is the most dangerous button in a local app: it destroys live data by design, and every other import path in WageRoute is deliberately additive ([ADR 0003](0003-additive-imports.md)).

The choice has to be made explicitly. Either the app grows a second import mode with its own confirmation and safety copies, or the additive rule is declared final and the recovery story is built around it.

## Decision

**Imports are additive, permanently. There is no replace-mode restore.**

- `backup:import` merges rows into the local ledger: ids that already exist are skipped, new rows are inserted, and settings already changed locally are kept.
- A backup restored onto a *different, clean* profile reconstructs that ledger exactly, because every row is new.
- Restoring onto a dirty profile keeps both ledgers. It is not promoted as a way to "undo" recent work; the backup is a recovery artifact, not a snapshot you can jump back to.
- The only replace path is **Erase all data…** in Settings, then import. The erase writes a last-resort `pre-erase` copy of the live database to the app's `backups` folder (newest three kept) before wiping, and the dialog says so. It never silently discards data it did not just copy.
- Exports are atomic and verified: written to a temporary file, flushed, renamed, then read back and hashed, so a backup that reports success is a backup that was actually written.

## Consequences

### Positive

- One import semantics across backups, entries CSVs and bank statements: nothing local disappears.
- A mistaken import is a merge, not a loss. The user can delete the added rows; they cannot un-erase a replaced ledger.
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

Rejected. Typed confirmation defends against a mis-click, not against a user who believes the backup is newer than it is. Every wrong decision in that flow is unrecoverable, while every wrong decision in the additive flow is visible in the ledger and reversible by deleting rows.

### Import into a new profile instead of the live one

Rejected for now: there is one local profile per app installation, so "a new profile" means renaming the database file by hand. The additive merge plus erase covers the real cases without adding a profile manager.

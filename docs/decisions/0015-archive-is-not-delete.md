# 0015. Archive is not delete

- **Status:** Accepted
- **Date:** 2026-10-31
- **Deciders:** Project owner
- **Related:** [ADR 0003](0003-additive-imports.md), [ADR 0007](0007-dedicated-accounts-balance-is-progress.md), [DATA-MODEL.md](../DATA-MODEL.md)

## Context

Every entity in WageRoute can leave the screen in two different ways. **Archiving** sets `is_archived = 1`: the row keeps its identity, its history and its foreign keys, but stops appearing in lists and stops counting in totals. **Deleting** sets `deleted_at`: the row disappears from every query but stays on disk, and imports or backups still carry it. Both flags survived several redesigns, and the UI has not always been clear about which button does which, or what a restored row brings back.

The audit asked for a written rule because the two states interact with goals, the Safe to Spend pool and the totals — and because "delete" in a local app is a promise about data, not just about a table.

## Decision

### Archive means "this is no longer active"; delete means "this should not exist"

- Archived accounts, goals and categories are excluded from pickers, the Safe to Spend pool, and the totals that describe the active ledger. Their historical rows remain, so a past month still adds up.
- A dedicated account that is archived keeps its goal pointer but contributes nothing to the goal's progress: its balance is no longer part of the ledger being counted. The goal screen says the account is archived rather than silently showing a smaller number.
- A bill that is paused is the same idea in the wall's vocabulary: it keeps its row and its due-day, and the wall stops reserving for it.

### Delete is soft at the storage layer

- Deleting sets `deleted_at`; it never issues `DELETE`. The row stays available to an export, a backup and a future undo.
- Deleting an account that has entries is refused unless `withEntries` is set, and the dialog says how many entries will go with it. Turning down the refusal is an explicit second decision, not a default.
- Deleting a paired transfer deletes both legs, because one leg without the other is a movement that never happened.
- The two-step **Erase all data…** is different: it drops every row and compacts the file. Even there, a last-resort `pre-erase` copy is written first, and the dialog says where it is.

### Restore is the inverse of archive, never of delete

- Un-archiving returns the row to every total exactly as it was. No re-linking is needed because nothing was unlinked.
- There is no restore of a deleted row in the UI. A deleted row can still come back through a JSON import (ADR 0003), but that is a data recovery path, not an "undo" button.

## Consequences

### Positive

- Historical reports stay correct when an account is archived: the entries were never touched.
- Archive is cheap, reversible and needs no confirmation.
- Delete is honest about its scope: the dialog names the dependency, and the repository refuses to hide entries by accident.

### Negative

- **Backups carry deleted rows.** A restore can resurrect something the user deleted (ADR 0003 merges; it does not consult tombstones). The import wizard lists what it will add, which is the only defence.
- **Archived rows still occupy their unique keys.** An account's name and a goal's pointer are not released by archiving, so a "fresh" account with the same purpose is a second row, not a replacement.
- **The vocabulary has to stay consistent.** A screen that says "remove" for an archive action reintroduces the confusion this ADR removes.

### Neutral

- No schema change; the two flags and the soft-delete convention predate this record.
- `is_archived` and `deleted_at` are independent on purpose: an archived row can be deleted, and the queries filter both.

## Alternatives considered

### Hard delete with a confirmation dialog

Rejected: it removes the only undo a local app has, and an export taken afterwards no longer describes what the ledger used to contain. The disk cost of keeping a few thousand rows is negligible.

### One "inactive" flag for both meanings

Rejected: archive is reversible and delete is not, and collapsing them would make the irreversible action look like the reversible one.

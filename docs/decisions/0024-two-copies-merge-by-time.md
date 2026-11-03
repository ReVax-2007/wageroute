# 0024 — Two copies of one ledger merge by time

**Status:** Accepted (2026-11-02)

## Context

[ADR 0023](0023-the-phone-reads-a-backup-and-writes-only-entries.md) gave the phone a read-only view plus an entry pad, because the desktop import only ever added rows. That rule kept the ledger safe, but it made the phone a companion rather than a peer: a bill, goal, account or entry could only be changed on the computer, and an edit made on the phone could never reach the desktop. The person using it asked for the phone to work "exactly and in tandem" with the desktop.

The schema has carried the machinery for a real merge since v1: every table has `created_at`, `updated_at` and `revision`, and deletes are soft (`deleted_at`). [ADR 0004](0004-sync-ready-schema.md) kept those columns precisely so a merge could be defined later. A sync server was never required to use them: a backup file already carries every column.

The obstacle was never transport, it was decision. An import that only adds cannot represent an edit or a deletion, so the honest answer was to refuse both. Once the same newer-wins rule is defined on both sides, a file is enough to carry edits, deletes and settings changes in either direction.

## Decision

**A backup is merged into the local ledger by last-write-wins on the row's own stamps, on both the desktop and the phone. Neither side may replace its copy from a file.**

1. **A row the local ledger does not have is added**, including a tombstone. There is nothing to delete when the row was never held, but the id is taken, so a later file cannot bring that row back under the same id. Both sides do this.
2. **A row the local ledger has is replaced only when the file's copy is newer.** `updated_at` decides; `revision` breaks a tie in the same millisecond; a row with no usable stamp never replaces one that has a stamp. A stamp later than the file's own export time is read as that export time, not as this device's clock, so two devices opening the same file agree on when a mis-stamped row changed.
3. **A tombstone is a row too.** A newer `deleted_at` deletes the local row; an older live copy cannot resurrect it. A newer live copy can bring a deleted row back, which is what makes "undo the delete" possible across devices.
4. **The local `created_at` is kept on an update.** An edit is not a new row, so history does not move.
5. **Settings merge per key** with the same newer rule. The one exception is the desktop's erase-then-restore path: a ledger with no history adopts the file's values, because the local ones are seeded defaults nobody chose. The phone starts from the file, so it has no seeded settings to protect.
6. **Categories are still identified by name.** A file row whose name already exists is linked to the local row instead of adding a twin, and a rename onto another live name is refused with a reason rather than splitting every report.
7. **The import report says what happened.** Added, updated and removed are counted separately and the toast names each; skipped means "left as it is here" — an older copy or a category name this profile already uses — not "ignored".

The comparison lives in one shared module, `src/shared/tableMerge.ts`: `incomingWins` decides, and `mergeTables` applies it for the phone. The desktop calls the same `incomingWins` and writes the result with SQL inside its existing import transaction; it does not rewrite rows that the rule leaves alone.

## Consequences

- The phone can delete any entry, not only the ones it added. A delete is written as a tombstone with a bumped revision, and a transfer or round-up deletes its partners too, so a half-pair cannot survive.
- A phone export and a desktop export merge in either order. Re-importing a file that has already been merged is a no-op, as before.
- Conflicts are silent by design: the newer edit wins and the other is not shown. The app records no per-field history, so a person who edits a row on the computer and deletes it on the phone loses one of the two with no dialog. The phone's Data screen and the desktop import toast state the rule instead of pretending there is a merge wizard.
- Tombstones accumulate. A row deleted years ago stays in every export as a one-line tombstone. That is the price of a merge that can tell "deleted" from "never seen", and it is bounded by the ledger's own size.
- Clocks matter. A device whose clock is badly behind can lose a delete to a later-stamped live row. The revision tiebreak and the future-stamp clamp reduce the window; they do not remove the need for a roughly correct clock.
- The desktop import is no longer purely additive, so [ADR 0003](0003-additive-imports.md) is amended: imports still never replace the whole ledger and there is still no replace-mode ([ADR 0010](0010-there-is-no-replace-mode.md)), but a newer version of an existing row is now applied.
- [ADR 0023](0023-the-phone-reads-a-backup-and-writes-only-entries.md) is superseded on the write side. The phone is still a static PWA with no server, still rebuilds the snapshot with the desktop's functions, and still keeps its copy in IndexedDB; what changes is that its copy is a peer the desktop merges, not an entry pad.

## Alternatives rejected

- **Keep the phone add-only and call it "in tandem".** It is not: every bill, goal and correction still has to wait for a trip to the computer, and a phone delete either lies or is lost.
- **A sync service with a merge server.** The product is local-first and has no account; a server would be the first thing it must secure, and would become mandatory for the phone's data to stay current.
- **Per-field diff and a conflict dialog.** The ledger has no field-level history, so a real three-way merge is not possible without storing one. A dialog that cannot show what changed is worse than a stated rule.
- **Last-writer by import order instead of row stamps.** The later import would always win, so a stale file would undo newer edits. The stamps already exist and describe when the person actually edited.
- **Replace the phone's copy on every import.** Simple, and it silently destroys everything typed on the phone since the last export.

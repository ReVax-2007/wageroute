# 0006. Imports ask instead of failing: a preview/confirm wizard with per-row repair

- **Status:** Accepted
- **Date:** 2026-10-28
- **Deciders:** Project owner
- **Supersedes:** parts of [ADR 0003](0003-additive-imports.md) (see "What changes")
- **Related:** [ADR 0003](0003-additive-imports.md), [ADR 0002](0002-integer-cents.md), [IMPORT-EXPORT.md](../IMPORT-EXPORT.md), [ARCHITECTURE.md](../ARCHITECTURE.md)

## Context

The additive merge decided in ADR 0003 kept the ledger safe, but it treated an imperfect file as an error. Real files are imperfect: bank and hand-written JSON omits columns, a backup from a shared person references accounts that do not exist locally, and a CSV names accounts the user has under a different label. Two failures showed up in practice:

- a v2-era backup that omitted `accounts.sort_order` crashed the whole import with `SqliteError: NOT NULL constraint failed: accounts.sort_order`, because every column is named explicitly in the `INSERT` and SQLite's own column default therefore never fires;
- a single dangling reference rolled the transaction back, so one unusable row discarded a thousand good ones and left the user with a raw SQLite message.

The owner's instruction was explicit: build a setup wizard for importing data, **if information is missing, prompt for it — do not fail the import**. The scope agreed was: prompt for every recoverable category (missing required value, invalid value, dangling or missing reference, malformed enum, unset nullable reference, unmatched CSV account name); per row offer **fix it or leave it out**, and when a row is left out tell the user what is wrong and how to repair the source file; surface the wizard in both Settings → Import data and the first-run "Import a backup"; and map unmatched CSV account names to local accounts instead of dropping them silently.

## Decision

Keep the additive merge of ADR 0003 unchanged in intent. Change *how* a defective file is handled: **detect before writing, ask the human, then write what the human agreed to.**

### Three phases

1. **Preview** (`data:preview`). Pick the file, read it, parse it, and run a pure detection pass over the tables without touching the database. Return what the file holds, per row, plus one problem per unusable field, plus the local rows a reference may be pointed at. The file itself stays in main; the renderer only ever receives an opaque single-use token.
2. **Answer** (renderer). The wizard groups problems by row and asks for a replacement value or a "leave this row out" decision. Nothing is discarded silently.
3. **Confirm** (`data:confirm(token, answers)`). Re-derive the same problems in main, apply the answers, drop whatever is still unusable, and merge. Only rows that survive the drop list reach SQLite.

### Per-row failure, not per-file

Each row is inserted inside its own `try/catch`. A row SQLite refuses becomes an entry in `issues`; every other row still lands. The `INSERT OR IGNORE`-style skip-by-ID, the preserved UUIDs, `TABLE_DEFAULTS` for absent columns and `TABLE_COLUMNS` allowlists all stay as ADR 0003 defined them.

### Detection is pure and shared

`findImportProblems` and `validateFieldValue` live in `src/shared/importRepair.ts`: no database, no Electron, deterministic. The same functions drive the preview questions, the confirm-time re-derivation and the tests, which is what makes the `b:<table>:<row>:<column>` answer keys safe to rely on across two IPC calls.

### Drops are reported, not swallowed

`ImportResult.dropped` carries a label, the joined reasons and a `fixHint` per row so the user can repair the same row in the source file later. A problem that nobody answered is dropped ("left blank") rather than thrown.

### Token lifecycle

Pending imports live in a module-scope map, capped at 8 with FIFO eviction, single-use, keyed by a random UUID. This bounds retained file bytes and keeps a stale handle from re-importing an already-consumed file.

## What changes relative to ADR 0003

ADR 0003's additive principles all stand. Two of its mechanical claims are superseded:

- "Links to rows that are absent locally fail the foreign-key check and abort the transaction" — such a link is now **a question**, answered by picking a local row, clearing the reference where the column is nullable, or leaving the row out.
- "The whole merge runs in one transaction. Any failure rolls back every row from that import" and "Import errors are shown without partially applying the file" — the merge still runs in one transaction, but a row-level failure no longer aborts the file: it becomes an issue entry and the rest of the import commits.

The ADR 0003 text is kept as written because it records the decision at the time it was made; this record is the change.

## Consequences

### Positive

- **One bad row cannot lose a ledger.** The failure mode that produced the `sort_order` crash is structurally impossible now.
- **The user is consulted for exactly the gaps they can fix.** "Which account is this pointing at?" is answerable; a raw constraint message is not.
- **Nothing disappears without explanation**, and the explanation includes how to fix the file for next time.
- **Re-import stays idempotent.** Skipping by UUID is untouched.
- **Testable without Electron.** Problem detection, answer application and drop rules are pure functions with direct tests.

### Negative

- **Two round trips instead of one**, and a file handle held in memory between them. Capped at 8 pending imports; an unconfirmed draft is leaked until the process exits.
- **Re-derivation is key-safe, not outcome-safe.** Confirm re-derives against the *current* database, so if local data changed between preview and confirm, a row that looked repairable at preview is dropped at confirm. The wizard's "repaired" badge is derived from non-empty text, not from validity, so the review step can still promise a row that confirm drops; the toast is the only reconciliation.
- **A partial import is now a normal outcome.** Users can end up with a ledger missing rows they thought they imported unless they read the toast and the review list.
- **Left-out rows are unrecoverable without the file.** There is no undo; the user must re-open the source and answer differently.
- **CSV parse problems share the `issues` bucket** with database refusals, so the store's wording ("refused by the database") can misattribute a malformed line to SQLite.
- **No component tests.** The wizard itself is verified by hand; only the shared detection and merge layers are automated.

### Neutral

- The action remains **Import data**, not "Restore". A true replace-from-file remains a separate, undecided operation (no ADR yet).
- The 64 MiB cap, the 200,000-rows-per-table cap, the 200-choice reference cap and the skip-by-ID rule are unchanged.
- `examples/backup.example.json` remains the canonical clean file; it now doubles as the "a valid backup must need zero wizard questions" test fixture.

## Alternatives considered

### Abort the file on the first bad row

What shipped before. Rejected by direct instruction — a single unusable reference should not discard a thousand good rows, and a SQLite message is not a user-facing prompt.

### Coerce silently (fill defaults, NULL the reference, import anyway)

Rejected as the primary path. It would write guesses into someone's financial ledger without asking, and a wrong `account_id` or amount is indistinguishable from a real one afterwards. Defaults are still used, but only for columns the app *knows* how to default from the schema; anything semantically load-bearing becomes a question.

### Auto-match dangling references by name

Rejected. Name matching is ambiguous and ADR 0003 already rejected heuristics for structural rows. CSV account names are the one place matching happens, and there it is exact-after-trim-and-lowercase, optionally narrowed by institution, with the user confirming any name the app could not resolve.

### Repair the file on disk

Rejected. Editing a user's backup file is a destructive act on data outside the app's own storage, and it removes the only copy of what the file originally said.

### One IPC call with the answers up front

Rejected. It either requires the renderer to guess the questions (no local reference list without a read) or forces a preview read anyway; splitting the calls also keeps the file bytes in main instead of round-tripping a multi-megabyte JSON across the bridge twice.

### A full interactive "restore mode"

Out of scope. Replace-with-confirmation is a different, higher-blast-radius operation and would need its own decision record.

## References

- [src/shared/importRepair.ts](../../src/shared/importRepair.ts) — problem detection, field validation, answer application, drop rules
- [src/shared/importRepair.test.ts](../../src/shared/importRepair.test.ts) — detection and repair behaviour, pure
- [src/main/ipc.ts](../../src/main/ipc.ts) — `data:preview` / `data:confirm`, token store, held file
- [src/main/db/backup.ts](../../src/main/db/backup.ts) — `TABLE_COLUMNS`, `TABLE_DEFAULTS`, per-row `try/catch`
- [src/main/db/entries.ts](../../src/main/db/entries.ts) — CSV merge with the wizard's account map
- [src/main/db/repositories.ts](../../src/main/db/repositories.ts) — `listImportChoices` for reference pickers
- [src/renderer/src/components/ImportWizard.tsx](../../src/renderer/src/components/ImportWizard.tsx) — rail, per-row fix/leave-out, review
- [IMPORT-EXPORT.md](../IMPORT-EXPORT.md) — wizard contract, formats, worked examples, limits

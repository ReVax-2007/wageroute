# Development

This guide covers local setup, the scripts, the layering rules, how to add a feature or a migration, and how to debug without touching real financial data.

---

## Contents

- [Prerequisites](#prerequisites)
- [Install](#install)
- [Scripts](#scripts)
- [Project layout](#project-layout)
- [TypeScript and aliases](#typescript-and-aliases)
- [Working safely with data](#working-safely-with-data)
- [Testing](#testing)
- [Adding a feature](#adding-a-feature)
- [Adding an IPC channel](#adding-an-ipc-channel)
- [Adding a schema migration](#adding-a-schema-migration)
- [Debugging](#debugging)
- [Native modules and packaging](#native-modules-and-packaging)
- [Code conventions](#code-conventions)
- [Troubleshooting](#troubleshooting)
- [Known test gaps](#known-test-gaps)

---

## Prerequisites

| Tool | Version | Notes |
| --- | --- | --- |
| Node.js | 22 or newer | CI uses 24 |
| npm | Bundled with Node | `package-lock.json` is committed |
| Xcode Command Line Tools | Current | Required to compile native modules and build macOS installers |
| Windows build tools | Current | Only needed to build Windows installers on Windows |
| SQLite CLI | Optional | Useful for inspecting a copy of the database |

WageRoute is a desktop Electron app. There is no browser-only or mobile target, and no backend to run.

## Install

```bash
npm install
```

The `postinstall` script runs `electron-builder install-app-deps`, which rebuilds `better-sqlite3` against the Electron ABI. If native bindings get out of sync after an Electron upgrade, run:

```bash
npm run postinstall
```

## Scripts

| Script | Command | Purpose |
| --- | --- | --- |
| `npm run dev` | `electron-vite dev` | Dev server, main/preload rebuild, hot renderer reload |
| `npm start` | `electron-vite preview` | Run the production bundles in `out/` |
| `npm test` | `node --import tsx --test` (twenty-one files listed explicitly) | Domain, cadence, accounts, importer, backup-example, merge, migration, maintenance, files, statements, preload bridge and repository tests |
| `npm run typecheck` | node + web type checks | Both TypeScript projects |
| `npm run typecheck:node` | `tsc --noEmit -p tsconfig.node.json` | Main, preload, shared, config |
| `npm run typecheck:web` | `tsc --noEmit -p tsconfig.json` | Renderer and shared |
| `npm run build` | typecheck + `electron-vite build` | `out/main`, `out/preload`, `out/renderer` |
| `npm run dist` | build + `electron-builder` | Current platform |
| `npm run dist:mac` | build + `electron-builder --mac` | DMG, arm64 + x64 |
| `npm run dist:win` | build + `electron-builder --win --x64 --arm64` | NSIS + MSI + portable + zip (MSI needs Windows: WiX) |
| `npm run dist:linux` | build + `electron-builder --linux --x64 --arm64` | AppImage + deb + rpm |

Architectures are passed as flags, not as `arch` lists in `electron-builder.yml`: electron-builder merges a target's declared arches into every build, so a declared list overrides `--x64`.

There is no lint script and no formatter configuration. Consistency is maintained by convention and type checking.

## Project layout

```text
src/
├── main/
│   ├── index.ts              app lifecycle, window, security policy
│   ├── ipc.ts                channel handlers, dialogs, file I/O
│   ├── files.ts              atomic, mode-restricted writes
│   ├── log.ts                crash/uncaught-error log
│   └── db/
│       ├── connection.ts     singleton, pragmas, path, boot checks
│       ├── maintenance.ts    quick_check, pre-upgrade copies, compaction
│       ├── migrations.ts     versioned schema
│       ├── repositories.ts   façade re-exporting the repo/ modules
│       ├── repo/             CRUD per entity, read models, transfers, round-up
│       ├── backup.ts         JSON build/parse/merge
│       ├── entries.ts        CSV entry merge
│       ├── legacy.ts         pre-rename database adoption
│       ├── seed.ts           first-run seed: blank (packaged) / demo (dev)
│       └── dedicated-accounts.test.ts  repository behaviour for dedicated goals
├── preload/
│   ├── index.ts              contextBridge wiring (Electron only)
│   ├── api.ts                FinanceApi built from the typed channel contract
│   ├── api.test.ts           every bridge method maps to one declared channel
│   └── index.d.ts            window.api typing
├── renderer/
│   ├── index.html            CSP, title
│   └── src/
│       ├── main.tsx          root, theme cache, error boundary
│       ├── App.tsx           screen switch, theme effect
│       ├── components/       Sidebar, grids, prompts, dialogs/, shared table and save hook
│       ├── lib/finance.ts    derived totals and labels
│       ├── screens/          one file per screen
│       ├── store/            session + data slices, selectors, useFinanceStore
│       └── styles/           tokens, layered sheets, grid sheet
└── shared/
    ├── accounts.ts       Safe-to-spend pool, total wealth, wealth buckets
    ├── allocator.ts
    ├── api.ts
    ├── channels.ts       typed IPC contract and the exhaustive channel list
    ├── billPrompts.ts
    ├── cadence.ts
    ├── csv.ts
    ├── dates.ts
    ├── emergency.ts
    ├── importRepair.ts   import problem detection and repair
    ├── money.ts
    ├── projections.ts
    ├── settings.ts
    ├── transfers.ts
    ├── types.ts
    ├── domain.test.ts
    ├── cadence.test.ts
    ├── dates.test.ts
    ├── errors.test.ts
    ├── occurrences.test.ts
    ├── kinds.test.ts
    ├── csv.test.ts
    ├── accounts.test.ts
    ├── backup-example.test.ts
    ├── backup-merge.test.ts
    └── importRepair.test.ts
```

### Layering rules

| Layer | May import | Must not import |
| --- | --- | --- |
| `shared` | Other shared modules | Electron, Node APIs, React, DOM |
| `main` | Shared, Node, Electron, better-sqlite3 | React, renderer code |
| `preload` | Shared types, Electron IPC | Node filesystem, database code, renderer code |
| `renderer` | Shared, React, Zustand, renderer modules | Electron, Node, better-sqlite3, SQL |

Shared code is the contract. If a rule needs to be used in both processes, it belongs in `shared`.

## TypeScript and aliases

Two projects:

- `tsconfig.node.json` — Node lib, `types: ["node"]`, includes main, preload, shared and the Vite config.
- `tsconfig.json` — DOM lib, JSX, includes renderer, shared and preload typings; excludes `*.test.ts`.
- Both enable `noUnusedLocals` and `noUnusedParameters`, so an unused import fails `npm run typecheck` rather than lingering.

Both enable `strict`, `verbatimModuleSyntax`, `isolatedModules` and `noEmit`. Type-only imports must use `import type`, because of `verbatimModuleSyntax`.

Aliases are defined in both the TS configs and `electron.vite.config.ts`:

| Alias | Resolves to |
| --- | --- |
| `@shared/*` | `src/shared/*` |
| `@renderer/*` | `src/renderer/src/*` |

There is no `baseUrl`; paths are relative to the repository root. If you add an alias, update the TS configs and the Vite config together.

## Working safely with data

The real database is your data. Treat it as production.

### Use a disposable home

On macOS, `CFFIXED_USER_HOME` redirects Electron's application data paths:

```bash
rm -rf /tmp/wageroute-dev-home
CFFIXED_USER_HOME=/tmp/wageroute-dev-home npm run dev
```

This creates a separate `WageRoute` data directory under `/tmp` and seeds it on first launch. Use it for:

- schema migration testing;
- first-run and legacy adoption tests;
- import experiments;
- UI screenshots with demo data.

### Inspect a copy, not the live database

Quit the app, then copy the database and inspect the copy:

```bash
cp "$HOME/Library/Application Support/WageRoute/wageroute.db" /tmp/wageroute-copy.db
sqlite3 -readonly /tmp/wageroute-copy.db
```

Useful queries:

```sql
PRAGMA user_version;
.tables
SELECT COUNT(*) FROM accounts WHERE deleted_at IS NULL;
SELECT COUNT(*) FROM transactions WHERE deleted_at IS NULL;
SELECT key, value FROM settings ORDER BY key;
```

Opening the live database with the CLI can create or touch WAL/SHM files. Read a copy unless you are intentionally diagnosing the live file.

### Never overwrite live preferences to test

Do not write test values into the real `settings` table, real accounts or real goals. If a test needs a specific state, use the disposable home or import into a throwaway profile.

### Quarantine, do not delete

When a test requires moving a database aside, move it to a dated quarantine folder. Do not delete the only copy of a user database, even a demo one, without confirmation.

## Testing

Twenty-one files run by `npm test` through `node --test` with `tsx` as the loader — 172 tests today. The script lists every file path explicitly, so **a new test file must be added to the `test` script in `package.json` or it never runs**; the `pretest` guard ([`scripts/check-test-list.mjs`](../scripts/check-test-list.mjs)) fails the run when a `*.test.ts` on disk is missing from that list, or when the list names a file that no longer exists.

| File | Style | Covers |
| --- | --- | --- |
| `domain.test.ts` | pure functions | money parsing and formatting boundaries; month-end date clamping and due-date derivation; allocator priority, shortfall, scaling, goal ordering, whole-dollar sweeping and the balance identity; debt as a surplus bucket; bill prompt chronology and early-payment window; round-up remainders and transfer legs; emergency variable averaging, essentials, target and coverage; settings defaults, corrupt input and round-trip serialization; CSV quoting, parsing, bank-style dates, duplicate headers and transfer rejection |
| `dates.test.ts` | pure functions | `isISODate` round-trips through `Date.UTC`: leap days, month ends, `2026-02-31`, `2026-13-01`, `0000-00-00` and the wrong shape |
| `errors.test.ts` | pure functions | `RepositoryError` codes survive `encodeError`/`decodeError`; `apiErrorMessage`/`apiErrorCode` strip the marker; non-repository errors pass through unchanged |
| `occurrences.test.ts` | pure functions | bill occurrence generation across cadences and month boundaries; the "third check" surplus case |
| `kinds.test.ts` | pure functions | account-kind classification and its Safe-to-spend default |
| `csv.test.ts` | pure functions | export round-trip; text cells beginning `=`, `+`, `-`, `@`, tab or CR are prefixed with an apostrophe; amount cells stay numeric |
| `cadence.test.ts` | pure functions | which paycheck slot a date falls in for each pay cadence; the check closest to a due day, ties going earlier; which slots a month is certain to contain; an unreachable target is clamped rather than dropped; `last_check` lands on the last guaranteed slot and nowhere else; `all_checks` has no single funding check; a single-check bill carries the **month** ($50 weekly → $216.67) on one check and nothing on the other; every strategy's monthly total equals the obligation it owes; no paycheck date means the spread, never the clock |
| `importRepair.test.ts` | pure functions | a clean backup needs nothing; each missing, invalid or dangling value becomes exactly one question; nullable versus required references; answers repair rows, unanswered rows are dropped rather than thrown; a still-invalid answer drops with the validation message; clearing a nullable reference is a valid answer; rows inside one file can satisfy each other's references; the accounts↔goals cycle is answerable in one pass; unmatched CSV account names collapse to one question each |
| `accounts.test.ts` | pure functions | the explicit Safe-to-spend choice versus the kind default; a dedicated account staying out of the spendable pool; archived accounts counting for nothing; credit subtracting from total wealth; wealth buckets partitioning the total exactly; the allocator skipping an account-funded goal and the leftover falling to savings |
| `backup-example.test.ts` | real file | `examples/backup.example.json` parses at the current `SCHEMA_VERSION` and every cross-table link — including an account dedicated to a goal — resolves, so the shipped example cannot silently drift |
| `backup-merge.test.ts` | **real in-memory SQLite** | schema-defaulted columns import with the default instead of failing NOT NULL; one unusable row is reported rather than aborting the file; a settings row without a key is skipped; existing values survive while missing timestamps fill in; a dedicated account and its goal survive an export/import round trip; CSV names mapped in the wizard land on the chosen account; an unmapped name is left out once and the rest still imports; a mapping whose account disappeared reports the row instead of throwing |
| `migrations.test.ts` | **real in-memory SQLite** | forward-only `user_version`; `SchemaTooNewError` carries the found and supported numbers and leaves `user_version` unchanged; each migration preserves existing rows |
| `reserves.test.ts` | **real in-memory SQLite** | `bill_reserves` rows are written and cleared with the bill lifecycle; a partial payment moves the reserve; the v7 migration backfills nothing it should not |
| `legacy.test.ts` | temp directories | pre-rename adoption moves the database and its sidecars or leaves everything in place and reports why |
| `maintenance.test.ts` | real SQLite file | `quick_check` passes on a healthy file; a non-SQLite file raises `DatabaseCorruptError`; a pre-upgrade copy carries every row and prunes to the newest three; `VACUUM` + `secure_delete` leave a sentinel memo absent from the database file |
| `ledger-guards.test.ts` | **real in-memory SQLite** | archived accounts are refused where they would be spent; a counter account on a non-transfer entry is refused; a round-up memo is clamped to 240 characters |
| `files.test.ts` | temp directories | an atomic write replaces the file, leaves mode `0600` on POSIX and no temporary behind; a failed write leaves the previous file intact |
| `dedicated-accounts.test.ts` | **real in-memory SQLite** | the two v4 columns round-trip through the repository; an unknown goal is refused; the account balance replaces the allocation total; an overdraft reads as zero; archiving releases the goal back to allocations; removing a goal detaches every account; a goal creates its funders in one call and their balances add; re-saving releases the ticks that were removed and `[]` is a choice, not a no-op; a tick that funded another goal moves and the old goal falls back; a missing account throws and rolls the whole save back; an archived account is refused without letting its valid sibling bind |

Conventions every new test follows:

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
```

- Flat top-level `test('description', () => …)` calls — the suite does not use `describe`/`it`.
- A database-backed test creates its own: `new Database(':memory:')` → `migrate(db)` → insert a `users` row with the fixed `USER_ID`, because every tenant query filters `user_id`. The `freshDb()` helper in `backup-merge.test.ts` is the pattern to copy; it is re-created per test.
- Assertions are on plain values and integer cents, never on rendered output or snapshots. There is no Testing Library, no jsdom and no coverage tool.

Run:

```bash
npm test
```

### What is not covered

There are no automated:

- IPC integration tests (the `data:preview`/`data:confirm` token lifecycle included);
- React component tests — including the import wizard and the allocator;
- end-to-end tests;
- visual regression tests;
- migration tests against fixture databases (the v2/v3 table rebuilds are verified by hand);
- repository tests for the CRUD validators outside the two importer paths above.

Those paths are verified manually. When changing them, use the disposable home and a copy of a real database, and document the manual check in the change description.

## Adding a feature

A typical feature crosses most layers. Use this checklist.

### 1. Domain and types

- Add or change types in `src/shared/types.ts`.
- Add pure rules in `src/shared` if the behaviour must be testable.
- Add tests to the file that owns the area: `domain.test.ts` for the maths and formats, `importRepair.test.ts` for the import problem/repair rules, `backup-merge.test.ts` when the rule needs a real database. Anything new needs its own `*.test.ts` listed in the `test` script.

### 2. Storage

- Add columns or tables in a new migration (never edit an old one).
- Update `src/main/db/repositories.ts`:
  - validation;
  - insert/update/read mappings (snake_case → camelCase);
  - derived queries;
  - snapshot assembly if the data is part of the read model.
- Update `src/main/db/backup.ts`:
  - `TABLE_COLUMNS` for any new table or column;
  - `TABLE_DEFAULTS` for columns that may be absent in older backups;
  - merge order if a new table has foreign keys.
- Update the seed if the demo profile should include the feature.

### 3. IPC

- Add a channel in `src/main/ipc.ts`.
- Add the method to `FinanceApi` in `src/shared/api.ts`.
- Add the bridge method in `src/preload/index.ts`.
- Add the store action in `src/renderer/src/store/useFinanceStore.ts`.

### 4. UI

- Add or update the screen in `src/renderer/src/screens`.
- Reuse primitives from `components/ui.tsx` (`Card`, `Button`, `Field`, `Modal`, `Money`, `Progress`, `Switch`, `Segmented`, `EmptyState`).
- Use design tokens from `styles/tokens.css`; do not hard-code dark-only colours.
- Every mutation should go through a store action so the snapshot refreshes and errors become toasts.

### 5. Documentation

- Update [DATA-MODEL.md](DATA-MODEL.md) for schema changes.
- Update [FEATURES.md](FEATURES.md) for behaviour.
- Update [IMPORT-EXPORT.md](IMPORT-EXPORT.md) if the file formats change.
- Update [RELEASING.md](RELEASING.md) if packaging or migration compatibility changes.
- Add a numbered record in [decisions/](decisions/) when a decision is new or changes; supersede rather than rewrite an old one.
- Add a bullet under `## [Unreleased]` in [CHANGELOG.md](../CHANGELOG.md). Anything merged to `main` after the last tag belongs there until a build ships it, including fixes and documentation-only changes.
- Append to [UNRELEASED.md](UNRELEASED.md) when a change joins the next-release queue, and update its blockers and checklist if the release gets harder, not just when it gets easier.

## Adding an IPC channel

1. Define the input and output types in `src/shared/types.ts` or `src/shared/api.ts`.
2. Add the method signature to `FinanceApi`.
3. Register `ipcMain.handle('domain:action', ...)` in `src/main/ipc.ts`.
   - Validate IDs with `requireId`.
   - Delegate payload rules to the repository; do not duplicate them in the handler.
4. Expose it in `src/preload/index.ts`.
5. Add a store action that calls it, refreshes the snapshot and surfaces errors.
6. Keep channel names `domain:verb` (`account:create`, `data:preview`, `data:confirm`).

Do not expose `ipcRenderer`, `require`, `fs` or raw SQL to the renderer.

## Adding a schema migration

Migrations are append-only. Never modify a `SCHEMA_V*` string once its version has shipped (`SCHEMA_V1`–`SCHEMA_V7` are released); databases in the field have already run them.

### Procedure

1. Add a new SQL string, e.g. `SCHEMA_V8`.
2. Add `{ version: 8, up: (db) => db.exec(SCHEMA_V8) }` to `MIGRATIONS`.
3. `SCHEMA_VERSION` updates automatically from the last entry.
4. Update types, repositories, backup allowlists and the seed. A column declared `NOT NULL` with a schema default also needs an entry in `TABLE_DEFAULTS`, or an older backup that omits it inserts `NULL` and aborts that row.
5. Test against a **copy** of a version-7 database (see [Working safely with data](#working-safely-with-data) — never the live file, and there is no downgrade path):
   - `PRAGMA user_version` before and after;
   - row counts preserved;
   - new columns present with correct defaults;
   - `PRAGMA integrity_check` and `foreign_key_check` clean;
   - app boots and snapshot loads.
6. Test a fresh database and an upgrade database separately.
7. Add or update documentation.

Version 4 is the model for an additive migration: two nullable `ALTER TABLE ADD COLUMN` statements and a partial index, no backfill, and no downgrade path. Existing rows read `NULL` in both columns, which the shared rules treat as "no explicit choice", so behaviour is unchanged until the user opts in.

Version 5 adds one column that is *not* nullable — `bills.funding_strategy TEXT NOT NULL DEFAULT 'all_checks'` — which is the cheaper of the two shapes for existing rows (SQLite fills the default in place, no table rebuild) but is exactly the case that needs the importer default described in step 4. Every released bill lands on `all_checks`, the strategy that reproduces the pre-v5 reserve arithmetic, so the upgrade moves no number.

Version 6 is the rebuild model, and the first one on a table that another table references. `bills.funding_strategy` is a CHECKed enum, SQLite cannot alter a CHECK, and `transactions.bill_id` points at `bills`, so the v2 recipe alone is not enough. What works in this build of better-sqlite3:

```sql
-- executed with foreign_keys = OFF AND legacy_alter_table = ON, both set
-- OUTSIDE the transaction (both pragmas are no-ops inside one):
ALTER TABLE bills RENAME TO bills_v5_old;
CREATE TABLE bills ( ... widened CHECK ... );
INSERT INTO bills SELECT ... FROM bills_v5_old;
DROP TABLE bills_v5_old;
CREATE INDEX idx_bills_sync ON bills (...);
```

- Without `legacy_alter_table = ON`, the bundled engine rewrites `transactions.bill_id REFERENCES bills(id)` to point at `bills_v5_old` during the rename — even with `foreign_keys = OFF` — and the `DROP` then fails or leaves the ledger dangling.
- `PRAGMA defer_foreign_keys = ON` does **not** substitute for this; it still fails at `COMMIT`.
- The migration is marked `rebuildsReferencedTable: true` in `MIGRATIONS`. The runner then suspends foreign keys, turns legacy mode on, runs `PRAGMA foreign_key_check` inside the transaction before setting `user_version` (a violation throws and rolls the whole version back), and restores both pragmas in `finally`.
- `src/main/db/migrations.test.ts` pins it: rows, defaults and the index survive; the widened value is accepted and a bogus one rejected; a referenced bill still cannot be deleted; a pre-seeded dangling `bill_id` makes the migration throw and roll back.

The same pattern applies to any future CHECK widening on a referenced table. `allocations` (v2) was safe without it; `accounts` or `bills` are not.

### Pointing at another table

`accounts.dedicated_goal_id` references `goals`, and `goals.account_id` already references `accounts`. Declaring the second direction as a foreign key makes the pair cyclic, and no static restore order in `TABLE_ORDER` (accounts → bills → goals → …) can then insert both rows without violating it. See [ADR 0007](decisions/0007-dedicated-accounts-balance-is-progress.md).

When a new column would close a cycle:

- store it as plain `TEXT` and validate the reference in the repository (`Goal not found`), not in SQLite;
- teach `findImportProblems` to ask about a dangling value, or an exported backup can point at a goal that no longer exists;
- null the pointer when the target is deleted, since no `ON DELETE` clause will do it for you.

The same "no declared key" precedent applies to `transactions.transfer_group_id` (version 3).

### SQLite constraints

- `ALTER TABLE ... ADD COLUMN` is supported. Added columns need a default or must be nullable.
- Changing a CHECK constraint, renaming a column or changing a primary key generally requires a table rebuild. Follow the v2 pattern:
  1. create a new table with the desired schema;
  2. `INSERT INTO new SELECT ... FROM old`;
  3. drop the old table;
  4. rename the new table;
  5. recreate indexes.
- The migration loop wraps each version in a transaction and sets `user_version` inside it.
- With foreign keys enabled, a rebuild is safe only when no other table references the table being dropped. `allocations` (v2) was safe; `bills` (v6) was not, and needed `legacy_alter_table` — see the v6 recipe above. `accounts` would need the same.

### Backup compatibility

Export uses `SELECT *`, import uses an allowlist (`TABLE_COLUMNS`). A new column that is not added to `TABLE_COLUMNS` exports fine and is then **silently dropped on import** — no error, no issue row, just missing data. `src/main/db/dedicated-accounts.test.ts` and the round trip in `backup-merge.test.ts` exist to catch exactly that.

If a new column is added:

- add it to `TABLE_COLUMNS`;
- add a fallback in `TABLE_DEFAULTS` only when a backup without the column should import as something other than `NULL`. Version 4's two columns need none: `NULL` is a meaningful value there ("no explicit choice"), which is the quieter option;
- decide whether the backup `version` should increase. A new `version` means older app builds reject newer files; that is usually correct for a breaking schema change. Version 4 raised it even though the SQL is additive, because the *meaning* of goal progress changed — an older build would read a dedicated account's balance as ordinary savings and double-count it.
- add the column to `examples/backup.example.json` and, if it links tables, to the link check in `backup-example.test.ts`.

## Debugging

### Renderer

- Open **View → Toggle Developer Tools** in development (the default Electron menu provides it).
- Or temporarily add `mainWindow.webContents.openDevTools()` in `src/main/index.ts`.
- React errors are caught by the error boundary in `main.tsx` and shown with a reload button.
- Zustand state can be inspected by adding a temporary `console.log(snapshot)` or by using the React DevTools extension if installed.

### Main process

- `console.log` from main appears in the terminal running `npm run dev`.
- A failed database open surfaces in the renderer boot screen, not as a terminal crash.
- Uncaught main-process errors terminate the app; run from a terminal to see the stack.

### Database

- Use the Settings screen's database path or the sidebar tooltip.
- Inspect a copy with `sqlite3 -readonly` (see [Working safely with data](#working-safely-with-data)).
- Check `PRAGMA user_version`, table counts and `deleted_at` filters when a row “disappears”.

### CDP / remote debugging

For scripted UI checks, launch a build with a remote debugging port and connect with the Chrome DevTools Protocol:

```bash
CFFIXED_USER_HOME=/tmp/wageroute-ui-home \
  "release/mac-arm64/WageRoute.app/Contents/MacOS/WageRoute" --remote-debugging-port=9222
```

Then query `http://127.0.0.1:9222/json` for the page target's `webSocketDebuggerUrl` and call `Runtime.evaluate` from a small Node script — Node 24 has a global `WebSocket`, so no dependency is needed. This is how the dedicated-accounts dialogs, badges and hero numbers were verified, and it is the only method that has found a real product bug (a Safe-to-Spend double deduction that the type checker and the unit tests both passed).

Three things cost time on the first attempt:

- Point the command at a build under `release/` or `out/`, **not** at `/Applications/WageRoute.app`. `src/main/index.ts` takes a single-instance lock, so launching the installed bundle again while the user's app is running just quits the new process and focuses theirs. The lock lives in `userData`, which is why a different `CFFIXED_USER_HOME` gets its own instance — but never rely on that as permission to launch the installed bundle.
- Always set `CFFIXED_USER_HOME` to a fresh directory. Without it the script reads and writes real data.
- React controls its form fields, so assigning `element.value` is invisible to the app. Use the prototype's native setter and then dispatch an event:

  ```js
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
  set.call(input, '4200.00')
  input.dispatchEvent(new Event('input', { bubbles: true }))
  ```

  `HTMLSelectElement` has its own setter for `<select>`; applying the input one throws.

The renderer's DOM is readable this way, but pixel output is not: `screencapture` on the machine used so far returns "could not create image from display" and assistive access is denied, so CDP verifies **behaviour and text**, never appearance. Scratch homes created for these runs are disposable — delete them afterwards, and delete only the ones this session made.

### Simulating first launch and legacy adoption

Legacy adoption reads from Electron's `appData` directory and writes to `userData`. To test it:

1. Create a temporary application-data home.
2. Place a `Cash Flow Routing/cash-flow-routing.db` (plus WAL/SHM if desired) inside it.
3. Launch with `CFFIXED_USER_HOME` pointing at that home.
4. Confirm `WageRoute/wageroute.db` is created and the original files are unchanged.
5. Relaunch and confirm adoption does not run again because the target exists.

## Native modules and packaging

`better-sqlite3` is a native module. It is built against a specific Node/Electron ABI.

- `npm install` runs `electron-builder install-app-deps` to rebuild it for Electron.
- `electron-builder.yml` sets `npmRebuild: true` and unpacks `**/*.node` from the asar.
- A plain `node` script that imports `better-sqlite3` uses the Node ABI, not the Electron ABI. If you need to run database code outside Electron, rebuild for Node or run it through Electron.

Symptoms of an ABI mismatch:

```text
Error: The module '.../better_sqlite3.node' was compiled against a different Node.js version
NODE_MODULE_VERSION ...
```

Fix:

```bash
npm run postinstall
# or
npx electron-builder install-app-deps
```

Architecture matters too: an arm64 Electron build needs an arm64 native module. `electron-builder` handles this per target, but a manual `npm rebuild` can produce the wrong architecture.

## Code conventions

- TypeScript strict, no `any` in new code.
- Two-space indentation, single quotes, no semicolons.
- Named exports for modules; default export only for the root `App`.
- `import type` for type-only imports.
- SQL is uppercase keywords; table and column names snake_case; repository aliases produce camelCase.
- Money variables end in `Cents`; formatted strings do not.
- Dates are `...On` or `...ISO`; timestamps are `...At`.
- UI text is sentence case, concise and specific. Empty states explain what to do next.
- Comments are used only for non-obvious constraints or history. Do not narrate what the code does.
- Errors are user-readable sentences, not codes.
- No network calls, no telemetry, no hidden writes.

### Renderer patterns

- Read data from `useFinanceStore`; do not fetch directly in components.
- Use selectors for derived numbers to avoid unnecessary re-renders.
- Keep dialogs local to their screen unless reused.
- Use `Button`, `Field`, `Modal`, `Money`, `Progress`, `Segmented` and `Switch` instead of new primitives.
- Confirm destructive actions with `window.confirm` and explain what is kept.
- Disable submit buttons while `busy`.

### Main patterns

- Validate at the IPC boundary (`requireId`) and in the repository (text, cents, enums, dates).
- Wrap multi-statement writes in `db.transaction`.
- Bump `revision` and `updated_at` on every update and soft delete.
- Filter `deleted_at IS NULL` in reads.
- Never interpolate a column or table name from user input.

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `NODE_MODULE_VERSION` mismatch | Native module built for Node, not Electron | `npm run postinstall` |
| App opens with Alex's demo data | Running unpackaged (`npm run dev`) with a fresh `userData` directory | Expected in development; use the real profile or import a backup |
| Changes do not appear | Snapshot not refreshed or app pointing at another database | Check the database path; restart; verify the store action awaited the mutation |
| CSV rows ignored | Account name mismatch or duplicate names | Check the issue message; rename or create accounts |
| JSON import fails with a foreign key error | Partial file references rows that are not local or earlier in the file | Include the referenced rows or null the links |
| Database changes seem lost | App still running and WAL not checkpointed | Quit before copying; copy `.db`, `-wal` and `-shm` |
| macOS refuses to open a build | Unsigned app, Gatekeeper | Right-click → Open, or sign/notarize |
| Windows SmartScreen warning | Unsigned installer, portable exe or zip | Expected for unsigned builds |
| Linux package manager warning | Unsigned deb/rpm, unverified AppImage | Expected for unsigned builds; verify the SHA-256 from SHA256SUMS.txt |
| Dev server port in use | Another Vite process | Stop it; Vite will otherwise choose the next port |
| TypeScript cannot resolve `@shared` | Alias missing in one config | Update both tsconfigs and `electron.vite.config.ts` |
| `electron-builder` uses the default icon | Icon path wrong or missing | Confirm `build/icon.icns` and `build/icon.png` |
| Backup file rejected as newer | Schema version in file exceeds app | Update the app; never edit the version down |

## Known test gaps

Before treating a change as complete, manually verify the paths that automated tests do not cover:

- account creation, editing, adjustment and deletion;
- paycheck commit and the resulting dashboard/donut state;
- transfer creation, paired edit and paired delete;
- round-up with each increment and destination type;
- bill prompt detection, snooze and mark-paid;
- theme switching, including system mode;
- JSON export → fresh-profile import;
- CSV export → fresh-profile import;
- partial JSON imports (settings only, transactions only);
- migration from the previous schema version on a database copy.

A build that type-checks and passes domain tests can still be functionally wrong. The manual list is part of the definition of done.

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
| `npm test` | `node --import tsx --test src/shared/domain.test.ts` | 19 domain tests |
| `npm run typecheck` | node + web type checks | Both TypeScript projects |
| `npm run typecheck:node` | `tsc --noEmit -p tsconfig.node.json` | Main, preload, shared, config |
| `npm run typecheck:web` | `tsc --noEmit -p tsconfig.json` | Renderer and shared |
| `npm run build` | typecheck + `electron-vite build` | `out/main`, `out/preload`, `out/renderer` |
| `npm run dist` | build + `electron-builder` | Current platform |
| `npm run dist:mac` | build + `electron-builder --mac` | DMG, arm64 + x64 |
| `npm run dist:win` | build + `electron-builder --win` | NSIS, x64 + arm64 |

There is no lint script and no formatter configuration. Consistency is maintained by convention and type checking.

## Project layout

```text
src/
├── main/
│   ├── index.ts              app lifecycle, window, security policy
│   ├── ipc.ts                channel handlers, dialogs, file I/O
│   └── db/
│       ├── connection.ts     singleton, pragmas, path
│       ├── migrations.ts     versioned schema
│       ├── repositories.ts   CRUD, derived reads, transfers, round-up
│       ├── backup.ts         JSON build/parse/merge
│       ├── entries.ts        CSV entry merge
│       ├── legacy.ts         pre-rename database adoption
│       └── seed.ts           first-run seed: blank (packaged) / demo (dev)
├── preload/
│   ├── index.ts              contextBridge API
│   └── index.d.ts            window.api typing
├── renderer/
│   ├── index.html            CSP, title
│   └── src/
│       ├── main.tsx          root, theme cache, error boundary
│       ├── App.tsx           screen switch, theme effect
│       ├── components/       Sidebar, grids, prompts, UI primitives
│       ├── lib/finance.ts    derived totals and labels
│       ├── screens/          one file per screen
│       ├── store/            Zustand store and selectors
│       └── styles/           tokens.css, app.css
└── shared/
    ├── allocator.ts
    ├── api.ts
    ├── billPrompts.ts
    ├── cadence.ts
    ├── csv.ts
    ├── dates.ts
    ├── emergency.ts
    ├── money.ts
    ├── projections.ts
    ├── settings.ts
    ├── transfers.ts
    ├── types.ts
    └── domain.test.ts
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

### Domain tests

`src/shared/domain.test.ts` uses `node:test` and `node:assert/strict`. It covers:

- money parsing and formatting boundaries;
- cadence smoothing and per-paycheck reserves;
- month-end date clamping and due-date derivation;
- allocator priority, shortfall, scaling, goal ordering, whole-dollar sweeping and the balance identity;
- debt as a surplus bucket;
- bill prompt chronology and early-payment window;
- round-up remainders and transfer legs;
- emergency variable averaging, essentials, target and coverage;
- settings defaults, corrupt input and round-trip serialization;
- CSV quoting, parsing, bank-style dates, duplicate headers and transfer rejection.

Run:

```bash
npm test
```

### What is not covered

There are no automated:

- repository/database tests;
- IPC integration tests;
- React component tests;
- end-to-end tests;
- visual regression tests;
- migration tests against fixture databases.

Those paths are verified manually. When changing them, use the disposable home and a copy of a real database, and document the manual check in the change description.

## Adding a feature

A typical feature crosses most layers. Use this checklist.

### 1. Domain and types

- Add or change types in `src/shared/types.ts`.
- Add pure rules in `src/shared` if the behaviour must be testable.
- Add tests in `src/shared/domain.test.ts`.

### 2. Storage

- Add columns or tables in a new migration (never edit an old one).
- Update `src/main/db/repositories.ts`:
  - validation;
  - insert/update/read mappings (snake_case → camelCase);
  - derived queries;
  - snapshot assembly if the data is part of the read model.
- Update `src/main/db/backup.ts`:
  - `TABLE_COLUMNS` for any new table or column;
  - `FALLBACK_VALUES` for columns that may be absent in older backups;
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

## Adding an IPC channel

1. Define the input and output types in `src/shared/types.ts` or `src/shared/api.ts`.
2. Add the method signature to `FinanceApi`.
3. Register `ipcMain.handle('domain:action', ...)` in `src/main/ipc.ts`.
   - Validate IDs with `requireId`.
   - Delegate payload rules to the repository; do not duplicate them in the handler.
4. Expose it in `src/preload/index.ts`.
5. Add a store action that calls it, refreshes the snapshot and surfaces errors.
6. Keep channel names `domain:verb` (`account:create`, `data:import`).

Do not expose `ipcRenderer`, `require`, `fs` or raw SQL to the renderer.

## Adding a schema migration

Migrations are append-only. Never modify `SCHEMA_V1`, `SCHEMA_V2` or `SCHEMA_V3` once released; databases in the field have already run them.

### Procedure

1. Add a new SQL string, e.g. `SCHEMA_V4`.
2. Add `{ version: 4, up: (db) => db.exec(SCHEMA_V4) }` to `MIGRATIONS`.
3. `SCHEMA_VERSION` updates automatically from the last entry.
4. Update types, repositories, backup allowlists and the seed.
5. Test against a copy of a version-3 database:
   - `PRAGMA user_version` before and after;
   - row counts preserved;
   - new columns present with correct defaults;
   - app boots and snapshot loads.
6. Test a fresh database and an upgrade database separately.
7. Add or update documentation.

### SQLite constraints

- `ALTER TABLE ... ADD COLUMN` is supported. Added columns need a default or must be nullable.
- Changing a CHECK constraint, renaming a column or changing a primary key generally requires a table rebuild. Follow the v2 pattern:
  1. create a new table with the desired schema;
  2. `INSERT INTO new SELECT ... FROM old`;
  3. drop the old table;
  4. rename the new table;
  5. recreate indexes.
- The migration loop wraps each version in a transaction and sets `user_version` inside it.
- With foreign keys enabled, a rebuild is safe only when no other table references the table being dropped. `allocations` was safe; `accounts` would not be.

### Backup compatibility

If a new column is added:

- add it to `TABLE_COLUMNS`;
- add a fallback in `FALLBACK_VALUES` if backups without it should import cleanly;
- decide whether the backup `version` should increase. A new `version` means older app builds reject newer files; that is usually correct for a breaking schema change.

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

For scripted UI checks, launch the built app or dev app with a remote debugging port and connect with the Chrome DevTools Protocol:

```bash
"/Applications/WageRoute.app/Contents/MacOS/WageRoute" --remote-debugging-port=9222
```

Then query `http://127.0.0.1:9222/json` for the page target. A small Node script using `Runtime.evaluate` can click buttons, read text and take screenshots. Use a disposable home so the script never touches real data.

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
| Windows SmartScreen warning | Unsigned NSIS installer | Expected for unsigned builds |
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

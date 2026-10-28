# Architecture

WageRoute is a three-process Electron application with a deliberately small surface: a sandboxed React renderer, a typed preload bridge, and a main process that owns SQLite and the filesystem. All financial rules live in a pure TypeScript layer shared by every process.

There is no backend service. The application makes no network requests.

---

## Contents

- [Constraints](#constraints)
- [Runtime topology](#runtime-topology)
- [Boot sequence](#boot-sequence)
- [Renderer lifecycle and state](#renderer-lifecycle-and-state)
- [IPC surface](#ipc-surface)
- [The shared domain layer](#the-shared-domain-layer)
- [The main/database layer](#the-maindatabase-layer)
- [Request flows](#request-flows)
- [Security boundary](#security-boundary)
- [Error handling](#error-handling)
- [Build system](#build-system)
- [Module map](#module-map)
- [Non-goals](#non-goals)

---

## Constraints

The architecture follows from five constraints:

1. **Local-only, single user.** No auth, no server, no network. The database is the product.
2. **Deterministic money.** Integer cents everywhere; routing decisions are reproducible from inputs.
3. **One source of truth.** SQLite owns state; the renderer holds a read snapshot and re-reads after every mutation.
4. **A narrow privilege boundary.** The renderer never touches Node, the filesystem or SQLite directly.
5. **Future sync without a rewrite.** UUID keys, `updated_at`, `revision` and soft deletes are already in the schema, but no sync code exists.

## Runtime topology

```text
┌────────────────────────────────────────────────────────────────────┐
│ Electron main process                                              │
│                                                                    │
│  app lifecycle ──► connection.ts ──► migrations.ts                 │
│       │                 │                                          │
│       │                 ├──► seed.ts (first run only)               │
       │                 │      packaged: blank user + defaults      │
       │                 │      dev: demo profile (Alex)             │
│       │                 └──► repositories.ts (all SQL)              │
│       │                                                            │
│       ├──► ipc.ts (handlers, dialogs, file I/O)                    │
│       └──► BrowserWindow (sandboxed)                               │
│                                                                    │
│  shared/ domain functions imported directly (no IPC)               │
└───────────────────────────────┬────────────────────────────────────┘
                                │ contextBridge: window.api
                                │ ipcRenderer.invoke / ipcMain.handle
┌───────────────────────────────▼────────────────────────────────────┐
│ Preload (sandboxed)                                                │
│  - exposes one typed FinanceApi object                             │
│  - no Node APIs, no filesystem, no ipcRenderer object leaked       │
└───────────────────────────────┬────────────────────────────────────┘
                                │
┌───────────────────────────────▼────────────────────────────────────┐
│ Renderer (React 19 + Zustand)                                      │
│  screens ──► useFinanceStore ──► window.api ──► snapshot refresh   │
│  pure helpers in src/renderer/src/lib/finance.ts                   │
└────────────────────────────────────────────────────────────────────┘
```

The same `src/shared` modules are imported by both the main process and the renderer. The build aliases ensure there is exactly one implementation of the allocator, cadence maths, date helpers, money parsing and CSV logic.

## Boot sequence

`src/main/index.ts`:

1. `app.setName('WageRoute')` runs before Electron resolves the `userData` path, so the data directory uses the new product name.
2. A single-instance lock is requested. A second launch quits immediately; the existing window is restored and focused.
3. After `whenReady()`:
   - every permission request is denied (`session.defaultSession.setPermissionRequestHandler`);
   - on macOS in development only, the dock icon is set from `build/icon.png`;
   - `adoptLegacyDatabase()` copies a pre-rename database if the new one is absent;
   - `getDatabase()` opens `wageroute.db`, sets WAL/NORMAL/foreign keys/busy timeout, and runs migrations;
   - packaged builds run `seedIfEmpty()` (a blank local user plus default settings, only when no user row exists); development runs `seedDemoIfEmpty()` (the Alex demo profile);
   - `registerIpcHandlers(db)` binds every channel;
   - `createWindow()` builds the BrowserWindow.
4. `before-quit` closes the SQLite handle.

The window is created with `show: false` and shown on `ready-to-show`. Security settings:

```ts
webPreferences: {
  preload: join(__dirname, '../preload/index.js'),
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true
}
```

Navigation is constrained: `setWindowOpenHandler` denies all child windows and sends `http(s)` URLs to the OS browser; `will-navigate` allows only the dev server URL in development or `file://` in production.

## Renderer lifecycle and state

`src/renderer/src/main.tsx`:

- imports the design tokens and application CSS;
- adds `is-mac` for platform-specific chrome;
- resolves the cached theme from `localStorage['cfr-theme']` before React paints to avoid a flash;
- wraps `App` in an error boundary that offers a reload button.

`src/renderer/src/App.tsx`:

- calls `init()` once;
- applies the theme (`dark`, `light`, or `system` through `matchMedia`) to `document.documentElement.dataset.theme`;
- renders a boot screen while loading or an error screen if the database cannot open;
- switches screens with a plain conditional, not a router.

The Zustand store (`src/renderer/src/store/useFinanceStore.ts`) holds:

| Field | Meaning |
| --- | --- |
| `status` | `loading`, `ready`, `error` |
| `error` | Boot failure message |
| `snapshot` | The complete read model from SQLite |
| `settings` | Parsed `AppSettings`, derived from `snapshot.settings` |
| `dbPath` | Absolute database path shown in the sidebar and Settings |
| `screen` | Active screen id |
| `allocatorOpen` | Wizard visibility |
| `busy` | Mutation in flight, used to disable controls |
| `notice` | Toast text and tone, auto-dismissed after 4.2 s |
| `snoozedBillIds` | In-memory bill prompt dismissals for this session |

### The mutation loop

Every write follows the same path:

```text
UI action
  └─► store action
        ├─ set busy = true
        ├─ await window.api.<mutation>(...)
        ├─ await window.api.getSnapshot()
        ├─ replace snapshot + parsed settings
        ├─ optionally show success toast
        ├─ on error: show error toast, keep old snapshot
        └─ set busy = false
```

There is no optimistic update and no client-side cache invalidation. The database is authoritative, and the UI cannot drift from it. The cost is one extra IPC round-trip per mutation; the benefit is that every screen always sees exactly what SQLite contains.

`saveSettings` is the one exception: it updates local state immediately for responsiveness, then persists. If persistence fails, the user sees an error toast.

### Selectors

`selectSafeToSpendCents`, `selectSafeToSpendPoolCents`, `selectCashOnHandCents`, `selectMonthlyWallCents`, `selectFundedGoalsCents`, `selectPoolEarmarkedGoalsCents` and `selectTotalWealthCents` return numbers only. Zustand's default `Object.is` comparison therefore prevents re-renders when unrelated parts of the snapshot change.

The maths is never re-derived in a component. The spendable pool, which goal money may be deducted from it, total wealth and its buckets all come from pure functions in `src/shared/accounts.ts`, so the tests, the main process and the renderer answer with the same rules — a screen either uses a selector or calls the shared function on `snapshot.accounts` directly. `wealthBuckets` returns a freshly-allocated array, so it is used with the whole snapshot in a render body rather than as a selector.

Two goal totals exist on purpose and are not interchangeable: `selectFundedGoalsCents` is every goal's money (used by the committed-spending meter, measured against all cash), while `selectPoolEarmarkedGoalsCents` is only the money that sits inside the spendable pool. Deducting the first from the pool would subtract dedicated-account goal money twice — once by keeping it out of the pool, once by deducting it as progress — which is the mistake [ADR 0007](decisions/0007-dedicated-accounts-balance-is-progress.md) records.

## IPC surface

Channels are registered once in `src/main/ipc.ts` and exposed through `src/preload/index.ts` as `window.api`. Every handler returns a promise; errors reject the invoke and are converted to a toast in the store.

| Channel | API method | Arguments | Result |
| --- | --- | --- | --- |
| `snapshot:get` | `getSnapshot` | — | Full `Snapshot` |
| `db:path` | `getDatabasePath` | — | Absolute path |
| `account:create` | `createAccount` | `AccountInput` | `void` |
| `account:update` | `updateAccount` | `id`, `Partial<AccountInput>` | `void` |
| `account:delete` | `deleteAccount` | `id` | `void` |
| `bill:create` | `createBill` | `BillInput` | `void` |
| `bill:update` | `updateBill` | `id`, `Partial<BillInput>` | `void` |
| `bill:delete` | `deleteBill` | `id` | `void` |
| `goal:create` | `createGoal` | `GoalInput` | `void` |
| `goal:update` | `updateGoal` | `id`, `Partial<GoalInput>` | `void` |
| `goal:delete` | `deleteGoal` | `id` | `void` |
| `transaction:create` | `createTransaction` | `TransactionInput` | `void` (id discarded) |
| `transaction:update` | `updateTransaction` | `id`, `TransactionPatch` | `void` |
| `transaction:delete` | `deleteTransaction` | `id` | `void` |
| `paycheck:commit` | `commitPaycheck` | `PaycheckDraftInput` | `CommittedPaycheck` |
| `settings:save` | `saveSettings` | `AppSettings` | `void` |
| `backup:export` | `exportBackup` | — | saved path or `null` |
| `csv:export` | `exportTransactionsCsv` | — | saved path or `null` |
| `data:preview` | `previewImport` | — | `ImportPreview` or `null` (cancelled) |
| `data:confirm` | `confirmImport` | `token`, `ImportAnswer[]` | `ImportResult` |
| `data:reset` | `resetData` | — | `void` (wipes every table, re-seeds a blank profile) |

Notes:

- `requireId` rejects empty or non-string IDs at the boundary. Full payload validation happens in the repository helpers.
- File dialogs are owned by the invoking window, so they are modal to WageRoute.
- Export and import use native save/open dialogs. The main process reads and writes the chosen file.
- The import reader rejects files larger than **64 MiB** before parsing.
- `data:preview` keeps the chosen file in a main-process map and hands back a single-use token; `data:confirm` accepts only that token. The renderer can never ask the main process to read a path it chose itself.

## The shared domain layer

`src/shared` is pure TypeScript with no Electron, Node or DOM dependencies (except types). It is the specification of the product.

| Module | Responsibility | Key exports |
| --- | --- | --- |
| `allocator.ts` | Deterministic paycheck routing | `buildAllocationPlan`, `AllocationPlan`, `PlanWarning` |
| `cadence.ts` | Frequency smoothing | `monthlyEquivalentCents`, `reservePerPaycheckCents`, labels |
| `dates.ts` | Calendar-safe ISO helpers | `todayISO`, `addMonthsISO`, `nextDueDateISO`, `previousDueDateISO`, `advanceByFrequency` |
| `money.ts` | Parsing, formatting, rounding | `parseMoneyToCents`, `centsToEditable`, `formatMoney`, `percentOf`, `floorToDollarCents` |
| `emergency.ts` | Emergency target and coverage | `averageMonthlyVariableCents`, `emergencyMonthlyEssentialsCents`, `recommendedEmergencyTargetCents`, `emergencyCoverageMonths` |
| `projections.ts` | 90-day bill/goal forecast | `projectUpcoming` |
| `billPrompts.ts` | Past-due bill detection | `dueBillPrompts` |
| `transfers.ts` | Paired legs and round-up remainder | `transferLegs`, `roundUpRemainderCents` |
| `settings.ts` | Settings defaults, parsing, serialization | `DEFAULT_SETTINGS`, `parseSettings`, `settingsToRecord` |
| `csv.ts` | CSV export, RFC 4180 parsing, entries import grammar | `toCsv`, `parseCsv`, `parseEntriesCsv`, `transactionsToCsv` |
| `api.ts` | IPC contract | `FinanceApi`, `ImportResult`, `ImportCounts` |
| `types.ts` | Domain types and inputs | `Snapshot`, `AppSettings`, all row types |

### Why the allocator is pure

`buildAllocationPlan` takes income, cadence, bills, goals and splits and returns a complete plan. It does not read the database, the clock or the UI. This makes the core money behaviour unit-testable and makes the commit path a thin wrapper:

```text
commitPaycheck
  ├─ validate input
  ├─ load active bills + goals
  ├─ buildAllocationPlan(...)
  ├─ write one paycheck row
  ├─ write non-zero allocation rows
  └─ write one income transaction
```

The invariant enforced by the algorithm is:

```text
priorityFunded + savings + investment + goals + debt + leisure === income
```

If the wall exceeds income, the wall is partially funded, every other bucket is zero and `health` is `shortfall`.

### Calendar rules

- Dates are `YYYY-MM-DD` strings with no time component.
- `addMonthsISO` clamps to the last valid day of the target month (`2026-01-31 + 1 month = 2026-02-28`).
- `monthsUntil` uses `Math.ceil(days / 30.4375)` and never returns less than 1, so a goal due today still has a one-month pace.
- `nextDueDateISO` returns today when the due day is today; `previousDueDateISO` also returns today. Bill prompts then apply a strict `dueOn < today` test, so a bill is never “late” on its due date.

## The main/database layer

### Connection

`src/main/db/connection.ts` holds one `better-sqlite3` instance:

- path: `join(app.getPath('userData'), 'wageroute.db')`;
- `journal_mode = WAL`;
- `synchronous = NORMAL`;
- `foreign_keys = ON`;
- `busy_timeout = 5000`;
- migrations run before the instance is returned;
- `closeDatabase()` is called on quit.

### Repositories

`src/main/db/repositories.ts` is the only module that executes SQL for CRUD and snapshots. It provides:

- validation helpers (`assertText`, `assertCents`, `assertOneOf`, `assertDate`);
- soft delete and update helpers that bump `revision` and `updated_at`;
- derived read queries (account balances, goal funding);
- transfer-group and round-up logic;
- paycheck commit and snapshot assembly.

There is no ORM. SQL is explicit and parameterised; column names come from internal allowlists, never from user input.

### Read model

`getSnapshot` returns:

```ts
{
  user,
  settings,               // raw key/value record
  accounts,               // includes archived, each with balanceCents
  bills,                  // non-deleted, active first
  goals,                  // non-deleted, with fundedCents/remainingCents
  transactions,            // non-deleted, newest first, LIMIT 500
  paychecks               // non-deleted, newest first, LIMIT 24 + allocations
}
```

Limits are deliberate: the UI is a working ledger, not an archive browser. JSON backup bypasses these limits and reads every row.

### Transaction boundaries

These operations are atomic:

- account deletion (null out references, then soft delete);
- transaction creation with paired legs;
- transaction creation with round-up;
- editing or deleting one leg of a transfer group;
- paycheck commit (paycheck + allocations + income entry);
- backup merge;
- CSV entry insert batch.

If any statement throws, the transaction rolls back and the UI shows the error.

## Request flows

### Route a paycheck

```text
Allocator wizard (3 steps)
  ├─ 1. income, date, source, deposit account, cadence
  ├─ 2. preview the Priority Wall reserve and true surplus
  └─ 3. adjust savings/investment/goals/debt percentages
        ├─ save splits + cadence + whole-dollar preference to settings
        └─ commitPaycheck
              ├─ buildAllocationPlan
              ├─ INSERT paychecks
              ├─ INSERT allocations (amount > 0)
              └─ INSERT income transaction on the deposit account
```

The income transaction changes the account balance. Allocation lines do not. Moving money to savings or investments remains a manual transfer, which is a separate explicit action.

### Add an expense with round-up

```text
EntryDialog / spreadsheet / bill prompt
  └─ createTransaction(kind = expense, amount < 0)
        ├─ INSERT expense row
        └─ if round-up enabled
              ├─ source account is checking or cash
              ├─ destination is active, not credit/investment, not the source
              ├─ sweep = increment − (|amount| mod increment)
              ├─ INSERT negative transfer leg on source
              └─ INSERT positive transfer leg on destination
```

Both round-up legs share a new `transfer_group_id`. Imported CSV entries call the insert statement directly and never trigger round-up.

### Import a file

```text
data:preview
  ├─ open dialog (JSON or CSV) → null when cancelled
  ├─ read file, reject > 64 MiB
  ├─ .csv  ──► parseEntriesCsv ──► findUnmappedAccounts ──► problems
  ├─ .json ──► parseBackupJson ──► findImportProblems ──────► problems
  └─ hold the file under a token, return ImportPreview { token, fileRows, problems, choices }

ImportWizard (renderer)
  ├─ step 2: one question per problem, answered or left out
  └─ step 3: review, then confirmImport(token, answers)

data:confirm
  ├─ takeImport(token)          ← single use, oldest of 8 evicted
  ├─ .csv  ──► buildAccountMap ──► mergeEntries ──► result
  └─ .json ──► findImportProblems (same pure rules, re-derived)
             ──► applyImportAnswers ──► mergeBackup ──► result
```

Problem detection is shared, pure code in `src/shared/importRepair.ts`, so the main process re-derives exactly the questions the wizard showed and can trust `table:index` answer keys. Anything still unusable is dropped with a reason rather than thrown, and `mergeBackup` / `mergeEntries` isolate the remaining database errors per row.

JSON import preserves IDs for cross-table links. CSV import creates new UUIDs and resolves accounts by name — or by your mapping in the wizard — because a CSV has no IDs to preserve.

### Delete an account

```text
account:delete
  └─ transaction
       ├─ bills.account_id       := NULL
       ├─ goals.account_id       := NULL
       ├─ paychecks.deposit_account_id := NULL
       └─ accounts.deleted_at    := now
```

The account disappears from balances and pickers. Its transaction rows are not deleted and still join to the soft-deleted account, so history remains readable.

## Security boundary

The boundary is examined in detail in [SECURITY.md](SECURITY.md). In summary:

- renderer: sandboxed, no Node, no direct filesystem or SQL;
- preload: one frozen-by-usage API object on `window.api`;
- main: validates IDs, delegates payload rules to repositories, parameterises SQL;
- navigation: child windows denied, external `http(s)` links opened by the OS, other navigation blocked;
- permissions: all denied;
- CSP: self-only scripts/styles, self/data images and fonts, localhost connect-src for development;
- data: unencrypted SQLite on disk, protected only by the OS account and full-disk encryption.

The renderer is trusted to call its own API methods. A compromised renderer can invoke any mutation, so XSS prevention is part of the security model rather than an optional hardening step.

## Error handling

| Layer | Behaviour |
| --- | --- |
| Main / repositories | Throws `Error` with a user-readable message; no partial writes because of transaction boundaries |
| Preload | Rejections propagate unchanged |
| Store | Strips Electron's `Error invoking remote method '...':` prefix, shows a 4.2 s error toast |
| Boot | A failed `getSnapshot` or `db:path` sets `status = 'error'` and renders a full-screen message |
| React | Error boundary renders the message and a reload button |

There is no logging subsystem, crash reporter, telemetry or error persistence. Errors are visible only while the toast is on screen.

## Build system

`electron.vite.config.ts` defines three builds:

- **main** — Node target, dependencies externalised, `@shared` alias;
- **preload** — Node target, dependencies externalised, `@shared` alias;
- **renderer** — browser target, React plugin, `@shared` and `@renderer` aliases, relative base for `file://` loading.

TypeScript runs in two projects:

- `tsconfig.node.json` covers `src/main`, `src/preload`, `src/shared` and the Vite config;
- `tsconfig.json` covers the renderer, shared code and preload typings, and excludes tests.

Both use `strict: true`, `verbatimModuleSyntax`, `isolatedModules` and no emit. `npm run build` refuses to bundle unless both type checks pass.

`electron-builder.yml` packages `out/**/*` and `package.json`, unpacks native `.node` files from the asar, and rebuilds native dependencies for Electron.

## Module map

| Path | Owns |
| --- | --- |
| `src/shared/types.ts` | Domain types shared by both processes |
| `src/shared/money.ts` | Money parsing and formatting, percent helpers, cent rounding |
| `src/shared/dates.ts` | ISO date maths, due-date derivation, month-end clamping |
| `src/shared/cadence.ts` | Per-year period counts, monthly equivalents, per-paycheck reserves |
| `src/shared/allocator.ts` | Paycheck split, priority order, shortfall scaling |
| `src/shared/accounts.ts` | Safe-to-spend membership, spendable pool, total wealth, wealth buckets |
| `src/shared/billPrompts.ts` | Bill prompt chronology and early-payment window |
| `src/shared/projections.ts` | Upcoming-month bill/goal projection rows |
| `src/shared/transfers.ts` | Round-up remainders and paired transfer legs |
| `src/shared/emergency.ts` | Emergency-fund variables, essentials and coverage |
| `src/shared/settings.ts` | Settings defaults, corrupt-input recovery, serialization |
| `src/shared/importRepair.ts` | Import problem detection, repair questions and field validation |
| `src/shared/csv.ts` | CSV encoding/parsing and entry-row validation |
| `src/shared/api.ts` | The `FinanceApi` contract the preload implements |
| `src/main/index.ts` | App lifecycle, window, navigation policy, permissions |
| `src/main/ipc.ts` | Channel registration, dialogs, file reads/writes |
| `src/main/db/connection.ts` | Database singleton, pragmas, path |
| `src/main/db/migrations.ts` | Schema versions 1–4 |
| `src/main/db/repositories.ts` | All CRUD, derived reads, transfers, round-up, paycheck commit |
| `src/main/db/backup.ts` | Backup build/parse/merge |
| `src/main/db/entries.ts` | CSV entry merge and account resolution |
| `src/main/db/legacy.ts` | Pre-rename database adoption |
| `src/main/db/seed.ts` | First-run seed: blank user in packaged builds, demo profile in development |
| `src/preload/index.ts` | IPC bridge |
| `src/renderer/src/store/useFinanceStore.ts` | Client state, mutation loop, selectors |
| `src/renderer/src/lib/finance.ts` | UI-facing derived totals and labels |
| `src/renderer/src/screens/*` | Screen-level behaviour |
| `src/renderer/src/components/*` | Reusable UI, grids, prompts |
| `src/renderer/src/styles/tokens.css` | Dark/light design tokens |
| `src/renderer/src/styles/app.css` | Layout and component styling |

## Non-goals

The current architecture intentionally excludes:

- user accounts, authentication or multi-tenancy (the schema has `user_id`, but there is one local user);
- a server, API or sync engine;
- bank aggregation or OFTP/CSV statement automation;
- auto-update;
- encryption at rest;
- multi-window support;
- routing, i18n, or a component library;
- a job queue or background workers.

Any of these can be added, but each one crosses a boundary described in this document and should arrive with its own decision record.

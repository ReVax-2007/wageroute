# Architecture

WageRoute is a three-process Electron application with a deliberately small surface: a sandboxed React renderer, a typed preload bridge, and a main process that owns SQLite and the filesystem. All financial rules live in a pure TypeScript layer shared by every process.

There is no backend service. The desktop application makes no network requests. The optional Pocket build is a folder of static files served from one origin; it has no server-side code and makes no cross-origin request.

---

## Contents

- [Constraints](#constraints)
- [Runtime topology](#runtime-topology)
- [Boot sequence](#boot-sequence)
- [Renderer lifecycle and state](#renderer-lifecycle-and-state)
- [IPC surface](#ipc-surface)
- [The shared domain layer](#the-shared-domain-layer)
- [Pocket (browser app)](#pocket-browser-app)
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
│       │                 └──► repo/ modules (all SQL)                │
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
│  screens ──► useFinanceStore ──► window.api ──► SnapshotPatch merge│
│  pure helpers in src/renderer/src/lib/finance.ts                   │
└────────────────────────────────────────────────────────────────────┘
```

The same `src/shared` modules are imported by both the main process and the renderer. The build aliases ensure there is exactly one implementation of the allocator, cadence maths, date helpers, money parsing and CSV logic.

## Boot sequence

`src/main/index.ts`:

1. `app.setName('WageRoute')` runs before Electron resolves the `userData` path, so the data directory uses the new product name.
2. A single-instance lock is requested. A second launch quits immediately; the existing window is restored and focused.
3. After `whenReady()`:
   - every permission request and permission check is denied except a sanitised clipboard write, which the copy buttons need (`setPermissionRequestHandler` plus `setPermissionCheckHandler`);
   - on macOS in development only, the dock icon is set from `build/icon.png`;
   - `adoptLegacyDatabase()` copies a pre-rename database if the new one is absent;
   - `getDatabase()` opens `wageroute.db`, sets WAL/NORMAL/foreign keys/busy timeout, runs `PRAGMA quick_check`, writes a pre-upgrade copy when the file is older than the build, runs migrations, and then takes the day's `daily-YYYY-MM-DD.db` copy (skipped when today already has one; a failure goes to the crash log instead of blocking the open);
   - packaged builds run `seedIfEmpty()` (a blank local user plus default settings, only when no user row exists); development runs `seedDemoIfEmpty()` (the Alex demo profile);
   - `registerIpcHandlers(db)` binds every channel;
   - `runBootTasks(db)` posts autopay bills that fell due (`postDueAutopay`) and records one balance snapshot per live account per day (`recordDailySnapshots`), each in its own `try/catch` that reports to the crash log, so neither can prevent the window;
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

Navigation is constrained by [`src/main/window-security.ts`](../src/main/window-security.ts). `setWindowOpenHandler` denies every child window and opens only an allowlisted external URL (the Buy Me a Coffee page) in the OS browser. `will-navigate` allows the packaged `index.html` by exact URL, or — in development only — any page on the dev server's origin; everything else is cancelled. The same trust predicate backs `isTrustedFrame()` in the IPC layer, so navigation and IPC agree on what counts as the app.

## Renderer lifecycle and state

`src/renderer/src/main.tsx`:

- imports the design tokens and application CSS;
- adds `is-mac` for platform-specific chrome;
- resolves the cached theme from `localStorage['cfr-theme']` before React paints to avoid a flash;
  the `cfr` prefix predates the WageRoute rename and is kept so an existing installation does not
  lose its theme; the same legacy prefix survives in the `cash-flow-routing-backup` format name;
- wraps `App` in an error boundary that offers a reload button.

`src/renderer/src/App.tsx`:

- calls `init()` once;
- applies the theme (`dark`, `light`, or `system` through `matchMedia`) to `document.documentElement.dataset.theme`;
- renders a boot screen while loading or an error screen if the database cannot open;
- switches screens with a plain conditional, not a router.

The Zustand store is a thin `create()` joining two slices in `src/renderer/src/store/`: `session.ts` (what the window is showing) and `data.ts` (the snapshot, the write queue and every action). `useFinanceStore.ts` re-exports `useFinanceStore` and the nine selectors, so screens import the same names they always have. It holds:

| Field | Slice | Meaning |
| --- | --- | --- |
| `status` | data | `loading`, `ready`, `error` |
| `error` | data | Boot failure message |
| `snapshot` | data | The complete read model from SQLite |
| `settings` | data | Parsed `AppSettings`, derived from `snapshot.settings` |
| `dbPath` | data | Absolute database path shown in the sidebar and Settings |
| `pending` | data | Per-row write flags keyed by row id |
| `screen` | session | Active screen id |
| `allocatorOpen` | session | Wizard visibility |
| `busy` | session | Mutation in flight, used to disable controls |
| `notice` | session | Toast text and tone, auto-dismissed unless it is an error |
| `confirm` | session | The one open confirmation question |
| `snoozedPrompts` | session | In-memory bill prompt dismissals for this session, keyed `billId:dueOn` |

### The mutation loop

Every write follows the same path:

```text
UI action
  └─► store action (serial queue)
        ├─ await window.api.<mutation>(...)
        ├─ receive WriteResult { value, patch, refreshError? }
        ├─ merge patch.tables into snapshot + re-parse settings
        ├─ optionally show success toast
        ├─ on error: show error toast, keep old snapshot
        └─ on refreshError: the write happened, show the re-read failure
```

`patch` is a `SnapshotPatch` (`Partial<Snapshot>`) read in the same SQLite transaction as the write, so the renderer adopts exactly the tables the write touched — an entry save no longer re-sends every bill, goal and paycheck. `getSnapshot()` is reserved for boot, an import confirm and an explicit `refresh()`. There is no optimistic update; the database is authoritative, and the UI cannot drift from it. Writes are serialised, so two fast saves cannot land an older snapshot over a newer one.

`saveSettings` is the one exception: it updates local state immediately for responsiveness, then persists. If persistence fails, the user sees an error toast and the previous values return.

### Selectors

`selectSafeToSpendCents`, `selectSafeToSpendPoolCents`, `selectCashOnHandCents`, `selectMonthlyWallCents`, `selectFundedGoalsCents`, `selectPoolEarmarkedGoalsCents` and `selectTotalWealthCents` return numbers only. Zustand's default `Object.is` comparison therefore prevents re-renders when unrelated parts of the snapshot change.

The maths is never re-derived in a component. The spendable pool, which goal money may be deducted from it, total wealth and its buckets all come from pure functions in `src/shared/accounts.ts`, so the tests, the main process and the renderer answer with the same rules — a screen either uses a selector or calls the shared function on `snapshot.accounts` directly. `wealthBuckets` returns a freshly-allocated array, so it is used with the whole snapshot in a render body rather than as a selector.

Two goal totals exist on purpose and are not interchangeable: `selectFundedGoalsCents` is every goal's money (used by the committed-spending meter, measured against all cash), while `selectPoolEarmarkedGoalsCents` is only the money that sits inside the spendable pool. Deducting the first from the pool would subtract dedicated-account goal money twice — once by keeping it out of the pool, once by deducting it as progress — which is the mistake [ADR 0007](decisions/0007-dedicated-accounts-balance-is-progress.md) records.

## IPC surface

`src/shared/channels.ts` is the single declaration of the wire contract: every channel name, its argument tuple and its result. `Channel`, `ChannelArgs<C>`, `ChannelResult<C>` and `IpcCaller` derive from `IpcContract`, and the `CHANNELS` array is checked at compile time to name every member. `src/main/ipc.ts` registers typed handlers against it and throws at boot if a declared channel was never registered; `src/preload/api.ts` builds `FinanceApi` from one `IpcCaller`, and `src/preload/index.ts` is the only Electron code in the bridge. `src/preload/api.test.ts` proves every method maps to a declared channel and that the bridge exposes exactly one method per channel.

Every write resolves with `WriteResult<T>` — `{ value, patch, refreshError? }` — where `patch` is a `SnapshotPatch` holding only the snapshot tables that write touched.

| Channel | Arguments | Result |
| --- | --- | --- |
| `snapshot:get` | — | Full `Snapshot` |
| `db:path` | — | Absolute path |
| `app:info` | — | `AppInfo`: version, schema version, Electron version |
| `app:diagnostics` | — | `AppDiagnostics`: runtime versions, paths, log tail and row counts |
| `app:legal` | — | `LegalTexts`: the bundled licence and third-party notices |
| `account:create` | `AccountInput` | `WriteResult<string>` (new id) |
| `account:update` | `id`, `Partial<AccountInput>` | `WriteResult<void>` |
| `account:delete` | `id`, `{ withEntries?: boolean }?` | `WriteResult<void>` |
| `account:archive` | `id`, `archived: boolean` | `WriteResult<void>` |
| `account:entry-count` | `id` | `number` (used by the delete dialog) |
| `bill:create` | `BillInput` | `WriteResult<string>` |
| `bill:update` | `id`, `Partial<BillInput>` | `WriteResult<void>` |
| `bill:delete` | `id` | `WriteResult<void>` |
| `bill:payments` | `YYYY-MM` month | `BillPaymentTotal[]` (per-bill payments in that month) |
| `goal:create` | `GoalInput` | `WriteResult<string>` |
| `goal:update` | `id`, `Partial<GoalInput>` | `WriteResult<void>` |
| `goal:delete` | `id` | `WriteResult<void>` |
| `goal:archive` | `id`, `archived: boolean` | `WriteResult<void>` |
| `transaction:create` | `TransactionInput` | `WriteResult<string>` |
| `transaction:update` | `id`, `TransactionPatch` | `WriteResult<void>` |
| `transaction:delete` | `id` | `WriteResult<void>` |
| `transaction:delete-many` | `ids: string[]` | `WriteResult<number>` (rows removed) |
| `transaction:query` | `LedgerQuery` | `TransactionPage` (`{ rows, total }`) |
| `category:create` | `CategoryInput` | `WriteResult<string>` |
| `category:update` | `id`, `Partial<CategoryInput>` | `WriteResult<void>` |
| `category:delete` | `id` | `WriteResult<void>` |
| `paycheck:commit` | `PaycheckDraftInput` | `WriteResult<CommittedPaycheck>` |
| `paycheck:apply` | `id`, `PlanMoveTarget[]` | `WriteResult<AppliedPlan>` |
| `settings:save` | `AppSettings` | `WriteResult<void>` |
| `backup:export` | — | saved path or `null` |
| `csv:export` | — | saved path or `null` |
| `statement:reconcile` | `accountId`, `statementCents`, `balanceOn` | `WriteResult<number>` (adjustment posted; `0` when the ledger already agreed) |
| `data:preview` | — | `ImportPreview` or `null` (cancelled) |
| `data:confirm` | `token`, `ImportAnswer[]` | `ImportResult` |
| `data:reset` | — | `WriteResult<void>` (wipes every table, re-seeds a blank profile) |

Notes:

- The types describe the wire; the main process still validates every id and option at runtime, because a type is not a guarantee. `requireId` rejects empty or non-string IDs at the boundary, `requireMonth` refuses anything but a real `YYYY-MM` month, `requireDate` and `requireCents` guard the reconciliation call, and full payload validation happens in the repository helpers.
- `data:confirm` returns a `reconciliation` when a statement carried a closing balance and its account was mapped. The comparison is made after the merge against `accountBalanceOn`, so the dialog describes the ledger as it stands; `statement:reconcile` then posts one `adjustment` dated on the closing day. `reconcileAccountOn` in the repository owns the credit-card sign conversion and the "already agrees" case.
- File dialogs are owned by the invoking window, so they are modal to WageRoute.
- Export and import use native save/open dialogs. The main process reads and writes the chosen file.
- The import reader rejects files larger than **64 MiB** before parsing, and both the `stat` and the read are asynchronous so a large file does not block the main process.
- `data:preview` keeps the chosen file in a main-process map and hands back a single-use token; `data:confirm` accepts only that token. The renderer can never ask the main process to read a path it chose itself.

## The shared domain layer

`src/shared` is pure TypeScript with no Electron, Node or DOM dependencies (except types). It is the specification of the product.

| Module | Responsibility | Key exports |
| --- | --- | --- |
| `allocator.ts` | Deterministic paycheck routing | `buildAllocationPlan`, `AllocationPlan`, `PlanWarning` |
| `cadence.ts` | Frequency smoothing and which paycheck funds a bill | `monthlyEquivalentCents`, `reservePerPaycheckCents`, `billFundingReserveCents`, `fundingCheckIndex`, `paycheckIndexInMonth`, `reachableCheckIndexes`, labels |
| `dates.ts` | Calendar-safe ISO helpers | `todayISO`, `addMonthsISO`, `nextDueDateISO`, `previousDueDateISO`, `advanceByFrequency` |
| `money.ts` | Parsing, formatting, rounding | `parseMoneyToCents`, `centsToEditable`, `formatMoney`, `percentOf`, `floorToDollarCents` |
| `adjustments.ts` | Adjustment reasons, their ledger memo and category | `ADJUSTMENT_PRESETS`, `adjustmentPresetsFor`, `adjustmentFor` |
| `emergency.ts` | Emergency target and coverage | `averageMonthlyVariableCents`, `emergencyMonthlyEssentialsCents`, `recommendedEmergencyTargetCents`, `emergencyCoverageMonths` |
| `accounts.ts` | Spendable pool and wealth rules | `countsInSafeToSpend`, `safeToSpendPoolCents`, `poolEarmarkedGoalsCents`, `unsettledRoutingCents`, `totalWealthCents`, `wealthBuckets` |
| `importRepair.ts` | Import problem detection and repair rules | `findImportProblems`, `applyImportAnswers`, `validateFieldValue`, `findUnmappedAccounts`, `buildAccountMap` |
| `projections.ts` | 90-day bill/goal forecast | `projectUpcoming` |
| `billPrompts.ts` | Past-due bill detection | `dueBillPrompts` |
| `transfers.ts` | Paired legs and round-up remainder | `transferLegs`, `roundUpRemainderCents` |
| `settings.ts` | Settings defaults, parsing, serialization | `DEFAULT_SETTINGS`, `parseSettings`, `settingsToRecord` |
| `csv.ts` | CSV export, RFC 4180 parsing, entries import grammar | `toCsv`, `parseCsv`, `parseEntriesCsv`, `transactionsToCsv` |
| `categories.ts` | Category seeds, normalisation key and month spending | `DEFAULT_CATEGORIES`, `CATEGORY_NAME_MAX`, `normalizeCategoryName`, `categoryKey`, `spendingByCategory` |
| `credit.ts` | A card's statement close and payment due dates | `creditCycle`, `creditAmountDue`, `previousCloseDate` |
| `payoff.ts` | Debt amortisation at an APR | `debtPayoff`, `requiredPaymentCents` |
| `history.ts` | Net-worth series from daily snapshots | `netWorthSeries`, `NetWorthPoint` |
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

## Pocket (browser app)

`src/pocket` is a second Vite root that builds to `dist-pocket/`. It has no Electron, no main process, no IPC and no server. It is not another write path to the desktop database; it holds a peer copy of the same tables, merges a backup into it, and exports it back, so the two devices meet through a file and the shared merge rule.

```text
backup JSON ── parseBackup ──► ImportTables ── buildSnapshot ──► Snapshot
                                                   │
                                                   ├─ pocketView (shared finance functions)
                                                   └─ screens: Home, Bills, Goals, Accounts,
                                                              Ledger, Data, Welcome
indexedDB ◄── writeLedger ◄── store (zustand) ◄────┘
                                   │
                    importFile ────┼──► mergeTables (shared last-write-wins)
             add / edit / delete ──┴──► lib/write.ts ──► shared/writeRules.ts
                       exportJson ────► every table as the phone holds it
```

| Module | Responsibility |
| --- | --- |
| `lib/backup.ts` | Validates the file and every row (known enums for known versions, whole-number money), fills missing tables, keeps the schema version and serializes the export |
| `lib/enums.ts` | The one set of allowed values for account kinds, transaction kinds, frequencies, funding strategies, allocation buckets, category kinds, plan health, reserve states and goal paces, shared by validation and the snapshot |
| `lib/snapshot.ts` | The parity layer: derives balances, transaction caps, goal funding, bill payments, reserves, paychecks and settings from the same table rows the desktop exports. It reimplements reads, not arithmetic, and sorts rows by code unit so the order matches SQLite's binary collation |
| `lib/compute.ts` | Calls `safeToSpendPoolCents`, `unpaidMonthlyWallCents`, `poolEarmarkedGoalsCents`, `unsettledRoutingCents`, `monthlyWall` and `goalsSummary`; derives bill states from `nextBillOccurrence` and the due-soon horizon |
| `lib/write.ts` | Every write the phone can make — bills, categories, goals, accounts and entries — as pure functions over the same `ImportTables` it displays. Each mirrors one desktop repository: the same columns, the same linked rows (a transfer's second leg, a purchase's round-up, a goal's dedicated accounts, a bill's payments), the same cascades on pause and delete, and the same refusal sentence, which it gets from `src/shared/writeRules.ts` rather than from its own copy. Stamps go through `stampAfter`, so a written row is always newer than it was and the merge can see the edit |
| `lib/entry.ts` | Builds one expense/income transaction row with a new UUID, the right sign, a real date and an allowed account; returns a plain reason when it cannot |
| `lib/store.ts` | Loads IndexedDB, merges an opened backup into the local copy, runs a writer and commits its tables, tombstones a delete, exports, forgets, and surfaces storage failures |
| `lib/idb.ts` | One IndexedDB database, one `ledger` store, one `current` key; a failed open is not cached and a version change closes the connection |
| `lib/install.ts` | Captures `beforeinstallprompt` at module load, reports standalone mode and exposes the deferred prompt |
| `public/sw.js` | Versioned shell cache, network-first navigation and cache-first hashed assets; the build injects the release stamp and the precache list |

The boundary is deliberate: the phone edits a copy of the same tables the desktop writes, and the two copies meet through the shared merge rule in `src/shared/tableMerge.ts`. An opened file adds rows the phone lacks, replaces a row whose `updated_at` (then `revision`) is newer, and applies a newer tombstone; an older file copy never overwrites a local edit. A delete on the phone writes a tombstone and bumps `revision` instead of dropping the row, so the removal survives into the next export. Transfer twins and round-up sweeps are tombstoned with the row that was selected, matching the desktop's delete. A bill marked paid on the phone arrives as an ordinary `bill_payment` row, and the desktop's merge re-derives that bill's claims from the payments the ledger now holds (`reconcileAllBillReserves`, inside the same transaction), so the wall reads paid without a second step. The rules and their trade-offs are recorded in [ADR 0024](decisions/0024-two-copies-merge-by-time.md) and [ADR 0025](decisions/0025-the-phone-writes-through-the-desktops-own-rules.md).

The offline shell is generated, not hand-listed: a Vite `closeBundle` plugin fills `SHELL_VERSION` and `__PRECACHE__` in `public/sw.js` with the package version, a build hash and the sorted hashed assets, so a cold offline open does not request a bundle the cache never held. A row that does not match the schema it claims — an unknown enum for a version the build knows, or money that is not a whole number — is refused at parse time rather than coerced into a value the user never wrote.

`src/pocket/lib/snapshot.test.ts` builds a migrated demo database, exports it through the desktop backup builder, opens it on the phone and asserts every displayed total against the desktop's own selectors. `backup.test.ts` proves the export merges into a desktop database exactly once. `src/shared/tableMerge.test.ts` pins the merge rule itself (add, newer-wins, revision tiebreak, tombstone, no-stamp and future-stamp cases, settings by key and category-name collisions), and `backup-merge.test.ts` proves the desktop applies the same decisions with SQL, including an update and a deletion arriving from the phone. `src/main/db/device-round-trip.test.ts` closes the loop the other tests leave open: it hands a real desktop export to the phone's writers, wraps the phone's tables back into a backup and imports it with `mergeBackup`, then reads the desktop database and asserts the bill, the payment, the transfer pair, the goal link and the deletion all landed as the desktop would have written them. The pocket TypeScript project includes `src/shared` and `src/renderer/src/lib/finance.ts`, so a change to either must still satisfy all three type checks.

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

`src/main/db/repositories.ts` is a façade re-exporting the modules in `src/main/db/repo/`, which are the only code that executes SQL for CRUD and snapshots:

| Module | Holds |
| --- | --- |
| `common.ts` | validation helpers (`assertText`, `assertCents`, `assertOneOf`, `assertDate`, `requireId`), soft delete and update helpers that bump `revision` and `updated_at` |
| `accounts.ts`, `bills.ts`, `goals.ts`, `transactions.ts`, `paychecks.ts`, `settings.ts`, `users.ts` | one aggregate root each, including transfers, round-up, reserves, ledger query/paging and paycheck commit |
| `categories.ts` | the category list, case-insensitive find/create/rename/delete, `ensureCategory` for free text, and the v8 backfill |
| `posting.ts` | `postDueAutopay`, the boot-time writer for bills marked `autopay`; it shares `dueBillPrompts` with the prompt card |
| `balances.ts` | `recordDailySnapshots` (one row per live account per day) and `listBalanceSnapshots` (the newest 400 days) |
| `read-models.ts` | `getSnapshot` and `readSnapshotParts` (a `SnapshotPatch` for the tables one write touched) |

There is no ORM. SQL is explicit and parameterised; column names come from internal allowlists, never from user input.

### Read model

`getSnapshot` returns:

```ts
{
  user,
  settings,               // raw key/value record
  accounts,               // includes archived, each with balanceCents and card terms
  bills,                  // non-deleted, active first
  goals,                  // non-deleted, with fundedCents/remainingCents
  categories,             // non-deleted, sort_order then name
  transactions,            // non-deleted, newest first, LIMIT 500 (+ transactionTotal)
  paychecks,              // non-deleted, newest first, LIMIT 24 + allocations (+ paycheckTotal)
  billReserves,           // the wall's claims
  balanceSnapshots         // one row per account per day, newest 400 days
}
```

Limits are deliberate: the UI is a working ledger, not an archive browser. The ledger screen does not use the capped `transactions` list — it calls `transaction:query` and pages the whole table in SQL — and JSON backup and CSV export read every row.

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
  ├─ open dialog (JSON, CSV, OFX/QFX, QIF) → null when cancelled
  ├─ read file asynchronously, reject > 64 MiB
  ├─ .ofx/.qfx ──► parseOfxStatement ─┐
  ├─ .qif ──────► parseQif ───────────┴─► one statement question ──► problems
  ├─ .csv  ──► parseEntriesCsv
  │             ├─ with Account column ──► findUnmappedAccounts ──► problems
  │             └─ without one ─────────► describeCsvStatement ──► one statement question
  ├─ .json ──► parseBackupJson ──► findImportProblems ──────────► problems
  └─ hold the file under a token, return ImportPreview { token, fileRows, problems, choices, statement? }

ImportWizard (renderer)
  ├─ step 2: one question per problem, answered or left out
  └─ step 3: review, then confirmImport(token, answers)

data:confirm
  ├─ takeImport(token)          ← single use; a newer preview replaces the older one
  ├─ entries ──► buildAccountMap ──► mergeEntries ──► result
  └─ .json ──► findImportProblems (same pure rules, re-derived)
             ──► applyImportAnswers ──► mergeBackup ──► result
```

Problem detection is shared, pure code in `src/shared/importRepair.ts`, so the main process re-derives exactly the questions the wizard showed and can trust `table:index` answer keys. Anything still unusable is dropped with a reason rather than thrown, and `mergeBackup` / `mergeEntries` isolate the remaining database errors per row.

JSON import preserves IDs for cross-table links. CSV import creates new UUIDs and resolves accounts by name — or by your mapping in the wizard — because a CSV has no IDs to preserve.

A statement (OFX/QFX, QIF, or a CSV with no Account column) is an entries file in which every row's account name is blank. The main process builds one synthetic mapping keyed on `accountName: ''` with no pre-selected answer; `buildAccountMap` turns the wizard's choice into `{ '': accountId }`, and `mergeEntries` resolves every line through `Object.hasOwn`. An unanswered statement therefore writes nothing and is reported once, not once per line.

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
- navigation: child windows denied, one allowlisted external link opened by the OS, all other navigation blocked by an exact URL/origin check;
- permissions: every request and check denied except a sanitised clipboard write for the copy buttons;
- CSP: self-only scripts, inline styles allowed, self/data images and fonts, localhost connect-src for development;
- data: unencrypted SQLite on disk, protected only by the OS account and full-disk encryption.

The renderer is trusted to call its own API methods. A compromised renderer can invoke any mutation, so XSS prevention is part of the security model rather than an optional hardening step.

## Error handling

| Layer | Behaviour |
| --- | --- |
| Main / repositories | Throws `Error` with a user-readable message; no partial writes because of transaction boundaries |
| Preload | Rejections propagate unchanged |
| Store | Strips Electron's `Error invoking remote method '...':` prefix and shows a notice: successes fade after 4.2 s, errors stay until dismissed or replaced |
| Boot | A failed `getSnapshot` or `db:path` sets `status = 'error'` and renders a full-screen message |
| React | Error boundary renders the message and a reload button |

Uncaught exceptions, unhandled rejections, renderer and child-process crashes, boot failures and database errors are appended to `logs/main.log` under the user-data directory by [`src/main/log.ts`](../src/main/log.ts). One previous generation is kept (512 KiB cap), and Settings → About shows the path and the last lines so a bug report can include them. There is no crash reporter backend, no telemetry and no other error persistence: a handled error the user dismisses from the notice is gone.

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
| `src/shared/adjustments.ts` | Adjustment reasons, memo and category mapping |
| `src/shared/emergency.ts` | Emergency-fund variables, essentials and coverage |
| `src/shared/settings.ts` | Settings defaults, corrupt-input recovery, serialization |
| `src/shared/importRepair.ts` | Import problem detection, repair questions and field validation |
| `src/shared/tableMerge.ts` | The last-write-wins decision (`incomingWins`) and the phone's `mergeTables`, used by both copies of the ledger |
| `src/shared/writeRules.ts` | The sentences and ranges every write is checked against — enums, text, cents, APR, dates, due days, signs, flags — shared by the desktop repositories and the phone's writers. `validateAccountForm` reads a whole account dialog (both devices) into cents, basis points and day numbers, and returns one message per field so a sheet can put each refusal under the box it belongs to |
| `src/shared/csv.ts` | CSV encoding/parsing and entry-row validation |
| `src/shared/categories.ts`, `credit.ts`, `payoff.ts`, `history.ts` | Category seeds and spending, card cycles, debt payoff, net-worth series |
| `src/shared/api.ts` | The `FinanceApi` contract the preload implements, plus `WriteResult` |
| `src/shared/channels.ts` | The typed IPC contract and the exhaustive channel list |
| `src/main/index.ts` | App lifecycle, window, navigation policy, permissions |
| `src/main/ipc.ts` | Typed channel registration, dialogs, file reads/writes |
| `src/main/db/connection.ts` | Database singleton, pragmas, path |
| `src/main/db/migrations.ts` | Schema versions 1–8 |
| `src/main/db/repositories.ts` | Façade re-exporting `repo/` |
| `src/main/db/repo/*` | CRUD per entity, derived reads, transfers, round-up, paycheck commit, read models |
| `src/main/db/backup.ts` | Backup build/parse/merge |
| `src/main/db/entries.ts` | CSV entry merge and account resolution |
| `src/main/db/legacy.ts` | Pre-rename database adoption |
| `src/main/db/seed.ts` | First-run seed: blank user in packaged builds, demo profile in development |
| `src/preload/index.ts` | Electron-only bridge wiring |
| `src/preload/api.ts` | `FinanceApi` built from one `IpcCaller` |
| `src/renderer/src/store/useFinanceStore.ts` | Joins the session and data slices; re-exports selectors |
| `src/renderer/src/store/session.ts`, `data.ts`, `selectors.ts` | Session state, snapshot mutations, pure totals |
| `src/renderer/src/lib/finance.ts` | UI-facing derived totals and labels |
| `src/renderer/src/screens/*` | Screen-level behaviour |
| `src/renderer/src/components/*` | Reusable UI, grids, prompts, data table, the net-worth sparkline |
| `src/renderer/src/components/dialogs/*` | The nine screen dialogs |
| `src/renderer/src/styles/tokens.css` | Dark/light design tokens |
| `src/renderer/src/styles/app.css` | Import list for the layered sheets |
| `src/renderer/src/styles/{base,components,screens,utilities}.css` | The app's cascade layers |
| `src/renderer/src/styles/grid.css` | react-data-grid theme, imported by the grid module |

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

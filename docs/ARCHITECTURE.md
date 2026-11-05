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
│                                                                    │
│Electron main process                                               │
│                                                                    │
│ app lifecycle ──► unlock.ts ──► connection.ts ──► migrations.ts    │
│      │              (the key)       │                              │
│      │                             ├──► seed.ts (first run only)   │
│      │                             └──► repo/ modules (all SQL)    │
│                                                                    │
│      ├──► custody.ts · encryption.ts (the transition, the wraps)   │
│      ├──► storage.ts (folder choice, lock, safety copies)          │
│      ├──► envelope.ts (a sealed export)                            │
│      ├──► ipc.ts (handlers, dialogs, file I/O)                     │
│      └──► BrowserWindow (sandboxed), or only the unlock prompt     │
│                                                                    │
│ shared/ domain functions imported directly (no IPC)                │
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
3. After `whenReady()`, `boot()` runs in this order:
   - every permission request and permission check is denied except a sanitised clipboard write, which the copy buttons need (`setPermissionRequestHandler` plus `setPermissionCheckHandler`);
   - on macOS in development only, the dock icon is set from `build/icon.png`;
   - `adoptLegacyDatabase()` copies a pre-rename database if the new one is absent — but only while the app still uses its own data folder, because a person who pointed WageRoute at an external ledger has already made that choice;
   - **the gate**: `openLedgerKey()` reads `ledger.key.json` and the ledger's own first 16 bytes and decides, before SQLite is involved, whether this launch has a key at all. It reconciles a change that never reported back (`reconcilePending`), unwraps the data key through the device wrap, through a passphrase, or by trying both, and returns `plaintext`, `keyed`, `locked` or `unrecoverable`. A passphrase is asked for in a window that owns no channels (`src/main/unlock-prompt.ts`); every refusal in this step ends in a dialog and `app.quit()`;
   - `getDatabase(dataKey)` then opens `wageroute.db` — cipher first, pragmas second — chmods the file `0600`, sets journal/synchronous/cache/mmap for the folder it is in, enables `secure_delete`, runs `PRAGMA quick_check`, writes a pre-upgrade copy when the file is older than the build, runs migrations, and then takes the day's `daily-YYYY-MM-DD.db` copy (skipped when today already has one; a failure goes to the crash log instead of blocking the open);
   - packaged builds run `seedIfEmpty()` (a blank local user plus default settings, only when no user row exists); development runs `seedDemoIfEmpty()` (the Alex demo profile);
   - `runBootTasks(db)` posts autopay bills that fell due (`postDueAutopay`) and records one balance snapshot per live account per day (`recordDailySnapshots`), each in its own `try/catch` that reports to the crash log, so neither can prevent the window;
   - `registerIpcHandlers(db)` binds every channel — **after** the ledger opened, which is what makes a locked ledger have no API to call;
   - `installMenu()` and then `createWindow()`, which builds the BrowserWindow.
4. `before-quit` closes the SQLite handle and releases `wageroute.lock`.

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

A launch whose ledger will not open builds a **different window**. `openPassphrasePrompt()` (`src/main/unlock-prompt.ts`) loads the same bundle with `?mode=unlock`, removes the menu, keeps devtools off and applies the same navigation posture; the renderer reads that query — never a channel — and renders `<Unlock />` instead of `<App />`. Two messages cross it: `wageroute:unlock-submit` in, `wageroute:unlock-retry` out. They live in `src/shared/channels.ts` **outside** `IpcContract`, because the contract is the ledger API and while the ledger is locked none of its channels are registered. A typed passphrase is checked against the wrap, and is never echoed back, stored, or written to the log; a wrong one re-asks, and closing the window is answered as a refusal with a dialog and a quit. That is what makes "locked" distinguishable from "broken" from outside: a locked ledger has no window that can be asked for rows.

Both windows are then watched by [`src/main/window-load.ts`](../src/main/window-load.ts), because a window that opens and never fills is a blank frame in front of a ledger that may be perfectly healthy — and nothing else in the main process could see it. `watchDocumentLoad()` is given the window's `did-finish-load` and `did-fail-load` events and three actions (reload, note, report), and counts **12 seconds of neither** as the same kind of failure, since silence is the only signal an initial empty document gives. Two retries are allowed, and the retry is a reload because reloading the page is the one remedy that has actually been seen to fix the stuck window; the next event writes a `window-load` (or `unlock-prompt-load`) crash line and ends the launch rather than holding a blank frame forever — the main window with a dialog and a quit, the prompt by closing itself, which the open that is waiting on it already reads as "no answer" and says out loud. A sub-resource failure is ignored — a missing icon is not a blank screen, and reloading would throw the page away — and so is `ERR_ABORTED`, which is what this module's own retry does to a load still in flight, so a slow-but-live page cannot abort itself into a report. The module imports nothing from Electron and takes its clock as a parameter, which is why the retry limit is a tested constant rather than a guess.

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

`src/renderer/src/main.tsx` also decides which *app* to mount, from the URL alone: `?mode=unlock` renders `<Unlock />`, the passphrase prompt, because a locked ledger has no channel to ask with. Everything else renders `<App />`.

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

`src/shared/channels.ts` is the single declaration of the wire contract: every channel name, its argument tuple and its result. `Channel`, `ChannelArgs<C>`, `ChannelResult<C>` and `IpcCaller` derive from `IpcContract`, and the `CHANNELS` array is checked at compile time to name every member. `src/main/ipc.ts` registers typed handlers against it and throws at boot if a declared channel was never registered; `src/preload/api.ts` builds `FinanceApi` from one `IpcCaller`, and `src/preload/index.ts` is the only Electron code in the bridge. `src/preload/api.test.ts` proves every method maps to a declared channel and that the bridge exposes exactly one method per channel. A confirmation that has to promise more than the rows on screen goes through the wire too: `transaction:count-deletion` is a read-only channel that returns `doomedDeletionIds`, because the renderer only ever holds one page of the ledger, and `Transaction` carries `transferGroupId` but no `roundUpSourceId` — so a sweep leg can be invisible to the screen that is asking about it. `account:count-deletion` and `bill:count-deletion` follow the same shape for the other destructive questions: the account one returns the size of `doomedAccountDeletionIds` (the rows recorded in the account plus the twins and sweeps they drag out of the others), and the bill one returns `billDeletionSummary` — the set-asides that go with the bill and the entries that stay without it. Every one of these is a read, never a write. A failed read tells the question nothing: `countAccountDeletion` and `countBillDeletion` come back as `null`, and the shared wording then says what it does not know instead of guessing a number — the entry question is the one case where the screen's own selection is an honest floor, so it keeps that fallback.

Two groups of channels exist because the ledger is not always reachable from the renderer. The four `storage:*` channels ask where the data lives, describe a candidate folder, and move the ledger in or out — the main process owns `storage.json` and `wageroute.lock`, so a window cannot choose a path for itself. The four `encryption:*` channels report the folder's custody state (`encryption:status`), rewrite every page (`encryption:enable`, `encryption:disable` — neither resolves into a usable session, because the transition needs the app's own handle closed and WageRoute restarts either way), or re-wrap the same 32-byte key without moving a page (`encryption:custody`, which returns the new status and keeps the session). A sealed file adds one step to the import path rather than a new verb: `data:preview` may answer `ImportNeedsPassphrase` instead of a preview, and `data:passphrase` takes the token plus the phrase and answers the same `ImportPreview` — so the wizard never sees a row of a file nobody has opened yet. `backup:export` takes the passphrase, or `null` for plain JSON.

Every write resolves with `WriteResult<T>` — `{ value, patch, refreshError? }` — where `patch` is a `SnapshotPatch` holding only the snapshot tables that write touched.

| Channel | Arguments | Result |
| --- | --- | --- |
| `snapshot:get` | — | Full `Snapshot` |
| `db:path` | — | Absolute path |
| `app:info` | — | `AppInfo`: version, schema version, Electron version |
| `app:diagnostics` | — | `AppDiagnostics`: runtime versions, paths, log tail, row counts and the `EncryptionStatus` the report prints as `Ledger:` |
| `app:legal` | — | `LegalTexts`: the bundled licence and third-party notices |
| `storage:location` | — | `StorageLocationInfo`: current folder, default folder, backups folder |
| `storage:choose` | — | `StorageCandidate` or `null` (cancelled) |
| `storage:apply` | `directory`, `StorageMoveMode` (`adopt` a ledger already there, `move` this one in, `fresh` start empty) | `StorageMoveResult` (always `restartRequired`) |
| `storage:default` | — | `StorageMoveResult` (back to the app's own folder) |
| `encryption:status` | — | `EncryptionStatus`: encrypted, cipher, device, passphrase, pending, staleKeyFile, deviceAvailable |
| `encryption:enable` | `EnableEncryptionRequest` (custody + passphrase) | `EncryptionChange`; the app restarts either way |
| `encryption:disable` | — | `EncryptionChange`; the app restarts either way |
| `encryption:custody` | `KeyCustodyChange` (one of five) | `EncryptionStatus` (page untouched, session kept) |
| `user:set-name` | `string` | `WriteResult<void>` |
| `account:create` | `AccountInput` | `WriteResult<string>` (new id) |
| `account:update` | `id`, `Partial<AccountInput>` | `WriteResult<void>` |
| `account:delete` | `id`, `{ withEntries?: boolean }?` | `WriteResult<void>` |
| `account:archive` | `id`, `archived: boolean` | `WriteResult<void>` |
| `account:count-deletion` | `id` | `number` (rows a delete retires, including twins and sweeps in other accounts) |
| `bill:create` | `BillInput` | `WriteResult<string>` |
| `bill:update` | `id`, `Partial<BillInput>` | `WriteResult<void>` |
| `bill:delete` | `id` | `WriteResult<void>` |
| `bill:count-deletion` | `id` | `BillDeletionSummary` (`{ reserves, linkedEntries }`) |
| `bill:payments` | `YYYY-MM` month | `BillPaymentTotal[]` (per-bill payments in that month) |
| `goal:create` | `GoalInput` | `WriteResult<string>` |
| `goal:update` | `id`, `Partial<GoalInput>` | `WriteResult<void>` |
| `goal:delete` | `id` | `WriteResult<void>` |
| `goal:archive` | `id`, `archived: boolean` | `WriteResult<void>` |
| `transaction:create` | `TransactionInput` | `WriteResult<string>` |
| `transaction:update` | `id`, `TransactionPatch` | `WriteResult<void>` |
| `transaction:delete` | `id` | `WriteResult<void>` |
| `transaction:delete-many` | `ids: string[]` | `WriteResult<number>` (rows removed) |
| `transaction:count-deletion` | `ids: string[]` | `number` (rows the delete retires, twins and sweeps included) |
| `transaction:query` | `LedgerQuery` | `TransactionPage` (`{ rows, total }`) |
| `category:create` | `CategoryInput` | `WriteResult<string>` |
| `category:update` | `id`, `Partial<CategoryInput>` | `WriteResult<void>` |
| `category:delete` | `id` | `WriteResult<void>` |
| `paycheck:commit` | `PaycheckDraftInput` | `WriteResult<CommittedPaycheck>` |
| `paycheck:apply` | `id`, `PlanMoveTarget[]` | `WriteResult<AppliedPlan>` |
| `settings:save` | `AppSettings` | `WriteResult<void>` |
| `backup:export` | passphrase to seal under, or `null` for plain JSON | saved path or `null` (cancelled) |
| `csv:export` | — | saved path or `null` |
| `statement:reconcile` | `accountId`, `statementCents`, `balanceOn` | `WriteResult<number>` (adjustment posted; `0` when the ledger already agreed) |
| `data:preview` | — | `ImportPreview`, or `ImportNeedsPassphrase` when the file is sealed, or `null` (cancelled) |
| `data:passphrase` | `token`, `passphrase` | `ImportPreview` (the same review step a plain file gets) |
| `data:confirm` | `token`, `ImportAnswer[]` | `ImportResult` |
| `data:reset` | — | `WriteResult<void>` (wipes every table, re-seeds a blank profile) |

Notes:

- The types describe the wire; the main process still validates every id and option at runtime, because a type is not a guarantee. `requireId` rejects empty or non-string IDs at the boundary, `requireMonth` refuses anything but a real `YYYY-MM` month, `requireDate` and `requireCents` guard the reconciliation call, and full payload validation happens in the repository helpers.
- `data:confirm` returns a `reconciliation` when a statement carried a closing balance and its account was mapped. The comparison is made after the merge against `accountBalanceOn`, so the dialog describes the ledger as it stands; `statement:reconcile` then posts one `adjustment` dated on the closing day. `reconcileAccountOn` in the repository owns the credit-card sign conversion and the "already agrees" case.
- File dialogs are owned by the invoking window, so they are modal to WageRoute.
- Export and import use native save/open dialogs. The main process reads and writes the chosen file.
- The import reader rejects files larger than **64 MiB** before parsing, and both the `stat` and the read are asynchronous so a large file does not block the main process.
- `data:preview` keeps the chosen file in a main-process map and hands back a single-use token; `data:confirm` accepts only that token. The renderer can never ask the main process to read a path it chose itself.
- A sealed file stops the wizard before any row exists. `data:preview` holds the text under a token and answers only `ImportNeedsPassphrase` — the token, the path, and `exportedAt` read off the header, which is the one part in the clear. `data:passphrase` *peeks* rather than spends, so a wrong phrase is typed again into the same box and a confirm that throws leaves the retry possible; the token is retired when the import lands.

## The shared domain layer

`src/shared` is pure TypeScript with no Electron, Node or DOM dependencies (except types). It is the specification of the product.

| Module | Responsibility | Key exports |
| --- | --- | --- |
| `allocator.ts` | Deterministic paycheck routing | `buildAllocationPlan`, `AllocationPlan`, `PlanWarning` |
| `cadence.ts` | Frequency smoothing and which paycheck funds a bill | `monthlyEquivalentCents`, `reservePerPaycheckCents`, `billFundingReserveCents`, `fundingCheckIndex`, `paycheckIndexInMonth`, `reachableCheckIndexes`, labels |
| `dates.ts` | Calendar-safe ISO helpers | `todayISO`, `addMonthsISO`, `nextDueDateISO`, `previousDueDateISO`, `advanceByFrequency` |
| `money.ts` | Parsing, formatting, rounding | `parseMoneyToCents`, `centsToEditable`, `formatMoney`, `percentOf`, `floorToDollarCents` |
| `adjustments.ts` | Adjustment reasons, their ledger memo and category, and the whole adjust-balance form | `ADJUSTMENT_PRESETS`, `adjustmentPresetsFor`, `adjustmentFor`, `ADJUST_MODES`, `resolveAdjustBalance` |
| `emergency.ts` | Emergency target and coverage | `averageMonthlyVariableCents`, `emergencyMonthlyEssentialsCents`, `recommendedEmergencyTargetCents`, `emergencyCoverageMonths` |
| `accounts.ts` | Spendable pool and wealth rules | `countsInSafeToSpend`, `safeToSpendPoolCents`, `poolEarmarkedGoalsCents`, `unsettledRoutingCents`, `totalWealthCents`, `wealthBuckets`, `cardPaymentSources` |
| `importRepair.ts` | Import problem detection and repair rules | `findImportProblems`, `applyImportAnswers`, `validateFieldValue`, `findUnmappedAccounts`, `buildAccountMap` |
| `projections.ts` | 90-day bill/goal forecast | `projectUpcoming` |
| `billPrompts.ts` | Past-due bill detection | `dueBillPrompts` |
| `transfers.ts` | Paired legs and round-up remainder | `transferLegs`, `roundUpRemainderCents` |
| `settings.ts` | Settings defaults, parsing, serialization | `DEFAULT_SETTINGS`, `parseSettings`, `settingsToRecord` |
| `csv.ts` | CSV export, RFC 4180 parsing, entries import grammar | `toCsv`, `parseCsv`, `parseEntriesCsv`, `transactionsToCsv` |
| `categories.ts` | Category seeds, normalisation key and month spending | `DEFAULT_CATEGORIES`, `CATEGORY_NAME_MAX`, `normalizeCategoryName`, `categoryKey`, `spendingByCategory` |
| `credit.ts` | A card's statement close and payment due dates | `creditCycle`, `creditAmountDue`, `previousCloseDate` |
| `encryption.ts` | The custody table the Settings card renders, and the one passphrase rule | `EncryptionStatus`, `CUSTODY_COPY`, `custodyCopy`, `custodyInUse`, `passphraseProblem`, `MIN_PASSPHRASE_CHARACTERS` |
| `envelope.ts` | The sealed-file format both devices read and write | `ENVELOPE_FORMAT`, `EncryptedEnvelope`, `parseEnvelope`, `looksLikeEnvelope`, `textIsEnvelope`, `envelopeToJson`, `envelopeFileName` |
| `diagnostics.ts` | The text behind *Copy diagnostics*, including the `Ledger:` line | `describeDiagnostics`, `describeEncryption` |
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
backup JSON ── plain, or sealed and opened first ── parseBackup ──► ImportTables
                                                                       │
                                              buildSnapshot ───────────┤
                                                                       ▼
                              pocketView (shared finance functions) · Snapshot
                              screens: Home, Bills, Goals, Accounts, Ledger, Data, Welcome
                                                                       │
 store (zustand) ◄─────────────────────────────────────────────────────┘
   ├─ importFile ────────────► mergeTables (shared last-write-wins)
   ├─ add / edit / delete ───► lib/write.ts ─► shared/writeRules.ts + shared/claims.ts
   ├─ exportJson ────────────► every table as the phone holds it, plain or sealed
   └─ seal / open the copy ──► lib/vault.ts ─► lib/webcrypto.ts ─► crypto.subtle
                                    │
                              lib/idb.ts: one record — a plain ledger, or a SealedCopy
                                     while the vault is shut
```

| Module | Responsibility |
| --- | --- |
| `lib/backup.ts` | Validates the file and every row (known enums for known versions, whole-number money), fills missing tables, keeps the schema version and serializes the export |
| `lib/enums.ts` | The one set of allowed values for account kinds, transaction kinds, frequencies, funding strategies, allocation buckets, category kinds, plan health, reserve states and goal paces, shared by validation and the snapshot |
| `lib/snapshot.ts` | The parity layer: derives balances, transaction caps, goal funding, bill payments, reserves, paychecks and settings from the same table rows the desktop exports. It reimplements reads, not arithmetic, and sorts rows by code unit so the order matches SQLite's binary collation |
| `lib/compute.ts` | Calls `safeToSpendPoolCents`, `unpaidMonthlyWallCents`, `poolEarmarkedGoalsCents`, `unsettledRoutingCents`, `monthlyWall` and `goalsSummary`; derives bill states from `nextBillOccurrence` and the due-soon horizon |
| `lib/write.ts` | Every write the phone can make — bills, categories, goals, accounts and entries — as pure functions over the same `ImportTables` it displays. Each mirrors one desktop repository: the same columns, the same linked rows (a transfer's second leg, a purchase's round-up, a goal's dedicated accounts, a bill's payments), the same cascades on pause and delete, and the same refusal sentence, which it gets from `src/shared/writeRules.ts` rather than from its own copy. Stamps go through `stampAfter`, so a written row is always newer than it was and the merge can see the edit. `insertedEntryIds` reads which ledger rows a write actually posted — both legs of a transfer, a purchase and its sweep — so the phone can claim every one of them as its own rather than only the id the writer returns. `expandDeletion` is the same map read backwards: it returns every row a delete retires, which is what the confirmation question counts. `doomedAccountEntryIds` applies that map to every row recorded in an account, and `billDeletionSummary` counts the set-asides a bill delete retires and the entries it releases — the two numbers the desktop reads over IPC, measured here from the copy already in IndexedDB. The sentence itself comes from `src/shared/deletion.ts`, so the phone asks it in the desktop's words. `reconcileBillClaims(tables, billId)` and `reconcileAllBillClaims(tables)` replay the desktop's claim derivation through the shared rule, so a payment typed here settles its bill here: the first runs after an entry write that pays a bill, an edit that moves a payment's amount, kind or date, an entry delete and an account delete, and the second is the backstop `store.ts` runs over a freshly opened or merged file |
| `lib/entry.ts` | Builds one expense/income transaction row with a new UUID, the right sign, a real date and an allowed account; returns a plain reason when it cannot |
| `lib/webcrypto.ts` | The phone's whole crypto surface: `randomBytes`, PBKDF2 key derivation, and one seal/open pair per part. It refuses before it touches a cipher — `hasCipher()` is false and `NO_CIPHER_HERE` says why wherever the page has no `crypto.subtle`, because WebCrypto is exposed only in a secure context and a page served over plain HTTP cannot seal, open, or forget anything |
| `lib/vault.ts` | This phone's own copy, sealed under a passphrase separate from the desktop's and from an export's: `wageroute-vault` v1, a marker kept in the clear beside one sealed record, a key held for the session only and never extractable. `createVault`, `unlockVault`/`verifyPassphrase`, `lockVault`, `sealRecord`/`openRecord`, `changeVaultPassphrase` |
| `lib/envelope.ts` | The same sealed-file contract the desktop writes, read and written through WebCrypto — so a file sealed on either device opens on the other. `sealEnvelope`, `openEnvelopeText`, `openEnvelopeFileText` |
| `lib/store.ts` | Loads IndexedDB, merges an opened backup into the local copy, runs a writer and commits its tables, tombstones a delete, exports (plain or sealed), forgets, and surfaces storage failures. It also holds the vault: `enableVault`/`disableVault`/`changeVaultPassphrase`/`unlockVaultWith`/`lockNow`, and a file that arrived sealed parked in `pendingSeal` until `unlockSeal` turns it into rows. `status` has a fifth value, `locked`: a copy on this phone that exists and cannot be read, which is why no screen shows a spinner there |
| `lib/idb.ts` | One IndexedDB database, one `ledger` store, one `current` key. The value is a union — a plain `StoredLedger`, or the `SealedCopy` the vault writes — so a reader that cannot open the key never sees rows it was not given |
| `lib/install.ts` | Captures `beforeinstallprompt` at module load, reports standalone mode and exposes the deferred prompt |
| `components/` | `VaultCard`, `UnlockVault` and `UnlockSeal` are the crypto surfaces a person meets — the vault itself, the gate over a copy that is shut, and the phrase asked for a file that arrived sealed. `ExportSheet` asks plain-or-sealed on the way out and `PickBackup` on the way in, `DeleteConfirm` asks the shared destructive question, and every sheet button is disabled while a write is in flight |
| `public/sw.js` | Versioned shell cache, network-first navigation and cache-first hashed assets; the build injects the release stamp and the precache list. `src/pocket/main.tsx` registers it only when `window.isSecureContext` — the same condition that decides whether a cipher exists on this page at all |

The boundary is deliberate: the phone edits a copy of the same tables the desktop writes, and the two copies meet through the shared merge rule in `src/shared/tableMerge.ts`. An opened file adds rows the phone lacks, replaces a row whose `updated_at` (then `revision`) is newer, and applies a newer tombstone; an older file copy never overwrites a local edit. A delete on the phone writes a tombstone and bumps `revision` instead of dropping the row, so the removal survives into the next export. Transfer twins and round-up sweeps are tombstoned with the row that was selected, matching the desktop's delete. A bill marked paid on the phone arrives as an ordinary `bill_payment` row, and the wall reads paid without a second step on either device: both derive a claim's state from the payments in front of them through the one rule in `src/shared/claims.ts`, the desktop at its own call sites and the phone after its own writes and after a merge ([ADR 0028](decisions/0028-both-devices-derive-a-bills-set-aside-from-its-payments.md)). The desktop's import keeps its own backstop (`reconcileAllBillReserves`, inside the same transaction), which is what corrects a claim that arrives carrying another device's stale state. The rules and their trade-offs are recorded in [ADR 0024](decisions/0024-two-copies-merge-by-time.md) and [ADR 0025](decisions/0025-the-phone-writes-through-the-desktops-own-rules.md).

The offline shell is generated, not hand-listed: a Vite `closeBundle` plugin fills `SHELL_VERSION` and `__PRECACHE__` in `public/sw.js` with the package version, a build hash and the sorted hashed assets, so a cold offline open does not request a bundle the cache never held. A row that does not match the schema it claims — an unknown enum for a version the build knows, or money that is not a whole number — is refused at parse time rather than coerced into a value the user never wrote. A key that a released build simply never wrote is the other case, and it must be accepted: a file from v1.2.0 has no `due_day` on its claims. Nothing refuses those, so the readers that turn a row into a fact must not answer a missing key with `0` and let a rule run on it, which is why the claim walk is handed only rows the desktop's schema could have held (`src/pocket/lib/write.ts`).

`src/pocket/lib/snapshot.test.ts` builds a migrated demo database, exports it through the desktop backup builder, opens it on the phone and asserts every displayed total against the desktop's own selectors. `backup.test.ts` proves the export merges into a desktop database exactly once. `src/shared/tableMerge.test.ts` pins the merge rule itself (add, newer-wins, revision tiebreak, tombstone, no-stamp and future-stamp cases, settings by key and category-name collisions), and `backup-merge.test.ts` proves the desktop applies the same decisions with SQL, including an update and a deletion arriving from the phone. `src/main/db/device-round-trip.test.ts` closes the loop the other tests leave open: it hands a real desktop export to the phone's writers, wraps the phone's tables back into a backup and imports it with `mergeBackup`, then reads the desktop database and asserts the bill, the payment, the transfer pair, the goal link and the deletion all landed as the desktop would have written them. `src/pocket/lib/claims-parity.test.ts` does the same for a claim's state: one money fact is driven through the real desktop repository and the real phone writer over a ledger exported from the first, and both devices' `bill_reserves` rows are compared — state and revision agree, and each side names *its own* payment in `settled_by`, which is why parity is asserted about the state and not the id. The pocket TypeScript project includes `src/shared` and `src/renderer/src/lib/finance.ts`, so a change to either must still satisfy all three type checks.

## The main/database layer

### Connection

`src/main/db/connection.ts` holds one `better-sqlite3-multiple-ciphers` instance — the cipher fork, and the only SQLite module in `package.json`. `getDatabase(dataKey)` takes the key the launch decided on, or `null` for a plaintext ledger, and the order of what follows is the whole design:

- resolve the folder from `storage.json` (`resolveDataDirectory`) and take `wageroute.lock`; a folder another machine is heartbeat-locked in stops the app rather than racing it, and a lock lost mid-session closes the handle instead of overwriting the new owner;
- `openLedger(file, dataKey)` **before any other pragma**: `PRAGMA cipher('chacha20')` and the raw key through `db.key()`, on a fresh handle (`applyKey` in `src/main/db/encryption.ts`), because every pragma after the first read is answered from pages that are either ciphertext or not a database — and every *second* connection in the app (a health probe, a storage inspection, a temporary copy) has to do the same or it sees a corrupt database;
- `chmod 0600` on the ledger — best effort, and the reason it is still not a substitute for OS-level protection is stated in [SECURITY.md](SECURITY.md);
- pragmas per folder: `WAL`/`NORMAL` plus a 16 MiB cache, in-memory temp store and mmap for the app's own folder; `DELETE`/`FULL`, no mmap for a chosen external folder, because a network share or a synced drive does not give SQLite the shared-memory guarantees WAL needs;
- `foreign_keys = ON`, `busy_timeout = 5000`, `secure_delete = ON` (a deleted row should not survive in a free page — this is a whole financial history in one file, and *erase all data* has to mean it);
- `PRAGMA quick_check`, a pre-upgrade copy when the file is older than the build, `migrate()`, then the day's `daily-YYYY-MM-DD.db` copy (a failure goes to the crash log instead of blocking the open);
- `closeDatabase()` on quit closes the handle and releases the lock.

The key the session opened with is kept in `sessionKey` and exported as `ledgerDataKey()`, because the app opens other connections — a storage candidate is probed on a fresh handle, and an unkeyed handle cannot read an encrypted ledger.

### Encryption at rest

Four modules own this, and each owns exactly one question:

| Module | Question it answers |
| --- | --- |
| `src/main/db/ledger-key.ts` | How are 32 bytes wrapped and unwrapped? `KEY_FILE = 'ledger.key.json'` (`0600`) holds only wraps — a `safeStorage` device wrap, a scrypt (`N=32768, r=8, p=1`) + AES-256-GCM passphrase wrap, or both — never the key. `LEDGER_CIPHER = 'chacha20'` |
| `src/main/db/encryption.ts` | How does a whole ledger change state? `ledgerLooksEncrypted()` reads the first 16 bytes; `openLedger()` applies the key; `encryptLedger`/`decryptLedger` take a `VACUUM INTO` pre-copy, record a `pending` marker, rewrite pages, verify on a fresh connection including `integrity_check`, delete the copy once it checks, and `reconcilePending()` puts the ledger back the way it was when a crash landed in the middle |
| `src/main/db/custody.ts` | Who may hold the key right now? `readEncryptionStatus`, `enableEncryption`, `disableEncryption`, `changeKeyCustody` — the last re-wraps the same bytes and touches no page, which is why custody can change as often as the owner likes |
| `src/main/db/unlock.ts` | Does this launch have a key at all? `openLedgerKey()` — the gate described in the boot sequence. `deviceCustodyAvailable()` is why a container reports false and the *This computer* option is withheld with its reason instead of failing later (`src/main/db/device-custody.ts`) |

Nothing is encrypted unless it is asked for: a default install writes plaintext, and the Settings card says so. The decision, its reversibility and what it does not protect against are recorded in [ADR 0029](decisions/0029-encryption-is-a-choice-on-the-disk-and-on-the-way-out.md), which supersedes [ADR 0019](decisions/0019-the-ledger-is-plaintext-at-rest.md); [ADR 0020](decisions/0020-there-is-no-app-lock.md) says why this is encryption and not an app lock.

A file leaving the app is a separate choice with its own rules. `src/shared/envelope.ts` declares the format (`wageroute-envelope` v1, PBKDF2-HMAC-SHA256 at 600 000 rounds, accepted between 100 000 and 2 000 000, 16-byte salt, 12-byte IV, 16-byte tag); the only plain text in the file is the parameters a reader needs before it can try a phrase, plus `exportedAt`, which is in the clear so a folder of these files still sorts by date. `src/main/envelope.ts` seals and opens it with `node:crypto`, and `src/pocket/lib/envelope.ts` is the same contract over WebCrypto, so a sealed file crosses devices in both directions. The `backups/` copies follow the ledger because they are written from a keyed connection; a CSV is never sealed, because ADR 0017 keeps a report plaintext.

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

### Unlock a keyed ledger at launch

```text
launch ──► openLedgerKey(dataDirectory, ledgerFile, { device, askForPassphrase })
  ├─ no key file beside the ledger
  │     ├─ first 16 bytes are 'SQLite format 3\0' ──► plaintext, the normal open
  │     └─ anything else ──► MissingKeyFileError. The driver is never asked to read
  │                          the file, so the one message that cannot be mistaken
  │                          ('file is not a database') is never produced. A dialog
  │                          names both paths and quits.
  ├─ key file present ──► device wrap if this machine has a keychain for it
  │                    └─ passphrase wrap ──► the ?mode=unlock window, re-asked on a
  │                                           wrong phrase; closing it is a refusal
  ├─ reconcilePending(...) when the marker records a change that never reported back
  └─ header says plaintext while a key file exists ──► open as plaintext and report
                                   `staleKeyFile`: a crashed decrypt leaves exactly this
                                   pair, and the readable ledger wins.
──► getDatabase(dataKey | null)   … and only after this do the ledger channels exist
```

### Turn encryption on, or off

```text
Settings → Encryption at rest → Encrypt my ledger (custody, optional passphrase)
  ├─ passphraseProblem() — the same function the main process calls, so the field
  │    and the writer cannot disagree about what counts as a passphrase
  ├─ encryption:enable ──► closeDatabase()      ← the transition holds the file alone
  ├─ generateDataKey, then the wraps the owner chose (safeStorage / scrypt+AES-GCM / both)
  ├─ readLedgerState on a connection opened to match the state that exists *now*
  ├─ VACUUM INTO a safety copy
  ├─ write the `pending` marker into ledger.key.json
  │     └─ if the marker cannot be written, the copy is deleted and no page moves:
  │        the marker is what turns encryption on
  ├─ rekey every page (chacha20 in, plaintext out)
  ├─ verify on a fresh connection (`assertTransition`): `integrity_check`, the
  │    transaction row count and the schema version — `rekey`'s own return value
  │    has lied twice, so nothing here trusts it
  ├─ clear the marker, delete the safety copy, relaunch
  └─ failure: log the scope, say what failed, and still relaunch — the ledger is
     whatever the last verified state was, in both directions.
A launch that finds a marker answers through reconcilePending(): the ledger reads as a
database → keep it and drop the marker; only the copy reads → restore it and log
`ledger-restored`; neither → `unrecoverable`, and the dialog shows both paths and
touches neither.
```

`encryption:custody` is the same card's other verb and the cheaper one: it re-wraps the existing 32 bytes in the sidecar, closes no handle, moves no page, and returns the new status to the same session.

### Seal a backup, and open one

```text
Settings → Export full backup → which file?
  ├─ plain   ──► buildBackup ──► wageroute-backup-<day>.json
  └─ sealed  ──► passphraseProblem() ──► buildBackup
                └─► sealEnvelope(json, phrase) ──► wageroute-backup-<stamp>-encrypted.json
                (built before the folder is chosen, so the name and the header
                 carry the same moment; both writes go through writeFileAtomic)

data:preview on that file
  ├─ textIsEnvelope? yes ──► hold the text under a token
  │       └─► ImportNeedsPassphrase { token, path, exportedAt }   ← no rows exist yet
  │            data:passphrase(token, phrase) peeks, does not spend
  │              ├─ EnvelopeError 'passphrase' → say retype, same box, same file
  │              └─ EnvelopeError 'shape'      → say this file, not a phrase
  └─ opened text ──► the ordinary backup preview, problems and all
```

The phone runs the same contract through WebCrypto (`src/pocket/lib/envelope.ts`), so a file sealed on one device opens on the other. A transactions CSV is never sealed — it is a report, and ADR 0017 keeps reports plaintext.

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
- data: SQLite on disk, plaintext unless the owner turns encryption on from Settings. When it is on, every page is `chacha20` ciphertext under a key the owner holds — this computer, a passphrase, or both — and the file is `0600`. Neither case is a substitute for the OS account and full-disk encryption, and neither stops someone who can already read the process's memory.
- custody: no server holds a copy of the key, and there is no reset, escrow or support path. If every wrap is lost the ledger is gone, which is why the Settings card states the lockout risk in its own text rather than in a sentence written per screen.

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

The module has two writers and the difference is the whole point. `logCrash(scope, error)` prefixes `Error:` and indents a stack, which is what a bug report should be built from; `logNote(scope, message)` writes a plain line for something that **happened** rather than something that went wrong — the try count of a passphrase that worked, for instance. Both are tested in `src/main/log.test.ts`, including the promise that neither throws into a caller that is already failing on a full or read-only disk.

The scope is the first bracket on each line, and the ledger's own are the reason the file is worth reading: `ledger-locked`, `ledger-unlocked` (how many passphrases it took, never one of them — a **note**, because that boot succeeded), `ledger-key-file-missing`, `ledger-no-custody`, `ledger-restored`, `key-file`, `encryption-enable`, `encryption-disable`, plus `storage-unavailable`, `storage-locked`, `daily-backup`, `autopay`, `snapshots`, `database-corrupt` and `database-open`. The window contributes two more, and they use both writers the way the level rule intends: `window-load` and `unlock-prompt-load` write a **note** per retry and one **crash** when the retries are spent. Nothing that reaches either writer may carry a key, a wrap or a passphrase, and `src/shared/diagnostics.test.ts` refuses the report whenever a key-shaped base64 or hex run survives path-stripping.

## Build system

`electron.vite.config.ts` defines three builds:

- **main** — Node target, dependencies externalised, `@shared` alias;
- **preload** — Node target, dependencies externalised, `@shared` alias;
- **renderer** — browser target, React plugin, `@shared` and `@renderer` aliases, relative base for `file://` loading.

TypeScript runs in three projects, one per process that can type-check alone:

- `tsconfig.node.json` covers `src/main`, `src/preload`, `src/shared` and the Vite config;
- `tsconfig.json` covers the renderer, shared code and preload typings, and excludes tests;
- `src/pocket/tsconfig.json` covers the phone app plus the `src/shared` modules it imports — including `src/renderer/src/lib/finance.ts`, so a change to either must still satisfy all three checks.

`npm run typecheck` runs all three; `npm run build` runs it before bundling and refuses to continue if any fails. `npm run pocket:build` builds the phone through `src/pocket/vite.config.ts` into `dist-pocket/`, and `pocket:dev` / `pocket:preview` serve it locally. `npm test` lists its files explicitly and `pretest` (`scripts/check-test-list.mjs`) fails when a `*.test.ts` exists that the list does not name, so a new suite cannot quietly never run. `postinstall` runs `electron-builder install-app-deps`, which for this driver is a no-op rather than a compile: `better-sqlite3-multiple-ciphers` sets `gypfile: false` and ships `prebuilds/<platform>-<arch>.node` files registered through N-API, so the same binary serves Node and Electron and there is no node-gyp output for it to rebuild. It is still the right command to keep — it is the step that would build from source on a platform that has no prebuild.

`electron-builder.yml` packages `out/**/*` and `package.json`, unpacks native `.node` files from the asar (`**/*.node`) — the driver's `prebuilds/` directory among them, because a `.node` inside an asar cannot be `dlopen`ed and a keyed ledger cannot be opened without that codec — and leaves `npmRebuild: true` in place, which is now harmless and vacuous for the reasons above. `scripts/third-party-notices.mjs` regenerates the notices the About screen bundles, and it names the fork.

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
| `src/shared/adjustments.ts` | Adjustment reasons, memo and category mapping, adjust-balance target and refusals |
| `src/shared/emergency.ts` | Emergency-fund variables, essentials and coverage |
| `src/shared/settings.ts` | Settings defaults, corrupt-input recovery, serialization |
| `src/shared/importRepair.ts` | Import problem detection, repair questions and field validation |
| `src/shared/claims.ts` | Whether a bill's set-aside has been spent, derived from its payments: `deriveClaimStates(claims, payments)` returns each claim's state, the payment that closed it, and a `changed` flag so neither device bumps a revision it has nothing to contribute to. Rows in, rows out — no SQLite, no clock, no DOM — and the ordering lives inside the rule, by code unit, so which claim a payment settles first cannot depend on which caller wrote the `ORDER BY` |
| `src/shared/tableMerge.ts` | The last-write-wins decision (`incomingWins`) and the phone's `mergeTables`, used by both copies of the ledger |
| `src/shared/writeRules.ts` | The sentences and ranges every write is checked against — enums, text, cents, APR, dates, due days, signs, flags — shared by the desktop repositories and the phone's writers. `validateAccountForm` reads a whole account dialog (both devices) into cents, basis points and day numbers, and returns one message per field so a sheet can put each refusal under the box it belongs to |
| `src/shared/deletion.ts` | Every sentence a destructive confirmation shows, built from how many rows really leave the ledger: `entryDeletionWords` (with the transfer-leg case), `accountDeletionWords`, `billDeletionWords`, `goalDeletionWords`, `eraseAllWords` and `phoneCopyWords`, plus the `archiveVsDeleteHint` line the account question shows above them. Each takes the count the device measured, or `null` when the ledger could not be asked, and says so instead of guessing; a screen whose read has not landed yet waits with its own neutral line rather than borrowing the failed-read wording. One module owns the questions, so a phone and a computer cannot ask the same one in two different truths |
| `src/shared/encryption.ts` | The custody table the Settings card renders (`CUSTODY_COPY`: what each option protects against, what it does not stop, how it can lock you out), `EncryptionStatus`, and the one passphrase rule both halves call |
| `src/shared/envelope.ts` | The sealed-file format — names, sizes, iteration bounds, `parseEnvelope` — shared by the desktop writer and the phone reader |
| `src/shared/diagnostics.ts` | `describeDiagnostics` and `describeEncryption`: the text behind *Copy diagnostics*, including the `Ledger:` line that separates an encrypted file from a damaged one |
| `src/shared/csv.ts` | CSV encoding/parsing and entry-row validation |
| `src/shared/categories.ts`, `credit.ts`, `payoff.ts`, `history.ts` | Category seeds and spending, card cycles, debt payoff, net-worth series |
| `src/shared/api.ts` | The `FinanceApi` contract the preload implements, plus `WriteResult` |
| `src/shared/channels.ts` | The typed IPC contract and the exhaustive channel list |
| `src/main/index.ts` | App lifecycle, the boot gate and its refusal dialogs, window, navigation policy, permissions |
| `src/main/ipc.ts` | Typed channel registration, dialogs, file reads/writes |
| `src/main/storage.ts` | `storage.json`, the chosen data folder, `wageroute.lock` and its heartbeat, safety copies, and the key file that travels with a move |
| `src/main/unlock-prompt.ts` | The one window that can exist before the ledger opens: `?mode=unlock`, two messages, no channels |
| `src/main/window-load.ts` | The watch on a window's own document: retry twice, then say so instead of holding a blank frame |
| `src/main/envelope.ts` | Seals and opens a `wageroute-envelope` file with `node:crypto` |
| `src/main/files.ts`, `src/main/log.ts`, `src/main/window-security.ts` | Atomic writes, the crash log and its tail, the URL/permission predicates |
| `src/main/db/connection.ts` | Database singleton, the key applied before any pragma, pragmas per folder type, path, lock |
| `src/main/db/ledger-key.ts` | `ledger.key.json`: the device and passphrase wraps, scrypt+AES-GCM, the pending marker, `0600` |
| `src/main/db/encryption.ts` | `ledgerLooksEncrypted`, `applyKey`/`openLedger`, the page-by-page encrypt/decrypt transition, `reconcilePending` |
| `src/main/db/custody.ts` | `readEncryptionStatus`, `enableEncryption`, `disableEncryption`, `changeKeyCustody` |
| `src/main/db/device-custody.ts` | The `safeStorage` wrap, and `deviceCustodyAvailable()` for a machine with no keychain |
| `src/main/db/unlock.ts` | The launch decision: `openLedgerKey()` → plaintext / keyed / locked / unrecoverable, and the missing-key-file refusal |
| `src/main/db/maintenance.ts` | `assertHealthy`, the pre-upgrade copy, `backupDaily` |
| `src/main/db/migrations.ts` | Schema versions 1–10 |
| `src/main/db/repositories.ts` | Façade re-exporting `repo/` |
| `src/main/db/repo/*` | CRUD per entity, derived reads, transfers, round-up, paycheck commit, read models |
| `src/main/db/backup.ts` | Backup build/parse/merge |
| `src/main/db/entries.ts` | CSV entry merge and account resolution |
| `src/main/db/legacy.ts` | Pre-rename database adoption — a plaintext-only path: it moves a pre-rename `cash-flow-routing.db` and refuses a file whose header is not plain SQLite, so it never touches a keyed ledger |
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

- user accounts, authentication or multi-tenancy (the schema has `user_id`, but there is one local user, and one folder — the container images run that one user's instance, not several). The `edge` profile in `docker-compose.yml` is the shape for a second person: another container with another volume, fronted by a proxy. It is *someone else's* binary making that decision, and no code here reads an identity header, because [ADR 0030](decisions/0030-self-hosting-puts-identity-at-the-edge.md) says an app that cannot tell two humans apart is the safe answer;
- a server, API or sync engine **the app talks to**: there is no backend and no network request from either half. `docker/` runs the same code on a machine the owner controls, and the phone still meets the desktop only through a file. A proxy in front of a container terminates TLS and asks a provider who may come in; neither half of the app learns that it happened.
- bank aggregation or OFTP/CSV statement automation;
- auto-update;
- a lock inside the app: no PIN screen, no auto-lock, no session timeout — [ADR 0020](decisions/0020-there-is-no-app-lock.md) explains why an unlocked window is not a defence, and the encryption above is what protects the file instead. There is no key escrow, recovery code or support path either;
- multi-window support;
- routing, i18n, or a component library;
- a job queue or background workers.

Any of these can be added, but each one crosses a boundary described in this document and should arrive with its own decision record.

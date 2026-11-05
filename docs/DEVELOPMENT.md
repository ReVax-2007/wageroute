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
| Xcode Command Line Tools | Current | Needed to build macOS installers; only needed to *compile* a native module if a platform has no prebuild |
| Windows build tools | Current | Only needed to build Windows installers on Windows |
| SQLite CLI | Optional | Useful for inspecting a copy of a **plaintext** database — see [Working safely with data](#working-safely-with-data) |

WageRoute ships as a desktop Electron app, and there is a second front end in the same repository: **WageRoute Pocket**, a browser-installed phone app in `src/pocket/` that holds its own copy of the ledger in IndexedDB and talks to the desktop only through a backup file. It is built with `npm run pocket:build` and served as static files — see [POCKET.md](POCKET.md). There is still no server the desktop depends on and no account to create.

## Install

```bash
npm install
```

The `postinstall` script runs `electron-builder install-app-deps`. For this project's driver — `better-sqlite3-multiple-ciphers` — that is a no-op in practice: the package ships a prebuilt binary for every platform and architecture the build targets, and it registers through **N-API**, so the same `.node` file serves Node and Electron without an ABI rebuild. It is the step that *would* compile a native module from source on a platform with no prebuild, which is why it stays in the scripts and why a toolchain is still worth having.

If a module ever does get out of sync (a platform fallback, an unusual architecture), re-run it:

```bash
npm run postinstall
```

## Scripts

| Script | Command | Purpose |
| --- | --- | --- |
| `npm run dev` | `electron-vite dev` | Dev server, main/preload rebuild, hot renderer reload |
| `npm start` | `electron-vite preview` | Run the production bundles in `out/` |
| `npm run lint` | `node scripts/lint.mjs` | Repository-local checks: no `debugger`, no `console.log`/`console.debug`, no `@ts-ignore`/`@ts-expect-error`, no `any` cast and no `: any` annotation |
| `npm test` | `node --import tsx --test` (seventy-three files listed explicitly) | Domain, cadence, categories, credit, payoff, history, accounts, importer, statements, QIF, backup-example, export round-trip, merge, write rules, migration, maintenance, entries, files, the crash log's two writers, the window's document-load watch, seed, users, product model, reconciliation, paycheck plan, device round-trip, allocator property, dashboard selectors, finance maths, dialog focus and save guard, reconciliation dialog, wall chips and next-check, bill-prompt dates, entry-dialog links, preload bridge, window security, repository tests, the encryption layer (key wraps, the ledger transition, the launch decision, the sealed export in both directions, the diagnostics report), the phone's vault and its no-cipher guard, and the Pocket snapshot/backup/write parity cases |
| `npm run notices` | `node scripts/third-party-notices.mjs` | Regenerate `THIRD-PARTY-NOTICES.txt` from the production tree in `package-lock.json`; also runs as `prebuild` |
| `npm run typecheck` | node + web + pocket type checks | All three TypeScript projects |
| `npm run typecheck:node` | `tsc --noEmit -p tsconfig.node.json` | Main, preload, shared, config |
| `npm run typecheck:web` | `tsc --noEmit -p tsconfig.json` | Renderer and shared |
| `npm run typecheck:pocket` | `tsc --noEmit -p src/pocket/tsconfig.json` | Pocket and the shared modules it imports |
| `npm run build` | notices + typecheck + `electron-vite build` | `out/main`, `out/preload`, `out/renderer` |
| `npm run pocket:dev` | `vite --config src/pocket/vite.config.ts` | Pocket with hot reload, normally in a phone-sized browser window |
| `npm run pocket:build` | `vite build --config src/pocket/vite.config.ts` | Static shell in `dist-pocket/` (manifest, service worker, icons, hashed assets) |
| `npm run pocket:preview` | `vite preview --config src/pocket/vite.config.ts` | Serve the built Pocket shell locally; use `-- --port 4175` to pick a port |
| `npm run dist` | build + `electron-builder --publish never` | Current platform |
| `npm run dist:mac` | build + `electron-builder --mac --x64 --arm64 --publish never` | DMG, arm64 + x64 |
| `npm run dist:win` | build + `electron-builder --win --x64 --arm64 --publish never` | NSIS + MSI + portable + zip (MSI needs Windows: WiX) |
| `npm run dist:linux` | build + `electron-builder --linux --publish never` | AppImage + deb + rpm |

Architectures are passed as flags, not as `arch` lists in `electron-builder.yml`: electron-builder merges a target's declared arches into every build, so a declared list overrides `--x64`.

There is no formatter configuration and no ESLint/Prettier dependency. `npm run lint` is a small script that covers the mistakes the type checker cannot see; formatting is maintained by convention. CI runs `npm run lint` before the tests.

### Containers

Neither image is an npm script — the point is to build without a local toolchain at all:

```sh
docker build -f docker/pocket.Dockerfile -t wageroute-pocket .
docker build -f docker/desktop.Dockerfile -t wageroute-desktop .
docker compose up --build
```

Both are multi-stage and build from the source copied into the context, so `dist-pocket/`, `out/` and `release/` are inputs to neither — they are in `.dockerignore` along with the two documents that are deliberately never published. The Pocket stage installs with `npm ci --ignore-scripts`, which skips the Electron download and the native rebuild the desktop needs; the desktop stage runs the same `npm run build` you would, then `electron-builder --linux --dir`, so it proves the Linux bundle and nothing about the macOS or Windows signing path. The desktop image's build asserts `/opt/wageroute/wageroute` is executable, because electron-builder suffixes the unpacked directory with the build architecture (`linux-arm64-unpacked`) and a hardcoded path fails at `COPY` time instead. Inside that image supervisord runs four programs by `priority`, which orders *spawning* and not readiness — Xvfb, the app, x11vnc and websockify all start within milliseconds — so `[program:vnc]` waits for Xvfb's `/tmp/.X11-unix/X${DISPLAY#:}` socket and then `exec`s the server, keeping supervisor's tracked pid the VNC process itself so a stop cannot orphan a listener on 5900. Run the desktop container with `--shm-size=1g` (the compose file sets it): Docker hands `/dev/shm` 64 MB by default and Electron wants more to paint, which `--disable-dev-shm-usage` papers over rather than fixes. What each container is for, and what running one costs you, is in [DEPLOYMENT.md](DEPLOYMENT.md#running-wageroute-in-a-container).

The third shape is a proxy, and it is behind a compose profile so nobody meets it by accident. To render or run it:

```sh
COMPOSE_PROFILES=edge \
WAGEROUTE_DOMAIN=ann.example.lan \
WAGEROUTE_AUTH_UPSTREAM=192.168.1.9:9091 \
WAGEROUTE_AUTH_URI=/api/authz/forward-auth \
WAGEROUTE_BIND=192.168.1.20 \
docker compose up -d --build caddy pocket-ann desktop-ann
```

`docker compose config` with those variables is the cheap check that the file renders, and `docker run --rm -v "$PWD/docker/edge.Caddyfile:/etc/caddy/Caddyfile:ro" -e WAGEROUTE_DOMAIN=ann.test -e WAGEROUTE_AUTH_UPSTREAM=127.0.0.1:9091 -e WAGEROUTE_AUTH_URI=/api/authz/forward-auth caddy:2.11.7-alpine caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile` is the check that the Caddyfile parses — both were run on 2026-11-04 and neither needs a provider running. Three gotchas worth knowing before you write the next line of it: compose's `${VAR:?error}` is evaluated while parsing the **whole file**, so it cannot guard a profile-gated variable without breaking the default `docker compose up` for everyone (that is why the Caddy container checks its own environment in its entrypoint), and `docker compose down` **skips services behind `profiles:`**, so closing the edge shape means naming the profile again or the proxy keeps listening. A third, found by running two tenants at once on 2026-11-04: if you give each tenant its own `internal: true` network, the proxy must also sit on a network that is **not** internal, or Docker publishes none of its ports and says nothing about it — the container keeps the requested binding in its `HostConfig`, `docker port` prints empty, and the symptom is a site that will not connect rather than an error. The deployment doc's [TLS, a login, and more than one person](DEPLOYMENT.md#tls-a-login-and-more-than-one-person) covers what the shape is for.

## Project layout

```text
src/
├── main/
│   ├── index.ts              app lifecycle, window, security policy, the launch gate
│   ├── ipc.ts                channel handlers, dialogs, file I/O
│   ├── files.ts              atomic writes, read-back verification
│   ├── log.ts                crash log and note writer
│   ├── storage.ts            the data directory, its lock, and moving it (key file included)
│   ├── envelope.ts           seals and opens a backup on the desktop
│   ├── unlock-prompt.ts      the one window that exists before the ledger opens
│   ├── window-load.ts        a window whose own screen never arrives: retry, then say so
│   ├── window-security.ts    trusted-page rules, the `?mode=unlock` gate
│   └── db/
│       ├── connection.ts     singleton, pragmas, path, boot checks
│       ├── encryption.ts     the keyed open path and the reversible transition
│       ├── ledger-key.ts     the key file beside the ledger: wraps, rails, mode 0600
│       ├── device-custody.ts the OS keychain wrap, and when this machine has none
│       ├── custody.ts        turning encryption on and off, changing who holds the key
│       ├── unlock.ts         how a launch gets its key back, and what it refuses
│       ├── maintenance.ts    quick_check, upgrade/erase/daily copies, compaction
│       ├── migrations.ts     versioned schema
│       ├── repositories.ts   façade re-exporting the repo/ modules
│       ├── repo/             CRUD per entity, read models, transfers, round-up,
│       │                     categories, autopay posting, balance snapshots
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
├── pocket/
│   ├── main.tsx              root and service-worker registration
│   ├── App.tsx               tabs, toasts, welcome/ready/locked switch
│   ├── lib/                  backup reader, snapshot, compute, entry rules,
│   │                         writers (bills, goals, accounts, categories, entries),
│   │                         IndexedDB, zustand store, install prompt,
│   │                         webcrypto.ts (one seam, and the no-cipher refusal),
│   │                         envelope.ts (the sealed file), vault.ts (this phone's copy)
│   ├── screens/              Home, Bills, Goals, Accounts, Ledger, Data, Welcome
│   ├── components/           MoneyInput (money and percent), Field, Sheet, DeleteConfirm,
│   │                         Nav, PickBackup, VaultCard, UnlockVault, UnlockSeal, ExportSheet
│   ├── public/               manifest, service worker, icons
│   └── vite.config.ts        separate root, alias, CSP injection, dist-pocket
└── shared/
    ├── accounts.ts       Safe-to-spend pool, total wealth, wealth buckets
    ├── allocator.ts
    ├── api.ts
    ├── channels.ts       typed IPC contract and the exhaustive channel list
    ├── billPrompts.ts
    ├── cadence.ts
    ├── claims.ts         whether a bill's set-aside has been spent — the walk both devices run
    ├── csv.ts
    ├── dates.ts
    ├── deletion.ts       every destructive question, counted, in one place
    ├── diagnostics.ts    the report text, DOM-free and testable
    ├── emergency.ts
    ├── encryption.ts     what an encrypted ledger reports, and each custody's honesty table
    ├── envelope.ts       the sealed-export shape both devices read and neither can put crypto in
    ├── importRepair.ts   import problem detection and repair
    ├── money.ts
    ├── projections.ts
    ├── qif.ts
    ├── settings.ts
    ├── statements.ts
    ├── tableMerge.ts     the newer-wins decision and the phone's mergeTables
    ├── transfers.ts
    ├── types.ts
    ├── writeRules.ts     the validation sentences and ranges both devices write with
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
    ├── qif.test.ts
    ├── claims.test.ts
    ├── tableMerge.test.ts
    ├── writeRules.test.ts
    ├── deletion.test.ts
    └── importRepair.test.ts
```

### Layering rules

| Layer | May import | Must not import |
| --- | --- | --- |
| `shared` | Other shared modules | Electron, Node APIs, React, DOM |
| `main` | Shared, Node, Electron, better-sqlite3-multiple-ciphers | React, renderer code |
| `preload` | Shared types, Electron IPC | Node filesystem, database code, renderer code |
| `renderer` | Shared, React, Zustand, renderer modules | Electron, Node, the SQLite driver, SQL |
| `pocket` | Shared, `renderer/src/lib/finance.ts`, React, Zustand, browser APIs (IndexedDB, File, ServiceWorker, `crypto.subtle`) | Electron, Node (including `node:crypto`), the SQLite driver, SQL, any other renderer module |

Shared code is the contract. If a rule needs to be used in both processes, it belongs in `shared`.

The one case that crosses a boundary on purpose: `src/main/envelope.test.ts` imports the **phone's** `sealEnvelope` to prove a file sealed on one platform opens on the other. That is a test reaching across, not a source file doing it, and it is why `typecheck:node` compiles the phone's crypto — which in turn is why `SessionKey` is inferred rather than annotated with `CryptoKey`, a name browsers declare as a type and Node only as a value.

## TypeScript and aliases

Two projects:

- `tsconfig.node.json` — Node lib, `types: ["node"]`, includes main, preload, shared and the Vite config.
- `tsconfig.json` — DOM lib, JSX, includes renderer, shared and preload typings; excludes `*.test.ts`.
- Both enable `noUnusedLocals` and `noUnusedParameters`, so an unused import fails `npm run typecheck` rather than lingering.

Both enable `strict`, `verbatimModuleSyntax`, `isolatedModules` and `noEmit`. Type-only imports must use `import type`, because of `verbatimModuleSyntax`.

`noUncheckedIndexedAccess` is **not** enabled. Enabling it was evaluated and measured: it surfaces 122 errors — 52 in 13 source files and 70 in tests — mostly array and record indexing in the projection, CSV and grid code. That is a real refactor rather than a flag flip, so it stays off until the affected paths are rewritten and their tests updated. Do not enable it in one config only; the two projects share `src/shared`.

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

**None of the above works on an encrypted ledger, and that is the point.** The stock SQLite CLI carries no codec, so a copy of a keyed `.db` is refused:

```bash
$ sqlite3 -readonly /tmp/wageroute-copy.db "PRAGMA user_version;"
Error: file is not a database
```

Do not treat that as damage, and do not "fix" it by forcing the file open. To read rows and pragmas on a copy you have three honest options: turn encryption **off** in the throwaway profile first and copy the plaintext result; take a **plain** export and read the JSON; or open the copy through the driver, which is what the tests do (`openLedger(file, dataKey)` in `src/main/db/encryption.ts`). The first sixteen bytes of a keyed file are not `SQLite format 3\0`, which is exactly how the app itself tells the two states apart — `ledgerLooksEncrypted()` reads nothing else.

### Never overwrite live preferences to test

Do not write test values into the real `settings` table, real accounts or real goals. If a test needs a specific state, use the disposable home or import into a throwaway profile.

### Quarantine, do not delete

When a test requires moving a database aside, move it to a dated quarantine folder. Do not delete the only copy of a user database, even a demo one, without confirmation.

## Testing

Seventy-three files run by `npm test` through `node --test` with `tsx` as the loader — 744 tests today. The script lists every file path explicitly, so **a new test file must be added to the `test` script in `package.json` or it never runs**; the `pretest` guard ([`scripts/check-test-list.mjs`](../scripts/check-test-list.mjs)) fails the run when a `*.test.ts` on disk is missing from that list, or when the list names a file that no longer exists.

| File | Style | Covers |
| --- | --- | --- |
| `domain.test.ts` | pure functions | money parsing and formatting boundaries; month-end date clamping and due-date derivation; allocator priority, shortfall, scaling, goal ordering, whole-dollar sweeping and the balance identity; debt as a surplus bucket; bill prompt chronology and early-payment window; round-up remainders and transfer legs; emergency variable averaging, essentials, target and coverage; settings defaults, corrupt input and round-trip serialization; CSV quoting, parsing, bank-style dates, duplicate headers and transfer rejection |
| `allocator.property.test.ts` | pure functions, seeded randomness | 500 generated plans assert the allocation invariant every time: income clamped, every cent allocated, priority never above the required amount, goal fundings never above their need, integer non-negative buckets, a shortfall zeroing the surplus, and whole-dollar buckets landing on multiples of $1 |
| `dates.test.ts` | pure functions | `isISODate` round-trips through `Date.UTC`: leap days, month ends, `2026-02-31`, `2026-13-01`, `0000-00-00` and the wrong shape |
| `errors.test.ts` | pure functions | `RepositoryError` codes survive `encodeError`/`decodeError`; `apiErrorMessage`/`apiErrorCode` strip the marker; non-repository errors pass through unchanged |
| `occurrences.test.ts` | pure functions | bill occurrence generation across cadences and month boundaries; the "third check" surplus case |
| `kinds.test.ts` | pure functions | account-kind classification and its Safe-to-spend default |
| `csv.test.ts` | pure functions | export round-trip; text cells beginning `=`, `+`, `-`, `@`, tab or CR are prefixed with an apostrophe and stripped again on import; amount cells stay numeric; one day above 12 settles the date order for the whole file; a file that cannot prove its order is read month-first and says so; an unknown kind that collides with an object member falls back to the amount's sign |
| `cadence.test.ts` | pure functions | which paycheck slot a date falls in for each pay cadence; the check closest to a due day, ties going earlier; which slots a month is certain to contain; an unreachable target is clamped rather than dropped; `last_check` lands on the last guaranteed slot and nowhere else; `all_checks` has no single funding check; a single-check bill carries the **month** ($50 weekly → $216.67) on one check and nothing on the other; every strategy's monthly total equals the obligation it owes; no paycheck date means the spread, never the clock |
| `importRepair.test.ts` | pure functions | a clean backup needs nothing; each missing, invalid or dangling value becomes exactly one question; nullable versus required references; answers repair rows, unanswered rows are dropped rather than thrown; a still-invalid answer drops with the validation message; clearing a nullable reference is a valid answer; rows inside one file can satisfy each other's references; the accounts↔goals cycle is answerable in one pass; unmatched CSV account names collapse to one question each; a reserve with no `state` is filled by the schema rather than asked about, while a present invalid state is still one question |
| `statements.test.ts` | pure functions | SGML and XML OFX/QFX statements read signed lines without a timezone shift; an impossible OFX date is reported rather than rolled forward; a statement with no transaction block is refused; a bank CSV without an Account column names its own problem line; a loan statement's principal is not treated as a closing balance and a loan ledger balance still reconciles; an investment statement imports only its cash movements and says what it left out |
| `qif.test.ts` | pure functions | a bank QIF keeps category precedence and reports file line numbers for its problems; a split record keeps its money and a shared category; a day-first file settles its own date order; a card QIF reads Quicken's `10/09'2026` form; an account name becomes the statement label; a two-account file, an investment-only file and an empty file are each refused with a message that says what to do instead, and a mixed file imports its cash while naming the investment records it left out |
| `accounts.test.ts` | pure functions | the explicit Safe-to-spend choice versus the kind default; a dedicated account staying out of the spendable pool; archived accounts counting for nothing; credit subtracting from total wealth; wealth buckets partitioning the total exactly; the allocator skipping an account-funded goal and the leftover falling to savings; routed debt and investing leaving Safe to Spend until the plan's own transfers land, and an unrelated deposit not counting as settlement |
| `categories.test.ts` | pure functions | name normalisation and the case/space-insensitive key; the seed list; spending for a month groups by linked id, falls back to stored text, ignores non-spending kinds and sorts largest first |
| `credit.test.ts` | pure functions | the close date walked first, then the first due day after it (both orderings); amount due never below zero; the previous close date of a date; a typed utilisation is percentage points (`5`, `42.5`, `0.25` accepted; blank, `5%`, three decimals and a negative refused) and resolves to `round(limit × percent / 100)` |
| `payoff.test.ts` | pure functions | amortisation in integer cents; the final payment when it is smaller; no plan when the payment cannot clear the interest; the two-year required payment |
| `history.test.ts` | pure functions | the net-worth series fills gaps forward, starts at the first recorded day, samples to 90 points and always keeps the last |
| `money.test.ts` | pure functions | the money and percent field sanitisers: digits, one point and any typed grouping survive, symbols and spaces are stripped, a minus is kept only where negatives are allowed and only in front, a percent never carries a sign and caps at two decimals; a grouped amount keeps every digit while typing and settles on one exact form when left, and sanitized text still parses to the same cents; a decimal comma is not read as a thousands separator, a comma reads as a decimal when that is the only sensible reading and as grouping when every group is three digits, two separators follow the rightmost one, and malformed grouping is refused rather than guessed at |
| `emergency.test.ts` | pure functions | the manual buffer sits on top of the auto target: months of essentials alone, a buffer added to that, and a missing, negative or unparseable buffer changing nothing — while zero essentials still honours the buffer |
| `adjustments.test.ts` | pure functions | every reason posts one truthful memo and category and appears exactly once with its own label; an account only offers the reasons that make sense for its kind, and every account keeps the plain correction and rounding options; `resolveAdjustBalance` answers all three credit modes with one target, reads a utilization as percentage points, falls back to the amount when a card has no limit, refuses a direction that contradicts the reason, and previews the owed, available and used figures |
| `product-model.test.ts` | **real in-memory SQLite** | the v8 seed and text backfill; category dedupe, rename and delete; a category is one row however its non-ASCII letters are cased; the ledger query filter/sort/page; bulk delete dedupe; daily snapshots once per day; autopay posts once, posts only the remainder of a part payment, and never guesses an account |
| `backup-example.test.ts` | real file | `examples/backup.example.json` parses at the current `SCHEMA_VERSION` and every cross-table link — including an account dedicated to a goal — resolves; merging the file into a migrated database raises no issue and every claim keeps the state and settling payment the file names, so the shipped example cannot silently drift from its own payment |
| `backup-merge.test.ts` | **real in-memory SQLite** | schema-defaulted columns import with the default instead of failing NOT NULL; one unusable row is reported rather than aborting the file; a settings row without a key is skipped and a key this build no longer reads is refused rather than restored; existing values survive while missing timestamps fill in; a restore into an empty ledger adopts the file's settings while an import into a ledger with history keeps the local ones; the import allowlist names every column the schema declares; a dedicated account and its goal survive an export/import round trip; CSV names mapped in the wizard land on the chosen account; an unmapped name is left out once and the rest still imports; a mapping whose account disappeared reports the row instead of throwing; a live claim under a deleted bill is reported instead of held forever; a claim whose funding cheque is a tombstone still reconciles with its payment; a reserve with no state lands reserved; a replay failure rolls the whole import back |
| `migrations.test.ts` | **real in-memory SQLite** | forward-only `user_version`; `SchemaTooNewError` carries the found and supported numbers and leaves `user_version` unchanged; each migration preserves existing rows; a v1 fixture migrates to the current schema with its EUR currency, opening balance and entry intact; a v2 debt allocation survives every later rebuild |
| `reserves.test.ts` | **real in-memory SQLite** | `bill_reserves` rows are written and cleared with the bill lifecycle; a partial payment moves the reserve; a cheque after the due day carries into the next month under any strategy; a payment dated before the new cheque settles the carry, not the new claim; deleting it re-opens exactly that carry and not another payment's claim; one payment cannot close two months of carry; two half payments close one claim and name the second; a linked delete leaves a legacy unlinked claim another payment covers paid; a refund takes back its payment's coverage; a zero-cent claim does not block the ones behind it; a strategy switch in either direction preserves the month's remainder and a third switch adds nothing; a due-day edit does not rewrite an old carry; one payment closes only the claims its amount fully covers, a card charge that closed a claim does not block the cash reserve, a payment smaller than the claim leaves it reserved, deleting a pre-v9 payment re-opens the carried claim it closed, and the v9 migration backfills strategy and due day without moving an amount |
| `legacy.test.ts` | temp directories | pre-rename adoption moves the database and its sidecars or leaves everything in place and reports why |
| `seed.test.ts` | **real in-memory SQLite** | a fresh install gets one unnamed user, all default settings and the starter categories but no demo rows; seeding twice keeps the first user; the demo profile is one linked set of rows where every transfer group carries both legs and sums to zero |
| `entries.test.ts` | **real in-memory SQLite** | a statement lands on the account the wizard chose and re-imports as duplicates; a bank's own id stops the same line landing twice, including twice in one file and across accounts, while an id on a soft-deleted row can be imported again; an unanswered statement is reported once, not once per line |
| `paycheck-plan.test.ts` | **real in-memory SQLite** | a retried draft id returns the first paycheck; a same-day second deposit or the same amount within ±3 days needs the duplicate flag; a bill already paid this month is not withheld again and a part payment only withholds the remainder, and a payment made in another month does not release this month's wall; applying a plan posts one paired transfer per line, a second press moves nothing, and a later press moves only the unsettled lines; a savings share cannot land in checking, a goal share only in that goal’s own account, and a line with no matching account kind is refused before anything is written |
| `export-roundtrip.test.ts` | **real in-memory SQLite** | 505 entries survive an export and re-import whole (505 added, 0 skipped; a second import adds 0 and skips 505); the 500-row default is a grid cap, not an export cap, and an explicit limit is honoured |
| `reconciliation.test.ts` | **real in-memory SQLite** | a balance on a date counts that day and nothing after it, and the opening balance is part of what the account held on that date; a card statement prints what is owed while the ledger holds it negative; a disagreement posts exactly one adjustment on the statement day and leaves later entries alone; reconciling a deleted account is refused rather than posted nowhere; the shared comparison reports the gap in the ledger's own sign |
| `users.test.ts` | **real in-memory SQLite** | setting a name trims it and the greeting reads it back; an empty name is a real answer that clears the greeting; a name longer than sixty characters, one containing a line break, and a non-string are refused rather than coerced; renaming a missing user is a not-found rather than a silent no-op |
| `api.test.ts` | pure | every bridge method reaches one declared channel and the contract has no extras; the bridge exposes exactly the channels the contract declares |
| `ui.dialog.test.ts` | **jsdom + React 19 `act`** | `useDialog` moves focus into the panel, wraps Tab last → first and Shift+Tab first → last, closes on Escape, returns focus to the trigger and restores the body’s overflow |
| `PriorityWall.test.ts` | **jsdom + React 19 `act`** | a month with one paid and one open claim still reads **Reserved**, a fully closed month reads **Paid**, the summary prints the reserved and paid sums separately, the next-check cell keeps only what the month still owes after a cash payment and a claim, an autopay payment with no claim still reads **Paid** and counts in the summary, a part-paid bill without a payday shows only its remainder, and the table has exactly one `<tbody>` |
| `BillPrompts.test.ts` | **jsdom + React 19 `act`** | a prompt from an earlier month shows a date field starting on its due date and capped at today, names the month the chosen date counts in, and posts that date; a prompt due this month posts its due date with no date field |
| `EntryDialog.test.ts` | **jsdom + React 19 `act`** | a bill payment shows a bill picker and refuses to save without one, then posts the chosen `billId` as money out; goal funding does the same for its goal; changing the kind removes the picker |
| `entry-links.test.ts` | **real in-memory SQLite** | a manual bill payment stores `bill_id` and the read model joins its name; goal funding stores `goal_id`; an unknown or another user's bill is refused, a link is refused on a kind it does not belong to, a row cannot name both, and a transfer cannot carry either; retyping an entry drops a link its new kind cannot carry while a bill payment retyped to an expense keeps its bill |
| `ImportWizard.test.ts` | **jsdom + React 19 `act`** | a money answer of `twelve` is named (`not an amount`) and keeps **Import** disabled while a blank answer does not, `12.50` clears the error, the review prints the export date with its future note, and an incomplete row is named once while a deliberately skipped row keeps **Not imported** |
| `maintenance.test.ts` | real SQLite file | `quick_check` passes on a healthy file; a non-SQLite file raises `DatabaseCorruptError`; only a real version increase in an existing file gets a pre-upgrade copy (never a fresh or already-current one); an upgrade copy carries every row and prunes to the newest three; a daily copy is written once per local day (a 23:30 local timestamp still names today), carries every row and keeps the newest seven; `VACUUM` + `secure_delete` leave a sentinel memo absent from the database file |
| `window-security.test.ts` | pure functions | the packaged page is trusted by exact URL, not by `startsWith`, so a lookalike prefix is refused; the dev server is trusted by origin, so a lookalike host or wrong port fails; only the support page may open in the system browser |
| `window-load.test.ts` | pure functions, injected clock | a document that arrives ends the watch; 12 s of nothing is retried twice and then reported once; `did-fail-load` is retried without waiting for the clock; a sub-resource failure and a load the retry itself aborted (`ERR_ABORTED`) change nothing and leave the clock armed; a load that recovers after a retry is never reported and leaves no timer; the limit and the timeout are the constants the shipped watch uses |
| `log.test.ts` | temp directory | a note carries no `Error:` and no stack shape; a crash keeps `name: message` and indents every continuation line; both stay readable through `recentLogTail` and `maxLines` scopes; the file is `0600` and rotates past 512 KiB into `main.log.1`; a parent that is a regular file throws into neither writer and gives an empty tail |
| `finance.test.ts` (renderer) | pure functions | cash on hand, credit owed/available with zero clamps, fundable accounts, the smoothed monthly and per-cheque wall, goal totals ignoring archived goals, the four-slice routing breakdown, the upcoming-payment horizon and day ordinals |
| `selectors.test.ts` (renderer) | pure functions on hand-built snapshots | an unpaid bill stays on the wall while a bill paid from a spendable account releases its part of it; a bill paid on a credit card stays withheld because the pool never fell, and when a bill is paid from both only the card-funded part stays; every headline selector reads zero without a snapshot; wealth counts every live account while the pool counts only spendable cash; Safe to Spend subtracts the unpaid wall, the earmarked goals and the unsettled routing |
| `ledger-guards.test.ts` | **real in-memory SQLite** | archived accounts are refused where they would be spent; a counter account on a non-transfer entry is refused; a round-up memo is clamped to 240 characters; a due day outside 1–31 or a funding slot no cadence offers is refused instead of clamped; shrinking a purchase retires its sweep rows; a bulk delete of a transfer counts both legs; `doomedDeletionIds` predicts the whole doomed set — a purchase with its two sweep rows, an overlapping selection counted once, a sweep picked on its own taking its sibling and no purchase, a plain entry alone, an unknown id ignored — and the number it promised before the write is exactly the number `deleteTransactions` reports afterwards; an account delete promises the rows it really retires — three recorded in the account, five leaving it — and leaves no sweep leg pointing at a retired purchase, and deleting the round-up *destination* takes both sweep legs while the purchase they round up stays; deleting a bill clears `bill_id` on its live payments and leaves their money |
| `files.test.ts` | temp directories | an atomic write replaces the file, leaves mode `0600` on POSIX and no temporary behind; a failed write leaves the previous file intact |
| `storage.test.ts` | temp directories, real SQLite files | the per-user folder is the default until a pointer names another one; a pointer to a folder that has gone stops the app instead of forking the data, and an unreadable pointer file is reported rather than silently ignored; a second writer on the same folder is refused, a lock left by a dead local process is taken over, and an abandoned lock from another computer expires instead of blocking forever; inspection reads the schema version without migrating anything; a move needs an empty folder and adopting needs a ledger; a ledger from a newer build is refused rather than downgraded; the folder in use cannot be chosen again and a candidate says whether it is locked or holds a ledger; a move copies the ledger, leaves the source in place, keeps a safety copy and never inherits the old sidecars, returning home keeps the local ledger aside before overwriting it, and a copy that fails leaves no half-written ledger behind |
| `dedicated-accounts.test.ts` | **real in-memory SQLite** | the two v4 columns round-trip through the repository; an unknown goal is refused; the account balance replaces the allocation total; an overdraft reads as zero; archiving releases the goal back to allocations; removing a goal detaches every account; a goal creates its funders in one call and their balances add; re-saving releases the ticks that were removed and `[]` is a choice, not a no-op; a tick that funded another goal moves and the old goal falls back; a missing account throws and rolls the whole save back; an archived account is refused without letting its valid sibling bind |
| `ledger-key.test.ts` | temp directories, real scrypt + AES-GCM | a data key is 32 random bytes; the same passphrase releases the same key and a different one does not; a passphrase containing a quote is data, not syntax; the wrap is randomised so two users sharing a phrase get different bytes; deriving is deterministic per salt and changes with every parameter; an empty passphrase is refused; the marker round-trips with its mode tightened to `0600`; a marker with no way in, a cipher this build does not ship, or a newer `version` is refused rather than ignored; a truncated marker says so instead of reporting no encryption; rotating custody re-wraps the **same** key; device and passphrase wraps both release it; `NoCustodyError` is what a ledger with every wrap removed reports |
| `encryption.test.ts` | **real SQLite files through the chacha20 codec** | the header, not the key file, decides the state; encrypt→decrypt leaves the money exactly where it was; a write through the codec survives a fresh keyed connection; the app's pragma block is accepted keyed; the safety copy of an encrypted ledger is itself encrypted; an unwritable key file stops the change **before a page moves**; a transition that lands but cannot confirm is rolled back; a second encrypt refuses; decrypting a plaintext ledger says so; a wrong key cannot start a decrypt; the journal mode the folder runs in is restored; every pending / unfinished / completed reconciliation case, including a ledger wrecked mid-encrypt put back from its copy with the wreck kept, one wrecked mid-decrypt coming back **encrypted** rather than empty, and a launch that refuses and touches nothing when no copy reads; the cipher is pinned so a driver default change cannot misread the file; no sidecar is left holding the other state |
| `custody.test.ts` | temp directories, an injected fake keychain | the whole Settings surface without a window: device custody leaves a ciphertext ledger the keychain opens, passphrase custody seals the key so only the phrase releases it, and `both` means either is enough; the plaintext pre-copy does not outlive an encrypt; the round trip encrypt → writes as ciphertext → decrypt leaves the money whole; a phrase too short to survive an offline guess is refused before anything is written; a machine with no keychain is refused device custody and given the phrase instead; a keychain that will not hand the key back stops the encrypt before a page moves; an encrypt that never got under way leaves no key file; an in-flight transition blocks every other encryption change; turning encryption off hands back a readable ledger and keeps no key; a custody change moves **no page**; the last way in cannot be removed; changing a passphrase proves the old one first; the status answers come from the file, not from a setting |
| `unlock.test.ts` | temp directories, hand-written custody attempts | the launch's decision, with no Electron in sight: a plaintext ledger has nothing to unlock; a device wrap that opens is **never followed by a question**; a keychain that refuses falls through to the passphrase; a wrong phrase is asked again, marked wrong and counted; closing the prompt leaves the ledger locked instead of opening anything; a passphrase-only ledger with no window names who is missing; a device-only ledger on a machine with no keychain names both ways out; a corrupt key file is refused before any phrase is asked for; a key file over a plaintext ledger does not make it unreadable; a finished transition is closed out of the key file on the way past; **a ciphertext ledger with no key file is named, not handed to the driver**, and a plaintext one with no key file still opens as the plaintext it is |
| `main/envelope.test.ts` | real Node crypto + **in-memory SQLite** | a sealed backup opens back to the exact text that went in; sealing twice yields different bytes because the salt and IV are new; a wrong passphrase is refused as a `passphrase` problem and not a file problem; an empty phrase is refused before any key is derived; a byte changed in transit fails the tag instead of decrypting to garbage; a header edited to weaken the cost of a guess does not open; a phrase is the bytes that were typed, so a differently normalised one is a different phrase; the default cost is recorded in the file; **a desktop export opens on the phone and a phone export opens on the desktop**; a whole ledger survives the envelope and imports as itself; a plain backup never reaches the cipher because the reader checks the header first |
| `shared/envelope.test.ts` | pure | the shared base64 is the same base64 `Buffer` writes, byte for byte; `fromBase64` refuses what it cannot decode instead of inventing bytes; a well-formed envelope parses and says what it holds; a plain backup is not an envelope and the two are never confused; a newer format version, an unimplemented cipher or kdf, or a header whose lengths do not add up is refused by name; the iteration count is honoured inside the guard rails, not at face value; an encrypted export names itself as one |
| `shared/encryption.test.ts` | pure | every custody option carries all three honesty columns — what it protects, what it does **not**, how it locks you out — so a new option without them is a build error; the passphrase rule is length and repetition, not a strength meter; the status report maps to the option name the screen shows |
| `shared/diagnostics.test.ts` | pure | the report says whether the file on disk is ciphertext; an encrypted ledger names its cipher and every wrap that opens it; a keyed file whose wraps cannot be read is not reported as healthy; an interrupted change appears with the direction it stopped in; the whole report carries build, ledger line and counts; an empty log reads as empty; and **no 24-character base64 or hex run survives path-stripping**, which is the tripwire that keeps a key, a wrap or a phrase out of the text a stranger reads |
| `Settings.export.test.ts` | **jsdom + React 19 `act`** | the export dialog offers both readings every time and writes **plain** by default, and a sealed export is refused until a real phrase is typed twice |
| `pocket/snapshot.test.ts` | **real in-memory SQLite** | a backup exported from a migrated demo database produces the same accounts, bills, goals, transactions, reserves, paychecks and settings on the phone; the phone's Safe to Spend and unpaid wall equal the desktop selectors; bill lines agree with payments and due dates; a phone entry moves the same balances and Safe to Spend; future-dated money changes balance but not cash; accounts sort by code unit like SQLite; a weekly bill with a stale `next_due_on` still reports a due date within the next seven days |
| `pocket/backup.test.ts` | pure + **real in-memory SQLite** | the shipped example opens and round-trips; malformed JSON, the wrong format, a missing or version-1 file, a non-list table, a non-record row and a file with no accounts are refused; a newer version opens with its warning retained; a partial file fills the missing tables; expense and income signs are enforced; invalid drafts throw; a phone export merges into a desktop database once and a second import adds nothing; an unknown account kind and a fractional amount are refused while integer strings are accepted, and a newer version still opens with its rows checked for shape |
| `shared/tableMerge.test.ts` | pure | the merge rule both devices use: an unknown row is added, an older copy leaves the local edit alone, a newer one replaces it, `revision` breaks a same-millisecond tie, a newer tombstone deletes and an older live row cannot revive it, a tombstone for a row never seen takes the id, a newer live row resurrects it, a row with no usable stamp never overwrites one with a stamp, a future stamp is clamped to the file's export time so two devices reading one file agree, settings merge by key and a key this build does not know is refused, a category name that already exists is linked rather than duplicated, a rename onto a live name is refused, a renamed or deleted category stops answering to its old name, the local `created_at` survives an update, and a row without an id is reported instead of dropped |
| `shared/writeRules.test.ts` | pure | the sentences and ranges one validator gives both devices: the enums are the only values either will write, text is trimmed and required and capped, cents are whole and in range and negative only where the caller allows, a patch can leave a column alone or clear it or set it, an unknown choice names the list it was not in, dates are `YYYY-MM-DD`, a due day is a real day and 31 stays 31, a paycheck choice is one of the four slots (1–4, floored, with `null`/`undefined` meaning "no choice"), an implausible APR is a typo, sort order rounds but never refuses a write, an unreadable pace means *as soon as the money allows*, a flag is a real boolean rather than a truthy string, and two stamps taken in order are comparable — the property `updated_at` sorting rests on |
| `shared/deletion.test.ts` | pure | every destructive question, on either device: a lone entry is named by its description, an entry whose description is blank or all spaces still reads properly, a multi-row delete puts the count in the title *and* the button and says what the extra rows are, a transfer leg always asks about both legs with its own memo or *This transfer*, and a count that is not a usable number is clamped so the app never offers `Delete 0 entries?`; an empty account, a counted one and an uncountable one each get their own sentence, a bill splits the set-asides that go from the entries recorded against it that stay, and its read-failed wording admits it measured nothing rather than printing a number, a goal says the plan leaves and the money stays, the erase names all five row counts in singular or plural, and forgetting the phone warns about the entries this phone wrote without claiming the computer has never seen them |
| `shared/claims.test.ts` | pure | the one walk both devices run: a part payment holds a claim open and gives no credit for the money it took, the payment that fills the gap settles it and names itself, money already offered is never offered to a claim again, a refund takes coverage back from the most recent contribution and reopens it, the due-day carry lets a 31 January cheque pay a bill due 1 February, quarterly smoothing skips that gate and clears every slice, an overpayment cannot spill into the next claim, the ordering inside the rule decides which claim is settled first, a claim that already agrees reports `changed: false` so a device leaves the other device's revision alone, and a ledger with no claims derives nothing |
| `pocket/claims-parity.test.ts` | **real in-memory SQLite** + pure | the same money fact typed on each device, over a ledger exported from the first: the desktop's repository and the phone's writer put the claim in the same state at the same `revision`, each naming *its own* payment in `settled_by`; a part payment leaves it open on both; deleting a settled payment reopens it on both; a payment written on the phone travels back through `mergeBackup` and settles the claim on the desktop; and a file in the shape the **released** desktop writes (schema 8, so its claims carry no `due_day` key) holds a carried claim open or settles it on exactly the day the computer uses, while a file that repeats one claim id cannot make that promise collect money twice |
| `pocket/write.test.ts` | pure | the rows the phone's writers leave behind: the phone refuses to stamp anything before a ledger is open, a bill keeps the desktop's defaults and a patch moves only what it names, a paused bill keeps its history while a delete hands its payments back to expenses, marking paid takes whatever the month still owes, a category name is shared rather than duplicated and deleting one leaves entries standing, a goal records its pace and its funding accounts, an account carries the credit columns and archiving or deleting the round-up destination stops the sweeps, an account with entries is archived rather than emptied and a bill or goal pointed at a deleted account lets go, a transfer is two legs the phone cannot pull apart, a round-up belongs to the purchase not the sweep, a retyped entry drops a link its new kind cannot carry, a lone leg from an old backup stays a transfer, a phone edit always looks newer than the row it replaces, and the phone's own list names every row a write posted (both transfer legs, a purchase with its sweep) while an edit, a delete or a bill adds nothing to it; the account question counts five rows leaving a three-row account because the transfer twin and the sweep leg stand in another account, and the bill question's two numbers are exactly the set-asides the delete retires and the entries it releases; the claim walk settles the reservation when the phone pays, reopens it when the payment is deleted, cut back or taken with its account, replays a merged file's payments on opening, leaves a ledger that already agrees byte-identical, and — the regression that caught a silent no-op — an edit arriving with its category writes the row it was shown instead of throwing the patch away |
| `device-round-trip.test.ts` | **real in-memory SQLite** | the end-to-end boundary: a desktop export is opened on the phone, written by the phone's writers and imported back with `mergeBackup` — a bill edited and paid on the phone arrives with the phone's amount, its bumped revision and its linked payment, and a second file does not undo the first; an expense, a transfer pair and a goal funding account land whole with their links; an entry deleted on the phone is gone from the desktop and counted as removed |
| `pocket/vault.test.ts` | real WebCrypto in Node, temp-free | the vault at the test floor's cheapest iteration count on purpose (600 000 rounds is what a person waits for, not what a suite waits for): a vault opens only with its own phrase; an empty box is refused **before any key stretching runs**; the ledger round-trips and the plaintext never reaches storage; two saves of one ledger are not the same bytes; a record touched after it was written does not open; sealing after `lockVault()` says `closed` instead of writing garbage; a screen holding an old marker will not seal under a new vault; a changed phrase opens the new vault and not the old; the wrong current phrase stops a change before anything is rewritten; `assertMarker` refuses a marker that does not parse, a record that is not a vault, and a sealed record that does not hold a ledger; and the cipher seam refuses a page with no cipher instead of meeting `undefined` — a vault neither starts nor opens there, and says which page |
| `pocket/vault-store.test.ts` | the store + a settled fake IndexedDB | no plaintext copy on disk at any point, including the turn-on and turn-off sequences; a phrase too short is refused before any crypto runs; two boxes that disagree do not make a vault; a phone reloaded with a vault on comes back `locked`, not empty; the locked phone opens with the phrase and no other; a save after another tab closed the vault keeps its rows and writes them on the next unlock; *Close it now* takes the key out and writes zero bytes; turning it off gives a plain copy again; a save while sealed writes the **sealed** copy rather than a plain one beside it; forgetting the phone takes the key with it; and on a page with no cipher the refusal is for what it is — the phone keeps working, its plain copy untouched, and a sealed phone there is never described to its owner as damage |
| `pocket/sealed-store.test.ts` | the store, real WebCrypto | a sealed file is recognised from its clear header before anything is asked of the person holding it; a wrong phrase keeps the file waiting and says so where it was typed; an empty box is refused before stretching; the right phrase lands the ledger on the phone; a file that only *looks* sealed is reported as the file problem it is; the phone still exports plain JSON by default; a sealed export from the phone is one the desktop opens, and one the phone reads back |
| `pocket/vault-ui.test.ts` | **jsdom + React 19 `act`** | the card states what sealing stops and what it does not before it asks for anything, and refuses a phrase that could not hold; closing the seal from the card takes the key and asks again; a damaged copy is told as one rather than as a phrase to retry; a forgotten phrase has exactly one door — erase this phone's copy — and every remount proves the no-cipher notice is live state, not a stuck flag; the gate and the card each render only when they are the truth |
| `pocket/seal-ui.test.ts` | **jsdom + React 19 `act`** | a sealed file names itself and waits, a wrong phrase stays on the same box, and a second sealed file is asked about with an empty box; the export writes plain by default and asks for nothing; a sealed export is refused until a real phrase is typed twice, then names itself; a page with no cipher offers the plain export and says why the sealed segment is not there, and a sealed file on such a page is not called damage — the delete is not the answer |

The phone's crypto tests lean on one helper: [`src/pocket/lib/without-cipher.ts`](../src/pocket/lib/without-cipher.ts) shadows `crypto.subtle` (a configurable getter, so an own `undefined` hides it and `delete` restores it) to reproduce the state Node cannot serve — a page served over a LAN address, where `getRandomValues` exists and the cipher does not. No app module imports it, so it does not reach `dist-pocket/`; when the phone is rebuilt, the built asset is checked for its absence rather than trusting the import graph.

Conventions every new test follows:

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
```

- Flat top-level `test('description', () => …)` calls — the suite does not use `describe`/`it`.
- A database-backed test creates its own: `new Database(':memory:')` → `migrate(db)` → insert a `users` row with the fixed `USER_ID`, because every tenant query filters `user_id`. The `freshDb()` helper in `backup-merge.test.ts` is the pattern to copy; it is re-created per test.
- Assertions are on plain values and integer cents, never on rendered output or snapshots. The DOM tests (`ui.dialog.test.ts`, `Allocator.test.ts`, `ReconcileStatementDialog.test.ts`, `PriorityWall.test.ts`, `ImportWizard.test.ts`, `BillPrompts.test.ts`, `EntryDialog.test.ts`, `Settings.export.test.ts`, and on the phone `pocket/vault-ui.test.ts` and `pocket/seal-ui.test.ts`) drive components through jsdom with React 19's `act`, and are the only places a component is mounted; there is no Testing Library and no coverage tool.

Run:

```bash
npm test
```

### What is not covered

There are no automated:

- IPC integration tests (the `data:preview`/`data:passphrase`/`data:confirm` token lifecycle included — the envelope functions behind the sealed branch are tested, the handler at `src/main/ipc.ts:1124` that calls them is not, so a typo in that wiring is only visible in the app);
- React component tests beyond the dialog focus model and the save guard — the dashboard's selectors are pure-tested, but the import wizard, the allocator and every screen are still checked by hand;
- end-to-end tests;
- visual regression tests;
- migration tests against every historical fixture — a v1 fixture now migrates to the current schema and a v2 debt allocation is proven to survive the rebuilds, but the v2/v3 migrations themselves are still only covered indirectly;
- repository tests for the CRUD validators outside the two importer paths above.
- any of the encryption layer running in the environment a user has: the custody tests inject a **fake keychain**, so the real `safeStorage` on a signed-in macOS login, a Windows credential or a Linux secret service is never exercised; the transition tests use the driver directly rather than the unpacked binary inside a packaged app; the phone's crypto runs on Node's WebCrypto and jsdom, never on a handset; and the no-cipher guard is proved by removing the property, not by loading a real `http://` page. Each of those has a manual proof in [RELEASING.md](RELEASING.md) and none has an automated one.

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

- Add the channel to the `IpcContract` map and the `CHANNELS` list in `src/shared/channels.ts` (the compile-time check rejects a handler with no contract entry).
- Add the handler in `src/main/ipc.ts`.
- Add the method to `FinanceApi` in `src/shared/api.ts`.
- Add the bridge call in `src/preload/api.ts`.
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
2. Add the method signature to `FinanceApi` and its entry to the `IpcContract` map in `src/shared/channels.ts`; add the name to the `CHANNELS` list. A channel missing from that list fails the compile-time `UnlistedChannel` check.
3. Register `ipcMain.handle('domain:action', ...)` in `src/main/ipc.ts`.
   - Validate IDs with `requireId` and month keys with `requireMonth`.
   - Delegate payload rules to the repository; do not duplicate them in the handler.
4. Expose it through the typed `call()` helper in `src/preload/api.ts` (the bridge is built from the contract, not hand-written per channel).
5. Add a store action that calls it, refreshes the snapshot and surfaces errors. A read-only channel with no snapshot effect (such as `app:diagnostics` or `bill:payments`) may be called from the screen through `window.api` instead.
6. Keep channel names `domain:verb` (`account:create`, `data:preview`, `data:confirm`).

Do not expose `ipcRenderer`, `require`, `fs` or raw SQL to the renderer. `src/preload/api.test.ts` fails if the bridge and the contract drift apart.

## Adding a schema migration

Migrations are append-only. Never modify a `SCHEMA_V*` string once its version has shipped (`SCHEMA_V1`–`SCHEMA_V3` shipped in the 1.0.x line, `SCHEMA_V4`–`SCHEMA_V6` in 1.1.0, and `SCHEMA_V7`–`SCHEMA_V8` in 1.2.0; `SCHEMA_V9` and `SCHEMA_V10` are on `main` and in no released build yet — all are immutable once shipped, and a migration that has only lived on `main` is already effectively frozen for anyone who ran it). Databases in the field have already run them.

### Procedure

1. Add a new SQL string, e.g. `SCHEMA_V9`.
2. Add `{ version: 9, up: (db) => db.exec(SCHEMA_V9) }` to `MIGRATIONS`.
3. `SCHEMA_VERSION` updates automatically from the last entry.
4. Update types, repositories, backup allowlists and the seed. A column declared `NOT NULL` with a schema default also needs an entry in `TABLE_DEFAULTS`, or an older backup that omits it inserts `NULL` and aborts that row.
5. Test against a **copy** of a database one version behind `SCHEMA_VERSION` — version 8 for the released line, version 9 once 10 ships (see [Working safely with data](#working-safely-with-data) — never the live file, and there is no downgrade path):
   - `PRAGMA user_version` before and after;
   - row counts preserved;
   - new columns present with correct defaults;
   - `PRAGMA integrity_check` and `foreign_key_check` clean;
   - app boots and snapshot loads.

   Migrations run on the pages, and the codec sits under them, so an encrypted ledger migrates exactly as a plaintext one does — but that is an *argument*, not a test. Every automated migration test opens a plaintext file. When you change a migration, run the procedure above once against a copy of a **keyed** profile (the `.db` and its `ledger.key.json` together) and note that you did.
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

Export uses `SELECT *`, import uses an allowlist (`TABLE_COLUMNS`). A new column that is not added to `TABLE_COLUMNS` exports fine and is then **silently dropped on import** — no error, no issue row, just missing data. `backup-merge.test.ts` compares the allowlist against `PRAGMA table_info` for every backed-up table, so the omission fails `npm test` instead of losing a user's column; `dedicated-accounts.test.ts` and the round trip cover the value-level behaviour.

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
- Inspect a copy with `sqlite3 -readonly` (see [Working safely with data](#working-safely-with-data)) — and know that on a keyed ledger the CLI has no codec, so the only readable states are "plaintext file" and "not a database". For a ciphertext ledger, read it through `openLedger(file, dataKey)` from `src/main/db/encryption.ts`, the same way the tests and the health probe do.
- Check `PRAGMA user_version`, table counts and `deleted_at` filters when a row “disappears”.
- If the app says `file is not a database` on a ledger you know was never encrypted, suspect damage; if it says it about a ledger that *was*, look for `ledger.key.json` beside it — the app refuses that combination by name before the driver ever sees the file.

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

The SQLite driver is `better-sqlite3-multiple-ciphers`, a MIT drop-in fork of `better-sqlite3` that carries SQLCipher's ChaCha20 codec. It matters for two reasons: the fork is what lets the ledger be ciphertext at all, and it is a **prebuilt** module, which changes what packaging has to do.

- The package ships `prebuilds/darwin-{x64,arm64}.node`, `linux-{x64,arm64}.node`, `linuxmusl-{x64,arm64}.node` and `win32-{x64,arm64}.node`, and `lib/binding.js` resolves one of those **before** it looks for a node-gyp output. `gypfile: false`, so `npm install` never compiles SQLite.
- The binary registers through **N-API** (`_napi_register_module_v1`), not a versioned V8 ABI. The same file therefore serves Node 24, the test loader and Electron without a rebuild, and an Electron major bump does not invalidate it. `npm run postinstall` (`electron-builder install-app-deps`) is a no-op for this module and stays in the scripts as the step that would rebuild a module that *does* need it.
- `electron-builder.yml` still sets `npmRebuild: true` and unpacks `**/*.node` out of the asar. The rebuild is harmless and now vacuous; the unpack is load-bearing — a `.node` inside an asar cannot be `dlopen`ed.
- A plain `node` script that imports the driver uses the same prebuilt file as Electron. That is why the whole test suite can drive real SQLite files and the real codec with `node --import tsx`.

What can still go wrong is architecture and platform, not ABI. With no matching prebuild and nothing compiled, `lib/binding.js` falls through to the node-gyp locations and Node reports the last one it tried:

```text
Error: Cannot find module '.../better-sqlite3-multiple-ciphers/build/Release/better_sqlite3.node'
```

That means no prebuild matched and there was nothing to compile — a platform the fork does not ship, or a lockfile that resolved a different tree. Fix by installing on the target platform (`npm ci`), and if the platform genuinely has no prebuild, by building it with the toolchain in [RELEASING.md](RELEASING.md#prerequisites). A `NODE_MODULE_VERSION` message belongs to the retired `better-sqlite3` and should not be seen at all; if it is, something has installed the wrong package.

Architecture matters independently: an arm64 Electron build needs `prebuilds/darwin-arm64.node`, and electron-builder picks the file per target.

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
- Confirm destructive actions through the shared dialog (`useDialog`, and the questions themselves come from `@shared/deletion`) — never `window.confirm`, and never a number the code has not counted.
- Disable submit buttons while `busy`.

### Main patterns

- Validate at the IPC boundary (`requireId`) and in the repository (text, cents, enums, dates).
- Wrap multi-statement writes in `db.transaction`.
- Bump `revision` and `updated_at` on every update and soft delete.
- Filter `deleted_at IS NULL` in reads.
- Never interpolate a column or table name from user input.
- **Any connection that reads a ledger's contents is made with `openLedger(file, dataKey)`** — the singleton, the health probe, a copy's verification. A connection that skips `applyKey()` sees a corrupt database in a file that is perfectly healthy, which is the failure mode encryption adds. The two places that open a file they cannot have a key for — `inspectLedger()` at `src/main/storage.ts:279` and the pre-rename adoption copy at `src/main/db/legacy.ts:97` — both check the SQLite header **first** and refuse an encrypted file rather than reading it as plaintext.
- Nothing that can read the ledger is registered before the launch gate opens it. `src/main/ipc.ts` runs against a handle that exists only after `openLedgerForBoot()` returned one, and the passphrase prompt is a separate window with two messages and no channels. A feature that must work while the ledger is locked is not a new channel — it is a new message on that prompt, and it should be refused unless there is a real reason.
- Copying a keyed ledger means copying `ledger.key.json` with it, and every `VACUUM INTO` copy of it is ciphertext: a backup taken from an encrypted profile is only as readable as the key file beside it.

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `Cannot find module '…/build/Release/better_sqlite3.node'` at launch | No prebuild matched this platform/arch, or the installed tree is not the lockfile's | `npm ci` on the platform you are running; if the platform genuinely has no prebuild, the toolchain in [RELEASING.md](RELEASING.md#prerequisites) is what compiles it |
| `NODE_MODULE_VERSION` mismatch | Something installed the retired `better-sqlite3` instead of the cipher fork — the fork's binary is N-API and cannot produce this | Confirm `package.json` names only `better-sqlite3-multiple-ciphers`, then `npm ci` |
| App opens with Alex's demo data | Running unpackaged (`npm run dev`) with a fresh `userData` directory | Expected in development; use the real profile or import a backup |
| Changes do not appear | Snapshot not refreshed or app pointing at another database | Check the database path; restart; verify the store action awaited the mutation |
| CSV rows ignored | Account name mismatch or duplicate names | Check the issue message; rename or create accounts |
| JSON import fails with a foreign key error | Partial file references rows that are not local or earlier in the file | Include the referenced rows or null the links |
| Database changes seem lost | App still running and WAL not checkpointed | Quit before copying; copy `.db`, `-wal` and `-shm` |
| macOS refuses to open a build | Unsigned app, Gatekeeper | Right-click → Open, or sign/notarize |
| Windows SmartScreen warning | Unsigned installer, portable exe or zip | Expected for unsigned builds |
| Linux package manager warning | Unsigned deb/rpm, unverified AppImage | Expected for unsigned builds; verify the SHA-256 from `SHA256SUMS` |
| Dev server port in use | Another Vite process | Stop it; Vite will otherwise choose the next port |
| TypeScript cannot resolve `@shared` | Alias missing in one config | Update both tsconfigs and `electron.vite.config.ts` |
| `electron-builder` uses the default icon | Icon path wrong or missing | Confirm `build/icon.icns` and `build/icon.png` |
| Backup file rejected as newer | Schema version in file exceeds app | Update the app; never edit the version down |

## Known test gaps

Before treating a change as complete, manually verify the paths that automated tests do not cover:

- account creation, editing, adjustment and deletion;
- paycheck commit and the resulting dashboard/donut state, including a retried draft and the duplicate confirmation;
- moving a routing plan from **Last routing**, and reopening it to find the lines already moved;
- transfer creation, paired edit and paired delete;
- round-up with each increment and destination type;
- bill prompt detection, snooze and mark-paid, and a payment settling the Priority Wall's **still unpaid** figure;
- autopay on a bill whose due day has passed, including a part payment;
- theme switching, including system mode;
- JSON export → fresh-profile import;
- CSV export → fresh-profile import, and CSV import through the wizard (its native file picker cannot be automated);
- a bank statement (OFX/QFX, QIF, or bank CSV) through the wizard, including one loan or investment statement;
- partial JSON imports (settings only, transactions only);
- migration from the previous schema version on a database copy;
- a **sealed** export: type the phrase twice, import the file back into a fresh profile, and confirm the wizard asks for the phrase *before* it shows any counts and refuses a wrong one in the box it was typed into;
- turning encryption **on** and then **off** in Settings, with a quit and a relaunch in between — the launch path (device custody opening silently, or the `WageRoute — locked` prompt) is the part no test can reach, because the tests inject the keychain;
- a keyed ledger whose `ledger.key.json` has been moved away: the refusal must name the key file, not report a damaged database;
- moving the data folder with encryption on, which copies the key file with it;
- on the phone: seal the vault, reload the page, unlock, change the passphrase, turn the seal off — and export sealed, then import the same file on the desktop.

Two of these have never been done in the environment they matter in: no **packaged** build has ever opened or created a keyed ledger, and no real handset has ever sealed a copy. Those are release-time proofs, not test gaps that closing one more file would fix — see [RELEASING.md](RELEASING.md#5-test-the-packaged-artifacts) and [POCKET.md](POCKET.md#status-what-has-been-proved-and-what-has-not).

A build that type-checks and passes domain tests can still be functionally wrong. The manual list is part of the definition of done.

# 0023 — The phone reads a backup and writes only entries

**Status:** Accepted (2026-11-02)

## Context

The desktop app is the ledger: SQLite, the main process, and every write path. The request was for a phone app that can be installed and trusted, and for it to be optional and local like the desktop. A backup is the only file the two devices already share.

A full port of the Electron main process onto the phone would mean a second implementation of the database, migrations, repositories and import wizard. Two implementations of money rules drift; two writers to one ledger need conflict resolution that does not exist. A hosted backend would turn a local-only app into an account, a server and a security surface the product has deliberately refused.

The phone also cannot see the desktop's history of edits and deletions. Desktop imports are additive: a row that is already present is skipped, an existing settings key wins, and nothing is removed. Anything the phone invents that the desktop cannot merge cleanly would quietly change the ledger on the next import.

## Decision

**Pocket is a static, installable web app that opens a backup, rebuilds the desktop's snapshot in the browser, and exports an additive backup that contains only the entries it added.**

1. **There is no server and no account.** The built app is static files (HTML, CSS, JS, icons, a manifest and a service worker). It can be hosted on any static origin, including GitHub Pages, and it works with no signal. The only file it asks for is one the user chooses; nothing is uploaded.
2. **The ledger lives in IndexedDB.** The imported tables, the schema version, the source file name and the ids the phone created are stored under one key in the browser's own database. Closing the tab, going offline or restarting the phone does not lose them. Clearing site data, or using a different browser, does.
3. **The snapshot is rebuilt with the desktop's own functions.** Pocket parses the backup with the shared table list, derives balances from live entries, applies the same monthly wall, goal funding, unsettled routing and Safe to Spend functions, and caps its lists the way the desktop does. Only the SQL reads are reimplemented; the arithmetic is imported from `src/shared` and `src/renderer/src/lib/finance.ts`, so the two screens cannot disagree about a number by construction. A parity test builds a demo database, snapshots it on the desktop side, and asserts the phone reaches the same values.
4. **The phone may only append plain entries.** Adding an expense or an income entry writes a new transaction id and records that id as local. The export carries the original tables with those entries appended. The desktop's additive import adds them once, rewrites the user id, and leaves everything else alone. Pocket does not edit, delete, re-date or re-route desktop rows, because the desktop cannot tell an edit from an untouched row. It does not record bill payments either: a payment must settle the claim the desktop wrote, and a phone-invented payment cannot carry that link.
5. **One phone, one ledger copy.** Replacing the file replaces the phone's copy after a confirmation that says how many local entries would be lost. *Forget this phone* deletes the browser copy and leaves the computer untouched. The app never merges two phone copies.
6. **The shell is versioned in a service worker.** Navigation is network-first so a new release lands on the next open; hashed assets are cache-first because their names never change. The install prompt appears when the browser offers one, and Safari gets Share → Add to Home Screen instructions instead.
7. **The policy is built in.** The production HTML carries a strict CSP: same-origin scripts and data, no objects, no base override, no form posts. There is no analytics, no remote font and no third-party request. The app is source-available under the same licence as the desktop.

## Consequences

- Pocket is a view and a small entry pad, not a second full app. Bills, goals, accounts, paychecks and settings are read-only on the phone; they are edited on the computer and arrive with the next backup.
- A phone entry that the desktop later changes or deletes stays in the ledger as its own row. That is the same additive rule as every other import, and it is why the phone refuses to pretend it edited anything.
- The phone shows a newer backup with a warning and disables the assumption that its export is safe until the desktop is updated; it does not silently upgrade or downgrade the schema.
- A browser that evicts site data loses the phone copy. The Data screen says so plainly and asks for an export before a replace or a forget.
- The static build adds a second TypeScript project and a build script, but no dependency on Electron. The GitHub Pages workflow publishes the built folder; enabling Pages and running the deploy are deliberate repository actions, not part of a normal release.

## Alternatives rejected

- **A native iOS/Android app sharing the SQLite file.** Two platform toolchains and a file-sharing story the user did not ask for; the PWA installs from the same origin as the docs and needs no store review.
- **A backend with accounts and sync.** It contradicts local-first, adds a server to secure, and becomes mandatory for the phone to work.
- **Run SQLite in the browser (WASM) and copy the whole database.** The file cannot be opened directly from a picker without a virtual filesystem, the backup format is already the portable surface, and a second writable database would invite divergent ledgers.
- **Let the phone edit or delete desktop rows.** The additive import cannot express an edit or a deletion, so the export would either lose the change or resurrect data. Refusing is the honest option.
- **Cache-first navigation.** A released fix would never reach an installed phone until the service worker changed again; network-first with an offline fallback keeps updates moving.

# Changelog

All notable changes to WageRoute are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) with the sections this project actually needs (`Added`, `Changed`, `Fixed`, `Removed`, `Known gaps`), and the release version numbers come from [docs/RELEASING.md](docs/RELEASING.md#semver-policy).

> **Reading this file.** `package.json` only changes at release time, so commits between releases carry the *previous* version number. Inside an `## [Unreleased]` block, identify work by its commit or pull request, not by the app version. `Unreleased` means merged into `main` and shipped in no build yet — it is what the next installer contains.

---

## [Unreleased]

Target: **1.1.0**. The queued work adds database schema version 4, and [any schema migration is at least a minor bump](docs/RELEASING.md#semver-policy), so this is not a patch release.

The import-wizard and documentation items below are on `main` after the `v1.0.2` tag (`7fce57b`). The dedicated-accounts work (schema 4, purposes, safe-to-spend choice, total wealth) is committed on `feat/dedicated-accounts` and reaches `main` through its pull request — until that merges, no released build and no `main` checkout has it.

### Added

- **Import wizard: ask instead of failing** — `8b25329` (#12, [ADR 0006](docs/decisions/0006-import-wizard-asks-instead-of-failing.md)). Importing a JSON backup or a CSV entries file now runs in two IPC steps. `data:preview` parses the file, keeps it in the main process behind a single-use token, and returns one question per unusable field — a missing name, an enum typed `chekcing`, a `due_day` of 45, a posting account that does not exist, a CSV bank label matching no local account. `data:confirm` re-derives the same questions from the shared rules, applies the answers and merges only the rows that survive. Every row can be fixed with its own editor (text, amount, whole number, date, dropdown of accepted values, dropdown of local rows plus **Leave unlinked**) or left out, and a left-out row is listed with every reason on it and how to repair the source file. An answer that still fails validation drops that row with the validator's message rather than throwing.
  Detection lives in pure shared code (`findImportProblems`), so the questions the wizard showed and the questions the importer checks are the same function, and the answer keys are safe across the two calls.
- **Account purposes: "this account is only for this"** — dedicated accounts. An account can now be bound to one sinking fund, and **that account's balance *is* the goal's progress**: no claim step, no separate top-up ledger. A goal funded this way shows the account name on its card, and the allocator stops routing paychecks into it because the money is already where it belongs. [ADR 0007](docs/decisions/0007-dedicated-accounts-balance-is-progress.md) records the decision, the alternative that was rejected, and what it costs.
- **Per-account Safe-to-spend choice** — each account declares whether it counts as spendable money, chosen at creation and editable afterwards: *Automatic* (checking, savings and cash count; investment and credit do not), *Always count it*, or *Never count it*. Investment accounts are excluded by default, which was the recommendation.
- **Total wealth** — one number for everything owned: cash, money parked in dedicated goal accounts and investments, minus credit owed. It appears as a strip on the Overview page with a bucket breakdown (*Cash · Saved for goals · Invested · Credit owed*), as the first summary tile on Accounts, and as a second line in the sidebar stat. Every surface calls the same `totalWealthCents`, so they cannot drift apart. Motivation was explicit: a small spendable balance read as poverty while goal and investment money existed uncounted.
- **Database schema version 4** (`accounts.dedicated_goal_id`, `accounts.in_safe_to_spend`) — additive, both columns nullable, plus a partial index on the goal pointer. Migration verified against a **copy** of a live version-3 database: `user_version` 3→4, both columns present, index created, `integrity_check` ok, no `foreign_key_check` violations, and all rows preserved (11 accounts, 14 transactions, 3 goals, 3 bills, 17 settings). No existing row opts in, so behaviour for an upgraded database is unchanged until the user chooses.
- **Backup compatibility for both new columns** — they are in the importer's allowlist (export is `SELECT *`, so a column missing from the allowlist would silently vanish on import), askable by the wizard when a pointer dangles, round-trip tested, and present in `examples/backup.example.json`.
- **Seven new shared rules under test** — `src/shared/accounts.ts` plus 15 new tests: explicit choice beats the kind default, a dedicated account is not spendable unless forced, archived accounts count for nothing, the pool is not all cash, credit subtracts from wealth, the buckets partition total wealth exactly, goal money outside the pool is not deducted from it, and the allocator skips account-funded goals. `npm test` is now 56 tests across six files.

### Changed

- **Safe to Spend is measured against the spendable pool, not all cash.** The formula is `spendable pool − monthly Priority Wall − the funded goals whose money is in that pool` instead of `cash on hand − …`. The committed-spending meter still uses cash on hand deliberately; only the hero number changed. The old documentation called the double count "by design" — it was not.
- **Fixed: dedicated-account goal money was deducted twice.** The first cut of the pool excluded a dedicated account from the pool *and* still subtracted its balance as goal progress, so a profile with $1,200 in checking, $4,200 in a dedicated savings account and no bills reported Safe to Spend as **−$3,000** instead of $1,200. Found by driving the built app over the Chrome DevTools Protocol, not by reading the code. `poolEarmarkedGoalsCents` now deducts only allocation-funded goals, and the hero's breakdown rows are labelled "Spendable accounts" and "Funded goals from the pool" so the arithmetic shown actually adds up. Excluding dedicated money from the pool is still only a **default**: choosing *Always count it* on a dedicated account reproduces the double count on purpose, which is the user's call, not a bug.
- **Goal progress has two sources.** Allocation rows for ordinary goals; the bound account's balance for dedicated ones. The balance *replaces* allocation rows rather than adding to them, so routing a paycheck into a dedicated account's goal cannot double-count. Deleting the goal detaches the pointer instead of deleting the account, and archiving the account hands progress back to the allocations.
- **`docs/SECURITY.md`: an unusable row no longer aborts an import.** The threat model previously claimed a constraint failure rolls the whole transaction back. Rows are now caught individually and the rest commit, which is stated with the change that made it true.
- **Documentation reconciled with the code.** `README.md`, `docs/DATA-MODEL.md`, `docs/FEATURES.md`, `docs/IMPORT-EXPORT.md`, `docs/DEVELOPMENT.md` and `docs/ARCHITECTURE.md` moved from schema version 3 to 4 and from app version 1.0.1 to 1.0.2; the Safe-to-Spend formula, the module map (the real `src/shared` file list), the migration recipe (including why a pointer that closes a foreign-key cycle must be validated in code, not declared), and the backup version-acceptance table all now match what ships. `docs/DEPLOYMENT.md` no longer says the working directory "is not currently a git repository".
- **Release documentation retargeted.** `docs/RELEASING.md`'s worked example is now the queued 1.1.0 release rather than a hypothetical `0.2.0`, its version table shows the working-tree schema, and the installer names in the docs carry 1.0.2 asset names. The `curl` install block's DMG volume path was verified by mounting a released DMG rather than guessed.

### Known gaps

- **The new UI has now been driven in a running app.** Launched built arm64 bundles against a disposable profile (`CFFIXED_USER_HOME=/tmp/...`) with `--remote-debugging-port`, and walked every new surface through the Chrome DevTools Protocol: the first-run card, the account create and edit dialogs with both new controls and their conditional hints, the row badges, the Total wealth tile and strip, the goal card's progress and funding-source chip, and the tri-state safe-to-spend choice surviving a round trip through IPC into SQLite and back (the badge disappears with *Always count it* and returns with *Automatic*). This is how the −$3,000 double deduction under **Fixed** was found — type-check and the test suite were green while the composed number was wrong. Screenshot capture and assistive access remain denied on this machine, so the *appearance* is still unverified even though the *behaviour* is. No component tests exist; the verification was manual and will not re-run itself.
- **The import wizard's rendered flow is still not driven.** Its detection and repair rules are tested as pure code, but the wizard opens a native file picker that the DevTools Protocol cannot reach, so opening a file from the dialog by hand is still somebody's job.
- **Only the arm64 macOS artifact has been launched** — on the development machine, against a copy of the live database for the migration check and then against the live database itself after install. The x64 DMG builds (with a node-gyp warning about the space in the path) and the Linux and Windows formats on the queued branch have never been started by anyone.
- **The installed build still reports version 1.0.2** while carrying schema 4, because the version bump happens on the release branch. Nothing about that bundle's name, `Info.plist` or DMG filename distinguishes it from the released 1.0.2; only `PRAGMA user_version` does.
- **v4 backups are refused by older builds.** The backup format version rose with the schema, so a file exported from the next release cannot be imported by 1.0.2. There is no downgrade path for a version-4 database.
- **A dedicated account's progress can fall silently.** Spending from it lowers the goal with no warning; that is the point of "the balance is the progress", and it is the trade-off ADR 0007 accepts.

---

## [1.0.2] - 2026-10-28

Tag `7fce57b`. Schema unchanged (3). Installers: `WageRoute-1.0.2-arm64.dmg`, `WageRoute-1.0.2.dmg`, `WageRoute.Setup.1.0.2.exe`.

### Added

- **Example backup** — `examples/backup.example.json`, a complete importable file (2 accounts, 2 bills, a sinking fund, one paycheck with 3 allocations, 4 ledger entries including a paired transfer, settings), validated against the real parser by `backup-example.test.ts` so the example cannot drift.
- **Erase all data** — Settings → Danger zone, guarded by two separate confirmations, returns the app to a blank first-run profile. Files already exported on disk are untouched.
- **Homebrew distribution** — the [`ReVax-2007/homebrew-wageroute`](https://github.com/ReVax-2007/homebrew-wageroute) cask installs the DMG against a pinned SHA-256, with the tap, `curl` and first-launch paths documented.

---

## [1.0.1] - 2026-10-28

Tag `c98fc5d`. Schema unchanged (3).

### Fixed

- **macOS Gatekeeper "damaged" error** — packaging re-signs the built app ad-hoc (`scripts/adhoc-sign.js`). The 1.0.0 DMGs carried an invalid code signature, which Gatekeeper reported as "WageRoute is damaged and can't be opened" on Apple Silicon; 1.0.1 passes `codesign --verify --deep --strict`.

### Changed

- **Packaged builds seed nothing.** First launch creates an empty profile and offers **Start from scratch** or **Import a backup**; the demo profile (Alex) is development-only (`npm run dev`).
- **No data-model or behaviour change** for existing users — databases and backups carry over as-is.

---

## [1.0.0] - 2026-10-28

Tag `ad56de9`. First stable release, schema 3, importer accepting backup versions 2–3.

### Added

- Priority Wall (weekly–yearly cadences, per-paycheck reserves, paused bills), the three-step paycheck allocator that splits the *surplus* rather than gross income, sinking funds with targets/deadlines/priorities, an emergency fund with an essentials-derived target.
- Accounts and credit tracking with derived balances and utilization, an editable ledger grid, a 90-day projection, round-up sweeps, paired transfers, past-due bill prompts.
- JSON backup/restore, transactions CSV export, additive and idempotent imports, dark/light/system themes.
- The documentation set: `docs/ARCHITECTURE.md`, `DATA-MODEL.md`, `FEATURES.md`, `IMPORT-EXPORT.md`, `DEPLOYMENT.md`, `DEVELOPMENT.md`, `RELEASING.md`, `SECURITY.md` and ADRs 0001–0005.
- Source-available licence, protected `main`, pull-request-only merges and `verify` CI.

[Unreleased]: https://github.com/ReVax-2007/wageroute/compare/v1.0.2...HEAD
[1.0.2]: https://github.com/ReVax-2007/wageroute/releases/tag/v1.0.2
[1.0.1]: https://github.com/ReVax-2007/wageroute/releases/tag/v1.0.1
[1.0.0]: https://github.com/ReVax-2007/wageroute/releases/tag/v1.0.0

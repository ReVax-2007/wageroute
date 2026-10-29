# Next release — everything queued

**This is the running list of what the next build contains.** It is not a changelog: [CHANGELOG.md](../CHANGELOG.md) records what landed after `v1.0.2`, this file records what has **not been shipped yet** and what has to happen when it is.

> **Accumulation rule.** Append to this file whenever work merges into `main` (or a branch is agreed for the release) and do **not** delete entries when they are merged — they are already released only once a tag and a build exist for them. Clear or replace this document **only** when told explicitly to tag, build, push and release. An AI doing a release should treat the version numbers, checksums and checklist below as the instruction set; nothing here authorises a release by itself.

---

## Target

| Field | Value |
| --- | --- |
| App version | **1.1.0** |
| Why not a patch | the queue adds database schema versions 4, 5 and 6, and [a schema change is always at least a minor bump](RELEASING.md#semver-policy) |
| Database schema | `6` (v4: `accounts.dedicated_goal_id`, `accounts.in_safe_to_spend`; v5: `bills.funding_strategy`, `bills.funding_paycheck_index`, `accounts.color`; v6: rebuilds `bills` to widen the `funding_strategy` CHECK to include `last_check`) |
| Backup format written | version `6` |
| Backup format accepted | `2`, `3`, `4`, `5`, `6` |
| Tag | `v1.1.0` (does not exist yet) |
| `package.json` today | still `1.0.2` — bump it **inside** the release branch, never before |

Everything below is merged into `main` but is in **no installer any user has**, except the schema-6 items in section 9, which are on `feat/last-check-pay-cycle-and-split-cap` until that pull request merges. The `v1.0.2` tag is at `7fce57b`; anything after it is unreleased. Schema 5 merged as PR #16 (`100bc65`); its section is kept for the release notes.

---

## In the release

### 1. Import wizard — `8b25329` (PR #12, [ADR 0006](decisions/0006-import-wizard-asks-instead-of-failing.md))

`data:preview` / `data:confirm` split with a single-use token, one question per unusable field, per-row fix-or-leave-out, unmapped CSV account names mapped in the wizard, rows the database still refuses reported per row instead of failing the file. Full behaviour in [IMPORT-EXPORT.md](IMPORT-EXPORT.md).

### 2. Backup importer defaults fix — `2024f7f` (PR #10)

A backup row that omitted a schema-defaulted column (`accounts.sort_order` and friends) inserted an explicit `NULL`, tripped `NOT NULL` and aborted the import with a raw `SqliteError`. Omitted keys now fall back to per-table schema defaults. `backup-merge.test.ts` covers it.

### 3. Corrected quarantine instructions — `4ac1f12` (PR #11)

`brew install --cask --no-quarantine` no longer prevents quarantine and a plain `xattr -dr` fails with `EPERM` because browser downloads also carry `com.apple.provenance`. The documented command is now `sudo xattr -rd com.apple.quarantine /Applications/WageRoute.app`, and the claim that Homebrew skips the first-launch prompt is gone — brew quarantines cask downloads; its value is the pinned checksum and easy upgrades.

### 4. Homebrew tap cross-link — `3d9ea02` (PR #9)

README names the [`homebrew-wageroute`](https://github.com/ReVax-2007/homebrew-wageroute) tap repository in both directions.

### 5. Dedicated accounts, safe-to-spend choice and total wealth — schema 4 ([ADR 0007](decisions/0007-dedicated-accounts-balance-is-progress.md))

An account can be bound to one sinking fund and its **balance is that goal's progress**; each account declares whether it counts as spendable; total wealth (cash + goal money + investments − credit owed) appears on the Overview, Accounts and sidebar. Safe to Spend is now measured against the spendable pool rather than all cash, and the deduction uses only goals whose money actually sits in that pool. A dedicated account's balance is already excluded from the pool, so deducting it again made the hero number negative. Detail in [CHANGELOG.md](../CHANGELOG.md#unreleased), [FEATURES.md](FEATURES.md) and [DATA-MODEL.md](DATA-MODEL.md).

Merged as PR #13 (`76283d4`) with 56 tests, a clean type-check, a green `verify` run and a production build. The dedicated-account and total-wealth surfaces were driven in a built app over CDP against a disposable profile; that walk caught and then confirmed the fix for a **−$3,000.00** Safe to Spend caused by deducting dedicated-goal money from the pool twice.

**The arm64 build is installed on the development machine and ran the migration against the real ledger.** Before installing, `wageroute.db` was snapshotted with `sqlite3 .backup` (schema 3, 11 accounts, 10 transactions, 2 goals, 3 bills, 17 settings); after first launch `user_version` was 4, both columns existed, every count was unchanged, `integrity_check` said `ok` and `foreign_key_check` was empty. The hero numbers then matched a SQL calculation of the documented rules on the same data — spendable pool $1,582.02, Priority Wall $462.69, pool-funded goals $0.00, Safe to Spend **$1,119.33**, total wealth **$4,751.93** splitting exactly into Cash $1,582.02 + Invested $3,679.66 − credit owed $509.75 — and Safe to Spend is the same number 1.0.2 showed, which is the "no existing row opts in, so nothing moves" claim tested rather than asserted. The bundle still reports `1.0.2` because the version bump happens on the release branch, so version alone cannot distinguish this build; the `release/` DMGs carry the same misleading name until 1.1.0 is cut.

See [CHANGELOG.md](../CHANGELOG.md#unreleased) for the full inventory, including the two-goal-totals change it forced.

### 6. Emergency fund pause and goal-owned funding accounts — `b864c75` (the first half of [ADR 0009](decisions/0009-the-goal-chooses-its-funding-accounts.md))

- The Emergency Card gained an **active** switch: paused shows **"Saving paused"** with a **"Resume saving"** action, and `commitPaycheck` drops the emergency goal before the allocator runs, so no *Route* button offers money that will not be routed and its share falls through to savings.
- The goal, not settings, now owns **which accounts fund it** — see section 7, which finishes that work and deletes the `emergencyAccountIds` key `b864c75` introduced.
- The original copy borrowed the wall's vocabulary ("Bill inactive" / "Resume bill") for a goal; the iteration in section 7 replaced it with "Saving paused" / "Resume saving".

### 7. Funding schedules, goal funding accounts and account colours — schema 5 — merged as PR #16 (`100bc65`) ([ADR 0008](decisions/0008-one-check-carries-the-month.md), [ADR 0009](decisions/0009-the-goal-chooses-its-funding-accounts.md))

Merged into `main`. Kept here because no installer contains it yet.

- **Four funding options per bill**, in the owner's order: *Closest to the due date*, *A specific paycheck*, *Reserve from all paychecks* (default), *First check of every month*. A single-check strategy reserves the **whole month's** obligation on one identified check and nothing on the others, so a month totals the same whichever option is chosen — asserted by `cadence.test.ts`. Slot maths is a calendar approximation (`CHECK_SLOT_ANCHORS`), clamped to slots that exist every month, and never reads the clock.
- **The goal picks its accounts, one or several**, through a **Funded by** dropdown or the **"Let several accounts add up together"** tick list; goal and binders commit in one transaction and a failure rolls back the whole save. `settings.emergencyAccountIds` is deleted.
- **Account colours**: eight swatches plus **Automatic colour**.
- **Schema 5** adds `bills.funding_strategy` (`NOT NULL DEFAULT 'all_checks'`), `bills.funding_paycheck_index` and `accounts.color`. The default is arithmetically identical to the pre-v5 spread, so an upgrade moves no number. `bills.funding_strategy` is also in `TABLE_DEFAULTS`, without which an older backup that omits it would insert `NULL` and trip `NOT NULL`.
- Verified so far: migration 4→5 against a **copy** of the live database (`user_version` 4→5, columns present, defaults applied, `integrity_check` ok, counts unchanged); `npm test` 68 tests across seven files; type-check clean; the built app driven over CDP for the four options, the derived hint, the wall's "Nth check only" row, the picker's dropdown/tick-list modes and the colour swatches.
- **The arm64 build is installed on the development machine and ran the migration against the real ledger (2026-10-29).** The previous bundle was moved, not deleted, to `.local-quarantine/2026-10-29-pre-v5/`, and `wageroute.db` was snapshotted first with `sqlite3 .backup` into `.local-backups/2026-10-29-pre-v5-install/` (schema 4, 12 accounts, 25 transactions, 3 goals, 4 bills, 19 settings, `integrity_check` ok). After first launch: `user_version` **5**, the three new columns present, all four bills on `funding_strategy = all_checks`, no account colours set, no `foreign_key_check` violations, and every count unchanged. The installed bundle still reports `1.0.2`, because the version bump happens on the release branch. The wall reads **$492.69** locked per month and **$227.40** reserved per paycheck (biweekly) on the live data, matching the pre-upgrade figures, which is the "no number moves" claim tested rather than asserted.

### 8. Queued, not merged: Linux and extra Windows formats — `2ef251f` (`origin/feat/linux-windows-installers`, no PR yet)

electron-builder additionally targets AppImage/deb/rpm for Linux x64 and arm64 and portable exe/zip for Windows, with two Ubuntu CI jobs and artifact names `wageroute-linux-x64/arm64`.

Decide **before** cutting 1.1.0: open the PR and land it, or hold it for 1.2.0. Holding it is the conservative choice — that branch has never had a green CI run, its artifacts have never been launched by anyone, and shipping a Linux format that does not start is worse than shipping none. If it is held, this section moves to a "deferred" list rather than being deleted.

### 9. Last check, pay-cycle settings and the 100% split cap — schema 6, on `feat/last-check-pay-cycle-and-split-cap` ([ADR 0011](decisions/0011-the-pay-cycle-is-a-setting.md))

Reaches `main` through a pull request. Bumps the schema and the backup format to 6.

- **"Last check of every month"** — a fifth funding option. It resolves to the last check the cadence is *guaranteed* to have (monthly 1, semimonthly 2, biweekly 2, weekly 4), so a biweekly month with a third check still funds on the second rather than leaving the bill unreserved in a two-check month. Listed fifth so the owner's original numbering is untouched.
- **Settings → Paycheck** — pay cadence, a free-text **Payday label** (`15th and last day`) and a **Default paycheck account**. The cadence was previously editable only inside the allocator's step 1; it is the same stored key. The label is display only and is never parsed into dates. The default account is preselect-only, with a fallback chain (`chosen → first non-archived checking → first non-archived`) so an archived pointer degrades instead of blocking a route.
- **Splits capped at 100%** — each of the four percentage rows caps at 100 minus the other three, so typing 100 into savings with debt at 90 snaps to 10. The allocator's largest-remainder scaling and the "Splits exceed 100%" guard remain for settings imported above 100.
- **Schema 6** rebuilds `bills` to widen the CHECK to include `last_check`. No column is added and no default changes, so an upgrade moves no number. It is the first rebuild on a table `transactions` references; it needs `PRAGMA legacy_alter_table = ON` plus suspended foreign keys, both set outside the transaction, and `migrate()` now runs `PRAGMA foreign_key_check` inside the transaction and rolls back on a violation. Recipe recorded in [DEVELOPMENT.md](DEVELOPMENT.md#sqlite-constraints).
- Verified: migration 5→6 against a **copy** of the live database (`user_version` 5→6, counts identical at 12 accounts / 4 bills / 3 goals / 25 transactions / 2 paychecks / 19 settings, `integrity_check` ok, `foreign_key_check` empty, pragmas restored, `transactions.bill_id` still `REFERENCES bills(id)`); `npm test` **73 tests across eight files** including the new `src/main/db/migrations.test.ts`; type-check and build clean; the built arm64 app driven over CDP for the Settings card and its round trip, the wall's payday hint, the five-option dialog, the `last_check` hint, the wall's "2nd check only" row, the allocator's default account and payday hint, and the split cap.
- The CDP walk caught a defect the tests did not: the repository's `BILL_FUNDING_STRATEGIES` allowlist had not been widened, so choosing "Last check of every month" closed the dialog and silently kept the old strategy. Fixed and re-verified (`Phone Bill` stored as `last_check`, row reading "2nd check only").
- **Not yet installed over the live app.** The schema-6 build was launched from `release/mac-arm64` against a disposable profile; the real `wageroute.db` has not been migrated to 6 yet, and the installed bundle still reports 1.0.2.

---

## Blockers before release

1. **The import wizard's rendered flow has never been opened.** Its detection and repair rules are tested as pure code, and the app itself is now drivable over CDP (see [DEVELOPMENT.md](DEVELOPMENT.md)), but the wizard begins with a native file picker that CDP cannot reach. Someone has to pick a real file and walk the questions by hand. The dedicated-accounts surfaces do not have this gap — they were verified that way, though no component test exists to keep them honest.
2. **The schema-6 branch has no pull request yet.** It must be committed, pushed, opened as a PR and merged before 1.1.0 can be cut.
3. **The schema-6 build has not been installed over the live app.** It ran against a disposable profile only. Whoever installs it should snapshot `wageroute.db` first, as was done for the 4→5 upgrade, and check that `user_version` reaches 6 with the counts unchanged.
4. **Decide the Linux/Windows-formats question** (section 8 above).

---

## Release checklist for 1.1.0

Standard procedure is [RELEASING.md](RELEASING.md). These are the items this release specifically adds or changes:

- [ ] `package.json` → `1.1.0` on a `release/1.1.0` branch.
- [ ] Move the `## [Unreleased]` block of [CHANGELOG.md](../CHANGELOG.md) under a `## [1.1.0] - <date>` heading and open an empty `Unreleased` section.
- [ ] Version sweep — these files currently describe 1.0.2 / schema 6 and must agree with the released build: [README.md](../README.md) header line and `curl` block, [DATA-MODEL.md](DATA-MODEL.md), [FEATURES.md](FEATURES.md), [SECURITY.md](SECURITY.md) (its `1.0.x` support table says "schemas 4, 5 and 6 arrive with the next release"), [DEPLOYMENT.md](DEPLOYMENT.md) artifact lists, [RELEASING.md](RELEASING.md) "current value" column, `docs/decisions/README.md`.
- [ ] Release notes must state: schema moves **3 → 4 → 5 → 6**, migration is automatic and forward-only, **there is no downgrade path**, and a backup exported from 1.1.0 cannot be imported by 1.0.2 or earlier.
- [ ] Add the "upgrading from 1.0.2" line: install over the top, data preserved, dedicated accounts and total wealth appear opt-in with existing numbers unchanged because no existing account opts in, every bill keeps the `all_checks` spread, and the new Paycheck settings start empty (no payday label, no default account), so the wall's numbers do not move until a strategy is chosen.
- [ ] Release notes must mention that migration 6 rebuilds `bills` (the only rebuild that touches a referenced table) and that it is covered by `migrations.test.ts`, including the rollback on a dangling reference.
- [ ] `SHA256SUMS.txt` for every installer.
- [ ] Homebrew cask in `ReVax-2007/homebrew-wageroute`: bump `version` **and** `sha256` for the arm64 DMG (Intel only if the tap carries it). No `--no-quarantine`; no `zap` stanza, by design.
- [ ] If Linux formats ship: document `AppImage`/`.deb`/`.rpm` install paths in DEPLOYMENT.md and the README, and record honestly whether anyone launched them.
- [ ] Tag `v1.1.0` after the release exists, then pull `main` locally and confirm the tag, `main`, `package.json` and the installed app all report `1.1.0`.
- [ ] After the release: reset this document to the new empty queue, and re-verify anything it claims.

---

## Compatibility notes to carry into the release

| Situation | What happens |
| --- | --- |
| 1.0.2 database opened by 1.1.0 | migrates 3→4→5→6 automatically; no row opts in, every bill lands on `all_checks`, so totals and wall figures are unchanged |
| 1.1.0 database opened by 1.0.2 | not supported — no downgrade path, do not do it |
| Backup exported by 1.1.0, imported by 1.0.2 | rejected (`version 6` > the app's `SCHEMA_VERSION`) |
| Backup exported by 1.1.0, imported by a schema-4 or schema-5 build | rejected (`version 6` > 4 / 5) |
| Backup exported by 1.0.2 (version 3), imported by 1.1.0 | accepted; the five new columns read their defaults (`NULL` = "no explicit choice", `funding_strategy` = `all_checks`) |
| Existing goal with allocation rows | keeps counting allocations until an account is bound to it; the goal screen's **Funded by** can bind it |
| Deleting a goal that owns an account | pointer nulled, the account survives and returns to the spendable pool |
| Archiving a dedicated account | progress falls back to allocation rows; the balance counts for nothing while archived |
| Existing bill after the upgrade | `funding_strategy = all_checks` — the old spread, unchanged until the bill is edited |
| Emergency fund paused | settings keep the flag; a fresh install defaults to active, and a version-5 backup without the key restores as active |
| Pay cycle, payday label, default account (new in v6) | settings rows, not columns: an upgraded database simply lacks them and reads the defaults (`biweekly`, no label, no default account → first checking) |
| Splits stored above 100% (imported or hand-edited) | the wizard still disables **Route** with "Splits exceed 100%"; the sliders cap at what the other three leave |

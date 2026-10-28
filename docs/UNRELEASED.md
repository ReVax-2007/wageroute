# Next release — everything queued

**This is the running list of what the next build contains.** It is not a changelog: [CHANGELOG.md](../CHANGELOG.md) records what landed after `v1.0.2`, this file records what has **not been shipped yet** and what has to happen when it is.

> **Accumulation rule.** Append to this file whenever work merges into `main` (or a branch is agreed for the release) and do **not** delete entries when they are merged — they are already released only once a tag and a build exist for them. Clear or replace this document **only** when told explicitly to tag, build, push and release. An AI doing a release should treat the version numbers, checksums and checklist below as the instruction set; nothing here authorises a release by itself.

---

## Target

| Field | Value |
| --- | --- |
| App version | **1.1.0** |
| Why not a patch | the queue adds database schema version 4, and [a schema change is always at least a minor bump](RELEASING.md#semver-policy) |
| Database schema | `4` (`accounts.dedicated_goal_id`, `accounts.in_safe_to_spend`) |
| Backup format written | version `4` |
| Backup format accepted | `2`, `3`, `4` |
| Tag | `v1.1.0` (does not exist yet) |
| `package.json` today | still `1.0.2` — bump it **inside** the release branch, never before |

Everything below is merged into `main` but is in **no installer any user has**. The `v1.0.2` tag is at `7fce57b`; anything after it is unreleased.

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

Committed on `feat/dedicated-accounts` (branched from `8b25329`, **no pull request yet**) with 56 tests, a clean type-check and a production build. The dedicated-account and total-wealth surfaces have been driven in a built app over CDP; that walk caught and then confirmed the fix for a **−$3,000.00** Safe to Spend caused by deducting dedicated-goal money from the pool twice. See [CHANGELOG.md](../CHANGELOG.md#unreleased) for the full inventory, including the two-goal-totals change it forced.

### 6. Queued, not merged: Linux and extra Windows formats — `2ef251f` (`origin/feat/linux-windows-installers`, no PR yet)

electron-builder additionally targets AppImage/deb/rpm for Linux x64 and arm64 and portable exe/zip for Windows, with two Ubuntu CI jobs and artifact names `wageroute-linux-x64/arm64`.

Decide **before** cutting 1.1.0: open the PR and land it, or hold it for 1.2.0. Holding it is the conservative choice — that branch has never had a green CI run, its artifacts have never been launched by anyone, and shipping a Linux format that does not start is worse than shipping none. If it is held, this section moves to a "deferred" list rather than being deleted.

---

## Blockers before release

1. **The import wizard's rendered flow has never been opened.** Its detection and repair rules are tested as pure code, and the app itself is now drivable over CDP (see [DEVELOPMENT.md](DEVELOPMENT.md)), but the wizard begins with a native file picker that CDP cannot reach. Someone has to pick a real file and walk the questions by hand. The dedicated-accounts surfaces do not have this gap — they were verified that way, though no component test exists to keep them honest.
2. **Decide the Linux/Windows-formats question** (item 6 above).
3. **Confirm the v3→v4 migration once more on the release branch** after merges, using a **copy** of a real database — the earlier check passed, but it ran against a branch state that has since gained commits.

---

## Release checklist for 1.1.0

Standard procedure is [RELEASING.md](RELEASING.md). These are the items this release specifically adds or changes:

- [ ] `package.json` → `1.1.0` on a `release/1.1.0` branch.
- [ ] Move the `## [Unreleased]` block of [CHANGELOG.md](../CHANGELOG.md) under a `## [1.1.0] - <date>` heading and open an empty `Unreleased` section.
- [ ] Version sweep — these files currently describe 1.0.2 / schema 4 and must agree with the released build: [README.md](../README.md) header line and `curl` block, [DATA-MODEL.md](DATA-MODEL.md), [FEATURES.md](FEATURES.md), [SECURITY.md](SECURITY.md) (its `1.0.x` support table says "schema 4 arrives with the next release"), [DEPLOYMENT.md](DEPLOYMENT.md) artifact lists, [RELEASING.md](RELEASING.md) "current value" column.
- [ ] Release notes must state: schema moves **3 → 4**, migration is automatic and forward-only, **there is no downgrade path**, and a backup exported from 1.1.0 cannot be imported by 1.0.2 or earlier.
- [ ] Add the "upgrading from 1.0.2" line: install over the top, data preserved, dedicated accounts and total wealth appear opt-in with existing numbers unchanged because no existing account opts in.
- [ ] `SHA256SUMS.txt` for every installer.
- [ ] Homebrew cask in `ReVax-2007/homebrew-wageroute`: bump `version` **and** `sha256` for the arm64 DMG (Intel only if the tap carries it). No `--no-quarantine`; no `zap` stanza, by design.
- [ ] If Linux formats ship: document `AppImage`/`.deb`/`.rpm` install paths in DEPLOYMENT.md and the README, and record honestly whether anyone launched them.
- [ ] Tag `v1.1.0` after the release exists, then pull `main` locally and confirm the tag, `main`, `package.json` and the installed app all report `1.1.0`.
- [ ] After the release: reset this document to the new empty queue, and re-verify anything it claims.

---

## Compatibility notes to carry into the release

| Situation | What happens |
| --- | --- |
| 1.0.2 database opened by 1.1.0 | migrates 3→4 automatically; no row opts in, so totals are unchanged |
| 1.1.0 database opened by 1.0.2 | not supported — no downgrade path, do not do it |
| Backup exported by 1.1.0, imported by 1.0.2 | rejected (`version 4` > the app's `SCHEMA_VERSION`) |
| Backup exported by 1.0.2 (version 3), imported by 1.1.0 | accepted; the two new account columns read `NULL` = "no explicit choice" |
| Existing goal with allocation rows | keeps counting allocations until an account is bound to it |
| Deleting a goal that owns an account | pointer nulled, the account survives and returns to the spendable pool |
| Archiving a dedicated account | progress falls back to allocation rows; the balance counts for nothing while archived |

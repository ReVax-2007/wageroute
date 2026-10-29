# Next release — everything queued

**This is the running list of what the next build contains.** It is not a changelog: [CHANGELOG.md](../CHANGELOG.md) records what shipped, this file records what has **not been shipped yet** and what has to happen when it is.

> **Accumulation rule.** Append to this file whenever work merges into `main` (or a branch is agreed for the release) and do **not** delete entries when they are merged — they are already released only once a tag and a build exist for them. Clear or replace this document **only** when told explicitly to tag, build, push and release. An AI doing a release should treat the version numbers, checksums and checklist below as the instruction set; nothing here authorises a release by itself.

---

## Last release

| Field | Value |
| --- | --- |
| Version | **1.1.0**, tagged `v1.1.0` at `fa40d74` and published 2026-10-29 |
| Release | <https://github.com/ReVax-2007/wageroute/releases/tag/v1.1.0> |
| Database schema | `6` — upgrades 3 → 4 → 5 → 6 on first launch, forward-only, no downgrade |
| Backup format | writes `6`, accepts `2`–`6` |
| Assets | `WageRoute-1.1.0-arm64.dmg`, `WageRoute-1.1.0.dmg` (Intel), `WageRoute.Setup.1.1.0.exe`, `SHA256SUMS.txt` |
| Homebrew | `ReVax-2007/homebrew-wageroute` at `1.1.0` (`7850918`) |
| Verification | arm64 build launched and migrated a **copy** of the live schema-5 database 5→6 with identical counts and unchanged wall figures ($492.69 / $227.40); Intel DMG and Windows installer never launched |

The `[1.1.0]` block in [CHANGELOG.md](../CHANGELOG.md) is the inventory; it is released now and is not repeated here.

---

## Target

| Field | Value |
| --- | --- |
| App version | **undecided** — no work is queued yet |
| Database schema | `6` (no migration queued) |
| Backup format written | `6` |
| Backup format accepted | `2`, `3`, `4`, `5`, `6` |
| `package.json` today | `1.1.0` — bump it **inside** the release branch, never before |

A patch is the default for fixes with no schema change; anything that adds a migration is at least a minor bump ([semver policy](RELEASING.md#semver-policy)).

---

## Queued

Nothing merged since `v1.1.0`.

---

## Deferred, not merged

### Linux and extra Windows formats — `2ef251f` (`origin/feat/linux-windows-installers`, no PR)

electron-builder additionally targets AppImage/deb/rpm for Linux x64 and arm64 and portable exe/zip for Windows, with two Ubuntu CI jobs and artifact names `wageroute-linux-x64/arm64`.

Held out of 1.1.0 on purpose: the branch has never had a green CI run and its artifacts have never been launched by anyone. Shipping a Linux format that does not start is worse than shipping none. Deciding this is still the owner's call — land it, or keep it deferred.

---

## Open gaps carried forward

1. **The import wizard's rendered flow has never been opened.** Its detection and repair rules are tested as pure code, but the wizard begins with a native file picker that CDP cannot reach. Someone has to pick a real file and walk the questions by hand.
2. **1.1.0 has not been installed over the live app.** `/Applications/WageRoute.app` is still the schema-5 build reporting 1.0.2, so the live `wageroute.db` is still schema 5; the 5→6 migration was checked against a copy. Installing migrates the live ledger irreversibly and needs a fresh `sqlite3 .backup` snapshot, the old bundle moved aside, and owner approval.
3. **Only the arm64 macOS installer has been launched.** The Intel DMG and the Windows installer have never been started.
4. **The builds are unsigned.** macOS is ad-hoc signed only, so downloaders need right-click → Open; Windows shows SmartScreen. Signing and notarization remain undone; see [RELEASING.md](RELEASING.md#code-signing-and-notarization).

---

## Release checklist for the next release

Standard procedure is [RELEASING.md](RELEASING.md). These are the items that stay specific to this project:

- [ ] `package.json` → the target version on a `release/<version>` branch, via `npm version <version> --no-git-tag-version`.
- [ ] Move the `## [Unreleased]` block of [CHANGELOG.md](../CHANGELOG.md) under a `## [<version>] - <date>` heading and open an empty `Unreleased` section; update the `compare` and release links.
- [ ] Version sweep: [README.md](../README.md) header line, `curl` block and Homebrew line; [DATA-MODEL.md](DATA-MODEL.md); [FEATURES.md](FEATURES.md); [SECURITY.md](SECURITY.md) support table; [RELEASING.md](RELEASING.md) "current value" column; [DEPLOYMENT.md](DEPLOYMENT.md) artifact lists.
- [ ] If a migration ships: prove it against a **copy** of the live database, state in the notes that it is automatic, forward-only and irreversible, and record the new backup window.
- [ ] `npm ci` from a clean tree, `npm test`, `npm run typecheck`, `npm run build`, `npm run dist:<platform>`.
- [ ] Launch the packaged artifact on a disposable profile (`CFFIXED_USER_HOME=/tmp/...`), not on the live ledger.
- [ ] `SHA256SUMS.txt` for every installer, named exactly as GitHub publishes it (spaces in `WageRoute Setup <version>.exe` become dots).
- [ ] Tag `v<version>`, let CI build the Windows installer, then create the GitHub Release with the raw installers.
- [ ] Bump `version` **and** every `sha256` in `ReVax-2007/homebrew-wageroute`; no `--no-quarantine`, no `zap` stanza.
- [ ] After the release: reset this document, and re-verify anything it claims.

---

## Compatibility notes to carry forward

| Situation | What happens |
| --- | --- |
| 1.0.2 database opened by 1.1.0 | migrates 3→4→5→6 automatically; no row opts in, every bill lands on `all_checks`, so totals and wall figures are unchanged |
| 1.1.0 database opened by 1.0.2 or earlier | not supported — no downgrade path, do not do it |
| Backup exported by 1.1.0, imported by 1.0.2 | rejected (`version 6` > the app's `SCHEMA_VERSION`) |
| Backup exported by 1.0.2 (version 3), imported by 1.1.0 | accepted; the new columns read their defaults (`NULL` = "no explicit choice", `funding_strategy` = `all_checks`) |
| Existing goal with allocation rows | keeps counting allocations until an account is bound to it; the goal screen's **Funded by** can bind it |
| Deleting a goal that owns an account | pointer nulled, the account survives and returns to the spendable pool |
| Archiving a dedicated account | progress falls back to allocation rows; the balance counts for nothing while archived |
| Emergency fund paused | settings keep the flag; a fresh install defaults to active, and a backup without the key restores as active |
| Pay cycle, payday label, default account | settings rows, not columns: a database from 1.0.2 simply lacks them and reads the defaults (`biweekly`, no label, no default account → first checking) |
| Splits stored above 100% (imported or hand-edited) | the wizard still disables **Route** with "Splits exceed 100%"; the sliders cap at what the other three leave |

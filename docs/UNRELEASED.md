# Next release — everything queued

**This is the running list of what the next build contains.** It is not a changelog: [CHANGELOG.md](../CHANGELOG.md) records what shipped, this file records what has **not** been shipped yet and what has to happen when it is.

> **Accumulation rule.** Append to this file whenever work merges into `main` (or a branch is agreed for the release) and do **not** delete entries when they are merged — they are already released only once a tag and a build exist for them. Clear or replace this document **only** when told explicitly to tag, build, push and release. An AI doing a release should treat the version numbers, checksums and checklist below as the instruction set; nothing here authorises a release by itself.

---

## Last release

| Field | Value |
| --- | --- |
| Version | **1.2.0**, tagged `v1.2.0` at `50cab8e` and published 2026-11-02 |
| Release | <https://github.com/ReVax-2007/wageroute/releases/tag/v1.2.0> |
| Database schema | `8` — upgrades 3 → 4 → 5 → 6 → 7 → 8 on first launch, forward-only, no downgrade |
| Backup format | writes `8`, accepts `2`–`8` |
| Assets | `WageRoute-1.2.0-arm64.dmg`, `WageRoute-1.2.0-x64.dmg`, `WageRoute.Setup.1.2.0.exe`, `WageRoute-1.2.0.portable.exe`, `WageRoute-1.2.0-{x64,arm64}.{msi,zip}`, `WageRoute-1.2.0-{x86_64,aarch64}.rpm`, `WageRoute-1.2.0-{amd64,arm64}.deb`, `WageRoute-1.2.0-{x86_64,arm64}.AppImage`, `SHA256SUMS` |
| Homebrew | `ReVax-2007/homebrew-wageroute` at `1.2.0` (`0e10e3b`), Intel URL now `WageRoute-#{version}-x64.dmg` |
| Verification | The **CI-built** arm64 DMG was downloaded from the published release, its SHA-256 checked against `SHA256SUMS`, then mounted and launched on a disposable profile: blank schema-8 ledger, sidebar `WageRoute v1.2.0`, licence and third-party notices bundled, ad-hoc signature valid. The same bundle opened a **copy** of the live schema-6 database: `user_version` 6 → 8, all 25 original transactions unchanged, 12 accounts / 4 bills / 3 goals / 2 paychecks intact, 3 dead draft settings removed, 22 categories and 12 balance snapshots backfilled, and the migrated ledger rendered on the dashboard. CI installed, launched, reinstalled over itself and uninstalled the MSI, and booted the AppImage and deb under xvfb. All four platform builds green; the release carries a `SHA256SUMS` that lists every asset except itself. **Not hand-launched:** the Intel DMG, NSIS, portable, zip, MSI and Linux packages; no screen-reader pass; unsigned and not notarized |

Two tags were replaced before publication, and nothing was ever distributed from the failed ones: the first `v1.2.0` build stopped in NSIS because `installerIcon` pointed at a PNG (`invalid icon file`), and the second built every platform but its tag-only release job ran `gh` without a checkout and hashed its own `SHA256SUMS`. Both fixes are in the tagged tree (`#45`, `#46`).

The `[1.2.0]` block in [CHANGELOG.md](../CHANGELOG.md) is the inventory; it is released now and is not repeated here.

---

## Target

| Field | Value |
| --- | --- |
| App version | `1.2.0` — no next version chosen; `package.json` stays `1.2.0` until the next bump |
| Database schema | `8`, forward-only; any new migration makes the next release at least a minor bump |
| Backup format | writes `8`, accepts `2`–`8` until a schema change says otherwise |
| CI gates | `npm run lint`, `npm test`, `npm run build` and both type checks on every pull request; a tag builds all four platforms and creates a **draft** release with `SHA256SUMS` |
| macOS signing | ad-hoc only; no notarization, so Gatekeeper still needs **Open Anyway** or a locally copied DMG |

---

## Queued

Work merged to `main` after `v1.2.0`. None of it is in an installer yet; the `[Unreleased]` block in [CHANGELOG.md](../CHANGELOG.md) is the readable inventory.

### Batch 17 — correctness

- Category lookup and text backfill compare the JS `categoryKey` instead of SQL `lower()`, so `CAFÉ` and `Café` no longer create two rows or split a report total.
- `settleEarlierBillReserves()` closes an earlier month's `reserved` claim when the bill is paid in a later month, while leaving each row in its own cycle.
- The goal funding-account picker follows the saved goal until touched (`draftIds`), and its **Select all** state is derived from the live list.
- A failed entry count no longer leaves the delete-account dialog disabled; negative credit limits and statement balances now show a field error; a dialog whose trigger is gone returns focus to `#main-content`.
- `needsPreUpgradeBackup()` limits `pre-upgrade-*` copies to real version increases.

### Batch 18 — release integrity and security

- New tag-only `guard` job: the tag must equal `package.json`'s version and sit on `origin/main`.
- The `release` job refuses to replace assets on an already-published release.
- `setWindowOpenHandler` opens only `https://buymeacoffee.com/revax`; `will-navigate` and `isTrustedFrame()` share `isTrustedPageUrl()`; `setPermissionCheckHandler` denies alongside the request handler.

### Batch 19 — coverage

- `src/main/window-security.test.ts` (3), `src/renderer/src/lib/finance.test.ts` (8), plus 24 cases across six existing files. `npm test` is **299 tests across thirty-seven files**.
- `package.json`'s explicit test list includes both new files; the `pretest` guard would otherwise fail every run.

### Batch 20 — documentation

- Corrected the error-notice/logging claims, the `dist:linux` architecture claim and the broken table in DEPLOYMENT, the missing `npm run lint` in CONTRIBUTING/README/PR template, the draft-release and blockmap claims in RELEASING, the in-app erase path, the migration history, and the ten-table backup count in ADR 0003.
- Updated ARCHITECTURE, SECURITY and FEATURES to describe the new allowlist and permission check.

### Before the next build

- [ ] Run the four gates on the final tree: `npm run lint`, `npm test`, `npm run build` (includes both type checks), and `npx electron-builder --dir --publish never`.
- [ ] Launch a packaged build on a disposable profile and confirm the Buy Me a Coffee link still opens and no other external URL does (no child window, no navigation).
- [ ] Re-check the Priority Wall after a cross-month bill payment: the old month's row reads `paid`, not `reserved`.
- [ ] Confirm the tag guard fires if `package.json` and the tag disagree (a scratch tag, deleted before push).
- [ ] Choose the next version. No migration was added in this batch, so a patch bump is still defensible; the tag guard requires the tag to match `package.json`.

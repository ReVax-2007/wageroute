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

**Nothing is queued.** Nothing has merged since `v1.2.0`. Append work here as it lands; do not clear or replace this file until explicitly told to tag, build and publish the next release.

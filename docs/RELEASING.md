# Releasing WageRoute

A WageRoute release is a **verified build of the desktop app plus a deliberate distribution step**. There is no server to deploy, no migration to run remotely and no publish automation. The hard parts are data compatibility, native modules and the fact that the installers are currently unsigned.

This document is the operational manual: what the version numbers mean, how to build, what CI does, what is missing before public distribution, and how to roll back without losing a ledger.

---

## Contents

- [Version model](#version-model)
- [Compatibility guarantees](#compatibility-guarantees)
- [Preflight checklist](#preflight-checklist)
- [Local build](#local-build)
- [What the build produces](#what-the-build-produces)
- [CI pipeline](#ci-pipeline)
- [Code signing and notarization](#code-signing-and-notarization)
- [Manual release procedure](#manual-release-procedure)
- [Publishing a GitHub Release](#publishing-a-github-release)
- [Version bump procedure](#version-bump-procedure)
- [Rollback](#rollback)
- [Hotfixes](#hotfixes)
- [Release notes template](#release-notes-template)
- [Release checklist](#release-checklist)
- [Known gaps](#known-gaps)

---

## Version model

WageRoute has three independent version numbers. Confusing them is the most common release mistake.

| Version | Where it lives | Current value | What it means |
| --- | --- | --- | --- |
| App version | `package.json` → `version` | `1.1.0` | The build users install. Drives installer names, macOS bundle version and release tags. |
| Database schema version | `src/main/db/migrations.ts` → `SCHEMA_VERSION`, stored in SQLite `PRAGMA user_version` | `6` | The shape of the on-disk database. Changes only when a migration is added. |
| Backup format version | Written into every JSON backup, equal to `SCHEMA_VERSION` | `6` | The newest backup the app writes. The reader accepts versions `2`, `3`, `4`, `5` and `6`. |

`package.json` reads `1.1.0` at the moment of the 1.1.0 release; between releases it keeps the last released number even though newer commits have landed, so the **commit SHA** is the only reliable identifier of an un-released build. Bump the version as part of the release, never before. Every build users had before 1.1.0 was schema 3; 1.1.0 is the first installer carrying schemas 4, 5 and 6.

The source of truth for the app version is `package.json`. `npm` updates `package-lock.json` with it; electron-builder reads it when naming artifacts and writing bundle metadata.

### SemVer policy

The data model and UI are declared stable as of 1.0.0:

- **Patch** (`1.0.0` → `1.0.1`) — bug fixes, copy changes, dependency patches, no schema change, no intentional behaviour break.
- **Minor** (`1.0.0` → `1.1.0`) — new features, new settings, new screens, **or any schema migration**. A schema change is always at least a minor bump, even if the feature is small.
- **Major** (`2.0.0`) — a stability break: schema changes that cannot be migrated forward, or removal of documented behaviour. A major bump requires a documented migration path.

Tags use the `v` prefix and match the app version exactly: `v1.0.0`. The CI workflow triggers on `v*`, so a typo such as `0.1.0` will build nothing.

### What is not versioned

- The backup format's internal marker remains `cash-flow-routing-backup` for compatibility with files produced before the rename. **Do not "fix" this string**; changing it would reject every existing backup.
- The `appId` (`com.wageroute.desktop`) and `productName` (`WageRoute`) are identity, not version. Changing either changes install paths and can orphan user data.
- Electron's version is pinned by `package-lock.json`. Upgrading Electron's major version changes the native-module ABI and is effectively a platform change; treat it as a feature release with a full installer test.

---

## Compatibility guarantees

### Database

- Migrations are **forward-only and append-only**. `migrate()` runs every migration whose version is greater than `PRAGMA user_version`, each inside a transaction, then advances `user_version`.
- Opening an older database upgrades it in place. There is no automatic downgrade.
- The app **refuses a database whose `user_version` is newer than the app's `SCHEMA_VERSION`**. `migrate()` raises `SchemaTooNewError` before any window opens; the main process names the problem and quits without writing to the file. Never open a newer database with an older build anyway — the guard protects the file, not your expectations.
- Schema changes must preserve existing rows unless the migration explicitly rebuilds a table, as the v2 rebuild did. Every migration must be tested against a copy of the previous schema with realistic data.

### Backups

| File version | Behaviour |
| --- | --- |
| `1` or missing | Rejected: `Backups older than schema 2 are not supported` |
| `2` | Accepted; missing columns receive documented defaults |
| `3` | Accepted |
| `4` | Accepted; `accounts.color`, `funding_strategy` and `funding_paycheck_index` receive defaults |
| `5` | Accepted; version 6 added no column |
| `6` | Accepted; no `bill_reserves` rows |
| `7` | Accepted; the newest format this app writes |
| `> 7` | Rejected: `This backup came from a newer version` |

Imports are additive and idempotent. Re-importing the same file skips rows that already exist by UUID. See [IMPORT-EXPORT.md](IMPORT-EXPORT.md).

A release that raises `SCHEMA_VERSION` must also decide whether the new backup shape is backward-compatible with the previous app version. The default answer is **no**: backups written by a newer app are not readable by an older app.

### Application

There is no auto-update, so "compatibility" means the new installer can open the existing database and the old installer can still be reinstalled if the new one is rejected. The second half is only true before a migration runs. Back up before every upgrade.

---

## Preflight checklist

Run this before building anything you intend to distribute. It is intentionally redundant with CI: CI checks types and tests, not whether the app is usable or correctly branded.

### Source and metadata

- [ ] Working tree is clean, or you know exactly which uncommitted changes are in the build.
- [ ] `package.json` version is the intended release version.
- [ ] `package-lock.json` was updated by the same version change.
- [ ] `productName`, `appId`, shortcut name and icon paths in `electron-builder.yml` are unchanged unless the rename is intentional.
- [ ] `build/icon.icns`, `build/icon.png` and the iconset exist and are current.
- [ ] No database, backup, exported CSV, `.env` or credential file is staged or inside the source tree.
- [ ] The backup format marker was not changed.
- [ ] `SCHEMA_VERSION` matches the latest migration entry.

### Verification

- [ ] `npm ci` from a clean `node_modules` (not `npm install`).
- [ ] `npm test` passes.
- [ ] `npm run typecheck` passes for both TypeScript projects.
- [ ] `npm run build` succeeds.
- [ ] The app boots with a throwaway profile.
- [ ] The golden paths were exercised manually (see [DEVELOPMENT.md](DEVELOPMENT.md#known-test-gaps)).
- [ ] A JSON export from the previous build imports into the new build on a fresh profile.
- [ ] A database created by the previous schema version migrates when opened by the new build, using a **copy**.
- [ ] Account balances, recent transactions and settings survive the migration.

### Packaging

- [ ] The previous output in `release/` has been moved aside so no stale installer is mistaken for this build.
- [ ] The built app launches from the packaged artifact, not just from `npm run dev`.
- [ ] The packaged app opens the expected database path.
- [ ] The version shown in the installer and app metadata matches `package.json`.

> **Stale artifacts:** `release/` is overwritten by every local build and is never cleaned automatically. Before packaging a release, move the whole folder aside (the 1.1.0 build used `.local-quarantine/2026-10-29-pre-1.1.0-release/`) so an older DMG cannot be uploaded under the new name.

---

## Local build

### Prerequisites

- Node.js **22 or newer** (`engines.node`). CI uses Node 24.
- npm with a working lockfile.
- Platform build tools for the native module:
  - macOS: Xcode Command Line Tools;
  - Windows: Visual Studio Build Tools with the C++ workload and Python;
  - Linux: `build-essential`, `python3`, `make`, `g++`.
- Enough disk for Electron, the unpacked app and installers (roughly 1–2 GB per platform).

`npm ci` runs `postinstall`, which is `electron-builder install-app-deps`. That rebuilds `better-sqlite3` against the installed Electron ABI. Skipping it produces `NODE_MODULE_VERSION` errors at launch.

### Commands

```bash
npm ci                      # exact dependency tree + native rebuild
npm test                    # shared domain tests
npm run typecheck           # node + web projects
npm run build               # typecheck, then electron-vite build into out/

npm run dist:mac            # build + DMG
npm run dist:win            # build + NSIS installer
npm run dist:linux          # build + AppImage, deb and rpm
npm run dist                # build + installers for the current platform
```

`npm run dist:*` runs `npm run build` first, so a type error stops the release.

### Script reference

| Script | Effect |
| --- | --- |
| `dev` | electron-vite dev server with HMR |
| `start` | preview the production build |
| `test` | `node --import tsx --test` over the eighteen test files listed in `package.json` |
| `typecheck:node` | main, preload, shared, config |
| `typecheck:web` | renderer and shared |
| `typecheck` | both projects |
| `build` | typecheck, then bundle main/preload/renderer into `out/` |
| `dist` | build, then electron-builder for the host platform |
| `dist:mac` | build, then macOS DMG |
| `dist:win` | build, then Windows NSIS, portable and zip |
| `dist:linux` | build, then Linux AppImage, deb and rpm |
| `postinstall` | rebuild native modules for Electron |

### Cross-platform builds

Build each installer on the platform it targets, or let CI do it.

- **macOS** — build on macOS. Producing both arm64 and x64 from an Apple Silicon machine requires the x64 native `better-sqlite3` binary; the config requests both architectures, but a build succeeding is not proof the x64 app launches. Verify on an Intel Mac or an x64 VM before shipping both.
- **Windows** — build on Windows. electron-builder can sometimes cross-build NSIS from macOS with Wine, but that path is not supported by this project and is not tested.
- **Linux** — build on Linux (CI uses Ubuntu). The AppImage, deb and rpm targets each download their own tooling (appimagetool, fpm) on demand; the Ubuntu runners already have the C toolchain better-sqlite3 needs. Cross-building Linux installers from macOS or Windows is not supported and not tested.

### Isolated test profile

Never test a release against the real ledger. On macOS, relocate Electron's application-data home:

```bash
CFFIXED_USER_HOME=/tmp/wageroute-release-test npm run dev
```

For the packaged app, launch it with the same environment variable if needed, or test on a clean user account or VM. Confirm the path shown in Settings before creating data.

### Why `npm ci` matters

`better-sqlite3` is a native module. It is compiled for one Electron ABI and one CPU architecture. The failure modes are:

- compiled for Node instead of Electron → `NODE_MODULE_VERSION` mismatch;
- compiled for arm64 and shipped in an x64 build → module load failure;
- `npm install` resolving a different tree than CI → a build that works locally and fails in CI.

`npm ci` plus `postinstall` is the supported path.

---

## What the build produces

### Intermediate output

`electron-vite build` writes `out/`:

```text
out/
├── main/index.js        main process
├── preload/index.js     context bridge
└── renderer/            HTML, CSS, JS assets
```

`out/` is gitignored. It is not a release artifact; it is input to electron-builder.

### Installers

`electron-builder` writes to `release/` (gitignored).

**macOS** — `mac.target` requests `dmg` for `arm64` and `x64`:

```text
release/
├── WageRoute-1.1.0-arm64.dmg
├── WageRoute-1.1.0-arm64.dmg.blockmap
├── WageRoute-1.1.0-x64.dmg
├── WageRoute-1.1.0-x64.dmg.blockmap
├── mac-arm64/WageRoute.app
└── mac/WageRoute.app            # when an x64 build runs
```

The names are pinned by `dmg.artifactName` in `electron-builder.yml` (`WageRoute-${version}-${arch}.dmg`), so both architectures carry their suffix and a release note can name an asset exactly. The `.blockmap` files are useful only to an auto-updater; there is none today.

**Windows** — `win.target` requests `nsis`, `msi`, `portable` and `zip` for `x64` and `arm64`:

```text
release/
├── WageRoute.Setup.1.2.0-x64.exe
├── WageRoute.Setup.1.2.0-x64.exe.blockmap
├── WageRoute-1.2.0-x64.msi
├── WageRoute-1.2.0-arm64.msi
├── WageRoute-1.2.0-x64.portable.exe
├── WageRoute-1.2.0-arm64.portable.exe
├── WageRoute-1.2.0-x64.zip
└── WageRoute-1.2.0-arm64.zip
```

`nsis.artifactName`, `msi.artifactName` and `portable.artifactName` pin predictable names instead of electron-builder's defaults, which contain spaces and drop a suffix. The zip target has no config block of its own, so it inherits the shared pattern through `win` — which is why `msi.artifactName` ends in `${ext}` rather than a literal `.msi`. With a literal `.msi` the zip target named itself `…-x64.msi` and 7-Zip failed with `System ERROR: The parameter is incorrect`, because a zip archive cannot be written under an `.msi` extension. `${ext}` resolves to `msi` for the MSI and `zip` for the archive.

NSIS is configured as a per-user install (`perMachine: false`), not one-click, with a selectable directory and a desktop shortcut. Per-user installs do not require administrator rights and put the app under the user's profile. The portable and zip targets exist for users who cannot run installers (locked-down machines, no admin). All four Windows formats are unsigned, so SmartScreen treats them the same way.

The MSI is built by electron-builder's WiX target, and WiX only runs on Windows — a macOS or Linux checkout cannot produce it. It installs per-user into `%LOCALAPPDATA%\Programs\WageRoute`, so `msiexec /i WageRoute-<version>-x64.msi /qn` works without elevation and is suitable for Intune, SCCM or Group Policy. Because WiX 4 has no arm64 architecture, the `-arm64` MSI is an x64 package that installs the arm64 app; Windows on ARM runs it without a prompt.

The MSI and the NSIS installer are separate products with separate uninstall entries. Installing one over the other leaves two entries in **Apps & features**; tell users to uninstall the old one first. The CI job reinstalls the MSI to prove an upgrade stays a single entry.

**Linux** — `linux.target` requests `AppImage`, `deb` and `rpm` for `x64` and `arm64`:

```text
release/
├── WageRoute-1.2.0-x86_64.AppImage
├── WageRoute-1.2.0-arm64.AppImage
├── WageRoute-1.2.0-amd64.deb
├── WageRoute-1.2.0-arm64.deb
├── WageRoute-1.2.0-x86_64.rpm
└── WageRoute-1.2.0-aarch64.rpm
```

`appImage.artifactName`, `deb.artifactName` and `rpm.artifactName` pin one pattern for all three packagers, but `${arch}` expands to each packager's own architecture name, not `x64`: AppImage and rpm call 64-bit Intel `x86_64`, deb calls it `amd64`, and only the arm64 AppImage and deb keep the literal `arm64` (the arm64 rpm says `aarch64`). That is electron-builder's naming, not a choice of ours, and it is why the CI smoke test selects `release/*.AppImage` and `release/*.deb` by format and asserts exactly one of each rather than matching a suffix. AppImage runs on any distro without root; deb and rpm integrate with the system package manager and desktop menu. All three are unsigned, so some distros warn during install.

### Bundle contents

`files` includes only `out/**/*` and `package.json`, minus source maps. `asarUnpack` extracts `**/*.node`, so the native SQLite binary sits outside the asar archive where it can be loaded. `npmRebuild: true` rebuilds native modules during packaging. `extraResources` copies `LICENSE` beside the app so the licence ships with the bundle.

No database is bundled. On first launch the app seeds one blank local user with default settings if no user row exists, and the dashboard offers a start-from-scratch or import-a-backup path. The demo profile (Alex) is seeded only in development builds (`app.isPackaged` false); it is **not** a release asset.

---

## CI pipeline

The workflow lives in [`.github/workflows/build.yml`](../.github/workflows/build.yml).

### Triggers

```yaml
on:
  workflow_dispatch:
  push:
    tags:
      - 'v*'
```

- **Manual** — run from the Actions tab, any branch.
- **Tag push** — a tag beginning with `v` (for example `v1.0.0`).

A normal branch push does **not** build installers. That is deliberate: packaging is slow and the artifacts are unsigned.

### Matrix

| Runner | Arch flag | Uploaded artifact | File pattern |
| --- | --- | --- | --- |
| `macos-latest` | `--mac --x64 --arm64` | `wageroute-mac` | `release/*.dmg` |
| `windows-latest` | `--win --x64 --arm64` | `wageroute-win` | `release/*.exe`, `release/*.zip`, `release/*.msi` |
| `ubuntu-latest` | `--linux --x64` | `wageroute-linux-x64` | `release/*.AppImage`, `release/*.deb`, `release/*.rpm` |
| `ubuntu-24.04-arm` | `--linux --arm64` | `wageroute-linux-arm64` | `release/*.AppImage`, `release/*.deb`, `release/*.rpm` |

Each Linux job passes one architecture flag, so a native runner never has to cross-compile `better-sqlite3`. macOS and Windows build both architectures on one runner because their prebuilt native binaries are available for both.

Architectures are passed on the command line, never as `arch` lists inside `electron-builder.yml`. electron-builder merges a target's declared arches into whatever the CLI asks for, so `--linux --x64` against a config that lists `arm64` still emits arm64 artifacts — which is how the first run of this workflow produced an x64 job holding an arm64 AppImage.

`fail-fast: false` means a macOS failure does not cancel the Windows build, so you can see both results.

### Steps

1. `actions/checkout@v4`
2. `actions/setup-node@v4` with Node **24** and npm cache
3. `npm ci`
4. `npm test`
5. `npm run build` (typecheck and production bundles)
6. `npx electron-builder <arch flag> --publish never`
7. Platform smoke test — see below
8. `actions/upload-artifact@v4` with `if-no-files-found: error`
9. On a tag push only: create a **draft** release if none exists and attach the raw installers with `gh release upload --clobber`

### Smoke tests

The tests and type checks prove the code; these steps prove the artifacts.

- **Windows** — silent-installs the x64 MSI with `msiexec /i … /qn`, checks the executable landed under `%LOCALAPPDATA%\Programs\WageRoute`, launches it and waits for `%APPDATA%\WageRoute\wageroute.db` to appear. The database is opened during boot before the window is shown, so its presence proves the packaged binary really started. It then reinstalls the same MSI and asserts exactly one **Apps & features** entry, and uninstalls and asserts the executable and install directory are gone. The ledger in `%APPDATA%` is left behind on purpose — uninstalling must not destroy a user's data.
- **Linux x64 and arm64** — runs the AppImage (`APPIMAGE_EXTRACT_AND_RUN=1`, no FUSE needed) under `xvfb-run` with a throwaway `HOME`, then extracts the deb and runs the packaged binary the same way. Each must create `~/.config/WageRoute/wageroute.db` within two minutes. If it does not, the step prints the app's own log from that profile before failing — on a headless runner a boot error is otherwise invisible. The step asserts that exactly one `*.AppImage` and one `*.deb` exist, so a job that quietly built the other architecture fails instead of running the wrong binary.
- **macOS** — no automated launch. The DMG is verified by hand on the release machine; see the checklist below.

The rpm is built but not launched, because `rpm2cpio` is not installed on the runner and the payload is the same binary as the deb.

### What CI does not do

- It does not lint. There is no linter configured.
- It does not launch the macOS app. The Windows MSI and the Linux AppImage and deb are launched; the DMG is not, because the runner has no display session the app will accept.
- It does not test the NSIS installer, the portable exe, the zip or the rpm at run time. They share the packaged payload with the MSI or the deb.
- It does not create a tag or write release notes. On a tag push it attaches files to a **draft** release; publishing stays manual.
- It does not sign with a real identity or notarize. macOS artifacts get an ad-hoc signature from the afterSign hook; Windows and Linux artifacts are unsigned.
- It does not compute checksums.
- It does not publish anywhere. `npm run dist:*` passes `--publish never`, because electron-builder treats a tag build as an implicit publish request and fails when `GH_TOKEN` is absent. Artifacts expire according to the repository's retention setting (GitHub's default is 90 days).
- It does not pin actions to commit SHAs; the major tags are mutable. See [SECURITY.md](SECURITY.md#supply-chain).

Artifacts are downloaded from the workflow run page. They are zip files containing the installer, and may lose the executable bit or macOS metadata depending on the download path. For distribution, publish the raw installer files rather than the artifact zip.

---

## Code signing and notarization

**Current state: ad-hoc macOS signature only.** Every macOS build is explicitly re-signed ad-hoc by `scripts/adhoc-sign.js` (electron-builder `afterSign` hook, driven by `identity: null` in `electron-builder.yml`). There is no certificate, notarization step, entitlements file or signing secret.

### macOS

An unsigned or ad-hoc-signed app downloaded from the internet receives the `com.apple.quarantine` attribute. Gatekeeper then refuses the normal launch path. Without an Apple Developer ID, users see one of:

- “WageRoute cannot be opened because the developer cannot be verified.”
- “WageRoute is damaged and can’t be opened” when the signature is missing or invalid on Apple Silicon.
- On recent macOS (15+), a plain double-click of a downloaded copy shows only **Move to Trash / Done** with no Open button.

Practical workarounds, in order of convenience:

1. **Right-click the app → Open → Open.** The shortcut-menu launch presents a dialog with an actual **Open** button; no trip to System Settings is needed. After the first approval, the app opens normally.
2. System Settings → Privacy & Security → **Open Anyway** (fallback when the right-click dialog is not offered).
3. Install via **Homebrew** (`brew install --cask ReVax-2007/wageroute/wageroute`) or **curl** — see [DEPLOYMENT.md](DEPLOYMENT.md#homebrew-tap). A curl download carries no quarantine attribute, so Gatekeeper never checks it. Homebrew does quarantine, so its first launch still needs option 1 unless you clear the flag with option 4.
4. `sudo xattr -rd com.apple.quarantine /Applications/WageRoute.app` (only for a build you trust; it removes a real protection). This needs your password. Without `sudo` the same command fails with EPERM on browser-downloaded apps, which also carry the `com.apple.provenance` attribute; prefer options 1–3.

Apple Silicon requires at least an ad-hoc signature for the executable to run, and an *invalid* signature produces the "damaged" dialog rather than the "cannot be verified" one. electron-builder's default no-identity path leaves the bundle with a broken signature, which is why the build re-signs it explicitly with `codesign --force --deep --sign -` in the afterSign hook, then runs `codesign --verify --strict` on the bundle so a failed signature fails the build instead of shipping. (`spctl --assess` is not used: it rejects ad-hoc signatures by design.) The hook runs **after** electron-builder applies the electron fuses: flipping a fuse rewrites the binary and invalidates any signature made before it, so a hook on `afterPack` would leave the shipped bundle invalid. Ad-hoc is not notarization and does not satisfy Gatekeeper for downloaded copies. Verify the artifact on a clean machine rather than assuming a local launch proves it will open elsewhere.

To ship properly you need:

- an Apple Developer Program membership;
- a **Developer ID Application** certificate;
- a hardened-runtime build with entitlements that allow Electron's JIT and the native module to load;
- notarization via `notarytool` (electron-builder's `notarize` configuration or an after-sign hook);
- stapling the notarization ticket to the DMG/app.

Secrets belong in CI secret storage (`CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`), never in the repository. Signing also changes the build pipeline and must be tested end to end; it is not a checkbox that can be added at the last minute.

### Windows

The NSIS installer is unsigned. On first run, SmartScreen shows “Windows protected your PC” and hides the install action behind **More info → Run anyway**. This is expected, not a bug.

To remove the warning you need an OV or EV code-signing certificate (or a cloud signing service such as Azure Trusted Signing), applied to both the application executables and the installer. EV certificates historically received immediate reputation; OV certificates accumulate reputation over time. Signing must be timestamped so signatures remain valid after the certificate expires.

### What signing does not solve

Signing proves who built the binary and that it was not modified after signing. It does not:

- encrypt the database;
- make the app safe to run from an untrusted source;
- replace backups;
- provide auto-update.

---

## Manual release procedure

This is the full path for a release you intend to distribute. It assumes the repository and remotes already exist. **Do not create a tag until the artifacts have passed verification**, because a tag push triggers CI and implies a release.

### 1. Decide the version and schema impact

- Does this release add a migration? If yes, raise the minor version and update [DATA-MODEL.md](DATA-MODEL.md).
- Does it change backup compatibility? If yes, document the new minimum/maximum in [IMPORT-EXPORT.md](IMPORT-EXPORT.md) and this file.
- Does it change app identity (`productName`, `appId`)? If yes, stop and plan data adoption first; see [ADR 0005](decisions/0005-wageroute-rename.md).

### 2. Bump the version

```bash
npm version 1.1.0 --no-git-tag-version
```

This updates `package.json` and `package-lock.json` without committing or tagging. Review the diff. Do not hand-edit one file and forget the other.

### 3. Verify from a clean tree

```bash
rm -rf node_modules out release
npm ci
npm test
npm run typecheck
npm run build
```

Run the preflight checklist above. Test on a copy of a real database and on a fresh profile.

### 4. Build the installers

On macOS:

```bash
npm run dist:mac
```

On Windows:

```bash
npm run dist:win
```

Or let CI build both after the tag. Local builds are for verification and for a release you are assembling by hand.

### 5. Test the packaged artifacts

Install from the DMG/EXE on a machine or VM that has never run WageRoute:

- launch and confirm the first-run prompt appears on a fresh profile (start from scratch or import a backup);
- import a backup and confirm counts;
- create an account, entry and transfer;
- quit and relaunch; confirm persistence;
- confirm the database path in Settings;
- on macOS, confirm Gatekeeper behaviour on a downloaded copy;
- on Windows, confirm SmartScreen behaviour and the per-user install path.

A build that launches from `out/` is not evidence that the packaged app works. The asar layout and native module unpacking only exist in the packaged artifact.

### 6. Record checksums

```bash
shasum -a 256 release/*.dmg release/*.exe release/*.AppImage release/*.deb release/*.rpm
```

Publish the checksums alongside the installers. They let a recipient confirm the file was not truncated or replaced.

### 7. Commit and tag

```bash
git add package.json package-lock.json docs
git commit -m "Release 1.1.0"
git push
git tag -a v1.1.0 -m "WageRoute 1.1.0"
git push origin v1.1.0
```

Only do this when you intend to release. The tag push starts CI. Do not move or force-push a tag after artifacts have been distributed; publish a new patch version instead.

### 8. Wait for CI and collect artifacts

Both matrix jobs must pass. Download the macOS and Windows artifacts. Compare their file names and sizes with the local build. If CI and local builds disagree, investigate before publishing; a platform-specific native-module failure is the usual cause.

### 9. Publish the release

See [Publishing a GitHub Release](#publishing-a-github-release). Attach the raw installers and checksums, write notes from the template, and mark a build as pre-release only when it is not meant to be the default download.

### 10. Archive

Keep, for the current and previous release:

- the installers;
- the checksums;
- the release notes;
- a copy of the database schema version and a sample backup from that version;
- the exact commit SHA.

If a future migration is questioned, this archive is how you reproduce the old behaviour.

---

## Publishing a GitHub Release

CI uploads workflow artifacts only. Creating a release is a manual, deliberate step.

1. Open **Releases → Draft a new release**.
2. Choose the existing tag (`v1.1.0`). Do not create the tag in the web UI unless you intentionally skipped the CLI step.
3. Title: `WageRoute 1.1.0`.
4. Paste the release notes from the template below.
5. Attach:
   - `WageRoute-<version>-arm64.dmg` and `WageRoute-<version>-x64.dmg` (Intel)
   - `WageRoute.Setup.<version>-x64.exe` and `WageRoute.Setup.<version>-arm64.exe`
   - `WageRoute-<version>-x64.msi` and `WageRoute-<version>-arm64.msi`
   - the portable exes and the two zips (`WageRoute-<version>-x64.zip`, `-arm64.zip`)
   - the AppImage, deb and rpm for x64 (`-x86_64.AppImage`, `-amd64.deb`, `-x86_64.rpm`) and arm64 (`-arm64.AppImage`, `-arm64.deb`, `-aarch64.rpm`)
   - `SHA256SUMS.txt` covering all of the above

   The draft release created by the tag build already carries these files; the `gh release upload` step in [`.github/workflows/build.yml`](../.github/workflows/build.yml) attaches them. Check the draft rather than re-uploading by hand.
6. Mark as **pre-release** only if you do not intend this build as the default download.
7. Publish.

Do not attach the workflow artifact zip in place of the raw installers. Do not attach a `.db` file, a personal backup, a CSV export or any file containing real financial data.

If the repository is private, release assets are only visible to people with access. Distribution to anyone else requires sharing the file directly or making the repository/release public deliberately. This repository is public, so release assets and the source are visible together.

---

## Version bump procedure

### App-only change

```bash
npm version 1.1.1 --no-git-tag-version
```

No schema or backup change. Installers get the new version; the database is untouched.

### Schema change

1. Append a migration to `MIGRATIONS` in `src/main/db/migrations.ts`; never edit an existing migration.
2. Raise the app version at least a minor.
3. Update `SCHEMA_VERSION` implicitly through the last migration entry (do not hard-code it separately).
4. Update the schema section of [DATA-MODEL.md](DATA-MODEL.md) and the compatibility table here.
5. Update the backup allowlists/defaults in `src/main/db/backup.ts` if columns changed.
6. Test: previous-schema database copy → new app → migration → export → import into fresh profile.
7. Test: new backup → previous app, and confirm the expected rejection.
8. Decide whether old backups remain importable. The reader currently accepts `2..SCHEMA_VERSION`; keep that window honest.
9. If the migration rebuilds a table, follow the v6 recipe in [DEVELOPMENT.md](DEVELOPMENT.md#adding-a-schema-migration): `PRAGMA legacy_alter_table = ON` and suspended foreign keys set outside the transaction, recreate indexes, and mark the migration `rebuildsReferencedTable: true` so the runner checks foreign keys before committing. A table nothing references can use the simpler v2 shape: create the new table, copy rows, drop the old one, recreate indexes, inside a transaction.
10. Do not ship a migration that cannot run on a database containing deleted rows, nulls in nullable columns, or the documented maximum row counts.

### Electron upgrade

1. Upgrade `electron` and `electron-builder` together where required.
2. Run `npm ci` so `postinstall` rebuilds `better-sqlite3` for the new ABI.
3. Rebuild and launch the packaged app on every target architecture.
4. Check the CSP and preload bridge against the new Electron defaults; do not relax `sandbox`, `contextIsolation` or `nodeIntegration` to make an upgrade work.
5. Treat it as a feature release, not a patch.

### Rename or identity change

Changing `productName` moves `userData` and therefore the database path. This requires an adoption step and a migration plan like the one in [legacy.ts](../src/main/db/legacy.ts). Never change the name and assume users will find their data.

---

## Rollback

### The safe rule

**A database that has been migrated cannot be rolled back by reinstalling an older app.** Restore a copy taken before the upgrade.

### App rollback without a schema change

1. Quit the app completely.
2. Reinstall the previous installer.
3. Launch and confirm the database opens.

No data is lost because the schema did not change.

### App rollback after a schema change

1. Quit the app.
2. Move the current `wageroute.db`, `-wal` and `-shm` into a dated quarantine folder. Do not delete them; they may be the only copy of new-version data.
3. Restore the pre-upgrade database files (all three) into `WageRoute/`.
4. Reinstall the previous app.
5. Launch and confirm balances and recent entries.

If you do not have a pre-upgrade copy, you cannot safely downgrade. Either stay on the newer app or reconstruct data from a JSON backup into a clean profile. Imports are additive, so import into an empty database when reconstructing.

### Bad release already distributed

- **Do not delete the tag or silently replace the assets.** People may already have the file.
- Mark the GitHub release as a pre-release or edit the notes with a prominent warning.
- Publish a fixed patch version as soon as possible.
- If the defect can corrupt data, say so explicitly and give the restore steps.
- Keep the bad artifacts available for diagnosis unless they contain something sensitive.

### CI artifact rollback

Artifacts expire. The release assets and your local archive are the durable copies. Do not rely on a workflow run from six months ago.

---

## Hotfixes

A hotfix is a patch release with the smallest possible diff.

1. Branch from the released tag, not from an unrelated feature branch.
2. Fix only the defect. Do not include opportunistic refactors.
3. Bump the patch version.
4. Run the full preflight and packaged-app test. Shortcuts here are how a second bad release happens.
5. Tag, let CI build, publish, and note the fixed version in the release notes.
6. Merge the fix back to the main line so it is not lost.

If the fix requires a schema change, it is not a patch. Follow the schema procedure and raise the minor version.

---

## Release notes template

```markdown
# WageRoute 1.2.0

Released: 2026-11-01
Schema: 7 (migrates 3 → 4 → 5 → 6 → 7) · Backups: accepts 2–7

## Highlights

- One or two sentences a user can understand.

## Added

- ...

## Changed

- ...

## Fixed

- ...

## Data and compatibility

- Database schema: 3 → 4 → 5 → 6 → 7, automatic on first launch, forward-only.
- Backups from versions 2–7 are accepted; a backup written by a newer app is refused by an older one.
- Existing data: preserved / requires the following step.

## Upgrade notes

- Back up before installing. See docs/DEPLOYMENT.md.
- macOS (Homebrew): `brew upgrade --cask ReVax-2007/wageroute/wageroute` — nothing else to do.
- macOS (manual DMG): the build is unsigned; right-click → Open on first launch. Zero-prompt alternative: `curl -LO <dmg-url>` instead of a browser download.
- Windows: SmartScreen will warn; choose More info → Run anyway.

## Checksums

SHA-256, one line per attached installer (see SHA256SUMS.txt):
- WageRoute-<version>-arm64.dmg — ...
- WageRoute-<version>-x64.dmg — ...
- WageRoute.Setup.<version>-x64.exe — ...
- WageRoute.Setup.<version>-arm64.exe — ...
- WageRoute-<version>-x64.msi — ...
- WageRoute-<version>-arm64.msi — ...
- WageRoute-<version>-x64.portable.exe — ...
- WageRoute-<version>-x64.zip — ...
- WageRoute-<version>-x86_64.AppImage — ...
- WageRoute-<version>-amd64.deb — ...
- WageRoute-<version>-x86_64.rpm — ...
- ... (the arm64 equivalents)
```

Keep the notes honest about signing, because that is the first thing a recipient will hit.

---

## Release checklist

### Before tagging

- [ ] Version decided; schema impact understood.
- [ ] `package.json` and `package-lock.json` bumped together.
- [ ] Tests, typecheck and build pass from a clean `npm ci`.
- [ ] Manual golden-path pass on an isolated profile.
- [ ] Previous-schema database copy migrates correctly.
- [ ] Export → fresh-profile import works.
- [ ] Packaged artifact launches on each target architecture.
- [ ] No personal data, database, backup or `.env` in the source tree.
- [ ] Icons and product metadata are correct.
- [ ] `release/` contains no stale installer from an earlier name or version.

### At release

- [ ] Commit is on the intended branch.
- [ ] Tag matches the app version exactly (`vX.Y.Z`).
- [ ] CI macOS and Windows jobs pass.
- [ ] Checksums generated.
- [ ] GitHub Release created with raw installers, checksums and notes.
- [ ] Pre-release flag set only when this build is not the default download.
- [ ] No database or backup attached.

### After release

- [ ] Install from the published assets on a clean machine.
- [ ] Bump the `homebrew-wageroute` tap: set `version` and both arch `sha256`s in `Casks/wageroute.rb` to the new release's checksums from `SHA256SUMS.txt`.
- [ ] Archive installers, checksums, notes, schema version and commit SHA.
- [ ] Keep the previous installer until the new one has been used successfully.
- [ ] Record any signing or Gatekeeper/SmartScreen feedback.

---

## Known gaps

These are real limitations, not TODOs that are already handled elsewhere:

| Gap | Consequence |
| --- | --- |
| No code signing or notarization | Gatekeeper and SmartScreen warn or block; unsuitable for broad public distribution |
| No auto-update | Users must download and install each release manually |
| No published release automation | CI produces artifacts only; a human must create the release |
| No checksums in CI | Checksums are manual and easy to skip |
| No SBOM or build provenance | Cannot attest to dependency contents beyond the lockfile |
| Actions pinned by major tag | A compromised or retagged action could affect builds |
| No packaged-app smoke test in CI | A build can be produced that never launches |
| Linux and alternative Windows formats not launch-verified | CI proves the AppImage/deb/rpm/portable/zip files are produced; none has been launched on a real machine. Treat the first release shipping them as unverified until users confirm |
| No x64 app verification on Apple Silicon | The config requests x64, but only arm64 has been exercised locally |
| No rollback automation | Rollback is a manual file restore with a quarantine step |
| Unsigned native module | `better-sqlite3` is unpacked from asar; integrity depends on the installer signature (which does not exist yet) |

Closing any of these changes the release process. Record the decision before implementing it.

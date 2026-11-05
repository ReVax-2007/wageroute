# Releasing WageRoute

A WageRoute release is a **verified build of the desktop app plus a deliberate distribution step**. There is no server to deploy and no migration to run remotely. A tag build packages every platform and attaches the installers to a **draft** GitHub Release, but publishing that release — and updating the Homebrew tap — stays manual. The hard parts are data compatibility, the native SQLite module, the fact that the installers are currently unsigned, and — for the first release that carries [encryption at rest](SECURITY.md#encryption-at-rest-and-key-custody) — a layer that has never been run from a packaged app.

This document is the operational manual: what the version numbers mean, how to build, what CI does, what is missing before public distribution, and how to roll back without losing a ledger.

---

## Contents

- [Version model](#version-model)
- [Compatibility guarantees](#compatibility-guarantees)
- [Preflight checklist](#preflight-checklist)
- [Local build](#local-build)
- [What the build produces](#what-the-build-produces)
- [WageRoute Pocket](#wageroute-pocket)
- [Container images](#container-images)
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
| App version | `package.json` → `version` | `1.3.0` | The build users install. Drives installer names, macOS bundle version and release tags. |
| Database schema version | `src/main/db/migrations.ts` → `SCHEMA_VERSION`, stored in SQLite `PRAGMA user_version` | `10` | The shape of the on-disk database. Changes only when a migration is added. |
| Backup format version | Written into every JSON backup, equal to `SCHEMA_VERSION` | `10` | The newest backup the app writes. The reader accepts versions `2` through `10`. |

`package.json` reads `1.3.0` at the moment of the 1.3.0 cut; between releases it keeps the last released number even though newer commits have landed, so the **commit SHA** is the only reliable identifier of an un-released build. Bump the version as part of the release, never before. Every build users had before 1.1.0 was schema 3; 1.1.0 was the first installer carrying schemas 4, 5 and 6, and 1.2.0 adds schema 7 (bill reserves) and schema 8 (categories, card terms and balance history), so it migrates a 1.0.x database through every step in one launch. Schema 9 (each claim's strategy, the due day it carried and the payment that settled it) and schema 10 (each goal's funding pace) are what 1.3.0 brings, so a 1.2.0 database migrates 8 → 9 → 10 on its first launch into that build.

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
- Electron's version is pinned by `package-lock.json`. Upgrading Electron's major version is still effectively a platform change — the renderer, the ABI of the shell and the packaging tooling all move together — and it deserves a full installer test. It no longer changes the SQLite module: that one is N-API, so its prebuilt binary survives the bump. Treat it as a feature release with a full installer test either way.

---

## Compatibility guarantees

### Database

- Migrations are **forward-only and append-only**. `migrate()` runs every migration whose version is greater than `PRAGMA user_version`, each inside a transaction, then advances `user_version`.
- Opening an older database upgrades it in place. There is no automatic downgrade.
- The app **refuses a database whose `user_version` is newer than the app's `SCHEMA_VERSION`**. `migrate()` raises `SchemaTooNewError` before any window opens; the main process names the problem and quits without writing to the file. Never open a newer database with an older build anyway — the guard protects the file, not your expectations.
- Schema changes must preserve existing rows unless the migration explicitly rebuilds a table, as the v2 rebuild did. Every migration must be tested against a copy of the previous schema with realistic data.
- **Encryption at rest is not a schema version.** A keyed ledger carries the same `user_version` as a plaintext one; the difference is in the first sixteen bytes and in the `ledger.key.json` beside it. `migrate()` neither creates nor removes it, so a migration is tested against whichever state the user was in — and a migration test run on a plaintext copy proves nothing about the keyed one, because every read goes through the codec.

### Backups

| File version | Behaviour |
| --- | --- |
| `1` or missing | Rejected: `Backups older than schema 2 are not supported` |
| `2` | Accepted; missing columns receive documented defaults |
| `3` | Accepted |
| `4` | Accepted; `accounts.color`, `funding_strategy` and `funding_paycheck_index` receive defaults |
| `5` | Accepted; version 6 added no column |
| `6` | Accepted; no `bill_reserves` rows |
| `7` | Accepted; no `categories` or `balance_snapshots` rows and no card terms |
| `8` | Accepted; no per-claim strategy, carried due day or settling payment |
| `9` | Accepted; goals have no funding pace |
| `10` | Accepted; the newest format this app writes |
| `> 10` | Rejected: `This backup came from a newer version` |

Imports merge by row identity and are idempotent. A row the file holds a newer version of replaces the local copy; an older copy is skipped; a newer tombstone deletes. Re-importing the same file changes nothing. See [IMPORT-EXPORT.md](IMPORT-EXPORT.md) and [ADR 0024](decisions/0024-two-copies-merge-by-time.md).

A release that raises `SCHEMA_VERSION` must also decide whether the new backup shape is backward-compatible with the previous app version. The default answer is **no**: backups written by a newer app are not readable by an older app.

A **sealed** export is a versioned envelope (`wageroute-envelope`, `contains: 'backup'`) with one of these backups encrypted inside it. The table above governs the contents; the envelope version is checked first and independently, and a reader that does not know the envelope it is handed refuses it before the passphrase is typed. Both versions have to be named in the release notes when either changes — see [Version bump procedure](#version-bump-procedure).

### Application

There is no auto-update, so "compatibility" means the new installer can open the existing database and the old installer can still be reinstalled if the new one is rejected. The second half is only true before a migration runs. Back up before every upgrade.

Encryption adds a second way that promise fails, and it has nothing to do with schema versions: **a ledger turned on for encryption cannot be read by a build that predates the codec**, and installing an old installer over it does not make it plaintext again. The only way back is the app that holds the key — turn encryption off in Settings, or take a plain (not sealed) export — before an older build is expected to open the folder. A keyed `.db` handed to a pre-encryption build does not even reach the `user_version` guard; the driver refuses the bytes. This is why the release notes for the encryption release have to say *back up before turning encryption on*, and why [Rollback](#rollback) treats it as its own case.

---

## Preflight checklist

Run this before building anything you intend to distribute. It is intentionally redundant with CI: CI checks types and tests, not whether the app is usable or correctly branded.

### Source and metadata

- [ ] Working tree is clean, or you know exactly which uncommitted changes are in the build.
- [ ] `package.json` version is the intended release version.
- [ ] `package-lock.json` was updated by the same version change.
- [ ] `productName`, `appId`, shortcut name and icon paths in `electron-builder.yml` are unchanged unless the rename is intentional.
- [ ] `build/icon.icns`, `build/icon.png`, `build/icon.ico` and the iconset exist and are current.
- [ ] No database, backup, exported CSV, `.env` or credential file is staged or inside the source tree.
- [ ] The backup format marker was not changed.
- [ ] `SCHEMA_VERSION` matches the latest migration entry.

### Verification

- [ ] `npm ci` from a clean `node_modules` (not `npm install`).
- [ ] `npm run lint` passes.
- [ ] `npm test` passes.
- [ ] `npm run typecheck` passes for all three TypeScript projects (node, web, pocket).
- [ ] `npm run build` succeeds and regenerates `THIRD-PARTY-NOTICES.txt`.
- [ ] `npm run pocket:build` succeeds and writes `dist-pocket/`.
- [ ] The app boots with a throwaway profile.
- [ ] The golden paths were exercised manually (see [DEVELOPMENT.md](DEVELOPMENT.md#known-test-gaps)).
- [ ] A JSON export from the previous build imports into the new build on a fresh profile.
- [ ] A database created by the previous schema version migrates when opened by the new build, using a **copy**.
- [ ] Account balances, recent transactions and settings survive the migration.
- [ ] A sealed backup (`-encrypted.json`) exported by this build opens in this build, and one exported by the previous release still opens here.
- [ ] On a throwaway profile, the **packaged** app — not `npm run dev` — encrypts a ledger, quits, comes back to the unlock prompt, opens with the passphrase, and decrypts again. `ledger.key.json` is `0600` beside the file, and the safety copy the transition takes is gone once it verifies.
- [ ] A keyed ledger whose `ledger.key.json` was moved away is refused **by name**, not by crash: the dialog says which two files it wanted, and nothing on disk changed.

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
- Platform build tools **only as a fallback**. The SQLite driver ships prebuilt N-API binaries for `darwin`, `linux` and `win32` at `x64` and `arm64` (plus `linuxmusl` for both), and its `package.json` sets `gypfile: false`, so `npm ci` never compiles it and a normal release build needs no C toolchain at all. You need one only where those eight files do not cover you — an unsupported architecture, or a `--force_build` source build — and there the compiler is required:
  - macOS: Xcode Command Line Tools;
  - Windows: Visual Studio Build Tools with the C++ workload and Python;
  - Linux: `build-essential`, `python3`, `make`, `g++`.
- Enough disk for Electron, the unpacked app and installers (roughly 1–2 GB per platform).

`npm ci` runs `postinstall`, which is `electron-builder install-app-deps`. With this driver there is nothing for it to rebuild: the module's binary is N-API, the same one loads under Node and under Electron, and the install step is kept because it is what would compile a source build on a platform that has no prebuild. `NODE_MODULE_VERSION` errors at launch were the classic reason to skip it; that failure mode belongs to the pre-N-API `better-sqlite3` this project no longer uses.

### Commands

```bash
npm ci                      # exact dependency tree, prebuilt native binary
npm test                    # shared domain tests
npm run typecheck           # node + web + pocket projects
npm run build               # typecheck, then electron-vite build into out/
npm run pocket:build        # static build of the phone app into dist-pocket/

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
| `lint` | repository-local gate: no `debugger`, console logging, `@ts-ignore` or `any` |
| `test` | `node --import tsx --test` over every test file listed in `package.json` |
| `notices` | regenerate `THIRD-PARTY-NOTICES.txt` from `package-lock.json` |
| `prebuild` | runs `notices` automatically before every `npm run build` |
| `typecheck:node` | main, preload, shared, config |
| `typecheck:web` | renderer and shared |
| `typecheck:pocket` | the phone app and shared |
| `typecheck` | all three projects |
| `build` | notices, typecheck, then bundle main/preload/renderer into `out/` |
| `pocket:dev` | Vite dev server for the phone app |
| `pocket:build` | static build of the phone app into `dist-pocket/` (not an installer) |
| `dist` | build, then electron-builder for the host platform (`--publish never`) |
| `dist:mac` | build, then macOS DMG |
| `dist:win` | build, then Windows NSIS, MSI, portable and zip |
| `dist:linux` | build, then Linux AppImage, deb and rpm |
| `postinstall` | `electron-builder install-app-deps` — a no-op for this driver's prebuilds, and the step that would rebuild a native module from source |

### Cross-platform builds

Build each installer on the platform it targets, or let CI do it.

- **macOS** — build on macOS. Producing both arm64 and x64 from an Apple Silicon machine is no longer a compile question: the driver ships `prebuilds/darwin-x64.node` beside `prebuilds/darwin-arm64.node`, and the config requests both architectures. A build succeeding is still not proof the x64 app launches — verify on an Intel Mac or an x64 VM before shipping both.
- **Windows** — build on Windows. electron-builder can sometimes cross-build NSIS from macOS with Wine, but that path is not supported by this project and is not tested.
- **Linux** — build on Linux (CI uses Ubuntu). The AppImage, deb and rpm targets each download their own tooling (appimagetool, fpm) on demand; nothing downloads or compiles a SQLite binary, because the driver's `linux-x64`, `linux-arm64`, `linuxmusl-x64` and `linuxmusl-arm64` prebuilds are already in `node_modules`. Cross-building Linux installers from macOS or Windows is not supported and not tested.

### Isolated test profile

Never test a release against the real ledger. On macOS, relocate Electron's application-data home:

```bash
CFFIXED_USER_HOME=/tmp/wageroute-release-test npm run dev
```

For the packaged app, launch it with the same environment variable if needed, or test on a clean user account or VM. Confirm the path shown in Settings before creating data.

For the encryption proofs, the throwaway folder is the whole custody: a keyed ledger is `wageroute.db` **and** the `ledger.key.json` beside it, so reproduce a keyed profile by copying both together — a folder with only the `.db` is the missing-key-file case, not a working ledger. Settings can point the data directory somewhere else entirely, which is why the path on screen is confirmed before any data is created.

### Why `npm ci` matters

`better-sqlite3-multiple-ciphers` is a native module, but a prebuilt one: `lib/binding.js` picks `prebuilds/<platform>-<arch>.node` before it ever looks for a node-gyp output, and the binary registers through N-API rather than a versioned V8 ABI, so the same file serves Node and Electron. The failure modes are now narrower, and `npm ci` still guards the ones that remain:

- a platform or architecture with no prebuild → the loader falls through to `build/Release/better_sqlite3.node`, which does not exist unless something compiled it: a module-load failure that looks like a packaging bug and is really a missing toolchain;
- the wrong architecture's prebuild shipped inside an installer → module load failure, which is why the Linux CI jobs assert exactly one `*.AppImage` and one `*.deb` rather than trusting the flag;
- `npm install` resolving a different tree than CI → a build that works locally and fails in CI.

`npm ci` plus `postinstall` is still the supported path — it is the same command that would build from source on a platform that needs it.

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
├── WageRoute-1.3.0-arm64.dmg
├── WageRoute-1.3.0-x64.dmg
├── mac-arm64/WageRoute.app
└── mac/WageRoute.app            # when an x64 build runs
```

The names are pinned by `dmg.artifactName` in `electron-builder.yml` (`WageRoute-${version}-${arch}.dmg`), so both architectures carry their suffix and a release note can name an asset exactly. `publish: null` means no `latest-mac.yml` is written: there is no updater, so there is no update feed. electron-builder still emits a `.dmg.blockmap` beside each DMG locally; the CI artifact patterns do not include it, so it never reaches the release.

**Windows** — `win.target` requests `nsis`, `msi`, `portable` and `zip` for `x64` and `arm64`:

```text
release/
├── WageRoute.Setup.1.3.0.exe
├── WageRoute-1.3.0-x64.msi
├── WageRoute-1.3.0-arm64.msi
├── WageRoute-1.3.0.portable.exe
├── WageRoute-1.3.0-x64.zip
└── WageRoute-1.3.0-arm64.zip
```

`nsis.artifactName` and `portable.artifactName` deliberately omit `${arch}`: electron-builder builds one installer that carries both architectures, and it only emits per-architecture copies *in addition* when the pattern contains `${arch}`. Asking for `${arch}` therefore produced three NSIS installers — a universal one and two per-arch ones — and the same for the portable exe. One universal file per format is what a release should carry, and it matches the `WageRoute.Setup.1.1.0.exe` name that 1.1.0 shipped.

The MSI and the zip are per architecture (`-x64`, `-arm64`), because neither format has a multi-architecture variant here. The zip has no config block of its own, so it inherits the pattern shared through `win` — which is why `msi.artifactName` ends in `${ext}` rather than a literal `.msi`. With a literal `.msi` the zip target named itself `…-x64.msi` and 7-Zip failed with `System ERROR: The parameter is incorrect`, because a zip archive cannot be written under an `.msi` extension. `${ext}` resolves to `msi` for the installer and `zip` for the archive.

NSIS is configured as a per-user install (`perMachine: false`), not one-click, with a selectable directory and a desktop shortcut. Per-user installs do not require administrator rights and put the app under the user's profile. The NSIS installer and the portable exe each carry the x64 and arm64 payloads in one file; the MSI and the zips are per architecture. The portable and zip targets exist for users who cannot run installers (locked-down machines, no admin). All four Windows formats are unsigned, so SmartScreen treats them the same way.

The MSI is built by electron-builder's WiX target, and WiX only runs on Windows — a macOS or Linux checkout cannot produce it. It installs per-user into `%LOCALAPPDATA%\Programs\WageRoute`, so `msiexec /i WageRoute-<version>-x64.msi /qn` works without elevation and is suitable for Intune, SCCM or Group Policy. Because WiX 4 has no arm64 architecture, the `-arm64` MSI is an x64 package that installs the arm64 app; Windows on ARM runs it without a prompt.

The MSI and the NSIS installer are separate products with separate uninstall entries. Installing one over the other leaves two entries in **Apps & features**; tell users to uninstall the old one first. The CI job reinstalls the MSI to prove an upgrade stays a single entry.

**Linux** — `linux.target` requests `AppImage`, `deb` and `rpm` for `x64` and `arm64`:

```text
release/
├── WageRoute-1.3.0-x86_64.AppImage
├── WageRoute-1.3.0-arm64.AppImage
├── WageRoute-1.3.0-amd64.deb
├── WageRoute-1.3.0-arm64.deb
├── WageRoute-1.3.0-x86_64.rpm
└── WageRoute-1.3.0-aarch64.rpm
```

`appImage.artifactName`, `deb.artifactName` and `rpm.artifactName` pin one pattern for all three packagers, but `${arch}` expands to each packager's own architecture name, not `x64`: AppImage and rpm call 64-bit Intel `x86_64`, deb calls it `amd64`, and only the arm64 AppImage and deb keep the literal `arm64` (the arm64 rpm says `aarch64`). That is electron-builder's naming, not a choice of ours, and it is why the CI smoke test selects `release/*.AppImage` and `release/*.deb` by format and asserts exactly one of each rather than matching a suffix. AppImage runs on any distro without root; deb and rpm integrate with the system package manager and desktop menu. All three are unsigned, so some distros warn during install.

### Bundle contents

`files` includes only `out/**/*` and `package.json`, minus source maps. `asarUnpack` extracts `**/*.node`, so the native SQLite binary sits outside the asar archive where it can be loaded — it now lives under `node_modules/better-sqlite3-multiple-ciphers/prebuilds/`, one file per platform and architecture, which that glob still covers. `npmRebuild: true` remains in the config; for a prebuilt N-API module there is nothing for it to compile, and it stays as the path a source build would take. `extraResources` copies `LICENSE` and the generated `THIRD-PARTY-NOTICES.txt` beside the app, and Settings → About can display both.

`publish: null` is deliberate. electron-builder otherwise infers a publisher from the repository field on a tag build and writes `latest-mac.yml` / `latest.yml`; WageRoute has no updater, so those files would advertise an update channel that does not exist. Releases are assembled by the workflow's release job instead.

No database is bundled. On first launch the app seeds one blank local user with default settings if no user row exists, and the dashboard offers a start-from-scratch or import-a-backup path. The demo profile (Alex) is seeded only in development builds (`app.isPackaged` false); it is **not** a release asset.

---

## WageRoute Pocket

WageRoute Pocket is the phone app: a static Vite/React build in `src/pocket/`, written to `dist-pocket/`, and installed from a browser. It is **not** part of a desktop release and not an electron-builder target. What a person does with it — installing it, the six tabs, carrying files between the two devices — is [POCKET.md](POCKET.md).

- **It has no version of its own.** It reads a desktop backup, merges it into its browser copy and merges its edits back through an export; the backup's format version is the compatibility number that matters, alongside the two cipher formats it can write and read — `wageroute-envelope` for a sealed file and `wageroute-vault` for its own sealed copy. A change to any of the three belongs in the desktop schema procedure above and in [Encryption and key custody change](#encryption-and-key-custody-change).
- **CI builds it, but never publishes it.** The `verify` job runs `npm run pocket:build` after `npm run build`, so a broken Pocket build fails the same gate as a broken desktop build. `dist-pocket/` is gitignored and is not uploaded as an artifact.
- **Publishing is a separate, manual decision.** [`.github/workflows/pocket.yml`](../.github/workflows/pocket.yml) is `workflow_dispatch` only and deploys `dist-pocket/` to GitHub Pages. A normal push or tag never publishes the phone app, and the workflow has no effect on the desktop installers.
- **A publish is a public deployment.** The static bundle is served from a public URL, so treat enabling Pages, running that workflow, or changing the published origin as owner actions, not release steps.
- **The service worker owns its own cache.** The build stamps `public/sw.js` with the package version and a hash of the built assets, and names the cache `wageroute-pocket-<stamp>`; only caches with that prefix are removed on activation, so a shared Pages origin does not lose another app's cache. Hashed assets are cache-first, navigation is network-first. A shell change reaches an installed phone on its next open without a manual version bump.

Releasing the desktop app does not require rebuilding or republishing Pocket. The reverse is also true: fixing only the phone app does not need a new installer. Do rebuild and republish when a release changes the backup format, the envelope or the vault, so phones can read and write what the new desktop writes — a phone on an old build cannot open a sealed file whose format it does not know, and refuses it by name rather than guessing.

To verify the phone build by hand:

```bash
npm run pocket:build
npm run pocket:preview   # then open the printed URL
```

Check that an exported desktop backup imports, an entry survives a reload, and the manifest and service worker are served. Then check the two ciphers on the one origin that gives them: seal this phone's copy, reload the page and unlock it again; export it sealed and open that file on the desktop; export a sealed backup from the desktop and open it here. On `localhost` all three work; over a LAN address on plain HTTP the app should say it has no cipher and refuse to offer a seal — which is the correct answer, not a failure to fix in code.

---

## Container images

`docker/` carries the two Dockerfiles plus their nginx, supervisor and entrypoint files, and `docker-compose.yml` runs both from one command. [`.github/workflows/docker.yml`](../.github/workflows/docker.yml) builds the pair and pushes them to `ghcr.io/<owner>/wageroute-pocket` and `…/wageroute-desktop`. What running one of them is *for*, and the caveats a user has to read first, are in [DEPLOYMENT.md](DEPLOYMENT.md#running-wageroute-in-a-container).

- **A tag push publishes them.** `build.yml` also fires on `v*`, but a tag run there stops at a **draft** Release whose publishing stays manual; `docker.yml` is the one workflow that actually delivers on a tag — it pushes the images to ghcr.io as part of the run. `pocket.yml`, by contrast, is `workflow_dispatch` only. A tag push writes `<version>` and `latest`; a manual run writes `sha-<commit>` and nothing else, because between releases `package.json` still carries the last released number and a run from `main` must not overwrite a published version tag. If you are not ready to publish images, that decision belongs **before** the tag, not after it.
- **Its guard is narrower than `build.yml`'s.** It fails the run unless the tag equals `package.json`'s version; it does not repeat the `guard` job's second check, that the tagged commit is an ancestor of `origin/main`, because an image built from any tag is still just an image and cannot replace a published artifact's checksums.
- **The first push creates the package as private.** Making it public, or linking it to the repository, is an owner action in the package's settings; the workflow cannot do either and does not try.
- **CI builds one architecture: the runner's, `linux/amd64`.** There is no multi-arch manifest, so an arm64 host pulling `wageroute-desktop` runs it under emulation — build locally with the same Dockerfile for a native arm64 image.
- **Publishing images is a deployment, not a release step.** No installer contains them, `SHA256SUMS` covers the installers and not the images, and a desktop release does not require rebuilding them. Pin `@sha256:` digests rather than `latest` if you depend on one not moving.
- **The workflow exists and has never run.** No image has ever been pushed to ghcr.io; every container proof in this repository was made against locally built `linux/arm64` images.
- **Inside a container, encryption is passphrase-only.** Device custody asks Electron's `safeStorage`, which throws without a keyring daemon — a headless session or a container — so the Settings picker withholds *This computer* and prints the reason there. The consequence for a release note is concrete: the key file and the ledger live in the same mounted volume, so a container user who loses that volume or forgets the passphrase has no second way in, and the machine holding the keychain is not an option.

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

Each Linux job passes one architecture flag, so a native runner never has to cross-compile anything. macOS and Windows build both architectures on one runner because the driver's prebuild for each is already in `node_modules`.

Architectures are passed on the command line, never as `arch` lists inside `electron-builder.yml`. electron-builder merges a target's declared arches into whatever the CLI asks for, so `--linux --x64` against a config that lists `arm64` still emits arm64 artifacts — which is how the first run of this workflow produced an x64 job holding an arm64 AppImage.

`fail-fast: false` means a macOS failure does not cancel the Windows build, so you can see both results.

### Steps

1. `actions/checkout` (pinned by commit SHA)
2. `actions/setup-node` (pinned by commit SHA) with Node **24** and npm cache
3. `npm ci`
4. `npm run lint`
5. `npm test`
6. `npm run build` (notices, typecheck and production bundles)
7. `npx electron-builder <arch flag> --publish never`
8. Platform smoke test — see below
9. `actions/upload-artifact` (pinned by commit SHA) with `if-no-files-found: error`
10. On a tag push only, the separate `release` job downloads every artifact, writes `SHA256SUMS`, creates a **draft** release if none exists and uploads the files with `gh release upload --clobber`

The build matrix runs with `permissions: contents: read`. Only the `release` job declares `contents: write`, so a compromised build step cannot alter the repository or a release.

### Smoke tests

The tests and type checks prove the code; these steps prove the artifacts.

- **Windows** — silent-installs the x64 MSI with `msiexec /i … /qn`, checks the executable landed under `%LOCALAPPDATA%\Programs\WageRoute` (accepting a machine-level `Program Files` redirect), launches it and waits for `%APPDATA%\WageRoute\wageroute.db` to appear. The database is opened during boot before the window is shown, so its presence proves the packaged binary really started. It then reinstalls the same MSI and asserts exactly one **Apps & features** entry across both uninstall registry hives — the per-user entry is not guaranteed to be in `HKCU` — and uninstalls and asserts the executable and install directory are gone. The ledger in `%APPDATA%` is left behind on purpose — uninstalling must not destroy a user's data.
- **Linux x64 and arm64** — runs the AppImage (`APPIMAGE_EXTRACT_AND_RUN=1`, no FUSE needed) under `xvfb-run` with a throwaway home directory, then extracts the deb and runs the packaged binary the same way. Each must create `wageroute.db` in that profile within two minutes. `HOME` alone is not isolation: the runner image exports `XDG_CONFIG_HOME`, which Electron prefers, so the step also points `XDG_CONFIG_HOME`, `XDG_DATA_HOME` and `XDG_CACHE_HOME` at the throwaway directory. If the ledger does not appear, the step lists the profile and prints the app's own log from it before failing — on a headless runner a boot error is otherwise invisible. The step asserts that exactly one `*.AppImage` and one `*.deb` exist, so a job that quietly built the other architecture fails instead of running the wrong binary.
- **macOS** — no automated launch. The DMG is verified by hand on the release machine; see the checklist below.

The rpm is built but not launched, because `rpm2cpio` is not installed on the runner and the payload is the same binary as the deb.

### What CI does not do

- It does not launch the macOS app. The Windows MSI and the Linux AppImage and deb are launched; the DMG is not, because the runner has no display session the app will accept.
- It does not test the NSIS installer, the portable exe, the zip or the rpm at run time. They share the packaged payload with the MSI or the deb.
- It does not create a tag or write release notes. On a tag push it creates or updates a **draft** release and attaches the files plus `SHA256SUMS`; publishing stays manual.
- It does not sign with a real identity or notarize. macOS artifacts get an ad-hoc signature from the afterSign and afterAllArtifactBuild hooks; Windows and Linux artifacts are unsigned.
- It never turns encryption on. Every smoke test boots a **fresh profile**, and encryption is opt-in with a plaintext ledger as its default, so CI proves the multiple-ciphers binary loads and writes a plain database inside the packaged layout — not that the packaged app can encrypt, unlock at launch, decrypt again, or read a keyed ledger it did not create. That gap is exactly what [step 5](#5-test-the-packaged-artifacts) exists for.
- It does not run `npm audit`, generate an SBOM or attest build provenance.
- It does not push packages to a registry or an auto-update feed. `npm run dist:*` and every packaging step pass `--publish never` (and `publish: null` is set in the config), because electron-builder treats a tag build as an implicit publish request and fails when `GH_TOKEN` is absent. The only upload is `gh release upload` into a draft release, described above. Workflow artifacts expire according to the repository's retention setting (GitHub's default is 90 days).

Every action is pinned by commit SHA with its release version in a comment; a bump means replacing the SHA, not the tag. See [SECURITY.md](SECURITY.md#supply-chain).

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

Apple Silicon requires at least an ad-hoc signature for the executable to run, and an *invalid* signature produces the "damaged" dialog rather than the "cannot be verified" one. electron-builder's default no-identity path leaves the bundle with a broken signature, so `scripts/adhoc-sign.js` (the `afterSign` hook) re-signs the bundle explicitly: nested Mach-O files (`.dylib`, `.so`, `.node` and the helper executables) first, then any nested `.app` bundles deepest-first, then the outer bundle, and finally runs `codesign --verify --deep --strict` so a failed signature fails the build instead of shipping. The hook runs **after** electron-builder applies the electron fuses — flipping a fuse rewrites the binary and invalidates any signature made before it, so a hook on `afterPack` would leave the shipped bundle invalid. `scripts/adhoc-sign-dmg.js` (`afterAllArtifactBuild`) then signs and verifies each `.dmg`, so the container matches the app inside it. (`spctl --assess` is not used: it rejects ad-hoc signatures by design.) Ad-hoc is not notarization and does not satisfy Gatekeeper for downloaded copies. Verify the artifact on a clean machine rather than assuming a local launch proves it will open elsewhere.

To ship properly you need:

- an Apple Developer Program membership;
- a **Developer ID Application** certificate;
- a hardened-runtime build with entitlements that allow Electron's JIT and the native module to load;
- notarization via `notarytool` (electron-builder's `notarize` configuration or an after-sign hook);
- stapling the notarization ticket to the DMG/app.

Secrets belong in CI secret storage (`CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`), never in the repository. Signing also changes the build pipeline and must be tested end to end; it is not a checkbox that can be added at the last minute.

### Windows

The Windows installers (NSIS, MSI), the portable executable, and the zip archives are currently unsigned. On modern Windows installations, users encounter two separate security checks:

1. **Browser download quarantine (Microsoft Edge / Google Chrome):**
   - Microsoft Edge blocks the download with a warning (*"WageRoute.Setup.exe was blocked because it could harm your device"*).
   - In Edge, users must hover over the download item → click **`...`** (More actions) → select **Keep** → select **Show more** → click **Keep anyway**.
   - In Google Chrome, users must select **Download suspicious file** or **Keep anyway** from the downloads alert.
2. **Mark of the Web & Windows Defender SmartScreen:**
   - Browsers write the NTFS alternate data stream `Zone.Identifier` (ZoneId=3) onto downloaded executables.
   - On first launch, SmartScreen displays a blue modal: *"Windows protected your PC — Microsoft Defender SmartScreen prevented an unrecognized app from starting."*
   - Users click **More info → Run anyway** to proceed.
   - Alternatively, right-click the executable → **Properties** → check the **Unblock** box under Security → **Apply**.
   - Downloading via PowerShell (`curl.exe -LO ...` or `Invoke-WebRequest`) avoids setting the Mark of the Web entirely.
   - Existing blocked files can also be unblocked in PowerShell via `Unblock-File -Path .\WageRoute.Setup.<version>.exe`.

To eliminate both warnings in production:
- Obtain an EV or OV code-signing certificate, or configure **Azure Trusted Signing** / **SignPath**.
- Integrate signing in the CI workflow using `signtool.exe` or electron-builder's `win.certificateFile` / `win.certificatePassword` configuration.
- Sign all nested executables (`WageRoute.exe`, helper binaries), the NSIS setup wrapper, and the MSI payload with an RFC 3161 timestamp server.

### Linux

Linux artifacts (AppImage, deb, rpm) are unsigned:
- **AppImage execution permissions:** Browsers do not set executable bits on downloaded files. Users must run `chmod +x WageRoute-<version>-x86_64.AppImage` before running.
- **FUSE 2 requirements:** Modern distributions (Ubuntu 22.04 LTS, Ubuntu 24.04 LTS, Debian 12) do not bundle `libfuse2` by default. AppImages will fail with `dlopen(): error loading libfuse.so.2` unless `libfuse2t64` (Ubuntu 24.04+) or `libfuse2` (Ubuntu 22.04) is installed, or the binary is executed with `./WageRoute-*.AppImage --appimage-extract-and-run`.
- **Package manager warnings:** Installing `.deb` or `.rpm` through GUI app stores may warn that the package is from an untrusted or unsigned source. Installing via CLI (`sudo apt install ./...deb` or `sudo dnf install ./...rpm`) bypasses GUI prompts and verifies dependencies cleanly.
- To sign Linux packages in production, configure a GPG key for Debian packages and RPM signing via `rpmsign`.

### What signing does not solve

Signing proves who built the binary and that it was not modified after signing. It does not:

- encrypt the database — that is the opt-in setting inside the app, and the ledger's own cipher does not care who signed the binary that reads it;
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
- Does it change the key file's `version`, the envelope's, or the vault's — or the iteration rails a reader will accept? Each is a compatibility event of its own, independent of `SCHEMA_VERSION`: see [Encryption and key custody change](#encryption-and-key-custody-change).

### 2. Bump the version

```bash
npm version 1.3.0 --no-git-tag-version
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

Run the preflight checklist above. Test on a copy of a real database and on a fresh profile. Since encryption is a property of the file rather than a schema version, "a copy of a real database" is two copies: one from a plaintext profile and one from a keyed one with its `ledger.key.json` moved beside it. Only the second exercises the codec, and never test either against the profile that holds real data — copy it out first.

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

**Encryption at rest is the layer that needs this the most**, because the thing it depends on — the codec inside the unpacked `.node` — exists only in the packaged app. On a throwaway profile:

- turn encryption **on** in Settings, quit, relaunch. With *This computer* custody and an unlocked login keychain the app should open with **nothing typed**; with a passphrase-only ledger the only window should be the one titled `WageRoute — locked`, and closing it should end the launch with the "stayed locked" dialog and both files untouched. Type a wrong phrase, then the right one — the retry is the screen's only complaint and the log records the count, never the phrase;
- turn it **off** again on the same profile: quit, relaunch, confirm the ledger opens with no prompt and that `sqlite3` can read the file. The reverse rewrite is a second transition, and it can fail in ways the forward one cannot;
- confirm the key file beside the ledger is `ledger.key.json` with mode `0600`, that it carries no pending transition marker after a clean boot, and that the safety copy taken for the change is gone;
- move `ledger.key.json` away and relaunch. The dialog must be the one that **names the missing key file and both paths** — not `file is not a database`, and not a crash. Put the file back and confirm it opens again;
- export a **sealed** backup from the packaged app, then import it into a fresh profile: the passphrase is asked for *before* any counts appear, a wrong phrase says so, and a plain export still opens straight into the preview.

Each of these is a two-minute check on a machine that has only ever seen the DMG or EXE. None of them is proved by `npm test`.

### 6. Checksums

The tag build's release job computes `SHA256SUMS` over the artifacts it downloads and attaches it to the draft release, so the published hashes come from the same run that built the files. For a locally assembled release, or to compare against CI, compute them yourself:

```bash
shasum -a 256 release/*.dmg release/*.exe release/*.msi release/*.zip release/*.AppImage release/*.deb release/*.rpm
```

They let a recipient confirm the file was not truncated or replaced.

### 7. Commit, merge and tag

`main` is protected and takes changes only through a merged pull request, and the tag guard refuses a tag that is not an ancestor of `origin/main` — so the tag comes **after** the merge lands, never before.

```bash
git switch -c release/1.3.0
git add package.json package-lock.json CHANGELOG.md README.md docs
git commit -m "Release 1.3.0"
git push -u origin release/1.3.0      # open the pull request, wait for `verify`, merge
git switch main && git pull
git tag -a v1.3.0 -m "WageRoute 1.3.0"
git push origin v1.3.0
```

Only do this when you intend to release. The tag push starts CI. Do not move or force-push a tag after artifacts have been distributed; publish a new patch version instead.

### 8. Wait for CI and collect artifacts

Every matrix job must pass. Download the macOS, Windows and Linux artifacts. Compare their file names and sizes with the local build. If CI and local builds disagree, investigate before publishing; a platform-specific native-module failure is the usual cause.

### 9. Publish the release

See [Publishing a GitHub Release](#publishing-a-github-release). Confirm the draft carries the raw installers and `SHA256SUMS`, write notes from the template, and mark a build as pre-release only when it is not meant to be the default download.

### 10. Archive

Keep, for the current and previous release:

- the installers;
- the checksums;
- the release notes;
- a copy of the database schema version and a sample backup from that version;
- a sample **sealed** export from that version, and a throwaway-profile `ledger.key.json` with it, so the envelope and key-file shapes read from the release are on hand — from a profile made for the test, never the one holding real data;
- the three format versions the release wrote: `SCHEMA_VERSION`, the key file's `version`, and the envelope and vault versions. They move independently, and a future reader needs the pair that belonged together;
- the exact commit SHA.

If a future migration is questioned, this archive is how you reproduce the old behaviour. If a future *decryption* is questioned, the sample files are the only way to prove what the release actually wrote.

---

## Publishing a GitHub Release

A tag build runs the `release` job, which creates or refreshes a **draft** release carrying every installer and `SHA256SUMS`. Publishing it — and updating the Homebrew tap — is a manual, deliberate step.

1. Open **Releases → Drafts** and select the draft the tag pushed. Do not create a second release for the same tag in the web UI.
2. Title: `WageRoute 1.3.0`.
3. Paste the release notes from the template below.
4. Confirm the draft carries:
   - `WageRoute-<version>-arm64.dmg` and `WageRoute-<version>-x64.dmg` (Intel)
   - `WageRoute.Setup.<version>.exe` (one installer for x64 and arm64)
   - `WageRoute-<version>-x64.msi` and `WageRoute-<version>-arm64.msi`
   - `WageRoute-<version>.portable.exe` and the two zips
   - the AppImage, deb and rpm for x64 (`-x86_64.AppImage`, `-amd64.deb`, `-x86_64.rpm`) and arm64 (`-arm64.AppImage`, `-arm64.deb`, `-aarch64.rpm`)
   - `SHA256SUMS` covering all of the above

   The `release` job in [`.github/workflows/build.yml`](../.github/workflows/build.yml) attaches these files and refuses to replace assets on a release that is already published. Check the draft rather than re-uploading by hand.
5. Mark as **pre-release** only if you do not intend this build as the default download.
6. Publish.

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
2. Run `npm ci`. `postinstall` still executes, but there is nothing for it to compile: the SQLite driver is a prebuilt N-API module, so its binary is the same file under the old and the new Electron. What an upgrade can still break is the shell around it — the asar layout, `safeStorage`, and the window's security defaults.
3. Rebuild and launch the packaged app on every target architecture.
4. Check the CSP and preload bridge against the new Electron defaults; do not relax `sandbox`, `contextIsolation` or `nodeIntegration` to make an upgrade work.
5. Treat it as a feature release, not a patch.

### Encryption and key custody change

Three small formats are independent of `SCHEMA_VERSION` and none of them is migrated by `migrate()`: the key file beside the ledger (`version: 1` in [ledger-key.ts](../src/main/db/ledger-key.ts)), the sealed backup (`wageroute-envelope` version 1, `src/shared/envelope.ts`), and the phone's vault (`wageroute-vault` version 1, `src/pocket/lib/vault.ts`). Each is versioned precisely so a reader can refuse what it cannot decode rather than guess — which is what the readers do today.

- **Changing one is a compatibility event, not a refactor.** A new envelope version must still be readable by the desktop release before it, or every sealed file users already carry becomes unreadable the day they upgrade. There is no automatic conversion of an old sealed file: the phrase opens it, or it stays shut.
- **`LEDGER_CIPHER` is pinned in code (`chacha20`), and a ledger that exists has already chosen.** Raising or swapping it does not re-encrypt anything; it makes every keyed ledger on the previous cipher unreadable. If it ever has to change, that needs its own migration story and a release that says so — the transition path in `src/main/db/encryption.ts` re-keys between plaintext and the pinned cipher and nothing else.
- **The iteration rails are a promise to the reader.** `MIN_ITERATIONS` / `MAX_ITERATIONS` in `src/shared/envelope.ts` bound what a reader will spend, and a file outside them is refused by design. Tightening the rails can strand files written under the old ones; check the released range before narrowing it.
- **The phone has to be republished.** A release that changes the envelope or the vault format needs `npm run pocket:build` deployed again — the phone is a separate distribution, and a phone that cannot read the desktop's new file is the same failure as a desktop that cannot read an old one. See [WageRoute Pocket](#wageroute-pocket).
- **Nothing here is proven by a test run.** The manual shape is what settles these, and one pass of it has been made: on 2026-11-04 the packaged macOS app encrypted a scratch ledger, restarted into the unlock prompt, opened it with the passphrase, moved the keyed folder and back, and decrypted it again. What that pass did **not** cover is why the checklist below still exists: no packaged build has written a **device** wrap (`safeStorage` under a signed, installed app on a real login), none has run on Windows or Linux with a keyed ledger, and none has been caught mid-transition. Before a release that ships the encryption toggle, the manual proof in the checklist below is the gate, not `npm test`.

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

If you do not have a pre-upgrade copy, you cannot safely downgrade. Either stay on the newer app or reconstruct data from a JSON backup into a clean profile. Imports merge rather than replace, but an old backup describes an old state; import into an empty database when reconstructing.

### Rolling back a profile that has encryption on

Reinstalling an older build does not undo encryption, and a keyed ledger is unreadable to a build with no codec — it fails at the driver, before the `user_version` guard ever runs. So the order matters:

1. On the **current** build, confirm the ledger opens (device custody, or type the passphrase).
2. Take a **plain** export — the dialog's unsealed option, not the sealed one. A sealed file is as unreadable to the old build as the database is.
3. Turn encryption **off** in Settings and let it finish. The transition verifies on a fresh connection, and removing the key file is the last step of a verified decrypt — if it did not verify, the marker stays and the ledger stays ciphertext.
4. Quit, reinstall the previous installer, and confirm the ledger opens plaintext.

If the passphrase is gone, there is no rollback: the custody is the point, and no reset exists in the app. The route back is a plain export taken before encryption was turned on, imported into a clean profile — which is why the release notes ask for a backup *before* the first encryption, not only before the upgrade.

Never hand an old build a `.db` whose `ledger.key.json` you moved into the folder to see what happens; move the whole folder or nothing, and keep the wreck (`<the ledger file>.wrecked`) if a restore ever runs.

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
# WageRoute <version>

Released: <YYYY-MM-DD>
Schema: <N> (migrates <prev> → <N>) · Backups: accepts 2–<N>

## Highlights

- One or two sentences a user can understand.

## Added

- ...

## Changed

- ...

## Fixed

- ...

## Data and compatibility

- Database schema: <prev> → <N>, automatic on first launch, forward-only.
- Backups from versions 2–<N> are accepted; a backup written by a newer app is refused by an older one.
- Encryption at rest: opt-in in Settings, reversible, off by default. Nothing is encrypted until you ask for it, and a ledger that has been encrypted can be turned back.
- Sealed backups: an export can be wrapped in a passphrase this app and WageRoute Pocket both open. There is no reset and no recovery: a file whose phrase is lost stays shut.
- Existing data: preserved / requires the following step.

## Upgrade notes

- Back up before installing. See docs/DEPLOYMENT.md. Do it **before** turning encryption on: a plain backup is the one artifact that still opens if a passphrase is lost. Keep a sealed export's phrase somewhere the copied file is not, and remember that an encrypted `.db` is only a ledger when its `ledger.key.json` sits beside it — move the whole folder, never the database alone.
- macOS (Homebrew): `brew upgrade --cask ReVax-2007/wageroute/wageroute` — nothing else to do.
- macOS (manual DMG): the build is unsigned; right-click → Open on first launch. Zero-prompt alternative: `curl -LO <dmg-url>` instead of a browser download.
- Windows: SmartScreen will warn; choose More info → Run anyway.

## Checksums

SHA-256, one line per attached installer (see SHA256SUMS):
- WageRoute-<version>-arm64.dmg — ...
- WageRoute-<version>-x64.dmg — ...
- WageRoute.Setup.<version>.exe — ...
- WageRoute-<version>-x64.msi — ...
- WageRoute-<version>-arm64.msi — ...
- WageRoute-<version>.portable.exe — ...
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
- [ ] If this release carries the encryption toggle: the packaged-build encryption proof above was done by hand, on a throwaway profile, and recorded here. *(The macOS half was run on 2026-11-04 with passphrase custody — see [UNRELEASED.md](UNRELEASED.md)'s Batch 57 — so the release that ships the toggle still owes the device wrap, the missing-key-file dialog, a sealed export/import and every step on Windows and Linux. No test substitutes for any of them.)*
- [ ] No personal data, database, backup or `.env` in the source tree.
- [ ] Icons and product metadata are correct.
- [ ] `release/` contains no stale installer from an earlier name or version.
- [ ] Decided whether this tag publishes the container images — `docker.yml` fires on `v*`, so the answer has to be reached before the tag, not after it.

### At release

- [ ] Commit is on the intended branch.
- [ ] Tag matches the app version exactly (`vX.Y.Z`).
- [ ] Every CI build job passes.
- [ ] The draft release carries the raw installers and `SHA256SUMS`; local hashes match CI.
- [ ] GitHub Release notes written and checked.
- [ ] Pre-release flag set only when this build is not the default download.
- [ ] No database or backup attached.

### After release

- [ ] Install from the published assets on a clean machine.
- [ ] Bump the `homebrew-wageroute` tap: set `version` and both arch `sha256`s in `Casks/wageroute.rb` to the new release's checksums from `SHA256SUMS`.
- [ ] If the tag published images, confirm both ghcr.io packages carry the new `<version>` and note their visibility — the first push makes a package private, and only an owner can make it public.
- [ ] Archive installers, checksums, notes, schema version, commit SHA — and, once a release carries encryption, the key file/envelope/vault versions with a throwaway-profile sample of each.
- [ ] Keep the previous installer until the new one has been used successfully.
- [ ] Record any signing or Gatekeeper/SmartScreen feedback.

---

## Known gaps

These are real limitations, not TODOs that are already handled elsewhere:

| Gap | Consequence |
| --- | --- |
| No code signing or notarization | Gatekeeper and SmartScreen warn or block; unsuitable for broad public distribution |
| No auto-update | Users must download and install each release manually |
| No published release automation | CI builds, hashes and attaches to a **draft**; a human publishes it |
| No dependency audit or SBOM | `npm ci`, SHA-pinned actions and review are the only supply-chain controls |
| No packaged-app smoke test for macOS or the NSIS-family formats | The MSI and the Linux packages are installed or booted by CI; the DMG, NSIS installer, portable exe and zip still need a human launch |
| No x64 app verification on Apple Silicon | The config requests x64, but only arm64 has been exercised locally |
| No rollback automation | Rollback is a manual file restore with a quarantine step |
| Unsigned native module | `better-sqlite3-multiple-ciphers` is unpacked from asar; integrity depends on the installer signature (which does not exist yet) |
| Encryption at rest has only run **packaged** on macOS, with a passphrase | The keyed open path, the unlock prompt, both directions of the transition and the keyed folder move ran in `release/mac-arm64/WageRoute.app` on 2026-11-04 ([UNRELEASED.md](UNRELEASED.md)'s Batch 57). A packaged build has still never written a **device** wrap — `safeStorage` behaves differently in a signed, installed app on a real login — nothing has run on Windows or Linux, and no packaged run has been interrupted mid-transition. The first release that ships the toggle owes the manual proof in the preflight checklist for those, and until they are done no document may promise them |
| The phone's cipher has never run on a handset | The vault and the sealed export are proved in Node's WebCrypto, jsdom and Chromium-through-Electron. No iPhone or Android device has sealed a copy, re-sealed on a save, or come back locked after a restart — see [POCKET.md](POCKET.md#status-what-has-been-proved-and-what-has-not) |
| GitHub Pages has never been enabled for Pocket | The phone app exists in the repository and has never been published, so no release has ever had a live phone build to test against |

Closing any of these changes the release process. Record the decision before implementing it.

# Deployment and data movement

**Short answer: WageRoute is local-only today.** There is no hosted service, no cloud account, no sync engine and no automatic update. The application is a desktop binary that reads and writes one SQLite file on the machine where it is installed — plus, when the owner turns encryption on, the `ledger.key.json` marker beside it, which holds the key only as a wrap; the installers open no port at all. The one exception this repository offers is opt-in: the two images in `docker/` run the apps locally and publish to `127.0.0.1` by default, and are covered under [Running WageRoute in a container](#running-wageroute-in-a-container). Files move between machines only when you export and import them.

This document separates what exists from what has been discussed. It also records the repository-hosting recommendation.

---

## Contents

- [Status matrix](#status-matrix)
- [What “deployment” means for WageRoute](#what-deployment-means-for-wageroute)
- [Where data lives](#where-data-lives)
- [Encryption at rest and key custody](#encryption-at-rest-and-key-custody)
- [Legacy data adoption](#legacy-data-adoption)
- [Current distribution](#current-distribution)
- [Install scripts](#install-scripts)
- [Homebrew tap](#homebrew-tap)
- [Running WageRoute in a container](#running-wageroute-in-a-container)
- [Multi-device today](#multi-device-today)
- [Sync status](#sync-status)
- [Auto-update status](#auto-update-status)
- [Repository hosting: GitHub or GitLab](#repository-hosting-github-or-gitlab)
- [Operational checklist](#operational-checklist)
- [Decision log](#decision-log)

---

## Status matrix

| Capability | Status | Evidence / notes |
| --- | --- | --- |
| Local desktop app (macOS, Windows, Linux) | **Implemented** | Electron + electron-builder DMG/NSIS/MSI/portable/zip/AppImage/deb/rpm |
| Local SQLite persistence | **Implemented** | `wageroute.db` in Electron `userData`, plus `ledger.key.json` in the same folder when encryption is on |
| Manual JSON backup and two-way merge on import | **Implemented** | Settings → Data; a full backup can be written plain or sealed with a passphrase |
| Manual CSV export and entries import | **Implemented** | Settings → Data |
| Unsigned installer builds | **Implemented** | Local scripts and GitHub Actions artifacts |
| CI build on demand / version tag | **Implemented** | `.github/workflows/build.yml` |
| Published GitHub release | **Implemented** | 1.0.0–1.2.0 published on `ReVax-2007/wageroute`; CI uploads the artifacts and the release is assembled by hand |
| Code signing / notarization | **Not implemented** | No certificates or config |
| Automatic updates | **Not implemented** | No `electron-updater`, no publish config |
| Cloud backup | **Not implemented** | No provider, no credentials, no code |
| Multi-device sync | **Not implemented** | Schema is sync-ready only |
| Server or API | **Not implemented** | No backend in the repository |
| User accounts or login | **Not implemented** | One local user row, and [ADR 0030](decisions/0030-self-hosting-puts-identity-at-the-edge.md) keeps it that way: the login is the edge's job, never the app's |
| Bank connections / statement sync | **Not implemented** | Manual entry and file import only |
| Telemetry / analytics / crash reporting | **Not implemented** | No network calls in app code |
| Encryption at rest | **Implemented, opt-in, unreleased** | Off by default and never imposed. When the owner turns it on: `chacha20` over the ledger file and its own `backups/` copies, with the key wrapped by this computer's keychain, a passphrase, or either of both. Reversible from the same screen. [ADR 0029](decisions/0029-encryption-is-a-choice-on-the-disk-and-on-the-way-out.md); the whole transition has now run in the packaged macOS build with a passphrase-held key — a shipped build has never written a device wrap — and OS full-disk encryption stays the control for everyone who leaves it off |
| Mobile or web client | **Implemented, unreleased** | WageRoute Pocket: a static installable phone app in `src/pocket`, served by any static host or by `docker/pocket.Dockerfile`. It ships in no installer, and no real handset has run it |
| Sealed export and phone vault | **Implemented, unreleased** | `wageroute-envelope` v1 read and written on both devices; the phone's own IndexedDB copy can be sealed (`wageroute-vault` v1). Both need a secure origin on the phone, and neither is in the published `1.2.0` |
| Container images | **Built, not published** | `docker/pocket.Dockerfile`, `docker/desktop.Dockerfile`, `docker-compose.yml`; `.github/workflows/docker.yml` publishes both to ghcr.io and has never run |
| Multi-user tenancy | **Not implemented in the app** | `user_id` exists but one user is seeded. [ADR 0030](decisions/0030-self-hosting-puts-identity-at-the-edge.md)'s answer is one container per person behind a proxy, and `docker-compose.yml`'s `edge` profile is that worked example — two such tenants were run side by side on 2026-11-04, and it has never run on a handset |
| TLS and a login in front of a container | **Worked example, not app code** | `docker/edge.Caddyfile` and the `edge` compose profile: Caddy terminates TLS and forward-authenticates before it proxies anything. The app has no certificate and no session, on purpose. Validated and driven against forward-auth stubs on 2026-11-04, with two tenants at once — see [TLS, a login, and more than one person](#tls-a-login-and-more-than-one-person) |

The schema contains UUIDs, `updated_at`, `revision` and `deleted_at` because a future sync layer was anticipated. That is preparation, not implementation. No sync behaviour, provider or conflict policy has been agreed.

## What “deployment” means for WageRoute

There are four different things people usually mean:

1. **Installing the app.** Today: build an unsigned DMG, NSIS/MSI/portable/zip or AppImage/deb/rpm installer and run it locally. The app is self-contained; an installer has nothing to host.
2. **Distributing the app.** Today: share the installer manually or download a CI artifact. There is no release channel, store listing or update feed.
3. **Deploying a backend.** There is no backend. Nothing is deployed to a server, and no data leaves the machine.
4. **Hosting the phone app, or running the desktop from a container.** Both are in [Running WageRoute in a container](#running-wageroute-in-a-container). Neither changes the first three: a container changes where the code runs, not the fact that the ledger lives on one disk and moves only in a file you carry.

Only the first two exist, and both are manual. The third has not been designed. The fourth exists as an option you have to choose and build yourself — see [Running WageRoute in a container](#running-wageroute-in-a-container).

## Where data lives

Electron resolves `app.getPath('userData')` from the product name set at startup (`WageRoute`). The database file is `wageroute.db`.

| Platform | Directory | Database |
| --- | --- | --- |
| macOS | `~/Library/Application Support/WageRoute/` | `wageroute.db` |
| Windows | `%APPDATA%\WageRoute\` | `wageroute.db` |
| Linux (development) | `~/.config/WageRoute/` | `wageroute.db` |

While the app is running, SQLite also creates:

- `wageroute.db-wal` — write-ahead log containing recent commits;
- `wageroute.db-shm` — shared-memory index for the WAL.

**Copy all three files together** if you copy the database while WageRoute is open. For a clean copy, quit the app first; closing checkpoints the WAL.

When encryption is on there is a fourth file, and it is not optional: `ledger.key.json`, written `0600` in the same folder, holding the data key only as wraps. **Copy all four** — a keyed `wageroute.db` on its own opens nowhere, not in WageRoute and not in `sqlite3`.

The database is plaintext unless the owner turns encryption on in Settings. That is deliberate: a default install is protected by the OS account and by full-disk encryption, and FileVault (macOS) or BitLocker (Windows) remains the control for a lost or stolen device. With encryption on, the file no longer presents itself as SQLite at all, and an older build — the published `1.2.0` included — refuses it as `SQLITE_NOTADB`. File permissions are those of your OS user account either way.

The sidebar and Settings show the live absolute path, which is the quickest way to confirm which file the running app is using.

### Development profiles

Electron uses `CFFIXED_USER_HOME` on macOS to relocate the application data home. Running with a temporary home is the safe way to test first-launch behaviour without touching real data:

```bash
CFFIXED_USER_HOME=/tmp/wageroute-test npm run dev
```

This produces `/tmp/wageroute-test/Library/Application Support/WageRoute/` and never opens the real ledger.

## Encryption at rest and key custody

WageRoute offers encryption and does not impose it. This section is the deployment half of that: what changes about folders, copies, containers and downgrades when the owner says yes. The threat model and the guarantees are in [SECURITY.md](SECURITY.md#encryption-at-rest-and-key-custody).

**What turning it on does.** Every page of `wageroute.db` is rewritten as `chacha20` ciphertext through the cipher driver, and the app's own dated copies in `backups/` follow the ledger from then on. `ledger.key.json` appears in the same folder, written `0600`, carrying the 32-byte data key only as **wraps** — never the key itself. Both directions take a `VACUUM INTO` pre-copy first, record a `pending` marker, verify the result on a fresh connection, delete the safety copy once it has, and restart the app.

**Who holds the key is a separate choice, and it is reversible.** *This computer* wraps the key with Electron's `safeStorage`, so the OS keychain answers to the account login — not to a fingerprint. *A passphrase* wraps it with scrypt (`N=32768, r=8, p=1`) and AES-256-GCM; the phrase is used once and then forgotten, and WageRoute keeps no copy. *Both* means either one opens the ledger. Changing custody re-wraps the same 32 bytes and rewrites nothing, so it is instant and repeatable, and it is the reason the choice can be revised after the fact.

**What a locked ledger means for the running app.** The launch opens the ledger before it registers any IPC, so a locked one is not a greyed-out window: there is no ledger window, and no ledger channel a renderer could ask a question of. Only the unlock prompt exists, with a masked passphrase field and a show toggle. Plan for that on any machine where somebody might walk up to a locked app and want the money figures — the phrase is the only way in when the device wrap is not custody.

**Folders, volumes and copies.** Anything that copies the ledger copies `ledger.key.json` with it, in the same directory, or the copy is a closed file. That covers a manual copy, a synced folder, a NAS share, a `docker` volume and a migration to another machine. The in-app move to a chosen data folder carries the key file for you, and the test that proves it re-opens the ledger in the new folder and reads the money back. A `docker volume rm` destroys both at once.

**Headless and container use.** A container has no keychain, so `deviceCustodyAvailable()` reports false and the *This computer* option is not offered — a ledger encrypted in one of the images is held by a passphrase and nothing else. Over the streamed desktop session the passphrase is typed into a window that is being shared with you, so treat that session's password as part of the custody story rather than as a separate one.

**Downgrades, and why a plain export is the escape hatch.** A keyed `wageroute.db` is not a file any build without the cipher can open — the published `1.2.0` gets `SQLITE_NOTADB` and will not migrate or repair it. That was watched rather than reasoned on 2026-11-04: installed 1.2.0 pointed at a byte copy of a keyed ledger logged the error twice, opened no window, and left the file byte-identical. Take a **plain** (unsealed) JSON backup before switching builds; it is the only copy that survives a downgrade in either direction.

**What has not been proved.** The transition has now run end to end in the packaged macOS app on scratch ledgers — enable, unlock prompt after the restart, read the rows back, disable — and the keyed folder move and return ran there too. Still unproven in an installed build: a **device** wrap (only a passphrase has ever written one outside a dev build), a Windows or Linux artifact, the native folder picker and save dialogs, and restoring a Settings copy into or over a keyed ledger. The open checks are listed in [UNRELEASED.md](UNRELEASED.md#before-the-next-build); treat anything they name as unverified rather than as risky. Nothing here promises an unlock duration: the passphrase cost has never been measured on the hardware users have.

## Legacy data adoption

The app was previously named **Cash Flow Routing**. That name produced a different `userData` directory and a different database filename.

On startup, before opening the database:

1. If `WageRoute/wageroute.db` already exists, do nothing.
2. Otherwise look for `Cash Flow Routing/cash-flow-routing.db` under Electron's `appData` directory.
3. If found, create the new directory and copy:
   - `cash-flow-routing.db`
   - `cash-flow-routing.db-wal` (if present)
   - `cash-flow-routing.db-shm` (if present)
4. Leave the original files untouched.
5. Open the new copy and run migrations normally.

Properties of this approach:

- it runs only when the new database is absent, so it never overwrites newer data;
- it copies rather than moves, so the old install remains usable;
- copying the WAL and SHM preserves commits that had not yet been checkpointed;
- it reads the source's 16-byte magic first, so a legacy file whose header is not SQLite's — which is what an encrypted ledger's first bytes are — is refused with a stated error rather than copied, checked or renamed;
- it runs before `getDatabase()`, so the app never creates an empty new database first;
- if no legacy database exists, it is a no-op and the seed runs.

The code lives in [`src/main/db/legacy.ts`](../src/main/db/legacy.ts).

## Current distribution

### Local builds

| Command | Output |
| --- | --- |
| `npm run build` | `out/main`, `out/preload`, `out/renderer` |
| `npm run dist:mac` | `release/*.dmg` for arm64 and x64 |
| `npm run dist:win` | `release/*.exe` (NSIS + portable), `*.msi` and `*.zip` for x64 and arm64 — MSI only on Windows (WiX) |
| `npm run dist:linux` | `release/*.AppImage`, `*.deb`, `*.rpm` for the **host** architecture only |
| `npm run dist` | Current platform default target |

`dist:mac` and `dist:win` pass `--x64 --arm64` explicitly; `dist:linux` passes neither, so it builds the host architecture (CI runs one job per Linux architecture instead). The config does not declare arches per target.

`release/` and `out/` are gitignored.

### CI

The GitHub Actions workflow at [`.github/workflows/build.yml`](../.github/workflows/build.yml):

- triggers on `workflow_dispatch` and on tags matching `v*`;
- runs a matrix of `macos-latest`, `windows-latest`, `ubuntu-latest` (`--linux --x64`) and `ubuntu-24.04-arm` (`--linux --arm64`);
- installs Node 24 with npm caching;
- runs `npm ci`, `npm run lint`, `npm test` and `npm run build` — the same gate as the `verify` job in [`.github/workflows/ci.yml`](../.github/workflows/ci.yml);
- packages with `npx electron-builder <arch flag> --publish never`;
- smoke-tests the Windows MSI (silent install, launch, database created, reinstall stays one entry, clean uninstall) and launches the Linux AppImage and the extracted deb under `xvfb-run`;
- uploads the installers as build artifacts named `wageroute-mac`, `wageroute-win`, `wageroute-linux-x64` and `wageroute-linux-arm64`;
- on a tag push, attaches the raw installers to a **draft** GitHub Release.

It does **not**:

- run `npm run typecheck` separately (the build does the type check);
- launch the macOS DMG, the NSIS installer, the portable exe, the zip or the rpm;
- sign or notarize the macOS app;
- sign the Windows installers, MSI, portable exe or zip;
- sign the Linux packages;
- publish the draft release, or create a tag;
- publish to a store;
- upload to any external service.

The artifacts are unsigned development builds. macOS Gatekeeper, Windows SmartScreen and some Linux package managers will warn when they are opened on another machine.

### Windows installation and security friction

Because the Windows builds are currently unsigned, Windows and modern web browsers (Microsoft Edge, Google Chrome) apply two successive security gates:

1. **Browser download quarantine (SmartScreen / Safe Browsing):**
   - When downloading `WageRoute.Setup.<version>.exe`, `WageRoute-<version>.portable.exe`, or `.msi`, Microsoft Edge flags the file:
     *"WageRoute.Setup.exe was blocked because it could harm your device"*.
     *Resolution:* Hover over the download item in Edge → select **`...`** (More actions) → click **Keep** → click **Show more** → select **Keep anyway**.
   - In Google Chrome, click the download warning icon in the top toolbar or downloads list → select **Download suspicious file** (or **Keep anyway**).
2. **Mark of the Web & Windows SmartScreen:**
   - Web browsers tag all downloaded files with an NTFS Alternate Data Stream named `Zone.Identifier` (ZoneId=3, Mark of the Web).
   - When the user runs the `.exe`, Windows Defender SmartScreen blocks execution with a blue dialog:
     *"Windows protected your PC — Microsoft Defender SmartScreen prevented an unrecognized app from starting."*
     *Resolution:* Click **More info** → click **Run anyway**.
   - *Manual file unblock:* Right-click the `.exe` in File Explorer → choose **Properties** → on the **General** tab check the **Unblock** box at the bottom → click **Apply** / **OK**.
3. **PowerShell / CLI bypass (avoids Mark of the Web):**
   - Just like `curl` on macOS avoids the Gatekeeper quarantine attribute, downloading through PowerShell or `curl.exe` on Windows does not set the `Zone.Identifier` alternate stream:
     ```powershell
     curl.exe -LO https://github.com/ReVax-2007/wageroute/releases/download/v1.2.0/WageRoute.Setup.1.2.0.exe
     .\WageRoute.Setup.1.2.0.exe
     ```
   - If an existing file is already blocked by Windows, it can be unblocked via PowerShell:
     ```powershell
     Unblock-File -Path .\WageRoute.Setup.1.2.0.exe
     ```

### Linux installation, permissions and dependencies

1. **AppImage execution permissions:**
   - Linux browsers download AppImages without the executable bit set. Launching an AppImage requires:
     ```bash
     chmod +x WageRoute-1.2.0-x86_64.AppImage
     ./WageRoute-1.2.0-x86_64.AppImage
     ```
2. **FUSE 2 dependency on modern distributions (Ubuntu 22.04+, Ubuntu 24.04+, Debian 12):**
   - Standard AppImages require `libfuse.so.2` to mount the internal filesystem image. Modern Ubuntu distributions do not include FUSE 2 by default and will fail with `dlopen(): error loading libfuse.so.2`.
   - Install the compatibility library:
     - Ubuntu 24.04 LTS: `sudo apt install libfuse2t64`
     - Ubuntu 22.04 LTS: `sudo apt install libfuse2`
   - Alternatively, run without FUSE:
     ```bash
     ./WageRoute-1.2.0-x86_64.AppImage --appimage-extract-and-run
     ```
3. **Native package manager installations (.deb and .rpm):**
   - Native packages do not require FUSE and integrate directly into the desktop environment and system launcher:
     - Debian / Ubuntu / Mint: `sudo apt install ./WageRoute-1.2.0-amd64.deb`
     - Fedora / RHEL / openSUSE: `sudo dnf install ./WageRoute-1.2.0-x86_64.rpm`

## Install scripts

`install.sh` (macOS and Linux, POSIX `sh`) and `install.ps1` (Windows PowerShell 5.1 and PowerShell 7) live at the repository root, so GitHub Pages serves them at `https://revax-2007.github.io/wageroute/install.sh` and `/install.ps1`.

| Step | `install.sh` | `install.ps1` |
| --- | --- | --- |
| Release | latest (the tag `releases/latest` redirects to), or `--version vX.Y.Z` | latest (GitHub API, falling back to the redirect), or `-Version` / `$env:WAGEROUTE_VERSION` |
| Asset | `WageRoute-<v>-arm64.dmg` / `-x64.dmg`; `-amd64.deb` / `-arm64.deb`; `-x86_64.rpm` / `-aarch64.rpm`; `-x86_64.AppImage` / `-arm64.AppImage` | `WageRoute.Setup.<v>.exe` |
| Verify | refuses unless the file's SHA-256 matches its line in the release's `SHA256SUMS` | the same, with `Get-FileHash` |
| Install | macOS: `hdiutil attach` → `ditto` into `/Applications` (or `~/Applications`, or `--dir`) → `xattr -dr com.apple.quarantine` and `com.apple.provenance`. Linux: `apt-get install ./…deb`, else `dnf`/`zypper install ./…rpm`, else (no package manager, no `sudo`, or `--appimage`) the AppImage in `~/.local/bin` plus `~/.local/share/applications/wageroute.desktop`, with the FUSE 2 command printed if `libfuse.so.2` is missing | `Unblock-File`, then the NSIS installer with `/S /currentuser` |
| Dry run | `--dry-run` | `-DryRun` / `$env:WAGEROUTE_DRY_RUN = '1'` |

Both refuse to run over a running WageRoute (macOS and Windows), never read or write the data folders, and work in a temporary folder they remove on exit. `install.sh` calls its `main` on the last line, so a download cut short runs nothing.

The `install-scripts` job in `.github/workflows/ci.yml` runs them against the real latest release on Ubuntu (`.deb`), macOS (`/Applications`, quarantine flag checked absent, signature verified) and Windows (PowerShell 5.1 install, PowerShell 7 piped dry run) on every pull request.

## Homebrew tap

macOS releases are also published to a custom tap, [`ReVax-2007/homebrew-wageroute`](https://github.com/ReVax-2007/homebrew-wageroute). Homebrew downloads the DMG itself, pins the exact SHA-256 of each installer in the cask, and replaces the app in `/Applications` on upgrade.

Install and update:

```bash
brew tap ReVax-2007/wageroute
brew install --cask wageroute          # first launch still needs right-click → Open
brew upgrade --cask wageroute
```

Notes:

- Homebrew quarantines cask downloads by default, so the first launch still needs right-click → **Open**. To remove the flag instead, run `sudo xattr -rd com.apple.quarantine /Applications/WageRoute.app`. Either way, the checksum was verified before install, unlike a manual browser download.
- On Homebrew 7+, tapping for the first time asks you to trust the tap once (`brew trust revax-2007/wageroute`).
- Uninstalling (`brew uninstall --cask wageroute`) removes only the app. The ledger database under `~/Library/Application Support/WageRoute` is deliberately not in the cask's `zap` list, so `brew uninstall --zap` cannot wipe your data either.
- The cask tracks one version at a time. Updating it is part of the release procedure; see [RELEASING.md](RELEASING.md#release-checklist).

## Running WageRoute in a container

Both Dockerfiles are multi-stage: the image builds the app from the source in the build context, so a container never depends on a folder you built earlier on your own machine, and the runtime layer carries only what it needs to run.

`docker compose up --build` starts both. Compose publishes each port to `127.0.0.1` only, on purpose — see the caveats below.

### Pocket in a container

```sh
docker build -f docker/pocket.Dockerfile -t wageroute-pocket .
docker run --rm -p 127.0.0.1:8173:80 wageroute-pocket
```

The image is 77 MB and contains nginx plus the files `npm run pocket:build` writes: no Node, no toolchain, no source. `npm ci` runs with `--ignore-scripts`, so neither the Electron binary download nor the driver's install step is ever fetched — nothing in the phone app's import graph reaches them.

It is the same static folder as any other host, with two things a plain file drop usually gets wrong:

- `Content-Security-Policy: frame-ancestors 'none'` as a real header, which the `<meta>` policy in the HTML cannot carry.
- `Cache-Control` split the way the offline shell needs: `index.html`, `sw.js` and the manifest are revalidated on every load so a new release lands on the next open, while `/assets/` — filenames that contain their own content hash — is cached as immutable.
- `manifest.webmanifest` is served as `application/manifest+json`, because a manifest served as `text/plain` makes Chrome refuse the install prompt.

It is still plain HTTP. `http://localhost:8173` is a secure origin, so the service worker runs, the app works offline on the machine running the container, and the page has a cipher it can use. The `127.0.0.1:` in the mapping is deliberate and it also means a handset **cannot reach this container at all**; to serve a phone, republish the port on your LAN address (`-p 8173:80`, which binds every interface, or `-p 192.168.x.x:8173:80`) and put TLS in front — plain HTTP on a LAN address gives a page that loads with no service worker, no install prompt and **no cipher at all**: Pocket can neither seal an export nor open one, and seals its own copy there. TLS is therefore a functional requirement for the phone's encryption, not only a transport nicety. TLS in front means your own certificate on a reverse proxy, or a tool that issues one automatically for a private network.

### The desktop in a container

```sh
docker build -f docker/desktop.Dockerfile -t wageroute-desktop .
docker run --rm --shm-size=1g -p 127.0.0.1:6080:6080 -v wageroute-data:/data wageroute-desktop
```

Docker gives `/dev/shm` 64 MB unless the run raises it, and Electron dies mid-paint when the shared memory it needs is not there. `--disable-dev-shm-usage` — which the container always passes — makes Chromium use `/tmp` instead, and a container measured at the 64 MB default did start, render and stay up. Raising `/dev/shm` is the recommendation, not a gate; `docker compose up --build` sets it for you.

This is **not** the app running as a web service. The renderer talks to a preload IPC bridge with no HTTP server behind it, so there is no browser build of the desktop to serve. What the container does instead is run the real Linux Electron build against an X display (Xvfb), export that display over VNC to loopback inside the container (x11vnc), and put noVNC on port 6080 so a browser shows the desktop window and forwards keyboard and mouse to it. `electron-builder --linux --dir` builds it; the resulting bundle carries `resources/LICENSE` and `resources/THIRD-PARTY-NOTICES.txt` like the installers do.

Read all of this before pointing it at a real ledger:

| | |
| --- | --- |
| **The ledger is inside a volume** | `HOME=/data`, so settings, `wageroute.db`, `ledger.key.json` when encryption is on, the crash log and the app's own `backups/` copies all live in the named volume. The two are a pair: a keyed ledger without its marker in the same volume opens nowhere. `docker volume rm` deletes the ledger as far as the app is concerned; the only other copy is the last export you carried out. |
| **Files you import must be inside the container** | The open dialog shows the container's filesystem, not yours. Mount the folder your backups live in (`-v ~/Downloads:/data/imports`) or `docker cp` the file in first. |
| **Chromium's sandbox is off** | `--no-sandbox` is what lets Electron start as root in a container. The renderer isolation the desktop app relies on is therefore not in force, which is the main reason to keep this to a machine you trust. |
| **One session, one container** | Electron's single-instance lock means one app process; every browser that connects to port 6080 watches and controls that same desktop, cursor included. |
| **The VNC password is not secret in transit** | noVNC sends it over the websocket. On `127.0.0.1` that is the loopback interface; published to your network in plain HTTP it is readable by anyone on it. If `WAGEROUTE_VNC_PASSWORD` is unset, the container generates one and prints it to its log. |
| **It is Linux x64/arm64 only** | There is no macOS or Windows container path. On Apple Silicon the image is built for `arm64`; the CI workflow builds `amd64`. |
| **It is slower than the installer** | Software rendering, no GPU, no keychain — so a ledger encrypted in this container can only be held by a passphrase —, no system file portal, and every keystroke makes a round trip through a websocket. The installers remain the way to use this app. |

### TLS, a login, and more than one person

Both images above publish to `127.0.0.1`, which is honest about what they are: a machine running its own apps. The moment you want a phone to open Pocket, or a second person to have their own ledger, you are asking for two things WageRoute deliberately does not have — a certificate and a login. [ADR 0030](decisions/0030-self-hosting-puts-identity-at-the-edge.md) decides where they go: **at the edge, in a proxy you already run, never in the app.** The app stays single-tenant. There is no login screen, no credential store, no session and no per-request identity in this repository, and a second person costs a second pair of containers and a second volume, not a second user row.

That is the whole reason this section exists rather than a "users" feature: an app that cannot tell two humans apart cannot be misconfigured into showing one of them the other's money. The isolation is a process boundary and a volume.

**The shapes, all of them supported by this design and none of them implemented by this app:**

| Shape | What it costs you | What it gives you |
| --- | --- | --- |
| Loopback only, no auth *(today's default)* | nothing | a phone cannot reach it; only this machine's browsers can |
| TLS, no login | a certificate your devices trust | Pocket is then *able* to install on a handset — the browser rule, never demonstrated on a device here; the desktop's VNC password stops crossing the wire in the clear; anyone who can resolve the name still gets in |
| TLS + a password at the edge | a proxy and one auth provider | only a person with that password reaches the ledger |
| TLS + TOTP or a passkey at the edge | the same, plus an identity provider that offers it | the shape most people actually want — see the caveat below |
| Back to the laptop | deleting that tenant's two containers and its volume | the installers, the keychain, and no proxy to maintain |

Moving between them changes nothing about the data: the ledger's file format is identical in every one, because the choice lives outside the app. Which is ADR 0022's data-folder rule again, not a new mechanism.

**The worked example** is `docker-compose.yml`'s `edge` profile plus `docker/edge.Caddyfile`. Nothing in the default shape changes — these services are behind a compose profile, so `docker compose up` still starts exactly the two loopback containers it started before:

```sh
COMPOSE_PROFILES=edge \
WAGEROUTE_DOMAIN=ann.example.lan \
WAGEROUTE_AUTH_UPSTREAM=192.168.1.9:9091 \
WAGEROUTE_AUTH_URI=/api/authz/forward-auth \
WAGEROUTE_BIND=192.168.1.20 \
docker compose up -d --build caddy pocket-ann desktop-ann
```

Naming the three services is what keeps the default pair from starting too: one shape or the other, never a half-mixed set. Caddy terminates TLS with its own local CA, asks your provider whether this connection may come in — `200` means proxy it, anything else means the browser sees the provider's answer instead — and then sends the request to **Ann's** container. Traefik does the same job with different syntax; the file is an example of the shape, not a dependency.

The three `WAGEROUTE_*` values the edge needs have no defaults, and the container says so and refuses to start rather than serving a site called `pocket.` — the guard runs before Caddy does. They are set that way *instead of* with compose's `${VAR:?error}` for one reason: that syntax is evaluated while parsing the whole file, so it would have broken `docker compose up` for everyone who never turns this profile on.

**How it fails closed**, in the order that matters:

1. `WAGEROUTE_BIND` defaults to `127.0.0.1`. An edge configured halfway is a proxy nobody can reach, not a ledger everybody can. Publishing it on a LAN address is a value you type.
2. The tenant containers publish **no ports at all**, so there is no address to walk past the login with. Measured with two tenants up on 2026-11-04: `docker ps` listed only exposed container ports (`80/tcp`, `6080/tcp`) with no host binding on either tenant, and from the Docker host itself Ann's own container address (`172.18.0.3:80`) simply did not answer — curl timed out after 4 s. What was *not* measured is the same attempt from a second physical machine: that the proxy is the only address reachable from elsewhere on the LAN rests on Docker's own rule that an unpublished container IP is not routable off the host, not on a demonstration here.
3. `forward_auth` proxies nothing unless the auth request answers `2xx`. If your provider is down, unreachable, or misconfigured, the result is an error page, not an open ledger.
4. Nothing reads a header to choose a folder. The *site block* chooses the upstream, so a typo in a name shows a Caddy error rather than someone else's money.
5. A keyed ledger inside a container is keyed **by passphrase**: `safeStorage` has no keychain to reach there, so `deviceCustodyAvailable()` reports false and the device option is withheld with its reason ([ADR 0029](decisions/0029-encryption-is-a-choice-on-the-disk-and-on-the-way-out.md)). `ledger.key.json` lives in the *same* volume as the ledger, which means one deleted volume takes both — and the volume is also where the app's own daily `backups/` copies are, so the export you carry out is the only copy that survives it.
6. Coming *down* from this shape needs the profile named again. A plain `docker compose down` skips services behind `profiles:` and leaves the proxy listening; `COMPOSE_PROFILES=edge docker compose down` is what actually closes the door, and adding `-v` takes the volumes — the ledger and its key file, and Caddy's CA — with it. Verified the hard way on 2026-11-04: the un-profiled `down -v` reported the network "still in use" and left Caddy up.
7. If you extend this into several tenants and mark their networks `internal: true`, the proxy needs a network that is *not* internal, or nothing can reach it. Found on 2026-11-04 in a two-tenant scratch stack: with every network internal, Docker kept the `127.0.0.1:443` request in `HostConfig` but published no host port at all — `docker port` was empty and the symptom was an unreachable site, not an error. The repo's own single-tenant `edge` shape does not use `internal:` and is not affected.

**What you have to do about the certificate.** `tls internal` gives you a real CA on your own network, and Caddy's root lives in the `wageroute-caddy` volume at `/data/caddy/pki/authorities/local/root.crt`. Phones and laptops will not trust it until you put it in their trust stores — `docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt ./caddy-root.crt`, then install it (a profile on iOS, Settings → Certificates on macOS, the platform's own import elsewhere). There is no shortcut here that is honest: a private name has no public CA, so either your devices trust your CA or every one of these pages shows a warning. Deleting that volume means every device that trusted it says *not secure* again. If you have a DNS server and can run an ACME-capable issuer instead, do that; the app cannot tell the difference.

A phone also needs the *names* to resolve on your network — `pocket.ann.example.lan`, and `desktop.ann.example.lan` for the streamed desktop, because the two site blocks are built as `pocket.{$WAGEROUTE_DOMAIN}` and `desktop.{$WAGEROUTE_DOMAIN}`; the bare `ann.example.lan` matches no site block, so its TLS handshake fails outright (measured on 2026-11-04: a `tlsv1 alert internal error`, curl exit 35) and nothing is served. One local DNS entry, or one `/etc/hosts` line per device per name. That is the chore ADR 0030 names as a cost rather than a convenience.

**What this proves and what it does not.** On 2026-11-04 this shape was run locally, end to end, against the images built from this tree: Caddy validated (`caddy validate`, 2.11.7), `docker compose config` renders the default shape with no extra environment and the `edge` shape with it, and through the proxy `https://pocket.ann.test/` answered **401 with the auth stub's own body** (nothing proxied) and **200 with a session cookie**, with `sw.js`, the hashed bundle and `content-security-policy: frame-ancestors 'none'` all arriving over TLS whose chain verified against the extracted root; `desktop.ann.test/vnc.html` did the same, and the unset-value guard exited 1 with its message.

Later the same day the shape was run with **two tenants at once** — Ann and Bob, four site blocks, one proxy, two volumes, two forward-auth stubs — and these were measured, not assumed:

- all four endpoints answered `200` over the one certificate chain at the same time;
- the Pocket bundle served to each was byte-identical (`sha256 a568b351…`), which is the plainest possible proof that nothing in either container knows which person it is serving;
- from inside each tenant's own container, the other tenant's service name did not resolve and its HTTP address was unreachable, both directions;
- each ledger sat on its own volume with its own inode and its own marker file, and neither container could see the other's;
- when *Ann's* stub was switched to answer `401`, both of Ann's endpoints went dark while **both of Bob's stayed up**, and Ann's Pocket container logged **zero** new requests — the door closed before the app, per tenant;
- the second tenant costs about **205 MiB** idle (its desktop container 192-198 MiB, its Pocket container 9-10 MiB) on an Apple Silicon Docker Desktop VM capped at 7.75 GiB; the proxy itself holds around 19-20 MiB whatever the tenant count. So the streamed desktop half is ~95 % of the per-person cost, and a phone-only deployment is ~10 MiB per person.

**Still not proved, and no measurement above changes it.** **None of it is a handset test**: no iPhone or Android device has opened this shape, no device has had the CA installed for it, and the browser rule that a secure origin is what unlocks `crypto.subtle` was applied here from the documented behaviour rather than measured on a phone. The two-tenant run used two Caddy stubs standing in for a real identity provider, so *what a provider actually returns* — its redirect, its cookie, its session lifetime — is still the operator's configuration and still untested here. The memory figures are idle containers on `arm64`; the `amd64` images the CI workflow builds have never run, so the numbers do not transfer to an Intel box. And one tenant is one ledger: nothing measured above says a person behind the door is limited to part of it, because there is no such thing as part of it.

**What this layer does not give you**, stated because a proxy is easy to over-trust:

- **A person through the door sees the whole tenant.** The app has no idea who walked in; there is no per-row authorization behind the proxy, because there is no identity to authorize. One tenant is one ledger and everyone the edge lets through is its owner.
- **Passkeys at the edge are unproven for this product.** WebAuthn needs a registrable domain as its `rpId`, and `127.0.0.1` — or a `.lan` name — is not one. If your provider can register under a real domain you own, this shape works for it; nothing here promises it.
- **No admin console, no quotas, no billing, no per-tenant backup schedule.** Adding a person means adding a volume, a container and two site blocks.
- **No sync between tenants, ever.** Two ledgers on one host are two files; carrying a backup by hand or merging two copies by time ([ADR 0024](decisions/0024-two-copies-merge-by-time.md)) is still the supported answer.
- **If someone forgets their edge password, we cannot help.** That is your edge's own reset flow, and ADR 0030 is the reason it has to be.

### Publishing the images

`.github/workflows/docker.yml` builds both and pushes them to `ghcr.io/<owner>/wageroute-pocket` and `…/wageroute-desktop`: a version tag push publishes `<version>` and `latest`, a manual run publishes `sha-<commit>` only. It uses the runner's own docker CLI, so the workflow adds nothing to the supply chain beyond the pinned checkout. **The workflow exists and has never run**, and the first push to GHCR creates the package as private — making it public is an owner action. Publishing images is a deployment, not a release: no installer contains them and no release requires rebuilding them.

## Multi-device today

There is no sync. The only supported ways to move data are:

1. **JSON backup** — full or partial, merged on import (newer row wins, tombstones delete).
2. **CSV export/import** — entries only, matched by account name.

### Copying the same database

Copying `wageroute.db` (plus WAL/SHM, plus `ledger.key.json` if the ledger is encrypted) to another machine preserves IDs and links. It is a snapshot, not a merge. Once both copies diverge, importing one into the other adds rows with new IDs and replaces a shared row only when the file's copy is newer; the other edit is lost without a prompt ([ADR 0024](decisions/0024-two-copies-merge-by-time.md)). A **keyed** copy is not portable in any useful sense: it opens only in a build with the cipher and only with its key file beside it, so a plain JSON export is the one form that survives a downgrade.

Recommended procedure:

1. Quit WageRoute on both machines.
2. Copy the three database files — four, if the folder holds `ledger.key.json`.
3. Open the copy on the destination.
4. Never run two divergent copies and expect automatic reconciliation.

### Importing one device into another

JSON import merges by row identity:

- a row the ledger does not have is added;
- a row with the same ID is replaced when the file's `updated_at` (then `revision`) is newer, and left alone otherwise;
- a newer tombstone deletes the local row; an older live copy cannot resurrect it;
- duplicate account names with different IDs are **not** merged;
- settings merge per key by the same newer-wins rule; a backup imported into an empty profile supplies the settings too.

This is a real merge for records, but not a conflict wizard: the newer edit wins and the older one is not shown. If the two databases contain separate accounts with the same names, expect duplicates. For Pocket, see [POCKET.md](POCKET.md) and [FEATURES.md](FEATURES.md#pocket-phone).

### Cloud-synced folders

Syncing the live SQLite directory yourself — copying the per-user folder, its WAL and its SHM into iCloud Drive, Dropbox or OneDrive — is **not supported**. WAL mode assumes a local filesystem with working file locks, and a sync client can copy a half-written database or conflicting WAL files.

The supported way to use a synced or network location is **Settings → Where your data lives**: WageRoute validates the folder, switches it to rollback journaling with `synchronous = FULL`, takes a safety copy when moving, carries `ledger.key.json` with the ledger when encryption is on, and uses `wageroute.lock` so one computer writes at a time. A sync client can still produce a conflicted copy, and the app cannot see or merge that copy; see [ADR 0022](decisions/0022-the-ledger-can-live-in-a-folder-you-choose.md).

Use exported files in a synced folder if you want off-machine copies without pointing the app at the folder.

### The phone

Pocket is the fourth route, and it is two-way between devices: export on the desktop, open the file on the phone, change what you like, export on the phone and import that file on the desktop. The file can travel **sealed** under a passphrase, the phone can seal **its own copy**, and either seal needs a page with a cipher — so a plain-HTTP origin cannot make or open one ([POCKET.md](POCKET.md)). The phone's copy merges the same way, so a desktop export does not overwrite what was changed on the phone since the last file. The phone edits bills, goals, accounts and entries through the desktop's own validation rules, and carries the tables the desktop exported; paychecks, allocations, settings and the writing of a paycheck's set-aside are still done on the computer, while whether that set-aside has been spent is derived on the phone from its own payments ([ADR 0028](decisions/0028-both-devices-derive-a-bills-set-aside-from-its-payments.md)), and there is no automatic file transfer. Publishing the static build is a manual GitHub Pages workflow; enabling Pages and running it are owner actions.

## Sync status

### What exists

- UUID primary keys generated on-device.
- A `user_id` column on every financial table.
- `updated_at` on every row (except settings, which has it too).
- `revision` on financial rows, intended for last-write-wins.
- `deleted_at` tombstones.
- Sync-oriented indexes on `(user_id, updated_at)`.
- JSON import that preserves IDs.

### What does not exist

- An identity or authentication model.
- A server, API, database or storage bucket.
- A transport, retry queue or outbox.
- Per-device cursors or `synced_at` columns.
- A conflict policy beyond the unused `revision` field.
- Encryption in transit. Encryption **at rest** has since become an opt-in feature ([Encryption at rest and key custody](#encryption-at-rest-and-key-custody)), but it protects a file on one disk — it is not a sync transport and carries no channel security.
- A multi-device migration strategy.
- Any UI for sync status, pairing or account creation.

### Decisions that would be required

Before any sync code is written, these need explicit agreement:

| Decision | Why it matters |
| --- | --- |
| Sync scope | All tables, or only ledger data? Are theme/round-up device-local? |
| Provider | Supabase, Firebase, a custom service, or file-based sync? |
| Identity | Email/password, passkey, OAuth, or a pairing key? |
| Encryption | Server-readable or end-to-end encrypted? Who holds the key? |
| Conflict policy | Last-write-wins by `updated_at`/`revision`, field-level merge, or manual resolution? |
| Initial upload | Which device wins on first sync? |
| Deletions | Tombstone retention and garbage collection |
| Money integrity | Server-side constraints or client-trusted writes? |
| Offline behaviour | Queue depth, retry, conflict surfacing |
| Data residency | Where the server and backups live |

None of these has been decided. The schema was designed to keep the door open, but the feature is not partially built: there is no dormant sync module, no feature flag and no configuration.

### If sync is added later

A minimal design that fits the current schema:

```text
local change
  └─► row write + outbox entry (same local transaction)
        └─► background push: POST changes with revision
              └─► server stores latest revision per row
                    └─► pull: rows where updated_at > cursor
                          └─► apply if incoming revision > local revision
```

This would still need conflict UX for concurrent edits, a tombstone policy, an auth model, and an encryption decision. It should arrive as an ADR, not as an implicit change.

## Auto-update status

WageRoute does not auto-update.

- `electron-updater` is not a dependency.
- `electron-builder.yml` has no `publish` section.
- CI does not create a release feed.
- There is no update check, download or restart flow.

Updating means replacing the installed app with a newer build. The database lives outside the app bundle, so replacing the app does not remove data. On first launch of a newer version, migrations run automatically. Back up before upgrading anyway; migrations are forward-only. Keep a **plain** JSON export, not only a keyed database or a sealed file: an encrypted `wageroute.db` cannot be opened, migrated or repaired by a build that lacks the cipher — the published `1.2.0` included — so going backwards is only possible through an unsealed export.

If auto-update is added later, it needs a signed release feed, platform signing identities, staged rollout and a rollback story. None of that exists.

## Repository hosting: GitHub or GitLab

The project lives in **`ReVax-2007/wageroute` on GitHub** — a public repository with protected `main`, pull-request-only merges, the `verify` CI check and releases that carry the installers and `SHA256SUMS`. The comparison below is the reasoning that led there, kept because it still explains the trade-offs if that ever changes.

### Why GitHub won

For this project, GitHub is the better default:

1. **The CI is already written for it.** `.github/workflows/build.yml` uses GitHub Actions, `actions/checkout`, `setup-node` and `upload-artifact`. Moving to GitLab means rewriting the pipeline as `.gitlab-ci.yml`.
2. **The toolchain fits.** electron-builder publishes naturally to GitHub Releases; the `gh` CLI covers issues, PRs and release assets; Dependabot can watch Electron and `better-sqlite3-multiple-ciphers`, which matter for security.
3. **macOS, Windows and Linux runners are available without managing infrastructure.** A desktop app needs all three platforms to produce installers.
4. **Source-available, not open-source.** The [LICENSE](../LICENSE) keeps commercial redistribution off the table — only the licensor ships WageRoute — so a public repository does not hand the product to anyone, and the app holds no server-side secrets. Privacy therefore rests on the licence, not on repository visibility, and nothing user-financial is ever committed (see [DEVELOPMENT.md](DEVELOPMENT.md#working-safely-with-data)).
5. **No self-hosting requirement.** Nothing about WageRoute needs a self-managed DevOps platform.

### When GitLab is the better choice

Choose GitLab if one or more of these is true:

- you already run or pay for GitLab and want everything in one place;
- you need self-hosted source control or CI for policy reasons;
- you want the built-in container registry, dependency proxy or security scanners;
- your team standardises on GitLab merge requests and issue boards;
- you need GitLab's particular approval or compliance features.

### Comparison

| Criterion | GitHub | GitLab |
| --- | --- | --- |
| Existing CI in this repo | **Ready** (`.github/workflows`) | Needs a rewrite |
| Desktop installer artifacts | Actions artifacts + Releases | CI artifacts + generic packages |
| macOS/Windows runners | Hosted, straightforward | Hosted, or self-managed |
| Release/update feed | GitHub Releases is the electron-builder default | Possible, but more wiring |
| CLI | `gh` | `glab` |
| Private repo | Yes | Yes |
| Self-hosting | Enterprise Server only | GitLab CE/EE self-managed |
| Built-in registry/scanners | Separate products/actions | Integrated |
| Best fit here | **Yes** | Only with a specific GitLab reason |

### If you choose GitHub

Do not commit the database or build output. The existing `.gitignore` already excludes:

```text
node_modules/
out/
release/
dist/
*.log
.DS_Store
.env
.env.local
*.db
*.db-wal
*.db-shm
.vscode/
.idea/
```

A safe first push looks like:

```bash
git init
git add README.md docs src build .github .gitignore package.json package-lock.json \
  electron-builder.yml electron.vite.config.ts tsconfig.json tsconfig.node.json
git status                 # confirm no .db, .env or release output
git commit -m "Initial WageRoute desktop app"
git branch -M main
git remote add origin git@github.com:<owner>/<repo>.git
git push -u origin main
```

Do not use `git add -A` without reviewing `git status`: a stray backup, exported CSV or `.env` would otherwise be easy to include.

This repository is **public** at `ReVax-2007/wageroute`. The source-available [LICENSE](../LICENSE) keeps commercial redistribution with the licensor, and nothing user-financial is ever committed. If that ever changes, review the code and docs for anything you do not want public before flipping visibility in either direction.

## Operational checklist

### Before an upgrade

- [ ] Export a full JSON backup, **plain** rather than sealed — it is the copy an older build can still read.
- [ ] Copy the database (with WAL/SHM — and `ledger.key.json` too, if the folder has one) while the app is closed.
- [ ] Confirm the backup file opens as JSON and contains the expected table counts.
- [ ] Keep the previous installer until the new version has opened successfully.

### After an upgrade

- [ ] Launch the app and confirm the dashboard loads.
- [ ] Check account balances against the last known values.
- [ ] Open the spreadsheet and confirm recent entries exist.
- [ ] Confirm settings (theme, splits, round-up) survived.

### Regular hygiene

- [ ] Full backup after significant ledger changes.
- [ ] Store at least one backup off the machine.
- [ ] Keep FileVault/BitLocker enabled.
- [ ] Do not sync the live database folder.
- [ ] Re-import a backup into a throwaway profile to verify it is readable.

### Restoring without the import path

If the app cannot open the database:

1. Quit WageRoute completely.
2. Move the broken `wageroute.db`, `-wal` and `-shm` files aside into a quarantine folder (do not delete them) — and `ledger.key.json` with them if the folder has one, so a keyed ledger is never split across two places.
3. Copy the backup database files into `WageRoute/`. A keyed ledger restored without its marker is **refused**, not rewritten: WageRoute will not touch pages it cannot hand a key back to.
4. Relaunch.

If you only have a JSON backup, launch with an empty/new database and use Settings → Import data. A sealed backup asks for its passphrase before the wizard shows any rows, and a plain one is readable by any build. The import merges rather than replaces, so start from an empty database when you want an exact reconstruction.

## Decision log

| Topic | State |
| --- | --- |
| Local-first desktop architecture | **Decided** — see [ADR 0001](decisions/0001-local-first-desktop.md) |
| Integer cents | **Decided** — see [ADR 0002](decisions/0002-integer-cents.md) |
| Merged imports (newer row wins) | **Decided** — see [ADR 0003](decisions/0003-additive-imports.md) and [ADR 0024](decisions/0024-two-copies-merge-by-time.md) |
| Sync-ready schema without sync | **Decided as preparation only** — see [ADR 0004](decisions/0004-sync-ready-schema.md) |
| WageRoute rename and legacy data adoption | **Decided** — see [ADR 0005](decisions/0005-wageroute-rename.md) |
| Sync provider, identity and conflict policy | **Not decided** |
| Cloud backup provider | **Not decided** |
| Auto-update and release channel | **Not decided** |
| Code signing identities | **Not decided** |
| Public vs private hosting | **Decided: public GitHub** with protected `main`, PR-only merges and the source-available licence |

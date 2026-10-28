# Deployment and data movement

**Short answer: WageRoute is local-only today.** There is no server, no cloud account, no sync engine and no automatic update. The application is a desktop binary that reads and writes one SQLite file on the machine where it is installed. Files move between machines only when you export and import them.

This document separates what exists from what has been discussed. It also records the repository-hosting recommendation.

---

## Contents

- [Status matrix](#status-matrix)
- [What “deployment” means for WageRoute](#what-deployment-means-for-wageroute)
- [Where data lives](#where-data-lives)
- [Legacy data adoption](#legacy-data-adoption)
- [Current distribution](#current-distribution)
- [Homebrew tap](#homebrew-tap)
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
| Local desktop app (macOS, Windows) | **Implemented** | Electron + electron-builder DMG/NSIS |
| Local SQLite persistence | **Implemented** | `wageroute.db` in Electron `userData` |
| Manual JSON backup and additive import | **Implemented** | Settings → Data |
| Manual CSV export and entries import | **Implemented** | Settings → Data |
| Unsigned installer builds | **Implemented** | Local scripts and GitHub Actions artifacts |
| CI build on demand / version tag | **Implemented** | `.github/workflows/build.yml` |
| Published GitHub/GitLab release | **Not implemented** | CI uploads artifacts only |
| Code signing / notarization | **Not implemented** | No certificates or config |
| Automatic updates | **Not implemented** | No `electron-updater`, no publish config |
| Cloud backup | **Not implemented** | No provider, no credentials, no code |
| Multi-device sync | **Not implemented** | Schema is sync-ready only |
| Server or API | **Not implemented** | No backend in the repository |
| User accounts or login | **Not implemented** | One local user row |
| Bank connections / statement sync | **Not implemented** | Manual entry and file import only |
| Telemetry / analytics / crash reporting | **Not implemented** | No network calls in app code |
| Encryption at rest | **Not implemented** | Relies on OS full-disk encryption |
| Mobile or web client | **Not implemented** | Desktop Electron only |
| Multi-user tenancy | **Not implemented** | `user_id` exists but one user is seeded |

The schema contains UUIDs, `updated_at`, `revision` and `deleted_at` because a future sync layer was anticipated. That is preparation, not implementation. No sync behaviour, provider or conflict policy has been agreed.

## What “deployment” means for WageRoute

There are three different things people usually mean:

1. **Installing the app.** Today: build an unsigned DMG or NSIS installer and run it locally. The app is self-contained; there is nothing to host.
2. **Distributing the app.** Today: share the installer manually or download a CI artifact. There is no release channel, store listing or update feed.
3. **Deploying a backend.** There is no backend. Nothing is deployed to a server, and no data leaves the machine.

Only the first two exist, and both are manual. The third has not been designed.

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

The database is not encrypted by WageRoute. File permissions are those of your OS user account. Use FileVault (macOS) or BitLocker (Windows) if the device could be lost or stolen.

The sidebar and Settings show the live absolute path, which is the quickest way to confirm which file the running app is using.

### Development profiles

Electron uses `CFFIXED_USER_HOME` on macOS to relocate the application data home. Running with a temporary home is the safe way to test first-launch behaviour without touching real data:

```bash
CFFIXED_USER_HOME=/tmp/wageroute-test npm run dev
```

This produces `/tmp/wageroute-test/Library/Application Support/WageRoute/` and never opens the real ledger.

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
- it runs before `getDatabase()`, so the app never creates an empty new database first;
- if no legacy database exists, it is a no-op and the seed runs.

The code lives in [`src/main/db/legacy.ts`](../src/main/db/legacy.ts).

## Current distribution

### Local builds

| Command | Output |
| --- | --- |
| `npm run build` | `out/main`, `out/preload`, `out/renderer` |
| `npm run dist:mac` | `release/*.dmg` for arm64 and x64 |
| `npm run dist:win` | `release/*.exe` (NSIS) for x64 and arm64 |
| `npm run dist` | Current platform default target |

`release/` and `out/` are gitignored.

### CI

The GitHub Actions workflow at [`.github/workflows/build.yml`](../.github/workflows/build.yml):

- triggers on `workflow_dispatch` and on tags matching `v*`;
- runs a matrix of `macos-latest` and `windows-latest`;
- installs Node 24 with npm caching;
- runs `npm ci`, `npm test`, then `npm run dist:mac` or `npm run dist:win`;
- uploads `release/*.dmg` or `release/*.exe` as build artifacts named `wageroute-mac` and `wageroute-win`.

It does **not**:

- run `npm run typecheck` separately (the `dist` script runs the build, which type-checks first);
- sign or notarize the macOS app;
- sign the Windows installer;
- create a GitHub Release;
- publish to a store;
- upload to any external service.

The artifacts are unsigned development builds. macOS Gatekeeper and Windows SmartScreen will warn when they are opened on another machine.

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

## Multi-device today

There is no sync. The only supported ways to move data are:

1. **JSON backup** — full or partial, additive on import.
2. **CSV export/import** — entries only, matched by account name.

### Copying the same database

Copying `wageroute.db` (plus WAL/SHM) to another machine preserves IDs and links. It is a snapshot, not a merge. Once both copies diverge, importing one into the other will skip rows with matching IDs but add rows with new IDs; edits to the same row are not reconciled.

Recommended procedure:

1. Quit WageRoute on both machines.
2. Copy the three database files.
3. Open the copy on the destination.
4. Never run two divergent copies and expect automatic reconciliation.

### Importing one device into another

JSON import is additive:

- rows with IDs that already exist are skipped;
- new rows are added;
- duplicate account names with different IDs are **not** merged;
- settings already present locally win.

This is safe for appending history, but it is not a merge tool. If the two databases contain separate accounts with the same names, expect duplicates.

### Cloud-synced folders

Putting the live SQLite database in iCloud Drive, Dropbox, OneDrive or a network share is **not supported**. SQLite WAL mode assumes a local filesystem with working file locks; a sync client can copy a half-written database or conflicting WAL files. WageRoute has no detection or recovery for that state.

Use exported files in a synced folder if you want off-machine copies. Do not sync the live database directory.

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
- Encryption in transit or at rest.
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

Updating means replacing the installed app with a newer build. The database lives outside the app bundle, so replacing the app does not remove data. On first launch of a newer version, migrations run automatically. Back up before upgrading anyway; migrations are forward-only.

If auto-update is added later, it needs a signed release feed, platform signing identities, staged rollout and a rollback story. None of that exists.

## Repository hosting: GitHub or GitLab

The project lives in **`ReVax-2007/wageroute` on GitHub** — a public repository with protected `main`, pull-request-only merges, the `verify` CI check and releases that carry the installers and `SHA256SUMS.txt`. The comparison below is the reasoning that led there, kept because it still explains the trade-offs if that ever changes.

### Why GitHub won

For this project, GitHub is the better default:

1. **The CI is already written for it.** `.github/workflows/build.yml` uses GitHub Actions, `actions/checkout`, `setup-node` and `upload-artifact`. Moving to GitLab means rewriting the pipeline as `.gitlab-ci.yml`.
2. **The toolchain fits.** electron-builder publishes naturally to GitHub Releases; the `gh` CLI covers issues, PRs and release assets; Dependabot can watch Electron and better-sqlite3, which matter for security.
3. **macOS and Windows runners are available without managing infrastructure.** A desktop app needs both platforms to produce installers.
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

Keep the repository **private** unless you have deliberately reviewed the code and docs for anything you do not want public. A finance app's source can reveal product intent even when it contains no personal data.

## Operational checklist

### Before an upgrade

- [ ] Export a full JSON backup.
- [ ] Copy the database (with WAL/SHM) while the app is closed.
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
2. Move the broken `wageroute.db`, `-wal` and `-shm` files aside into a quarantine folder (do not delete them).
3. Copy the backup database files into `WageRoute/`.
4. Relaunch.

If you only have a JSON backup, launch with an empty/new database and use Settings → Import data. The import is additive, so import into an empty database when you want an exact reconstruction.

## Decision log

| Topic | State |
| --- | --- |
| Local-first desktop architecture | **Decided** — see [ADR 0001](decisions/0001-local-first-desktop.md) |
| Integer cents | **Decided** — see [ADR 0002](decisions/0002-integer-cents.md) |
| Additive imports | **Decided** — see [ADR 0003](decisions/0003-additive-imports.md) |
| Sync-ready schema without sync | **Decided as preparation only** — see [ADR 0004](decisions/0004-sync-ready-schema.md) |
| WageRoute rename and legacy data adoption | **Decided** — see [ADR 0005](decisions/0005-wageroute-rename.md) |
| Sync provider, identity and conflict policy | **Not decided** |
| Cloud backup provider | **Not decided** |
| Auto-update and release channel | **Not decided** |
| Code signing identities | **Not decided** |
| Public vs private hosting | **Recommended private GitHub; not yet actioned** |

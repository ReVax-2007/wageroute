# 0005. Rename to WageRoute and adopt legacy data

- **Status:** Accepted
- **Date:** 2026-10-27
- **Deciders:** Project owner
- **Supersedes:** none
- **Related:** [DEPLOYMENT.md](../DEPLOYMENT.md#legacy-data-adoption), [RELEASING.md](../RELEASING.md)

## Context

The application was originally named **Cash Flow Routing**. The owner asked for a better product name, app icon, window title and subtitle. The chosen name is **WageRoute**, which describes the core action: routing a paycheck into priorities, savings, investments, goals, debt and leisure.

Renaming a desktop app is not only a string change. Electron derives the `userData` directory from the application name. Changing `productName` moves the database path from:

```text
…/Cash Flow Routing/cash-flow-routing.db
```

to:

```text
…/WageRoute/wageroute.db
```

If the app simply relaunches with the new name, it finds no database, seeds demo data and appears to have lost the user's entire ledger. That is unacceptable even for a personal tool. The rename also touches the backup format marker, installer names, the app icon, the bundle identifier and the window title.

## Decision

Rename the product to **WageRoute** and migrate existing data on first launch.

### Identity

| Item | Before | After |
| --- | --- | --- |
| Product name | Cash Flow Routing | **WageRoute** |
| npm package | `cash-flow-routing` | `wageroute` |
| Electron `appId` | (old identifier) | `com.wageroute.desktop` |
| Database file | `cash-flow-routing.db` | `wageroute.db` |
| Window title | Cash Flow Routing | `WageRoute — Paycheck routing` |
| Installer name | Cash Flow Routing-… | `WageRoute-…` / `WageRoute Setup …` |
| Icon | previous asset | `build/icon.icns`, `build/icon.png` |
| App version | `0.1.0` | `0.1.0` (unchanged) |

### Legacy data adoption

On startup, **before** the database is opened:

1. If `WageRoute/wageroute.db` exists, do nothing.
2. Otherwise look for `Cash Flow Routing/cash-flow-routing.db` under Electron's `appData` directory.
3. If found, create the new directory and copy:
   - `cash-flow-routing.db`
   - `cash-flow-routing.db-wal`, if present
   - `cash-flow-routing.db-shm`, if present
4. Leave every original file in place.
5. Open the new copy and run migrations normally.

Properties of this decision:

- **Copy, never move.** The old installation remains usable and the original is a fallback.
- **Never overwrite.** Adoption only runs when the new database is absent.
- **Preserve uncheckpointed commits.** The WAL and SHM are copied with the main file, so recent transactions are not lost.
- **Run before opening.** The app cannot accidentally create an empty new database first.
- **No-op when there is nothing to adopt.** A fresh development install seeds the demo profile as before; a packaged install seeds one blank user.
- **One-shot.** Once `wageroute.db` exists, later changes in the old folder are not re-imported.

### Compatibility choices

- **The backup format marker remains `cash-flow-routing-backup`.** Every backup written by the old app must remain importable. Renaming the marker would reject existing files. The marker is a format identifier, not the product name.
- **The schema version did not change** for the rename. The database contents are compatible; only the path and filename moved.
- **The app version stayed `0.1.0`.** The rename is not a behavioural release; it is identity work. The next functional change earns the next version.

## Consequences

### Positive

- Existing ledgers continue to work after the rename, with recent WAL commits intact.
- The old app and database remain intact, so the rename is reversible by reinstalling the old build.
- Users can compare the old and new installations side by side during the transition.
- The name, icon and title now match the product's purpose.
- Existing backups remain valid because the format marker did not change.

### Negative

- **Two application folders can coexist**, each with a database. Users may edit the wrong one. The sidebar footer shows the live path as its tooltip and Settings → Data prints it in full, which is the mitigation.
- **The first launch copies the entire database.** A large ledger means a longer first start and double disk usage until the old folder is cleaned up.
- **The old folder is never deleted.** That is intentional, but it means deleted data may persist there indefinitely. Cleaning it up is a user decision, not an app action.
- **The copy is not a merge.** If the user continues using the old app after the rename, those newer changes are invisible to WageRoute. Consolidation requires an export/import, which is additive ([ADR 0003](0003-additive-imports.md)).
- **The bundle identifier changed**, so OS-level identity changes with it: notification permissions, firewall entries, saved window state and any future code-signing identity are per-bundle. There is no signing identity yet.
- **Installer and shortcut names changed.** Users may end up with both old and new shortcuts.
- **A stale installer exists** in `release/` under the old name; it must not be distributed as WageRoute. See [RELEASING.md](../RELEASING.md#what-the-build-produces).
- **The working directory is still named `Cash Flow Routing`.** The folder name is not the product name; renaming it is optional and would break any external scripts or shortcuts pointing at it.

### Neutral

- The database filename and the product name now match.
- The legacy adoption code is small and self-contained in `src/main/db/legacy.ts`.
- The old backup marker will remain forever unless a future version supports both markers and a migration window. That is a deliberate compatibility cost.

## Alternatives considered

### Keep the old name

Rejected by the owner. The name was not descriptive and the product identity was being finalized.

### Rename without data adoption

Rejected. It would look like total data loss on first launch and force every existing user to find and import a backup manually.

### Move the database instead of copying

Rejected. A move is destructive if anything goes wrong mid-operation, leaves the old app broken, and removes the fallback. Copying costs disk space but is reversible.

### Symlink the old folder to the new one

Rejected. Symlinks behave differently across platforms, interact badly with backup tools and cloud sync, and make it unclear which path is authoritative.

### Import the old database through the JSON path

Rejected as the primary mechanism. It requires the old app to still run and produce an export, and it loses nothing but adds a manual step. The file copy preserves WAL state and works even if the old app cannot launch.

### Change the backup marker to `wageroute-backup`

Rejected. It would break every existing backup and provide no user benefit. The marker identifies the format, not the brand.

### Bump the version for the rename

Rejected. The app version describes behaviour and data compatibility. A rename with an unchanged schema is `0.1.0`; inflating the version would make the release history misleading.

## References

- [src/main/db/legacy.ts](../../src/main/db/legacy.ts) — adoption implementation and copy set
- [src/main/db/connection.ts](../../src/main/db/connection.ts) — adoption runs before `getDatabase()`
- [src/main/index.ts](../../src/main/index.ts) — `app.setName('WageRoute')`
- [electron-builder.yml](../../electron-builder.yml) — product name, app ID, icons, installer names
- [src/renderer/index.html](../../src/renderer/index.html) — window title
- [DEPLOYMENT.md](../DEPLOYMENT.md#legacy-data-adoption) — operational description and data paths
- [RELEASING.md](../RELEASING.md) — installer naming and the stale old-name artifact

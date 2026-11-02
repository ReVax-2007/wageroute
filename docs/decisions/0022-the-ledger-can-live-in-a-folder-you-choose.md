# 0022 — The ledger can live in a folder you choose

**Status:** Accepted (2026-11-02)

## Context

WageRoute has always kept its database in the per-user application-data folder. That is the right default — it needs no setup, it is covered by OS permissions, and it survives an app update. But it also means one ledger belongs to one computer. A user with a desktop and a laptop cannot look at the same numbers without exporting a backup and importing it on the other machine, and a user with a NAS or a synced cloud folder already has a place designed to hold shared files.

The request was explicit that this be **optional**: the app must keep working exactly as it does today without any share, account or network. The request also described using the location as *the* data location, not as an export target, so every computer points at the same folder and reads the same ledger.

SQLite is a single-writer database. Its locking, WAL and shared-memory behaviour assume a filesystem with working POSIX locks. SMB, NFS and cloud-sync clients do not all provide those guarantees, and a sync client can copy a database mid-write or produce a “conflicted copy”. Two machines writing the same file would not merge — they would corrupt or silently lose entries.

## Decision

**The location is a pointer, the ledger stays a plain SQLite file, and only one process writes it at a time.**

1. **The pointer lives outside the database.** `storage.json` in the per-user folder records the chosen folder. The app must know where the database is before it can open it, so this cannot live inside the ledger. The pointer is written atomically. If the folder it names is missing, the app refuses to start and says so; it never falls back to the local copy, because that would fork the ledger.
2. **Switching is a restart.** The database handle, every prepared statement and every IPC handler are bound to the file that was open at launch. A hot swap would mean rebuilding all of them and trusting that nothing read the old handle in between. Instead the app validates the target, copies when asked, writes the pointer, closes the database and relaunches. The next boot uses the normal, already-tested open path.
3. **One writer, enforced by a lock file.** `wageroute.lock` in the data folder carries a random token, the hostname, the PID and a start time. The owner refreshes its mtime every 30 seconds. A second process on the same host is refused while its PID is alive; a lock from another host is honoured until it has not been refreshed for three minutes, after which it is treated as abandoned. If the heartbeat finds the file replaced, the running app closes its database and stops rather than write over the machine that took over.
4. **External folders use rollback journaling.** On a folder other than the per-user one, the database opens with `journal_mode = DELETE`, `synchronous = FULL` and no memory map, instead of WAL. This is slower, but it does not depend on shared memory or the finer locking WAL requires, and it does not leave a memory-mapped view that can outlive a replaced file.
5. **A switch leaves recoverable copies on both sides.** Moving data into a folder takes a `pre-move-*.db` copy in the `backups` folder beside the ledger it leaves (newest three kept) and writes the new file only after it passes an integrity check. Moving back copies the external ledger over the local one after taking a `pre-return-*.db` copy of the local file. Adopting an existing ledger copies nothing and leaves the local file untouched.
6. **A newer schema is refused before the switch.** If the chosen folder's ledger reports a schema version above this build's, the app explains that the other computer needs updating rather than opening and failing at boot.
7. **Cloud folders are allowed, with honest limits.** A Google Drive, Dropbox, OneDrive or iCloud folder is just a folder. The app warns that a sync tool can create conflict copies and that WageRoute can only see the file it opens. It does not attempt to detect sync clients, merge conflict copies or coordinate with them.

## Consequences

- The default path is unchanged for every existing user: no migration, no new file, no schema change. `storage.json` and `wageroute.lock` appear only when the feature is used or the app runs.
- Pre-upgrade, pre-erase and pre-move copies follow the ledger into the chosen folder, so the backups the UI names are beside the data they protect.
- A share that is unplugged, unmounted or offline produces a startup dialog naming the folder, not a silent second ledger.
- The lock is advisory. A sync client that ignores file locking, a user who edits the database with another SQLite tool, or a machine that is asleep for longer than the stale window can still produce two writers. The app documents this as a single-computer-at-a-time feature, not as concurrent multi-device sync.
- Switching folders restarts the app, so it is a deliberate action in Settings, not something a background task does.

## Alternatives rejected

- **Automatic sync/merge between machines.** That is a backend, conflict resolution and a much larger security surface; it is the opposite of the optional, local-first design.
- **Keep WAL on network folders.** WAL needs shared memory and byte-range locks that several network filesystems do not honour; the failure mode is a corrupt ledger, not an error.
- **Switch data folders without restarting.** The handler graph is built around one open handle; rebuilding it live adds a class of use-after-close bugs for no user-visible benefit.
- **Database triggers or a settings row for the location.** Both are inside the file the app has to locate first.
- **Detect NAS/cloud providers by path and refuse them.** The request explicitly asked for those locations. Warning and using the safe journal mode is more honest than a blocklist that cannot know every mount.

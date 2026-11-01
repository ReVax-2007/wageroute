# 0019. The ledger is plaintext at rest

- **Status:** Accepted
- **Date:** 2026-10-31
- **Deciders:** Project owner
- **Related:** [ADR 0001](0001-local-first-desktop.md), [ADR 0020](0020-there-is-no-app-lock.md), [SECURITY.md](../SECURITY.md)

## Context

WageRoute keeps a complete financial history in one SQLite file under the user's application-support folder. The file is not encrypted: anyone who can read the OS user's files can read every balance, bill and memo, and the write-ahead log can hold recent commits that have not yet reached the main file. Exports are plaintext JSON and CSV at a path the user chooses.

The audit raised this as a real exposure on a shared Mac or a machine with a backup agent that copies the whole home folder. The choice was between implementing encryption and deciding, explicitly, that the operating system is the security boundary.

## Decision

**At-rest encryption is out of scope for this product. Plaintext plus OS protection is the deliberate design.**

- The database, its `-wal`/`-shm` sidecars, backups and exports are plaintext (backups and exports are sensitive documents, not caches).
- The app does what it can cheaply: the database file is `chmod 0600` on open where the platform supports it, exports are created `0600` and written atomically, the log is `0600`, and erase compacts the file so deleted rows do not linger in free pages.
- **Full-disk encryption is the control.** FileVault, BitLocker or the Linux equivalent protects data on a powered-off device. The security documentation says so plainly and does not claim the app protects the file itself.
- **Backups are the user's responsibility.** The default save location is Documents; the documentation warns that this is often cloud-synced and recommends an encrypted archive before moving a backup off the machine.
- A last-resort `pre-erase` copy of the database is written before **Erase all data**. It is plaintext, it lives in the same protected folder, and the dialog says where it is. A user who wants the data gone deletes that file too.
- No password, no key derivation and no encrypted container will be added without a new ADR that supersedes this one.

## Consequences

### Positive

- No key management, no recovery-phrase support burden, and no shape where a forgotten passphrase loses a user's entire history.
- SQLite stays a normal SQLite file: backups can be opened with standard tools, corruption can be diagnosed, and the `VACUUM INTO` safety copies need no special handling.
- The threat model is honest: the app defends against a malicious import, a compromised renderer and a tampered bundle, not against someone who already has the user's files.

### Negative

- **A shared machine is a real exposure.** On a multi-account Mac or Windows PC, another local account may be able to read the file if the folder permissions are wrong; the app's best-effort `0600` is not a guarantee.
- **Cloud-synced folders leak the ledger.** A backup in iCloud Drive or OneDrive is readable by the provider unless the user encrypts it first.
- **The WAL sidecars follow the folder, not the file.** Their permissions are inherited, and a user who tightens only `wageroute.db` has not tightened the commits still in `-wal`.

### Neutral

- No schema change.
- If encrypted storage is ever added, the `Snapshot` read model and the backup format do not change; encryption would sit at the file layer, and the migration of existing plaintext files would need its own decision.

## Alternatives considered

### Encrypt the database with a passphrase (SQLCipher or an application-level key)

Rejected for now: it requires a key-derivation and recovery design, breaks `VACUUM INTO` and external tooling, and does not help the common case (a lost or stolen unlocked machine), which the OS already handles better. It is a product decision for a future version, not a hardening patch.

### Encrypt only exports

Rejected as a false sense of safety: the live database remains the larger copy, and an encrypted export the user cannot open without the app is a backup that fails when the app is unavailable.

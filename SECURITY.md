# Security policy

## Supported versions

The published line is 1.1.x; the unreleased 1.2.x line carries schema 8. Security fixes are applied to the newest supported line (1.1.0 is schema 6). Older builds and unsupported backup versions are not patched.

## Reporting a vulnerability

**Do not open a public issue for a security problem.**

If private vulnerability reporting is enabled on this repository, use **Security → Report a vulnerability**. Otherwise contact the repository owner through an existing private channel.

Please include:

- WageRoute and schema versions;
- operating system and architecture;
- reproduction steps using a **synthetic** ledger;
- expected impact;
- whether local access, a malicious import file or a tampered installer is required.

Never attach a real database, backup, CSV export or screenshots containing account numbers or balances. Redact or recreate the data.

There is no bug bounty and no guaranteed response time.

## Scope

In scope: the Electron application, the preload bridge, IPC handlers, SQLite schema and migrations, JSON/CSV import parsing, and the build/release workflow.

Out of scope: the operating system, malware running as the same user, bank systems, and any future hosted service (none exists today). WageRoute does not connect to banks, hold credentials, move money or implement sync.

The full threat model, implemented controls and known weaknesses are documented in [docs/SECURITY.md](docs/SECURITY.md).

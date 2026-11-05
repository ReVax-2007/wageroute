# Security model

WageRoute is a **single-user, local-only ledger**: a desktop app and an optional phone web app. It has no accounts, no login and no roles, does not talk to a server and does not hold bank credentials. Its security therefore rests on the operating-system account that runs it, full-disk encryption, and the fact that imported files are parsed as data rather than executed — plus, **only where the owner asks for it**, a cipher over the ledger file, an exported backup and the phone's own copy. Encryption is opt-in, reversible in both directions, and never claims more than it gives ([ADR 0029](decisions/0029-encryption-is-a-choice-on-the-disk-and-on-the-way-out.md)); the passphrase prompt at launch is a request for a key, not an authentication step, and [ADR 0020](decisions/0020-there-is-no-app-lock.md)'s refusal of a UI-only lock still stands.

This document describes what is actually implemented, what the trust boundaries are, what an attacker with local access can do, and which weaknesses are known and accepted. It is deliberately specific; “secure” without a threat model is not useful.

> **Scope:** the application in this repository, the published `1.2.x` line and the superseded `1.1.x` line. There is no production server, hosted service or multi-tenant deployment to assess. One boundary matters when reading the encryption sections: **the encryption layer is in this repository's build, not in the published `1.2.0`**, and a `.db` file this build has encrypted cannot be opened by `1.2.0` at all — see [Encryption at rest and key custody](#encryption-at-rest-and-key-custody).

---

## Contents

- [Supported versions](#supported-versions)
- [Reporting a vulnerability](#reporting-a-vulnerability)
- [Assets](#assets)
- [Trust boundaries](#trust-boundaries)
- [Implemented controls](#implemented-controls)
- [Data at rest](#data-at-rest)
- [Encryption at rest and key custody](#encryption-at-rest-and-key-custody)
- [Sealed exports and the phone's vault](#sealed-exports-and-the-phones-vault)
- [Application shell hardening](#application-shell-hardening)
- [Network exposure](#network-exposure)
- [Supply chain](#supply-chain)
- [Pocket (web app)](#pocket-web-app)
- [Import security](#import-security)
- [Threat model](#threat-model)
- [Known weaknesses](#known-weaknesses)
- [Hardening recommendations](#hardening-recommendations)
- [Incident response](#incident-response)
- [Security review checklist](#security-review-checklist)
- [Non-goals](#non-goals)

---

## Supported versions

| Version | Supported | Notes |
| --- | --- | --- |
| `1.2.x` | Yes | Latest published line; fixes land here. Carries schema 8, writes backup format 8 and accepts backups from schema 2–8. |
| `1.1.x` | No | Superseded. 1.1.0 carries schema 6 and cannot open a schema-8 database; upgrade instead of patching. |
| `1.0.x` | No | Superseded. 1.0.2 carries schema 3 and cannot open a 1.1.0 database; upgrade instead of patching. |
| Older app versions | No | No security backports; upgrade or restore a backup |
| Backups with schema `1` | No | Rejected by the importer |
| Databases with `user_version` ahead of the app | Refused | `SchemaTooNewError` at launch: a dialog names the newer schema, the app quits and the file is untouched |
| A `wageroute.db` this build has **encrypted** | Refused by `1.2.0` | It ships the plain driver, so the keyed file reads as `SQLITE_NOTADB`. Nothing is damaged and nothing is guessed; restore a JSON backup instead, or upgrade. |
| A sealed `wageroute-envelope` | Only builds that ship the reader | Both devices in this repository open it; an older build has no passphrase step to offer, so the file stays the opaque thing it is |
| Databases with `user_version` ahead of the app | Refused | `SchemaTooNewError` at launch: a dialog names the newer schema, the app quits and the file is untouched |

There is no long-term-support branch, no patch guarantee and no CVE process. This is a personal finance tool, not a regulated product.

---

## Reporting a vulnerability

There is no security mailbox or bug bounty yet. Report privately to the maintainer — use **Security → Report a vulnerability** if private reporting is enabled on the repository, otherwise the channel you use to receive builds. Do not open a public issue.

Please include:

- the WageRoute version and schema version (Settings → About shows both);
- operating system and architecture;
- steps to reproduce, ideally with a **synthetic** ledger;
- the impact you believe it has;
- whether the issue requires local access, a malicious import file, or a tampered installer.

Do **not** attach a real database, a real backup, a CSV export or screenshots containing account numbers or balances. Reproduce with fake accounts and amounts. If a real file is unavoidable, redact it and say so.

There is no response-time commitment. Do not open a public issue for an unfixed vulnerability once a repository exists; coordinate first.

---

## Assets

In rough order of sensitivity:

1. **The ledger database** — account names, institutions, balances, bills, paychecks, allocations, goals, transaction memos, dates and amounts. This is a detailed financial profile.
2. **The key to that ledger, and the phrase that can carry it** — the 32-byte data key never sits in the clear, but the phrase that releases it is the one secret a person can lose and the one thing an offline guesser can attack. Nothing else in the app has this property.
3. **Backups and exports** — full JSON backups contain every table, including soft-deleted rows. CSV exports contain transaction history. Both are plaintext unless the person typing the export chooses a passphrase, which writes a sealed `wageroute-envelope` instead; the CSV stays plaintext by design ([ADR 0017](decisions/0017-the-csv-is-a-review-copy.md)).
4. **Settings** — split percentages, round-up destination, theme. Low sensitivity alone; combined with the ledger they describe behaviour.
5. **Database path and machine identity** — the absolute path is shown in the UI and can reveal the OS username.
6. **Application integrity** — users must be able to trust that the installer they run is the build that was tested.
7. **The host account** — any process running as the same OS user can read or modify all of the above regardless of what the app does.

There are no passwords, API keys, bank tokens or session cookies stored by WageRoute. A ledger's passphrase is never stored, not even hashed: the AES-GCM tag over the wrapped key is the only check, and it is tried only against this app's own file. If you find a credential in the repository or a build, that is a release-blocking defect.

---

## Trust boundaries

```text
┌──────────────────────────────────────────────────────────────────┐
│ Operating-system user account                                    │
│                                                                  │
│  ┌──────────────────────────┐        ┌────────────────────────┐  │
│  │ Renderer (Chromium)      │        │ Main process (Node)    │  │
│  │ React, Zustand           │        │ fs, dialogs, SQLite,   │  │
│  │ sandbox: true            │        │ keychain (safeStorage) │  │
│  │ no Node, no direct FS    │        │ full user privileges   │  │
│  └────────────┬─────────────┘        └───────────┬────────────┘  │
│               │ window.api (contextBridge)       │               │
│               └──────────── IPC ─────────────────┘               │
│                                                  │               │
│                                       ┌──────────▼────────────┐  │
│                                       │ wageroute.db (+WAL)   │  │
│                                       │  + ledger.key.json    │  │
│                                       └───────────────────────┘  │
│                                                                  │
│  Untrusted files ──► native open dialog ──► main parser ──► SQL  │
└──────────────────────────────────────────────────────────────────┘
```

Nothing below the ledger box is a network path, and the OS account is still the boundary that matters most. What encryption changes is narrower than that picture suggests: it decides what a *file copy* is worth. With the ledger keyed, `wageroute.db` no longer opens as a SQLite database and its page 1 is not the header; without it, the file is plaintext and the OS is the only control. Neither state stops a process running as the same user, because such a process can reach the key in the main process's memory, the unlocked session, or the app's own IPC. See [Encryption at rest and key custody](#encryption-at-rest-and-key-custody).

### Renderer

The renderer is treated as **less trusted than main** but still capable of reading and changing the entire ledger through the bridge. It has no Node.js, no `require`, no filesystem and no network permission beyond what CSP allows. A cross-site-scripting bug in the renderer is therefore not arbitrary code execution on the host, but it is full access to the ledger and every IPC channel.

### Preload

The preload script is the only bridge. It exposes one object, `window.api`, with named methods. It does not expose `ipcRenderer`, `require`, `process` or arbitrary channel names. See [src/preload/index.ts](../src/preload/index.ts).

### Main

The main process is fully privileged: it can read and write files, open native dialogs and execute SQL. It assumes the renderer's arguments are untrusted and validates IDs and repository inputs, but it does not assume the renderer itself is hostile. Defense in depth is limited; the bridge is the security boundary.

### Files

Imported files are **untrusted input**. The renderer cannot choose the path; the user picks it in a native dialog owned by main. Exports likewise write only to a path the user selects. This means a compromised renderer cannot read an arbitrary file by passing a path over IPC, but it can ask the user to pick a file and then read the parsed contents through the snapshot.

### Operating system

The app does not defend against malware running as the same user, an administrator, or an attacker with physical access and an unlocked session. Full-disk encryption and OS account hygiene are the controls for those cases. Encryption at rest moves one of those cases into a different category — an attacker with the *disk* and not the *session*, e.g. a machine taken while powered off — but only when the owner turned it on and the custody holding the key is not sitting beside the file it opens.

---

## Implemented controls

| Control | Where | What it prevents |
| --- | --- | --- |
| `sandbox: true` | [src/main/index.ts](../src/main/index.ts) | Renderer process sandbox; no direct OS access |
| `contextIsolation: true` | same | Page JavaScript cannot reach Electron internals |
| `nodeIntegration: false` | same | No `require`, `process` or Node APIs in the renderer |
| Narrow preload bridge | [src/preload/index.ts](../src/preload/index.ts) | Only named finance operations, no generic IPC |
| Navigation denied | `will-navigate` handler | The window cannot leave the app's own page: the packaged `file://` URL exactly, or the dev server's origin in development |
| Exact navigation allowlist | `isTrustedPageUrl()` in [src/main/window-security.ts](../src/main/window-security.ts) | A crafted same-directory, lookalike-host or wrong-port URL cannot pass as the app page |
| New windows denied | `setWindowOpenHandler` | No child windows at all; only the allowlisted `https://buymeacoffee.com/revax` leaves for the external browser |
| Permissions denied except clipboard writes | `permissionAllowed()` in [src/main/window-security.ts](../src/main/window-security.ts), wired through `setPermissionRequestHandler` and `setPermissionCheckHandler` | Camera, microphone, notifications, geolocation, clipboard read, etc. — requested or merely checked. The one allowlisted permission is `clipboard-sanitized-write`, which the copy buttons need; it writes what the page already shows and cannot read the clipboard |
| Single-instance lock | `app.requestSingleInstanceLock()` | Two processes writing the same SQLite file |
| IPC sender validation | `isTrustedFrame()` in [src/main/ipc.ts](../src/main/ipc.ts) | Every handler refuses a frame that is not the app's own page (or the dev server during development) |
| Content Security Policy | [src/renderer/index.html](../src/renderer/index.html) | Remote script/style/frame/connection origins are blocked by default |
| Strict production CSP | `strictCsp()` in [electron.vite.config.ts](../electron.vite.config.ts) | The packaged page drops the dev `ws://localhost` and inline-script allowances at build time |
| No HTML injection sinks | Renderer source | No `dangerouslySetInnerHTML`, `innerHTML`, `eval` or `new Function` |
| Fixed IPC channel list | [src/main/ipc.ts](../src/main/ipc.ts) | Renderer cannot invoke arbitrary main-process operations |
| ID validation | `requireId()` in `ipc.ts` | Empty/non-string IDs are rejected before reaching SQL |
| Size checks in bytes | `Buffer.byteLength` before a 64 MiB cap | A multi-byte import cannot slip past a character-count check |
| Atomic export writes | `writeFileAtomic()` in [src/main/files.ts](../src/main/files.ts) | An interrupted or failed export leaves the previous file intact instead of a truncated one |
| Export file mode | `openSync(..., 0o600)` in `files.ts` | On macOS and Linux, exported ledger data is not world-readable. Windows has no POSIX mode bits, so there the file inherits the user profile's ACL |
| Export read-back verification | SHA-256 digest compared after the rename in `files.ts` | A write that silently truncated or was substituted is reported instead of being presented as a backup |
| Boot integrity check | `assertHealthy()` in [src/main/db/maintenance.ts](../src/main/db/maintenance.ts) | A corrupt file is reported instead of being migrated, written to, or silently misread |
| Opt-in cipher over the ledger | `openLedger()` in [src/main/db/encryption.ts](../src/main/db/encryption.ts), one driver (`better-sqlite3-multiple-ciphers`), cipher recorded in the marker | A file copy of a keyed ledger is not a readable database. Off by default, so this protects only the installs that asked for it |
| Key never in the clear | `sealCustody()` in [src/main/db/custody.ts](../src/main/db/custody.ts), wraps written `0600` by `writeKeyFile()` in [src/main/db/ledger-key.ts](../src/main/db/ledger-key.ts) | The sidecar alone opens nothing: it holds the data key only as a device wrap, a passphrase wrap, or both |
| The ledger opens before the API exists | `boot()` → `openLedgerForBoot()` before `registerIpcHandlers()` in [src/main/index.ts](../src/main/index.ts) | While a keyed ledger is locked there is no ledger window, no `window.api` and no ledger channel to exercise — only the passphrase prompt, which owns two messages |
| A transition must prove itself | `transition()` and `assertTransition()` in `encryption.ts`, `reconcilePending()` | A `rekey` that silently no-ops, a crash mid-change, or a marker and header that disagree are reported and rolled back, not presented as an encrypted ledger |
| Sealed export, both readers | [src/shared/envelope.ts](../src/shared/envelope.ts) with [src/main/envelope.ts](../src/main/envelope.ts) and [src/pocket/lib/envelope.ts](../src/pocket/lib/envelope.ts) | A backup that leaves the machine can carry the ledger under a passphrase instead of beside it, and the phone can open what the desktop sealed |
| A file cannot choose its own work factor | iteration rails in `envelope.ts` (`MIN_ITERATIONS`/`MAX_ITERATIONS`), `parseEnvelope()`, `assertMarker()` in [src/pocket/lib/vault.ts](../src/pocket/lib/vault.ts) | A hostile sealed file cannot claim “1 iteration” and hand a key back instantly, nor “a billion” and hang the machine reading it |
| The phone's own copy can be sealed | [src/pocket/lib/vault.ts](../src/pocket/lib/vault.ts), non-extractable session key in module scope | IndexedDB read after the page is closed yields ciphertext and a marker, not the ledger |
| Pre-upgrade copies | `backupBeforeUpgrade()` | A forward-only migration cannot destroy the only copy of an older schema |
| Pre-erase copies | `backupBeforeErase()` in [src/main/db/maintenance.ts](../src/main/db/maintenance.ts) | An accidental erase is disclosed and recoverable from the newest three `pre-erase-*.db` copies |
| Daily copies | `backupDaily()` in [src/main/db/maintenance.ts](../src/main/db/maintenance.ts) | The newest seven local days survive a mistake nobody took a manual export for; a failure is logged and never blocks the open |
| Secure delete | `PRAGMA secure_delete = ON` | Deleted rows do not linger in free pages |
| Erase compacts the file | `VACUUM` + `wal_checkpoint(TRUNCATE)` in `compact()` | "Erase all data" leaves no recoverable rows in the database or the WAL |
| Crash log | `logCrash()` and `logNote()` in [src/main/log.ts](../src/main/log.ts) | A boot or renderer failure is recorded instead of vanishing; a plain fact (which passphrase try opened the ledger) goes through the note writer so it does not read as an error |
| User-scoped queries | `src/main/db/repo/` | Every read and write includes `user_id`; one local user cannot address another's rows |
| Prepared statements | repositories and backup merge | No user-supplied string is interpolated into SQL |
| Column allowlists | `TABLE_COLUMNS` in `src/main/db/backup.ts` | Imported object keys never become SQL identifiers |
| Import size cap | `MAX_IMPORT_BYTES = 64 MiB` | Trivial memory/disk exhaustion via a huge file |
| Per-table row cap | 200,000 rows in `parseBackupJson` | Absurd table sizes before insertion |
| Format/version checks | `parseBackupJson` | Wrong file type, newer schema, unsupported old schema |
| Per-row guarded import | `mergeBackup`, `mergeEntries` | One rejected row costing the whole file; the transaction still commits the rest |
| Foreign keys on | `PRAGMA foreign_keys = ON` | Dangling references from imported rows |
| STRICT tables + CHECK constraints | migrations | Wrong types and out-of-range enums/amounts at the database boundary |
| Newer-wins merge | `mergeBackup`, `mergeTables` | An older backup silently reverting a newer local edit or setting |
| No telemetry or analytics | entire source | Ledger data leaving the machine through app code |
| Lockfile + `npm ci` in CI | `package-lock.json`, workflow | Unreviewed dependency resolution drift |

### What “sandbox” means here

`sandbox: true` sandboxes the **Chromium renderer**, not the whole application. The main process still runs with the user's full privileges by design: it must open the SQLite file and native dialogs. There is no macOS App Sandbox entitlement, no Windows AppContainer and no container around the app.

The container path inverts both halves of that sentence, and [Running WageRoute in a container](DEPLOYMENT.md#the-desktop-in-a-container) says so where it is documented: Electron runs with `--no-sandbox`, because a Chromium user-namespace sandbox is not what an unprivileged root container gives you, so the renderer isolation above is **not** in force inside `wageroute-desktop`. What you gain instead is filesystem isolation — the ledger, the profile and the crash log all sit in one named volume — which is a different guarantee, not a stronger one. Run that container only on a machine you already trust with the ledger.

### Validation split

Repository functions validate renderer input: text length, cent ranges, enum values, ISO dates, account existence. Backup import is a **separate path**: it type-checks values, allowlists columns and relies on SQLite constraints, but it does not apply the same length and date-format checks. See [Import security](#import-security).

---

## Data at rest

| Item | Protection |
| --- | --- |
| `wageroute.db` | **Plaintext by default; chacha20 when the owner turns encryption on.** Mode `0600` on open where the filesystem allows it. A keyed file's first bytes are not the SQLite header, and plain SQLite — including the published `1.2.0` — refuses it as `SQLITE_NOTADB`. |
| `ledger.key.json` | Written `0600` beside the ledger, and removed as the last step of a verified decrypt. It holds the data key only as wraps, so on its own it opens nothing — but a folder copy that carries this file *and* the OS keychain login, or a guessable passphrase, carries the ledger. It is the app's only way to know a file is keyed before opening it, and a keyed ledger whose marker is missing is refused rather than guessed at. |
| `wageroute.db-wal` / `-shm` | Same, inherited from the database file's directory and umask. Recent commits may exist only in the WAL. When the ledger is keyed the pages the driver writes are the cipher's; WageRoute does not byte-test the WAL, and the transition deliberately leaves WAL mode while it rekeys ([encryption.ts:19-21](../src/main/db/encryption.ts)). |
| `storage.json` | Plaintext pointer to a chosen data folder, written `0600` in the per-user folder. Contains a path, no ledger data. |
| `wageroute.lock` | Plaintext, `0600` where the folder allows it: hostname, PID and start time of the process writing the ledger. No ledger data. |
| A chosen external data folder | The database, its key file and its backups inherit that folder's permissions. On a share or a cloud-synced folder the provider and everyone with access can read them, and WageRoute cannot tighten an ACL it does not own. Encryption is the control that survives such a copy — but only if the custody that releases the key does not live in the same folder. |
| Pre-upgrade, pre-erase, daily and move copies | `backups/pre-upgrade-*.db`, `pre-erase-*.db`, `daily-*.db`, `pre-move-*.db` and `pre-return-*.db` in the data folder; newest three of each kept (seven for the daily copies). Each is a `VACUUM INTO` copy taken from the ledger **as it was at that moment**: keyed ledger, keyed copy; plaintext ledger, plaintext copy. Pre-erase and daily copies deliberately outlive the erase. |
| `pre-encrypt-*` / `pre-decrypt-*` | The transition's safety copy. **Deleted as soon as the change verifies** ([custody.ts:122](../src/main/db/custody.ts), [custody.ts:163](../src/main/db/custody.ts)), because the one taken before an encrypt is the whole ledger in readable plaintext sitting beside the file that just became ciphertext. A copy that outlives a crash is what `reconcilePending()` reads to decide whether the change landed. |
| JSON backups | At the user-selected path, mode `0600` on macOS and Linux. Plaintext unless a passphrase is typed for the export, in which case the file is a sealed `wageroute-envelope` and the ledger inside it is ciphertext under AES-256-GCM. |
| Sealed backups | Same format, same path rules. The marker fields (cipher, KDF, iterations, salt, IV, tag, `exportedAt`) are deliberately in the clear so a person can recognise and sort these files without the phrase; only the ledger bytes are under the cipher. |
| CSV exports | Always plaintext at the user-selected path, written `0600` on macOS and Linux; on Windows it inherits the profile ACL. A cipher a spreadsheet cannot open is not a feature ([ADR 0017](decisions/0017-the-csv-is-a-review-copy.md)). |
| Pocket's copy in IndexedDB | Plaintext unless the phone's vault is turned on; then one sealed record plus a marker in the clear. A browser profile that can read site data can read the plain one, and gets ciphertext from the sealed one **only after the page has been closed** — an open, unlocked tab is readable either way. |
| Logs | `logs/main.log` in the app data folder, mode `0600`, rotated at 512 KB to `main.log.1`. Contains error messages, stack traces and one-line notes, not ledger rows. The encryption paths log typed failures that name files and directions (`encryption-enable`, `ledger-locked`, `ledger-key-file-missing`, `ledger-restored`) and one success — `ledger-unlocked`, counting the passphrases it took, because a person who typed three times and a person who typed once have different problems afterwards. That success goes through the note writer, so a boot that worked does not read as a crash in the tail *Copy diagnostics* sends to a bug report. No passphrase or data key is written to it, and the typed phrase is never returned over IPC. |
| Preferences | SQLite settings table; no secrets. When the ledger is keyed they are inside the cipher with everything else in the file. |

WageRoute **does** offer, and **does not** impose:

- encryption of the database file, which is opt-in, reversible in both directions, and off until someone asks in Settings;
- a passphrase seal on an exported backup, offered per export rather than set once globally;
- a way to open the ledger before a window exists — the launch gate asks for the key, and refusing to type it is a supported answer.

What it still does not do:

- encrypt anything by default, or migrate a file behind the user's back;
- require a password or add a UI-only app lock ([ADR 0020](decisions/0020-there-is-no-app-lock.md));
- hold a recovery path of any kind — no key escrow, no reset we operate, no hosted copy, no way to help a person who has lost every way in;
- guarantee secure deletion on a filesystem that ignores `secure_delete` (copy-on-write or SSD wear-levelling can leave blocks behind).

The database file is `chmod 0600` best effort on every open, so other local accounts cannot read it on a normal single-user install; the app does not verify this and a filesystem may refuse the change. The `-wal` and `-shm` sidecars inherit the directory's ACLs and umask, while `ledger.key.json` and every ledger export are written `0600` by the same atomic writer. Windows has no POSIX mode bits: there the database, the key file, the exports and the log are protected by the ACL of the user profile they live in, which is what the app data folder and the default export path sit inside.

**Deleted data is retained.** A normal delete sets `deleted_at`; rows remain in the table and are included in `SELECT *` exports. “Delete” means “hide from the UI”, not “erase” — see [ADR 0015](decisions/0015-archive-is-not-delete.md). A backup taken after a deletion still contains the deleted row, memo and amount. **Erase all data** is different: it first writes a consistent `pre-erase-*.db` copy under `backups/`, then drops every row and compacts the file, so the live database holds no recoverable rows in free pages or the WAL. The confirmation dialog discloses that copy, and the newest three are kept. An erase is therefore recoverable from disk until those copies are rotated out, and earlier `pre-upgrade-*` and `daily-*` copies are not swept by it either; delete the whole `backups` folder if every copy must go.

[ADR 0019](decisions/0019-the-ledger-is-plaintext-at-rest.md) recorded the original plaintext-at-rest decision and wrote down the condition for reversing it; [ADR 0029](decisions/0029-encryption-is-a-choice-on-the-disk-and-on-the-way-out.md) is that reversal, and amends [ADR 0020](decisions/0020-there-is-no-app-lock.md)'s refusal of an in-app lock to allow a gate that holds a real key. Read both before changing anything in this area.

### Practical implications

- Use **FileVault** (macOS) or **BitLocker** (Windows). Without it, anyone with the disk can read the ledger.
- Do not store backups in a cloud-synced folder unless you accept that the provider can read them. The default save location is Documents, which is often synced by iCloud Drive or OneDrive.
- Encrypt backups before moving them off the machine (for example with an encrypted archive or `age`).
- Quit the app before copying the database. Copy `.db`, `-wal` and `-shm` together.
- A chosen data folder on a NAS or in a sync service is readable by whoever controls that service. Only use it if you accept that exposure, and set the folder's permissions there yourself. WageRoute opens such folders with rollback journaling and takes a writer lock, but a sync client can still produce a conflict copy; the app can only see the file it opens. See [ADR 0022](decisions/0022-the-ledger-can-live-in-a-folder-you-choose.md).
- Never run two copies of WageRoute against one ledger outside the app's own lock — for example by copying the file while one is open, or by mounting the same share on two computers that ignore the lock. The lock is advisory, not a database cluster.
- If you turn encryption on, decide custody deliberately. Adding or removing a method rewraps 32 bytes and costs nothing; **losing every way in costs the ledger**, and a hosted reset does not exist. Turning encryption *off* is always available from inside an open session, which is the reason the option is reversible rather than one-way.
- A ledger this build has encrypted cannot be opened by the published `1.2.0`, and neither can an encrypted copy in `backups/`. Before changing builds, keep a **plaintext** JSON export: `1.2.0` has no envelope reader, so a sealed copy is not a way back through an older build either.

---

## Encryption at rest and key custody

Everything here is **off until the owner turns it on** in Settings, under the card titled *Encryption at rest*, and reversible in both directions afterwards. A person who never opens that card gets exactly the install described in [Data at rest](#data-at-rest): plaintext, no key file, no passphrase prompt, nothing changed under their feet.

### The one driver

`better-sqlite3-multiple-ciphers` is the only SQLite module in the dependency tree — there is no "encrypted build" and no plain `better-sqlite3` left. An unkeyed connection reads and writes an unencrypted database exactly as plain SQLite does, so the same binary serves a plaintext ledger and a keyed one, the plaintext path is exercised by every install that has not opted in, and this feature cannot rot into an untested branch. The cipher is `chacha20`, recorded in the key file as `LEDGER_CIPHER` ([src/main/db/ledger-key.ts:24](../src/main/db/ledger-key.ts)) so a file states what it was written with rather than being assumed.

### Custody: who holds the key

The ledger is encrypted with a random 32-byte data key. That key is never stored in the clear; it is *wrapped*, once per method the user chooses, into `ledger.key.json` beside the ledger. Either wrap releases it.

| Custody | What holds the key | What it stops | What it costs |
| --- | --- | --- | --- |
| **Device** | The OS keychain through Electron's `safeStorage` — login keychain on macOS, DPAPI on Windows, libsecret on Linux when a keyring daemon answers ([src/main/db/device-custody.ts](../src/main/db/device-custody.ts)) | A copy of the folder onto another machine, another user or another login | Anyone logged in as you can ask the keychain for the key. It is device-bound, not biometric, and this app adds no gate of its own. |
| **Passphrase** | A key derived with scrypt (`N = 32 768`, `r = 8`, `p = 1`) sealing the data key under AES-256-GCM | Anyone with the files and the disk but not the phrase — including an offline guesser, who pays a memory-hard pass per try | **Permanent lockout is real.** With a phrase and nothing else, a forgotten phrase means the ledger is gone and there is no one who can help. |
| **Both** | Two wraps of the same 32 bytes | Either way in still works when the other is lost or unavailable | Two things to keep, and the phrase is still the weaker one. |

Custody can be changed at any time, in any direction, by anyone holding one way in. It rewraps the key and touches no page, so it needs no restart and no migration.

### A locked ledger has no app

`boot()` in [src/main/index.ts:283](../src/main/index.ts) opens the ledger **before** `registerIpcHandlers()`. While the file is keyed, there is no ledger window, no `window.api` and no ledger IPC channel to exercise — only the unlock prompt, which is the same bundle loaded with `?mode=unlock` ([src/main/unlock-prompt.ts](../src/main/unlock-prompt.ts), [src/renderer/src/Unlock.tsx](../src/renderer/src/Unlock.tsx)) and speaks exactly two messages: a passphrase in, a "that was wrong" back. Device custody is tried silently first; the phrase is asked for only when the device cannot answer. Closing the prompt is a refusal to unlock, not a bypass, and the app quits.

That ordering is the whole reason this is not the UI lock [ADR 0020](decisions/0020-there-is-no-app-lock.md) refused: there is no path from a locked launch to a renderer that can read rows.

A launch that finds ciphertext and no `ledger.key.json` is refused before the driver sees the file: `openLedgerKey()` reads the header first ([src/main/db/unlock.ts:154](../src/main/db/unlock.ts)) and the failure branch prints both paths plus the two ways back ([src/main/index.ts:197](../src/main/index.ts)). Handing that combination to SQLite instead answers `SQLITE_NOTADB` — the same words a genuinely damaged plaintext file gets — so the one failure a person causes by moving or restoring the `.db` without the small file beside it would read as corruption. `custody.ts` refuses the same pairing before it would re-wrap anything ([src/main/db/custody.ts:146](../src/main/db/custody.ts)).

### Turning it on, and back off

Both directions rewrite every page, so they close the database, run the transition and relaunch. The measured sequence is in `transition()` in [src/main/db/encryption.ts:112](../src/main/db/encryption.ts):

1. a `VACUUM INTO` safety copy, taken on a connection in the ledger's current state, then opened and counted before anything trusts it;
2. the transition recorded as `pending` in the key file **before** a page moves, so a crash mid-change is detectable;
3. `secure_delete = ON` → `locking_mode = EXCLUSIVE` → `journal_mode = delete` → `cipher` → `rekey` → close, then **verify on a fresh connection** (header, rows, schema version, `integrity_check`) and restore the folder's journal mode.

Those pragmas are not decoration, and each answers a way the change silently does nothing: a freed page can keep readable rows; a rekeyed page parked in the WAL leaves page 1 with its old bytes, so an "is it encrypted?" check passes on a file that was never converted; `PRAGMA key` on a plaintext file only registers a key and reports success; `rekey`'s own return value has lied twice.

Failure is handled by shape, not by hope:

- a transition that throws is rolled back by renaming the safety copy over the ledger and clearing the marker;
- a change that landed but could not confirm, or a marker and header that disagree, is reconciled at the next launch by `reconcilePending()`;
- a ledger whose **both** copies are unreadable is reported as `unrecoverable`, named with both paths, and left exactly alone. The app will not guess between a ledger and its own safety copy.
- the plaintext pre-copy is deleted the moment an encrypt verifies, and the decrypt side's copy goes too ([src/main/db/custody.ts:122](../src/main/db/custody.ts), [custody.ts:163](../src/main/db/custody.ts)). Keeping a readable duplicate of a file the user just asked to protect would be a defect dressed as a backup.

### What this layer does not do

- It does not stop a process running as your own OS user, a live unlocked session, or anyone who can read the key from memory while the ledger is open. That is still the [Operating system](#operating-system) boundary and [ADR 0020](decisions/0020-there-is-no-app-lock.md)'s territory.
- It is not a password manager, an app lock, or a second factor. The prompt asks for a key, not for identity.
- It does not hide the file's existence, its size, its shape, or the folder path in `storage.json`.
- It does not encrypt the CSV export (deliberately — [ADR 0017](decisions/0017-the-csv-is-a-review-copy.md)), the crash log, or `storage.json`.
- It does not survive losing every way in, and there is no recovery we operate.

### Headless and container use

`deviceCustodyAvailable()` returns false when no keychain answers, and a headless session or a container with no keyring daemon **throws** rather than reporting false; either way the answer is "no keychain" ([src/main/db/device-custody.ts:35](../src/main/db/device-custody.ts)). The Settings card treats that as a missing option rather than a failed one: where no keychain answers, *This computer* is not offered at all ([src/renderer/src/components/EncryptionCard.tsx:399](../src/renderer/src/components/EncryptionCard.tsx)). So in `wageroute-desktop`, an encrypted ledger is reachable by **passphrase custody only**, typed into the unlock prompt over the streamed desktop. The device wrap is not a broken option there, it is an unavailable one. See [DEPLOYMENT.md](DEPLOYMENT.md) for the container notes.

---

## Sealed exports and the phone's vault

Two different exposures, two different designs, one set of cryptographic constants. Neither is on by default and neither is required.

### A sealed backup: `wageroute-envelope` v1

`backup:export` takes `passphrase: string | null`. `null` writes exactly the plaintext JSON it always wrote. A phrase writes an envelope defined in [src/shared/envelope.ts](../src/shared/envelope.ts): `PBKDF2-HMAC-SHA-256` at 600 000 rounds, `AES-256-GCM`, with the salt (16 bytes), IV (12), tag (16), iteration count and `exportedAt` in the clear and the ledger JSON itself under the cipher.

- **The clear fields are a choice.** A person can tell these files apart, sort them by date and recognise the format without the phrase. What is secret stays secret; the envelope deliberately has no hidden header.
- **Chosen by the weakest reader.** PBKDF2 rather than scrypt or Argon2 because the phone must open desktop files and WebCrypto implements PBKDF2 and nothing memory-hard. The cost is paid in rounds, not in construction — and the desktop's *own* key file keeps scrypt, because the only reader there is Node.
- **One file, two readers.** [src/main/envelope.ts](../src/main/envelope.ts) uses `node:crypto`, [src/pocket/lib/envelope.ts](../src/pocket/lib/envelope.ts) uses WebCrypto, and a file sealed by one opens in the other; that pair is asserted in tests, not in prose.
- **A file cannot tell the app to be cheap.** The reader honours the parameters a file states only inside guard rails — 100 000 to 2 000 000 iterations, exact field lengths, a parseable date, non-empty ciphertext. Hostile values are refused outright.
- **Import reads either form.** The desktop's wizard gets a `sealed` answer and asks for the phrase before it counts anything (`data:preview` → `data:passphrase`); the phone holds a sealed file in `pendingSeal` until a phrase arrives. A wrong phrase and a damaged file are indistinguishable from inside AES-GCM, so the failure codes say what the *person* can act on: `shape` (not our file — choose a different one) or `passphrase` (fine file — type it again).

### The phone's own copy: `wageroute-vault` v1

Pocket can seal the copy that stays in IndexedDB ([src/pocket/lib/vault.ts](../src/pocket/lib/vault.ts)): one marker in the clear (`PBKDF2-SHA256`, `AES-256-GCM`, the iteration count, the salt, a sealed verifier token) over one sealed record. It shares the envelope's constants and its WebCrypto seam but not its shape, because it is written many times from one key: the phrase is stretched **once per unlock**, the derived key is non-extractable and lives only in module scope, and every save re-seals with a fresh IV. Closing the page loses the key, which is what makes a reopened phone say *locked* rather than *empty*.

- Sealed and plain copies are two members of one union under the same IndexedDB key, so sealing costs no store version, unsealing is the same single write in reverse, and there is no half-migrated state to recover from.
- Turning it on, off, or changing the phrase is done from the phone's own Data tab. A wrong current phrase rewrites nothing; a new phrase means a new salt, not a re-wrap, and the phrase it replaces is finished.
- **A phone with no key in hand cannot answer any question about its ledger**, so the vault has a third failure code — `closed` — and a save that cannot be sealed keeps its rows on screen and writes them once the vault reopens rather than pretending or discarding.
- This layer has exactly one way in. No phone gives Pocket a keychain `safeStorage` can reach, so "both" has no counterpart here: lose the phrase and this copy is sealed for good. What rescues the owner is a copy that exists elsewhere — the computer's ledger or a backup carried out — and the sheet that asks for the phrase says so before it writes anything.
- **Unlocked-and-open is not sealed.** The card says so in those words: a vault stops someone reading the stored copy of a phone that has been closed; it does nothing to a phone sitting on Pocket with the vault open.
- No PIN, and no passkey this release. A four-to-six-digit PIN is a passphrase with a smaller search space, and 600 000 rounds over ten thousand values is nothing; a passkey needs a registrable domain as its `rpId`, which a self-hosted `127.0.0.1` is not. A gate that merely hides a plaintext store is the theatre [ADR 0020](decisions/0020-there-is-no-app-lock.md) already refused.

### The cipher on the phone is a privilege of the origin

`crypto.subtle` exists only in a secure context. `http://192.168.x.x` still gives the page `crypto.getRandomValues` and gives it **no cipher at all** — so Pocket can run, and can even hold a sealed vault it cannot open. [src/pocket/lib/webcrypto.ts:44](../src/pocket/lib/webcrypto.ts) owns the answer: `hasCipher()` and one sentence, `NO_CIPHER_HERE`, naming the cause and the way out (open it over HTTPS, or on the machine it runs on).

- Every derivation, seal and open goes through the seam that calls it, and the refusal arrives as `shape` — nothing a person can fix by typing again. It is raised **before** `openPart()`'s catch-all, so a missing cipher can never be folded into the "bad tag" answer and reported as a wrong phrase.
- The screens ask, rather than hide: the vault card and the sealed-export segment show the sentence where their actions would have been, with the option still named; a sealed file's passphrase box and a vault's unlock box are disabled while a *Choose a different file* stays usable, because on such a page the file is not the problem.
- **The destructive door is disabled on purpose.** A cipherless page cannot open a healthy vault, so the unlock screen's *Forget this phone's copy* would be the end of a ledger that only looks lost. The way out is a different URL, not a delete.
- Nothing here is proven in a real browser on an insecure origin: the guard is exercised in jsdom and Node, and no document may quote an unlock delay for a phone CPU that has never run it.

### What neither seal does

They are choices about *copies*, not about the running app. A sealed backup does not stop a wrong-but-plausible ledger being imported, and a vault does not stop a malicious browser extension or a same-origin script reaching an open page. Both fail as a *secrecy* control if the phrase is short or reused: 600 000 PBKDF2 rounds and one memory-hard scrypt pass are a cost per guess, not a defence, and no document in this repository calls either "military-grade".

---

## Application shell hardening

The packaged binary is not a general-purpose Node runtime, and it does not expose developer tooling:

- **Electron fuses** (`electron-builder.yml`, applied before the ad-hoc signature): `runAsNode` off, `NODE_OPTIONS` off, `--inspect` off, cookie encryption on, embedded ASAR integrity validation on, and `onlyLoadAppFromAsar` on. A renamed `WageRoute` binary cannot be used to run arbitrary Node code, and an unpacked or modified `app.asar` fails the integrity check instead of loading.
- **No in-app developer tools.** The packaged window is created with `devTools: false`.
- **No default menu.** Electron's stock menu carries Reload, Force Reload and Toggle Developer Tools. The packaged build installs a minimal macOS app/edit/window menu (so Copy, Paste and Select All keep their shortcuts) and sets no application menu at all on other platforms.
- **The renderer runs sandboxed** with `contextIsolation: true` and `nodeIntegration: false`; the only bridge is the typed `window.api` object.
- **A newer database is refused, not guessed at.** `migrate()` raises `SchemaTooNewError` when `user_version` exceeds the schema this build applies, the app shows a dialog naming the problem and quits, and the file is left untouched. An older build cannot write to a schema it does not understand.
- **A damaged database is refused too.** Before migrating, `assertHealthy()` runs `PRAGMA quick_check`. A failure raises `DatabaseCorruptError`: the app names it, quits, and does not open a window or write to the file.
- **A locked ledger has no app.** `boot()` opens the ledger before it registers a single IPC handler, so while a keyed file stays shut there is no ledger window, no `window.api` and no ledger channel in the process — only the unlock prompt. See [Encryption at rest and key custody](#encryption-at-rest-and-key-custody).
- **Upgrades keep a copy.** A schema migration rewrites the file and cannot be undone, so `backupBeforeUpgrade()` writes a consistent `VACUUM INTO` copy under `backups/` (newest three kept) before it runs.
- **The last week keeps itself.** After the migrations settle, `backupDaily()` writes one `daily-YYYY-MM-DD.db` copy per local day (newest seven kept). A copy for today ends the call, and a failure is logged rather than thrown, so a full disk cannot keep the ledger closed.
- **The packaged page cannot talk to a local server.** The CSP baked into the built `index.html` is `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`. The development policy (inline script for React Refresh, `ws://localhost` for HMR) never ships.
- **IPC is bound to the app's own page.** Every handler runs `isTrustedFrame()` first and refuses a sender whose frame URL is not the built `index.html` (or the dev server while developing). A compromised or injected frame cannot exercise the ledger API on the app's behalf.
- **A boot failure is visible.** The main process logs to `logs/main.log`, shows an error dialog naming the problem and the log file, and quits — it cannot end up running with no window. A window that opened but never filled is the same kind of failure and is no longer silent: `src/main/window-load.ts` watches each window's own document, reloads it twice, and then logs and says why the screen stayed blank instead of leaving a person in front of an empty frame.
- **The build can say what it is without guessing.** Settings → Diagnostics reports the version, schema, Electron/Chromium/Node versions, platform, database and log paths, log tail and row counts, and copies that report as text. It is assembled from runtime values, not from the source tree, so a support report describes the binary in front of the user.
- **The licence and third-party notices ship with the app.** The packaged build carries `LICENSE` and a generated `THIRD-PARTY-NOTICES.txt` as extra resources, and Settings → About can display both, so the dependency set is disclosed rather than implied.
- **Repository refusals are typed.** `RepositoryError` carries a code (`VALIDATION`, `NOT_FOUND`, `CONFLICT`, `STATE`) that survives IPC through an encoded marker, so the UI can distinguish "the record is gone" from "the input is wrong" without parsing prose.

Signing remains ad-hoc only — see [Known weaknesses](#known-weaknesses). Fuses and ASAR integrity protect the shape of the bundle, not its authenticity.

---

## Network exposure

The application code makes **no outbound network requests**. There is no HTTP client, no telemetry SDK, no crash reporter, no update checker, no bank integration and no analytics.

The development policy in [src/renderer/index.html](../src/renderer/index.html) allows inline scripts and a local socket:

```text
script-src 'self' 'unsafe-inline'
connect-src 'self' ws://localhost:* http://localhost:*
```

The Vite dev server needs both. A packaged build does not: `strictCsp()` in [electron.vite.config.ts](../electron.vite.config.ts) replaces the meta tag during the build with the policy quoted under [Application shell hardening](#application-shell-hardening), which has no inline-script allowance and `connect-src 'self'` only. The shipped page therefore cannot start an inline script or open a connection to a local service, and a compromised renderer has no CSP-sanctioned way to run injected code.

The main process can open an external browser for `http(s)` URLs passed to `window.open` (`setWindowOpenHandler` in [src/main/index.ts](../src/main/index.ts)). Only one destination is allowed — `https://buymeacoffee.com/revax`, compared by exact origin and path in [src/main/window-security.ts](../src/main/window-security.ts) — and every other URL, including other `http(s)` hosts, is denied without being opened. The one UI link is the static **Buy me a coffee** anchor in Settings, which targets `_blank` and leaves the app through this handler. The allowlist means a renderer compromise can no longer use the handler as a general exfiltration path.

### Containers

The two images in `docker/` are the first thing this project **ships** that listens on a port. The development servers have always listened (`pocket:dev` on 5173, `pocket:preview` on 4173, the renderer dev server on 5173, all bound to localhost), but they are not the product; a container is, and it is still not an installer. These notes therefore add a boundary the release build never had, and the containers get their own notes.

- **`wageroute-pocket`** is nginx serving static files. It still has no backend, no environment and no secret, and the ledger never becomes a request, a header or a cached response. Its config closes the one gap a plain file drop leaves — `frame-ancestors 'none'` as a real header, where the `<meta>` policy ignores it — and splits `Cache-Control` so the offline shell keeps working. Reachable only on `127.0.0.1` it is a local server; republished to `0.0.0.0` it is a plain-HTTP site anyone on the network can read and write through, and a handset loading it over plain HTTP gets no service worker, no install prompt **and no `crypto.subtle`** — so the vault and sealed exports are unavailable there, not merely unwired. Serving it to other people means TLS in front, on a host you control.
- **`wageroute-desktop`** is the one place in WageRoute where a remote party can drive the app. x11vnc binds to loopback *inside* the container and only noVNC's websocket is published, but anyone who authenticates to that websocket sees and controls the entire desktop, cursor included: Electron's single-instance lock means there is exactly one session and every viewer shares it. The VNC password travels over that websocket unencrypted — on the default `127.0.0.1:6080` mapping that is the loopback interface, republished it is your network — and when `WAGEROUTE_VNC_PASSWORD` is unset the container generates one and **prints it to its own log**, so read `docker logs` as a credential store. Encryption at rest does not change this picture: a viewer who can drive the desktop can wait for the ledger to open, and after that the cipher protects nothing they can see. The unlock prompt masks the phrase the way a password field does, with a *show* toggle the person can press. In this container `deviceCustodyAvailable()` is false, so the **only** custody available is a passphrase — and the volume holds both `wageroute.db` and `ledger.key.json`, which is exactly the pairing that makes the marker insufficient on its own.
- Neither image is part of a release, and the publishing workflow has never run. A container changes where the code runs, not what it enforces. For the desktop, the CSP, the external-link allowlist, the permission handler and the repository validation all still live inside `app.asar`, and nothing about being containered weakens them; the one documented exception is the renderer sandbox, per [What "sandbox" means here](#what-sandbox-means-here). For Pocket, the container adds two HTTP response headers to the same files `npm run pocket:build` writes and enforces nothing else — a person who drops the folder on any host gets the same app with the same `<meta>` policy, and the `frame-ancestors` gap stays open on a host that cannot send headers.
- **The `edge` profile moves the door outside this repository, and that is a security change even though no app code is touched.** `docker/edge.Caddyfile` and the `caddy` service terminate TLS and ask an identity provider whether a connection may in before anything reaches a tenant. From that moment two owners control one ledger: the proxy's configuration, and a `forward_auth` bug or a `WAGEROUTE_BIND` typed as `0.0.0.0` publishes a financial history in a way this codebase cannot see or stop. What the example does enforce, each part checked on 2026-11-04: the tenant containers publish **no ports**, so from outside the machine running Docker the proxy is the only path in — measured with two tenants up, where a tenant's own container address did not answer even from the Docker host itself, though no second physical machine has tried; `forward_auth` proxies nothing unless the provider answers `2xx`, so a provider that is down or misconfigured yields an error page rather than an open ledger; the unset-name guard exits 1 instead of serving a site called `pocket.`; and no request selects a data folder — the *site block* picks the upstream, so a mistyped name shows Caddy's error instead of another person's money. What it does not enforce: delete both `forward_auth` blocks and you have HTTPS with no door, which is a shape [ADR 0030](decisions/0030-self-hosting-puts-identity-at-the-edge.md) supports and this bullet exists to warn about. See [DEPLOYMENT.md](DEPLOYMENT.md#tls-a-login-and-more-than-one-person).

---

## Supply chain

The build is part of the product. WageRoute ships Chromium, a native SQLite module and a small JavaScript dependency tree, and it is assembled by npm and GitHub Actions.

Current controls:

- `package-lock.json` pins the resolved dependency tree; CI and the release instructions use `npm ci`, not `npm install`.
- The runtime dependency set is small: React, React DOM, Zustand, react-data-grid, lucide-react and `better-sqlite3-multiple-ciphers`. The rest is build tooling.
- **One SQLite driver, and it carries a cipher codec.** The fork replaced `better-sqlite3` outright rather than sitting beside it, which is what keeps the encrypted path from rotting — and it is a wider supply-chain surface than the plain module was, because the code that can decrypt a ledger now ships to everyone. Its prebuilds cover all packaged targets, and `npm run notices` names it in `THIRD-PARTY-NOTICES.txt`.
- The `.node` that answers for the codec is the fork's own **N-API prebuild** for this platform and architecture — the same file loads under Node and under Electron, so an Electron version bump does not invalidate it and nothing is compiled against a versioned V8 ABI. `npmRebuild: true` and `postinstall: electron-builder install-app-deps` are still in the scripts, and for this module they do nothing; they remain for a platform with no prebuild, where the source build is the only way to get a binary. What *is* load-bearing is the `**/*.node` `asarUnpack` rule: a `.node` inside the asar cannot be `dlopen`ed, and the file is unpacked beside the archive rather than read out of it. The supply-chain consequence is that the shipped binary is the one the fork published for this platform, so `npm ci` on the lockfile is what pins it.
- No runtime CDN, remote font, remote image or remote script is used. The CSP blocks remote origins by default.
- **GitHub Actions are pinned by commit SHA**, not by a moving major tag. The version each SHA corresponds to is in a comment beside it, and Dependabot-style bumps must replace the SHA.
- **CI builds from the lockfile and runs the gates** — `npm run lint`, `npm test`, `npm run build` and an unpacked `electron-builder --dir` pass — before any artifact is uploaded. The build matrix has read-only token permissions; a separate release job holds `contents: write` and only runs for a tag.
- **Every release artifact is checksummed in CI.** The release job writes `SHA256SUMS` over the installers it downloads and attaches it to the draft release, so a published checksum is produced by the same run that built the file rather than by hand afterwards.
- **Third-party notices are generated, not remembered.** `npm run notices` (also run by `prebuild`) walks the production dependency tree in `package-lock.json`, reads each licence file and writes `THIRD-PARTY-NOTICES.txt`, which is packaged as an extra resource.
- The repository is public at `ReVax-2007/wageroute`. The source-available [LICENSE](../LICENSE) keeps commercial redistribution with the licensor, and nothing user-financial is ever committed.

Known gaps:

- no `npm audit`, Dependabot/Renovate or dependency-review gate in CI;
- no SBOM, build provenance or reproducible-build check;
- installers are unsigned, so a tampered build cannot be distinguished from a legitimate one by the OS — the published `SHA256SUMS` is the only integrity check;
- an Electron major upgrade still needs a full packaged-app test, not just a typecheck: the shell, its fuses and the packaging tooling move together. The SQLite module is the part that no longer moves with it — its binary is N-API, so the same prebuild serves the new Electron — and every release-notes rule in [RELEASING.md](RELEASING.md#semver-policy) about treating such an upgrade as a feature release stands.

A compromised dependency or action runs with the build's privileges. Because the app makes no outbound requests, a malicious package would have to add that capability itself; review diffs and lockfile changes rather than assuming the network policy protects the build. Recommendations are in [Hardening recommendations](#hardening-recommendations).

---

## Pocket (web app)

Pocket is a separate static build in `src/pocket`. It has no main process, no SQLite, no IPC and no server; it is HTML, CSS, JavaScript, a manifest and icons served from one origin.

- **No network path exists.** The production CSP is `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'`. There is no remote script, font, analytics or telemetry call. The only file read is the one the user picks; it is read with `File.text()` and never uploaded.
- **The ledger is plaintext in IndexedDB by default**, just as the desktop database is plaintext on disk — and, like the desktop, it can be sealed if the owner asks. The phone's vault ([src/pocket/lib/vault.ts](../src/pocket/lib/vault.ts), [The phone's own copy](#the-phones-own-copy-wageroute-vault-v1)) puts one sealed record plus a marker in the clear where the plain copy used to sit, and closing the page loses the key, so a reopened phone is locked rather than empty. What no vault changes: any script that runs on the same origin — including a malicious browser extension — can read the ledger **while the vault is open**, and anyone using the same unlocked browser profile can open the app. There is still no UI-only app lock, matching [ADR 0020](decisions/0020-there-is-no-app-lock.md).
- **The service worker only caches the app shell.** It skips non-GET and cross-origin requests; navigation is network-first with a cached `index.html` fallback; hashed assets are cache-first. The precache list and release stamp are written into `sw.js` at build time, so the shell it holds is the bundle actually shipped. It never stores the ledger, the backup file or an export.
- **A backup cannot execute anything.** Pocket parses it with `JSON.parse`, reads a fixed table list and validates rows defensively; a malformed, oversized or schema-inconsistent file is refused before it reaches the store. A file that arrives as a `wageroute-envelope` is not parsed as a ledger at all: it is held in `pendingSeal` until a phrase turns it into one, and a wrong phrase or a changed file is a typed refusal, not a partial import. For a schema version the build knows, every enum must be one of the values in `lib/enums.ts` rather than being coerced, and every money field must be a whole number of cents. An opened file merges into the phone's copy by the same newer-wins rule as the desktop, and an export writes the tables exactly as the phone holds them — sealed under a passphrase first, if the person typing asked for one.
- **A key the file does not carry is accepted, and that is the dangerous half.** A column added by a later schema is simply absent from an older file — a backup from released 1.2.0 has no due day on a bill's set-aside — and refusing it would lock a person out of their own ledger, so `parseBackup` lets it through. Its readers then answer a missing key with `0` or `''`, which is a value the file never stated. Nothing may run a rule on that: a day of `0` silently opens a gate that a real day would have closed, so the phone derives a claim's state only from facts the desktop's schema would have guaranteed and leaves the rest as the file has them. Rows repeating one id collapse to the one the desktop's merge keeps, so a hand-edited file cannot make one promise collect money twice.
- **A phone write goes through the desktop's own validator.** The writers in `src/pocket/lib/write.ts` call `src/shared/writeRules.ts`, the same module the desktop repositories use, so an amount, date, enum or name the desktop would refuse cannot be saved on the phone either — and a row the phone did save is one the desktop's merge can accept without a special case. A refusal is shown on the sheet and nothing is written, so a rejected edit never reaches IndexedDB and never travels in an export.
- **Installing requires a secure origin.** Service workers and the install prompt work on HTTPS (or `localhost` for development). A static host that serves the folder over plain HTTP gives an app with no install prompt and no offline shell. The deployment origin should be one the user already trusts, such as the project's GitHub Pages site.
- **The same rule decides whether a cipher exists.** `crypto.subtle` is a privilege of the origin, not of the app: `http://192.168.x.x` gives the page `crypto.getRandomValues` and no cipher at all. Pocket answers that with one sentence at the seam every cryptographic call goes through, reported as a shape failure rather than a wrong passphrase, and with the sealed-export segment, both passphrase boxes and the unlock screen's destructive *Forget this phone's copy* disabled until the page is served over HTTPS or from the machine it runs on. See [The cipher on the phone is a privilege of the origin](#the-cipher-on-the-phone-is-a-privilege-of-the-origin).
- **Site data is the phone's security boundary.** Clearing the browser's site data, using private browsing or switching browsers removes the copy — sealed or not, since the marker and the key live in that same storage. Export before replacing the file or forgetting the phone; the app says so in both confirmations, and if IndexedDB refuses the erase it says the stored copy may remain instead of claiming it is gone.
- **Framing protection is not available in a meta CSP.** `frame-ancestors` is ignored when delivered by a `<meta>` tag, so the page relies on the host's response headers against clickjacking. GitHub Pages does not send them; a deployment that needs this should add `Content-Security-Policy: frame-ancestors 'none'` at the host.

---

## Import security

JSON backups — plain or sealed as a `wageroute-envelope` — and CSV entry files are the only external data the app accepts.

### What a malicious file cannot do

- **It cannot execute code.** JSON is parsed by `JSON.parse`; CSV is parsed by a hand-written state machine. No `eval`, no dynamic import, no shell.
- **It cannot inject SQL.** Every value is bound as a parameter. Column names come from a fixed allowlist, and table names come from a fixed order list.
- **It cannot choose its own `user_id`.** Imported rows are rewritten to the local user ID.
- **It cannot read another file.** The renderer cannot pass a path; the native dialog chooses one path, and only that file is read.
- **It cannot escape the chosen export path.** Export writes to the path returned by the save dialog.
- **It cannot abort a healthy import.** Everything inserts inside one transaction, but each row is guarded on its own: a row that still violates a `STRICT` type, `CHECK` or foreign-key rule after the wizard is reported as an issue and skipped, and the remaining rows commit. A file built to break one row cannot damage the rest of the database. (Before the import wizard existed, a constraint failure rolled the whole import back; that is no longer the design.)
- **It cannot overwrite a setting with an older copy.** Settings merge per key: the file's value replaces the local one only when its stamp is newer, and a missing or older stamp leaves the local value alone. Unknown keys and an unusable currency are refused.
- **It cannot plant settings this build does not read.** A key outside the build's settings table is reported and skipped, so a future downgrade cannot act on an unknown switch.
- **It cannot overwrite an existing row with an older copy.** An ID this ledger already holds is replaced only when the file's row carries a newer stamp (or an equal stamp with a higher revision); an older or unstamped copy is skipped.
- **It cannot split a category.** A category whose name already exists is matched by case-insensitive name and the imported transactions are relinked to the local row, instead of inserting a twin or a dangling id.
- **It cannot make the app reach for a key unasked.** A file that parses as a `wageroute-envelope` is reported as `sealed` and nothing is derived until a person types a phrase into the step that asks for it; on the phone the bytes wait in `pendingSeal`. An unsealed file never enters that path.
- **It cannot forge its way into a ledger.** AES-256-GCM authenticates the sealed bytes, so a changed ciphertext, a flipped character or a mismatched tag is a refusal (`shape` — “typing the phrase again will not change this”), not a ledger with one number quietly altered. A vault marker naming a format, version or cipher this build does not ship is rejected before a key is derived from it.

### What a malicious file can do

- **Create plausible-looking but false financial records.** Imports have no signature or provenance, and a newer-stamped row can replace an existing one. A file can add, alter or tombstone accounts, transactions, bills and goals that look real. Treat an imported ledger as untrusted until reviewed.
- **Look authenticated without being trustworthy.** A seal proves the bytes are the bytes that were sealed and that the phrase opened them; it says nothing about who sealed them. A file from a stranger opens with the phrase *they* chose and lands in this ledger as ordinary untrusted rows — so a sealed backup is not a signed one, and the merge rules above are what actually apply to it.
- **Exhaust resources within the caps.** 64 MiB of JSON and up to 200,000 rows per table can still take time and disk. The UI grid shows at most 500 transactions and 24 paychecks, so the damage is mostly to derived totals and startup time.
- **Insert misleading text.** Memos, categories, account names and institution names are stored and displayed. React escapes them, so they cannot become HTML, but they can contain control characters, very long strings or deceptive labels.
- **Insert malformed optional dates and absurd text lengths.** The wizard now rejects impossible calendar dates in the required date fields, but optional dates such as `bills.next_due_on` and `goals.target_date` still bypass it, and the backup path does not apply the repository's length validators. SQLite `STRICT` and `CHECK` constraints catch wrong types and invalid enums/amounts; they do not validate date syntax or limit string size. A resulting “Invalid Date” can distort projections.
- **Add tombstoned rows.** A deleted row imported from another device is invisible but retained, consistent with the sync model.
- **Use up to the full 64 MiB in one string value.** Nothing in the backup path caps individual field lengths.
- **Trigger confusing duplicate accounts.** IDs are preserved, so importing the same account under a new ID creates a second account with the same name and institution.

### CSV-specific

- The CSV parser is RFC 4180-style and quote-aware; malformed quoting produces issues rather than code execution.
- The importer only reads the first 10 rows looking for a header, then requires date, account and amount columns.
- Amounts are parsed into integer cents; unparseable rows are reported as issues.
- Transfers are skipped with a reason rather than paired automatically.
- Rows do not trigger round-up; imports are direct inserts.
- Deduplication uses a fingerprint (account, kind, amount, date, memo, category), so a modified memo defeats it. Duplicate-looking rows can be imported intentionally.

### Formula injection on export

`transactionsToCsv` treats text as data, not as a possible formula. A cell in a text column whose first character is `=`, `+`, `-`, `@`, tab or carriage return is prefixed with a single quote by `defuseFormula()` in [src/shared/csv.ts](../src/shared/csv.ts), so a memo such as `=HYPERLINK("https://example.invalid","click")` opens as text in Excel and other spreadsheet applications. Dates and amounts are deliberately not defused: they are machine-readable values and never begin with an ambiguous character except the amount's leading `-`, which a spreadsheet reads as a negative number.

Residual risk: an import pipeline that strips a leading apostrophe can turn the cell back into a formula, and re-saving an exported file in a spreadsheet can reintroduce formulas. When a ledger contains text you did not enter yourself, open the export in a text editor or import it as text. The export is a review copy, not a backup — see [ADR 0017](decisions/0017-the-csv-is-a-review-copy.md).

### Backups as data, not instructions

A backup is a data file. It is not a configuration bundle, a plugin or a script. Do not import a file from someone you would not trust with your ledger, and do not treat instructions embedded in memos or account names as anything other than text. A passphrase typed at the import step stays on the machine: it is used only to stretch a key against the file in front of it, the app has no network path, and no service exists that could receive it.

---

## Threat model

Likelihood assumes a normal personal installation, not a targeted investigation.

| # | Threat | Scenario | Mitigation | Residual risk |
| --- | --- | --- | --- | --- |
| 1 | Local data disclosure | Another process or user reads `wageroute.db` | OS account separation; FileVault/BitLocker; no network; opt-in cipher over the file | **High** if malware runs as the same user or the disk is unencrypted. Encryption does not change the same-user case: that process reaches the key in memory or the open app. |
| 2 | Lost or stolen device | Laptop stolen while unlocked or disk removed | OS full-disk encryption; opt-in ledger cipher, which survives with the disk and without the session | **High** without FDE, and **high** with neither control. An encrypted ledger plus either custody method turns this into an offline cracking problem; a device wrap on a powered-off machine is out of reach, and a passphrase is only as good as the phrase. |
| 3 | Malicious import | A crafted JSON/CSV adds false rows or oversized text | Parser allowlists, size/row caps, SQLite constraints, per-row guards inside one transaction | **Medium** — fabricated data, misleading UI, slow projections |
| 4 | Renderer compromise | XSS or a malicious dependency runs in the renderer | Sandbox, context isolation, no Node, CSP, no HTML sinks, narrow bridge; no ledger window or ledger channel exists while a keyed ledger is locked | **High for the ledger** — once the app is open, full read/write via `window.api`; possible external-URL exfiltration |
| 5 | Supply chain | A compromised npm package or GitHub Action alters the build | Lockfile, `npm ci`, small dependency set, review | **Medium** — no audit, SBOM, provenance or SHA-pinned actions. The single SQLite driver now carries a cipher codec, so a compromise there can reach decrypted pages. |
| 6 | Tampered installer | A modified DMG/EXE is distributed | Published `SHA256SUMS` from the build run; public source | **Medium** — no code signing, so the OS cannot vouch for the binary |
| 7 | Shared computer | A colleague or family member uses the same OS session | None inside the app while it runs ([ADR 0020](decisions/0020-there-is-no-app-lock.md)); a keyed ledger at least asks for the phrase before any app exists | **High** — no app lock, no separate profiles, and a session left open gives the whole ledger away |
| 8 | Accidental deletion | A transaction or account is deleted | Soft delete retains the row; backups | **Low** for recovery, but no undo UI and no purge |
| 9 | Disk/database corruption | Power loss, disk failure, killed process | WAL, `synchronous=NORMAL`, transactions, FK | **Medium** — no automatic backup, no scheduled `integrity_check` |
| 10 | SQL injection | A crafted ID or imported value reaches SQL | Prepared statements, ID checks, column allowlists | **Low** |
| 11 | Arbitrary file read/write | Renderer asks main to read a path | Native dialog; no path parameter over IPC | **Low** — social engineering of the user remains |
| 12 | Denial of service | A huge import or many rows | 64 MiB cap, 200k rows/table, UI limits | **Medium** — startup and derived calculations can still slow. A sealed file costs the iteration count it declares, capped by the rails; a huge file can still make someone wait out a legal 2 000 000-round derivation. |
| 13 | CSV formula execution | Exported memo begins with `=` and is opened in Excel | `defuseFormula()` prefixes `= + - @ tab CR` on text columns | **Low** — amounts stay numeric; a deliberately apostrophe-prefixed cell is still text |
| 14 | Backup exposure | Plaintext backup in iCloud/OneDrive/Documents | User choice of path; a per-export passphrase seal that both devices can open | **Medium** while the option is unused — provider and sync history can read it. **Low–Medium** once sealed: the header and `exportedAt` are still visible, and the phrase is not. |
| 15 | Deleted-data retention | User expects deletion to erase data | Soft deletes for a single row; **Erase all data** drops rows and compacts, after a disclosed `pre-erase-*.db` copy | **Low–Medium** — a single delete is a tombstone; an erase is recoverable from that copy until it is rotated out |
| 16 | Lost key custody | The passphrase is forgotten, the keychain login is gone, or `ledger.key.json` is deleted | Two wraps under *Both*, custody changeable at any time, the marker refused rather than guessed at | **High and unrecoverable** when only one method was chosen. No escrow, no reset, no support path exists — and the encrypted copies in `backups/` are lost with it |
| 17 | A change interrupted mid-flight | Power loss or a kill during an encrypt/decrypt | `pending` marker written before a page moves, `VACUUM INTO` pre-copy, verified on a fresh connection, `reconcilePending()` at the next launch, and a refusal to guess when both files are unreadable | **Medium–Low** — this is the code that can lose data if wrong. Both directions of the change have run in the packaged app with clean exits; the **interrupted** case has never been run there, and never on real power loss |
| 18 | A hostile sealed file or marker | An envelope or vault marker that declares its own cost | The reader honours stated parameters only inside rails (100 000–2 000 000 iterations, exact field lengths, parseable date, non-empty ciphertext); unknown formats and versions are refused | **Low** — the rails bound both a cheap and an absurd claim; a legal maximum still costs a real derivation |
| 19 | A phone page with no cipher | Pocket served over a plain-HTTP LAN address, where `crypto.subtle` does not exist | One refusal sentence at the WebCrypto seam, reported as `shape`, and the destructive *Forget this phone's copy* disabled on such a page | **Medium** for a self-hoster who follows the plain-HTTP shape: the vault is simply unavailable there, and a locked copy looks lost until the cause is named |

### Explicitly out of scope

- A remote attacker with no local access and no malicious file. The **installers** have no listening service and no inbound network path, so this stays out of the product's threat model. The `wageroute-desktop` container is the exception and is out of scope only while its port stays on `127.0.0.1`: republish 6080 and a remote party who guesses the VNC password can drive the app, with consequences described under [Containers](#containers).
- Bank fraud, account takeover or payment initiation. WageRoute never connects to a bank and never moves money; “routing” is an envelope plan stored locally.
- Multi-user authorization. There is one local user row and no login.
- Malicious administrators, kernel malware or physical memory attacks.

---

## Known weaknesses

Listed with severity for this app's context. None are fixed in `1.2.x` unless stated — and the encryption rows describe the build in this repository, which the published `1.2.0` does not contain.

| Weakness | Severity | Impact | Notes |
| --- | --- | --- | --- |
| Unsigned macOS, Windows and Linux builds | **High** for distribution | Tampering is hard to detect; Gatekeeper/SmartScreen friction | Published `SHA256SUMS` is the only integrity check; see [RELEASING.md](RELEASING.md#code-signing-and-notarization) |
| Encryption at rest is opt-in, so a default install is plaintext | **High** on a stolen disk, **by design** | Full ledger readable on any install that never opened the Settings card | Deliberate: opt-in, reversible, never imposed ([ADR 0029](decisions/0029-encryption-is-a-choice-on-the-disk-and-on-the-way-out.md)). FileVault/BitLocker remain the control for everyone who has not turned it on ([ADR 0019](decisions/0019-the-ledger-is-plaintext-at-rest.md) as superseded) |
| A forgotten passphrase can be permanent | **High** where passphrase is the only custody | The ledger, and every encrypted `backups/` copy of it, are unrecoverable. No reset, no escrow, no support path | *Both* custody exists to make this the rare case; every dialog that asks for a phrase has to say it in the same words as the honesty table |
| An encrypted `.db` is a downgrade trap | **Medium** | The published `1.2.0` reads a keyed ledger as `SQLITE_NOTADB` and cannot migrate or repair it | Take a **plaintext** JSON backup before changing builds: `1.2.0` ships neither the cipher driver nor the envelope reader, so nothing encrypted or sealed is readable there |
| The transition rewrites the whole file | **Medium** | A crash mid-change needs the `pending` marker, the pre-copy and `reconcilePending()` to land correctly | Round-trip proven inside the running app on scratch ledgers, and both directions ran end to end in the **packaged** macOS app on 2026-11-04 with passphrase custody ([UNRELEASED.md](UNRELEASED.md), Batch 57); the crash-in-the-middle case and a device wrap have still never run there |
| The phone's vault has never run on a phone | **Medium** for the promises we may make about it | The screens are driven in jsdom and the WebCrypto half measured in a laptop Chromium; iOS Safari and Android Chrome have never been timed or tested | No document may quote an unlock delay, and whether a browser evicts the IndexedDB copy under storage pressure — sealed or not — is unverified too |
| A plain-HTTP phone gets no cipher | **Medium** for self-hosters | `crypto.subtle` is absent off a secure origin, so the vault and sealed exports are unavailable, and a locked copy can look lost | One sentence at the seam names the cause; the destructive erase is disabled on such a page. Serve Pocket over HTTPS or from the machine it runs on |
| Soft-deleted rows retained | **Medium** (privacy) | A normal “delete” keeps the row in the database and in backups | **Erase all data** drops every row and compacts the file; per-row deletion is still a tombstone |
| Backup copies outlive the erase | **Low–Medium** (privacy) | The ledger can be recovered from `backups/pre-erase-*.db` or an older `daily-*`/`pre-upgrade-*` copy | Pre-erase copy disclosed in the confirmation dialog; delete the `backups` folder to remove every copy |
| Backup import bypasses length/date validators | **Medium** (integrity) | Oversized strings, malformed dates, odd revision values | SQLite constraints still apply |
| No dependency audit, SBOM or provenance | **Medium** | Supply-chain issues are found late | `npm ci`, SHA-pinned actions and review only |
| No app lock or idle timeout | **Medium** on shared devices | Anyone at an unlocked session can read the ledger | No *UI-only* lock by design ([ADR 0020](decisions/0020-there-is-no-app-lock.md)); the launch prompt asks for a key, not for identity, and only exists when the owner encrypted the file |
| The device wrap is not a biometric | **Medium** (misreading risk) | Anyone logged into the OS account can ask the keychain for the key | Stated on the Settings card in those terms; a passphrase wrap can be added on top |
| External URL handler has one hard-coded entry | **Low** today | A compromised renderer could still ask the OS to open the support page | Exact origin and path allowlist (`https://buymeacoffee.com/revax`); all other navigation blocked |
| Default backup path is Documents | **Low–Medium** | May be cloud-synced | User can choose another path, and a passphrase per export |
| No audit log of edits/deletes | **Low–Medium** | Cannot reconstruct who changed what | Single-user app; backups are the fallback |
| Error messages may include local paths | **Low** | Reveals username/path to the local user | Not remote — and now also in the encryption dialogs, which name both the ledger and its safety copy on purpose |

Fixed in 1.2.0 and removed from this table: CSV formula injection on export, the permissive production CSP, missing IPC sender validation, database file permissions, and the missing startup integrity check. See [Implemented controls](#implemented-controls).

---

## Hardening recommendations

Ordered by value for this project. None are implemented unless explicitly noted.

### Before distributing beyond your own machines

1. **Sign and notarize macOS builds; sign Windows builds.** Without this, users cannot distinguish your build from a modified one. See [RELEASING.md](RELEASING.md#code-signing-and-notarization).
2. **Publish SHA-256 checksums** with every installer, and verify them after download. *(Done: the release job writes `SHA256SUMS` over the artifacts and attaches it to the draft release.)*
3. **Pin GitHub Actions to commit SHAs** and add a dependency review step. *(Partly done: every action is SHA-pinned with its version in a comment; there is still no dependency-review step.)*
4. **Add `permissions: contents: read`** to the workflow so the default token is not broader than needed. *(Done: the build matrix is read-only; only the tag-triggered release job holds `contents: write`.)*

### Data protection

5. **Turn on FileVault/BitLocker** on every machine that runs WageRoute. This is the single highest-value control, and encryption at rest does not replace it — it is the layer under this one, not the way around it.
6. **Encrypt backups** before storing them off the machine. *(Partly done: an export can be sealed with a passphrase that both devices open, per export rather than globally; a plaintext backup still needs an archive or `age` if you want a format outside this app.)*
7. **Tighten database permissions** — create the file with mode `0600` on POSIX systems, and confirm the directory is user-only. *(Done: `chmodSync(file, 0o600)` best effort on open, and the same writer gives `ledger.key.json` mode `0600`.)*
8. **Add an optional purge/compact action** that physically removes tombstoned rows, with a clear warning that it breaks sync history. *(Partly done: erasing all data drops every row and runs `VACUUM`; there is no per-row purge.)*
9. **Encrypt the ledger** if the threat model includes disk theft without FDE. *(Done: opt-in, reversible, one driver, key custody in the user's hands — [ADR 0029](decisions/0029-encryption-is-a-choice-on-the-disk-and-on-the-way-out.md), and proved in the packaged macOS app on 2026-11-04. What remains is the device wrap and a handset, not adding it.)*
10. **Verify the encrypted paths in the shape users run.** Half done on 2026-11-04: the packaged app encrypted a scratch ledger, restarted into the unlock prompt, opened it, moved a keyed ledger to a data folder and back, and decrypted it again. Still open — a Settings **restore** from a keyed `VACUUM INTO` copy, the native folder picker itself, a device wrap in an installed build, and a Windows or Linux artifact. The unit-level move coverage is `src/main/storage.test.ts`.
11. **Revisit the cost parameters before distribution, not after.** The key file's scrypt (`N = 32 768`) and the envelope's 600 000 PBKDF2 rounds are recorded in the file so they can rise without locking anyone out — but every raise makes an old ledger slower to open on a weak machine, and no phone CPU has been timed.
12. **Give the key file the same care as the database in every folder operation.** A move carries `ledger.key.json` with it ([ADR 0022](decisions/0022-the-ledger-can-live-in-a-folder-you-choose.md)); legacy adoption moves only a plaintext pre-rename database and has no key-file code at all ([src/main/db/legacy.ts:33](../src/main/db/legacy.ts)). So the pair only comes apart outside the app — and a launch that finds ciphertext with no key file now names both paths and quits instead of reporting corruption ([src/main/db/unlock.ts:154](../src/main/db/unlock.ts)). What has not been proven is a packaged install doing the **legacy** half: the in-app move carried the key file in the packaged app on 2026-11-04 — driven through the IPC behind the folder picker, which is still unproven itself — but no pre-rename database has ever been adopted by an installed build.

### Application hardening

13. **Neutralize CSV formulas on export.** Prefix `=`, `+`, `-`, `@`, tab and carriage return with a single quote, or offer a raw export. Add tests for memos and account names. *(Done: `defuseFormula()` applies to the text columns; amounts are untouched.)*
14. **Tighten the CSP** for production: remove `'unsafe-inline'` from `script-src` and drop localhost from `connect-src`. Verify the packaged build first; Vite may inline a bootstrap script. *(Done: `strictCsp()` rewrites the meta tag at build time.)*
15. **Add `base-uri 'none'`, `object-src 'none'`, `frame-ancestors 'none'` and `form-action 'none'`** to the CSP. *(Done, production policy only.)*
16. **Validate the IPC sender** — reject calls whose `senderFrame` is not the main window's top frame. *(Done: `isTrustedFrame()` guards every handler.)*
17. **Apply repository validators to imported rows** (text length, date syntax, revision bounds) before insert, or share one validation layer between both paths.
18. **Cap individual field lengths on import** to match the UI limits.
19. **Remove or allowlist the external URL handler** if no feature needs it.
20. **Add `PRAGMA integrity_check`** on startup or on demand, and surface the result rather than silently continuing. *(Done: `PRAGMA quick_check` before migrating; a failure refuses to open the file, and a transition verifies with a full `integrity_check` on a fresh connection.)*
21. **Add automated dependency updates and `npm audit` in CI**, with a documented triage policy.
22. **Add a lightweight audit trail** (append-only local log of create/update/delete with timestamp) if the ledger becomes shared or business-critical.
23. **Serve a self-hosted Pocket over TLS.** Without a secure origin the phone gets no service worker, no install prompt and no cipher at all, so the vault and sealed exports simply are not available there. *(Worked example: `docker-compose.yml`'s `edge` profile with `docker/edge.Caddyfile` — TLS and a forward-auth login at the proxy, never in the app, per [ADR 0030](decisions/0030-self-hosting-puts-identity-at-the-edge.md). It was validated and driven locally on 2026-11-04; no handset has run it.)*

### Operational

24. **Do not run WageRoute on a shared OS account.** Use a separate user account per person.
25. **Test restores.** A backup that has never been imported is an assumption, not a backup. A sealed one is only tested once it has been opened with the phrase from a device that did not write it.
26. **Keep an offline copy** of the installer and checksums for the version that created the current schema — and keep the phrase or the login that opens an encrypted ledger with it, because an installer alone cannot read a keyed file.
27. **If you run the `edge` profile, treat the proxy as part of the ledger's custody.** Bind stays on `127.0.0.1` until you type an address; tenant containers publish no ports — checked with two tenants running on 2026-11-04, where no tenant had a host binding and a tenant's own container address did not answer even from the Docker host; a provider that does not answer `2xx` means no page, not an open one, and closing **one** tenant's door was measured to leave the other's serving normally. Two of those three are the repository's own file and one is whoever runs the proxy — so re-check them after any proxy edit, and remember that closing the shape needs the profile named again (`COMPOSE_PROFILES=edge docker compose down`), because a plain `down` leaves the proxy listening. If you extend the example to several tenants, be careful with `internal: true` networks: Docker will then refuse to publish the proxy's own port and say nothing about it, which looks like a broken site rather than a misconfiguration.

---

## Incident response

### Suspected malicious import

1. Quit WageRoute.
2. Preserve a copy of the current database and the imported file in a dated quarantine folder.
3. Do not re-import the file.
4. Restore the last known-good database copy, or import a known-good JSON backup into a clean profile.
5. Review accounts, recent transactions and settings for unexpected rows.
6. If the file came from another person, warn them.

### Suspected local compromise

1. Assume the ledger and every backup on the machine are exposed. **With encryption on and no session live**, the file itself is the cipher's and the phrase is not on disk — but treat the keychain as compromised too, because the attacker holds the login, and a ledger that was open during the compromise was readable by definition.
2. Disconnect the machine from the network if malware is suspected.
3. Preserve evidence before cleanup; do not overwrite the database, the WAL or `ledger.key.json`.
4. Change credentials for any financial institution whose data appears in the ledger, using a different device.
5. Rebuild the OS or restore from a trusted image; reinstall WageRoute from a verified installer and checksum.
6. Restore data from a backup created before the compromise, if one is trustworthy. Rotate the ledger's passphrase afterwards — with *Both* custody the device wrap can be re-issued without rewriting the file, but a phrase an attacker may have watched typed is not a secret any more.

### Suspected tampered installer

1. Do not run it.
2. Compare its SHA-256 with the published checksum and the build you produced.
3. Delete or quarantine the file.
4. Rebuild from source and re-verify; if signing keys were exposed, revoke the certificate and publish an advisory.

### Locked out of an encrypted ledger

1. Try the other way in first: the device wrap needs only this OS login, and the phrase needs only to be typed correctly.
2. Check that `ledger.key.json` is beside the ledger and belongs to it. A folder restored from a copy that carried the database but not the marker has a ledger nothing can open, and the app says so rather than rewriting it.
3. Look for a JSON backup, sealed or plain, and for the phrase that opens it. That is the way back; the app cannot be talked past the cipher.
4. Do not run an older build against a keyed file expecting it to read it — it refuses as `SQLITE_NOTADB`, and repeated opens do not help.
5. There is no recovery we operate: no escrow, no reset, no support tool. Do not "clean" `backups/` while looking for a way in; those copies are the only other copies that exist.

### Data corruption

1. Quit the app.
2. Copy `.db`, `-wal`, `-shm` and `ledger.key.json` aside.
3. Run `sqlite3 copy.db "PRAGMA integrity_check;"` on the copy — **only for a plaintext ledger**. A keyed file is not a SQLite database to `sqlite3`, and that refusal is the encryption working, not a new fault; check it through WageRoute with the phrase instead.
4. If the copy opens, export a JSON backup from a build pointed at it, then import into a clean profile.
5. If it does not open, restore the latest backup and accept the loss of changes since then.
6. Do not repeatedly open a corrupt database with the live app; each open may create more WAL state.

### What WageRoute cannot tell you

There is no audit log, no login history and no tamper-evident hash chain. After an incident you can see current rows and tombstones, but not who changed them or when beyond `created_at`/`updated_at`. Encryption adds one narrow signal: a launch that could not open the ledger writes a line to `logs/main.log` — `ledger-locked`, `ledger-no-custody`, `key-file` — so a refused boot is evidence, but it is a refusal of the *file*, not a record of guesses, and the passphrase typed at the prompt is never written. Document that limitation rather than implying forensic coverage.

---

## Security review checklist

Use this for any change that touches the bridge, the database, imports or the build.

- [ ] No new outbound network request, telemetry or remote resource.
- [ ] No new IPC channel without input validation and a user-scoped query.
- [ ] No renderer-supplied filesystem path.
- [ ] No `dangerouslySetInnerHTML`, `innerHTML`, `eval` or dynamic code loading.
- [ ] `sandbox`, `contextIsolation` and `nodeIntegration` settings unchanged.
- [ ] CSP not relaxed for production; any relaxation has a written reason.
- [ ] SQL uses bound parameters and allowlisted identifiers.
- [ ] Import changes keep the byte cap, row caps, table allowlist and transaction.
- [ ] Imported strings and dates are validated or their limits documented.
- [ ] New dependencies are reviewed; lockfile updated; no postinstall script from an unknown package.
- [ ] No ledger data, backup, database or secret in logs, fixtures or the repository.
- [ ] Error messages do not echo file contents.
- [ ] Tests cover malformed and hostile input for the changed path.
- [ ] No passphrase, data key or wrap content reaches a log, an IPC result, an error message or a fixture — and a typed phrase never comes back out.
- [ ] Any encryption change is reversible in the same build, and both directions were exercised on a scratch ledger in `/private/tmp`, never on a live one.
- [ ] New crypto that the phone must read uses WebCrypto, and honours only the parameters a file declares when they sit inside the guard rails.
- [ ] A page with no cipher still refuses rather than offering a delete it cannot undo.
- [ ] Documentation updated — this file, [IMPORT-EXPORT.md](IMPORT-EXPORT.md), [POCKET.md](POCKET.md) or [RELEASING.md](RELEASING.md) as appropriate.

---

## Non-goals

WageRoute does not attempt to provide:

- multi-user authentication or authorization;
- server, API or cloud security;
- bank credential handling (it never asks for them);
- payment initiation or money movement;
- protection from malware running as the same OS user;
- anti-tamper, DRM or license enforcement;
- secure erase of deleted data;
- regulatory certification (PCI DSS, SOC 2, GDPR “compliance” in a formal sense);
- hardware-backed key storage — the device wrap is the OS keychain reached through `safeStorage`, not a secure enclave or a token, and no gate beyond the OS's own is added;
- key custody we operate: no escrow, no recovery service, no server that has ever held a ledger copy or a passphrase;
- a vulnerability disclosure program or bug bounty.

If any of these become requirements, they change the architecture. Record the decision as an ADR before building it.

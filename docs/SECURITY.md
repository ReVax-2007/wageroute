# Security model

WageRoute is a **single-user, local-only desktop ledger**. It does not authenticate a user, does not talk to a server and does not hold bank credentials. Its security therefore rests on three things: the operating-system account that runs it, full-disk encryption, and the fact that imported files are parsed as data rather than executed.

This document describes what is actually implemented, what the trust boundaries are, what an attacker with local access can do, and which weaknesses are known and accepted. It is deliberately specific; “secure” without a threat model is not useful.

> **Scope:** the application in this repository, the unreleased `1.2.x` line and the published `1.1.x` line. There is no production server, hosted service or multi-tenant deployment to assess.

---

## Contents

- [Supported versions](#supported-versions)
- [Reporting a vulnerability](#reporting-a-vulnerability)
- [Assets](#assets)
- [Trust boundaries](#trust-boundaries)
- [Implemented controls](#implemented-controls)
- [Data at rest](#data-at-rest)
- [Network exposure](#network-exposure)
- [Supply chain](#supply-chain)
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
| `1.2.x` (unreleased) | Yes | Current line; fixes land here. Carries schema 8, writes backup format 8 and accepts backups from schema 2–8. |
| `1.1.x` | Yes until 1.2.0 ships | Latest published line. 1.1.0 carries schema 6; it cannot open a schema-8 database and is not patched once 1.2.0 ships. |
| `1.0.x` | No | Superseded. 1.0.2 carries schema 3 and cannot open a 1.1.0 database; upgrade instead of patching. |
| Older app versions | No | No security backports; upgrade or restore a backup |
| Backups with schema `1` | No | Rejected by the importer |
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
2. **Backups and exports** — full JSON backups contain every table, including soft-deleted rows. CSV exports contain transaction history. Both are plaintext.
3. **Settings** — split percentages, round-up destination, theme. Low sensitivity alone; combined with the ledger they describe behaviour.
4. **Database path and machine identity** — the absolute path is shown in the UI and can reveal the OS username.
5. **Application integrity** — users must be able to trust that the installer they run is the build that was tested.
6. **The host account** — any process running as the same OS user can read or modify all of the above regardless of what the app does.

There are no passwords, API keys, bank tokens or session cookies stored by WageRoute. If you find a credential in the repository or a build, that is a release-blocking defect.

---

## Trust boundaries

```text
┌──────────────────────────────────────────────────────────────────┐
│ Operating-system user account                                    │
│                                                                  │
│  ┌──────────────────────────┐        ┌────────────────────────┐  │
│  │ Renderer (Chromium)      │        │ Main process (Node)    │  │
│  │ React, Zustand           │        │ fs, dialogs, SQLite    │  │
│  │ sandbox: true            │        │ full user privileges   │  │
│  │ no Node, no direct FS    │        │                        │  │
│  └────────────┬─────────────┘        └───────────┬────────────┘  │
│               │ window.api (contextBridge)       │               │
│               └──────────── IPC ─────────────────┘               │
│                                                  │               │
│                                       ┌──────────▼────────────┐  │
│                                       │ wageroute.db (+WAL)   │  │
│                                       └───────────────────────┘  │
│                                                                  │
│  Untrusted files ──► native open dialog ──► main parser ──► SQL  │
└──────────────────────────────────────────────────────────────────┘
```

### Renderer

The renderer is treated as **less trusted than main** but still capable of reading and changing the entire ledger through the bridge. It has no Node.js, no `require`, no filesystem and no network permission beyond what CSP allows. A cross-site-scripting bug in the renderer is therefore not arbitrary code execution on the host, but it is full access to the ledger and every IPC channel.

### Preload

The preload script is the only bridge. It exposes one object, `window.api`, with named methods. It does not expose `ipcRenderer`, `require`, `process` or arbitrary channel names. See [src/preload/index.ts](../src/preload/index.ts).

### Main

The main process is fully privileged: it can read and write files, open native dialogs and execute SQL. It assumes the renderer's arguments are untrusted and validates IDs and repository inputs, but it does not assume the renderer itself is hostile. Defense in depth is limited; the bridge is the security boundary.

### Files

Imported files are **untrusted input**. The renderer cannot choose the path; the user picks it in a native dialog owned by main. Exports likewise write only to a path the user selects. This means a compromised renderer cannot read an arbitrary file by passing a path over IPC, but it can ask the user to pick a file and then read the parsed contents through the snapshot.

### Operating system

The app does not defend against malware running as the same user, an administrator, or an attacker with physical access and an unlocked session. Full-disk encryption and OS account hygiene are the controls for those cases.

---

## Implemented controls

| Control | Where | What it prevents |
| --- | --- | --- |
| `sandbox: true` | [src/main/index.ts](../src/main/index.ts) | Renderer process sandbox; no direct OS access |
| `contextIsolation: true` | same | Page JavaScript cannot reach Electron internals |
| `nodeIntegration: false` | same | No `require`, `process` or Node APIs in the renderer |
| Narrow preload bridge | [src/preload/index.ts](../src/preload/index.ts) | Only named finance operations, no generic IPC |
| Navigation denied | `will-navigate` handler | The window cannot leave the app's own `file://` page |
| Exact navigation allowlist | `will-navigate` compares the full `pathToFileURL(...).href` | A crafted same-directory or `file://` path cannot pass as the app page |
| New windows denied | `setWindowOpenHandler` | No child windows; `http(s)` URLs are handed to the external browser |
| All permission requests denied | `setPermissionRequestHandler` | Camera, microphone, notifications, geolocation, clipboard read, etc. |
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
| Pre-upgrade copies | `backupBeforeUpgrade()` | A forward-only migration cannot destroy the only copy of an older schema |
| Pre-erase copies | `backupBeforeErase()` in [src/main/db/maintenance.ts](../src/main/db/maintenance.ts) | An accidental erase is disclosed and recoverable from the newest three `pre-erase-*.db` copies |
| Secure delete | `PRAGMA secure_delete = ON` | Deleted rows do not linger in free pages |
| Erase compacts the file | `VACUUM` + `wal_checkpoint(TRUNCATE)` in `compact()` | "Erase all data" leaves no recoverable rows in the database or the WAL |
| Crash log | `logCrash()` in [src/main/log.ts](../src/main/log.ts) | A boot or renderer failure is recorded instead of vanishing |
| User-scoped queries | `src/main/db/repo/` | Every read and write includes `user_id`; one local user cannot address another's rows |
| Prepared statements | repositories and backup merge | No user-supplied string is interpolated into SQL |
| Column allowlists | `TABLE_COLUMNS` in `src/main/db/backup.ts` | Imported object keys never become SQL identifiers |
| Import size cap | `MAX_IMPORT_BYTES = 64 MiB` | Trivial memory/disk exhaustion via a huge file |
| Per-table row cap | 200,000 rows in `parseBackupJson` | Absurd table sizes before insertion |
| Format/version checks | `parseBackupJson` | Wrong file type, newer schema, unsupported old schema |
| Per-row guarded import | `mergeBackup`, `mergeEntries` | One rejected row costing the whole file; the transaction still commits the rest |
| Foreign keys on | `PRAGMA foreign_keys = ON` | Dangling references from imported rows |
| STRICT tables + CHECK constraints | migrations | Wrong types and out-of-range enums/amounts at the database boundary |
| Additive import / existing-wins settings | `mergeBackup` | A backup silently overwriting existing settings or rows |
| No telemetry or analytics | entire source | Ledger data leaving the machine through app code |
| Lockfile + `npm ci` in CI | `package-lock.json`, workflow | Unreviewed dependency resolution drift |

### What “sandbox” means here

`sandbox: true` sandboxes the **Chromium renderer**, not the whole application. The main process still runs with the user's full privileges by design: it must open the SQLite file and native dialogs. There is no macOS App Sandbox entitlement, no Windows AppContainer and no container around the app.

### Validation split

Repository functions validate renderer input: text length, cent ranges, enum values, ISO dates, account existence. Backup import is a **separate path**: it type-checks values, allowlists columns and relies on SQLite constraints, but it does not apply the same length and date-format checks. See [Import security](#import-security).

---

## Data at rest

| Item | Protection |
| --- | --- |
| `wageroute.db` | **None beyond the OS.** Plaintext SQLite, tightened to mode `0600` on open where the filesystem allows it. |
| `wageroute.db-wal` / `-shm` | Same, inherited from the database file's directory and umask. Recent commits may exist only in the WAL. |
| Pre-upgrade and pre-erase copies | `backups/pre-upgrade-*.db` and `backups/pre-erase-*.db` in the app data folder; plaintext, newest three of each kept. The pre-erase copies deliberately outlive the erase. |
| JSON backups | Plaintext JSON at the user-selected path; default name is in Documents. |
| CSV exports | Plaintext at the user-selected path, written `0600` on macOS and Linux; on Windows it inherits the profile ACL. |
| Logs | `logs/main.log` in the app data folder, mode `0600`, rotated at 512 KB to `main.log.1`. Contains error messages and stack traces, not ledger rows. |
| Preferences | SQLite settings table; no secrets. |

WageRoute does **not**:

- encrypt the database;
- require a password or app lock;
- encrypt backups;
- guarantee secure deletion on a filesystem that ignores `secure_delete` (copy-on-write or SSD wear-levelling can leave blocks behind).

The database file is `chmod 0600` best effort on every open, so other local accounts cannot read it on a normal single-user install; the app does not verify this and a filesystem may refuse the change. The `-wal` and `-shm` sidecars inherit the directory's ACLs and umask. Windows has no POSIX mode bits: there the database, the exports and the log are protected by the ACL of the user profile they live in, which is what the app data folder and the default export path sit inside.

**Deleted data is retained.** A normal delete sets `deleted_at`; rows remain in the table and are included in `SELECT *` exports. “Delete” means “hide from the UI”, not “erase” — see [ADR 0015](decisions/0015-archive-is-not-delete.md). A backup taken after a deletion still contains the deleted row, memo and amount. **Erase all data** is different: it first writes a consistent `pre-erase-*.db` copy under `backups/`, then drops every row and compacts the file, so the live database holds no recoverable rows in free pages or the WAL. The confirmation dialog discloses that copy, and the newest three are kept. An erase is therefore recoverable from disk until those copies are rotated out; if that is unacceptable, delete the `backups` folder afterwards.

The plaintext-at-rest decision is recorded in [ADR 0019](decisions/0019-the-ledger-is-plaintext-at-rest.md), and the absence of an in-app lock in [ADR 0020](decisions/0020-there-is-no-app-lock.md).

### Practical implications

- Use **FileVault** (macOS) or **BitLocker** (Windows). Without it, anyone with the disk can read the ledger.
- Do not store backups in a cloud-synced folder unless you accept that the provider can read them. The default save location is Documents, which is often synced by iCloud Drive or OneDrive.
- Encrypt backups before moving them off the machine (for example with an encrypted archive or `age`).
- Quit the app before copying the database. Copy `.db`, `-wal` and `-shm` together.
- Do not sync the **live** `WageRoute` folder. Syncing a WAL-mode SQLite database across devices can corrupt it or resurrect old data.

---

## Application shell hardening

The packaged binary is not a general-purpose Node runtime, and it does not expose developer tooling:

- **Electron fuses** (`electron-builder.yml`, applied before the ad-hoc signature): `runAsNode` off, `NODE_OPTIONS` off, `--inspect` off, cookie encryption on, embedded ASAR integrity validation on, and `onlyLoadAppFromAsar` on. A renamed `WageRoute` binary cannot be used to run arbitrary Node code, and an unpacked or modified `app.asar` fails the integrity check instead of loading.
- **No in-app developer tools.** The packaged window is created with `devTools: false`.
- **No default menu.** Electron's stock menu carries Reload, Force Reload and Toggle Developer Tools. The packaged build installs a minimal macOS app/edit/window menu (so Copy, Paste and Select All keep their shortcuts) and sets no application menu at all on other platforms.
- **The renderer runs sandboxed** with `contextIsolation: true` and `nodeIntegration: false`; the only bridge is the typed `window.api` object.
- **A newer database is refused, not guessed at.** `migrate()` raises `SchemaTooNewError` when `user_version` exceeds the schema this build applies, the app shows a dialog naming the problem and quits, and the file is left untouched. An older build cannot write to a schema it does not understand.
- **A damaged database is refused too.** Before migrating, `assertHealthy()` runs `PRAGMA quick_check`. A failure raises `DatabaseCorruptError`: the app names it, quits, and does not open a window or write to the file.
- **Upgrades keep a copy.** A schema migration rewrites the file and cannot be undone, so `backupBeforeUpgrade()` writes a consistent `VACUUM INTO` copy under `backups/` (newest three kept) before it runs.
- **The packaged page cannot talk to a local server.** The CSP baked into the built `index.html` is `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`. The development policy (inline script for React Refresh, `ws://localhost` for HMR) never ships.
- **IPC is bound to the app's own page.** Every handler runs `isTrustedFrame()` first and refuses a sender whose frame URL is not the built `index.html` (or the dev server while developing). A compromised or injected frame cannot exercise the ledger API on the app's behalf.
- **A boot failure is visible.** The main process logs to `logs/main.log`, shows an error dialog naming the problem and the log file, and quits — it cannot end up running with no window.
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

The main process can open an external browser for `http(s)` URLs passed to `window.open` (`setWindowOpenHandler` in [src/main/index.ts](../src/main/index.ts)). The one UI link is the static **Buy me a coffee** anchor in Settings, which targets `_blank` and therefore leaves the app through this handler; no other page opens an external URL. If a renderer compromise occurs, that handler is a potential exfiltration path through a URL; it should be restricted to an allowlist or removed if it stays unused.

---

## Supply chain

The build is part of the product. WageRoute ships Chromium, a native SQLite module and a small JavaScript dependency tree, and it is assembled by npm and GitHub Actions.

Current controls:

- `package-lock.json` pins the resolved dependency tree; CI and the release instructions use `npm ci`, not `npm install`.
- The runtime dependency set is small: React, React DOM, Zustand, react-data-grid, lucide-react and better-sqlite3. The rest is build tooling.
- `better-sqlite3` is rebuilt against the installed Electron ABI by `postinstall` and unpacked from the asar archive, so the binary that loads is the one built for that app.
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
- an Electron major upgrade changes the native ABI and needs a full packaged-app test, not just a typecheck.

A compromised dependency or action runs with the build's privileges. Because the app makes no outbound requests, a malicious package would have to add that capability itself; review diffs and lockfile changes rather than assuming the network policy protects the build. Recommendations are in [Hardening recommendations](#hardening-recommendations).

---

## Import security

JSON backups and CSV entry files are the only external data the app accepts.

### What a malicious file cannot do

- **It cannot execute code.** JSON is parsed by `JSON.parse`; CSV is parsed by a hand-written state machine. No `eval`, no dynamic import, no shell.
- **It cannot inject SQL.** Every value is bound as a parameter. Column names come from a fixed allowlist, and table names come from a fixed order list.
- **It cannot choose its own `user_id`.** Imported rows are rewritten to the local user ID.
- **It cannot read another file.** The renderer cannot pass a path; the native dialog chooses one path, and only that file is read.
- **It cannot escape the chosen export path.** Export writes to the path returned by the save dialog.
- **It cannot abort a healthy import.** Everything inserts inside one transaction, but each row is guarded on its own: a row that still violates a `STRICT` type, `CHECK` or foreign-key rule after the wizard is reported as an issue and skipped, and the remaining rows commit. A file built to break one row cannot damage the rest of the database. (Before the import wizard existed, a constraint failure rolled the whole import back; that is no longer the design.)
- **It cannot overwrite existing settings.** Settings use `INSERT OR IGNORE`; the local value wins.
- **It cannot overwrite an existing row by ID.** Existing IDs are skipped, not updated.

### What a malicious file can do

- **Create plausible-looking but false financial records.** Imports are additive and there is no signature or provenance. A file can add accounts, transactions, bills and goals that look real. Treat an imported ledger as untrusted until reviewed.
- **Exhaust resources within the caps.** 64 MiB of JSON and up to 200,000 rows per table can still take time and disk. The UI grid shows at most 500 transactions and 24 paychecks, so the damage is mostly to derived totals and startup time.
- **Insert misleading text.** Memos, categories, account names and institution names are stored and displayed. React escapes them, so they cannot become HTML, but they can contain control characters, very long strings or deceptive labels.
- **Insert malformed dates and absurd text lengths.** The backup path does not apply the repository's date and length validators. SQLite `STRICT` and `CHECK` constraints catch wrong types and invalid enums/amounts; they do not validate date syntax or limit string size. A resulting “Invalid Date” can distort projections.
- **Add unknown settings keys.** They are stored and ignored by the UI. Existing keys are not changed.
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

A backup is a data file. It is not a configuration bundle, a plugin or a script. Do not import a file from someone you would not trust with your ledger, and do not treat instructions embedded in memos or account names as anything other than text.

---

## Threat model

Likelihood assumes a normal personal installation, not a targeted investigation.

| # | Threat | Scenario | Mitigation | Residual risk |
| --- | --- | --- | --- | --- |
| 1 | Local data disclosure | Another process or user reads `wageroute.db` | OS account separation; FileVault/BitLocker; no network | **High** if malware runs as the same user or the disk is unencrypted |
| 2 | Lost or stolen device | Laptop stolen while unlocked or disk removed | OS full-disk encryption | **High** without FDE; no app-level encryption |
| 3 | Malicious import | A crafted JSON/CSV adds false rows or oversized text | Parser allowlists, size/row caps, SQLite constraints, transaction rollback | **Medium** — fabricated data, misleading UI, slow projections |
| 4 | Renderer compromise | XSS or a malicious dependency runs in the renderer | Sandbox, context isolation, no Node, CSP, no HTML sinks, narrow bridge | **High for the ledger** — full read/write via `window.api`; possible external-URL exfiltration |
| 5 | Supply chain | A compromised npm package or GitHub Action alters the build | Lockfile, `npm ci`, small dependency set, review | **Medium** — no audit, SBOM, provenance or SHA-pinned actions |
| 6 | Tampered installer | A modified DMG/EXE is distributed | Published `SHA256SUMS` from the build run; public source | **Medium** — no code signing, so the OS cannot vouch for the binary |
| 7 | Shared computer | A colleague or family member uses the same OS session | None inside the app ([ADR 0020](decisions/0020-there-is-no-app-lock.md)) | **High** — no app lock, no separate profiles |
| 8 | Accidental deletion | A transaction or account is deleted | Soft delete retains the row; backups | **Low** for recovery, but no undo UI and no purge |
| 9 | Disk/database corruption | Power loss, disk failure, killed process | WAL, `synchronous=NORMAL`, transactions, FK | **Medium** — no automatic backup, no scheduled `integrity_check` |
| 10 | SQL injection | A crafted ID or imported value reaches SQL | Prepared statements, ID checks, column allowlists | **Low** |
| 11 | Arbitrary file read/write | Renderer asks main to read a path | Native dialog; no path parameter over IPC | **Low** — social engineering of the user remains |
| 12 | Denial of service | A huge import or many rows | 64 MiB cap, 200k rows/table, UI limits | **Medium** — startup and derived calculations can still slow |
| 13 | CSV formula execution | Exported memo begins with `=` and is opened in Excel | `defuseFormula()` prefixes `= + - @ tab CR` on text columns | **Low** — amounts stay numeric; a deliberately apostrophe-prefixed cell is still text |
| 14 | Backup exposure | Plaintext backup in iCloud/OneDrive/Documents | User choice of path; no encryption | **Medium** — provider and sync history can read it |
| 15 | Deleted-data retention | User expects deletion to erase data | Soft deletes for a single row; **Erase all data** drops rows and compacts, after a disclosed `pre-erase-*.db` copy | **Low–Medium** — a single delete is a tombstone; an erase is recoverable from that copy until it is rotated out |

### Explicitly out of scope

- A remote attacker with no local access and no malicious file. There is no listening service and no inbound network path.
- Bank fraud, account takeover or payment initiation. WageRoute never connects to a bank and never moves money; “routing” is an envelope plan stored locally.
- Multi-user authorization. There is one local user row and no login.
- Malicious administrators, kernel malware or physical memory attacks.

---

## Known weaknesses

Listed with severity for this app's context. None are fixed in `1.1.x` unless stated.

| Weakness | Severity | Impact | Notes |
| --- | --- | --- | --- |
| Unsigned macOS and Windows builds | **High** for distribution | Tampering is hard to detect; Gatekeeper/SmartScreen friction | Published `SHA256SUMS` is the only integrity check; see [RELEASING.md](RELEASING.md#code-signing-and-notarization) |
| No encryption at rest | **High** on a stolen disk | Full ledger readable | Rely on FileVault/BitLocker ([ADR 0019](decisions/0019-the-ledger-is-plaintext-at-rest.md)) |
| Soft-deleted rows retained | **Medium** (privacy) | A normal “delete” keeps the row in the database and in backups | **Erase all data** drops every row and compacts the file; per-row deletion is still a tombstone |
| Pre-erase copies outlive the erase | **Low–Medium** (privacy) | The ledger can be recovered from `backups/pre-erase-*.db` | Disclosed in the confirmation dialog; delete the `backups` folder to remove it |
| Backup import bypasses length/date validators | **Medium** (integrity) | Oversized strings, malformed dates, odd revision values | SQLite constraints still apply |
| No dependency audit, SBOM or provenance | **Medium** | Supply-chain issues are found late | `npm ci`, SHA-pinned actions and review only |
| No app lock or idle timeout | **Medium** on shared devices | Anyone at an unlocked session can read the ledger | No auth by design ([ADR 0020](decisions/0020-there-is-no-app-lock.md)) |
| External URL handler is unrestricted | **Low** today | Potential exfiltration if renderer is compromised | Only the Settings support link uses it; remove or allowlist |
| Default backup path is Documents | **Low–Medium** | May be cloud-synced | User can choose another path |
| No audit log of edits/deletes | **Low–Medium** | Cannot reconstruct who changed what | Single-user app; backups are the fallback |
| Error messages may include local paths | **Low** | Reveals username/path to the local user | Not remote |

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

5. **Turn on FileVault/BitLocker** on every machine that runs WageRoute. This is the single highest-value control.
6. **Encrypt backups** before storing them off the machine; avoid cloud-synced live database folders.
7. **Tighten database permissions** — create the file with mode `0600` on POSIX systems, and confirm the directory is user-only. *(Done: `chmodSync(file, 0o600)` best effort on open.)*
8. **Add an optional purge/compact action** that physically removes tombstoned rows, with a clear warning that it breaks sync history. *(Partly done: erasing all data drops every row and runs `VACUUM`; there is no per-row purge.)*
9. **Consider SQLCipher or an encrypted container** if the threat model includes disk theft without FDE. This is a significant change: it affects migrations, backups, debugging and performance.

### Application hardening

10. **Neutralize CSV formulas on export.** Prefix `=`, `+`, `-`, `@`, tab and carriage return with a single quote, or offer a raw export. Add tests for memos and account names. *(Done: `defuseFormula()` applies to the text columns; amounts are untouched.)*
11. **Tighten the CSP** for production: remove `'unsafe-inline'` from `script-src` and drop localhost from `connect-src`. Verify the packaged build first; Vite may inline a bootstrap script. *(Done: `strictCsp()` rewrites the meta tag at build time.)*
12. **Add `base-uri 'none'`, `object-src 'none'`, `frame-ancestors 'none'` and `form-action 'none'`** to the CSP. *(Done, production policy only.)*
13. **Validate the IPC sender** — reject calls whose `senderFrame` is not the main window's top frame. *(Done: `isTrustedFrame()` guards every handler.)*
14. **Apply repository validators to imported rows** (text length, date syntax, revision bounds) before insert, or share one validation layer between both paths.
15. **Cap individual field lengths on import** to match the UI limits.
16. **Remove or allowlist the external URL handler** if no feature needs it.
17. **Add `PRAGMA integrity_check`** on startup or on demand, and surface the result rather than silently continuing. *(Done: `PRAGMA quick_check` before migrating; a failure refuses to open the file.)*
18. **Add automated dependency updates and `npm audit` in CI**, with a documented triage policy.
19. **Add a lightweight audit trail** (append-only local log of create/update/delete with timestamp) if the ledger becomes shared or business-critical.

### Operational

20. **Do not run WageRoute on a shared OS account.** Use a separate user account per person.
21. **Test restores.** A backup that has never been imported is an assumption, not a backup.
22. **Keep an offline copy** of the installer and checksums for the version that created the current schema.

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

1. Assume the ledger and every backup on the machine are exposed.
2. Disconnect the machine from the network if malware is suspected.
3. Preserve evidence before cleanup; do not overwrite the database or WAL.
4. Change credentials for any financial institution whose data appears in the ledger, using a different device.
5. Rebuild the OS or restore from a trusted image; reinstall WageRoute from a verified installer and checksum.
6. Restore data from a backup created before the compromise, if one is trustworthy.

### Suspected tampered installer

1. Do not run it.
2. Compare its SHA-256 with the published checksum and the build you produced.
3. Delete or quarantine the file.
4. Rebuild from source and re-verify; if signing keys were exposed, revoke the certificate and publish an advisory.

### Data corruption

1. Quit the app.
2. Copy `.db`, `-wal` and `-shm` aside.
3. Run `sqlite3 copy.db "PRAGMA integrity_check;"` on the copy.
4. If the copy opens, export a JSON backup from a build pointed at it, then import into a clean profile.
5. If it does not open, restore the latest backup and accept the loss of changes since then.
6. Do not repeatedly open a corrupt database with the live app; each open may create more WAL state.

### What WageRoute cannot tell you

There is no audit log, no login history and no tamper-evident hash chain. After an incident you can see current rows and tombstones, but not who changed them or when beyond `created_at`/`updated_at`. Document that limitation rather than implying forensic coverage.

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
- [ ] Documentation updated — this file, [IMPORT-EXPORT.md](IMPORT-EXPORT.md) or [RELEASING.md](RELEASING.md) as appropriate.

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
- hardware-backed key storage;
- a vulnerability disclosure program or bug bounty.

If any of these become requirements, they change the architecture. Record the decision as an ADR before building it.

# 0029 — Encryption is a choice, on the disk and on the way out

**Status:** Accepted (2026-11-04). Supersedes [ADR 0019](0019-the-ledger-is-plaintext-at-rest.md); amends [ADR 0020](0020-there-is-no-app-lock.md).

**Related:** [ADR 0001](0001-local-first-desktop.md), [ADR 0022](0022-the-ledger-can-live-in-a-folder-you-choose.md), [ADR 0024](0024-two-copies-merge-by-time.md), [ADR 0025](0025-the-phone-writes-through-the-desktops-own-rules.md), [SECURITY.md](../SECURITY.md), [IMPORT-EXPORT.md](../IMPORT-EXPORT.md), [POCKET.md](../POCKET.md)

## Context

[ADR 0019](0019-the-ledger-is-plaintext-at-rest.md) decided that the ledger stays plaintext and that the operating system is the security boundary. That was the right call for the product at the time: no key management, no recovery burden, no shape where a forgotten passphrase loses someone their entire history. It also wrote down the condition for changing it — "no password, no key derivation and no encrypted container will be added without a new ADR that supersedes this one". This is that ADR.

What changed is the requirement, not the reasoning. A local-only app whose users also carry a phone copy, and who may sync their Documents folder to a cloud they do not control, leaves two exposures that OS permissions genuinely do not cover: the backup file that leaves the machine, and the ledger file on a machine someone else can log into. The owner asked for encryption that works, **off by default**, switchable in both directions later, with the user always given the option and always able to change it afterwards. Everything in this decision follows from those three constraints — opt-in, reversible, choice of method — rather than from a general wish to "add encryption".

Two facts from the feasibility work shaped the design:

- **A backup has to be readable on the weakest device that must open it.** The desktop's own key file uses scrypt because Node has it and only the desktop reads it. A file that a phone must also open cannot use anything WebCrypto does not implement, so the export format is chosen by the phone, not by the desktop.
- **One SQLite driver has to serve everyone.** An optional encryption package means a code path most users never run and CI cannot exercise. `better-sqlite3-multiple-ciphers` reads an unkeyed database exactly as plain SQLite does, so the same binary can serve a plaintext ledger and an encrypted one.
- **The phone's cipher is a privilege of the origin, not of the app.** A browser exposes `crypto.subtle` only in a secure context, so Pocket served on `http://192.168.x.x` — a shape its own setup doc already warns installs nothing from — keeps `crypto.getRandomValues` and has no cipher at all. Any encryption layer on this device has to answer that state with advice instead of with a crash, and "come back over HTTPS" is the only advice that is true.

## Decision

**Encryption is opt-in at both layers, reversible at both layers, and never claims protection it does not provide.**

1. **Nothing changes until the user asks.** A ledger stays plaintext with no key file until someone turns encryption on in Settings, under the card titled *Encryption at rest*. There is no default-on, no nagging, and no migration that encrypts a file behind the user's back.
2. **At rest: one driver, real cipher.** `src/main/db/encryption.ts:145` performs the transition the measured way (`secure_delete = ON` → `locking_mode = EXCLUSIVE` → `journal_mode = delete`, because a rekeyed page parked in the WAL is not a rekeyed file → `cipher = chacha20` → `rekey` → close → **verify on a fresh connection** → restore the folder's journal mode), with a `VACUUM INTO` pre-copy first and a rollback that restores it. `LEDGER_CIPHER` is pinned in `src/main/db/ledger-key.ts:23` so a file records the cipher it was actually written with.
3. **Key custody is a choice, and the choice is the user's.** `ledger.key.json` sits beside the ledger and holds one 32-byte data key wrapped up to twice: by the OS keychain (`safeStorage`, `src/main/db/device-custody.ts`), by a passphrase (scrypt, `src/main/db/ledger-key.ts:208`), or by both. The sidecar is not secret and is not sufficient — it opens nothing without one of the two ways in. Custody can be changed at any time, in any direction, and adding or removing a method rewraps 32 bytes rather than rewriting a page.
4. **Both directions are reversible, and the app says which one costs a restart.** Encrypting and decrypting rewrite the whole file, so they close the database, transition, and relaunch (`EncryptionChange.restartRequired` is the literal `true`). Custody changes touch no page and restart nothing. The dialog states which is which.
5. **A locked ledger has no app.** `boot()` in `src/main/index.ts` opens the ledger *before* `registerIpcHandlers`, so while the file is keyed there is no ledger window and no ledger IPC channel — only the `?mode=unlock` prompt (`src/main/unlock-prompt.ts`, `src/renderer/src/Unlock.tsx`). Device custody is tried silently first; a passphrase is only asked for when the device cannot answer; closing the prompt is a refusal, not a bypass.
6. **On the way out: a sealed backup is offered, not imposed.** `backup:export` takes `passphrase: string | null`; `null` writes exactly the plaintext file it always wrote. A phrase produces a `wageroute-envelope` (`src/shared/envelope.ts`): PBKDF2-HMAC-SHA-256 at 600 000 rounds, AES-256-GCM, salt/IV/tag/iteration count and `exportedAt` **in the clear** so a person can recognise and sort these files without the phrase, and the ledger itself under the cipher. The same file opens on the desktop (`src/main/envelope.ts`, `node:crypto`) and on the phone (`src/pocket/lib/envelope.ts`, WebCrypto). Import reads either form: the desktop's wizard gets a `sealed` answer and asks before it counts anything (`data:passphrase`), and the phone holds a sealed file in `pendingSeal` until a phrase arrives.
7. **On the phone's own disk: a vault, not another cipher to configure.** `src/pocket/lib/vault.ts` seals the copy that stays in IndexedDB — `wageroute-vault` v1, one marker in the clear (`PBKDF2-SHA256`, `AES-256-GCM`, the iteration count, the salt, a sealed verifier token) over one sealed record. It shares the envelope's constants and its WebCrypto seam (`src/pocket/lib/webcrypto.ts`) but not its shape, because it is written many times from one key: the phrase is stretched **once per unlock**, the derived key is non-extractable and lives only in module scope, and every save re-seals with a fresh initial vector. Closing the page loses the key, which is what makes a reopened phone say "locked". The sealed copy and the plaintext copy are two members of one union under the same IndexedDB key, so sealing costs no store version and unsealing is the same single write in reverse — no bulk migration, and no half-moved state to recover from. It is opt-in from the phone's own Data tab (`src/pocket/screens/Data.tsx`, in the card `VaultCard.tsx`), the gate that asks for the phrase is `UnlockVault.tsx`, and whether the computer's file is keyed is a separate question entirely.
8. **A file cannot tell the app to be weak.** The reader honours the parameters a file states, but only inside guard rails: 100 000 to 2 000 000 iterations, exact field lengths, a parseable date, non-empty ciphertext. A hostile export cannot say "1 round" and hand back a key in microseconds, nor "a billion" and hang a laptop. The vault honours the same rails because it reads the same constants.
9. **Every option carries its own honesty table, and the desktop's is in the type.** `src/shared/encryption.ts` gives each custody method a label, a headline and three sentences named `protects`, `fails` and `lockout`, and the Settings card renders them verbatim — a custody option that cannot explain itself is a build error. The phone's vault and the two export sheets are the same three questions in prose written on the screen that asks them (`VaultCard.tsx`, `ExportSheet.tsx`, `ExportBackupDialog`), because they answer different exposures and no shared string would fit all three. That is a known cost of this decision: **the shape is enforced in one place and imitated in three.** What is not negotiable is the rule itself, which is [ADR 0020](0020-there-is-no-app-lock.md)'s, extended: **a lock, or a cipher, that implies more protection than it gives is a defect, not a feature** — and ADR 0020's decision that there is no *UI-only* lock stands unchanged.
10. **Failure is typed, because the advice differs.** An envelope can fail as `shape` (not our file — choose a different one) or as `passphrase` (fine file, wrong phrase — type it again); a vault adds `closed`, because a phone with no key in hand cannot answer any question about its ledger. The screens branch on those codes, never on prose — and a damaged sealed record says *typing again will not change this*, because a wrong phrase and a wrecked file are indistinguishable from inside AES-GCM. There is a third case the cipher cannot express, and it is not about the file: a page that is not a secure context has no cipher to reach. `src/pocket/lib/webcrypto.ts` answers it as `shape` with one sentence, refuses it **before** `openPart`'s catch so it can never be mistaken for a failed tag, and every screen that would have offered sealing asks it instead — including the gate, whose *Forget this phone's copy* button is disabled there, because a healthy vault on a LAN address is precisely the copy that must not be erased by someone told it is lost.
11. **Out of scope, still.** No hosted recovery, no password reset we operate, no remote attestation, no key escrow, no per-column encryption, no server that ever holds a ledger copy.

## Consequences

### Positive

- A person on a shared machine, or one whose Documents folder syncs to a cloud, can now make the two exposures in ADR 0019's "Negative" list cost them something to exploit — without anyone who never asked for encryption paying anything.
- Reversibility is not a slogan: a scratch ledger went plaintext → encrypted → used → decrypted → used again inside the running app, and the header went from `SQLite format 3` to ciphertext and back.
- The export envelope is genuinely cross-device rather than app-specific: a phone-sealed file is opened by the desktop's Node cipher inside `src/pocket/lib/sealed-store.test.ts`, and the name, the header and the JSON inside all derive from one `exportedAt`.
- The phone's vault gets the same reversibility without a migration: sealing and unsealing are one read and one write of one record, so there is no state in which half of a ledger is ciphertext, and no store version or schema version moved to get there.
- The plain-driver path cannot rot into an untested branch: the driver that encrypts is the only driver, and it reads a plaintext file on every install that has not opted in.

### Negative

- **Passphrase custody can lock someone out permanently, and there is no way for us to help.** With only a phrase and no device wrap, a forgotten passphrase means the ledger is gone. "Both" exists to make that the rare case; the dialog that asks for a phrase must say the same thing the honesty table does.
- **A wrong phrase is now a support shape.** An offline guesser has one job: stretch a candidate and see whether the tag opens. A ledger's key file costs that person a memory-hard scrypt pass (`N = 32 768`) per guess and a sealed backup costs 600 000 PBKDF2-SHA256 rounds, and neither number is a defence against a phrase that is short or reused — the docs have to say that rather than "military-grade".
- **A `.db` file this build has *encrypted* cannot be opened by released 1.2.0**, which ships the plain driver: it reads as `SQLITE_NOTADB`. (A plaintext ledger from this build still opens there normally — that is what "off by default" has to mean.) The same is true of an encrypted `VACUUM INTO` copy in `backups/` — so a lost key now also loses those copies.
- **Two safety copies existed that should not have.** The transition's pre-copy is the whole ledger in plaintext sitting beside the file that just became ciphertext; it is deleted the moment the change verifies (`src/main/db/custody.ts:122`), and the decrypt side's copy goes too (`custody.ts:163`). Encryption is opt-in; a plaintext liability is not automatically acceptable just because it was temporary.
- The app now has an unlock window, a key file, a marker-vs-header reconciliation (`reconcilePending`) and a crash story for a transition that landed but could not confirm. That is real complexity in the launch path, and it is the part that can lose someone's data if it is wrong.
- **The vault has exactly one way in.** No phone gives this app a keychain `safeStorage` can reach, so the desktop's "both" custody has no counterpart here: lose the passphrase and this phone's copy is sealed for good. What rescues the owner is a copy that exists elsewhere — the computer's ledger, or a backup carried out — and the sheet that asks for the phrase says so before it writes anything.
- **Unlocked-and-open is not sealed.** The session key lives in module scope for exactly as long as the page does, so a vault stops someone reading the stored copy of a phone that has been closed; it does not stop someone holding a phone with Pocket open on it. That is the card's "Does not stop" line, in those words rather than softer ones.
- **The phone's seal depends on a certificate the owner has to obtain.** An unencrypted origin gives Pocket no cipher, so a sealed vault or a sealed export on a phone means HTTPS on the address the phone opens — which a private LAN has no public CA for. The app now refuses that state honestly instead of crashing into a storage error, but refusing is not the same as working: a person following the deployment doc's plain-HTTP shape simply does not get this layer, and the docs have to say so rather than describing the vault as something the phone always has.
- **Nothing in this layer has run on the device it is built for.** The vault's screens are driven in jsdom and its WebCrypto half was measured inside a Chromium on a laptop, not on iOS Safari or Android Chrome. 600 000 PBKDF2 rounds cost that laptop about a third of a second; a phone CPU has never been timed, so no document may promise an unlock delay.

### Neutral

- No schema change and no `SCHEMA_VERSION` bump: encryption lives in the file layer and in the sidecar, exactly as ADR 0019's "Neutral" section predicted. The `Snapshot` read model and the JSON backup format are untouched — an envelope is a plain backup put through a cipher, so the rows underneath are the same rows.
- `ledger.key.json` travels with a data-folder move (ADR 0022), and never with an `adopt`, which must not overwrite the key file the adopted folder already owns.
- CSV export stays plaintext by design: it is a review copy for a spreadsheet ([ADR 0017](0017-the-csv-is-a-review-copy.md)), and a cipher a spreadsheet cannot open is not a feature.
- The two devices' switches are independent. A keyed computer with an unsealed phone, or the other way round, are both normal states; nothing synchronises the choice, because the only thing that crosses between them is a backup file, and that file carries its own seal or does not.

## Alternatives considered

### Encryption on by default

Rejected. It forces the lockout risk on every user, changes the file under an existing install without consent, and makes first run a passphrase lesson rather than a budget.

### A separate optional package or build flavour for the encrypted driver

Rejected. Two code paths, one of them unexercised by CI and by most users, is how a security feature rots. The fork's prebuilds cover all eight packaged targets, so bundling it is not the supply-chain risk it first looked like; the notices file names it.

### scrypt or Argon2 for the export envelope

Rejected on platform grounds, not strength: the phone has to open desktop files, and WebCrypto implements PBKDF2 and nothing else memory-hard. The cost is paid in rounds (600 000, OWASP's recommendation for PBKDF2-SHA256) instead of in construction. The desktop's *own* key file keeps scrypt, because the only reader there is Node.

### Encrypt the `.db` file itself, or hand out an `age`/ZIP archive

Rejected. The ledger is the live working copy, not the backup, and its format is our business to keep boring; and a backup a person cannot open with any tool but ours is a backup that fails when the app is unavailable — the objection ADR 0019 raised against encrypting exports, answered by making the envelope readable by both of our devices and by any implementation that follows the format.

### Keep the passphrase in a SQL `PRAGMA key = '...'` string

Rejected. Text keys have to be escaped into SQL, and a phrase containing `'` is a footgun waiting for a user. The data key is a 32-byte value we derive, passed as a `Buffer`; the phrase never reaches a SQL string at all.

### Store the passphrase (hashed) in settings so unlock is "simpler"

Rejected. A verifier that can be checked offline is a cracking target, and the design already needs neither: the GCM tag over the wrapped key *is* the check, and it is only ever tried against our own file.

### A PIN, or a passkey that holds the phone's key

Rejected for this release, and the reason is the size of the search space rather than the shape of the UI. A four-to-six-digit PIN is a passphrase with less work for an offline guesser: 600 000 PBKDF2 rounds over ten thousand possible values finishes in a blink, so a PIN would have bought a faster unlock at the cost of the only property the vault has. A passkey is the shape people actually want, but WebAuthn can only *carry* a secret through `largeBlob`, which this product has never proven — it needs a registrable domain as the `rpId`, and a self-hosted `127.0.0.1` or `wageroute.local` is not one. A passkey that merely gates a plaintext store is the UI lock ADR 0020 already refused. The marker keeps `kdf`, `cipher`, `iterations` and `salt` in the clear precisely so that a later record can add a second way in without rewriting anybody's file.

### A UI lock backed by nothing

Rejected, unchanged from ADR 0020. A gate that a file copy walks past is theatre, and this product has decided not to sell theatre.

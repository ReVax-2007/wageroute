# 0031 — A fingerprint is one more way in, never the only door

**Status:** Accepted (2026-11-05), with the owner's decisions recorded under *Owner's decisions* below. Those decisions change two things the proposal said. **A passkey may never be the only wrap**, with no `acceptLockout` escape. **An opt-in PIN is added**, overruling this record's own "A PIN as the short way in" alternative. The record was first written as Proposed, with the spike below; the sections after *Owner's decisions* describe what was built and what was measured.

**Related:** [ADR 0020](0020-there-is-no-app-lock.md), [ADR 0029](0029-encryption-is-a-choice-on-the-disk-and-on-the-way-out.md), [ADR 0030](0030-self-hosting-puts-identity-at-the-edge.md), [SECURITY.md](../SECURITY.md), spike: [`spikes/0031-passkey-prf/`](../../spikes/0031-passkey-prf/)

## Context

The owner asked for users, passwords or PINs, and fingerprint, always opt-in, always reversible, and hosted only on machines they control. Version 1.3.1 already delivers most of that: opt-in encryption at rest whose key is held by the OS keychain, a passphrase, or both (ADR 0029); sealed backups; a passphrase vault for the phone's own copy; and one container per person behind a TLS edge (ADR 0030). Fingerprint is what is missing. The code has no biometric or WebAuthn call anywhere.

[ADR 0020](0020-there-is-no-app-lock.md) still applies: **a UI-only lock is rejected as a security control.** If a fingerprint only hides the dashboard, copying `wageroute.db` gets past it. A fingerprint feature is therefore acceptable only if the fingerprint releases a key that the data actually needs. ADR 0029 rejected a passkey "for this release" on two grounds. It said WebAuthn could carry a secret only through `largeBlob`. It also said a passkey needs a registrable domain, which a self-hosted `127.0.0.1` or `wageroute.local` is not. This record tests both claims and corrects them where the measurements below disagree.

The data already has the right shape for this. Both of the desktop's existing ways in wrap one random 32-byte data key in `ledger.key.json` (`src/main/db/ledger-key.ts`). Adding or removing a way in rewraps 32 bytes and rewrites no page (`changeKeyCustody` in `src/main/db/custody.ts`). A fingerprint, if it can produce a stable secret, is a third wrap of the same key.

## The mechanism: WebAuthn PRF, not `largeBlob`, not a prompt

The WebAuthn `prf` extension asks the authenticator for a CTAP2 `hmac-secret`. The result is a 32-byte HMAC, computed inside the authenticator, over a salt the page chooses. It is keyed by a secret that never leaves the authenticator, and the authenticator releases it only after user verification. The same credential with the same salt always returns the same 32 bytes. A different credential or a different salt returns unrelated bytes. HKDF turns that output into an AES-GCM key-encryption key, and that key seals the data key. Nothing secret is stored beside the wrap, so a copied wrap opens nothing without the authenticator *and* a verified user.

This differs in kind from the gates ADR 0020 refused:

- `systemPreferences.promptTouchID()` resolves a promise and releases nothing. Electron's own type documentation says *"This API itself will not protect your user data"* (`node_modules/electron/electron.d.ts`). Used alone it is a UI-only lock, and this record rejects it in the same terms ADR 0020 does.
- `safeStorage` (the existing device wrap) is bound to the login and has no biometric access control. Anyone logged in as the owner can ask the keychain for the key (`src/main/db/device-custody.ts`).
- `largeBlob`, which ADR 0029 considered, *stores* a secret on the authenticator. PRF *derives* one, needs no storage on the authenticator, and has wider support. This record uses PRF and does not consider `largeBlob` further.

## Spike: what was measured

`spikes/0031-passkey-prf/run.mjs` serves `prf.html` and drives it over the Chrome DevTools Protocol. The page implements the proposed custody shape in WebCrypto: one random data key, one PBKDF2-600 000 passphrase wrap (the vault's current parameters), and one PRF wrap, `HKDF-SHA256(prf.first, salt, "wageroute data-key wrap")` → AES-256-GCM. Authentication uses a **CDP virtual authenticator** (`ctap2_1`, transport `internal`, resident keys, user verification, `hasPrf: true`). No real fingerprint was touched and nothing was written to the login keychain. Full output: [`spikes/0031-passkey-prf/results.json`](../../spikes/0031-passkey-prf/results.json). Run on 2026-11-05 on an Apple M5 MacBook Pro, macOS 26.5.1, Node 24.22.2.

| Check | Chrome 156.0.8078.80 | Electron 45.1.0 (Chromium 156.0.8078.49) |
|---|---|---|
| `getClientCapabilities()["extension:prf"]` (the real browser, before any virtual authenticator) | `true` | `true` |
| `isUserVerifyingPlatformAuthenticatorAvailable()` (real platform) | `true` (Touch ID enrolled) | **`false`**: no platform authenticator until `app.configureWebAuthn` runs |
| Register on `http://localhost` with `prf.eval` | `prf.enabled: true`, results already returned at create | same |
| Assertion returns 32 PRF bytes, UV flag set | yes, 2–3 ms | yes, 2 ms |
| Same passkey, same salt, later assertion → same bytes | yes | yes |
| PRF wrap opens to the original 32-byte data key | yes | yes |
| Different PRF salt → unrelated bytes (domain separation) | yes | yes |
| A second passkey for the same site opens the first one's wrap | **no** | **no** |
| Passphrase wrap opens the same data key independently | yes; wrong phrase does not | same |
| Passkey removed ("lost") → assertion | no authenticator answers (5 s cut-off) | same |
| …and the passphrase wrap still opens the key | **yes** | **yes** |
| rpId `127.0.0.1` from `http://127.0.0.1` | `SecurityError: This is an invalid domain.` | same |
| rpId `wageroute.lan` claimed from `http://localhost` | `SecurityError` (not a suffix of the origin) | same |
| `https://wageroute.lan`, certificate **trusted** (SPKI pin), rpId `wageroute.lan` | full custody run passes | full custody run passes |
| `https://wageroute.lan`, certificate **untrusted** (as with Caddy `tls internal` before its root is installed) | the page never loads (certificate interstitial), so there is no WebAuthn at all | not run |
| Packaged renderer origin `file://`, rpId empty or `localhost` | n/a | `SecurityError: Public-key credentials are only available to HTTPS origins with valid certificates, HTTP origins that fall under 'localhost'…` |
| `http://localhost:1/unlock` answered from memory by `session.protocol.handle('http')`, **no socket listening** | n/a | full custody run passes |
| PBKDF2-SHA256, 600 000 rounds, in the page | 42–46 ms | 46–49 ms |

What the spike **proves**: the wrap design is sound in both Chromiums the project cares about. PRF output is deterministic per credential and salt. It is useless with the wrong credential. Losing the passkey leaves the passphrase wrap intact. The desktop can give its unlock window a WebAuthn-eligible origin without opening a port. The rpId rules for self-hosted origins match the table.

What the spike **could not measure**, which is why this record is only Proposed:

- **A real fingerprint.** Every assertion came from a virtual authenticator. The real Touch ID platform authenticator in desktop Chrome reports `extension:prf: true`, but that flag describes the browser, not the authenticator. Whether Chrome's iCloud Keychain or Chrome-profile passkeys on this Mac return PRF output was not checked, because that needs a person to touch the sensor. It can be run by hand: serve `prf.html` on `http://localhost`, open it in Chrome, and call `await spike.custody('localhost')` in the console.
- **Electron's own Touch ID authenticator.** It exists only after `app.configureWebAuthn({ touchID: { keychainAccessGroup } })`, and that group must appear in a `keychain-access-groups` code-signing entitlement. WageRoute's builds are ad-hoc signed (`identity: null` in `electron-builder.yml`, `scripts/adhoc-sign.js`), and this machine has no signing identity (`security find-identity` → 0). Whether that authenticator implements PRF is **unknown**. Electron's documentation states that the *other* macOS mode, `platformPasskeys` (ASAuthorizationController), ignores `prf` inputs.
- **Any phone.** iOS Safari, Android Chrome, installed-PWA mode, and a private CA on a handset were not measured. The vault's own WebCrypto has also never been timed on a phone (ADR 0029).
- **Windows Hello and Linux.** No such machine was available.

## Answers

### 1. Pocket (phone): yes. A passkey's PRF output can be a second wrap of the vault key.

**One structural change comes first.** Vault v1 (`src/pocket/lib/vault.ts`) has no data key. The AES key comes straight from PBKDF2 over the phrase, and changing the phrase makes a new vault. A passkey cannot wrap a key that is never stored, so the vault must become **v2**: a random 32-byte data key seals the record, and the marker carries `wraps.passphrase` (PBKDF2 salt, iterations, sealed data key) and `wraps.passkey[]` (credential id, rpId, PRF salt, HKDF salt, sealed data key). The marker's design already anticipated this (ADR 0029: *"so that a later record can add a second way in without rewriting anybody's file"*). v1 stays readable. A v1 vault becomes v2 only when its owner adds a passkey, and the conversion is the same single-record rewrite that sealing already uses. Changing the passphrase becomes a rewrap, the same as on the desktop.

**Support today** (client support only, which is not the same as every authenticator returning PRF):

| Platform | PRF with a platform passkey | Evidence |
|---|---|---|
| Chrome desktop 156, macOS 26.5 | browser yes; authenticator not measured | measured (`getClientCapabilities`), table above |
| Safari 18+ on iOS 18 / iPadOS 18 / macOS 15+, iCloud Keychain | yes | Safari 18.0 release notes, as reported by [Corbado](https://www.corbado.com/blog/passkeys-prf-webauthn); PRF over the cross-device (QR/hybrid) flow returned empty results until a partial fix in 18.2 ([Apple forums](https://developer.apple.com/forums/thread/774112)) |
| Chrome on Android, Google Password Manager | yes | reported ([Corbado](https://www.corbado.com/blog/passkeys-prf-webauthn)); third-party providers vary by provider |
| Windows Hello (Chrome/Edge, Firefox 148+) | yes on Windows 11 builds from the February 2026 update (26200.7840 reported) | community reports ([Bitwarden forum](https://community.bitwarden.com/t/encryption-prf-via-windows-hello-passkey/94236), [Corbado](https://www.corbado.com/blog/passkeys-prf-webauthn)), not Microsoft documentation |
| Firefox elsewhere | security keys with `hmac-secret`; platform passkeys uneven | [passkeyprf.com](https://www.passkeyprf.com/) (older) |

None of the external rows was measured here. The product must therefore **feature-detect rather than version-sniff**. The UI may offer a passkey only after a registration returns `prf.enabled === true` *and* a test assertion opens a freshly made wrap. If either step fails, nothing is written and the vault stays passphrase-only.

**The `rpId` a self-hosted origin needs.** WebAuthn binds a credential to a hostname. That hostname must be the page's own hostname or a registrable suffix of it, and the page must be a secure context with a *valid* certificate:

- **`localhost`**: works (measured). This covers `pocket:dev` and `pocket:preview` on the machine itself, not a phone.
- **A LAN IP such as `192.168.x.x` or `127.0.0.1`**: refused, `SecurityError: This is an invalid domain.` (measured). The plain-HTTP LAN shape already has no cipher (ADR 0029), so a passkey changes nothing there.
- **A `.lan` name behind Caddy `tls internal`**: works once the device trusts Caddy's root (measured in Chromium with the certificate pinned). Until then the page does not load, so WebAuthn never runs. Installing that root on each phone is the chore ADR 0030 already names. **The rpId must be the tenant's full hostname** (e.g. `ann.wageroute.lan`), never a shared parent such as `wageroute.lan`. Otherwise a credential made for Ann's Pocket could be exercised on Bob's, which would erode the one-tenant-per-origin isolation ADR 0030 relies on. Bob could not open Ann's wrap, which lives in Ann's browser storage, but the boundary should not depend on that.
- **A real domain** with a public certificate works without that chore.
- This corrects ADR 0029. A passkey does **not** need a publicly registrable domain. It needs a hostname, not an IP address, plus a certificate the device trusts. `.local` mDNS names were not tested.

**When the passkey is lost** (deleted from the password manager, the account reset, a move from iPhone to Android), the PRF wrap can no longer be opened. The spike shows the passphrase wrap still opens the same data key. For that reason the first release **requires a passphrase wrap to exist before a passkey can be added, and refuses to remove the last passphrase while a passkey is the only other wrap**. The rule is stricter than the desktop's because the phone has no keychain to fall back on. The "only wrap" exception in answer 3 is not offered on the phone in this proposal.

### 2. Desktop: no biometric key without a signing identity. With one, Electron already has the API, and no new npm dependency is needed.

- **`promptTouchID`**: a prompt that releases nothing. Rejected on its own (ADR 0020).
- **`safeStorage`**: login-bound, not biometric. Unchanged.
- **Electron 45's `app.configureWebAuthn({ touchID: { keychainAccessGroup } })`** (macOS only) enables a Secure Enclave platform authenticator for `navigator.credentials` inside Electron. It is **not a new dependency**. It costs three other things:
  1. **An Apple Developer Program team.** The access group must appear in a `keychain-access-groups` entitlement, and that entitlement requires a real signing identity tied to a Team ID. Today's ad-hoc signature cannot carry one. This is a money-and-identity decision for the owner, not an engineering one.
  2. **A WebAuthn origin for the unlock window.** The packaged renderer loads `file://`, which is refused (measured). Answering `http://localhost` from memory with `session.protocol.handle('http')` in the unlock window's own session passes the full custody run without opening any port (measured). That session must serve only the unlock page.
  3. **PRF support in that authenticator.** Not measured, and not documented either way. **This decides whether the desktop half happens at all.** If Electron's Touch ID authenticator does not return PRF, the desktop gets no fingerprint wrap and this record says so instead of falling back to a prompt.
- **A native keychain item with biometric access control** (`SecAccessControlCreateWithFlags(… kSecAccessControlBiometryCurrentSet …)` on the data-protection keychain) needs **the same entitlement and the same Team ID**, so it has no advantage over `configureWebAuthn` and adds native code. The modules available are no better. `keytar` (MIT, last release 7.9.0; `atom/node-keytar` has been archived since December 2022) exposes no access-control flags. `node-mac-auth` (MIT, 1.1.0, 2024) is a Touch ID *prompt*, so it is a UI gate. `@napi-rs/keyring` (MIT, actively maintained, 2.1.2 in October 2026) was not checked for access-control options. A WageRoute-owned N-API module would be new native code to build for eight targets and to sign. **Not recommended.**
- **Windows Hello.** Chromium on Windows hands WebAuthn to `webauthn.dll`, so Electron there already reaches Windows Hello with no configuration call and no entitlement. Windows Hello PRF is reported from the February 2026 Windows 11 update. It needs the same `protocol.handle` origin and is **unmeasured**. If it works, Windows is the cheapest desktop to support.
- **Linux.** There is no OS biometric keystore. `fprintd` authorises PAM logins and releases no secret, so on Linux it would be a UI gate. **No fingerprint wrap on Linux.** A FIDO2 security key with `hmac-secret`, including a fingerprint key, works through the same Electron WebAuthn path in principle. It is unmeasured and would be labelled as a security key, not as "fingerprint".
- **Containers** (ADR 0030) have neither a keychain nor a platform authenticator. A served tenant uses Pocket's passkey wrap, which belongs to the phone's browser, not to the container.

### 3. How it fits custody

**A third wrap of the same 32 bytes.** `LedgerKeyFile` gains `passkey?: PasskeyWrap { credentialId, rpId: 'localhost', prfSalt, hkdfSalt, iv, tag, ciphertext }`. `KeyCustodyChange` gains `add-passkey` and `remove-passkey`. Like the current two actions, each change rewraps 32 bytes and rewrites no page. `proveReleasable` proves a new passkey wrap with a real assertion before the file is replaced, so a wrap that cannot be opened is never written. Checked against the current code: `parseKeyFile` (`src/main/db/ledger-key.ts`) validates only the fields it knows and returns the rest untouched. So 1.3.1 opens a key file that carries a passkey wrap through its device or passphrase wrap. When 1.3.1 changes custody, `applyChange` spreads `...file`, so the passkey wrap survives, and because it wraps the same data key it stays valid. The one exception is a file whose *only* wrap is a passkey. 1.3.1 refuses that file with "holds no way to open the ledger". That refusal is accurate, and since the owner forbade a passkey-only file it is also unreachable through this build. The key file therefore stays `version: 1`.

**`CustodyMethod` stops being a three-value union.** The current `'device' | 'passphrase' | 'both'` describes a pair. Three wraps make seven combinations, so the type becomes a set of independent wraps (`{ device, passphrase, passkey }`) with one honesty entry per *wrap*. "Either one opens it" becomes a sentence the Settings card composes from the set. `custodyInUse` and the picker change accordingly. This is the one refactor the feature forces, and it belongs to the same change.

**Never the only wrap.** *(The proposal allowed an `acceptLockout` exception on the desktop. The owner chose "Never allow it", so the exception does not exist on either device.)* After any change, `changeKeyCustody` requires at least one wrap that can stand alone — keychain, passphrase or PIN — and refuses otherwise, naming what is left. `readKeyFile` refuses a file whose only wrap is a passkey.

**Unlock order.** Device first, silently, as today. Then the passkey, which costs one fingerprint touch. Then the passphrase. Cancelling the fingerprint prompt falls through to the passphrase prompt and is never treated as a bypass (ADR 0029 §5).

**The honesty rows.** These are drafts for `CUSTODY_COPY` and the vault card, written in the voice of the existing rows:

| Wrap | `protects` | `fails` | `lockout` |
|---|---|---|---|
| **Desktop: Touch ID / Windows Hello** | A copy of the folder anywhere else. Also another program running as you on this computer: the key opens only through WageRoute's own passkey, and the system asks for your finger or face every time. | Anyone who knows this computer's password: the system accepts it in place of a fingerprint. Anyone at your open, unlocked WageRoute window. It is no stronger than the device password behind it. | If it is the only way in: a wiped or replaced computer, a reset Secure Enclave or TPM, or a deleted passkey means the ledger is gone. This passkey does not sync. Keep a passphrase or the keychain alongside it. |
| **Phone: passkey** | The sealed copy on a closed phone, without typing a phrase. The secret never leaves the authenticator, and nothing stored on the phone is enough to open the copy. | Anyone who knows the phone's passcode (it stands in for the fingerprint). Anyone who controls the Apple or Google account the passkey syncs through and can sign in on a device of their own. Anyone holding the phone while Pocket is open. | None on its own: the passphrase stays and opens the same copy. If you delete the passkey or change phone ecosystems, type the passphrase instead. |

Both rows deliberately say "fingerprint **or device passcode**". Platform authenticators fall back to the passcode, and a row that implied only a finger opens the key would be the kind of overclaim ADR 0020 forbids.

## Owner's decisions (2026-11-05)

The owner answered the proposal's open questions. These are their choices, quoted:

1. **Mac Touch ID:** *"Skip Mac for now (Recommended)"*. No Apple Developer membership. Pocket gets passkeys now, Windows Hello sits behind feature detection, macOS keeps keychain and passphrase, and Linux gets none.
2. **PIN:** *"Offer PIN with a warning"*. An opt-in PIN, off by default, shown with a plain warning that it can be cracked offline if the file is copied.
3. **Only key:** *"Never allow it (Recommended)"*. A fingerprint or passkey may never be the only wrap, on the desktop or the phone. `acceptLockout` is dropped.

### Amendment: the PIN

This record's own alternatives listed *"A PIN as the short way in"* as rejected, and ADR 0029 rejected it for the same reason: offline guessing exhausts a few digits immediately. **The owner overruled that.** The reason is not that the arithmetic changed. Some people want a short typed secret on a machine only they use, and the owner preferred to offer one honestly rather than leave them with no option. The conditions that make it acceptable under ADR 0020:

- It is a real wrap of the data key, not a gate. A PIN that hid a plaintext store would still be refused.
- It is opt-in, off by default, digits only, and at least 6 digits (`pinProblem` in `src/shared/encryption.ts`).
- Its honesty row's `fails` sentence is `PIN_WARNING`: *anyone with a copy of the file can try every PIN offline… a six-digit PIN is a million guesses*. The desktop confirms that sentence in a dialog before saving, and the phone's sheet shows it as the question it asks.
- It costs more per guess than a passphrase where that is measurable without hurting unlock. On the desktop that is scrypt `N = 131 072` (128 MiB, **160 ms** on an Apple M5, against the passphrase's 41 ms). On the phone it is PBKDF2 at **2 000 000** rounds, the guard rails' ceiling, which took 142 ms in Node on the same M5 and has not been timed on any phone. The cost does not make a PIN safe; it makes the offline search cost what an unlock can afford.
- It may stand alone as a passphrase does, with the same total lockout. On the phone the passphrase can be removed only while a PIN exists and no passkey does.

## Decision

1. **Fingerprint and face exist only as a PRF wrap of the existing data key.** There is no prompt-only gate, and `app.configureWebAuthn` is not called.
2. **Custody is a set of wraps of one data key**: `device`, `passphrase`, `pin` and `passkey` on the desktop (`WrapKind`, `src/shared/encryption.ts`), and `passphrase`, `pin` and `passkey` in a v2 vault. Any one opens it. Every wrap is proved by opening it again before it is written, can be added and removed at any time, and renders its own `protects` / `fails` / `lockout` rows.
3. **Never only a passkey.** `hasStandingWrap` defines what may stand alone: keychain, passphrase or PIN. The desktop's `changeKeyCustody` and `readKeyFile`, and the vault's `removeVaultWrap` and `assertMarker`, all enforce it. On the phone the passphrase also stays while a passkey exists.
4. **Pocket: vault v2.** A random 32-byte data key seals the record. The marker carries `wraps.passphrase` and `wraps.pin` (PBKDF2), `wraps.passkey` (PRF → HKDF-SHA256, `rpId` = `location.hostname`) and a `keyId`. v1 stays readable, and a new vault is still v1. A v1 vault becomes v2 only when a PIN or passkey is added: the phrase is proved, a fresh data key is made, the phrase is re-wrapped at its existing cost, and the record is re-sealed in one write. On v2, changing the phrase or PIN is a rewrap and the record does not move.
5. **Desktop passkey: Windows Hello behind detection.** `passkeyOffered` is true only on `win32`. The ceremony runs in `src/main/passkey-window.ts`: an in-memory session, `http://localhost/passkey` answered by `protocol.handle` (no socket), no preload, and a CSP of `default-src 'none'`. The ceremony is `runPasskeyCeremony` from `src/shared/passkey-ceremony.ts`, the same function the phone calls, sent to the page through `executeJavaScript`. A registration must return `prf.enabled`, and a second assertion's output must open the wrap made from the first, before `changeKeyCustody` writes anything.
6. **Unlock order: keychain → passkey → typed.** A cancelled, failed or wrong passkey falls through to the prompt. The prompt says *passphrase*, *PIN* or *passphrase or PIN* according to the key file. Digits are tried as the PIN first, and both are tried.

## What was measured and what was only unit-tested

| Claim | How it was established |
|---|---|
| PRF wrap and unwrap is deterministic, refuses a different passkey, and the passphrase survives a lost passkey (Chrome 156, Electron 45) | **Measured**: spike table above, `spikes/0031-passkey-prf/results.json` |
| On this Mac, Electron 45 without `configureWebAuthn` reports no platform authenticator, even with a virtual one attached, so the desktop refuses the offer up front with *"offers no fingerprint or face check"* | **Measured**: `spikes/0031-passkey-prf/ceremony-smoke.json`, `realPlatform` |
| The app's own `passkey-window.ts` loads `http://localhost/passkey` from `protocol.handle`, and runs the shared ceremony through `executeJavaScript` after esbuild bundling. Registration plus two assertions return the same 32 bytes (161 ms), and the wrap made from the first opens with the second | **Measured** in Electron 45 with a CDP virtual authenticator, with only the platform-availability answer stubbed to `true`: `ceremony-smoke.json`, `platformCheckStubbed` |
| The unlock window asks for the stored credential, and a passkey that returns no PRF output gives `null`, so the launch falls through to typing | **Measured**, same run. A credential copied into a second virtual authenticator carries no hmac-secret seed, so a successful cross-window unlock could not be shown this way |
| Custody rules: a PIN wraps the same key, stands alone and is never removed last, needs ≥ 6 digits, and is changed only after proving the current one. A passkey is never left alone, is not written when two answers differ, and a passkey-only key file is refused | **Unit-tested**: `src/main/db/custody.test.ts` (real SQLite ledger, HMAC stand-in authenticator) |
| Unlock order, fall-through on cancel/failure/wrong output, PIN-only prompt and retry | **Unit-tested**: `src/main/db/unlock.test.ts` |
| Vault v1 → v2 on adding a PIN, both secrets open the re-sealed record, the old marker no longer seals, passkey add/unlock/lost-passkey, the never-only and phrase-stays rules, passkey-only marker refused, rewrap on change | **Unit-tested**: `src/pocket/lib/vault.test.ts` (Node WebCrypto, stand-in ceremony) |
| Windows Hello returning PRF to Electron; any handset registering a passkey, returning PRF, or opening a v2 vault; a handset's PBKDF2 timing | **Not run.** No Windows machine or handset was available here. The offer is feature-detected and self-tested, so where these fail, nothing is written and the existing ways in are untouched |

## Consequences

### Positive

- The owner's "fingerprint" request is met without breaking ADR 0020: the finger releases a key, and a copied file stays sealed.
- No new runtime dependency on any platform and no server component. PRF runs in the browser, and the ceremony is one function shared by both devices.
- The phone gets more than one way in, which ADR 0029 listed as a gap ("the vault has exactly one way in").

### Negative

- **The vault format changed (v1 → v2).** That is the largest code cost, and it touches the most fragile path on the phone. v1 must remain readable indefinitely, and a v2 copy cannot be opened by a 1.3.1 phone.
- **A PIN is weak against a copied file**, by the owner's informed choice. The warning is mandatory and confirmed before saving.
- **Synced passkeys widen who can open the phone's copy** to anyone who controls the owner's Apple or Google account. The card's row says so.
- **macOS and Linux desktops get no fingerprint.** That follows from the owner's choice and the platforms, not from a missing implementation.
- **"Fingerprint" is really "fingerprint or device PIN/passcode."** The protection is the device secret's, with the hardware's rate limiting.

### Neutral

- No schema change and no `SCHEMA_VERSION` bump. The change lives in `ledger.key.json` (still `version: 1`, because 1.3.1 ignores the new fields) and in the vault record.
- ADR 0030 is unchanged. The passkey is local custody, not edge identity. Per-tenant hostnames (`ann.wageroute.lan`) keep each tenant's passkeys separate.

## Alternatives considered

### `promptTouchID` or Windows Hello as a prompt in front of the dashboard
Rejected (ADR 0020). It releases nothing, and a file copy gets past it.

### `largeBlob` to carry the key on the authenticator
Not pursued. PRF is more widely supported, needs no storage on the authenticator, and keeps the wrap beside the data, where the existing custody code already looks.

### A native module with `kSecAccessControlBiometryCurrentSet`
Rejected. It needs the same Team ID as `configureWebAuthn`, adds signed native code for eight targets, and solves only macOS.

### Asking the system browser to run the ceremony and hand the secret back to Electron
Rejected. It needs a loopback listener that any local process could reach, plus a channel to carry the derived secret between two applications. Answering `http://localhost` with `protocol.handle` inside Electron gives the same origin with no socket.

### A PIN as the "short" way in
Proposed as rejected, for the reason ADR 0029 gives: offline guessing exhausts four to six digits immediately. **Overruled by the owner** (see *Amendment: the PIN*). A PIN is offered opt-in, with at least six digits, a dearer KDF and a confirmed warning, because the owner preferred an honest weak option to none. The passkey is still the short way in without that weakness, where the platform allows one.

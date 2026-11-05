# WageRoute Pocket — using the phone

WageRoute Pocket is the optional phone app. It is not a second ledger and it never syncs: it opens a backup from your computer, keeps a copy of those tables in the browser, lets you edit that copy with no signal, and hands the changes back in a file you carry yourself. There is no account, no sign-in, no server and no upload — the backup file is the only thing that ever leaves either device, and you can [seal it](#sealed-exports) before it does.

This page is the user's guide. The behaviour it describes is documented screen by screen in [FEATURES.md](FEATURES.md#pocket-phone), the merge rule in [ADR 0024](decisions/0024-two-copies-merge-by-time.md), the shared validation in [ADR 0025](decisions/0025-the-phone-writes-through-the-desktops-own-rules.md), the counted delete questions in [ADR 0027](decisions/0027-one-expansion-answers-every-destructive-question.md), the way a bill's set-aside is worked out on both devices in [ADR 0028](decisions/0028-both-devices-derive-a-bills-set-aside-from-its-payments.md), and the choice to seal this phone's own copy or a file that leaves it in [ADR 0029](decisions/0029-encryption-is-a-choice-on-the-disk-and-on-the-way-out.md). The security notes are in [SECURITY.md](SECURITY.md#pocket-web-app).

## Contents

- [Before you start](#before-you-start)
- [Getting it onto the phone](#getting-it-onto-the-phone)
- [First run](#first-run)
- [Day to day](#day-to-day)
- [Sealing this phone's copy](#sealing-this-phones-copy)
- [Carrying changes between the two devices](#carrying-changes-between-the-two-devices)
- [What the phone does not do](#what-the-phone-does-not-do)
- [When something is refused](#when-something-is-refused)
- [Status: what has been proved, and what has not](#status-what-has-been-proved-and-what-has-not)
- [Hosting it yourself](#hosting-it-yourself)

## Before you start

You need three things:

1. **WageRoute on your computer, with data in it.** The phone opens a backup, so a ledger with nothing in it gives you an empty phone.
2. **A backup file.** On the computer: **Settings → Export full backup**. It writes `wageroute-backup-YYYY-MM-DD.json`, or `wageroute-backup-<date>-encrypted.json` if you seal it with a passphrase there. The phone opens both.
3. **A web address the phone can reach over HTTPS.** This is the one real requirement, and it is why the app is not simply a file you copy to the phone: a secure origin is what a browser hands three separate privileges to — the install prompt, the offline service worker, and its crypto. Plain `http://192.168.x.x` opens the page and gives you none of them: nothing works offline, there is no icon, and [any cipher](#a-page-with-no-cipher) is refused with an explanation rather than attempted half-way. The repository ships a worked example of the address: `docker-compose.yml`'s `edge` profile puts Caddy with a local CA and a forward-auth login in front of the Pocket container, and [DEPLOYMENT.md](DEPLOYMENT.md#tls-a-login-and-more-than-one-person) has the command and what still has not been proved on a handset.

Both devices should be on the same release. A phone pointed at an old build reads an old backup format; the desktop reads files the phone writes at the highest schema version the phone has seen.

## Getting it onto the phone

**Once the app is published, this is the whole procedure:**

1. Open the address on the phone's browser — Chrome on Android, Safari on iPhone.
2. Install it: on Android, the browser menu offers **Install app**, or the app itself shows **Add WageRoute to this phone**; on iPhone, Share → **Add to Home Screen**.
3. Open it from the home screen. It now runs as its own app, without browser chrome, and opens with the signal off.

If the browser offers nothing, the page is not on a secure origin, or it has already been installed. Installing again does nothing; the icon opens the same app.

**Publishing it is an owner action, and as of this writing it has not been done.** The repository carries a manual workflow, [`.github/workflows/pocket.yml`](../.github/workflows/pocket.yml), that builds `dist-pocket/` and deploys it to GitHub Pages. To turn it on: enable Pages for the repository with **GitHub Actions** as the build source, then run the **Pocket** workflow from the Actions tab. The deployment URL appears on that run. No tag, no release and no desktop build publishes the phone app, and a normal push never will.

Until then, or if you would rather keep the app off a public URL, [host the folder yourself](#hosting-it-yourself).

## First run

The welcome screen says *Your ledger, in your pocket*, and asks for one thing: **Choose a WageRoute backup**. Below the button it lists the three steps — export on the computer, send the file to the phone, add the page to your home screen — and states that there is no account, no upload and no tracking.

The file is checked before anything is stored. A sealed one is recognised by its clear header and waits for its passphrase on the same screen; everything below is what happens once the rows can be read. It must be a WageRoute backup (the `cash-flow-routing-backup` marker), version 2 or newer, with at least one account and money written as whole cents. Anything else is refused with a reason on the same screen rather than opened half-way: a file that is not JSON, a file with no ledger in it, a file too large for a phone (over 24 MB), an account kind or frequency this build does not know, an amount that is not a whole number of cents. Integer strings are accepted; a value that would need rounding is not.

When it opens, the app says *Your ledger is on this phone now. It stays here.* If the browser refuses to store it, you get *Opened, but this phone could not store it* and the reason — the copy is on screen only for this session, so do not count on it.

Everything lives in one browser record (IndexedDB, database `wageroute-pocket`). Closing the app, switching off the signal or restarting the phone keeps it. Clearing the site's data, using private browsing, or opening the address in a different browser does not: those are different copies, and the app cannot see them.

## Day to day

Six tabs: **Home**, **Bills**, **Goals**, **Accounts**, **Entries**, **Data**. Editing happens in a sheet that slides up from the bottom; **Escape** or a tap on the dim background closes it without saving.

| Tab | What it shows | What you can do there |
| --- | --- | --- |
| **Home** | Safe to Spend with its four-line breakdown, cash on hand, total wealth, next payday, bills due in the next 14 days, your first three goals, every live account, and the entry count with the date of the file it came from | Read only. **All bills**, **All goals** and **All accounts** jump to the tab that edits them |
| **Bills** | The monthly total, the per-paycheck reserve, and each open bill with its next due date, account, amount and state — **Due**, **Set aside**, **Part paid** or **Paid** | **Add** a bill; a row opens **Mark paid**, **Pause** / **Turn back on**, **Edit**, **Delete** |
| **Goals** | Funded total, progress, and each goal's target, remaining and target date; archived goals keep their own heading | **Add** a goal; a row opens **Edit**, **Archive** / **Bring back**, **Delete** |
| **Accounts** | Total wealth, cash on hand, card debt and the room left on the cards, one row per account, with a utilisation bar on each card | **Add** an account; a row shows what is owed, the limit, available, used, APR, minimum, statement close and due days, what is due now and the payoff at the minimum, and offers **Adjust balance**, **Pay this card** on a card, **Edit**, **Archive** / **Bring back**, **Remove** |
| **Entries** | The ledger grouped by date with a total per day, transfers shown as two legs. Rows this phone wrote carry *on this phone*. Over 500 entries it says it is showing the newest 500 | **Add** an entry of any kind; a row's pencil opens it for editing, the trash removes it |
| **Data** | The file's name, when it was opened, the date it was exported, how many entries are held and how many this phone wrote, the schema, any notes from the last merge, the app version, and — if you asked for one — the seal on this phone's copy | **Open a newer backup**, **Export a backup** plain or sealed, **Seal it** / **Change the passphrase** / **Turn it off** / **Close it now**, install instructions, the privacy note, **Forget this phone** |

Every number is computed by the same functions the desktop uses, so a figure that is wrong on one device is wrong on both — the app has no second arithmetic of its own.

**Paying a bill on the phone is what you came for.** **Mark paid** posts the month's payment exactly as the desktop's prompt would, and the paycheck's set-aside for that bill closes on this device in the same keystroke. The bill reads **Paid** here without waiting for a round trip, and Safe to Spend keeps the cash for a card payment instead of treating the debt as money gone. Editing that payment to a smaller figure, moving its date, or deleting it reopens the claim again — the answer is worked out from the payments in front of the phone, not remembered from the file it opened.

Some fields are locked, and the sheet says why. An account's **type** cannot change once it exists, because the entries behind it were written as a different instrument. What you owe is never typed in: **Adjust balance** posts an adjustment entry so the opening balance stays the figure the account started with. In the entry sheet, a transfer leg keeps its account and kind locked, and a round-up sweep also keeps its date and amount, because those rows are half of a pair the ledger only reads together. A goal's colour is the desktop's to choose.

Anything the desktop would refuse, the phone refuses in the same words, because both read one validation module. A refusal stays on the sheet under the field it belongs to and nothing is written — so a rejected edit can never travel back to the computer in a later export.

## Sealing this phone's copy

Neither cipher is on by default, both can be turned on or off at any time, and choosing one does not choose the other. The phone has two separate secrets to keep, and they are kept differently:

| | The vault | The envelope |
| --- | --- | --- |
| What it covers | The copy this phone keeps in its own storage | A file that leaves the phone |
| Where it lives | IndexedDB, database `wageroute-pocket` | A JSON file you carry yourself |
| Turning it on | Data → the seal card → **Seal it** | Data → **Export a backup** → *Sealed with a passphrase* |
| Asked for again | Every time the app is reopened or the page reloaded | Every time that file is opened, on either device |
| If the phrase is lost | This phone's copy is gone. Your computer and your other files are untouched | That file is gone. Nothing else is |

Both stretch the passphrase with PBKDF2-HMAC-SHA256 into an AES-256-GCM key, both default to 600 000 rounds, and both apply the desktop's passphrase rule in the desktop's words: ten characters is the floor, and the reason given is that whoever holds a copy of the sealed thing can test guesses offline at their own speed, which a short phrase runs out of fast. A file sealed on the phone opens on the computer and a file sealed on the computer opens on the phone, because the format is one shared module (`src/shared/envelope.ts`) and each device only supplies its own cipher — `node:crypto` there, WebCrypto here. The mechanics of the envelope, field by field, are in [IMPORT-EXPORT.md](IMPORT-EXPORT.md#sealed-exports-the-envelope).

### The vault

The card is written as a choice rather than a toggle, with the three lines the option owes you — what it **stops**, what it **does not stop**, and what happens **if you lose the phrase** — and they stay on screen after it is on, because the moment to read them is before. The short form: it stops anyone who reads this handset's storage (a copied app folder, a device backup, a browser you did not open); it does not stop anyone using the phone while the app is open and unlocked, and it is not a second lock laid over the one your phone already has.

What actually happens when you seal:

- Your passphrase is stretched **once**, into a key that is non-extractable and lives in this page's memory only — not in the store, not on disk, not in component state. What stays behind in storage is the marker in the clear (format `wageroute-vault`, the rounds, the salt, a sealed token that proves a phrase, and the date) beside exactly **one** sealed copy of the whole ledger.
- Every save re-seals that one copy under a fresh initial vector. Derivation costs per unlock, not per keystroke — which is the difference between a phone that seals every write and one that puts half a second behind each commit.
- **Closing the app loses the key**, and so does **Close it now**, which takes the key out of the page without touching your data. Reopening gives a screen of its own: *Sealed on {date}* and one passphrase box, with no tabs behind it — every number they would show is under the cipher, and a phone that printed a ledger over unreadable bytes would be lying. The date is the one fact about the copy that does not need the phrase, because the marker is in the clear.
- **Change the passphrase** asks for the current one first and proves it *without* disturbing the open session, so a typo in the new box cannot lock you out of a working phone. It mints a fresh salt rather than re-wrapping a key — the old phrase stops opening the copy the moment this succeeds, and the notice says so. **Turn it off** is the same operation in reverse: read with the key, write the copy plain, then let the key go. Nothing is bulk-decrypted and no migration can strand the file, because there was only ever one record.
- The card reports **Sealed since** and **Cost of a guess — 600,000 rounds**. That number is the whole defence, and the honest counterpart is what is *not* here: there is no delay between attempts, no lockout and no counter of guesses, because the app holds no secret that could enforce one and anyone with a copy of the storage can attack it without the app at all. There is no reset and nobody who can open a sealed phone for you — which is also why the phrase is typed twice before anything is written.

Refusals come in two kinds and the screen distinguishes them. *That passphrase does not open this phone's copy of your ledger.* is worth typing again. A damaged copy is not, and says so: the marker that will not parse, or the sealed copy that no longer authenticates, means *Typing again will not change this. The copy on this phone is damaged, and the way back is a backup from your computer.* Nothing on this phone can be decrypted without the phrase that sealed it, so a file from the computer is the only other door.

The locked screen has exactly two doors — the phrase, and **Forget this phone's copy** (*Erase the copy on this phone?* → **Erase this phone**, or **Keep it**). Erasing is offered there deliberately: a forgotten passphrase has no reset, so hiding the second door would leave a person whose vault will not open with nothing but the browser's site-data settings to resort to — a worse route to the same place. It deletes what is on this phone and nothing else.

### Sealed exports

Data → **Export a backup** offers *Plain JSON* and *Sealed with a passphrase*. The first writes `wageroute-pocket-<date>.json`, readable in any spreadsheet by anyone holding the file. The second asks for the phrase twice and writes `wageroute-pocket-<YYYYMMDD-HHMMSS>-encrypted.json` — the name says what is inside, and the name and the header come from the same moment, so a file the browser saves cannot disagree with the file within it. The phrase used there is used once and then forgotten; it is not the vault's phrase and not your computer's unless you type the same words each time. **WageRoute can recover none of them.**

A sealed file arriving *at* the phone — from the first-run picker or from **Open a newer backup** — gets one sheet for both doors: *Open an encrypted backup*, with the file's name, the date it was written, and a passphrase box, because nothing in it can be counted until that phrase opens it. A wrong phrase keeps the sheet and the file: it stays held so you can type again rather than being thrown away. Opening changes nothing on this phone; the merge that follows is the same one a plain file takes, and reports the same counts.

### A page with no cipher

`crypto.subtle` exists only on a secure origin, so plain `http://192.168.x.x` gives an app that can read its own storage and cannot seal or open a thing. Rather than meeting `undefined is not an object`, every screen here says the same sentence and stops offering what it cannot do:

> This page has no cipher: a browser lends WageRoute its crypto only over HTTPS, or on the machine the app is running on. Open it that way, or carry the plain export.

**Seal it** and the *Sealed with a passphrase* segment go dark, and so does the erase door on the locked screen — a page that cannot open a healthy vault must not offer the delete that would end a copy which only looks lost. **Forget this phone** on Data stays live, because erasing bytes needs no cipher, and a plain export still works: the ledger is not damaged, the URL is. Opening that same address over HTTPS, or on the machine it runs on, changes nothing about the stored rows.

## Carrying changes between the two devices

There is no transfer. You are the transport, and the file is the message.

**Phone → computer.** Data → **Export a backup** writes every table as the phone now holds it, including deletions, as `wageroute-pocket-<date>.json` — or, sealed, as the encrypted file [described above](#sealed-exports). Get it to the computer and open **Settings → Import data** on it: a sealed file asks for the phrase before it shows you any counts, then the wizard reports how many rows were added, changed and removed. New rows arrive; a row the phone changed more recently replaces the computer's copy; a deletion recorded on the phone is applied; a row the computer changed more recently stays as it is. Importing the same file twice changes nothing the second time.

**Computer → phone.** Export on the computer — plain, or sealed with a passphrase you are willing to type on a phone — send the file, then Data → **Open a newer backup**; a sealed file asks for its phrase before anything is counted. This merges, it does not replace: entries you added on the phone since the last file survive, and the confirmation tells you how many of them could still be overwritten by a newer copy in the file before you agree to it. Afterwards the toast says what moved — `Merged: 3 new · 1 changed · 2 removed`, or `Merged: Nothing changed` — with any notes (a category name that already existed under another id, for instance) listed on Data. If this phone's copy is sealed, everything that arrives goes back out under that same seal: the merge writes through the vault, so there is no second, plaintext copy of your ledger sitting next to the encrypted one.

The rule is last-write-wins per row, by `updated_at` and then `revision`. It is not a conflict wizard: the older edit is dropped, not shown, and there is no field-level history or undo. **So the habit that keeps you safe is a short one — carry the file after each session on either device, and do not edit the same bill, goal, account or entry on both before a file has passed between them.**

A file from an older desktop is expected, not a problem. The phone opens backups from version 2 upwards, and a column an older build never wrote — such as the day a set-aside was claimed for, which the released 1.2.0 does not record — is filled the same way the computer fills it when it opens that file: from the bill's own due day. Nothing is invented. A row whose facts cannot be read is left exactly as the file has it, and the next export from the computer, which replays every claim as it imports, brings it onto the same answer.

## What the phone does not do

- **Route a paycheck.** Paychecks, their allocations, the routing plan and settings are written on the computer and arrive with the next backup. The phone has no writer for them, so it cannot half-write one.
- **Create a set-aside.** A paycheck's reservation is written on the computer. The phone works out whether it has been spent, and updates that state, but never invents a new claim.
- **Hold a categories screen.** Neither device has one: type a new name into an entry and it is created.
- **Merge two phones, or tell you which side won.** Two phone copies are two copies; only the computer's file joins them.
- **Read a file by itself.** No fetch, no pairing, no background import. You choose the file each time.
- **Hold a copy of a passphrase.** Not the one that seals this phone's copy, not the one that seals a file: neither device keeps a copy, there is no reset, nobody can be asked to open a sealed thing for you, and there is no waiting period or attempt count between one guess and the next. The key stretching in front of each guess — the rounds on the card, the rounds in the file's header — is the only cost there is.
- **Encrypt anything on the network.** There is no network traffic to encrypt beyond the page load; the seal is on the storage of this handset and on the file that leaves it.

## When something is refused

| You see | What it means | What to do |
| --- | --- | --- |
| A refusal under a field, sheet still open | The desktop would refuse the same typing. Nothing was written | Fix the value. The sheet keeps what you typed |
| *That file is too large to open on a phone* | Over 24 MB | Trim the ledger on the computer, or export a partial backup |
| *That is not a WageRoute backup* | Wrong marker or wrong file | Check you exported from WageRoute, and pick the `.json` |
| A newer-schema warning on Data | The file came from a newer desktop build than this phone app | Look, but do **not** export from the phone until the app is rebuilt and republished |
| *This page has no cipher: …* | The address is not a secure origin, so the browser withholds its crypto. Your ledger is not damaged | Open it over HTTPS, or on the machine it runs on. Until then the plain export is the door that works — and do not erase anything to "fix" this |
| *That passphrase does not open this phone’s copy of your ledger.* | Wrong phrase at the gate, or on the seal card. Typing it again can help; there is no reset and nobody holding it | Try once more. If it is genuinely gone, the copy on this phone is, and the way back is a backup from the computer |
| *Typing again will not change this. The copy on this phone is damaged…* | The marker will not parse, or the sealed copy no longer authenticates what WageRoute wrote | A different phrase cannot help. Erase this phone's copy and open a file from the computer |
| *That passphrase does not open this file, or the file has been changed since it was written.* | The wrong phrase for that envelope, or a file altered in transit | Retype it. If this phone wrote the file, the phrase is the one typed twice in the export sheet — not necessarily the vault's |
| *That is not a problem the passphrase can fix — the file itself is not one WageRoute can open.* | The header said sealed, then the file failed to read: a newer envelope, an unknown cipher, a length out of place. The sentence above this one in the sheet names which | **Choose a different file.** If it is a newer envelope, rebuild and republish the phone app rather than exporting from it back to the computer |
| *Opened, but this phone could not store it* | The browser refused IndexedDB — private mode, full storage, blocked site data | Do not rely on the copy; fix the browser setting and open the file again |
| *The screen is clear, but phone storage would not erase the copy* | **Forget this phone** removed the app's view, not the stored row | Clear the site's data in the browser settings to be sure |
| Nothing happens after a delete | The confirmation is still open, or you chose *Keep it* | Deletes always ask first, and *Keep it* is the safe answer |

A copy you have lost this way is not recoverable from the app: the only other copy is the last file you carried. When in doubt, **export before you forget**, and keep the file the phone wrote until it has landed on the computer.

## Status: what has been proved, and what has not

Worth reading before you rely on this with real money.

- **Proved by tests.** The same money fact typed on each device leaves both in the same state (`src/pocket/lib/claims-parity.test.ts`), including a fact carried in a file from the released desktop, which stamps its set-asides with no due day at all; every writer's row, refusal sentence and cascade is pinned against the desktop's own (`src/pocket/lib/write.test.ts`, `src/shared/writeRules.test.ts`, `src/shared/claims.test.ts`); the phone's figures are compared with a desktop snapshot of the same rows (`src/pocket/lib/snapshot.test.ts`). A phone write, exported and merged back on the desktop, settles the claim there too. The ciphers are held to the same standard: a sealed phone's storage holds no readable ledger and no plain copy beside it, a reloaded vault comes back locked rather than empty, a changed passphrase retires the one it replaces, a record tampered with after it was written refuses to open, and a vault made at a cost outside the rails is refused before any key is derived from it (`src/pocket/lib/vault.test.ts`, `vault-store.test.ts`, `src/pocket/components/vault-ui.test.ts`). Sealed files cross both ways — a phone's sealed export is one the desktop opens, and the desktop's is one the phone reads (`src/pocket/lib/sealed-store.test.ts`, `src/main/envelope.test.ts`) — and every seal screen is tested again on a page whose cipher has been taken away, which is what an insecure origin gives you (`src/pocket/components/seal-ui.test.ts`, `src/pocket/lib/without-cipher.ts`).
- **Proved in a browser, over the Chrome DevTools Protocol, against the built bundle** — the screens, the refusals, imports, exports, the counted delete questions and the offline shell. The bundle driven is the bundle the build wrote, checked by its hash.
- **Not yet proved: a real handset.** No iPhone or Android device has installed the shell, opened it with the radio off, or carried a file back. The offline shell was shown to survive a stopped server on `localhost`, not on an installed phone. The same gap covers the seal: no handset has sealed a vault, re-sealed itself on every save, come back locked after a restart, or typed 600 000 rounds of PBKDF2 through a real phone's WebCrypto — the tests run the same WebCrypto calls in a Node harness, and a mid-range Android is slower than a laptop. And the whole no-cipher branch has only ever been driven on a machine that can be given an insecure page on purpose; on a real handset across your Wi-Fi, that sentence is the expected first answer until TLS is in front of it. This is the remaining gap in the release checklist, and it is a manual one.
- **Not enabled: GitHub Pages.** The workflow exists and has never been run to a live site.

## Hosting it yourself

`npm run pocket:build` writes a folder of static files to `dist-pocket/`: `index.html` with a same-origin content policy, `manifest.webmanifest`, `sw.js`, icons, and hashed assets. There is no backend, no environment and no build-time secret.

- **Paths are relative** (`base: './'` in `src/pocket/vite.config.ts`), so the folder works at a domain root, under `/pocket/`, or on a project page. Upload the contents, not the folder itself, if your host expects the site at the root.
- **Serve it over HTTPS.** A secure origin is what the browser conditions three things on: the service worker, the install prompt, and `crypto.subtle` — so an insecure one gives you a page that works online but cannot seal or open anything, as [that section](#a-page-with-no-cipher) puts it. `localhost` counts, so `npm run pocket:preview` (port 4173) and `npm run pocket:dev` (5173) are enough to work on your own machine, ciphers included, and both can even be installed there. They bind to localhost by default: adding `-- --host` lets a phone on the same Wi-Fi load the page, but over plain HTTP it loses the service worker, the install prompt and the cipher — nothing works offline, and sealing is refused with an explanation.
- **Nothing is asked for once the page is up.** No API, no telemetry, no font or script from a third party; the only traffic to the origin is the browser's own page load and the shell's cached files, and the ledger never becomes a URL, a header or a cached response.
- **Caching is the app's own business.** `sw.js` is stamped at build time with `<version>-<hash of the shell>` and the exact asset list, and its cache is named `wageroute-pocket-<that stamp>`. A page load tries the network first and falls back to the cached shell, so a new release lands on the next open; hashed files are served from cache. Only caches with that prefix are ever deleted, so sharing an origin — or a GitHub Pages account — with another app is safe.
- **A host that can send headers should add** `Content-Security-Policy: frame-ancestors 'none'`. The policy in the HTML is delivered by a `<meta>` tag, where `frame-ancestors` is ignored, so clickjacking protection depends on the host. GitHub Pages does not send it.
- **Or run the container.** The repository ships a Dockerfile that builds `dist-pocket/` from source and serves it with nginx (77 MB, no Node, no source in the runtime image):

  ```sh
  docker build -f docker/pocket.Dockerfile -t wageroute-pocket .
  docker run --rm -p 127.0.0.1:8173:80 wageroute-pocket
  ```

  Then open `http://localhost:8173`. It is the same folder `npm run pocket:build` writes, and the container adds the two things a plain file drop often gets wrong: `frame-ancestors 'none'` as a real header, and `Cache-Control` split so `sw.js` and the page are revalidated on every load while a hashed asset is cached forever. `docker compose up --build` starts it beside the desktop container — see [DEPLOYMENT.md](DEPLOYMENT.md#running-wageroute-in-a-container). Publishing a container image is a deployment like Pages is, not part of a release. It is still plain HTTP, and `localhost` on your own machine counts as a secure origin, so the service worker runs and the app works offline there. The `-p 127.0.0.1:` prefix is on purpose: it means a handset across your Wi-Fi **cannot** reach this container at all. To serve a phone, republish the port on your LAN address (drop the `127.0.0.1:` or bind `-p 0.0.0.0:8173:80`) and put TLS in front of it — plain HTTP on a LAN address gives a page that loads without a service worker and without a cipher, so nothing works offline, there is no install prompt, and the seal is off the table until the certificate is.

- **Publishing a new build is a deployment, not a release.** The desktop installers do not contain the phone app, and a desktop release does not require republishing it. Do republish when a release changes the backup format, the envelope or the vault's, so phones can read and write what the new desktop writes.

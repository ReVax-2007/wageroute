# 0030 — Self-hosting puts identity at the edge, never in the app

**Status:** Accepted (2026-11-04)

**Related:** [ADR 0001](0001-local-first-desktop.md), [ADR 0004](0004-sync-ready-schema.md), [ADR 0019](0019-the-ledger-is-plaintext-at-rest.md), [ADR 0022](0022-the-ledger-can-live-in-a-folder-you-choose.md), [ADR 0023](0023-the-phone-reads-a-backup-and-writes-only-entries.md), [ADR 0029](0029-encryption-is-a-choice-on-the-disk-and-on-the-way-out.md), [DEPLOYMENT.md](../DEPLOYMENT.md)

## Context

The owner runs this on their own machine, and said so twice: users host on their own machines, not on external servers — the basement server or a Docker container on the laptop is the deployment, not a service we operate. Batch 52 built that: two images (`docker/pocket.Dockerfile`, `docker/desktop.Dockerfile`), a `docker-compose.yml`, and a publish workflow. Both publish to `127.0.0.1` by default, which is honest about the consequence: a handset cannot reach them at all.

The next question the container work raises is the one [ADR 0001](0001-local-first-desktop.md) deferred. Two people want their own ledgers on one host:

- **There is no identity anywhere in the app.** WageRoute does not authenticate; the `users` table exists but is always seeded with one credential-less row, and every read and write is scoped to it. The container's own doors are a published port and, for the streamed desktop, a noVNC password that crosses an unencrypted websocket.
- **Serving Pocket to a phone without TLS is not the app people installed.** A service worker and an install prompt need a secure origin; `http://192.168.x.x` gives a page that loads, then loses both ([DEPLOYMENT.md](../DEPLOYMENT.md#pocket-in-a-container)). So "publish it to my network" *requires* a certificate, and a private network has no public CA for it.
- **Application state is already one folder.** `HOME=/data` puts settings, the ledger, its key sidecar (ADR 0029), the crash log and the app's own `backups/` copies inside one mount. Per-user isolation is therefore a volume and a routing rule — not a feature to build.

The tempting answer is to put a login in the app. That is the decision this record refuses.

## Decision

**Authentication and TLS belong to the edge. The app stays single-tenant, and multi-user is one instance per person behind a proxy.**

1. **The app never learns who is logged in.** No login screen, no credential store, no session it issues, no per-request identity, and no check that asks *which person* is on the connection. The one gate inside the app is `isTrustedFrame` (`src/main/ipc.ts:240`, called by the `handle()` wrapper at `:274`), which all forty-seven channels of `CHANNELS` (`src/shared/channels.ts`) run through before their handler does anything — a boot check at `src/main/ipc.ts:1260` throws if a contract channel is ever registered without the wrapper, so the count is the whole contract rather than a sample. But the check asks which window the message came from, not who typed it, and it exists to keep an unrelated frame out of the ledger. The single channel registered outside that helper, the unlock prompt's own (`src/main/unlock-prompt.ts:90`, guarded by its own `isUnlockFrame` at `:91`), checks its frame the same way against the same URL rule. None of it can tell two humans apart, which is exactly why it is not an answer to this record's question. The proxy decides whether this connection may reach this instance, and the app assumes that if the bytes arrived, the edge let them through.
2. **The edge is the operator's choice, and both common shapes work.** Caddy or Traefik, each able to issue certificates for a private name, in front of either service, gated by forward authentication (`200` means allow, anything else means the login page) against the tool the operator already runs — Authelia, Authentik, the proxy's own basic auth, or a single-user password. **What the repo owes here is a worked example, not an auth implementation** — a proxy service and one templated tenant in `docker-compose.yml`, plus the chapter in [DEPLOYMENT.md](../DEPLOYMENT.md#tls-a-login-and-more-than-one-person) that says how to fail closed. That example now exists: the `edge` profile in `docker-compose.yml` adds `caddy`, `pocket-ann` and `desktop-ann` with Ann's own `wageroute-ann-data` volume, and `docker/edge.Caddyfile` holds the two TLS site blocks. It was validated and driven through a forward-auth stub on 2026-11-04; the proof and its limits are in that chapter. Every one of those services is behind `profiles: [edge]`, so the default `docker compose up` still starts exactly the two loopback containers it started before. What the record still refuses to say is the other half: this is a *shape*, not an authentication implementation — no login, credential store or session ships in this repository, and no document here may promise that an operator's provider is configured correctly, or that a handset has run this.
3. **One tenant = one instance = one volume.** A second person gets a second pair of containers with their own `-v wageroute-ann-data:/data`, their own route, their own backups. **There is no multi-tenant code path, no shared database and no row-level security**, so there is no way for one tenant's query to reach another's money: the isolation is a process boundary and a mount, and it is the same isolation a laptop with two user accounts already gives. On 2026-11-04 that was demonstrated between two real tenants rather than argued from the mechanism: run side by side, each tenant's container could not resolve or reach the other's address in either direction, each ledger sat on its own volume with its own inode, the Pocket bundle served to both was byte-identical, and closing **Ann's** auth stub left **Bob's** site serving traffic with nothing new in Ann's app log. The measurements are in [DEPLOYMENT.md](../DEPLOYMENT.md#tls-a-login-and-more-than-one-person).
4. **Options, and a way back.** The shapes are all supported and all reversible: loopback only with no auth (today's default), TLS with no login, TLS plus a password, TLS plus TOTP or a passkey at the edge, or "give up the server and run it on the laptop again". Nothing inside the app can refuse one of these, because nothing inside the app sees one — and for the same reason nothing here can promise one: an edge passkey needs a name the operator's identity provider can register under, which is the caveat in the Negative list below rather than a feature of this product. A ledger's file format is identical in every one of them, so moving between shapes is copying a folder — which is ADR 0022's data-folder choice, not a new mechanism.
5. **Encryption does not depend on the edge, and the edge does not depend on encryption.** A tenant whose ledger is keyed (ADR 0029) keeps that protection even if the proxy is misconfigured to plain HTTP — but read the claim narrowly: the cipher covers **the file**, so what survives a bad deploy is a copied or snapshot ledger, while the streamed desktop and its noVNC password cross the wire exactly as they always did — in the clear until the edge terminates TLS. And a served tenant cannot use the desktop's device custody: a container has no keychain for `safeStorage` to reach, `deviceCustodyAvailable()` reports false in a headless session (`src/main/db/device-custody.ts:35`), so a keyed ledger on a server is keyed **by passphrase**, with everything that implies for lockout. A tenant who never turned encryption on is still gated by the same login. The two controls are independent by design, because a deployment that needs both to work is a deployment where one failure opens everything.
6. **What the desktop container's shape means, stated rather than softened.** Electron's single-instance lock means one app process per container, so **every viewer of one desktop instance shares that one cursor** — that is a property of the design, not a bug to fix, and it is why "two people" on the desktop half means two containers. Files an import needs must already be inside the container, and `--no-sandbox` means the renderer isolation the installer relies on is not in force.
7. **Out of scope, in the same words as before.** No account that must exist before the app works, no hosted recovery or password reset we operate, no sync between tenants, no admin console, no quotas or billing, no telemetry about who runs what. If a person forgets their edge password, the answer is their edge's own reset flow; we are not in a position to help, and this record is the reason.

## Consequences

### Positive

- The app keeps the property that made it auditable: one local file, one user, no secrets to hold. A login would have added a credential store, a session and an authorization surface — the three places a financial app gets breached.
- Multi-user costs one mount and one route, so it inherits the *existing* guarantees: the same 0600 file permissions, the same per-tenant `VACUUM INTO` copies, the same ADR 0029 custody choice, and a broken instance cannot read a neighbour.
- People who want one person and no proxy are unaffected. Nothing here makes TLS or a login a requirement to run the app, and the loopback default in `docker-compose.yml` stays as it is.
- The phone gets the shape it needs: HTTPS at the edge is what restores the install prompt and the offline copy on a handset. That is the browser's rule, applied here — the chapter's own measurements stop at a laptop browser, and no handset has run this shape.

### Negative

- **Someone else's software is now in the trust path.** A proxy misconfiguration can publish a ledger to the LAN, and a forward-auth bug can publish it to the internet. The docs have to name that as the risk it is instead of describing the setup as a convenience, and the example must fail closed: bind to the LAN address, never to `0.0.0.0` with no auth.
- **Two people means two of everything:** two pairs of containers, two memory footprints, two backup routines, two places to look when something is wrong. Measured on 2026-11-04, an extra tenant costs about **205 MiB idle** — roughly 195 MiB of it is the streamed desktop container and 10 MiB the Pocket one, with the proxy holding 19-20 MiB for any tenant count — on `linux/arm64`, with no user logged in. So the phone-only shape is cheap per person and the desktop shape is not; and because the `amd64` images have never run, that number describes this machine, not every one.
- **A private certificate is a real chore.** Phones and laptops have to trust the CA, which means a name that resolves on the LAN plus installing our own root on each device — and no shortcut there is honest.
- Passkeys at the edge, which is the shape most people would want, are **still unproven for this product**: WebAuthn needs a registrable domain as the `rpId`, and `127.0.0.1` is not one. Nothing in this record promises them.

### Neutral

- No schema change, no new table, no `SCHEMA_VERSION` bump. The `users` row stays a placeholder, and the code that scopes reads to it stays because it is harmless and because removing it would touch every repository function for no gain.
- The images do not change. This is composed at the edge: `docker-compose.yml` now holds the example — the `edge` profile, Caddy, and one templated tenant with its own volume — and `docs/DEPLOYMENT.md` owns the instructions. `pocket-ann` and `desktop-ann` build from the same `docker/pocket.Dockerfile` and `docker/desktop.Dockerfile` as the default services, and the only new file is `docker/edge.Caddyfile`.
- `.github/workflows/docker.yml` still has never run, and publishing images remains a separate approval from shipping a release.

## Alternatives considered

### A login inside the app, with all tenants in one database

Rejected. It means a password hash we are responsible for, a session that must be bound to a user on each of the forty-seven handlers in `src/main/ipc.ts`, and row-level authorization as the only thing between two people's finances. It also cannot work for the desktop container, which is one Electron process with one cursor: the multi-tenant server would be a second application, and [ADR 0001](0001-local-first-desktop.md) already declined to build one.

### One container, one volume, per-user subfolders chosen by a header

Rejected. A routing value that selects someone's entire financial history is a single point of failure with no audit trail: a wrong header, a stale cookie, or a proxy rule edit silently shows another person's ledger and lets you type into it. A process boundary and a mount cannot be misconfigured into that.

### Basic auth compiled into the Pocket nginx image

Rejected. It would make WageRoute the author of an authentication implementation and a password-file format, and would still not answer TOTP, passkeys, or an existing identity provider. The proxy does this better, and the operator already runs one.

### mTLS with client certificates as the door

Rejected as the primary answer, kept as a valid extra: installing a client certificate on a phone is a project of its own, and the person who cannot do it has no way to reach their money.

### Per-tenant keys inside one shared database

Rejected. It is the same row-level-security problem with a cipher pasted on top, and ADR 0029 already gives each tenant's own file its own key — which is the isolation that survives a bug in our SQL.

### "Two users on one host" solved by just syncing the ledgers

Rejected, and out of this program. Sync needs an identity model, a transport and a conflict policy that [ADR 0004](0004-sync-ready-schema.md) explicitly deferred; carrying a backup by hand, or merging two copies by time ([ADR 0024](0024-two-copies-merge-by-time.md)), is the supported answer today.

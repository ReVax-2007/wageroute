# 0001. Local-first desktop application, no backend

- **Status:** Accepted
- **Date:** 2026-10-27
- **Deciders:** Project owner
- **Supersedes:** none
- **Related:** [0004](0004-sync-ready-schema.md), [DEPLOYMENT.md](../DEPLOYMENT.md)

## Context

WageRoute is a personal zero-based budgeting tool. The data is a complete financial profile: accounts, institutions, balances, bills, paychecks and every transaction. The intended user is one person managing their own money, often on one laptop.

Several delivery models were possible:

- a hosted web application with a database and accounts;
- a mobile-first app (the Expo/React Native direction was considered and rejected);
- a desktop application with a local database;
- a local-first application that also syncs through a cloud service.

The project needed to ship a usable desktop tool without standing up infrastructure, handling bank credentials, or taking on the operational and legal burden of storing someone else's financial records. Offline use and instant interaction mattered more than multi-device access. The owner also explicitly rejected reframing the product as a web or Expo app.

## Decision

Build a **local-first desktop application** with Electron.

- The UI runs in a sandboxed Chromium renderer.
- A privileged main process owns the filesystem and SQLite.
- All data lives in one SQLite database under Electron's `userData` directory (`wageroute.db`).
- There is **no backend, no account system, no cloud storage, no telemetry and no network dependency**.
- Moving data between machines is a manual export/import operation.
- Distribution is a DMG (macOS) or NSIS installer (Windows), currently unsigned.

“Local-first” here means the local database is the only source of truth. It does **not** mean a sync engine exists. The schema contains sync-oriented fields as preparation; see [ADR 0004](0004-sync-ready-schema.md).

## Consequences

### Positive

- **Privacy by construction.** Ledger data does not leave the machine unless the user exports it. There is no server to breach and no third party to trust.
- **Offline and fast.** Every read is a local SQLite query; there is no request latency or availability dependency.
- **Simple operations.** No hosting, database migrations in production, TLS, auth provider, backups-as-a-service or on-call.
- **Clear failure modes.** If the app is broken, the data file is still on disk and can be copied or opened with `sqlite3`.
- **Small attack surface.** No inbound ports, no remote API, no session tokens.
- **Cheap to run.** No recurring infrastructure cost.

### Negative

- **No multi-device sync.** Two machines diverge. Users must export/import, and imports merge rather than reconcile (see [ADR 0003](0003-additive-imports.md)).
- **The user is the backup operator.** Nothing protects against a lost disk unless the user copies data off the machine.
- **Security depends on the OS.** No app-level encryption or login; FileVault/BitLocker and account hygiene are load-bearing.
- **Desktop only.** No phone access, no browser access, no sharing with a partner without exporting a file.
- **Distribution friction.** Two platforms, two installer formats, native modules, signing and notarization work.
- **Electron cost.** A large runtime, a native SQLite ABI per platform/architecture, and a Chromium security surface to keep current.

### Neutral

- The database path is platform-specific and visible in the UI.
- The app seeds a demo profile only in development builds; a packaged first launch seeds one blank user and offers start-from-scratch or import. That is a product decision, not an architecture requirement.
- Auto-update is absent, which is consistent with “no network” but adds manual upgrade work.

## Alternatives considered

### Hosted web application

Rejected. It would require a server, authentication, authorization, encrypted storage, backups, monitoring, incident response and a privacy policy appropriate to financial data. It also contradicts the preference for a desktop tool and adds latency to every interaction.

### Mobile-first app (Expo / React Native)

Rejected by the owner. The workflow — a wide spreadsheet grid, a multi-step allocator, side-by-side accounts — is desktop-shaped. A phone build would either lose functionality or require a separate design.

### Local-first with immediate cloud sync

Deferred, not adopted. Sync needs an identity model, a provider, a conflict policy, encryption decisions, a tombstone protocol and a sync-aware UI. None of that was agreed. Building it now would delay the core budgeting tool and lock in choices that are hard to reverse. The schema is prepared, but sync remains an explicit non-goal until a new ADR is accepted.

### PWA with local storage

Rejected. Browser storage is evictable, has no robust file-level backup story, and does not provide a trustworthy native filesystem path for a ledger. It also inherits the web framing the owner rejected.

## References

- [ARCHITECTURE.md](../ARCHITECTURE.md) — runtime topology and process responsibilities
- [DEPLOYMENT.md](../DEPLOYMENT.md) — what “deployment” means with no backend
- [SECURITY.md](../SECURITY.md) — trust boundaries and data-at-rest model
- [src/main/index.ts](../../src/main/index.ts) — window, sandbox and lifecycle setup
- [src/main/db/connection.ts](../../src/main/db/connection.ts) — database location and pragmas

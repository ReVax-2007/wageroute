# 0004. Prepare the schema for sync without implementing sync

- **Status:** Accepted as preparation only
- **Date:** 2026-10-27
- **Deciders:** Project owner
- **Supersedes:** none
- **Related:** [0001](0001-local-first-desktop.md), [0003](0003-additive-imports.md), [DATA-MODEL.md](../DATA-MODEL.md), [DEPLOYMENT.md](../DEPLOYMENT.md#sync-status)

## Context

WageRoute is local-first and single-user ([ADR 0001](0001-local-first-desktop.md)). Multi-device access was discussed but never agreed: no provider, identity model, transport, conflict policy, encryption decision or rollout plan exists.

At the same time, retrofitting identity and change-tracking into a live SQLite schema is expensive. Adding a UUID primary key later means rewriting every foreign key and every exported backup. Adding `updated_at` later means backfilling timestamps that were never recorded. Adding soft deletes later means losing the fact that a row was deleted rather than never created.

The schema was therefore designed once, with the fields a future sync layer would need, while explicitly **not** building that layer.

## Decision

Bake the following into schema v1 and keep them in later migrations:

- **UUIDv4 primary keys** generated on the device, so two offline devices cannot collide.
- **`user_id` on every tenant table**, foreign-keyed to `users`. Today it is filled with the single seeded local user. The migration comment anticipates it as a future tenant/RLS key.
- **`updated_at`** as an ISO-8601 UTC timestamp, intended as a pull cursor.
- **`revision`** as a monotonic integer incremented on update and soft delete, intended for last-write-wins comparison.
- **`deleted_at`** soft deletes, so a deletion is a tombstone that can replicate instead of a row that silently reappears on the next pull.
- **Sync indexes** `(user_id, updated_at)` on accounts, bills, goals and transactions, plus user/date indexes used by the UI.
- **No database-side timestamp defaults and no `AUTOINCREMENT`**, so identity and time are owned by the application and replays are deterministic.
- Backup exports include tombstones and sync metadata, so a file carries enough information to reconstruct state.

Explicitly **not** implemented:

- no sync client, server, provider SDK or network call;
- no `synced_at` column and no outbox table (the migration comment describes them as a future addition);
- no device identity, vector clock, operation log or CRDT;
- no authentication or authorization beyond the single local user;
- no conflict UI, merge policy or tombstone retention policy;
- no encryption decision for synced data.

The presence of these columns is **preparation, not a commitment to sync**. “Sync-ready” in this repository means “the identity and change-tracking primitives exist”; it does not mean a sync feature is planned, scheduled or safe to enable.

## Consequences

### Positive

- A future sync design does not have to rewrite primary keys or foreign keys.
- Soft deletes preserve the intent of a deletion, which is necessary for any replication protocol and useful for recovery today.
- `updated_at` and `revision` make change detection possible without a schema migration.
- Backups already carry stable IDs and metadata, so file-based transfer is coherent with a future sync model.
- The indexes needed for incremental pulls already exist.

### Negative

- **Extra columns and storage for a feature that may never ship.** Every row carries `user_id`, `updated_at`, `deleted_at` and `revision`.
- **Tombstones accumulate forever.** There is no purge, compaction or retention policy. Deleted rows remain in the database, in backups and in exports ([SECURITY.md](../SECURITY.md#data-at-rest)).
- **Every query must remember `deleted_at IS NULL`.** A forgotten filter shows deleted rows. This is a real source of bugs.
- **`revision` is not enforced as a conflict resolution mechanism.** It increments, but nothing compares revisions or rejects stale writes. There is no last-write-wins implementation.
- **Timestamps come from the device clock.** Clock skew, timezone mistakes and manual clock changes can make `updated_at` non-monotonic. It is a cursor only if a future sync layer accounts for that.
- **The schema can create a false impression.** A reader may assume sync exists because the fields do. The documentation must keep saying otherwise.
- **Single-user assumptions are baked in.** `user_id` is always the one local user; there is no user management, invitation, membership or role model.
- **Import preserves revisions and timestamps**, so a malicious or stale file can introduce old `updated_at` values that a future sync cursor would skip.

### Neutral

- `user_id` is currently redundant for isolation (there is one user), but it makes every repository query user-scoped by habit.
- The v2 migration rebuilt at least one table to add columns, demonstrating that even “prepared” schemas still migrate.
- A future sync design may decide these primitives are wrong (for example, preferring an operation log over row revisions). That would supersede this ADR, not silently change the columns.

## Alternatives considered

### Strip sync fields; add them when sync is built

Rejected. The migration cost is concentrated in the hardest place: primary keys and foreign keys. Backfilling identity for existing rows, rewriting references and reconciling backups is exactly the work this decision avoids.

### Implement sync now

Rejected. It would require decisions this project has not made:

- **Provider:** hosted service, self-hosted server, or file sync?
- **Identity:** local-only pseudonymous ID, email/password, OAuth, passkey?
- **Authorization:** row-level security, per-user encryption keys, or a single shared ledger?
- **Conflict policy:** last-write-wins by revision, field-level merge, or manual resolution?
- **Deletes:** tombstone retention, compaction, resurrection semantics?
- **Encryption:** transport only, at rest at the provider, or end-to-end?
- **Failure modes:** offline queue, retries, partial pulls, schema version skew?
- **Operations:** hosting, backups, monitoring, incident response, privacy policy.

Building any of these without agreement would lock in choices that are expensive to reverse and would contradict the local-first decision. Sync needs its own ADR and a security review.

### Hard deletes plus an audit log

Rejected for the current schema. Hard deletes are simpler for queries and privacy, but they cannot replicate a deletion; a future pull would resurrect the row. An audit log could compensate, but it is additional machinery, not a simplification, and it still needs retention rules.

### Integer auto-increment IDs

Rejected. They collide across devices and leak creation order. UUIDs are larger but portable and generated offline.

### CRDTs or an operation log from day one

Rejected as premature. They are a different data model with significant complexity, and the product has not established that multi-device editing is a requirement. Row-level metadata is a cheaper option that can later be supplemented or replaced.

## References

- [src/main/db/migrations.ts](../../src/main/db/migrations.ts) — schema comment, UUID keys, `user_id`, `updated_at`, `revision`, `deleted_at`, sync indexes
- [src/main/db/repositories.ts](../../src/main/db/repositories.ts) — revision increments, soft deletes, user-scoped queries
- [DATA-MODEL.md](../DATA-MODEL.md#sync-readiness) — per-table detail and the gaps a real sync layer must close
- [DEPLOYMENT.md](../DEPLOYMENT.md#sync-status) — what exists versus what has been discussed
- [ADR 0003](0003-additive-imports.md) — file-based merge semantics that a sync layer would eventually replace or complement

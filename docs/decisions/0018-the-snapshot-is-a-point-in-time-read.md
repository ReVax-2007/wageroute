# 0018. The snapshot is a point-in-time read

- **Status:** Accepted
- **Date:** 2026-10-31
- **Amended:** 2026-11-01 — the reads are now wrapped in one transaction (see *One read transaction*).
- **Deciders:** Project owner
- **Related:** [ADR 0002](0002-integer-cents.md), [ARCHITECTURE.md](../ARCHITECTURE.md), [DATA-MODEL.md](../DATA-MODEL.md)

## Context

The renderer never queries SQLite. It asks for a `Snapshot`: accounts with balances, goals with progress, bills, settings, balances over time and a capped list of the newest transactions. Every screen derives its totals from that one object, and the selectors assume the pieces agree with each other. The grid and the transaction query are the exception — they page the ledger in SQL.

The audit found two problems in the read model: the snapshot's separate statements were not wrapped in a read transaction, and the 500-row `transactions` list can be mistaken for the whole ledger. It also asked for the caps and the boot-time integrity policy to be stated rather than discovered.

## Decision

### One read transaction

- `snapshot:get` runs every read in one `db.transaction`. `getSnapshot` wraps the full set; `readSnapshotParts` (the patch a write returns) wraps the subset it re-reads. A save landing between statements can no longer hand the UI figures from two different states of the ledger, and that holds even if a second thread or a worker is introduced later.
- With one writer on the main thread the wrapper is belt and braces; it is now the contract rather than an invariant the next author has to remember.
- Every write is a SQLite transaction that ends before the IPC call returns. The renderer only sees a snapshot taken after the write committed.

### Caps are UI caps, not ledger limits

- The `transactions` list in the snapshot is capped at 500 rows and carries `transactionTotal`. The dashboard and the small recent-activity view use it.
- The ledger screen does not use the cap. It calls `transaction:query`, which pages, sorts and filters in SQL, so every row is reachable.
- JSON backup and CSV export read every row through dedicated queries. An export that silently stopped at 500 would be a data-loss bug, so it never reads the capped list.
- Aggregate figures (Safe to Spend, total wealth, the wall) are computed from the full account and bill sets, not from the capped list.

### Boot integrity is part of the read contract

- Before any read, `PRAGMA quick_check` runs on the opened database. A failure closes the file and refuses to start with a `DatabaseCorruptError` naming the path; the app never writes a migration into a damaged file.
- A forward schema version is refused before migration, leaving the file untouched. A pre-upgrade `VACUUM INTO` copy (newest three kept) is taken before every migration that will rewrite the file.
- The database runs WAL with `synchronous = NORMAL`, `foreign_keys = ON` and a 5-second busy timeout.

## Consequences

### Positive

- The renderer's arithmetic has one input, and the selectors can assume its parts belong to the same moment.
- A large ledger browses without loading every row into memory, while the export remains complete.
- Corruption is detected before it can be compounded by a migration, and the pre-upgrade copy is the way back when a migration goes wrong.

### Negative

- **The snapshot must be re-read after every write.** Screens do that through the store; a screen that caches a snapshot across writes shows stale totals.
- The 500-row cap is a second number to keep honest. The UI says "newest 500" where it uses the cap and never presents it as the ledger.
- The transaction wrapper makes each read one statement from the ledger's point of view, so a long-running read now holds the write lock behind it for its duration. The reads are small and indexed; a query slow enough to matter would need the paging path instead.

### Neutral

- No schema change. The caps were already what the code did; the transaction wrapper was added on 2026-11-01 in `getSnapshot` and `readSnapshotParts`.
- `databaseBytes` and row counts are exposed in Settings → Diagnostics, so a bug report can say how large the ledger actually is.

## Alternatives considered

### Query per screen instead of one snapshot

Rejected: the renderer would need SQL, the IPC surface would grow per screen, and every screen would have to re-establish the same consistency it currently inherits.

### Keep the whole ledger in the snapshot

Rejected: it makes startup time and memory proportional to history, and it still cannot page or sort in SQL.

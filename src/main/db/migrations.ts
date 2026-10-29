import type Database from 'better-sqlite3'

/**
 * Sync-readiness rules baked into this schema:
 *
 *  - Every primary key is a UUIDv4 generated on-device, so two devices can
 *    create rows offline without colliding.
 *  - Every row carries user_id (future Supabase RLS tenant key), updated_at
 *    (ISO-8601 UTC, used as the pull cursor) and revision (monotonic, used for
 *    last-write-wins conflict resolution).
 *  - Deletes are soft (deleted_at) so a tombstone can be replicated instead of
 *    silently resurrecting a row on the next pull.
 *  - Money is always INTEGER cents. No floats, no currency-mixed columns.
 *  - No AUTOINCREMENT and no DB-side defaults for timestamps: the app owns
 *    identity and time, which keeps replays deterministic.
 *
 * A future sync layer adds, per table: synced_at, and an outbox table fed by
 * triggers on insert/update/delete. Nothing below has to change for that.
 */
const SCHEMA_V1 = `
CREATE TABLE users (
  id            TEXT PRIMARY KEY NOT NULL,
  email         TEXT,
  display_name  TEXT NOT NULL,
  currency      TEXT NOT NULL DEFAULT 'USD',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  deleted_at    TEXT,
  revision      INTEGER NOT NULL DEFAULT 1
) STRICT;

CREATE TABLE settings (
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key         TEXT NOT NULL,
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (user_id, key)
) STRICT;

CREATE TABLE accounts (
  id                     TEXT PRIMARY KEY NOT NULL,
  user_id                TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name                   TEXT NOT NULL,
  kind                   TEXT NOT NULL CHECK (kind IN ('checking','savings','cash','investment','credit')),
  institution            TEXT,
  starting_balance_cents INTEGER NOT NULL DEFAULT 0,
  is_archived            INTEGER NOT NULL DEFAULT 0 CHECK (is_archived IN (0,1)),
  sort_order             INTEGER NOT NULL DEFAULT 0,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL,
  deleted_at             TEXT,
  revision               INTEGER NOT NULL DEFAULT 1
) STRICT;

CREATE TABLE bills (
  id            TEXT PRIMARY KEY NOT NULL,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  amount_cents  INTEGER NOT NULL CHECK (amount_cents > 0),
  frequency     TEXT NOT NULL CHECK (frequency IN ('weekly','biweekly','semimonthly','monthly','quarterly','annual')),
  due_day       INTEGER NOT NULL CHECK (due_day BETWEEN 1 AND 31),
  category      TEXT NOT NULL DEFAULT 'Bills',
  account_id    TEXT REFERENCES accounts(id),
  autopay       INTEGER NOT NULL DEFAULT 0 CHECK (autopay IN (0,1)),
  is_active     INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  next_due_on   TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  deleted_at    TEXT,
  revision      INTEGER NOT NULL DEFAULT 1
) STRICT;

CREATE TABLE goals (
  id            TEXT PRIMARY KEY NOT NULL,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  target_cents  INTEGER NOT NULL CHECK (target_cents > 0),
  target_date   TEXT,
  priority      INTEGER NOT NULL DEFAULT 100,
  color         TEXT NOT NULL DEFAULT '#34D399',
  account_id    TEXT REFERENCES accounts(id),
  is_archived   INTEGER NOT NULL DEFAULT 0 CHECK (is_archived IN (0,1)),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  deleted_at    TEXT,
  revision      INTEGER NOT NULL DEFAULT 1
) STRICT;

CREATE TABLE paychecks (
  id                  TEXT PRIMARY KEY NOT NULL,
  user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_cents        INTEGER NOT NULL CHECK (amount_cents > 0),
  received_on         TEXT NOT NULL,
  source              TEXT NOT NULL DEFAULT 'Paycheck',
  deposit_account_id  TEXT REFERENCES accounts(id),
  priority_cents      INTEGER NOT NULL DEFAULT 0,
  surplus_cents       INTEGER NOT NULL DEFAULT 0,
  leisure_cents       INTEGER NOT NULL DEFAULT 0,
  health              TEXT NOT NULL CHECK (health IN ('covered','tight','shortfall')),
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  deleted_at          TEXT,
  revision            INTEGER NOT NULL DEFAULT 1
) STRICT;

CREATE TABLE allocations (
  id           TEXT PRIMARY KEY NOT NULL,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  paycheck_id  TEXT NOT NULL REFERENCES paychecks(id) ON DELETE CASCADE,
  bucket       TEXT NOT NULL CHECK (bucket IN ('priority','savings','investment','goal','leisure')),
  goal_id      TEXT REFERENCES goals(id),
  label        TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  deleted_at   TEXT,
  revision     INTEGER NOT NULL DEFAULT 1
) STRICT;

CREATE TABLE transactions (
  id                  TEXT PRIMARY KEY NOT NULL,
  user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id          TEXT NOT NULL REFERENCES accounts(id),
  kind                TEXT NOT NULL CHECK (kind IN ('income','expense','bill_payment','transfer','goal_funding','investment','adjustment')),
  amount_cents        INTEGER NOT NULL,
  occurred_on         TEXT NOT NULL,
  memo                TEXT NOT NULL DEFAULT '',
  category            TEXT NOT NULL DEFAULT 'Uncategorized',
  bill_id             TEXT REFERENCES bills(id),
  goal_id             TEXT REFERENCES goals(id),
  paycheck_id         TEXT REFERENCES paychecks(id),
  counter_account_id  TEXT REFERENCES accounts(id),
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  deleted_at          TEXT,
  revision            INTEGER NOT NULL DEFAULT 1
) STRICT;

CREATE INDEX idx_accounts_sync ON accounts(user_id, updated_at);
CREATE INDEX idx_bills_sync ON bills(user_id, updated_at);
CREATE INDEX idx_goals_sync ON goals(user_id, updated_at);
CREATE INDEX idx_paychecks_user ON paychecks(user_id, received_on DESC);
CREATE INDEX idx_allocations_paycheck ON allocations(paycheck_id);
CREATE INDEX idx_allocations_goal ON allocations(goal_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_transactions_sync ON transactions(user_id, updated_at);
CREATE INDEX idx_transactions_account ON transactions(account_id, occurred_on DESC) WHERE deleted_at IS NULL;
CREATE INDEX idx_transactions_user_date ON transactions(user_id, occurred_on DESC) WHERE deleted_at IS NULL;
`

interface Migration {
  version: number
  /** Rebuilds a table that other tables reference, so enforcement is suspended. */
  rebuildsReferencedTable?: boolean
  up: (db: Database.Database) => void
}

/**
 * v2 adds the debt routing bucket. SQLite cannot alter a CHECK constraint, so
 * the allocations table is rebuilt in place. Nothing references allocations,
 * which makes the drop-and-rename safe with foreign keys enabled.
 */
const SCHEMA_V2 = `
CREATE TABLE allocations_v2 (
  id           TEXT PRIMARY KEY NOT NULL,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  paycheck_id  TEXT NOT NULL REFERENCES paychecks(id) ON DELETE CASCADE,
  bucket       TEXT NOT NULL CHECK (bucket IN ('priority','savings','investment','goal','debt','leisure')),
  goal_id      TEXT REFERENCES goals(id),
  label        TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  deleted_at   TEXT,
  revision     INTEGER NOT NULL DEFAULT 1
) STRICT;

INSERT INTO allocations_v2
  (id, user_id, paycheck_id, bucket, goal_id, label, amount_cents,
   created_at, updated_at, deleted_at, revision)
SELECT id, user_id, paycheck_id, bucket, goal_id, label, amount_cents,
       created_at, updated_at, deleted_at, revision
FROM allocations;

DROP TABLE allocations;

ALTER TABLE allocations_v2 RENAME TO allocations;

CREATE INDEX idx_allocations_paycheck ON allocations(paycheck_id);
CREATE INDEX idx_allocations_goal ON allocations(goal_id) WHERE deleted_at IS NULL;
`

/**
 * v3 is additive: credit limits, the emergency-fund flag, and the transfer
 * group that pairs both legs of an account-to-account move.
 */
const SCHEMA_V3 = `
ALTER TABLE accounts ADD COLUMN credit_limit_cents INTEGER
  CHECK (credit_limit_cents IS NULL OR credit_limit_cents >= 0);

ALTER TABLE goals ADD COLUMN is_emergency INTEGER NOT NULL DEFAULT 0
  CHECK (is_emergency IN (0,1));

ALTER TABLE transactions ADD COLUMN transfer_group_id TEXT;

CREATE INDEX idx_transactions_transfer_group ON transactions(transfer_group_id)
  WHERE transfer_group_id IS NOT NULL;

UPDATE goals SET is_emergency = 1 WHERE lower(name) = 'emergency fund';
`

/**
 * v4 makes an account's purpose explicit: a savings account can be dedicated to
 * one goal (its balance then *is* that goal's progress), and any account can be
 * opted out of the Safe-to-spend figure.
 *
 * `dedicated_goal_id` deliberately carries no FOREIGN KEY clause. goals already
 * references accounts, so a declared key here would make the two tables cyclic
 * and no static insert order could restore a backup containing both. It is
 * validated in the repository layer on write and ignored when dangling on read,
 * exactly like v3's transfer_group_id.
 */
const SCHEMA_V4 = `
ALTER TABLE accounts ADD COLUMN dedicated_goal_id TEXT;

CREATE INDEX idx_accounts_dedicated_goal ON accounts(dedicated_goal_id)
  WHERE dedicated_goal_id IS NOT NULL;

ALTER TABLE accounts ADD COLUMN in_safe_to_spend INTEGER
  CHECK (in_safe_to_spend IS NULL OR in_safe_to_spend IN (0,1));
`

/**
 * v5 adds bill funding strategies and account color customization:
 *  - bills.funding_strategy ('all_checks', 'closest_due_date', 'specific_check', 'first_check')
 *  - bills.funding_paycheck_index (1, 2, 3, etc.)
 *  - accounts.color (hex code string)
 */
const SCHEMA_V5 = `
ALTER TABLE bills ADD COLUMN funding_strategy TEXT NOT NULL DEFAULT 'all_checks'
  CHECK (funding_strategy IN ('all_checks','closest_due_date','specific_check','first_check'));

ALTER TABLE bills ADD COLUMN funding_paycheck_index INTEGER;

ALTER TABLE accounts ADD COLUMN color TEXT;
`

/**
 * v6 adds the fifth funding strategy, `last_check`. It is not additive: the
 * allowed values live in a CHECK constraint, and SQLite cannot alter one, so
 * the table is rebuilt.
 *
 * `transactions.bill_id` references `bills`, which makes this the documented
 * twelve-step procedure rather than a plain drop-and-rename: enforcement is
 * suspended in {@link migrate}, and `legacy_alter_table` is switched on so the
 * rename leaves the REFERENCES clause in `transactions` alone. Without it the
 * rename rewrites that clause to point at `bills_v5_old` — even with foreign
 * keys disabled — and dropping the old table then breaks the ledger. Rows are
 * copied under the same ids and `PRAGMA foreign_key_check` runs before commit,
 * so a dangling reference aborts the upgrade instead of being written.
 */
const SCHEMA_V6 = `
ALTER TABLE bills RENAME TO bills_v5_old;

CREATE TABLE bills (
  id                     TEXT PRIMARY KEY NOT NULL,
  user_id                TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name                   TEXT NOT NULL,
  amount_cents           INTEGER NOT NULL CHECK (amount_cents > 0),
  frequency              TEXT NOT NULL CHECK (frequency IN ('weekly','biweekly','semimonthly','monthly','quarterly','annual')),
  due_day                INTEGER NOT NULL CHECK (due_day BETWEEN 1 AND 31),
  category               TEXT NOT NULL DEFAULT 'Bills',
  account_id             TEXT REFERENCES accounts(id),
  autopay                INTEGER NOT NULL DEFAULT 0 CHECK (autopay IN (0,1)),
  is_active              INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  next_due_on            TEXT,
  funding_strategy       TEXT NOT NULL DEFAULT 'all_checks'
                           CHECK (funding_strategy IN ('all_checks','closest_due_date','specific_check','first_check','last_check')),
  funding_paycheck_index INTEGER,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL,
  deleted_at             TEXT,
  revision               INTEGER NOT NULL DEFAULT 1
) STRICT;

INSERT INTO bills
  (id, user_id, name, amount_cents, frequency, due_day, category, account_id,
   autopay, is_active, next_due_on, funding_strategy, funding_paycheck_index,
   created_at, updated_at, deleted_at, revision)
SELECT id, user_id, name, amount_cents, frequency, due_day, category, account_id,
       autopay, is_active, next_due_on, funding_strategy, funding_paycheck_index,
       created_at, updated_at, deleted_at, revision
FROM bills_v5_old;

DROP TABLE bills_v5_old;

CREATE INDEX idx_bills_sync ON bills(user_id, updated_at);
`

/**
 * v7 links a round-up sweep to the purchase that caused it, makes the ledger's
 * hot sort an index instead of a temp B-tree, and clears settings rows that no
 * build reads any more.
 *
 * `round_up_source_id` is the id of the expense (not its transfer group), so
 * editing or deleting that expense can find and rewrite or remove the sweep in
 * the same transaction. It deliberately carries no FOREIGN KEY clause for the
 * same reason as `transfer_group_id`: both legs point at a row that is
 * soft-deleted with them, and a hard constraint would only make restore order
 * matter.
 *
 * The index replaces the v1 partial index. The snapshot query filters
 * `user_id = ?` and `deleted_at IS NULL` and sorts by `occurred_on DESC,
 * created_at DESC`; with `deleted_at` as the second key column SQLite can use
 * the index for the equality and the whole ORDER BY, so the temp B-tree
 * disappears.
 *
 * `bill_reserves` is the wall's lifecycle: one row per bill per calendar month
 * saying the money was carried by a cheque (`reserved`) and whether a matching
 * bill payment later cleared it (`paid`). It replaces the old behaviour where
 * every cheque re-reserved every bill and no payment ever released anything.
 */
const SCHEMA_V7 = `
ALTER TABLE transactions ADD COLUMN round_up_source_id TEXT;

CREATE INDEX idx_transactions_round_up_source ON transactions(round_up_source_id)
  WHERE round_up_source_id IS NOT NULL;

DROP INDEX idx_transactions_user_date;

CREATE INDEX idx_transactions_user_date
  ON transactions(user_id, deleted_at, occurred_on DESC, created_at DESC);

CREATE TABLE bill_reserves (
  id            TEXT PRIMARY KEY NOT NULL,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bill_id       TEXT NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  paycheck_id   TEXT NOT NULL REFERENCES paychecks(id) ON DELETE CASCADE,
  cycle         TEXT NOT NULL CHECK (length(cycle) = 7),
  amount_cents  INTEGER NOT NULL CHECK (amount_cents >= 0),
  state         TEXT NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved','paid')),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  deleted_at    TEXT,
  revision      INTEGER NOT NULL DEFAULT 1
) STRICT;

CREATE INDEX idx_bill_reserves_cycle
  ON bill_reserves(user_id, bill_id, cycle) WHERE deleted_at IS NULL;
CREATE INDEX idx_bill_reserves_paycheck ON bill_reserves(paycheck_id);

DELETE FROM settings
 WHERE key IN ('emergencyAccountIds', 'insurance_floor_cents', 'round_up_enabled');
`

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    up: (db) => {
      db.exec(SCHEMA_V1)
    }
  },
  {
    version: 2,
    up: (db) => {
      db.exec(SCHEMA_V2)
    }
  },
  {
    version: 3,
    up: (db) => {
      db.exec(SCHEMA_V3)
    }
  },
  {
    version: 4,
    up: (db) => {
      db.exec(SCHEMA_V4)
    }
  },
  {
    version: 5,
    up: (db) => {
      db.exec(SCHEMA_V5)
    }
  },
  {
    version: 6,
    rebuildsReferencedTable: true,
    up: (db) => {
      db.exec(SCHEMA_V6)
    }
  },
  {
    version: 7,
    up: (db) => {
      db.exec(SCHEMA_V7)
    }
  }
]

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version

export class SchemaTooNewError extends Error {
  readonly code = 'SCHEMA_TOO_NEW'

  constructor(readonly found: number, readonly supported: number) {
    super(
      `This database was created by a newer WageRoute (schema ${found}); ` +
        `this build understands schema ${supported}.`
    )
    this.name = 'SchemaTooNewError'
  }
}

export function migrate(db: Database.Database): void {
  const current = db.pragma('user_version', { simple: true }) as number
  // A forward-only migration cannot read a schema it has never seen. Refusing
  // here keeps the file untouched instead of letting queries fail one toast at
  // a time — and stops a write from landing on a schema this build misreads.
  if (current > SCHEMA_VERSION) throw new SchemaTooNewError(current, SCHEMA_VERSION)
  const hadForeignKeys = (db.pragma('foreign_keys', { simple: true }) as number) === 1

  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue
    const suspend = migration.rebuildsReferencedTable === true
    if (suspend) {
      db.pragma('foreign_keys = OFF')
      db.pragma('legacy_alter_table = ON')
    }
    try {
      db.transaction(() => {
        migration.up(db)
        if (suspend) {
          const violations = db.pragma('foreign_key_check') as unknown[]
          if (violations.length > 0) {
            throw new Error(
              `Migration ${migration.version} left ${violations.length} dangling foreign key(s)`
            )
          }
        }
        db.pragma(`user_version = ${migration.version}`)
      })()
    } finally {
      if (suspend) {
        db.pragma('legacy_alter_table = OFF')
        if (hadForeignKeys) db.pragma('foreign_keys = ON')
      }
    }
  }
}

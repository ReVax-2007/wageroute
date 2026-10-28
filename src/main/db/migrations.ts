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

const MIGRATIONS: readonly Migration[] = [
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
  }
]

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version

export function migrate(db: Database.Database): void {
  const current = db.pragma('user_version', { simple: true }) as number

  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue
    db.transaction(() => {
      migration.up(db)
      db.pragma(`user_version = ${migration.version}`)
    })()
  }
}

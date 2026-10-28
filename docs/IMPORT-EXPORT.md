# Import and export

WageRoute has one data-movement principle: **imports add, they never restore over what is already there.** A JSON backup can be complete or partial, and a CSV file can be a full export or a handful of rows from a bank. Existing rows and existing settings always win.

This document specifies both file formats, the merge rules, deduplication, validation, error reporting and the exact behaviour the UI exposes.

Source: [`src/main/db/backup.ts`](../src/main/db/backup.ts), [`src/main/db/entries.ts`](../src/main/db/entries.ts), [`src/shared/csv.ts`](../src/shared/csv.ts), [`src/main/ipc.ts`](../src/main/ipc.ts).

---

## Contents

- [Entry points](#entry-points)
- [JSON backup format](#json-backup-format)
- [JSON merge semantics](#json-merge-semantics)
- [JSON validation and errors](#json-validation-and-errors)
- [CSV export](#csv-export)
- [CSV import grammar](#csv-import-grammar)
- [CSV account matching](#csv-account-matching)
- [CSV duplicates](#csv-duplicates)
- [CSV insert semantics](#csv-insert-semantics)
- [Worked examples](#worked-examples)
- [UI messages](#ui-messages)
- [Limits and cautions](#limits-and-cautions)

---

## Entry points

All three operations live in **Settings → Data**.

| Action | API method | Dialog | Default name |
| --- | --- | --- | --- |
| Export full backup | `exportBackup()` | Save JSON | `~/Documents/wageroute-backup-YYYY-MM-DD.json` |
| Export transactions CSV | `exportTransactionsCsv()` | Save CSV | `~/Documents/wageroute-transactions-YYYY-MM-DD.csv` |
| Import data | `importData()` | Open JSON or CSV | — |

Import first shows a confirmation:

> Import this file? Everything already in this app stays exactly as it is — the import only adds what is missing.

The file picker accepts `.json` and `.csv`. The branch is chosen by the file extension, case-insensitively. A file larger than **64 MiB** is rejected before parsing.

Cancelling any dialog returns `null` and shows no toast.

---

## JSON backup format

A backup is a single JSON object:

```json
{
  "format": "cash-flow-routing-backup",
  "version": 3,
  "exportedAt": "2026-10-27T18:22:04.871Z",
  "tables": {
    "accounts": [],
    "bills": [],
    "goals": [],
    "paychecks": [],
    "allocations": [],
    "transactions": [],
    "settings": []
  }
}
```

### Top-level fields

| Field | Required | Rule |
| --- | --- | --- |
| `format` | Yes | Must equal `cash-flow-routing-backup` |
| `version` | Yes | Integer, 2 or 3, not greater than the current schema version |
| `exportedAt` | No | String; defaults to `""` when absent |
| `tables` | Yes | Object containing table arrays |

The `format` identifier still uses the pre-rename name so backups made before the WageRoute rename remain importable. Do not change it without a versioned migration path.

### Tables and columns

Seven tables are exported and accepted. Each row carries the full column set below. Unknown columns are ignored; known columns that are absent receive a fallback or `null`.

| Table | Accepted columns |
| --- | --- |
| `accounts` | `id`, `user_id`, `name`, `kind`, `institution`, `starting_balance_cents`, `credit_limit_cents`, `is_archived`, `sort_order`, `created_at`, `updated_at`, `deleted_at`, `revision` |
| `bills` | `id`, `user_id`, `name`, `amount_cents`, `frequency`, `due_day`, `category`, `account_id`, `autopay`, `is_active`, `next_due_on`, `created_at`, `updated_at`, `deleted_at`, `revision` |
| `goals` | `id`, `user_id`, `name`, `target_cents`, `target_date`, `priority`, `color`, `account_id`, `is_emergency`, `is_archived`, `created_at`, `updated_at`, `deleted_at`, `revision` |
| `paychecks` | `id`, `user_id`, `amount_cents`, `received_on`, `source`, `deposit_account_id`, `priority_cents`, `surplus_cents`, `leisure_cents`, `health`, `created_at`, `updated_at`, `deleted_at`, `revision` |
| `allocations` | `id`, `user_id`, `paycheck_id`, `bucket`, `goal_id`, `label`, `amount_cents`, `created_at`, `updated_at`, `deleted_at`, `revision` |
| `transactions` | `id`, `user_id`, `account_id`, `kind`, `amount_cents`, `occurred_on`, `memo`, `category`, `bill_id`, `goal_id`, `paycheck_id`, `counter_account_id`, `transfer_group_id`, `created_at`, `updated_at`, `deleted_at`, `revision` |
| `settings` | `user_id`, `key`, `value`, `updated_at` |

These lists are internal allowlists. SQL column names never come from the file, and every value is bound as a parameter.

### What a full export contains

`buildBackup` runs `SELECT * FROM <table> WHERE user_id = ?` for every table. It therefore includes:

- soft-deleted rows (tombstones);
- all transactions, not just the 500 returned to the UI;
- all paychecks, not just the 24 returned to the UI;
- raw settings key/value pairs.

It does **not** include:

- the `users` row (display name, email and the legacy currency column);
- the theme cache in `localStorage`;
- the database file itself;
- any indexes, triggers or schema metadata beyond `version`.

Because the user row is absent, restoring a backup into a fresh database still relies on the seeded local user. Display name is not carried across devices.

### Partial tables

A file may omit any table. An absent table is treated as an empty list, not as “delete everything”. Unknown table names are ignored.

This allows hand-written or selectively exported files:

```json
{
  "format": "cash-flow-routing-backup",
  "version": 3,
  "tables": {
    "transactions": [
      {
        "id": "0f5b4f0a-3d7e-4f8c-9a51-2a9f0f7b0c11",
        "account_id": "5c4c1f6e-7a2b-4a8c-9d33-91e2f4a6b701",
        "kind": "expense",
        "amount_cents": -4215,
        "occurred_on": "2026-10-01",
        "memo": "Metro",
        "category": "Groceries"
      }
    ]
  }
}
```

Omitted metadata is filled as follows:

| Missing column | Fill |
| --- | --- |
| `created_at` | Import time |
| `updated_at` | Import time |
| `revision` | `1` |
| `credit_limit_cents` | `null` |
| `is_emergency` | `0` |
| `transfer_group_id` | `null` |
| Any other omitted column | `null` (or the database default, if the column has one) |

Omitted `memo`, `category`, `source`, `priority`, booleans and similar columns fall back to database defaults where defined. Omitted `name`, `amount_cents`, `kind`, `frequency`, `due_day`, `account_id`, `user_id` or `id` will generally fail a NOT NULL or CHECK constraint and roll back the entire import.

### Version compatibility

| File version | Result |
| --- | --- |
| `< 2` | Rejected: “Backups older than schema 2 are not supported” |
| `2` | Accepted; missing v3 columns receive fallbacks |
| `3` | Accepted |
| `> 3` | Rejected: “This backup came from a newer version (schema N)” |
| Non-integer | Rejected: “Backup has no version number” |

---

## JSON merge semantics

`mergeBackup` runs inside one SQLite transaction. Either every eligible row is added, or nothing is.

Tables are processed in foreign-key order:

```text
accounts → bills → goals → paychecks → allocations → transactions → settings
```

### Row identity

- For all financial tables, the primary key is `id`.
- If a row with the same `id` **and the local `user_id`** already exists, the row is counted as **skipped**.
- Otherwise it is inserted, preserving its imported UUID.
- `user_id` from the file is ignored and replaced with the local user ID.

Preserving IDs is what keeps cross-table links intact: an imported transaction can point at an imported account, bill, goal or paycheck.

### Existing rows are never updated

There is no upsert for financial rows. A row with the same ID is skipped even if its contents differ. This is why imports are additive rather than a restore: editing a local row and then importing an older backup will not overwrite the edit.

### Settings

Settings use `INSERT OR IGNORE` against `PRIMARY KEY (user_id, key)`:

- missing keys are added;
- existing keys are skipped, so local preferences always win;
- an empty or non-string key fails the import;
- a missing `value` becomes an empty string;
- a missing `updated_at` becomes import time.

Importing a backup never changes your existing currency, theme, splits, round-up or emergency settings.

### Duplicate names are not merged

Identity is the UUID, not the name. Importing a full backup from a different installation will add a second account called “Everyday Checking” with a different UUID, not merge it into the local one. The same is true for goals, bills and paychecks.

This is deliberate: automatically merging by name would risk attaching transactions to the wrong account. If you want to combine installations, import into an empty database or accept that duplicate-named rows will appear and clean up manually.

### Tombstones

Because full exports include `deleted_at` rows, an import can add a tombstone for a row that does not exist locally. It will not appear in the UI, but its ID is now taken. Re-importing a backup taken before a local delete will not resurrect the row: the local tombstone has the same ID and is skipped.

### Foreign keys and partial files

Foreign keys are enforced. A partial import must either:

- include the rows it references, in an order the merge can satisfy (the fixed table order handles this), or
- reference rows that already exist locally with the same IDs, or
- omit the reference so it becomes `null`.

A transaction with an explicit `bill_id`, `goal_id`, `account_id` or `paycheck_id` that does not exist locally or earlier in the same file will fail the whole import. This is the most common cause of a partial backup being rejected.

---

## JSON validation and errors

| Condition | Message |
| --- | --- |
| File is not parseable JSON | “That file is not valid JSON” |
| Top level is not an object | “Backup file has no data” |
| Wrong format marker | “That is not a WageRoute backup” |
| Missing or non-integer version | “Backup has no version number” |
| Newer schema | “This backup came from a newer version (schema N)” |
| Older than schema 2 | “Backups older than schema 2 are not supported” |
| Missing `tables` object | “Backup has no tables” |
| A table is not an array | “The `<table>` table is not a list” |
| More than 200,000 rows in a table | “Backup `<table>` table is too large” |
| A row is not an object | “Backup has a malformed row in `<table>`” |
| A row has no `id` | “Backup has a `<table>` row without an id” |
| A settings row has no key | “Backup has a settings row without a key” |
| A value is an array/object | “Backup has an unsupported value for `<column>`” |
| A database constraint fails | SQLite's error message, with the whole import rolled back |

Values may be strings, numbers, booleans or `null`. Booleans are converted to 0/1. Numbers are passed through as-is; SQLite `STRICT` will reject a non-integer in an INTEGER column.

The import result contains `added` and `skipped` counts per table. Issues are only used by the CSV path; a JSON import that succeeds returns an empty `issues` array.

---

## CSV export

### Columns

```csv
Date,Account,Institution,Kind,Category,Description,Amount,Currency
```

- `Date` is `YYYY-MM-DD`.
- `Account` is the account's display name.
- `Institution` is the account's institution or an empty string.
- `Kind` is the raw transaction kind (`income`, `expense`, `bill_payment`, `transfer`, `goal_funding`, `investment`, `adjustment`).
- `Category` and `Description` are free text.
- `Amount` is signed decimal dollars with exactly two decimals, no thousands separators and no currency symbol.
- `Currency` comes from the local **user record**, not from the settings key. In a default install both are `USD`; importing settings with a different currency changes display but not this column.

### Format details

- UTF-8, no BOM.
- CRLF (`\r\n`) line endings between rows.
- A cell is quoted when it contains a comma, a double quote, CR or LF.
- Double quotes inside a quoted cell are doubled (`""`).
- There is no trailing newline after the last row.

### Row scope

The exporter uses `snapshot.transactions`, which is capped at the **500 newest non-deleted transactions**. JSON backup is the only full-history export.

Rows are ordered by `occurred_on DESC, created_at DESC`.

---

## CSV import grammar

The CSV importer is designed for WageRoute exports and tolerant of common bank exports.

### Reading

- UTF-8 BOM is stripped.
- Quoted cells may contain commas, doubled quotes and newlines.
- Blank lines are skipped.
- Rows are arrays of raw strings.

### Header discovery

The importer scans the first **10 rows** for a header containing at least:

- a date column,
- an account column,
- an amount column.

This allows a bank preamble before the real header. If no such row is found:

> That CSV needs Date, Account and Amount columns

### Header aliases

Header matching is case-insensitive, trims whitespace and collapses repeated spaces.

| Canonical field | Accepted headers |
| --- | --- |
| Date | `date`, `occurred on`, `occurred_on`, `posted`, `posting date` |
| Account | `account`, `account name`, `account_name` |
| Institution | `institution`, `bank`, `financial institution` |
| Kind | `kind`, `type`, `transaction type` |
| Category | `category` |
| Description | `description`, `memo`, `note`, `notes`, `details` |
| Amount | `amount`, `value` |
| Currency | Ignored on import |

An unrecognised column is ignored.

### Dates

Accepted formats:

| Format | Example |
| --- | --- |
| ISO with optional single-digit month/day | `2026-10-01`, `2026-1-5` |
| US slash date | `10/02/2026`, `1/5/2026` |
| Year-first slash date | `2026/10/02` |

The date is validated against a real UTC calendar; `2026-02-31` is rejected. Unreadable dates produce an issue:

> row N has an unreadable date

### Amounts

Amounts use the same parser as the UI, so all of these work:

```text
42.50     -42.50     $1,234.56     (42.00)     USD 42.50
```

A missing, unreadable or zero amount produces:

> row N has no usable amount

### Kinds

The kind cell is lowercased and spaces or hyphens become underscores.

| Imported text | Stored kind |
| --- | --- |
| `income`, `deposit`, `credit` | `income` |
| `expense`, `debit`, `withdrawal`, `purchase`, `payment` | `expense` |
| `bill_payment`, `bill` | `bill_payment` |
| `transfer` | Rejected as an issue |
| `goal_funding`, `savings` | `goal_funding` |
| `investment` | `investment` |
| `adjustment` | `adjustment` |
| A valid raw kind | That kind |
| Anything else or blank | Inferred from the amount sign: positive → `income`, negative → `expense` |

Transfers cannot be imported from CSV because one CSV row cannot reconstruct both legs. The row is reported:

> row N is a transfer — import a JSON backup to keep both legs

Other rows in the same file still import.

### Row requirements

Each row must have:

- a readable date;
- a non-empty account name;
- a usable, non-zero amount;
- a kind that is not `transfer`.

Optional values default as follows:

| Field | Default |
| --- | --- |
| Category | `Uncategorized` |
| Description | empty string |
| Institution | `null` |

---

## CSV account matching

CSV rows do not carry account IDs, so the importer resolves each row to a local account:

1. Collect all non-deleted accounts.
2. Match account names case-insensitively after trimming.
3. If the row has an institution, and at least one name match has the same institution (case-insensitive, trimmed), narrow to those.
4. If no institution is supplied, or no name match has a matching institution, keep all name matches.

Outcomes:

| Candidates | Result |
| --- | --- |
| Exactly one | Row is queued for insert |
| Zero | Issue: ``no account named “X”`` |
| More than one | Issue: ``“X” matches more than one account`` |

Account names are not created automatically. Create or rename accounts before importing.

Archived accounts are still eligible for matching because the lookup does not filter `is_archived`. Soft-deleted accounts are excluded.

---

## CSV duplicates

Rows in a file may legitimately repeat: two identical coffees on the same day are two real entries. A simple “skip if a matching row exists” rule would lose the second one, while importing blindly would duplicate everything on a re-import.

The importer uses a per-fingerprint allowance:

```text
fingerprint = [accountId, kind, amountCents, occurredOn, memo, category]
```

For each distinct fingerprint in the file:

1. Count how many matching non-deleted rows already exist in the database for that fingerprint.
2. Process the file's rows in order.
3. For each occurrence, if the on-disk count is greater than zero, skip it and decrement the count.
4. Otherwise insert it.

Examples:

| Existing rows | File rows | Result |
| --- | --- | --- |
| 0 | 1 | 1 added |
| 0 | 2 identical | 2 added |
| 1 | 1 identical | 0 added, 1 skipped |
| 1 | 2 identical | 1 added, 1 skipped |
| 2 | 1 identical | 0 added, 1 skipped |

This makes re-importing the same file idempotent while preserving genuine duplicates within a single file.

The fingerprint ignores `bill_id`, `goal_id`, `paycheck_id`, `counter_account_id` and `transfer_group_id`, all of which are `null` on CSV-inserted rows.

Not considered duplicates: rows that differ in any fingerprinted field, including memo case, whitespace or category.

---

## CSV insert semantics

Queued rows are inserted in one SQLite transaction with:

- a new UUID;
- the local user ID;
- the resolved account ID;
- the parsed kind, amount, date, memo and category;
- `bill_id`, `goal_id`, `paycheck_id`, `counter_account_id` and `transfer_group_id` set to `NULL`;
- `created_at` and `updated_at` set to import time;
- `revision = 1`.

Because the insert bypasses `createTransaction`:

- **no round-up sweep is triggered**, even if round-up is enabled;
- no paired transfer is created;
- no bill or goal link is inferred;
- no validation beyond what parsing and the database constraints provide.

Rows are inserted even if they fall outside the UI's 500-row snapshot window; they will exist in SQLite but may not appear in the current ledger grid until older rows scroll out of the window.

---

## Worked examples

### 1. Full backup into a fresh database

- Every table is present.
- IDs are preserved, so links hold.
- Settings keys are inserted because none exist locally (apart from the seeded defaults; those keys already exist and are skipped).
- Result: all rows added, `skipped` counts zero except possibly settings keys that were seeded.

### 2. Full backup into the same database

- Every financial row has the same ID and is skipped.
- Every settings key already exists and is skipped.
- Result: `added` zero across the board; the UI reports “Nothing new — those records are already in your data”.

### 3. Partial settings file

```json
{
  "format": "cash-flow-routing-backup",
  "version": 3,
  "tables": {
    "settings": [
      { "key": "currency", "value": "CAD" },
      { "key": "theme", "value": "light" }
    ]
  }
}
```

If both keys already exist locally, both are skipped and the local values win. If a key is new, it is added and becomes visible after the snapshot refresh.

### 4. Partial transactions file

- Omit `bill_id`, `goal_id`, `paycheck_id`, `counter_account_id` and `transfer_group_id` to avoid foreign-key failures.
- Supply a valid existing `account_id`.
- The transactions are added with their IDs, so re-importing skips them.
- They appear in the ledger if they fall within the 500 newest rows.

### 5. Bank CSV with a preamble

```text
Account statement export
Generated 2026-10-27

Date,Description,Amount,Account
10/01/2026,Metro,-42.15,Everyday Checking
10/02/2026,Payroll,1500.00,Everyday Checking
```

The header is found at row 4. Both rows import as entries. The first becomes an expense (negative amount, unknown kind), the second an income.

### 6. Re-importing the same bank CSV

- The first file added two rows.
- The second run finds one existing row per fingerprint and skips both.
- Result: zero added, two skipped.

### 7. Two identical coffees in one file

- Two rows with the same account, kind, amount, date, memo and category.
- Zero matching rows exist.
- Both are inserted.
- A later re-import skips both.

---

## UI messages

After a JSON import:

- `Imported N new records` when rows were added;
- `… · N already present` when rows were skipped;
- `Nothing new — those records are already in your data` when nothing was added and nothing was skipped;
- `That file had nothing to import` when the file contained no rows.

After a CSV import, the noun changes to **entries** and ignored rows are included:

- `Imported N new entries · N already present · N rows ignored`;
- if nothing was added but rows were ignored:
  `Nothing imported — N rows ignored (<first issue message>)`.

JSON imports never report ignored rows; a malformed row aborts the import instead.

---

## Limits and cautions

| Limit | Value |
| --- | --- |
| Maximum import file size | 64 MiB |
| Maximum rows per JSON table | 200,000 |
| Snapshot/CSV export rows | 500 newest transactions |
| JSON date range | Any valid date; no limit |

Cautions:

- Backups contain your complete financial history in plain text. Store them somewhere you would store a bank statement.
- Imported JSON preserves IDs. Importing two installations into one database creates duplicate accounts and goals with the same names but different IDs.
- CSV import does not create missing accounts, link bills or goals, or reconstruct transfers.
- A failed JSON import leaves the database unchanged, including any rows that appeared to import before the failure.
- The import is not a restore. It will not delete local rows, reset settings, or roll back to an earlier state.

# Import and export

WageRoute has one data-movement principle: **imports add, they never restore over what is already there.** A JSON backup can be complete or partial, and a CSV file can be a full export or a handful of rows from a bank. Existing rows and existing settings always win.

The second principle is **a file is never rejected because of one bad row.** Anything the app cannot work out on its own is asked about in an import wizard, and anything you cannot answer is left out with an explanation while the rest of the file lands.

This document specifies both file formats, the wizard, the merge rules, deduplication, validation, error reporting and the exact behaviour the UI exposes.

Source: [`src/shared/importRepair.ts`](../src/shared/importRepair.ts), [`src/main/db/backup.ts`](../src/main/db/backup.ts), [`src/main/db/entries.ts`](../src/main/db/entries.ts), [`src/shared/csv.ts`](../src/shared/csv.ts), [`src/main/ipc.ts`](../src/main/ipc.ts), [`src/renderer/src/components/ImportWizard.tsx`](../src/renderer/src/components/ImportWizard.tsx).

---

## Contents

- [Entry points](#entry-points)
- [The import wizard](#the-import-wizard)
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

Import lives in **Settings → Data**; export lives beside it.

| Action | API method | Dialog | Default name |
| --- | --- | --- | --- |
| Export full backup | `exportBackup()` | Save JSON | `~/Documents/wageroute-backup-YYYY-MM-DD.json` |
| Export transactions CSV | `exportTransactionsCsv()` | Save CSV | `~/Documents/wageroute-transactions-YYYY-MM-DD.csv` |
| Import data | `previewImport()` then `confirmImport(token, answers)` | Open JSON or CSV, then the wizard | — |

The first-run dashboard offers **Start from scratch** or **Import a backup**; the second button opens the same wizard as Settings → Import data. There is no longer a single "pick a file and hope" import.

The file picker accepts `.json` and `.csv`. The branch is chosen by the file extension, case-insensitively. A file larger than **64 MiB** is rejected before parsing.

Cancelling the file picker returns `null` and opens nothing. Cancelling the wizard leaves the database untouched.

---

## The import wizard

### Why it exists

The ledger's columns are `NOT NULL`, `STRICT` and `CHECK`-constrained, while a hand-written or bank-supplied file is rarely complete. Before the wizard, one unusable value aborted the whole import with a raw SQLite message. Now the gaps are found before anything is written and put to you in plain language.

### Steps

1. **Choose file** — the picker in the main process. The renderer never sees or sends a path; it holds a token.
2. **Missing info** — one card per row that cannot import as it stands, with an editor per problem and a **Leave this row out** toggle.
3. **Review** — what will be imported, what you filled in (with the values), and what is being left out with why and how to fix the file.

Step 2 is skipped when nothing is missing, so a clean WageRoute backup is a one-click confirm.

### What the wizard asks about

Detection is pure shared code (`findImportProblems`), so the main process re-derives exactly the same questions when the answers come back.

| Category | Asked as | Editor |
| --- | --- | --- |
| A required column is empty (`name`, `amount_cents`, `kind`, `frequency`, `due_day`, `target_cents`, `received_on`, `occurred_on`, `label`, `bucket`, settings `key`) | "Account name is missing" | Text / amount / whole number, per column |
| An enum value outside the schema's `CHECK` list | "Account type is not valid (chekcing)" | Dropdown of the accepted values |
| A number outside its allowed range (`due_day` 1–31, amounts above zero) | "Day of month is not valid (45)" | Whole number with the range in the hint |
| A foreign key pointing at something that does not exist | "Posting account is not valid (acc-nope)" | Dropdown of local rows, plus **Leave unlinked** where the column is nullable |
| A value of the wrong JSON type (object, array, boolean in a text/date column) | "Pay date is not a plain value" | The column's own editor |
| A CSV account name with no matching local account | "no local account is named “COFFSHOC *BREW BAR”" | Dropdown of local accounts, one question per distinct name covering every line that shares it |

Columns that have a schema default — `sort_order`, `is_archived`, `category`, `memo`, `revision`, `priority` and friends — are **never** asked about; they are filled silently. See [partial tables](#partial-tables). The two v4 account columns are not in that list either, in the other direction: they have no default and are nullable, so an absent `dedicated_goal_id` or `in_safe_to_spend` simply arrives as `NULL`.

Rows without an `id` are not a question either: a UUID is minted at import time. Only rows that *other* rows in the same file point at need a real ID, which is why the wizard's reference check counts IDs the file creates itself (`withFileIds`).

### Fix or leave out

Each answer is `{ key, value, skip }`, keyed by `b:<table>:<rowIndex>:<column>` for backup rows and `e:<firstLine>` for CSV name groups.

- **Fill it in** — the answer is validated by the same rules as the file (`validateFieldValue`). A valid answer patches the row before the merge.
- **Leave it out** — the whole row is dropped from this import, and the review step lists it with every reason on it plus how to fix the source file.
- **Say nothing** — an unanswered question drops its row too. Nothing invalid ever reaches SQLite, so nothing can abort the rest of the file.
- **Answer wrongly** — an answer that still fails validation drops that row and reports why (`… — must be one of checking, savings, …`), instead of throwing.

Dropping is per row: a bill with three problems is one card, and leaving it out removes only that bill. Every other row in the table still imports.

### What the wizard cannot fix

Rows that satisfy every question but still break a database rule — a `CHECK` on a column the wizard does not police, such as `bills.funding_strategy`, a foreign key to a row that vanished between the two steps — are caught per row inside the merge transaction and returned as `issues` with a row description (`account “Weekend Fun”: CHECK constraint failed: kind`). The transaction still commits everything else.


---

## JSON backup format

A backup is a single JSON object:

```json
{
  "format": "cash-flow-routing-backup",
  "version": 7,
  "exportedAt": "2026-10-27T18:22:04.871Z",
  "tables": {
    "accounts": [],
    "bills": [],
    "bill_reserves": [],
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
| `version` | Yes | Integer, 2 to 7, not greater than the current schema version |
| `exportedAt` | No | String; defaults to `""` when absent |
| `tables` | Yes | Object containing table arrays |

The `format` identifier still uses the pre-rename name so backups made before the WageRoute rename remain importable. Do not change it without a versioned migration path.

### Tables and columns

Eight tables are exported and accepted. Each row carries the full column set below. Unknown columns are ignored; known columns that are absent receive a fallback or `null`.

| Table | Accepted columns |
| --- | --- |
| `accounts` | `id`, `user_id`, `name`, `kind`, `institution`, `starting_balance_cents`, `credit_limit_cents`, `color`, `dedicated_goal_id`, `in_safe_to_spend`, `is_archived`, `sort_order`, `created_at`, `updated_at`, `deleted_at`, `revision` |
| `bills` | `id`, `user_id`, `name`, `amount_cents`, `frequency`, `due_day`, `category`, `account_id`, `autopay`, `is_active`, `next_due_on`, `funding_strategy`, `funding_paycheck_index`, `created_at`, `updated_at`, `deleted_at`, `revision` |
| `bill_reserves` | `id`, `user_id`, `bill_id`, `paycheck_id`, `cycle`, `amount_cents`, `state`, `created_at`, `updated_at`, `deleted_at`, `revision` |
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

This allows hand-written or selectively exported files. A complete, importable file covering every table with full column sets — two accounts, two bills, a goal, a routed paycheck with allocations, and linked transactions including a paired transfer — lives at [`examples/backup.example.json`](../examples/backup.example.json). It is validated by `src/shared/backup-example.test.ts`, so it cannot drift from the parser.

```json
{
  "format": "cash-flow-routing-backup",
  "version": 5,
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
| `id` | A freshly generated UUID |
| `credit_limit_cents` | `null` |
| `transfer_group_id` | `null` |
| Any other omitted column | `null` |

Because every column is named explicitly in the `INSERT`, a SQLite column default never fires — the importer supplies the value. `TABLE_DEFAULTS` in [`src/main/db/backup.ts`](../src/main/db/backup.ts) mirrors the schema defaults so an omitted column lands on the same value the app would have chosen:

| Table | Omitted columns filled silently |
| --- | --- |
| `accounts` | `starting_balance_cents` → `0`, `is_archived` → `0`, `sort_order` → `0` |
| `bills` | `category` → `Bills`, `autopay` → `0`, `is_active` → `1` |
| `goals` | `priority` → `100`, `color` → `#34D399`, `is_archived` → `0`, `is_emergency` → `0` |
| `paychecks` | `source` → `Paycheck`, `priority_cents` → `0`, `surplus_cents` → `0`, `leisure_cents` → `0` |
| `transactions` | `memo` → `""`, `category` → `Uncategorized` |
| `bill_reserves` | `state` → `reserved` |
| `allocations`, `settings` | — |

Anything else that is missing or unusable — no `name`, an out-of-range `due_day`, a bad `kind`, a dangling `account_id` or `dedicated_goal_id` — is raised in the wizard before the merge runs, and its row is left out if it is not answered. A row that still breaks a database rule is reported on its own and does not stop the others.

`accounts.dedicated_goal_id` and `accounts.in_safe_to_spend` need **no** silent default: both are nullable with no schema default, so an absent key becomes `NULL`, which is exactly "not dedicated" and "derive Safe to Spend from the kind". A v2 or v3 file therefore imports with pre-v4 semantics.

### Version compatibility

| File version | Result |
| --- | --- |
| `< 2` | Rejected: “Backups older than schema 2 are not supported” |
| `2` | Accepted; missing v3 columns receive fallbacks |
| `3` | Accepted; the two v4 account columns arrive as `NULL` |
| `4` | Accepted; `accounts.color` arrives as `NULL` (the type colour), `bills.funding_strategy` arrives as `all_checks` and `funding_paycheck_index` as `NULL` |
| `5` | Accepted; nothing new to fall back on — version 6 added no column |
| `6` | Accepted; no `bill_reserves` rows, so the wall starts its receipts from the next route |
| `7` | Accepted |
| `> 7` | Rejected: “This backup came from a newer version (schema N)” |
| Non-integer | Rejected: “Backup has no version number” |

`bills.funding_strategy` is `NOT NULL` with a schema default, so it needs an entry in the importer's per-table defaults (`TABLE_DEFAULTS`): the importer lists every allowlisted column explicitly, and without the fallback an older file that omits the key would insert `NULL` and trip the constraint. That is the same failure fixed for `accounts.sort_order` in `2024f7f`, so the new column is covered by the same regression test rather than a new one.

---

## JSON merge semantics

`mergeBackup` runs inside one SQLite transaction, but each row is inserted in its own `try`. A row the database rejects is reported in `issues` with a description of that row, and the transaction still commits everything else. A statement failing does not abort the transaction; the import either commits the good rows or, if the whole transaction fails, writes nothing at all.

Tables are processed in foreign-key order:

```text
accounts → bills → bill_reserves → goals → paychecks → allocations → transactions → settings
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
- a row with no usable `key` or `value` is asked about in the wizard, and left out with an explanation if it stays blank — it never fails the import;
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

The one exception is `accounts.dedicated_goal_id`: accounts are inserted before goals, so a real foreign key there would make the pair cyclic and no order could restore a backup that uses the feature. The column carries **no** `REFERENCES` clause and is validated by the repository instead — on **write** only. A pointer that dangles after a restore is ignored when reading (the goal simply has no dedicated account), which is why the wizard has to ask about it before the merge rather than rely on the database.

A transaction with an explicit `bill_id`, `goal_id`, `account_id` or `paycheck_id` that exists neither locally nor earlier in the same file is raised in the wizard, where you can point it at a real row, clear it where the column is nullable, or leave that one row out. This used to be the most common cause of a whole backup being rejected; now it costs at most the rows that carry the bad link.

IDs the file creates for itself count as known, so a partial file that ships its own accounts and transactions is not asked about them — as long as the parent row either has an `id` in the file or is not referenced by name. A row that will be given a generated UUID cannot be a reference target, because nothing in the file can know that ID in advance; the wizard reports the referencing row instead.

---

## JSON validation and errors

Whole-file problems are rejected in `data:preview`, before the wizard opens, and the database is never touched:

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

Everything below is per row: the row is left out, described in `issues`, and the rest of the file imports.

| Condition | Handling |
| --- | --- |
| A required or constrained value is missing, invalid or dangling | Asked in the wizard first; dropped with a reason if unanswered or answered badly |
| A row has no `id` | A UUID is generated and the row imports (it just cannot be a reference target) |
| A settings row has no key | Issue: “setting row N: no setting key” |
| A value is an array/object where a scalar belongs | Issue naming the constraint, or a wizard question first |
| Any other database constraint fails | Issue: `<table> “label”: <SQLite message>` |

Values may be strings, numbers, booleans or `null`. Booleans are converted to 0/1. Numbers are passed through as-is; SQLite `STRICT` rejects a non-integer in an INTEGER column, and that rejection is reported per row.

The import result carries `added` and `skipped` counts per table, `dropped` rows (label, every reason, how to fix the file) and `issues` for rows the database itself refused. Both JSON and CSV imports use them.

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
| One already mapped by you in the wizard | Queued for insert against the account you picked |
| Zero | One wizard question per distinct name; leave it unanswered and every line with that name is left out |
| More than one | Issue: ``“X” matches more than one account`` |

The wizard groups a bank statement's many `COFFSHOC *BREW BAR` lines into a single question keyed on the first line that name appears on (`e:<firstLine>`), so you map each name once rather than line by line. Its answer becomes an account map handed to the merge, and names you chose to leave out are reported once as a dropped group instead of once per line.

Account names are not created automatically. Either map the lines onto an existing account in the wizard, or create an account with that exact name and import again — the second run matches by name and needs no mapping.

Archived accounts are still eligible for matching because the lookup does not filter `is_archived`. Soft-deleted accounts are excluded. An account you mapped in the wizard and then deleted before confirming is reported per line (“was mapped to an account that no longer exists”) rather than aborting the import.

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
- the resolved account ID, or the account you mapped that name onto in the wizard;
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
  "version": 5,
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

### 8. Hand-written backup with three problems on one bill

```json
{
  "format": "cash-flow-routing-backup",
  "version": 5,
  "tables": {
    "accounts": [{ "id": "acc-1", "name": "Cheque", "kind": "checking" }],
    "bills": [{ "id": "bill-1", "name": "Rent", "frequency": "monthly", "due_day": 45, "account_id": "acc-gone" }]
  }
}
```

- The wizard opens on one card for bill “Rent” with three questions: the amount is missing, `due_day` 45 is outside 1–31, and `acc-gone` does not exist.
- Type `1200`, `15` and pick Cheque: the row imports with those values.
- Leave the amount blank instead: the whole bill is left out — the row is dropped, not partially patched — and the review step says so and how to fix the file. The account still imports.
- Answer `0` for the amount: validation rejects it (“must be at least 0.01”), so the row is dropped with that message rather than reaching SQLite.

### 9. Bank CSV whose account names do not exist locally

- `findUnmappedAccounts` collapses the file's lines into one question per distinct name, so 40 `COFFSHOC *BREW BAR` lines ask once.
- Map it to an existing account and those 40 lines insert against that account; the dedup fingerprint then uses that account ID, so re-importing the same CSV skips them.
- Leave one name unmapped and it is reported once as a dropped group, while every other line still imports.

---

## UI messages

The wizard's review step is where detail lives: what is being imported, the values you filled in, and every row left out with its reason and how to fix the file. The toast after confirming is the one-line summary.

When rows were added — **records** for JSON, **entries** for CSV:

```text
Imported N new records · M already present · K rows left out · L rows refused by the database
```

Each tail segment only appears when its count is above zero. `left out` counts rows you dropped or never answered; `refused by the database` counts rows that passed the wizard and were still rejected by a constraint.

When nothing was added:

| Situation | Message |
| --- | --- |
| Rows were left out or refused | `Nothing imported — N rows left out` (error styling) |
| Everything was already there | `Nothing new — those records are already in your data` |
| The file had no rows | `That file had nothing to import` |

Problems raised before or during the run appear as error toasts with the main-process message verbatim: `That file is not valid JSON`, `That CSV has no entries`, `That file is too large`, `That file could not be read`, and `That import has expired — pick the file again` when the token was evicted or already used.

---

## Limits and cautions

| Limit | Value |
| --- | --- |
| Maximum import file size | 64 MiB |
| Maximum rows per JSON table | 200,000 |
| Pending wizard tokens held in the main process | 8, oldest evicted first, single use |
| Reference choices offered per table | 200 |
| Snapshot/CSV export rows | 500 newest transactions |
| JSON date range | Any valid date; no limit |

Cautions:

- Backups contain your complete financial history in plain text. Store them somewhere you would store a bank statement.
- Imported JSON preserves IDs. Importing two installations into one database creates duplicate accounts and goals with the same names but different IDs.
- CSV import does not create missing accounts, link bills or goals, or reconstruct transfers.
- A whole-file rejection leaves the database untouched. A per-row rejection leaves the *other* rows imported — read the review step and the toast rather than assuming all-or-nothing, and re-import the same file after fixing it: rows that already landed are recognised by ID (or by fingerprint for CSV) and skipped.
- Leaving a row out is not a rollback. Nothing local is deleted by an import, but a row you skipped stays missing until you import it again.
- The import is not a restore. It will not delete local rows, reset settings, or roll back to an earlier state.

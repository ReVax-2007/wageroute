# Features and behaviour

This is the functional reference for WageRoute 1.0.2 and the dedicated-accounts work queued for the next release. It describes what each screen does, which numbers it derives, what happens on save, and where the edge cases are.

Related references: [DATA-MODEL.md](DATA-MODEL.md) for formulas and storage, [IMPORT-EXPORT.md](IMPORT-EXPORT.md) for file behaviour, [ARCHITECTURE.md](ARCHITECTURE.md) for the mutation loop.

---

## Contents

- [Navigation](#navigation)
- [Overview](#overview)
- [Priority Wall](#priority-wall)
- [Sinking funds](#sinking-funds)
- [Emergency fund](#emergency-fund)
- [Accounts](#accounts)
- [Paycheck allocator](#paycheck-allocator)
- [Spreadsheet](#spreadsheet)
- [Settings](#settings)
- [Cross-cutting behaviour](#cross-cutting-behaviour)
- [Status matrix](#status-matrix)
- [Edge cases](#edge-cases)

---

## Navigation

The sidebar has six destinations and one global action:

| Item | Screen id | Purpose |
| --- | --- | --- |
| Overview | `dashboard` | Summary and prompts |
| Priority Wall | `wall` | Bills |
| Sinking funds | `goals` | Goals and emergency calculator |
| Accounts | `accounts` | Banks and credit |
| Spreadsheet | `ledger` | Ledger and projections |
| Settings | `settings` | Theme, round-up, data |
| **Route a paycheck** | — | Opens the allocator wizard over any screen |

The sidebar also shows a light/dark switch, cash on hand, the number of tracked accounts and the database path. Navigation is local state; there is no URL routing. The selected screen is not persisted across launches.

---

## Overview

The Overview is assembled from the snapshot and a few derived helpers.

### Greeting and header

`greeting()` uses the local hour: before 12 is “Good morning”, before 18 is “Good afternoon”, otherwise “Good evening”. The date is `formatDateLong(todayISO())`. The display name comes from the single local user.

### Safe to Spend

```text
Safe to Spend = spendable pool − monthly Priority Wall − funded goals whose money is in the pool
```

- **Spendable pool** is the sum of the balances of the accounts the user treats as spendable (see [Accounts](#accounts)). It is *not* cash on hand: an investment account can be opted in and a savings account opted out. With no per-account choice recorded, the pool is the non-archived checking, savings and cash balances, so pre-v4 data behaves exactly as before.
- **Monthly Priority Wall** is the smoothed monthly obligation of all **active** bills.
- **Funded goals whose money is in the pool** is every goal's funded amount *except* goals fed by a dedicated account (`poolEarmarkedGoalsCents`).

An account dedicated to a goal is left out of the pool by default, and its goal's progress is therefore not deducted either. The money has already been set aside — it is neither spendable nor inside the pool, so deducting it a second time would subtract the same amount twice and could push the hero number far below zero for no reason. Ordinary (allocation-funded) goals keep their deduction because that money really is still sitting in the pool.

The hero also shows:

```text
committed share = min(1, (monthly wall + funded goals) / cash)
```

If cash is zero, the share is zero. Safe to Spend can be negative; the value is styled as negative rather than clamped. The meter is deliberately measured against cash on hand, not the pool, because it answers "how much of my visible cash is already spoken for".

### Total wealth

Directly under the hero:

```text
Total wealth = sum of every non-archived account balance
```

Credit balances are stored negative, so they subtract. The strip splits the same number into Cash, Saved for goals, Invested and Credit owed; the split is tested to add back to the total exactly. The figure also appears as the first tile on Accounts and as a second line in the sidebar stat.

### Stat cards

| Card | Value | Hint |
| --- | --- | --- |
| Cash on hand | Cash across accounts, compact currency | “Across N tracked accounts” (includes archived in the count) |
| Priority Wall / month | Smoothed monthly wall | Per-paycheck reserve |
| Sinking funds | Funded ÷ total targets, rounded percent | Funded of target |
| Guilt-free last check | `leisureCents` of the newest paycheck | Pay date or “No paycheck routed yet” |

### This month's routing

The donut covers paychecks whose `receivedOn` starts with the current `YYYY-MM`. Allocations are folded into four slices:

| Slice | Buckets |
| --- | --- |
| Priority Wall | `priority` |
| Growth & sinking funds | `savings`, `investment`, `goal` |
| Debt payoff | `debt` |
| Guilt-free | `leisure` |

The centre shows total routed for the month. Each legend row shows amount and share of the month total. If nothing is routed this month, an empty state offers the allocator.

### Last routing

The newest paycheck (within the 24-paycheck snapshot window) is rendered as:

- the paycheck amount;
- a stacked bar whose segment widths are `segment.cents / paycheck.amount_cents`;
- a six-row legend: Priority Wall, Savings, Investments, Debt, Goals, Guilt-free (zero segments omitted);
- a health chip (`covered`, `tight`, `shortfall`) and the locked wall amount.

### Goals at a glance

Each goal shows funded vs target and a progress bar coloured by the goal's stored colour. Goals are not filtered by archive flag here; the snapshot excludes soft-deleted goals only.

### Recent activity

The six newest transactions show date, description, account, category chip and signed amount. The “Open spreadsheet” action switches to the ledger tab.

### Bill prompts

See [Bill prompts](#bill-prompts) below. The prompt card appears above the stat grid only when at least one active bill is past due and unconfirmed.

---

## Priority Wall

### Summary strip

| Figure | Formula |
| --- | --- |
| Locked every month | `Σ round(bill.amount × billPeriodsPerYear / 12)` over active bills |
| Reserved per paycheck | `Σ round(bill.amount × billPeriodsPerYear / payPeriodsPerYear)` over active bills |
| Active bills | Count of active bills; hint shows paused count and, when a paycheck exists, `perCheck / lastPaycheck.amount` as a percentage |

Cadence constants:

| Frequency | Occurrences per year |
| --- | --- |
| Weekly | 52 |
| Biweekly | 26 |
| Semimonthly | 24 |
| Monthly | 12 |
| Quarterly | 4 |
| Annual | 1 |

Pay cadence periods: weekly 52, biweekly 26, semimonthly 24, monthly 12.

Example: a $600 annual premium is $50/month. A $1,200 monthly bill reserves $553.85 per biweekly paycheck (`1200 × 12 / 26 = 553.846…`, rounded to 55385 cents).

### The wall table

Columns: bill name and category (plus “autopay”), amount, cadence, due day as an ordinal, per-paycheck reserve, monthly equivalent and actions.

Actions:

- **Pause/resume** — flips `is_active` immediately. Paused rows are dimmed, stop reserving and stop producing prompts, but remain in the table and in history.
- **Edit** — opens the bill dialog.
- **Remove** — confirmation then soft delete.

### Bill dialog

Fields: name, amount, cadence, due day (1–31), category, paid-from account, autopay checkbox and “Reserve money from every paycheck”.

Validation:

- name is required;
- amount must parse to cents and be greater than zero;
- due day is coerced to a number and clamped by the repository;
- category defaults to `Bills`;
- account is optional.

New bills get `nextDueOn = null`. Editing preserves the existing `nextDueOn` unless it is explicitly changed.

### Notes

- The wall is a reservation model, not an automatic payment schedule.
- Monthly figures are smoothed; a large annual bill does not create a spike in the month it lands.
- Deleting a bill does not delete its past payments.

---

## Sinking funds

### Goal cards

Each card shows:

- colour dot, name and target date (or “No deadline set”);
- funded amount of target;
- progress bar coloured by the goal;
- percent funded, capped at 100 for display;
- amount remaining (`max(0, target − funded)`);
- priority chip, emergency chip when flagged, a monthly pace chip, and a funding-source chip when the goal is fed by a dedicated account.

Monthly pace:

```text
months = targetDate ? max(1, ceil(daysUntil(today, targetDate) / 30.4375)) : null
monthlyNeed = months ? ceil(remaining / months) : null
```

A goal with no target date shows “No pace set”. A goal whose deadline is today still gets a one-month pace.

Progress has two sources (see [ADR 0007](decisions/0007-dedicated-accounts-balance-is-progress.md)):

- **A dedicated account.** If any live, non-archived account is marked “Mine only for” this goal, its **balance is the funded amount** — several accounts add together, and the allocation total is replaced, not added to. The card shows a chip naming those accounts, and the number moves with every entry that touches them. An overdrawn dedicated account reads as zero.
- **Otherwise, allocation lines** written by paycheck routing. Moving money into the account named in “Held in” does not increase progress on such a goal.

Detaching or archiving the last dedicated account puts the goal back on its allocation total. The historical allocation rows are never deleted; they are simply not shown while an account is the source.

### Goal dialog

Fields: name, target amount, optional target date, priority, held-in account, colour. Colours are a fixed six-swatch palette.

Validation: name required, target greater than zero. Priority is numeric; lower numbers are funded first.

Creating a goal does not backfill it with existing savings. Editing a target recalculates progress against the new target immediately.

Removing a goal asks for confirmation, then soft-deletes it. Its historical allocations remain in the ledger but no longer appear as progress, and every account dedicated to it is detached in the same transaction so none points at a removed goal.

### Funding order

When the allocator distributes the goal percentage, eligible goals are sorted by:

1. priority ascending;
2. target date ascending, with no date sorting last;
3. name ascending.

Fully funded goals are skipped, and so is every goal fed by a dedicated account: an allocation written against it would be invisible, so its share of the budget falls through to savings instead. When no goal is allocatable at all the warning is “no goals”, whether that means none exist or all of them have their own account. Each remaining goal takes `min(remaining need, remaining goal budget)`. Any leftover goal budget becomes savings.

---

## Emergency fund

The emergency calculator is embedded at the top of Sinking funds, not in Settings.

### Inputs

| Input | Behaviour |
| --- | --- |
| Mode | **Auto calculate** or **Manual** |
| Months | 3, 4, 5 or 6 in auto mode |
| Include variable spending | Adds recent variable expenses to the wall |
| Manual target | A free-form amount shown only in manual mode |

### Automatic target

```text
monthly wall = smoothed active bills
variable average = average monthly variable expenses over the last 6 months
essentials = wall + (includeVariable ? variable average : 0)
target = essentials × months
```

The variable average:

- considers only `kind = 'expense'` rows with a negative amount;
- starts at the first day of the month five months before the current month;
- ends today (inclusive);
- divides the total by the number of calendar months from the earliest included expense to today, inclusive, with a minimum of one;
- ignores bills, transfers, investments and adjustments.

Example: three expenses of $100, $200 and $300 in three months average $200/month.

### Manual target

Manual mode replaces the calculation with a typed amount. Switching to manual pre-fills the field with the current automatic target if it is empty. The manual amount is still saved to settings when switching back to auto, so it is not lost.

### Applying

“Apply target” / “Create emergency fund”:

1. validates the target is above zero;
2. saves the emergency settings;
3. if an emergency goal exists, updates its `target_cents`;
4. otherwise creates a goal named **Emergency Fund**, priority 1, colour `#38BDF8`, no account, `isEmergency = true`.

The card also shows the wall, variable average, essentials, target, a progress bar, coverage in months and whether an emergency goal exists. Coverage is `funded / essentials`, and is 0 when essentials are 0.

The emergency flag is a label and a lookup key. It does not change allocation ordering; priority does that. Migration v3 flagged any existing goal named “Emergency Fund”.

---

## Accounts

### Grouping

Active accounts are grouped by `institution`, sorted alphabetically. Accounts with no institution fall under **No bank assigned**. Each group header shows the group total and, when present, credit owed.

### Summary tiles

| Tile | Value |
| --- | --- |
| Total wealth | `Σ` non-archived balances; credit is already negative |
| Cash across accounts | Non-archived checking + savings + cash |
| Credit owed | `Σ max(0, −balance)` for credit accounts |
| Available credit | `Σ max(0, limit − owed)` for credit accounts with a limit |

The hint also counts tracked credit cards.

### Account rows

Each row shows the account kind dot, name, kind label, credit limit when present, a utilization bar for credit cards, the display balance and an available/owed label.

Display rules:

- credit: `max(0, −balanceCents)` labelled “owed”;
- non-credit: signed balance labelled “available”; a negative non-credit balance is styled red.

Credit utilization is `min(100, round(displayBalance / limit × 100))`, shown only when the limit is a positive number.

### Add / edit account

Fields:

- **Account name** — required.
- **Bank or institution** — free text with a datalist of existing institutions.
- **Type** — checking, savings, cash, investment, credit.
- **Starting balance** — create only. For credit cards the label becomes “Balance owed today” and a positive entry is stored as a negative balance.
- **Credit limit** — credit cards only.
- **Mine only for** — any live sinking fund, or **Nothing in particular**. Choosing a goal makes the account dedicated: its balance becomes that goal's progress, a hint explains that money parked here is spent when the goal is funded, and the account drops out of the spendable pool by default.
- **Safe to spend** — Automatic / Always count it / Never count it. Automatic follows the account type (checking, savings and cash are included; investment, credit and dedicated accounts are not), and an explicit choice wins in both directions.

Both fields appear on create *and* edit, and are written as one pair so the dialog cannot save a purpose change without its pool consequence.

Editing cannot change the starting balance. The subtitle explains that corrections use an adjustment entry so the opening balance stays intact.

### Adjust balance

The dialog takes a target balance and a date. It computes:

```text
delta = target − current derived balance
```

If the delta is zero, it reports “That balance is already correct” and writes nothing. Otherwise it posts one `adjustment` transaction for the delta with memo “Balance adjustment” and category “Adjustment”. For a credit card, the typed amount owed is negated before comparison.

This keeps every correction visible in the spreadsheet.

### Pay a credit card

Available on credit accounts only.

- Source accounts are active, non-credit, non-investment accounts.
- The default amount is the current amount owed.
- The action posts a paired `transfer`: negative leg on the source, positive leg on the card, memo `Payment · <card name>`, category `Credit payment`.
- Paying more than owed is allowed; the card balance becomes positive and displays as zero owed.

### Remove an account

Confirmation text explains that entries stay in the ledger. On delete:

- bills, goals and paychecks referencing the account have the reference set to null;
- the account is soft-deleted;
- transactions remain and still display the account name;
- balances, cash and credit totals stop including it.

---

## Paycheck allocator

The allocator is a modal wizard opened from the sidebar or any “Route a paycheck” action. Opening it resets all fields from current settings.

### Step 1 — Income

Fields:

- paycheck amount (large currency input; Enter advances when positive);
- pay date (defaults to today);
- source (defaults to “Payroll”);
- deposit account (defaults to the first checking account, else the first account);
- pay cadence (defaults to the saved cadence).

The step also previews the wall reserve: “Next we hold back X for the Priority Wall”.

Validation before advancing: the amount must be greater than zero. The commit also requires a deposit account.

### Step 2 — Priority Wall

Shows:

- the number of active bills;
- the total reserve for the selected cadence;
- an expandable per-bill breakdown;
- true surplus = income − funded wall;
- a shortfall warning when the wall exceeds income.

A shortfall does not block the wizard, but the plan has no surplus and every split is zero. Committing such a paycheck is allowed; it records the partial wall funding and a shortfall health value.

### Step 3 — Distribute

Four percentage controls, each with a slider and a number input:

- savings;
- investments;
- sinking funds;
- debt payoff.

All are clamped to 0–100 by the component and by the domain layer.

The panel shows:

- the true surplus;
- the cent amount for each split;
- a routed-percentage summary: `splitTotal% of True Surplus`, with `100 − splitTotal` staying guilt-free, or an over-allocation warning;
- “Round every bucket to whole dollars”;
- the guilt-free amount;
- goals funded from this check, with remaining need;
- plan warnings.

If the splits add up to more than 100%, the route button is disabled and labelled “Splits exceed 100%”. The pure allocator would scale them proportionally, but the UI prevents that state.

### The algorithm

In order:

1. Clamp income to ≥ 0 and round to cents.
2. Compute the Priority Wall reserve from **active** bills and the selected cadence.
3. Fund the wall up to income. If income is short, stop: all other buckets are zero and health is `shortfall`.
4. Compute the true surplus.
5. Compute each split as `round(surplus × percent / 100)`.
6. If the requested splits exceed the surplus, scale them with largest-remainder apportionment so the cents still sum exactly.
7. Sort goals by priority, date, name and fund each up to its remaining need.
8. Sweep unused goal budget into savings.
9. If whole-dollar mode is on, floor savings, investments, debt and each goal funding to whole dollars.
10. Recompute goal total.
11. Leisure = surplus − savings − investment − goals − debt.
12. Health: `shortfall` if the wall was not covered; otherwise `tight` when income is zero or leisure is less than 10% of income; otherwise `covered`.

The identity `priority + savings + investment + goals + debt + leisure = income` always holds.

### Warnings

| Code | Meaning |
| --- | --- |
| `shortfall` | The paycheck cannot cover the wall |
| `splits_scaled` | Requested splits exceeded the surplus and were scaled down |
| `goal_overflow` | Goal budget remained after all goals were funded and swept to savings |
| `no_bills` | The wall is empty |
| `no_goals` | No goals exist, so the goal share became savings |
| `tight_margin` | Leisure is below 10% of income |

The UI suppresses `splits_scaled` when the user's own split total is over 100%, because the over-allocation message is clearer.

### Commit

On submit:

1. Validates income > 0, deposit account present and splits ≤ 100.
2. Saves `payCadence`, the four split percentages and `wholeDollarBuckets` to settings.
3. Calls `commitPaycheck` with the draft.
4. On success, closes the wizard, switches to Overview and shows “Paycheck routed”.
5. On failure, shows the error and leaves the wizard open.

The commit writes one `paychecks` row, one allocation row per positive line, and one `income` transaction on the deposit account. It does **not** move money to savings, investments, goals or debt. Those movements remain manual transfers or spending decisions.

Because settings are saved before the commit, a failed commit can still update the saved cadence and splits. This is intentional: the user's preferred split is a preference, not part of the paycheck transaction.

---

## Spreadsheet

### Tabs

The toolbar switches between:

- **Transactions (N)** — the editable ledger;
- **Next 90 days (N)** — a read-only projection.

The hint text changes with the tab.

### Ledger grid

Columns: Date, Account, Kind, Category, Description, Amount, delete action.

- Click or double-click a cell to edit in place.
- Date uses a native date input and accepts only `YYYY-MM-DD`.
- Account and Kind use selects.
- Category and Description use text editors.
- Amount parses through `parseMoneyToCents`; invalid input cancels the edit.
- Sorting is available on Date, Category and Amount; multiple sort columns are supported by the grid.
- Each changed cell produces a patch containing only the fields that changed, then calls `updateTransaction`.
- Delete asks for confirmation. For a paired transfer, the prompt says “Delete both legs” and the repository removes the whole group.

The grid receives the snapshot's newest 500 non-deleted transactions.

### Projections

`projectUpcoming` runs over active bills and all goals for the next 90 days:

- **Bills** start at `nextDueOn` when it is on or after today, otherwise at the next occurrence of `dueDay`. They repeat by frequency up to the horizon, with a guard of 400 occurrences per bill.
- **Goals** appear when they have a target date within the horizon and a positive remaining amount. The row amount is the remaining amount, not the target.
- Rows are sorted by date, then name.
- The grid is read-only and shows Date, Type (Bill/Goal), Name, Category, Amount.

### Add entry dialog

Fields: date, account, kind, destination account (transfers only), amount, category, description.

Amount direction:

| Kind | Stored amount |
| --- | --- |
| Income | `+abs(typed)` |
| Expense, bill payment, transfer, goal funding, investment | `−abs(typed)` |
| Adjustment | the typed sign, unchanged |

Validation:

- account required;
- amount required and non-zero;
- transfers require a different destination account.

Transfers create both legs. Expenses may trigger round-up. The dialog closes after the store refresh; errors appear in the dialog before it closes.

### Empty states

- No ledger rows: “No entries yet” with an add action.
- No projections: the grid simply renders zero rows.

---

## Settings

### Appearance

Dark, Light or System. System listens to `prefers-color-scheme` and switches live. The resolved theme is written to `document.documentElement.dataset.theme` and cached in `localStorage['cfr-theme']` so the next launch paints the right palette immediately. Settings remain the source of truth.

### Round-up

- Toggle “Round up debit spending”. It is disabled when no active savings account exists, with a shortcut to Accounts.
- Choose the destination savings account.
- Choose the increment: $1, $2 or $5.
- The hint shows a live example using $12.40.

Rules enforced at write time:

- only `checking` and `cash` source accounts trigger a sweep;
- the destination must be active and must not be credit or investment;
- the destination cannot be the source account;
- the sweep is `increment − (|amount| mod increment)`, and zero when the amount is already divisible;
- the sweep is a paired transfer with category `Round-up` and memo `Round-up · <original memo>`;
- only newly created negative expenses trigger it. Editing an existing expense, importing entries and logging a bill payment do not.

### Data

Three actions:

- **Export full backup** — JSON save dialog, default `~/Documents/wageroute-backup-YYYY-MM-DD.json`.
- **Export transactions CSV** — CSV save dialog, default `~/Documents/wageroute-transactions-YYYY-MM-DD.csv`.
- **Import data** — open dialog accepting `.json` and `.csv`, then the import wizard.

### Import wizard

The wizard has three steps — choose file, missing info, review — and the same component serves the first-run "Import a backup" button on the dashboard.

- **Missing info** shows one card per row that cannot import as it stands, with an editor per question: text, amount, whole number, date, an enum dropdown, or a dropdown of local rows for a foreign key (with **Leave unlinked** where the column allows NULL). CSV account names that match nothing are grouped into one question per name covering every line that shares it.
- Each card offers **Leave this row out** (or **Leave these lines out** for CSV). Filling an answer in patches the row; leaving it blank drops the row instead of failing the import.
- **Review** names what is being imported, echoes the values you supplied, and lists everything not imported with every reason on that row plus how to fix the source file. A warning counts rows still incomplete before you confirm.
- A file with nothing missing skips straight to review, so a clean WageRoute backup is still one click.
- Rows that pass the wizard but break a database rule anyway are reported individually; the rest of the transaction commits.

The file path stays in the main process between the two steps — the renderer only ever holds a single-use token. See [docs/IMPORT-EXPORT.md](IMPORT-EXPORT.md#the-import-wizard).

The database path is displayed below the actions and is also shown in the sidebar (with a tooltip for the full path).

### Danger zone

**Erase all data…** starts a two-step confirmation. The first dialog explains what is deleted (every account, bill, sinking fund, paycheck and ledger entry, plus settings) and that exported backups and CSV files are untouched; **Continue** opens a second dialog with a final **Erase everything** button. The erase wipes the database, re-seeds a blank local user with default settings, and returns to the dashboard in the same blank state as a first launch.

### Emergency fund

A pointer card to Sinking funds; the calculator itself lives there.

---

## Cross-cutting behaviour

### Bill prompts

On the Overview, active bills are checked against payments:

1. Find the most recent occurrence of the bill's due day on or before today.
2. Ignore it when `dueOn >= today` (a bill is never late on its due date).
3. Define the payment window as `[dueOn − 5 days, nextDueOn)`.
4. If any transaction with a matching `billId` falls in the window, the bill is considered confirmed.
5. Otherwise show a prompt with the bill name, due date, days late and autopay flag.

Matching is by `billId`, not category, so an unrelated “Housing” expense does not silence the prompt.

Actions:

- **Yes, it cleared** posts a `bill_payment` for the bill amount on its linked account, or a fallback checking/first active account when no account is linked. The date is the due date, the memo is the bill name and the category is copied from the bill. This does not advance `nextDueOn`; the next cycle is derived from the due day.
- **Not yet** snoozes the prompt for the current session only. Snoozes are not persisted and reset on restart.

Prompts are sorted by due date, then name. The count badge reflects visible prompts after snoozing.

### Paired transfers

- Created by the transfer entry kind, credit-card payments and round-ups.
- Both legs share a `transfer_group_id`.
- Editing amount, date, memo or category through either leg updates both.
- Account and kind are locked for paired legs; the error explains to delete and re-enter.
- Deleting either leg deletes both.
- The transfer amount is the absolute value; the source leg is negative and the destination leg positive.

### Money parsing

`parseMoneyToCents` accepts:

- optional `$`, spaces and commas;
- a leading `+` or `-`;
- parentheses for negatives, e.g. `(42.00)`;
- a leading `USD`;
- zero, one or two decimal places;
- whole numbers without decimals.

It rejects more than two decimals, non-numeric text, an empty string (returns `null`) and unsafe integers. It never uses floating-point arithmetic for the result.

### Toasts and confirmations

- Success and error messages are toasts, auto-dismissed after 4.2 seconds; clicking one dismisses it early.
- Destructive actions use the native `window.confirm` dialog: deleting accounts, bills, goals and transactions.
- Import uses a confirmation before opening the file picker.

### Theme propagation

The theme is applied at the document root. The grid is styled through the shared design tokens; a small number of components use dedicated classes for chart and grid surfaces. Theme choice is independent of data.

### Time and time zones

All domain dates are constructed as UTC dates from `YYYY-MM-DD` strings. “Today” is derived from the local calendar date via `todayISO()`, then treated as a date-only value. Timestamps (`created_at`, `updated_at`, `exportedAt`) are ISO UTC instants. There is no timezone setting and no daylight-saving adjustment for date-only calculations.

---

## Status matrix

| Capability | Status | Notes |
| --- | --- | --- |
| Manual accounts, bills, goals, entries | Implemented | |
| Paycheck routing with priority-first allocation | Implemented | Pure, tested |
| Sinking funds and goal priorities | Implemented | |
| Emergency fund auto/manual target | Implemented | 3–6 month presets |
| Credit accounts, limits and utilization | Implemented | No interest/APR modelling |
| Paired transfers | Implemented | |
| Round-up sweeps | Implemented | Expense creation only |
| Bill payment prompts | Implemented | Session-only snooze |
| 90-day projections | Implemented | Bills and goal deadlines |
| Dark/light/system themes | Implemented | |
| JSON backup, partial JSON import | Implemented | Additive |
| CSV export and entries import | Implemented | CSV export limited to 500 rows |
| Multi-currency display | Partial | Currency setting exists; no selector and no conversion |
| Bank connections / statement sync | Not implemented | Manual entry and file import only |
| Recurring transaction generation | Not implemented | Bills are a reserve model |
| Paycheck editing or deletion | Not implemented | Commit is append-only in the UI |
| Goal withdrawals or spending from a goal | Partial | Spending from a **dedicated account** lowers that goal's progress, because its balance is the progress. Allocation-funded goals have no withdrawal path — their money never left the spendable accounts |
| Debt payoff schedule / APR | Not implemented | Debt is a percentage bucket plus credit balances |
| Category budgets and reports | Not implemented | |
| Cloud sync, multi-device, accounts | Not implemented | Schema prepared only |
| Auto-update | Not implemented | |
| Encryption at rest | Not implemented | Rely on OS full-disk encryption |
| Multi-user | Not implemented | One local user row |
| Mobile or web build | Not implemented | Desktop Electron only |

---

## Edge cases

| Situation | Behaviour |
| --- | --- |
| Paycheck smaller than the wall | Wall partially funded, all other buckets zero, `shortfall` health |
| Splits over 100% in the pure allocator | Scaled proportionally with largest remainders; UI blocks the state |
| No bills | Plan warns and routes the whole surplus |
| No goals | Goal share sweeps to savings with a `no_goals` warning |
| Goals fully funded | Remaining goal budget sweeps to savings with `goal_overflow` |
| Goal due today | One-month pace (never zero months) |
| Goal with no target date | Funded by priority; no pace chip |
| Bill due on the 31st in a short month | Clamped to the last day of the month |
| Bill due today | No prompt until tomorrow |
| Payment a few days early | Counts for the cycle if within five days of the due date |
| Payment dated after the due date but before the next cycle | Counts as confirmed |
| Unrelated expense in the same category | Does not silence a prompt |
| Edit a paired transfer's account or kind | Rejected with an explanation |
| Delete one transfer leg | Both legs are soft-deleted |
| Delete an account with transactions | Transactions remain; references are nulled |
| Archived account | Hidden from cash/credit totals and most pickers |
| Credit card overpaid | Displays zero owed; available credit is capped at the limit |
| Round-up destination is the source account | No sweep |
| Round-up on an exact dollar amount | No sweep |
| Round-up on a credit card | No sweep |
| Import duplicate transaction | Skipped by ID (JSON) or fingerprint allowance (CSV) |
| Import unknown CSV account | Row reported as an issue, other rows still import |
| Import transfer row from CSV | Reported as an issue; use a JSON backup to keep both legs |
| Import settings that already exist | Local value wins |
| Import a backup from a newer schema | Rejected with a version message |
| JSON import with missing sync metadata | Filled with `now` and revision 1 |
| JSON import with a dangling foreign key | The whole import rolls back |
| Delete the database file | Packaged: next launch seeds a blank profile with the first-run prompt; development: next launch re-seeds the demo profile |

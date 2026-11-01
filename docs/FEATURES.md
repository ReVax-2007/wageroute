# Features and behaviour

This is the functional reference for the current build. It describes what each screen does, which numbers it derives, what happens on save, and where the edge cases are. Features merged but not released yet are marked in [UNRELEASED.md](UNRELEASED.md); this file describes the behaviour the code has, not only what the last installer contains.

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
| Settings | `settings` | Pay cycle and payday label, default paycheck account, theme, round-up, data |
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
                − this month's debt and investment routing that has not moved yet
```

- **Spendable pool** is the sum of the balances of the accounts the user treats as spendable (see [Accounts](#accounts)). It is *not* cash on hand: an investment account can be opted in and a savings account opted out. With no per-account choice recorded, the pool is the non-archived checking, savings and cash balances, so pre-v4 data behaves exactly as before.
- **Monthly Priority Wall** is the smoothed monthly obligation of all **active** bills.
- **Funded goals whose money is in the pool** is every goal's funded amount *except* goals fed by a dedicated account (`poolEarmarkedGoalsCents`).
- **Routing not moved yet** is this month's `debt` and `investment` allocation lines, less the transfers a routing plan itself posted to a credit or investment account since the earliest of those paycheques (`unsettledRoutingCents`). Only entries carrying one of this month's `paycheck_id` values count — an unrelated deposit, card payment or market gain must not make a plan look settled when the money is still in checking. Routing records a plan and moves nothing ([ADR 0013](decisions/0013-a-route-is-a-plan-not-a-movement.md)), so the dollars are still in checking until the card is paid or the brokerage transfer lands; deducting them only while they are still there avoids charging the same dollar twice once it has moved. Savings is not deducted: a savings account in the pool is still spendable, and one outside it is already excluded from the pool.

An account dedicated to a goal is left out of the pool by default, and its goal's progress is therefore not deducted either. The money has already been set aside — it is neither spendable nor inside the pool, so deducting it a second time would subtract the same amount twice and could push the hero number far below zero for no reason. Ordinary (allocation-funded) goals keep their deduction because that money really is still sitting in the pool.

The hero also shows:

```text
committed      = max(0, spendable pool − Safe to Spend)
committed share = committed / spendable pool        (0 when the pool is empty)
```

The meter bar caps at 100%, but the note above it keeps the real figure: above 100% it reads “N% of spendable cash is committed — more than you have”, and an empty pool reads “No spendable cash is tracked yet”. It is measured against the pool because that is the money Safe to Spend was computed from; measuring against cash on hand counted investment and excluded savings inconsistently with the number beside it.

### Total wealth

Directly under the hero:

```text
Total wealth = sum of every non-archived account balance
```

Credit balances are stored negative, so they subtract. The strip splits the same number into Cash, Saved for goals, Invested and Credit owed; the split is tested to add back to the total exactly. The figure also appears as the first tile on Accounts and as a second line in the sidebar stat.

When at least two days of history exist, a **sparkline** sits under the total: one point per day, sum of every live account's recorded balance, coloured green when the last point is at or above the first and red when it is below. The line's accessible name reads the exact figures and dates (`Net worth from $17,200.00 on Oct 2 to $17,900.00 today`), and the caption reads **Since Oct 2**. The series is sampled to at most 90 points, always keeping the last. With one day of history, or none, nothing is drawn rather than a flat line that implies measurement.

### Due in the next two weeks

A queue of bills and credit-card payments falling in the next fourteen days, soonest first:

- a bill contributes its amount;
- a card contributes `last_statement_balance_cents` minus payments recorded since the statement closed — only when the statement balance and the cycle days are known, so the app never invents a card due date;
- each row shows name, `Today` or `in Nd`, the date and the amount; rows due within two days are highlighted;
- an empty state reads **Nothing due** with *"No bill or card payment lands in the next fourteen days."*

### Spending this month

The month's expenses and bill payments (`expense` and `bill_payment` dated in the current calendar month) grouped by category:

- up to six category rows, each with the category colour, a share bar and its total, largest first;
- a footnote with the month total and the category count, plus *", top six shown"* when more exist;
- an entry with no linked category falls under its stored text; an empty month shows **No spending recorded**.

### Stat cards

| Card | Value | Hint |
| --- | --- | --- |
| Cash on hand | Cash across accounts, compact currency | “Across N tracked accounts” (active only; archived accounts are excluded) |
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
| Reserved on the next check | `Σ billFundingReserveCents(bill, payCadence, nextCheckDate, anchor, paidThisMonth)` over active bills — the spread for `all_checks` bills plus the full month on the one funding check for the four single-check strategies; a bill already claimed this month reserves 0, and a bill partly paid reserves only the remainder |
| Active bills | Count of active bills; hint shows paused count and, when a paycheck exists, `perCheck / lastPaycheck.amount` as a percentage |

The two figures answer different questions and are deliberately not the same arithmetic: *locked every month* is the obligation, *reserved on the next check* is what the next real cheque carries. Averaging is what makes a $600 yearly premium look like $50 a month instead of a shock. The reserve figure is labelled **Next check** with the date when Settings → Paycheck has a **Pay schedule anchor**; without one the card reads **Average per check** and the table column is labelled **Per check**. The hint names the cycle, the date and, when one is set, the free-text payday label ("Biweekly pay cycle · 15th and last day"); the label is display only.

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

Columns: bill name and category (plus “autopay”), amount, cadence, due day as an ordinal, the per-check figure — labelled **Next check** when an anchor is set and **Per check** otherwise, with a tooltip saying single-check bills carry the whole month there — monthly equivalent and actions.

A bill funded by a single paycheck shows its monthly amount in the per-check column with a **“Reserved on the 2nd check of the month”** sub-label (“each month” when no payday is set), so the row cannot be read as a recurring deduction. Paused bills sort below the active ones and are marked **Bill inactive** — that label belongs to bills; a paused emergency fund says **Saving paused**.

The name cell carries the month's receipt when there is one: **Reserved this month** while a fully funded route has claimed the bill, **Paid this month** once a linked payment has landed. The claim is a record, not a movement: the money is still in the account until the bill is actually paid ([ADR 0012](decisions/0012-the-wall-remembers-its-claims.md)).

Actions:

- **Pause/resume** — flips `is_active` immediately. Paused rows are dimmed, stop reserving and stop producing prompts, but remain in the table and in history.
- **Edit** — opens the bill dialog.
- **Remove** — confirmation then soft delete.

### Bill dialog

Fields: name, amount, cadence, due day (1–31), category, paid-from account, autopay checkbox, **Funding schedule** and — when it is needed — **Which paycheck?**.

Autopay marks a bill as one WageRoute records for you. At launch, every active autopay bill whose latest occurrence has passed without a matching payment gets one `bill_payment` dated the due day with a `· autopay` memo, and the month's reserve flips to **Paid**. A part payment already in the ledger counts, so only the remainder is posted; a bill with no usable account (neither its own nor the default deposit account) is skipped and stays on the wall rather than being guessed at. The app still does not move money between accounts — you pay the bill — it keeps the ledger honest without a manual prompt. A hint under the checkbox says exactly that. New bills default to autopay on.


Funding schedule offers the five choices in this order, numbered so the list reads as an answer rather than a set of labels:

| # | Option | What it does |
| --- | --- | --- |
| 1 | **Closest to the due date** | The paycheck whose slot sits nearest the bill's due day carries the whole month; other paychecks reserve nothing for it |
| 2 | **Choose specific paycheck to fund** | Shows a second field, **Which paycheck?**, listing only the slots this pay cadence is certain to produce each month (1st/2nd for biweekly, 1st–4th for weekly, only 1st for monthly) |
| 3 | **Reserve from all paychecks** | The default. The year's cost is spread evenly over every paycheck, so nothing lumps onto one check |
| 4 | **First check of every month** | The month's obligation always lands on the 1st paycheck |
| 5 | **Last check of every month** | The month's obligation lands on the last check the cadence is *guaranteed* to have — the 2nd for biweekly, the 4th for weekly, the 2nd for semimonthly. Biweekly months with a 3rd check still fund on the 2nd, so a short month cannot leave the bill unreserved |

Whatever is chosen, the month is collected exactly once — a strategy moves the money, it never multiplies it. Under 1, 2, 4 and 5 a $50 weekly bill asks $216.67 from one check rather than the $50 instance that happens to fall there.

The "Which paycheck?" field only appears for option 2 and only when the pay cadence has more than one guaranteed slot. A live hint under the field names the paycheck that will actually fund the bill (for example, "Reserves the whole month's obligation on the 2nd paycheck, closest to the due day"), and disappears for option 3.

Validation:

- name is required;
- amount must parse to cents and be greater than zero;
- due day must be a whole number from 1 to 31 — `0`, `32`, a fraction or `NaN` is refused with *"Due day must be a whole number from 1 to 31"* rather than clamped, so a typo cannot silently move a bill to the month end;
- category defaults to `Bills`;
- account is optional;
- funding schedule is one of the five enum values; `funding_paycheck_index` is only read for option 2, the repository requires a whole number from 1 to 4, and the reserve math clamps it to the last slot the cadence guarantees (2 for biweekly and semimonthly, 4 for weekly, 1 for monthly).

New bills get `nextDueOn = null`. Editing preserves the existing `nextDueOn` unless it is explicitly changed.

### Notes

- The wall is a reservation model; autopay only records the payment, it never moves money.
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
- priority chip, emergency chip when flagged, a monthly pace chip, and a **Dedicated account** / **N dedicated accounts** chip when the goal is fed by its own accounts;
- when accounts fund the goal, each one is listed under the total with its own balance, so the sum is never a black box.

Monthly pace:

```text
months = targetDate ? max(1, ceil(daysUntil(today, targetDate) / 30.4375)) : null
monthlyNeed = months ? ceil(remaining / months) : null
```

A goal with no target date shows “No pace set”. A goal whose deadline is today still gets a one-month pace.

Progress has two sources (see [ADR 0007](decisions/0007-dedicated-accounts-balance-is-progress.md) and [ADR 0009](decisions/0009-the-goal-chooses-its-funding-accounts.md)):

- **A dedicated account.** If any live, non-archived account is ticked as a funder of this goal, those accounts' **balances added together are the funded amount** — the allocation total is replaced, not added to. The card lists each contributing account with its own balance under the total, and the number moves with every entry that touches them. An overdrawn dedicated account reads as zero.
- **Otherwise, allocation lines** written by paycheck routing. Moving money into the account named in “Deposit account” does not increase progress on such a goal.

Detaching or archiving the last dedicated account puts the goal back on its allocation total. The historical allocation rows are never deleted; they are simply not shown while an account is the source.

### Goal dialog

Fields: name, target amount, optional target date, priority, **Funded by**, **Deposit account**, colour. Goal colours are a fixed six-swatch palette.

**Funded by** is the picker that decides where progress comes from, and it is a property of the goal, not of the account:

- by default one dropdown, because one account is the common case — it lists savings, checking and cash accounts with their balances, plus **“No account — count allocations instead”**. An account that already funds a *different* goal is labelled `(funds That Goal)` so taking it is a visible decision, not a surprise;
- a **“Let several accounts add up together”** checkbox swaps the dropdown for a tick list, and the ticked balances are summed. Unticking here is the way to release an account; the account dialog's pointer is the same relation seen from the other side;
- choosing funders never touches **Deposit account**, which stays a separate, informational “where does the finished lump get spent”.

Saving applies both sides at once: the goal row and every funder binding commit in one transaction, so a newly created goal cannot arrive with a target but no accounts, and a failed binding rolls the whole save back rather than half-applying ticks. An archived account is refused as a funder.

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

### Which accounts fund it, and whether to save this paycheck

The card reuses the same **Funded by** picker as the goal dialog, pointed at the emergency goal:

- one account by default — a single dropdown, because one savings account holding the float is the common case;
- **“Let several accounts add up together”** switches to a tick list whose balances are summed;
- nothing ticked means progress is counted from the allocations each paycheck routes.

There is no separate list of emergency account IDs in settings. The relation lives on the goal like any other sinking fund, so the emergency fund cannot disagree with the accounts screen, and an account can only ever be an emergency funder or another goal's funder — never quietly both.

**Save towards it every paycheck** pauses the contribution, not the fund: `emergencyActive = false` makes the allocator stop routing surplus into the emergency goal while leaving its target, progress and coverage visible. While paused the card shows a **Saving paused** chip and a **Resume saving** button. Bills use **Bill inactive / Resume bill** for the same idea; the two labels are deliberately different because a goal is not a bill.

### Applying

“Apply target” / “Create emergency fund”:

1. validates the target is above zero;
2. saves the emergency settings (`emergencyMode`, months, include-variable, manual target, `emergencyActive`) — no account list, because accounts belong to the goal;
3. if an emergency goal exists, updates `target_cents` **and** its `fundingAccountIds` in the one `goal:update` call, which binds the ticked accounts and releases the ones unticked;
4. otherwise creates a goal named **Emergency Fund**, priority 1, colour `#38BDF8`, `isEmergency = true`, funders attached in the same `goal:create`.

Progress on the card is read from the goal's own `fundedCents`, not recomputed in the component, so the meter, the goal card and the allocator cannot show three different totals.

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

Each row shows the account kind dot — painted with the account's chosen colour when it has one — name, kind label, credit limit when present, a utilization bar for credit cards, the display balance and an available/owed label.

Display rules:

- credit: `max(0, −balanceCents)` labelled “owed”;
- non-credit: signed balance labelled “available”; a negative non-credit balance is styled red.

Credit utilization is `min(100, round(displayBalance / limit × 100))`, shown only when the limit is a positive number.

A credit card with its cycle recorded also prints a second line:

```text
$412.30 due · closes Oct 18 · due Nov 8
```

The amount is `max(0, last_statement_balance_cents − payments recorded since the close)`, so a payment logged early reduces it. When the APR and minimum payment are set, the row adds a payoff line — `19 mo at minimum · $263.14 interest` — or says the minimum never clears the balance when the payment cannot cover the month's interest. Missing terms print nothing rather than an estimate.

### Add / edit account

Fields:

- **Account name** — required.
- **Bank or institution** — free text with a datalist of existing institutions.
- **Type** — checking, savings, cash, investment, credit.
- **Starting balance** — create only. For credit cards the label becomes “Balance owed today” and a positive entry is stored as a negative balance.
- **Credit limit** — credit cards only.
- **APR** — credit cards only. A percentage between 0 and 100, stored in basis points; validated on the field.
- **Minimum payment** — credit cards only. The monthly figure the card asks for; drives the payoff estimate.
- **Last statement balance** — credit cards only. What the last statement asked for; drives the amount due.
- **Statement closes on** / **Payment due on** — credit cards only. Days 1–31; the due date is resolved as the first due day after the close date, so either ordering works. A hint explains that the cycle and APR drive the due queue and the payoff estimate.
- **Mine only for** — any live sinking fund, or **Nothing in particular**. Choosing a goal makes the account dedicated: its balance becomes that goal's progress, a hint explains that money parked here is spent when the goal is funded, and the account drops out of the spendable pool by default. This is the same relation the goal dialog's **Funded by** picker writes, seen from the other side; whichever end you edit last wins, and an account never funds two goals.
- **Safe to spend** — Automatic / Always count it / Never count it. Automatic follows the account type (checking, savings and cash are included; investment, credit and dedicated accounts are not), and an explicit choice wins in both directions.
- **Colour** — eight swatches plus **Automatic colour**. The chosen colour paints the account's dot on the Accounts list; *Automatic* stores nothing and lets the account type decide, so an account that has never been touched keeps the type colour and a v4 database shows no change at all.

Both purpose fields appear on create *and* edit, and are written as one pair with the colour so the dialog cannot save a purpose change without its pool consequence.

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

### Which accounts a picker offers

Not every picker lists every account, and the difference is deliberate:

- **Deposit and routing destinations** (paycheck deposit, plan moves, the account a goal's money is spent from) offer live checking, savings and cash accounts. Money has to land somewhere spendable; a credit card or brokerage account is a different instrument, not a place a paycheck is deposited, so `fundableAccounts` excludes both.
- **“Paid from” on a bill, and the account select in the entry dialog, stay wider.** A bill can legitimately be charged to a credit card, and an entry can be a transfer onto that card (paying it) or into an investment account. Restricting those lists would make real ledgers impossible to record, so every live account remains selectable there.
- **Money hints use the one currency from Settings.** Every money field formats its example with that currency (`Enter 12.34 for $12.34`) instead of a hard-coded symbol, so a EUR ledger is never explained in dollars.

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
- deposit account (defaults to the account chosen in Settings → Paycheck, falling back to the first non-archived checking account, then the first non-archived checking or savings account; the list offers checking and savings only);
- pay cadence (defaults to the saved cadence).

The step also previews the wall reserve: “Next we hold back X for the Priority Wall”, and, when a payday label is set, names the paydays — “Paydays: 15th and last day — edit this label in Settings.”

If the Same amount, date and account were already routed, the wizard shows a **duplicate warning** and the button becomes **Confirm duplicate**; only the confirming click passes `allowDuplicate`, so a double-click cannot reserve the wall twice.

Validation before advancing: the amount must be greater than zero. The commit also requires a deposit account.

### Step 2 — Priority Wall

Shows:

- the number of active bills;
- the total reserve for the selected cadence **on the pay date entered in step 1** — a bill scheduled onto one paycheck appears at its full monthly figure there and at nothing on the other check of the month;
- an expandable per-bill breakdown that lists every active bill, showing **$0.00** for one an earlier cheque already claimed this month or one already paid this month, so it is not charged twice;
- true surplus = income − funded wall;
- a shortfall warning when the wall exceeds income.

Payments count when they fall in the **same calendar month as the pay date**, not the day the screen is read: a cheque dated 13 November is not released by a payment made on 31 October, and one dated 31 October is.

A shortfall does not block the wizard, but the plan has no surplus and every split is zero. Committing such a paycheck is allowed; it records the partial wall funding and a shortfall health value.

### Step 3 — Distribute

Four percentage controls, each with a slider and a number input:

- savings;
- investments;
- sinking funds;
- debt payoff.

All are clamped to 0–100 by the component and by the domain layer. The component also caps each control at **100 minus the other three**, so the four can never total more than 100%: with debt at 90, the other three sliders stop at 10 and typing 100 into savings snaps to 10. Space freed by one bucket is immediately available to the others.

The panel shows:

- the true surplus;
- the cent amount for each split;
- a routed-percentage summary: `splitTotal% of True Surplus`, with `100 − splitTotal` staying guilt-free, or an over-allocation warning;
- “Round every bucket to whole dollars”;
- the guilt-free amount;
- goals funded from this check, with remaining need;
- plan warnings.

If the splits add up to more than 100%, the route button is disabled and labelled “Splits exceed 100%”. The pure allocator would scale them proportionally, but the per-control cap means the UI cannot reach that state; the guard stays for imported or hand-written settings that already total more.

The step also states what the button does: WageRoute records the plan against the deposit and does not move money between accounts or pay bills. There is no paired transfer behind a route; the ledger entries that move money are the ones the user records ([ADR 0013](decisions/0013-a-route-is-a-plan-not-a-movement.md)).

### The algorithm

In order:

1. Clamp income to ≥ 0 and round to cents.
2. Compute the Priority Wall reserve from **active** bills, the selected cadence and the paycheck's own date (`billFundingReserveCents` per bill), passing the payments dated in the pay date's month and already linked to the bill so a fully paid bill withholds nothing and a part payment withholds only the remainder.
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

- **Transactions (N)** — the editable ledger. `N` is the number of entries matching the current filter, so it changes as the filter does and is not capped at the page.
- **Next 90 days (N)** — a read-only projection.

The hint text changes with the tab.

### Ledger grid

The ledger is queried, not filtered in the renderer: every filter, the sort and the page go to `transaction:query`, which returns one page of rows and the number of matches. The grid therefore holds 100 rows at a time and can page through the whole table, not the 500-row snapshot.

**Filter bar** (`role="search"`, labelled **Filter the ledger**): a search field matching description or category text, From and To dates, Account, Kind, Category and Sort — **Newest first**, **Oldest first**, **Largest amount** (by absolute value) or **Smallest amount** — plus **Clear**. Changing any filter resets to the first page. The empty state offers **Clear the filter**; with no entries at all it offers an add action.

**Columns:** Date, Account, Kind, Category, Description, Amount, delete action.

- Click or double-click a cell to edit in place.
- Date uses a native date input and accepts only `YYYY-MM-DD`.
- Account and Kind use selects; both are read-only on a paired transfer row.
- Category is a text editor with a `datalist` of existing category names; the typed or picked name is resolved back to its category id, so reports stay grouped. Description uses a plain text editor.
- Amount parses through `parseMoneyToCents`; invalid input cancels the edit.
- Each changed cell produces a patch containing only the fields that changed, then calls `updateTransaction`.
- Delete asks for confirmation. For a paired transfer, the prompt says “Delete both legs” and the repository removes the whole group.

**Paging and selection.** The footer prints the visible range (`1–100 of 520`), the page number and previous/next controls. A header checkbox selects every row on the current page only; the bar above the grid reads `N entries selected` and offers **Clear selection** and **Delete selected**, which asks one confirm (`Delete 3 entries?`) and removes exactly those rows. A selection does not survive a page change or a new filter.

### Projections

`projectUpcoming` runs over active bills and all goals for the next 90 days:

- **Bills** start at `nextDueOn` when it is on or after today, otherwise at the next occurrence of `dueDay`. They repeat by frequency up to the horizon, with a guard of 400 occurrences per bill.
- **Goals** appear when they have a target date within the horizon and a positive remaining amount. The row amount is the remaining amount, not the target.
- Rows are sorted by date, then name.
- The grid is read-only and shows Date, Type (Bill/Goal), Name, Category, Amount.

### Add entry dialog

Fields: date, account, kind, destination account (transfers only), amount, category, description. Category offers the existing category names as a `datalist` and resolves the typed text to its id; a new name becomes a new category through `ensureCategory`.

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

Transfers create both legs, and an expense may trigger a round-up. The dialog closes only once the store has confirmed the write; a rejected save keeps the dialog open with its error in place.

### Empty states

- No ledger rows: “No entries yet” with an add action.
- No projections: the grid simply renders zero rows.

---

## Settings

### Appearance

Three choices in the sidebar, presented as a radio group — **System**, **Light**, **Dark** — with the resolved state printed beside the label (`System · light`). It is one tab stop: the arrows move the selection between options, Home and End jump to either end, and only the checked button is in the tab order. System follows `prefers-color-scheme` and switches live across a running app, because the preference is read through `useSyncExternalStore` rather than sampled once at startup. The resolved theme is written to `document.documentElement.dataset.theme` and cached in `localStorage['cfr-theme']` so the next launch paints the right palette immediately. Settings remain the source of truth; the cache is only a first-paint hint.

### Money

- **Currency** — the code every amount is formatted in. The select offers the common ledger currencies above; a backup that carries another valid ISO code keeps it and is listed rather than silently replaced. `parseSettings` rejects anything that is not a three-letter code `Intl` knows, so a typo cannot become a ledger that shows one currency and no error.
- Changing the currency changes the symbol, grouping and decimal places only. Amounts already recorded are **not** converted and no exchange rate is fetched; a ledger kept in euros but switched to dollars reads the same numbers with a different sign.

### Round-up

- Toggle “Round up debit spending”. It is disabled when no active savings account exists, with a shortcut to Accounts; turning it on preselects the first active savings account.
- Choose the destination savings account. When the saved destination is archived or is no longer a savings account, the switch reads off and the select says the destination needs re-choosing before sweeps resume; when no destination was ever chosen, the select simply asks for one.
- Choose the increment: 1, 2 or 5 in the ledger's currency, labelled with its symbol (`$`, `€`, `£`, `CA$`, …).
- The hint shows a live example in the chosen currency, e.g. “A $12.40 coffee sweeps $0.60.”

Rules enforced at write time:

- only `checking` and `cash` source accounts trigger a sweep;
- the destination must be active and must not be credit or investment;
- the destination cannot be the source account;
- the sweep is `increment − (|amount| mod increment)`, and zero when the amount is already divisible;
- the sweep is a paired transfer with category `Round-up` and memo `Round-up · <original memo>`;
- only newly created negative expenses trigger it. Editing an existing expense, importing entries and logging a bill payment do not.

### Paycheck

- **Pay cadence** — weekly, biweekly, semimonthly or monthly. It is the same setting the Priority Wall and the allocator read; the wall's summary line and the allocator's step-1 hint name it.
- **Payday label** — free text such as `15th and last day`. It is a label, not arithmetic: it appears next to the cadence on the wall and in the allocator's step-1 hint, and never changes a reserve. Saved on blur, trimmed, and an all-blank value clears it.
- **Pay schedule anchor** — one real payday as a date. Weekly and biweekly checks are projected from it, so the wall's **Next check** date and reserve column stay on the weekday the user is actually paid and a third check in a month counts as surplus. Clearing the field returns the wall to day-of-month slots. Unlike the label, this value is read by formulas; invalid dates read as blank.
- **Default paycheck account** — the deposit account the allocator preselects. The list offers active checking and savings accounts plus **First checking account**, which restores the built-in fallback. An archived or deleted pointer falls back to the first non-archived checking account rather than failing.

### Data

Three actions:

- **Export full backup** — JSON save dialog, default `~/Documents/wageroute-backup-YYYY-MM-DD.json`.
- **Export transactions CSV** — CSV save dialog, default `~/Documents/wageroute-transactions-YYYY-MM-DD.csv`. Memo, category, account name and institution are written as text cells with any leading `=`, `+`, `-`, `@`, tab or carriage return prefixed by an apostrophe, so opening the file in a spreadsheet evaluates nothing; amounts stay numeric. Importing the file back strips exactly one leading apostrophe from those cells, so a round trip returns the original text — and a memo that genuinely begins with an apostrophe keeps it.
- **Import data** — open dialog accepting `.json`, `.csv`, `.ofx` and `.qfx`, then the import wizard. A CSV with no Account column and any OFX/QFX file are read as a bank statement.

Both exports are written to a temporary file, flushed and renamed into place, so a failed or interrupted export leaves the previous file untouched instead of a half-written one. The file is created mode `0600` on macOS and Linux; on Windows it inherits the user profile's ACL.

### Import wizard

The wizard has three steps — choose file, missing info, review — and the same component serves the first-run "Import a backup" button on the dashboard.

- **Missing info** shows one card per row that cannot import as it stands, with an editor per question: text, amount, whole number, date, an enum dropdown, or a dropdown of local rows for a foreign key (with **Leave unlinked** where the column allows NULL). CSV account names that match nothing are grouped into one question per name covering every line that shares it.
- **Bank statements** (OFX 1.x/2.x, QFX, and any CSV without an Account column) are read as one account's history: the wizard prints the bank, masked account number, covered date range and closing balance, lists lines it left out (bad dates, zero amounts, transfers), and asks a single question — which local account these lines belong to. Nothing is pre-selected and **Import** stays disabled until you answer, because a statement's account number is not a local account name and a guess would post money into the wrong balance.
- Each card offers **Leave this row out** (or **Leave these lines out** for CSV). Filling an answer in patches the row; leaving it blank drops the row instead of failing the import.
- **Review** names what is being imported, echoes the values you supplied, and lists everything not imported with every reason on that row plus how to fix the source file. A warning counts rows still incomplete before you confirm.
- A file with nothing missing skips straight to review, so a clean WageRoute backup is still one click.
- Rows that pass the wizard but break a database rule anyway are reported individually; the rest of the transaction commits.

The file path stays in the main process between the two steps — the renderer only ever holds a single-use token. See [docs/IMPORT-EXPORT.md](IMPORT-EXPORT.md#the-import-wizard).

The database path is displayed below the actions. The sidebar footer shows the running version instead — `WageRoute v1.1.0` — with the full database path as its tooltip.

### About

- **Version** — `app.getVersion()`, the version baked into the running bundle, delivered over the `app:info` IPC channel. It is *not* read from the checkout's `package.json` at runtime, so a build launched from `release/` reports the version it was packaged as.
- **Database schema** — `SCHEMA_VERSION`, the last migration this build applies. A database at a lower `user_version` is migrated on launch; one above it is refused before any window opens, and the file is left untouched.
- **Electron** — the runtime version the bundle carries, useful when a bug could be a runtime bug.
- **Buy me a coffee** — an `https://buymeacoffee.com/revax` link with `target="_blank"`. The main process denies in-app windows and hands `http(s)` URLs to the system browser, so the app never navigates away from the ledger.
- **Licence** and **Third-party notices** — open the packaged `LICENSE` and the generated `THIRD-PARTY-NOTICES.txt` in a scrollable dialog instead of sending the user to the repository. Both files are copied beside the packaged app as extra resources, so a build always carries the texts it is required to.

### Diagnostics

A **Diagnostics** card next to About prints version, schema, Electron/Chromium/Node, platform and architecture, whether the build is packaged, the database path and size, the backups and log paths, the last lines of `logs/main.log`, and how many rows each imported table currently holds. **Copy diagnostics** puts that report on the clipboard, and **Show details** reveals it as selectable text. Every value comes from the running process (`app.getVersion()`, `process.versions`, the live database), not from the checkout, so the report describes the binary in front of the user.

### Danger zone

**Erase all data…** starts a two-step confirmation. The first dialog explains what is deleted (every account, bill, sinking fund, paycheck and ledger entry, plus settings) and that exported backups and CSV files are untouched; **Continue** opens a second dialog with a final **Erase everything** button. The erase wipes the database, re-seeds a blank local user with default settings, and returns to the dashboard in the same blank state as a first launch.

The erase is physical, not a tombstone: every row is dropped and the file is compacted (`VACUUM`), so the previous contents are not recoverable from free pages or the write-ahead log. Before the wipe the main process writes one last-resort copy with `VACUUM INTO` to the app's `backups` folder (`pre-erase-<timestamp>.db`, newest three kept), and the dialog says so — a user who erases by mistake has a way back, and a user who wants the data gone can delete that file too. The live ledger itself cannot be recovered. A single row deleted elsewhere in the app is different: it is soft-deleted and still present in backups.

### Safety copies

When a build opens a database from an older schema, it writes a consistent copy to `backups/` in the app data folder before migrating, named `pre-upgrade-<from>-to-<to>-<timestamp>.db`. The newest three are kept. If the database fails SQLite's `quick_check` at launch, WageRoute refuses to open or change it and says so rather than migrating a damaged file.

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

- **Yes, it cleared** posts a `bill_payment` for the bill amount on its linked account, or a fallback checking/first active account when no account is linked. If the linked account has been archived, the prompt is blocked instead: it says the account is archived and asks you to edit the bill, because a payment into an archived balance would leave every total unchanged. The date is the due date, the memo is the bill name and the category is copied from the bill. This does not advance `nextDueOn`; the next cycle is derived from the due day.
- **Not yet** snoozes that occurrence, keyed by bill and due date, so next month's prompt still appears. Snoozed rows move to a **Snoozed** list under the open prompts with a **Bring back** button. Snoozes are session-only and reset on restart.

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

- Success messages are toasts, auto-dismissed after 4.2 seconds; errors stay until dismissed, because an error is a fact the user has to read. Hovering or focusing a toast pauses its timer, so it does not vanish mid-read.
- A toast is a live region — `role="status"` for success, `role="alert"` for errors — with a dedicated **Dismiss notification** button. Its text is selectable, so an error can be copied into a bug report.
- Destructive actions — deleting a bill, a goal, a ledger row or a selection, and a grid edit that changes an entry's kind or account — use one styled `askConfirm` dialog that names the consequence. Import uses a confirmation before opening the file picker.

### Keyboard, focus and dialogs

- **One dialog model.** Every dialog — account, bill, goal, entry, erase, allocator — is built on the same `useDialog` hook: focus moves into the panel on open, Tab and Shift+Tab cycle within it, Escape closes it, the page behind is scroll-locked, and focus returns to the element that opened it.
- **Named by their heading.** `Modal` and the allocator panel set `aria-labelledby` to their visible `<h2>` and `aria-describedby` to their subtitle, using generated ids, so a screen reader announces the dialog's real name rather than a duplicated `aria-label`.
- **Backdrop clicks are deliberate.** A dialog closes only when the press *starts and ends* on the backdrop, so a drag that begins inside the panel and releases outside does not discard the form.
- **The allocator cannot be dismissed mid-write.** While a route is saving, Escape, the backdrop and the close button do nothing; the write finishes or fails visibly first.
- **Skip to content.** The first Tab from the window chrome reveals a **Skip to content** link that jumps to the workspace, bypassing the sidebar.
- **Visible focus everywhere.** `:focus-visible` draws a two-pixel accent ring on every interactive control, including the spreadsheet's cell editor and the allocator's income field.
- **Import wizard steps are labels.** Only a step you can actually navigate back to is a button; the current step is a non-interactive `aria-current="step"` marker, so clicking a step marker can never reopen the native file picker.
- **Per-row pending state.** Logging a bill payment disables only that prompt's buttons and shows *Logging…* there; the other prompts stay usable.

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
| Credit accounts, limits and utilization | Implemented | Credit limit and utilization |
| Card terms: APR, minimum payment, statement cycle | Implemented | Payoff estimate is arithmetic on the entered terms; no statement download |
| Paired transfers | Implemented | |
| Round-up sweeps | Implemented | Expense creation only |
| Bill payment prompts | Implemented | Session-only, per-occurrence snooze |
| 90-day projections | Implemented | Bills and goal deadlines |
| Dark/light/system themes | Implemented | Tri-state, follows `prefers-color-scheme` live |
| JSON backup, partial JSON import | Implemented | Additive |
| CSV export and entries import | Implemented | Export covers the whole ledger; Debit/Credit columns are read |
| Bank statement import (OFX/QFX, account-less CSV) | Implemented | Destinations chosen in the wizard; `FITID`/reference dedupe; balance shown, not reconciled |
| Keyboard dialogs and focus management | Implemented | Trap, Escape, focus restore, skip link, named headings |
| Multi-currency display | Implemented | Selector in Settings → Money; display only, no conversion or exchange rates |
| Bank connections / statement sync | Not implemented | Manual entry and file import only |
| Recurring transaction generation | Partial | Autopay bills are posted at launch; other bills stay a reserve model |
| Paycheck editing or deletion | Not implemented | Commit is append-only in the UI |
| Goal withdrawals or spending from a goal | Partial | Spending from a **dedicated account** lowers that goal's progress, because its balance is the progress. Allocation-funded goals have no withdrawal path — their money never left the spendable accounts |
| Debt payoff schedule / APR | Partial | Payoff months, interest and a two-year payment are computed from the entered terms; no extra-payment planner |
| Category budgets and reports | Partial | Monthly spending by category; no budgets |
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
| Impossible calendar date (`2026-02-31`) | Refused before it is written; the message asks for `YYYY-MM-DD` |
| Edit a paired transfer's account or kind | Rejected with an explanation |
| Delete one transfer leg | Both legs are soft-deleted |
| Delete an account with transactions | The dialog counts them and needs an explicit **Delete account and N entries**; **Archive instead** keeps everything |
| Archived account | Hidden from cash/credit totals and most pickers |
| Credit card overpaid | Displays zero owed; available credit is capped at the limit |
| Round-up destination is the source account | No sweep |
| Round-up on an exact dollar amount | No sweep |
| Round-up on a credit card | No sweep |
| Import duplicate transaction | Skipped by ID (JSON), by the bank's `FITID`/reference (statement), or by the fingerprint allowance (CSV without one) |
| Autopay bill whose account is archived or missing | Skipped, not guessed; the wall keeps showing it |
| Autopay bill with a part payment already logged | Posts only the remainder |
| Re-import a statement after a line was reworded | Skipped again, because the bank's id matches |
| Category deleted while entries reference it | Entries keep their text and lose the link; reports show the text |
| Card terms left blank | No amount due, no payoff estimate; nothing is invented |
| Import unknown CSV account | Row reported as an issue, other rows still import |
| Import transfer row from CSV | Reported as an issue; use a JSON backup to keep both legs |
| Import settings that already exist | Local value wins |
| Import a backup from a newer schema | Rejected with a version message |
| Open a database written by a newer build | Refused at launch with a dialog; the file is not opened or modified |
| JSON import with missing sync metadata | Filled with `now` and revision 1 |
| JSON import with a dangling foreign key | The whole import rolls back |
| Delete the database file | Packaged: next launch seeds a blank profile with the first-run prompt; development: next launch re-seeds the demo profile |

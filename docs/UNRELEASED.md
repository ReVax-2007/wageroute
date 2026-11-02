# Next release — everything queued

**This is the running list of what the next build contains.** It is not a changelog: [CHANGELOG.md](../CHANGELOG.md) records what shipped, this file records what has **not** been shipped yet and what has to happen when it is.

> **Accumulation rule.** Append to this file whenever work merges into `main` (or a branch is agreed for the release) and do **not** delete entries when they are merged — they are already released only once a tag and a build exist for them. Clear or replace this document **only** when told explicitly to tag, build, push and release. An AI doing a release should treat the version numbers, checksums and checklist below as the instruction set; nothing here authorises a release by itself.

---

## Last release

| Field | Value |
| --- | --- |
| Version | **1.2.0**, tagged `v1.2.0` at `50cab8e` and published 2026-11-02 |
| Release | <https://github.com/ReVax-2007/wageroute/releases/tag/v1.2.0> |
| Database schema | `8` — upgrades 3 → 4 → 5 → 6 → 7 → 8 on first launch, forward-only, no downgrade |
| Backup format | writes `8`, accepts `2`–`8` |
| Assets | `WageRoute-1.2.0-arm64.dmg`, `WageRoute-1.2.0-x64.dmg`, `WageRoute.Setup.1.2.0.exe`, `WageRoute-1.2.0.portable.exe`, `WageRoute-1.2.0-{x64,arm64}.{msi,zip}`, `WageRoute-1.2.0-{x86_64,aarch64}.rpm`, `WageRoute-1.2.0-{amd64,arm64}.deb`, `WageRoute-1.2.0-{x86_64,arm64}.AppImage`, `SHA256SUMS` |
| Homebrew | `ReVax-2007/homebrew-wageroute` at `1.2.0` (`0e10e3b`), Intel URL now `WageRoute-#{version}-x64.dmg` |
| Verification | The **CI-built** arm64 DMG was downloaded from the published release, its SHA-256 checked against `SHA256SUMS`, then mounted and launched on a disposable profile: blank schema-8 ledger, sidebar `WageRoute v1.2.0`, licence and third-party notices bundled, ad-hoc signature valid. The same bundle opened a **copy** of the live schema-6 database: `user_version` 6 → 8, all 25 original transactions unchanged, 12 accounts / 4 bills / 3 goals / 2 paychecks intact, 3 dead draft settings removed, 22 categories and 12 balance snapshots backfilled, and the migrated ledger rendered on the dashboard. CI installed, launched, reinstalled over itself and uninstalled the MSI, and booted the AppImage and deb under xvfb. All four platform builds green; the release carries a `SHA256SUMS` that lists every asset except itself. **Not hand-launched:** the Intel DMG, NSIS, portable, zip, MSI and Linux packages; no screen-reader pass; unsigned and not notarized |

Two tags were replaced before publication, and nothing was ever distributed from the failed ones: the first `v1.2.0` build stopped in NSIS because `installerIcon` pointed at a PNG (`invalid icon file`), and the second built every platform but its tag-only release job ran `gh` without a checkout and hashed its own `SHA256SUMS`. Both fixes are in the tagged tree (`#45`, `#46`).

The `[1.2.0]` block in [CHANGELOG.md](../CHANGELOG.md) is the inventory; it is released now and is not repeated here.

---

## Target

| Field | Value |
| --- | --- |
| App version | `1.2.0` — no next version chosen; `package.json` stays `1.2.0` until the next bump |
| Database schema | `10`, forward-only; the new migrations make the next release at least a minor bump |
| Backup format | writes `10`, accepts `2`–`10` |
| CI gates | `npm run lint`, `npm test`, `npm run build` and both type checks on every pull request; a tag builds all four platforms and creates a **draft** release with `SHA256SUMS` |
| macOS signing | ad-hoc only; no notarization, so Gatekeeper still needs **Open Anyway** or a locally copied DMG |

---

## Queued

Work merged to `main` after `v1.2.0`. None of it is in an installer yet; the `[Unreleased]` block in [CHANGELOG.md](../CHANGELOG.md) is the readable inventory.

### Batch 17 — correctness

- Category lookup and text backfill compare the JS `categoryKey` instead of SQL `lower()`, so `CAFÉ` and `Café` no longer create two rows or split a report total.
- `settleEarlierBillReserves()` closes the earliest open claim when the bill is paid in the following month, while leaving each row in its own cycle and never settling a claim the later payment did not spend. (Batch 22 replaced its `last_check`-only test with the funding cheque's day-of-month; see below.)
- The goal funding-account picker follows the saved goal until touched (`draftIds`), its **Select all** state is derived from the live list, unticking 2 → 1 keeps the checklist open, and a rejected save keeps the draft.
- A failed entry count no longer pretends the account is empty; negative credit limits and statement balances now show a field error; a dialog whose trigger is gone returns focus to `#main-content`.
- `needsPreUpgradeBackup()` limits `pre-upgrade-*` copies to real version increases.

### Batch 18 — release integrity and security

- New tag-only `guard` job: the tag must equal `package.json`'s version and sit on `origin/main`.
- The `release` job refuses to replace assets on an already-published release.
- `setWindowOpenHandler` opens only `https://buymeacoffee.com/revax`; `will-navigate` and `isTrustedFrame()` share `isTrustedPageUrl()`; both permission handlers answer from `permissionAllowed()`, which allows only `clipboard-sanitized-write`.

### Batch 19 — coverage

- `src/main/window-security.test.ts` (4), `src/renderer/src/lib/finance.test.ts` (8), plus the rest of the new cases across the existing suite. `npm test` is **309 tests across thirty-eight files**.
- `package.json`'s explicit test list includes both new files; the `pretest` guard would otherwise fail every run.

### Batch 20 — documentation

- Corrected the error-notice/logging claims, the `dist:linux` architecture claim and the broken table in DEPLOYMENT, the missing `npm run lint` in CONTRIBUTING/README/PR template, the draft-release and blockmap claims in RELEASING, the in-app erase path, the migration history, and the ten-table backup count in ADR 0003.
- Updated ARCHITECTURE, SECURITY and FEATURES to describe the new allowlist and permission check.

### Batch 21 — audit follow-up

- Schema 8's backfill grouped categories with SQL `lower()` for the transaction link while the plan used the JS key; a version-7 upgrade now links every entry by id and treats `CAFÉ` and `Café` as one category. Dead `backfillCategories` in the category repository removed.
- Reserve settlement limited to one claim per payment, so a payment moved into April no longer marks an unspent March claim paid. Batch 22 later replaced the strategy-based eligibility test with the funding cheque's own day-of-month; see below.
- The tag guard fetches full history instead of `--depth=1`, which could hide a genuine ancestor of `main`.
- Permission handlers allow `clipboard-sanitized-write` so the copy buttons work; every other permission stays denied.
- Funding picker keeps the checklist open when unticking 2 → 1; goal save failure keeps the draft; account-delete dialog no longer claims zero entries when the count failed.

### Batch 22 — money, import and documentation audit

- A restored category that matches a live name by `categoryKey` now reuses the local row instead of inserting a twin, and the file's transactions are relinked to that row's id and spelling. `CAFÉ` restores into `Café`; the imported rows count as skipped, not as failures.
- A bill charged to a credit card no longer releases the Priority Wall in `commitPaycheck`: only `paid − credit` lowers the withheld total, because the debt rose rather than the cash leaving. Reserve settlement still receives every paid bill id.
- The v8 balance-snapshot backfill stops at today, so an entry dated in the future no longer inflates the launch-day net-worth point.
- Renaming a category carries the rename into `bills.category`, so autopay cannot recreate the old spelling on its next bill.
- The import wizard refuses an impossible calendar date (`2026-02-31`) instead of letting `Date.parse` roll it into March and sort the entry into the wrong month.
- The Allocator aborts before writing a paycheck when the split settings save fails, instead of routing with a split the screen no longer shows.
- `Field` still links its hint and error to the control when a `<datalist>` follows it in the same field.
- Twelve documentation corrections: selector and dialog counts, the CSP's inline-style allowance, the transaction index order, boolean and due-day settings parsing, the uncapped reference import, deposit account kinds, the lint gate's description, the restored-category rule, the settings-allowlist claim, the narrowed malformed-date claim, the external-URL description, and the `309`/`38` test count.

### Batch 22 — the reserve lifecycle remembers how it was written

- Schema 9 adds `bill_reserves.strategy` (the funding strategy in force when the cheque wrote the claim), `bill_reserves.due_day` (the due day it was written against) and `bill_reserves.settled_by` (the transaction that closed it), with a partial index on the link. The migration backfills each live row from its bill; no amount, state or date changes, and a pre-v9 database upgrades on first launch.
- The plan now receives the month's open claims (`monthClaims`) instead of a list of reserved bill ids. Every claim reduces the month's need, and a spread cheque tops the month up to its normal share. Switching a carried bill to every-check no longer reserves the month twice, switching a spread bill to one check reserves only the remainder, and a third switch reserves nothing more.
- A payment in a later month settles an earlier claim when that claim's funding cheque fell **after** the bill's due day in its own cycle — the real carry rule. It is no longer limited to `last_check`: a monthly `first_check` cheque on 31 January funds a 1 February due date. A payment dated before the new month's cheque settles the carry, not the new claim, because that cheque had not been received yet.
- Deleting or moving a payment re-opens exactly the claim `settled_by` names, then falls back to the old cycle lookup for rows paid before v9.
- A restored reserve row takes its bill's strategy and due day when the file states neither, and starts with no `settled_by` link. The example backup and the backup allowlist carry the columns.
- `src/main/db/reserves.test.ts` gains five lifecycle cases (carry under `first_check`, payment-before-cheque ordering, delete re-opening the carry, and both strategy switches), `migrations.test.ts` gains the v9 case, and `backup-merge.test.ts` proves a restored claim takes its bill's strategy unless the file states one.

### Batch 23 — settle, reopen and display the same claim

- The commit backstop now skips a payment already named by `settled_by`, so one payment can no longer close two months of carry. `reopenCycleClaim` touches only unlinked rows, so deleting or moving one payment leaves a claim another live payment closed paid.
- Every claim reduces the month's remaining need, whatever strategy wrote it. `billFundingReserveCents` tops a spread bill up to its normal share when a claim exists (smoothing a partly paid bill across the cheques still to come), and `recordBillReserves` caps a month's open claims at the bill's monthly equivalent.
- Each claim stores its own `due_day`; a later edit to the bill cannot change whether an old claim carries.
- The Priority Wall passes this month's cash payments and open claims into the next-check projection, and reports reserved and paid claims as separate sums instead of counting paid money as reserved.
- The Allocator preview subtracts `creditCents` from `paidCents`, matching `commitPaycheck` for a bill charged to a card.
- Restore refuses a nameless category or one longer than 60 characters instead of writing a row the app cannot save, and relinks an entry that names its category only by spelling.
- New cases: four in `reserves.test.ts` (one payment one carry, delete leaves another payment's claim paid, third switch reserves nothing, due-day edit), four in `backup-merge.test.ts` (stated due day, nameless category, long name, text-only relink), and the v9 migration asserts the due-day backfill. `npm test` is **324 tests across thirty-eight files**.

### Batch 24 — pay only what the money covers

- A payment now closes only the claims its own amount fully covers, oldest first. Same-cycle settlement used to mark every open instalment `paid`, so a single 60,000 payment closed 120,000 of claims. A claim is never part-paid: a payment smaller than the next claim leaves it open.
- `recordBillReserves` caps a month on its **open** claims. A claim closed by a card charge no longer blocks the cash reserve the plan asks for, so the allocator and the writer agree again.
- After a payment lands mid-month, `billFundingReserveCents` divides the remaining need across the guaranteed cheques still to come. A 120,000 bill with 60,000 paid before the last semimonthly cheque now withholds 60,000, not 30,000. (Batch 26 counts the real anchored series instead of the guaranteed slots; see below.)
- A pre-v9 payment with no `settled_by` link re-opens the earlier carried claim it closed, not only a row in the payment's own month.
- New cases: four in `reserves.test.ts` (an instalment-sized payment, a short payment, a card-closed claim, a legacy carry re-open), two in `cadence.test.ts` (mid-month and monthly recovery), the v9 migration's due day is now 28 so the backfill is actually exercised, and the restored-reserve case inherits a due day of 30. `npm test` is **330 tests across thirty-eight files**.

### Batch 25 — the wall says which money is still open

- A month with one paid instalment and one open claim used to print **Paid this month**, because any paid row won the chip. It now reads **Reserved** while anything is open and **Paid** only when every claim for the month is closed; the summary above the table already reported the two sums separately.
- The Priority Wall and the dashboard passed their own `<tbody>` to `DataTable`, which supplies one, so both pages contained a nested body and React reported a hydration error. They now pass rows only.
- New `PriorityWall.test.ts` mounts the wall in jsdom: the mixed month reads **Reserved**, a closed month reads **Paid**, the summary prints `$600.00 reserved this month · $600.00 paid`, the next check keeps only the $300 a cash payment and a claim leave owed, and the table has exactly one `<tbody>`. `npm test` is **333 tests across thirty-nine files**; lint 127 files.

### Batch 26 — derive claim states from the payments

- Claim states are now **derived** by `reconcileBillReserve`, which replays every live bill-linked transaction for the bill in date order. The incremental settle/reopen functions (`settleBillReserveForPayment`, `settleEarlierBillReserve`, `settleEarlierBillReserves`, `reopenBillReservesSettledBy`, `reopenCycleClaim`) are gone.
- **A bill paid in instalments settles.** Two 60,000 payments now close a 120,000 claim; the old matcher broke on the first claim larger than one payment, so the claim stayed `reserved` forever and the wall printed reserved and paid money for the same bill. `settled_by` names the payment that completed it.
- **A refund is not a payment.** A positive bill-linked row takes coverage back from the most recent contribution instead of closing a claim, so a refunded month reads `reserved` again.
- **Deleting or moving one payment cannot disturb a claim another payment paid.** Previously a linked v9 delete also ran the legacy cycle fallback, which re-opened an unrelated unlinked claim. Replaying the remaining payments leaves the other claim paid and renames the payment that covers it.
- **An empty claim no longer blocks the queue.** The carry loop stopped at the first zero-cent claim, which kept every eligible claim behind it reserved; the replay skips non-positive claims.
- **The commit backstop replays every bill** (`reconcileAllBillReserves`), including a merged backup, and `mergeBackup` runs it once at the end, so a partial restore's claims and payments agree without a manual edit.
- **A fifth weekly or third biweekly cheque counts.** `remainingChecksInMonth` used the guaranteed slot count and treated a real later cheque in the same month as if it did not exist, concentrating a part-payment's remainder on one cheque and risking an all-or-nothing shortfall. With a payday anchor it now counts the actual series; without one, the guaranteed fallback is unchanged.
- The month's cap still counts **open** claims only. That is deliberate: a claim closed by a card charge released its earmark but did not take cash out of the pool, so the later cheques still have to cover the bill's cash obligation. The card case in `reserves.test.ts` pins it.
- New cases: instalments closing one claim, the legacy unlinked claim surviving a linked delete, a refund re-opening its claim, a zero claim skipped, and anchored weekly/biweekly remaining-cheque counts. `npm test` is **339 tests across thirty-nine files**; lint 127 files.

### Batch 27 — the wall shows only money still owed

- **One annual or quarterly payment clears every slice it covers.** A 1,200,000 annual premium gathered twelve 100,000 claims from twelve cheques but the old carry rule required the cheque's day of month to fall after the bill's due day, so the single payment closed one slice and left eleven reading `reserved`. Smoothed bills now walk every earlier claim whose cheque had arrived, whatever the due day.
- **The wall says what the next check still owes.** A bill already covered this month shows $0.00 and **Nothing more due** instead of naming a check that has nothing left to do; a paused bill shows $0.00 and **Paused** instead of a reserve it will never take.
- **The table fits its card.** Seven columns of nowrap money plus a long funding hint forced a horizontal scroll and pushed the numbers out of the card. Amount, cadence and due day now sit under the bill name, leaving four columns, and only the numeric cells refuse to wrap.
- **The allocator's breakdown hides settled lines.** Bills whose reserve is zero are left out, with one line saying how many are already covered this month, so a paid wall no longer looks like an open question.
- **A bill-linked adjustment is not a payment.** `listBillPaymentsThisMonth` now reads only `bill_payment` and `expense` rows, and accepts an as-of day so a future-dated entry does not release a month before it happens. `commitPaycheck` passes the cheque's own date.
- **A refund cannot grow the wall.** The renderer's paid-per-bill map clamps at zero, matching the repository, so a net-positive bill no longer increases what is withheld.
- **Deleted parents stop counting.** `claimsThisMonthFor` and `recordBillReserves` join live bills and cheques, the wall filters claims to live bills, and deleting an account now replays the claims its payments used to hold open.
- New cases: an annual payment clearing every slice, a bill-linked adjustment ignored, the as-of ceiling, and deleting the account re-opening the bill, plus three jsdom cases for the zero, covered and paused rows. `npm test` is **345 tests across thirty-nine files**; lint 127 files.

### Batch 28 — inputs, cards, buffers and goal pace

- **Every money field is a money field.** Bill, entry, goal, account, paycheck-card and adjustment amounts now use `MoneyInput`, which keeps digits, the first decimal point and at most two decimals, and shows an on-screen keypad on phones. Percent fields use `PercentInput`; the allocator's income field and the spreadsheet's inline amount editor share the same sanitiser. An entry can still be negative, but the minus sign is only accepted at the start.
- **An adjustment carries a reason.** The dialog offers mistake, rounding, interest earned, interest charged, investment gain and investment loss, filtered to the account kind. The reason chooses the memo and category (`Interest earned` → Income, gain/loss → Investing), and a gain that lowers the balance or a loss that raises it is refused rather than mislabelled.
- **A card can be adjusted by what is owed, what is available, or how full it is.** The adjust dialog on a credit account offers three modes: balance owed, available credit, and utilisation percent. Each resolves to a target owed amount and previews the balance, available credit and utilisation that will be saved; available credit and percent are clamped at zero.
- **The emergency fund can carry a manual buffer.** Auto mode adds an optional extra cushion (`emergencyBufferCents`) on top of months × essentials, for one-offs the monthly average misses. Blank, negative and non-finite values add nothing, and zero essentials still honours the buffer.
- **One-time income has its own section.** The dashboard lists this month's income entries that are not paychecks (`transactions.paycheck_id IS NULL`), with a total and an **Add income** dialog. The money is written to the ledger and deliberately stays out of paycheck routing.
- **A goal can be paced or paused.** Schema 10 adds `goals.funding_pace`: `asap` funds the remaining need on the next cheque, `by_date` caps each cheque at `ceil(need / checksLeft)` so the goal still arrives by its target date, and `paused` removes it from the allocator entirely. The goal dialog sets the pace next to priority; the goal card has a pause/resume button and chips for **Funding paused** and **Paced to <date>**. Existing goals default to `asap`, so an upgrade writes the same allocations it did before.
- New cases: five sanitiser cases in `money.test.ts`, four buffer cases in `emergency.test.ts`, three allocator cases in `domain.test.ts` (paused goal, paced goal, paced goal with no target date), four adjustment-reason cases in `adjustments.test.ts`, and the v10 migration case (existing goal defaults to `asap`, the CHECK refuses an unknown pace). `npm test` is **362 tests across forty-two files**; lint 132 files.

### Batch 29 — the screens speak plain English

- Navigation reads **Home**, **Bills**, **Goals**, **Accounts**, **Spreadsheet**, **Settings**; the Priority Wall screen is titled *The bills that come first* and the goals screen *Save for what is coming*.
- **Sinking funds** became **Goals**, **guilt-free money** became **Fun money**, **true surplus** became **Left to split**, **safe to spend** became **Left to spend**, and *reserved* became *set aside*. The allocator's steps are **Income → Bills → Split it up**, with buttons that name the action.
- Every allocator warning, dialog hint and empty state is rewritten as plain sentences; the paycheck plan stores its saved lines as **Bill money** and **Fun money**.
- Internal identifiers are untouched: screen ids (`wall`), bucket keys (`priority`, `savings`, `leisure`), selectors and schema stay as they were, so existing databases and backups are unaffected. `PriorityWall.test.ts` and `Allocator.test.ts` assert the new copy.

### Before the next build

- [x] Run the four gates on the final tree: `npm run lint`, `npm test`, `npm run build` (includes both type checks), and `npx electron-builder --dir --publish never`. *(2026-11-02, Batch 27: lint 127 files clean, 345/345 tests, build clean; packaging re-run below.)*
- [ ] Launch a packaged build on a disposable profile and confirm the Buy Me a Coffee link still opens and no other external URL does (no child window, no navigation).
- [ ] Re-check the Priority Wall after a cross-month bill payment: the old month's row reads `paid`, not `reserved`; then move the payment to the next month and confirm the source month reads `reserved` again even after the next cheque commits.
- [x] Open a copy of a schema-8 database with the new build: it must migrate to 9, keep every reserve row and amount, and show the same wall on first launch. *(Verified 2026-11-02: a scratch schema-8 database migrated through the built app — two reserve rows kept their amounts, `strategy` and `due_day` backfilled from the bill, `settled_by` null, partial index present — and the booted app rendered the wall.)*
- [x] Switch a bill from first-check to every-check between two cheques and confirm the second cheque reserves nothing for it; switch a spread bill to one check and confirm the second cheque reserves only the remainder; switch it back and confirm a third cheque reserves nothing. *(Verified 2026-11-02 over CDP on a disposable profile against the `out/` build; the stored claim kept its own strategy and due day while the bill changed.)*
- [ ] Route two cheques across two months, pay the bill once, then commit a third cheque: only one month may read `paid`. Delete that payment and confirm the other month's paid claim is untouched.
- [ ] Edit a bill's due day after a carry has been claimed and confirm the next payment still closes that carry.
- [ ] Open the allocator for a month with a card-paid bill and confirm its preview priority matches the recorded paycheck; then check the wall's next-check figure subtracts the same cash payment.
- [x] Remove `settled_by` from one reserve row in a scratch copy and confirm the delete/move path still re-opens the claim by cycle. *(Covered by the `deleting a pre-v9 payment re-opens the claim it carried` case in `reserves.test.ts`, which nulls the link and deletes the payment.)*
- [ ] Launch a packaged build and copy an entry id from Settings/About to the clipboard: the permission handlers allow only `clipboard-sanitized-write`, so a denied copy would now show up as a silent no-op.
- [x] Confirm the tag guard fires if `package.json` and the tag disagree (a scratch tag, deleted before push). *(2026-11-02: the workflow's two checks were run locally against the tree with `GITHUB_REF_NAME=v9.9.9` — exited 1 — and `v1.2.0` — matched and found on `main`; no tag was created or pushed.)*
- [ ] Choose the next version. Schemas 9 and 10 are new migrations, so the next release is at least a minor bump; the tag guard requires the tag to match `package.json`.

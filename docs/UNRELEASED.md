# Next release — everything queued

**This is the running list of what the next build contains.** It is not a changelog: [CHANGELOG.md](../CHANGELOG.md) records what shipped, this file records what has **not been shipped yet** and what has to happen when it is.

> **Accumulation rule.** Append to this file whenever work merges into `main` (or a branch is agreed for the release) and do **not** delete entries when they are merged — they are already released only once a tag and a build exist for them. Clear or replace this document **only** when told explicitly to tag, build, push and release. An AI doing a release should treat the version numbers, checksums and checklist below as the instruction set; nothing here authorises a release by itself.

---

## Last release

| Field | Value |
| --- | --- |
| Version | **1.1.0**, tagged `v1.1.0` at `fa40d74` and published 2026-10-29 |
| Release | <https://github.com/ReVax-2007/wageroute/releases/tag/v1.1.0> |
| Database schema | `6` — upgrades 3 → 4 → 5 → 6 on first launch, forward-only, no downgrade |
| Backup format | writes `6`, accepts `2`–`6` |
| Assets | `WageRoute-1.1.0-arm64.dmg`, `WageRoute-1.1.0.dmg` (Intel), `WageRoute.Setup.1.1.0.exe`, `SHA256SUMS.txt` |
| Homebrew | `ReVax-2007/homebrew-wageroute` at `1.1.0` (`7850918`) |
| Verification | arm64 build launched and migrated a **copy** of the live schema-5 database 5→6 with identical counts and unchanged wall figures ($492.69 / $227.40); installed over the live app on 2026-10-29 (snapshot in `.local-backups/2026-10-29-pre-1.1.0-install/`, old bundle in `.local-quarantine/2026-10-29-pre-1.1.0-install/`), live `wageroute.db` now at `user_version` 6 with every count unchanged; Intel DMG and Windows installer never launched |

The `[1.1.0]` block in [CHANGELOG.md](../CHANGELOG.md) is the inventory; it is released now and is not repeated here.

---

## Target

| Field | Value |
| --- | --- |
| App version | **undecided** — at least a minor bump once the audit batches land |
| Database schema | `7` — the v7 upgrade is queued in batch 2 |
| Backup format written | `7` |
| Backup format accepted | `2`, `3`, `4`, `5`, `6`, `7` |
| `package.json` today | `1.1.0` — bump it **inside** the release branch, never before |

A patch is the default for fixes with no schema change; anything that adds a migration is at least a minor bump ([semver policy](RELEASING.md#semver-policy)).

---

## Queued

### Data integrity and safe saves — batch 1 of 4 from the 2026-10-29 audit

The first of four batches that clear [AUDIT-2026-10-29.md](../AUDIT-2026-10-29.md). No schema change: everything here is a rule, a guard or a state the UI can now reach.

- **Archive instead of delete, for accounts and goals.** Both screens list archived rows in their own card with **Restore**; an archived account leaves every total, the Safe-to-Spend pool and the allocator but keeps its own balance and history, and an archived goal gets no slice of a paycheck, no funded progress and no earmark in the pool. Deleting a goal is a second, deliberate step from the archived list.
- **Account deletion counts its entries.** `RemoveAccountDialog` asks the main process how many entries the account holds and offers *Archive instead* / *Delete account and N entries* / Cancel. `deleteAccount` refuses a delete with entries unless `withEntries` is passed, and that path soft-deletes both legs of every transfer touching the account.
- **One sign rule for money.** `src/shared/kinds.ts` is the single table: income positive, expense/bill payment/transfer/goal funding/investment negative, adjustment either. The CSV parser derives the sign, the importer reports rows that still contradict their kind, and `createTransaction` normalises on write. `updateTransaction` refuses to turn an entry into a transfer or a transfer leg into something else, and mirrors date/amount/text edits onto the paired leg. The spreadsheet makes **Account** and **Kind** read-only on transfer rows.
- **Dialogs close only on success.** Every store mutation returns `Promise<boolean>`; the account, bill, goal, entry and payment dialogs stay open with their error when a save fails. Writes run through one serial queue, and `saveSettings` rolls back its optimistic value on failure.
- **Legacy adoption is atomic and verified** (`src/main/db/legacy.ts`): header check, staged copy, `PRAGMA quick_check` on a read-only handle, sidecars renamed first, cleanup on failure, and a dialog that says the old folder was left untouched.
- **CSV import fails loudly on an unclosed quote**, naming the line the quote starts on.
- **Exports read the whole ledger** (`listAllTransactions`) instead of the 500-row screen snapshot, and are written `0600`.
- **Tests:** four new files — `src/shared/kinds.test.ts`, `src/shared/csv.test.ts`, `src/main/db/legacy.test.ts`, `src/main/db/ledger-guards.test.ts` — 25 cases, `npm test` at **98 tests across twelve files**.

Verification: `npm test`, `npm run typecheck` and `npm run build` clean; the built app launched on a disposable `CFFIXED_USER_HOME` profile and driven over CDP — archive → archived card → restore for both an account and a goal, the remove dialog reading *"its 2 entries"* with all three choices, and the goal dialog staying open on a blank name then closing after a successful save.

### Priority Wall lifecycle and money truth — batch 2 of 4 from the 2026-10-29 audit

The second batch, and the first with a schema change. Clears L-09, L-10, L-14, C-07, C-29, C-31 (wall lifecycle and the occurrence engine), L-11, L-12, L-13 (allocation honesty), L-01/P-65 (committed meter), L-06 (per-check numbers), L-15 (obsolete settings) and PF-5 (ledger index).

- **Schema 7 adds `bill_reserves`.** One row per bill per month: `cycle` (`YYYY-MM`), `amount_cents`, `state` (`reserved`/`paid`). A fully funded route writes the rows; a shortfalling route writes none. The wall shows **Reserved this month** / **Paid this month** chips, a second cheque in the month does not re-claim a single-check bill, a bill payment flips the claim to `paid`, and editing or deleting the payment re-opens the month. Deleting a bill soft-deletes its claims.
- **Reserves travel.** `bill_reserves` is in `TABLE_COLUMNS`, `TABLE_DEFAULTS`, the importer's allowlist and the example backup; the settings export now keeps only keys the current build reads.
- **One recurrence engine.** `src/shared/occurrences.ts` (weekly, biweekly, monthly, quarterly, annual, semimonthly; anchored on `next_due_on`) now feeds the chronology prompts, the 90-day projection and the wall. Month-end bills clamp instead of drifting.
- **A pay schedule anchor.** `settings.payAnchorDate` is a real payday; `nextPaydayISO` projects weekly/biweekly checks from it, and the wall's next-check column and date use it. The free-text payday label stays display-only.
- **Partial payments surface.** The prompt reads "X of Y already matched" and logs only the remainder.
- **Duplicate deposit guard.** Same amount/date/account is refused by `commitPaycheck`; the allocator asks and passes `allowDuplicate` only after **Route it anyway**.
- **Honest plan copy.** Allocator step 3 states it records a plan and does not move money or pay bills; dashboard's committed meter is now `pool − safeToSpend` over the pool, with a >100% variant.
- **Settings cleanup.** v7 deletes the draft keys `emergencyAccountIds`, `insurance_floor_cents`, `round_up_enabled`; the live `roundUpEnabled` key is untouched.
- **Tests:** two new files — `src/shared/occurrences.test.ts`, `src/main/db/reserves.test.ts` — 17 cases, plus the partial-payment prompt case and the v7 migration test. `npm test` is now **115 tests across fourteen files**.

Verification: `npm test` (115), `npm run typecheck` and `npm run build` clean; the built app launched on a disposable `CFFIXED_USER_HOME` profile (`/tmp/wageroute-b2`) with schema 7 applied. Over CDP: set the anchor to `2026-10-02`, put Rent on *first check*, routed $4,000 on 2026-10-02 and again on 2026-10-16 — Rent reserved $1,850.00 once and $0 on the second cheque, while `all_checks` bills carried their spread each time; the wall rendered **Reserved on the next check $175.38** with **Oct 30 · Biweekly**, a **Paid this month** chip on Rent after a payment and **Reserved this month** on the others. Re-entering the same $4,000/2026-10-02 deposit produced the duplicate warning and **Route it anyway**; a $48.00 part payment on Car insurance showed *"$48.00 of $148.00 already matched"* with **Yes, log the rest**, and confirming wrote exactly $100.00 and closed the prompt. Dashboard meter read **18% of spendable cash is already spoken for**; Settings rendered the anchor date field.

### Accessibility, dialog behaviour and copy — batch 3 of 4 from the 2026-10-29 audit

The third batch. No schema change and no domain-math change: every fix is renderer behaviour, presentation or wording. It is recorded as [ADR 0014](decisions/0014-one-dialog-one-focus-model.md).

- **One dialog model.** `useDialog(onClose, active)` in `src/renderer/src/components/ui.tsx` now owns focus entry, the Tab/Shift-Tab trap, Escape, body scroll lock and focus return for the account, bill, goal, entry, erase, first-run and allocator dialogs. Focus returns to the element that opened the dialog — captured **during render**, before React's `autoFocus` moves it, which is the bug the first attempt shipped and then fixed. The allocator passes `closeIfIdle`, so Escape, the backdrop and the close button do nothing while a route is saving.
- **Backdrop dismissal is press-start plus click.** `backdropHandlers` remembers whether `mousedown` landed on the backdrop, so selecting text and overshooting the panel no longer discards the form.
- **Dialogs are named by their heading.** `Modal` and the allocator panel set `aria-labelledby` on the visible `<h2>` and `aria-describedby` on the subtitle via `useId`; the duplicated `aria-label` is gone.
- **Skip link and focus rings.** A **Skip to content** link precedes the sidebar and `<main>` is focusable; `:focus-visible` draws a 2px accent ring on every control, `.workspace`, `.modal` and `.allocator-panel` suppress the ring on their own containers, and `.alloc-income:focus-within` rings the whole income field.
- **Theme is a radio group and System is live.** Sidebar **System / Light / Dark** buttons sit in a `role="radiogroup"` with `aria-checked`, and the resolved state prints beside the label. `usePrefersLight` reads `matchMedia` through `useSyncExternalStore`, so an OS appearance change repaints without a restart. The footer renders plain `WageRoute` until `app:info` answers instead of flashing `v…`.
- **Toasts are live regions.** Success is `role="status"`, errors are `role="alert"` and no longer auto-expire; `pauseNotice`/`resumeNotice` stop the timer on hover or focus; a labelled **Dismiss notification** button replaces the whole-surface click, and `.toast-text` is selectable.
- **Contrast.** Light-mode `--text-muted`, `--placeholder`, `--text-faint`, `--accent` (now `#0a7a54`), `--savings`, `--investment`, `--goal`, `--debt` and `--leisure` were darkened to clear WCAG AA; dark-mode muted text was lifted for the same reason; `::selection` uses `var(--accent)`/`var(--accent-ink)`.
- **Layout and overflow.** `.table-scroll` lets the Priority Wall scroll inside its card at narrow widths; `.account-summary` drops to 2×2 under 1180px; account names in the ledger grid and the wall, and goal titles, ellipsize with a `title` tooltip; `.wall-table` sets a first-column width range.
- **Copy.** The spreadsheet subtitle is tab-aware (edit vs read-only forecast), the account-type hint reads *"Leave as Nothing in particular to keep it a general account"*, and a failed route says the paycheck was not routed and nothing was saved. Name inputs in the account, bill and goal dialogs carry `maxLength={60}`.
- **Import wizard steps.** The rail renders the current step as a non-interactive `span` with `aria-current="step"`, a `<button>` only for the fix step when it is reachable from review, and plain spans elsewhere — so no chip reopens the native picker and the current step is announced.
- **Per-row pending.** `BillPrompts` tracks `pendingKey` (`billId:dueOn`) instead of one global flag, so logging one payment disables only that row and shows *Logging…* only there.
- **The manual emergency target is not clobbered.** Saving any other setting used to write an empty draft over `emergencyManualTargetCents`; the goal dialog now writes the manual target only when manual mode is saved, and restores the stored value when switching from automatic to manual.

Verification: `npm run typecheck`, `npm test` (115 across fourteen files) and `npm run build` clean. The build was launched on the disposable profile (`CFFIXED_USER_HOME=/tmp/wageroute-b2`, schema 7) with `--remote-debugging-port=9335` and driven over CDP at 1060×700 using **native** `Input.dispatchKeyEvent`/`dispatchMouseEvent` — synthetic `KeyboardEvent`s cannot exercise default focus movement. Results: the Add account dialog held focus for 26 consecutive Tabs and 3 Shift+Tabs with zero escapes and 16 distinct targets, Escape closed it, and `document.activeElement` was the exact **Add account** trigger; the allocator opened with focus on `.income-input`, held 12 Tabs, closed on Escape and returned focus to **Route a paycheck**; `aria-labelledby`/`aria-describedby` resolved to the `<h2>`/subtitle; the workspace was scroll-locked (and restored) while a dialog was open; the success toast was `role="status"` with a **Dismiss notification** button and dismissing removed it; clicking **Light** then **System** repainted the document to `light` and survived a reload with `System` checked. Dark and light screenshots at 1060×700 were reviewed for Overview and Accounts. **Not verified:** nothing was exercised with a screen reader, and no automated test asserts the focus behaviour, so a regression in the trap or the return target would not fail CI.

### Running version in the app

Settings → **About** shows the bundle's own version (`app.getVersion()` via the new `app:info` channel), the schema version it applies and its Electron version; the sidebar footer shows `WageRoute v<version>`. Verification: launched the built app on a disposable profile, `getAppInfo()` returned `{ version: '1.1.0', schemaVersion: 6, electron: '45.1.0' }`, the footer rendered `WageRoute v1.1.0`, and the About card rendered all three values.

### Buy me a coffee

`https://buymeacoffee.com/revax` in Settings → About, plus a README Support section and `.github/FUNDING.yml` (`custom`) for the repository's Sponsor button. Clicking it in the running app left the window on `file://…/renderer/index.html` and opened the address in the system browser (Chrome became frontmost), so the child-window denial and `shell.openExternal` path both worked.

No schema change; both are candidates for a patch or minor bump depending on what else queues up.

---

## Deferred, not merged

### Linux and extra Windows formats — `2ef251f` (`origin/feat/linux-windows-installers`, no PR)

electron-builder additionally targets AppImage/deb/rpm for Linux x64 and arm64 and portable exe/zip for Windows, with two Ubuntu CI jobs and artifact names `wageroute-linux-x64/arm64`.

Held out of 1.1.0 on purpose: the branch has never had a green CI run and its artifacts have never been launched by anyone. Shipping a Linux format that does not start is worse than shipping none. Deciding this is still the owner's call — land it, or keep it deferred.

---

## Open gaps carried forward

1. **The import wizard's rendered flow has never been opened.** Its detection and repair rules are tested as pure code, but the wizard begins with a native file picker that CDP cannot reach. Someone has to pick a real file and walk the questions by hand.
2. **Homebrew's receipt is stale.** 1.1.0 was installed manually from the published arm64 DMG, which carries no quarantine flag, so the app opens without the Gatekeeper prompt but the cask receipt still says `1.0.2`. `brew list --versions wageroute` will disagree with the app until the next `brew upgrade --cask wageroute` — which re-installs the same 1.1.0 and, because brew downloads it, does apply quarantine.
3. **Only the arm64 macOS installer has been launched.** The Intel DMG and the Windows installer have never been started.
4. **The builds are unsigned.** macOS is ad-hoc signed only, so downloaders need right-click → Open; Windows shows SmartScreen. Signing and notarization remain undone; see [RELEASING.md](RELEASING.md#code-signing-and-notarization).

---

## Release checklist for the next release

Standard procedure is [RELEASING.md](RELEASING.md). These are the items that stay specific to this project:

- [ ] `package.json` → the target version on a `release/<version>` branch, via `npm version <version> --no-git-tag-version`.
- [ ] Move the `## [Unreleased]` block of [CHANGELOG.md](../CHANGELOG.md) under a `## [<version>] - <date>` heading and open an empty `Unreleased` section; update the `compare` and release links.
- [ ] Version sweep: [README.md](../README.md) header line, `curl` block and Homebrew line; [DATA-MODEL.md](DATA-MODEL.md); [FEATURES.md](FEATURES.md); [SECURITY.md](SECURITY.md) support table; [RELEASING.md](RELEASING.md) "current value" column; [DEPLOYMENT.md](DEPLOYMENT.md) artifact lists.
- [ ] If a migration ships: prove it against a **copy** of the live database, state in the notes that it is automatic, forward-only and irreversible, and record the new backup window.
- [ ] `npm ci` from a clean tree, `npm test`, `npm run typecheck`, `npm run build`, `npm run dist:<platform>`.
- [ ] Launch the packaged artifact on a disposable profile (`CFFIXED_USER_HOME=/tmp/...`), not on the live ledger.
- [ ] `SHA256SUMS.txt` for every installer, named exactly as GitHub publishes it (spaces in `WageRoute Setup <version>.exe` become dots).
- [ ] Tag `v<version>`, let CI build the Windows installer, then create the GitHub Release with the raw installers.
- [ ] Bump `version` **and** every `sha256` in `ReVax-2007/homebrew-wageroute`; no `--no-quarantine`, no `zap` stanza.
- [ ] After the release: reset this document, and re-verify anything it claims.

---

## Compatibility notes to carry forward

| Situation | What happens |
| --- | --- |
| 1.0.2 database opened by 1.1.0 | migrates 3→4→5→6 automatically; no row opts in, every bill lands on `all_checks`, so totals and wall figures are unchanged |
| 1.1.0 database opened by 1.0.2 or earlier | not supported — no downgrade path, do not do it |
| Backup exported by 1.1.0, imported by 1.0.2 | rejected (`version 6` > the app's `SCHEMA_VERSION`) |
| Backup exported by 1.0.2 (version 3), imported by 1.1.0 | accepted; the new columns read their defaults (`NULL` = "no explicit choice", `funding_strategy` = `all_checks`) |
| Existing goal with allocation rows | keeps counting allocations until an account is bound to it; the goal screen's **Funded by** can bind it |
| Deleting a goal that owns an account | pointer nulled, the account survives and returns to the spendable pool |
| Archiving a dedicated account | progress falls back to allocation rows; the balance counts for nothing while archived |
| Emergency fund paused | settings keep the flag; a fresh install defaults to active, and a backup without the key restores as active |
| Pay cycle, payday label, default account | settings rows, not columns: a database from 1.0.2 simply lacks them and reads the defaults (`biweekly`, no label, no default account → first checking) |
| Splits stored above 100% (imported or hand-edited) | the wizard still disables **Route** with "Splits exceed 100%"; the sliders cap at what the other three leave |

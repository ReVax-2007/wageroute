# 0033. A split transfer is ordinary transfers saved together

- **Status:** Accepted
- **Date:** 2026-11-10
- **Deciders:** Project owner
- **Related:** [ADR 0025](0025-the-phone-writes-through-the-desktops-own-rules.md), [ADR 0032](0032-a-typed-category-is-the-persons-label.md), [FEATURES.md](../FEATURES.md#transfers), [DATA-MODEL.md](../DATA-MODEL.md)

## Context

The owner banks at two banks. Each month they move one lump sum from an account at bank A into one account at bank B, then send pieces of it on to several other bank-B accounts. Recording that meant one transfer per piece, with the lump sum added up by hand before the money was moved. They want to type "from this account: $X here, $Y there, $Z there" once, see the total while typing, and save it as the matching transfers in one step.

## Decision

- **A split transfer is ordinary transfers, not a new kind of row.** `planSplitTransfer` in `src/shared/splitTransfer.ts` turns the split into a list of `transfer` entries. Each is written by the existing writer with all of its checks, as a normal linked pair. No column, table or schema version changes, and every screen, report, export and merge already reads these rows correctly.
- **All or nothing.** The desktop writes the list inside one SQL transaction (`createSplitTransfer` in `src/main/db/repo/transactions.ts`, over IPC `transaction:create-split`). The phone folds the list over its pure `createEntry` and commits once (`createSplitTransfer` in `src/pocket/lib/write.ts`). A refusal on any line leaves the ledger untouched on both devices.
- **No shared grouping id.** `transfer_group_id` stays "exactly two legs" (DATA-MODEL integrity rule 3), and a third id would need a migration and a delete-together rule for little gain. Once saved, each transfer is listed, edited and deleted on its own, exactly as if it had been entered by hand. Undoing a split means deleting its transfers.
- **The hop through bank B is the owner's choice, made per split.** The form has an optional **Through** account.
  - Left empty, each line is one transfer straight from the source. This is the net result and the right record when the bank sends the pieces directly.
  - When set, the total moves source → through account first, and each other line then moves on from there. This matches what happens at the banks when the lump sum lands in one bank-B account before it is split, so the bank-B account's history reconciles against its statement. A line naming the through account is the share that stays there, and its category and description label the first leg.
  - We recommend **Through** whenever the money really does land in one account first. It costs one extra pair, and every account's history then matches its bank statement.
- **Shared refusals.** One function, `splitTransferProblem`, gives the sentence for every refusal. The desktop form calls it while typing, and both writers call it before saving. A credit card can be neither the source nor the through account, because money leaves both, and the refusal is `CREDIT_CARD_SOURCE_REFUSAL`. Paying a card is still allowed on any line. No account may appear on two lines or be the source. Every line needs an account and a positive amount in integer cents, and a split has at most 20 lines.
- **Labels.** Each desktop line takes its own category (the `CategoryInput` from ADR 0032) and description. A blank category files the line under `Transfer`, and a blank description reads `Transfer to <account>`. Pocket's sheet takes one category for the whole split and a note per line, which is enough for the phone and keeps the sheet short.

## Consequences

- There is no migration, and a build from before this change reads a split's rows as the ordinary transfers they are.
- A split is not shown as a unit after saving. The recent-transfers list shows its transfers one by one. If the owner later wants them shown or deleted together, that needs a grouping column and is a separate decision.
- With **Through**, the through account shows money arriving and leaving on the same day. That is the record the bank shows too, and its balance only keeps the share that stays.

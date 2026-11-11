# 0033. A split transfer is ordinary transfers saved together

- **Status:** Accepted, amended 2026-11-10 (split grouping)
- **Date:** 2026-11-10
- **Deciders:** Project owner
- **Related:** [ADR 0025](0025-the-phone-writes-through-the-desktops-own-rules.md), [ADR 0032](0032-a-typed-category-is-the-persons-label.md), [FEATURES.md](../FEATURES.md#transfers), [DATA-MODEL.md](../DATA-MODEL.md)

## Context

The owner banks at two banks. Each month they move one lump sum from an account at bank A into one account at bank B, then send pieces of it on to several other bank-B accounts. Recording that meant one transfer per piece, with the lump sum added up by hand before the money was moved. They want to type "from this account: $X here, $Y there, $Z there" once, see the total while typing, and save it as the matching transfers in one step.

## Decision

- **A split transfer is ordinary transfers, not a new kind of row.** `planSplitTransfer` in `src/shared/splitTransfer.ts` turns the split into a list of `transfer` entries. Each is written by the existing writer with all of its checks, as a normal linked pair. No new kind of row, and every screen, report, export and merge already reads these rows correctly.
- **All or nothing.** The desktop writes the list inside one SQL transaction (`createSplitTransfer` in `src/main/db/repo/transactions.ts`, over IPC `transaction:create-split`). The phone folds the list over its pure `createEntry` and commits once (`createSplitTransfer` in `src/pocket/lib/write.ts`). A refusal on any line leaves the ledger untouched on both devices.
- **One split group, beside the pairs.** *Amended 2026-11-10, at the owner's request.* The first version wrote no grouping id. Schema 11 adds `transactions.split_group_id`, which every leg of every transfer one split wrote shares. `transfer_group_id` keeps its "exactly two legs" rule (DATA-MODEL integrity rule 3). Each transfer is still an ordinary pair, and its amount, date, note and category can be edited on its own. The group decides two things:
  - **Shown together.** Recent transfers shows a split as one line: the source, every account it reached, the total that left the source and *Split · N transfers*. The spreadsheet tags each leg *Split ×N*, and Pocket's entries say *split transfer*.
  - **Deleted together.** Deleting any leg deletes every leg of the split on both devices (`doomedDeletionIds`, `expandDeletion`), and the confirmation counts all of them.
- **The hop through bank B is the owner's choice, made per split.** The form has an optional **Through** account.
  - Left empty, each line is one transfer straight from the source. This is the net result and the right record when the bank sends the pieces directly.
  - When set, the total moves source → through account first, and each other line then moves on from there. This matches what happens at the banks when the lump sum lands in one bank-B account before it is split, so the bank-B account's history reconciles against its statement. A line naming the through account is the share that stays there, and its category and description label the first leg.
  - We recommend **Through** whenever the money really does land in one account first. It costs one extra pair, and every account's history then matches its bank statement.
- **Shared refusals.** One function, `splitTransferProblem`, gives the sentence for every refusal. The desktop form calls it while typing, and both writers call it before saving. A credit card can be neither the source nor the through account, because money leaves both, and the refusal is `CREDIT_CARD_SOURCE_REFUSAL`. Paying a card is still allowed on any line. No account may appear on two lines or be the source. Every line needs an account and a positive amount in integer cents, and a split has at most 20 lines.
- **Labels.** Each desktop line takes its own category (the `CategoryInput` from ADR 0032) and description. A blank category files the line under `Transfer`, and a blank description reads `Transfer to <account>`. Pocket's sheet takes one category for the whole split and a note per line, which is enough for the phone and keeps the sheet short.

## Consequences

- The grouping column is schema 11 (shared with [ADR 0034](0034-a-locked-account-is-frozen-money.md)). A build from before it ignores `split_group_id` and reads a split's rows as the ordinary transfers they are, deleting them one pair at a time.
- A split cut by the 50-row window of Recent transfers can show only some of its legs. Its total is read from the legs on screen.
- With **Through**, the through account shows money arriving and leaving on the same day. That is the record the bank shows too, and its balance only keeps the share that stays.

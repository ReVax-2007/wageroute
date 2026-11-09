# 0032. A typed category is the person's label

- **Status:** Accepted
- **Date:** 2026-11-09
- **Deciders:** Project owner
- **Related:** [ADR 0025](0025-the-phone-writes-through-the-desktops-own-rules.md), [FEATURES.md](../FEATURES.md#transfers), [DATA-MODEL.md](../DATA-MODEL.md)

## Context

The owner records small moves between accounts, such as a round-up of spare change or sweeping a few dollars into savings, and wants each one filed under a label. A transfer already carried a category on both legs, and the entry dialog offered it, but the **Transfers** screen only had a description box and wrote the hard-coded category `Transfer`.

Both writers also put every typed category through an alias table: `Round-up` became `Transfer`, `Credit payment` became `Debt` and `Paycheck` became `Income`. The table existed so the app's own sweep, card payment and paycheck rows landed in seeded categories. It could not tell the app's text from the person's, though, so someone typing `Round-up` on a transfer had it filed as `Transfer` without being told. That is the label this request is about.

## Decision

- **The Transfers screen has a Category box**, the same one the entry dialog uses (`CategoryInput`): it suggests the ledger's categories and takes a new name. The category stays filled in between transfers, so a run of round-ups is labelled once. One submit still writes one linked pair, and both legs get the same category row.
- **A typed category is kept as typed**, on the desktop and on Pocket. The alias table is gone. Each internal writer now names its seeded category directly: the round-up sweep writes `Transfer`, a card payment writes `Debt` and a committed paycheck writes `Income`. Those rows end up exactly as they did before.
- **A transfer resolves its category once.** Both legs get the resolved id and name, so text sent alongside a `categoryId` cannot split the pair.
- **The model stays as it is.** A labelled move is a `transfer` pair, not a new kind, and no column or schema version changes. A single-account correction stays **Adjust balance** with its own reasons.

## Consequences

- There is no migration, and existing ledgers are untouched. Rows written before this change keep the category they were given.
- A build from before this change, on either device, still aliases the three names on its own writes. That only changes which label a new row gets, and rows merge unchanged either way.
- Pocket's round-up sweep still writes the text `Round-up` with no category id, while the desktop writes `Transfer`. That difference is older than this decision and is left as a follow-up.

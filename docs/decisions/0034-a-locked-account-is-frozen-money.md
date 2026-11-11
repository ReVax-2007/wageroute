# 0034. A locked account is frozen money

- **Status:** Accepted
- **Date:** 2026-11-10
- **Deciders:** Project owner
- **Related:** [ADR 0015](0015-archive-is-not-delete.md), [ADR 0025](0025-the-phone-writes-through-the-desktops-own-rules.md), [ADR 0033](0033-a-split-transfer-is-ordinary-transfers-saved-together.md), [FEATURES.md](../FEATURES.md#accounts), [DATA-MODEL.md](../DATA-MODEL.md)

## Context

The owner holds accounts they still own but must not touch: money set aside, a term deposit, an account kept only for its history. They want to mark such an account so nothing can be recorded against it by mistake. **Archive** does not fit, because it takes the account out of every total and hides it. That is right for a closed account and wrong for money that is still theirs.

## Decision

- **A new flag, `accounts.is_locked`** (schema 11, default 0). It is separate from `is_archived`, and an account can be locked and later archived, or the reverse.
- **A locked account is frozen.** Both devices refuse, with one sentence (`LOCKED_ACCOUNT_REFUSAL` in `src/shared/writeRules.ts`):
  - any new entry, transfer or split line into or out of it;
  - any bill, paycheck deposit or other new link pointing at it;
  - any edit or delete of an entry recorded in it, its transfer twin or its round-up sweep.
  - The refusal lives in `requireAccount` / `requireAccountRow` and a row check (`assertEntriesUnlocked`), so it holds whatever screen, import of an entry or IPC call asks.
- **Its money is wealth, not spending money** (the owner's choice). It stays on the Accounts screen with its balance and counts in total wealth and net worth. `countsInSafeToSpend` is false for it whatever its own setting, so Safe to Spend never offers money that cannot be moved.
- **It leaves every picker that leads to a write** (`isUsableAccount` in `src/shared/accounts.ts`, `entryAccounts` on the phone). Pay card and Adjust balance are hidden on it. Its name, bank and colour can still be edited, because none of those move money.
- **Locking switches off a round-up sweep pointed at it**, as archiving does, so unlocking never quietly restarts sweeps. The sweep writer also skips a locked destination.
- **Account management still works on it.** It can be unlocked, archived or deleted, and deleting it with its entries goes through the usual confirmation.

## Consequences

- Schema 11 is a forward-only migration. Backups carry `is_locked`, and a file from before it reads as unlocked. A build from before this change ignores the column and treats every account as usable, so the lock is not enforced there.
- Locking is not a security control. Anyone who opens the ledger can unlock the account. It prevents mistakes, not access.

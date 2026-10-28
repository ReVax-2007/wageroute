# 0002. Store money as integer cents

- **Status:** Accepted
- **Date:** 2026-10-27
- **Deciders:** Project owner
- **Supersedes:** none
- **Related:** [DATA-MODEL.md](../DATA-MODEL.md), [IMPORT-EXPORT.md](../IMPORT-EXPORT.md)

## Context

Every screen in WageRoute does arithmetic on money: subtract bills from a paycheck, split percentages, sum account balances, round up a purchase, project 90 days of cash flow, compare goals and totals. Binary floating point cannot represent most decimal fractions exactly (`0.1 + 0.2 !== 0.3`), and errors compound when values are summed repeatedly. A personal ledger also has to reconcile to the cent, because a visible off-by-one-cent discrepancy destroys trust.

The alternatives were:

- JavaScript `number` holding dollars as a float;
- decimal strings;
- integer minor units (cents);
- a decimal library.

The app is single-currency in practice (one `currency` setting), does not perform FX, and does not need sub-cent precision. The UI accepts two decimal places.

## Decision

Store and compute all money as **integer cents**.

- SQLite columns use `INTEGER` and the `_cents` suffix (`amount_cents`, `starting_balance_cents`, `target_cents`, `credit_limit_cents`, …).
- Domain types carry cents; percentages are applied with `Math.round` in one place (`percentOf`), not accumulated as floats.
- Conversion happens only at the boundaries:
  - **Input** — `parseMoneyToCents` accepts `1,234.56`, `$1,234.56`, `USD 1234.56`, `(12.34)` for negative and `-12.34`; it strips separators, reads at most two fraction digits, and returns `null` for invalid input.
  - **Display** — `formatMoney` and `formatMoneyCompact` divide by 100 and use `Intl.NumberFormat` with two fraction digits.
  - **CSV export** — `centsToEditable` writes a plain `1234.56` string, not a formatted currency.
  - **CSV import** — `parseMoneyToCents` converts back; unparseable rows are reported as issues.
  - **JSON backups** — cents are written and read as integers; no division.
- Rounding to whole dollars (`floorToDollarCents`) and round-up sweeps (`roundUpRemainderCents`) operate on integers.

## Consequences

### Positive

- Exact addition and subtraction for every value the user sees.
- No “penny drift” after thousands of transactions or repeated paycheck allocations.
- The database is unambiguous: an amount is an integer, not a formatted string or a float.
- Backups and CSV are portable without locale-dependent parsing on the storage side.
- SQLite `INTEGER` is exact up to 64-bit; JavaScript safe integers cover any realistic personal ledger.

### Negative

- **Every boundary needs discipline.** A new field that stores dollars instead of cents, or a `toFixed(2)` that returns a string, is a bug waiting to happen. The `_cents` suffix is the convention that makes review possible.
- **The model assumes two decimal places.** `parseMoneyToCents` and the formatters hard-code hundredths. Currencies with zero decimals (JPY) or three (KWD) are not modelled correctly, even though the currency code is configurable.
- **No currency conversion.** `users.currency` and `settings.currency` change the symbol and formatting only. Mixing currencies in one ledger is unsupported; there is no rate table.
- **Display rounding is separate from storage.** A percentage split rounds to the nearest cent; the sum of rounded buckets can differ from the input by a cent. The allocator's remainder handling exists for this reason.
- **Very large values are still bounded.** `Number.isSafeInteger` is checked on parse; other arithmetic is not overflow-checked.

### Neutral

- `formatMoney` falls back to USD formatting if `Intl` rejects the currency code. The stored code is still whatever the user set.
- CSV exports are written with the *user record's* currency, while the UI formats with the *settings* currency. They are normally the same; the distinction is documented in [IMPORT-EXPORT.md](../IMPORT-EXPORT.md).

## Alternatives considered

### Floating-point dollars

Rejected. `0.1 + 0.2` problems are unacceptable in a ledger, and equality comparisons for dedupe and transfers become unreliable. Formatting can hide the error, but totals eventually drift.

### Decimal strings in SQLite

Rejected. SQLite has no native decimal type; storing strings means every sum needs application-level parsing, ordering and comparison become lexical unless carefully zero-padded, and `CHECK` constraints cannot do arithmetic naturally.

### A decimal library (decimal.js, big.js)

Rejected. It adds a dependency and object allocation to every operation, and the database still needs a storage representation. Integer cents solve the problem with the platform's native numeric type.

### Store dollars as integers, cents separately

Rejected. Two sources of truth invite divergence. One integer in the smallest unit is simpler.

### Per-currency minor units

Deferred. Correct for a multi-currency product, but the app explicitly does not convert or mix currencies. If multi-currency becomes a requirement, this ADR should be superseded: the storage unit would need to depend on the currency's exponent, and every formatter/parser would need the exponent.

## References

- [src/shared/money.ts](../../src/shared/money.ts) — parsing, formatting, percent and whole-dollar helpers
- [src/shared/transfers.ts](../../src/shared/transfers.ts) — round-up remainder and paired transfer legs
- [src/shared/types.ts](../../src/shared/types.ts) — `_cents` fields on every money-bearing type
- [src/main/db/migrations.ts](../../src/main/db/migrations.ts) — `INTEGER` columns and `CHECK` constraints
- [DATA-MODEL.md](../DATA-MODEL.md) — per-table money columns
- [IMPORT-EXPORT.md](../IMPORT-EXPORT.md) — cent handling in backups and CSV
- [src/shared/domain.test.ts](../../src/shared/domain.test.ts) — arithmetic and parsing tests

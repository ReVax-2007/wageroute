import { RepositoryError } from "./errors";
import type {
  AccountKind,
  SplitTransferInput,
  SplitTransferLine,
  TransactionInput,
} from "./types";
import { CREDIT_CARD_SOURCE_REFUSAL } from "./writeRules";

/**
 * A split transfer is one source sending money to several accounts at once
 * (ADR 0033). It is not a new kind of row: this module turns it into the
 * ordinary transfers each device already knows how to write, and both devices
 * write that list in one all-or-nothing save. The refusals live here so the
 * desktop, the phone and the form that is being typed into say the same thing.
 */

/** More lines than anyone splits a deposit into; a cap keeps a bad call small. */
export const SPLIT_TRANSFER_MAX_LINES = 20;

export interface SplitAccount {
  kind: AccountKind;
  name: string;
}

export type SplitAccountLookup = (id: string) => SplitAccount | undefined;

function lineCents(line: SplitTransferLine): number {
  return Number.isSafeInteger(line.amountCents) && line.amountCents > 0
    ? line.amountCents
    : 0;
}

/** What leaves the source: every line's amount, in integer cents. */
export function splitTransferTotalCents(
  lines: readonly SplitTransferLine[],
): number {
  return lines.reduce((sum, line) => sum + lineCents(line), 0);
}

/**
 * The first reason this split cannot be written, as the sentence a person
 * reads, or `null` when it can. The form calls it while typing; the writers
 * call it through `planSplitTransfer` before anything is saved.
 */
export function splitTransferProblem(
  input: SplitTransferInput,
  accountOf: SplitAccountLookup,
): string | null {
  const sourceId = input.sourceAccountId;
  const viaId = input.viaAccountId || null;
  if (!sourceId) return "Choose the account the money leaves from";
  const source = accountOf(sourceId);
  if (!source) return "Account not found";
  if (source.kind === "credit") return CREDIT_CARD_SOURCE_REFUSAL;

  if (viaId) {
    if (viaId === sourceId)
      return "The money has to pass through a different account than it leaves";
    const via = accountOf(viaId);
    if (!via) return "Account not found";
    // The pieces leave the via account, so it is a source too.
    if (via.kind === "credit") return CREDIT_CARD_SOURCE_REFUSAL;
  }

  if (input.lines.length === 0)
    return "Add at least one account to send money to";
  if (input.lines.length > SPLIT_TRANSFER_MAX_LINES) {
    return `A split transfer takes at most ${SPLIT_TRANSFER_MAX_LINES} accounts`;
  }
  const seen = new Set<string>();
  for (const line of input.lines) {
    if (!line.accountId) return "Choose an account on every line";
    if (line.accountId === sourceId)
      return "A line can’t send money back to the account it leaves";
    if (seen.has(line.accountId))
      return "Each account can appear on one line only";
    seen.add(line.accountId);
    if (!accountOf(line.accountId)) return "Account not found";
    if (lineCents(line) === 0) return "Enter an amount on every line";
  }
  return null;
}

/**
 * The transfers a split writes, in order. Without a via account each line is
 * one transfer from the source. With one, the total moves from the source to
 * the via account first, then each other line moves on from there; a line
 * naming the via account is the share that stays, and lends that first leg its
 * category and description.
 */
export function planSplitTransfer(
  input: SplitTransferInput,
  accountOf: SplitAccountLookup,
): TransactionInput[] {
  const problem = splitTransferProblem(input, accountOf);
  if (problem) throw new RepositoryError("VALIDATION", problem);

  const transfer = (
    from: string,
    to: string,
    amountCents: number,
    line: Partial<SplitTransferLine>,
  ): TransactionInput => {
    const category = line.category?.trim() ?? "";
    return {
      accountId: from,
      counterAccountId: to,
      kind: "transfer",
      amountCents,
      occurredOn: input.occurredOn,
      memo: line.memo?.trim() || `Transfer to ${accountOf(to)!.name}`,
      category: category || "Transfer",
      categoryId: category ? (line.categoryId ?? null) : null,
    };
  };

  const viaId = input.viaAccountId || null;
  if (!viaId) {
    return input.lines.map((line) =>
      transfer(input.sourceAccountId, line.accountId, line.amountCents, line),
    );
  }
  const kept = input.lines.find((line) => line.accountId === viaId) ?? {};
  return [
    transfer(
      input.sourceAccountId,
      viaId,
      splitTransferTotalCents(input.lines),
      kept,
    ),
    ...input.lines
      .filter((line) => line.accountId !== viaId)
      .map((line) => transfer(viaId, line.accountId, line.amountCents, line)),
  ];
}

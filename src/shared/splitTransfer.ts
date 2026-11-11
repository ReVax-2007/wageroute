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

interface SplitLeg {
  accountId: string
  amountCents: number
  transferGroupId: string | null
  splitGroupId: string | null
}

/** How many transfers each split on screen wrote, keyed by its split group. */
export function splitTransferSizes(rows: readonly SplitLeg[]): Map<string, number> {
  const pairs = new Map<string, Set<string>>()
  for (const row of rows) {
    if (!row.splitGroupId) continue
    const set = pairs.get(row.splitGroupId) ?? new Set<string>()
    set.add(row.transferGroupId ?? row.accountId)
    pairs.set(row.splitGroupId, set)
  }
  return new Map([...pairs].map(([id, set]) => [id, set.size]))
}

export interface SplitSummary {
  sourceAccountId: string
  /** Every account the split moved money into, the through account first. */
  destinationIds: string[]
  /** What left the source: the figure moved between banks. */
  totalCents: number
}

/**
 * One split read back from its legs. The source is the account that only
 * sends; the total is what left it, so a split through another account is not
 * counted twice.
 */
export function summarizeSplit(legs: readonly SplitLeg[]): SplitSummary | null {
  const receiving = new Set(legs.filter((leg) => leg.amountCents > 0).map((leg) => leg.accountId))
  const sourceLeg = legs.find((leg) => leg.amountCents < 0 && !receiving.has(leg.accountId))
  if (!sourceLeg) return null
  const destinationIds: string[] = []
  for (const leg of legs) {
    if (leg.amountCents > 0 && !destinationIds.includes(leg.accountId)) destinationIds.push(leg.accountId)
  }
  const totalCents = legs
    .filter((leg) => leg.amountCents < 0 && leg.accountId === sourceLeg.accountId)
    .reduce((sum, leg) => sum - leg.amountCents, 0)
  return { sourceAccountId: sourceLeg.accountId, destinationIds, totalCents }
}

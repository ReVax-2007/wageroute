import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ArrowRightLeft, Plus, Trash2 } from "lucide-react";
import { formatDateLabel, todayISO } from "@shared/dates";
import { formatMoney, parseMoneyToCents } from "@shared/money";
import {
  SPLIT_TRANSFER_MAX_LINES,
  splitTransferProblem,
  splitTransferTotalCents,
} from "@shared/splitTransfer";
import type { AccountWithBalance, SplitTransferInput } from "@shared/types";
import { CategoryInput } from "../components/CategoryInput";
import { Button, Field, IconButton, MoneyInput } from "../components/ui";
import { accountAvailLabel, confirmFloor } from "../lib/finance";
import { usableLabel } from "@shared/accounts";
import { useFinanceStore } from "../store/useFinanceStore";

interface DraftLine {
  key: number;
  accountId: string;
  amount: string;
  category: { name: string; id: string | null };
  memo: string;
}

let nextKey = 1;
function blankLine(accountId = ""): DraftLine {
  return {
    key: nextKey++,
    accountId,
    amount: "",
    category: { name: "", id: null },
    memo: "",
  };
}

/** A line's field: every row is labelled, only the first one shows it. */
function LineField({
  label,
  shown,
  children,
}: {
  label: string;
  shown: boolean;
  children: ReactNode;
}) {
  return (
    <label className="field">
      <span className={shown ? "field-label" : "field-label sr-only"}>
        {label}
      </span>
      {children}
    </label>
  );
}

/**
 * One source sending money to several accounts at once (ADR 0033). The total
 * is added up while typing, so the person knows how much to move between banks,
 * and the save writes every line as an ordinary transfer, all or nothing.
 */
export function SplitTransferForm({
  activeAccounts,
  sourceAccounts,
  currency,
}: {
  activeAccounts: AccountWithBalance[];
  sourceAccounts: AccountWithBalance[];
  currency: string;
}) {
  const createSplitTransfer = useFinanceStore(
    (state) => state.createSplitTransfer,
  );
  const askConfirm = useFinanceStore((state) => state.askConfirm);

  const accountMap = useMemo(
    () => new Map(activeAccounts.map((account) => [account.id, account])),
    [activeAccounts],
  );

  const [sourceId, setSourceId] = useState<string>(sourceAccounts[0]?.id ?? "");
  const [viaId, setViaId] = useState<string>("");
  const [occurredOn, setOccurredOn] = useState<string>(todayISO());
  const [lines, setLines] = useState<DraftLine[]>(() => [
    blankLine(),
    blankLine(),
  ]);
  const [saving, setSaving] = useState<boolean>(false);
  const [attempted, setAttempted] = useState<boolean>(false);

  // The source stays on an account that can send money; the via account is never it.
  useEffect(() => {
    if (!sourceAccounts.some((account) => account.id === sourceId)) {
      setSourceId(sourceAccounts[0]?.id ?? "");
    }
    if (
      viaId &&
      (viaId === sourceId ||
        !sourceAccounts.some((account) => account.id === viaId))
    ) {
      setViaId("");
    }
  }, [sourceAccounts, sourceId, viaId]);

  const source = accountMap.get(sourceId);
  const via = viaId ? accountMap.get(viaId) : undefined;
  const destinations = activeAccounts.filter(
    (account) => account.id !== sourceId,
  );
  const viaChoices = sourceAccounts.filter(
    (account) => account.id !== sourceId,
  );

  const input: SplitTransferInput = {
    sourceAccountId: sourceId,
    viaAccountId: viaId || null,
    occurredOn,
    lines: lines.map((line) => ({
      accountId: line.accountId,
      amountCents: parseMoneyToCents(line.amount) ?? 0,
      category: line.category.name,
      categoryId: line.category.id,
      memo: line.memo,
    })),
  };
  const totalCents = splitTransferTotalCents(input.lines);
  const problem = splitTransferProblem(input, (id) => accountMap.get(id));
  // A half-typed form is not wrong yet; a duplicate or a loop back to the source is.
  const shownProblem =
    problem && (attempted || totalCents > 0) ? problem : null;

  const update = (key: number, change: Partial<DraftLine>) =>
    setLines((current) =>
      current.map((line) => (line.key === key ? { ...line, ...change } : line)),
    );

  const submit = async () => {
    setAttempted(true);
    if (problem) return;
    // Only the source can end lower: a "through" account receives the total first.
    if (!(await confirmFloor(askConfirm, source, -totalCents, currency))) return;
    setSaving(true);
    try {
      const ok = await createSplitTransfer(input);
      if (ok) {
        // The same split tends to come round again: keep the accounts and labels.
        setLines((current) =>
          current.map((line) => ({ ...line, amount: "", memo: "" })),
        );
        setAttempted(false);
      }
    } finally {
      setSaving(false);
    }
  };

  const sourceAfterCents = source ? source.balanceCents - totalCents : 0;
  const onward = via
    ? lines.filter((line) => line.accountId && line.accountId !== viaId).length
    : 0;

  return (
    <div className="transfer-card">
      <div className="form-grid">
        <Field label="From account">
          <select
            className="select"
            value={sourceId}
            onChange={(event) => setSourceId(event.target.value)}
          >
            {sourceAccounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.name} ({accountAvailLabel(account, currency)})
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="Through"
          hint="Optional: the account the total lands in first, before it is split"
        >
          <select
            className="select"
            value={viaId}
            onChange={(event) => setViaId(event.target.value)}
          >
            <option value="">Straight from the source</option>
            {viaChoices.map((account) => (
              <option key={account.id} value={account.id}>
                {account.name}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <div
        className="split-lines"
        role="group"
        aria-label="Accounts to send money to"
      >
        {lines.map((line, index) => (
          <div className="split-line" key={line.key}>
            <LineField label="To account" shown={index === 0}>
              <select
                className="select"
                value={line.accountId}
                onChange={(event) =>
                  update(line.key, { accountId: event.target.value })
                }
              >
                <option value="">Choose…</option>
                {destinations.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.id === viaId
                      ? `${account.name} (stays here)`
                      : account.name}
                  </option>
                ))}
              </select>
            </LineField>
            <LineField label="Amount" shown={index === 0}>
              <MoneyInput
                value={line.amount}
                placeholder="0.00"
                onValueChange={(amount) => update(line.key, { amount })}
              />
            </LineField>
            <LineField label="Category" shown={index === 0}>
              <CategoryInput
                listId={`split-category-options-${line.key}`}
                value={line.category.name}
                placeholder="Transfer"
                onChange={(name, id) =>
                  update(line.key, { category: { name, id } })
                }
              />
            </LineField>
            <LineField label="Description" shown={index === 0}>
              <input
                className="input"
                value={line.memo}
                placeholder="Optional"
                onChange={(event) =>
                  update(line.key, { memo: event.target.value })
                }
              />
            </LineField>
            <IconButton
              label={`Remove line ${index + 1}`}
              danger
              disabled={lines.length === 1}
              onClick={() =>
                setLines((current) =>
                  current.filter((item) => item.key !== line.key),
                )
              }
            >
              <Trash2 size={14} />
            </IconButton>
          </div>
        ))}
        <div>
          <Button
            size="sm"
            icon={<Plus size={14} />}
            disabled={lines.length >= SPLIT_TRANSFER_MAX_LINES}
            onClick={() => setLines((current) => [...current, blankLine()])}
          >
            Add account
          </Button>
        </div>
      </div>

      <div className="form-grid">
        <Field label="Transfer date">
          <input
            className="input"
            type="date"
            value={occurredOn}
            onChange={(event) => setOccurredOn(event.target.value)}
          />
        </Field>
        <div className="split-total" aria-live="polite">
          <span className="split-total-label">Total to move</span>
          <strong className="split-total-amount">
            {formatMoney(totalCents, currency)}
          </strong>
          {source && (
            <span className="muted">
              {source.name} after: {formatMoney(sourceAfterCents, currency)}
              {usableLabel(source, currency, sourceAfterCents) !== null &&
                ` · ${usableLabel(source, currency, sourceAfterCents)}`}
            </span>
          )}
        </div>
      </div>

      {totalCents > 0 && source && !problem && (
        <div className="transfer-summary-box">
          <ArrowRightLeft size={16} />
          <span>
            {via ? (
              <>
                Moving <strong>{formatMoney(totalCents, currency)}</strong> from{" "}
                <strong>{source.name}</strong> into <strong>{via.name}</strong>
                {onward > 0 && (
                  <>
                    , then on to {onward}{" "}
                    {onward === 1 ? "account" : "accounts"}
                  </>
                )}{" "}
                on <strong>{formatDateLabel(occurredOn)}</strong>.
              </>
            ) : (
              <>
                Moving <strong>{formatMoney(totalCents, currency)}</strong> from{" "}
                <strong>{source.name}</strong> to {lines.length}{" "}
                {lines.length === 1 ? "account" : "accounts"} on{" "}
                <strong>{formatDateLabel(occurredOn)}</strong>.
              </>
            )}
          </span>
        </div>
      )}

      {shownProblem && <div className="form-error">{shownProblem}</div>}

      <div>
        <Button
          variant="primary"
          icon={<ArrowRightLeft size={16} />}
          disabled={saving || totalCents <= 0}
          onClick={() => void submit()}
        >
          {saving
            ? "Recording transfers…"
            : totalCents > 0
              ? `Split ${formatMoney(totalCents, currency)} now`
              : "Record split transfer"}
        </Button>
      </div>
    </div>
  );
}

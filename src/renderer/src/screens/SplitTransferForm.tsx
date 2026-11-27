import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ArrowRightLeft, Equal, Plus, Trash2 } from "lucide-react";
import { formatDateLabel, todayISO } from "@shared/dates";
import { formatMoney } from "@shared/money";
import {
  SPLIT_TRANSFER_MAX_LINES,
  splitTransferProblem,
  splitTransferTotalCents,
} from "@shared/splitTransfer";
import { FULL_BPS, centsToBps, formatBps } from "@shared/splitTotal";
import type { AccountWithBalance, SplitTransferInput } from "@shared/types";
import { CategoryInput } from "../components/CategoryInput";
import {
  Button,
  Field,
  IconButton,
  MoneyInput,
  PercentInput,
  Segmented,
} from "../components/ui";
import { accountAvailLabel, confirmFloor } from "../lib/finance";
import { usableLabel } from "@shared/accounts";
import { useFinanceStore } from "../store/useFinanceStore";
import {
  NO_SHARE,
  useSplitTotal,
  type ShareLine,
  type ShareUnit,
} from "../lib/useSplitTotal";

interface DraftLine extends ShareLine {
  accountId: string;
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
    share: NO_SHARE,
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
 * One source sending money to several accounts at once (ADR 0033). Either the
 * lines are typed and the total added up while typing, or the total is named
 * first and shared out by slider, amount or percent until the lines equal it.
 * Both save every line as an ordinary transfer, all or nothing.
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
  const split = useSplitTotal(lines, setLines, currency);
  const { splitting, unit, goalCents, balance, resolved } = split;

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
    lines: lines.map((line, index) => ({
      accountId: line.accountId,
      amountCents: split.lineCents(line, index),
      category: line.category.name,
      categoryId: line.category.id,
      memo: line.memo,
    })),
  };
  const totalCents = splitTransferTotalCents(input.lines);
  const lineProblem = splitTransferProblem(input, (id) =>
    accountMap.get(id),
  );
  const problem = split.goalProblem ?? lineProblem;
  // A half-typed form is not wrong yet; a duplicate or a loop back to the
  // source is. What is left of a total shows in its own box while sharing out.
  const shownProblem = attempted
    ? problem
    : lineProblem && totalCents > 0
      ? lineProblem
      : null;
  const lineName = (index: number) =>
    accountMap.get(lines[index]?.accountId ?? "")?.name ?? `Line ${index + 1}`;
  const note = split.note(lineName);

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
        split.reset();
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
      <Segmented
        label="How to enter the split"
        value={split.entry}
        onChange={(next) => {
          setAttempted(false);
          split.switchEntry(next);
        }}
        options={[
          { value: "lines", label: "Add up the lines" },
          { value: "total", label: "Split a total" },
        ]}
      />
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

      {splitting && (
        <div className="split-goal">
          <Field label="Total to move">
            <MoneyInput
              value={split.goalText}
              placeholder="0.00"
              onValueChange={split.setGoal}
            />
          </Field>
          <div className="split-goal-tools">
            <Segmented
              label="Share by"
              value={unit}
              onChange={split.setUnit}
              options={[
                { value: "amount", label: "Amount" },
                { value: "percent", label: "Percent" },
              ]}
            />
            <Button
              size="sm"
              icon={<Equal size={14} />}
              disabled={goalCents <= 0}
              onClick={split.splitEven}
            >
              Split evenly
            </Button>
          </div>
        </div>
      )}

      <div
        className="split-lines"
        role="group"
        aria-label="Accounts to send money to"
      >
        {lines.map((line, index) => (
          <div
            className={splitting ? "split-line split-line-share" : "split-line"}
            key={line.key}
          >
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
            {splitting ? (
              <LineField
                label={unit === "percent" ? "Percent" : "Amount"}
                shown={index === 0}
              >
                {unit === "percent" ? (
                  <PercentInput
                    value={split.shareText(line, index)}
                    placeholder="0"
                    onFocus={() => split.focusShare(line, index)}
                    onBlur={split.blurShare}
                    onValueChange={(text) => split.typeShare(line.key, text)}
                  />
                ) : (
                  <MoneyInput
                    value={split.shareText(line, index)}
                    placeholder="0.00"
                    onFocus={() => split.focusShare(line, index)}
                    onBlur={split.blurShare}
                    onValueChange={(text) => split.typeShare(line.key, text)}
                  />
                )}
              </LineField>
            ) : (
              <LineField label="Amount" shown={index === 0}>
                <MoneyInput
                  value={line.amount}
                  placeholder="0.00"
                  onValueChange={(amount) => update(line.key, { amount })}
                />
              </LineField>
            )}
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
              onClick={() => {
                split.linesChanged();
                setLines((current) =>
                  current.filter((item) => item.key !== line.key),
                );
              }}
            >
              <Trash2 size={14} />
            </IconButton>
            {splitting && (
              <ShareSlider
                name={lineName(index)}
                unit={unit}
                cents={resolved.cents[index]}
                totalCents={goalCents}
                leftCents={balance.leftCents}
                currency={currency}
                onSlide={(value) => split.slide(line.key, value)}
                onTakeRest={() => split.takeRest(line.key, index)}
              />
            )}
          </div>
        ))}
        <div>
          <Button
            size="sm"
            icon={<Plus size={14} />}
            disabled={lines.length >= SPLIT_TRANSFER_MAX_LINES}
            onClick={() => {
              split.linesChanged();
              setLines((current) => [...current, blankLine()]);
            }}
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
          {splitting ? (
            <>
              <span className="split-total-label">
                Shared out of {formatMoney(goalCents, currency)}
              </span>
              <strong className="split-total-amount">
                {formatMoney(balance.allocatedCents, currency)}
              </strong>
              <span
                className={
                  balance.leftCents === 0
                    ? "split-balance exact"
                    : balance.leftCents > 0
                      ? "split-balance under"
                      : "split-balance over"
                }
              >
                {goalCents === 0
                  ? "Enter the total to move"
                  : balance.leftCents === 0
                    ? "Adds up exactly"
                    : balance.leftCents > 0
                      ? `${formatMoney(balance.leftCents, currency)} left to place`
                      : `${formatMoney(-balance.leftCents, currency)} over the total`}
              </span>
            </>
          ) : (
            <>
              <span className="split-total-label">Total to move</span>
              <strong className="split-total-amount">
                {formatMoney(totalCents, currency)}
              </strong>
            </>
          )}
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

      {note && (
        <p className="muted split-note" aria-live="polite">
          {note}
        </p>
      )}

      {shownProblem && <div className="form-error">{shownProblem}</div>}

      <div>
        <Button
          variant="primary"
          icon={<ArrowRightLeft size={16} />}
          disabled={saving || totalCents <= 0 || (splitting && problem !== null)}
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

/**
 * One line's share of the total as a real range input: arrow keys step a
 * dollar or a percent, the value is announced as money and percent, and the
 * readout beside it updates while dragging.
 */
function ShareSlider({
  name,
  unit,
  cents,
  totalCents,
  leftCents,
  currency,
  onSlide,
  onTakeRest,
}: {
  name: string;
  unit: ShareUnit;
  cents: number;
  totalCents: number;
  leftCents: number;
  currency: string;
  /** Basis points by percent, cents by amount. */
  onSlide: (value: number) => void;
  onTakeRest: () => void;
}) {
  const bps = centsToBps(totalCents, cents);
  const percent = `${formatBps(bps) || "0"}%`;
  const money = formatMoney(cents, currency);
  const byPercent = unit === "percent";
  const restLabel =
    leftCents >= 0
      ? `Put the ${formatMoney(leftCents, currency)} left on ${name}`
      : `Take the ${formatMoney(-leftCents, currency)} over off ${name}`;
  return (
    <div className="split-share">
      <input
        type="range"
        className="split-share-range"
        min={0}
        max={byPercent ? FULL_BPS : Math.max(totalCents, 1)}
        step={100}
        value={byPercent ? bps : Math.min(cents, totalCents)}
        disabled={totalCents <= 0}
        aria-label={`Share for ${name}`}
        aria-valuetext={`${money}, ${percent} of ${formatMoney(totalCents, currency)}`}
        onChange={(event) => onSlide(Number(event.target.value))}
      />
      <span className="split-share-readout num" aria-hidden="true">
        {money} · {percent}
      </span>
      <Button
        size="sm"
        variant="quiet"
        disabled={totalCents <= 0 || leftCents === 0}
        aria-label={restLabel}
        title={restLabel}
        onClick={onTakeRest}
      >
        Take the rest
      </Button>
    </div>
  );
}

import { useState } from 'react'
import { cardOwedCents } from '@shared/accounts'
import { adjustmentPresetsFor, type AdjustmentReason } from '@shared/adjustments'
import { todayISO } from '@shared/dates'
import { centsToEditable, formatMoney, parseMoneyToCents } from '@shared/money'
import type { AccountWithBalance } from '@shared/types'
import { Button, Field, Modal, MoneyInput, PercentInput, Segmented } from '../ui'
import { useFinanceStore } from '../../store/useFinanceStore'
import { useDialogSave } from '../useDialogSave'

type CreditMode = 'owed' | 'available' | 'percent'

const CREDIT_MODES: { value: CreditMode; label: string }[] = [
  { value: 'owed', label: 'Amount owed' },
  { value: 'available', label: 'Available credit' },
  { value: 'percent', label: 'Utilization' }
]

export function AdjustBalanceDialog({
  account,
  onClose
}: {
  account: AccountWithBalance
  onClose: () => void
}) {
  const settings = useFinanceStore((state) => state.settings)
  const adjustAccountBalance = useFinanceStore((state) => state.adjustAccountBalance)
  const isCredit = account.kind === 'credit'
  // Signed, so an overpaid card starts at its credit instead of a misleading 0.
  const owedCents = cardOwedCents(account)
  const limitCents = account.creditLimitCents
  const availableCents = limitCents === null ? null : limitCents - owedCents
  const usedPercent =
    limitCents !== null && limitCents > 0
      ? Math.round((owedCents / limitCents) * 1000) / 10
      : null
  const canUseCreditModes = isCredit && limitCents !== null && limitCents > 0
  const presets = adjustmentPresetsFor(account.kind)
  const [mode, setMode] = useState<CreditMode>('owed')
  const [reason, setReason] = useState<AdjustmentReason>('correction')
  const [value, setValue] = useState(centsToEditable(owedCents))
  const [occurredOn, setOccurredOn] = useState(todayISO())
  const { saving, error, setError, run } = useDialogSave(onClose)
  const preset = presets.find((candidate) => candidate.value === reason) ?? presets[0]

  const seedFor = (next: CreditMode): string => {
    if (next === 'available') return centsToEditable(availableCents ?? 0)
    if (next === 'percent') return usedPercent === null ? '' : String(usedPercent)
    return centsToEditable(owedCents)
  }

  const changeMode = (next: CreditMode) => {
    setMode(next)
    setValue(seedFor(next))
    setError(null)
  }

  // All three credit fields boil down to a target amount owed.
  const typed = parseMoneyToCents(value)
  const targetOwedCents =
    typed !== null && canUseCreditModes && mode === 'available'
      ? limitCents! - typed
      : typed !== null && canUseCreditModes && mode === 'percent'
        ? Math.round((limitCents! * typed) / 100)
        : typed

  const submit = async () => {
    if (targetOwedCents === null) {
      setError(mode === 'percent' ? 'Enter a utilization percentage' : 'Enter a balance')
      return
    }
    // A card normally holds a negative balance, so a positive "owed" entry
    // becomes money out. Typing a negative amount says the card is overpaid,
    // which is the only way to record a credit balance in its favour.
    const target = isCredit ? -targetOwedCents : targetOwedCents
    const delta = target - account.balanceCents
    if ((reason === 'investment_gain' || reason === 'interest_earned') && delta < 0) {
      setError(`${preset.label} should raise the balance. Pick a loss or interest charged instead.`)
      return
    }
    if ((reason === 'investment_loss' || reason === 'interest_charged') && delta > 0) {
      setError(`${preset.label} should lower the balance. Pick a gain or interest earned instead.`)
      return
    }
    await run(() => adjustAccountBalance(account, target, occurredOn, reason))
  }

  return (
    <Modal
      title={`Adjust ${account.name}`}
      subtitle="This posts one adjustment entry, so the change stays visible in the ledger."
      onClose={onClose}
      footer={
        <>
          <Button variant="quiet" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={saving}>
            Post adjustment
          </Button>
        </>
      }
    >
      <div className="form-grid">
        {canUseCreditModes && (
          <div className="field span-2">
            <span className="field-label">Adjust by</span>
            <Segmented<CreditMode>
              label="What to enter"
              value={mode}
              onChange={changeMode}
              options={CREDIT_MODES}
            />
          </div>
        )}
        <Field label="What changed?" hint={preset.hint}>
          <select
            className="input"
            value={reason}
            onChange={(event) => {
              setReason(event.target.value as AdjustmentReason)
              setError(null)
            }}
          >
            {presets.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label={
            mode === 'available'
              ? 'Available credit now'
              : mode === 'percent'
                ? 'Utilization now'
                : isCredit
                  ? 'Amount owed now'
                  : 'Balance now'
          }
          hint={
            mode === 'percent'
              ? 'Share of the limit in use, for example 42.5'
              : isCredit && mode === 'owed'
                ? 'Enter a negative amount if the card is overpaid'
                : undefined
          }
        >
          {mode === 'percent' ? (
            <PercentInput autoFocus value={value} onValueChange={setValue} />
          ) : (
            <MoneyInput
              autoFocus
              allowNegative={mode === 'owed'}
              value={value}
              onValueChange={setValue}
            />
          )}
        </Field>
        <Field label="Date">
          <input
            className="input"
            type="date"
            value={occurredOn}
            onChange={(event) => setOccurredOn(event.target.value)}
          />
        </Field>
      </div>

      {canUseCreditModes && targetOwedCents !== null && (
        <p className="field-hint">
          After saving: {formatMoney(targetOwedCents, settings.currency)} owed ·{' '}
          {formatMoney(Math.max(0, limitCents! - targetOwedCents), settings.currency)} available ·{' '}
          {Math.max(0, Math.round((targetOwedCents / limitCents!) * 1000) / 10)}% used
        </p>
      )}
      <p className="field-hint">
        Recorded as “{preset.memo}” · {preset.category}
      </p>
      <p className="field-hint">
        {isCredit
          ? owedCents < 0
            ? `Credit on the card: ${formatMoney(-owedCents, settings.currency)}`
            : `Current owed: ${formatMoney(owedCents, settings.currency)}${
                limitCents !== null
                  ? ` · limit ${formatMoney(limitCents, settings.currency)}`
                  : ''
              }`
          : `Current balance: ${formatMoney(owedCents, settings.currency)}`}
        {isCredit && limitCents === null && ' · add a credit limit to adjust by available credit or utilization'}
      </p>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </Modal>
  )
}

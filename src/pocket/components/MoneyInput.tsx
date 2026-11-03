import type { InputHTMLAttributes } from 'react'
import { canonicalMoneyInput, sanitizeMoneyInput, sanitizePercentInput } from '@shared/money'

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'value' | 'onChange' | 'inputMode'> & {
  value: string
  onValueChange: (value: string) => void
  allowNegative?: boolean
}

/** A money field that only ever holds a number: no letters, one point, two decimals. */
export function MoneyInput({
  value,
  onValueChange,
  allowNegative = false,
  className = 'input',
  onBlur,
  ...rest
}: Props) {
  return (
    <input
      {...rest}
      type="text"
      inputMode="decimal"
      autoComplete="off"
      className={className}
      value={value}
      onChange={(event) =>
        onValueChange(sanitizeMoneyInput(event.target.value, { allowNegative }))
      }
      onBlur={(event) => {
        // Typing keeps its separators; leaving the field settles on one form.
        onValueChange(canonicalMoneyInput(event.target.value, { allowNegative }))
        onBlur?.(event)
      }}
    />
  )
}

/** A percent field: percentage points, two decimals at most, never a sign. */
export function PercentInput({
  value,
  onValueChange,
  className = 'input',
  ...rest
}: Omit<Props, 'allowNegative'>) {
  return (
    <input
      {...rest}
      type="text"
      inputMode="decimal"
      autoComplete="off"
      className={className}
      value={value}
      onChange={(event) => onValueChange(sanitizePercentInput(event.target.value))}
    />
  )
}

import type { InputHTMLAttributes } from 'react'
import { canonicalMoneyInput, sanitizeMoneyInput } from '@shared/money'

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'value' | 'onChange' | 'inputMode'> & {
  value: string
  onValueChange: (value: string) => void
}

/** A money field that only ever holds a number: no letters, one point, two decimals. */
export function MoneyInput({ value, onValueChange, className = 'input', onBlur, ...rest }: Props) {
  return (
    <input
      {...rest}
      type="text"
      inputMode="decimal"
      autoComplete="off"
      className={className}
      value={value}
      onChange={(event) => onValueChange(sanitizeMoneyInput(event.target.value))}
      onBlur={(event) => {
        // Typing keeps its separators; leaving the field settles on one form.
        onValueChange(canonicalMoneyInput(event.target.value))
        onBlur?.(event)
      }}
    />
  )
}

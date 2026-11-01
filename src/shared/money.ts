const MONEY_INPUT = /^\d*(\.\d{0,2})?$/

export function parseMoneyToCents(raw: string): number | null {
  if (typeof raw !== 'string') return null
  let text = raw.trim()
  if (!text) return null

  let negative = false
  if (text.startsWith('(') && text.endsWith(')')) {
    negative = true
    text = text.slice(1, -1).trim()
  }

  text = text.replace(/[\s,$]/g, '')
  if (/^usd/i.test(text)) text = text.slice(3)

  if (text.startsWith('-')) {
    // Parentheses and a minus sign disagree about the sign; refuse rather than
    // guess which one the user meant.
    if (negative) return null
    negative = true
    text = text.slice(1)
  } else if (text.startsWith('+')) {
    text = text.slice(1)
  }

  // Nothing numeric left: a bare "$", "usd" or "-" is not zero.
  if (!MONEY_INPUT.test(text) || text === '' || text === '.') return null

  const [whole, fraction = ''] = text.split('.')
  const dollars = whole === '' ? 0 : Number(whole)
  const cents = Number(`${fraction}00`.slice(0, 2))
  const total = (negative ? -1 : 1) * (dollars * 100 + cents)
  return Number.isSafeInteger(total) ? total : null
}

export function centsToEditable(cents: number): string {
  const rounded = Math.round(cents)
  const sign = rounded < 0 ? '-' : ''
  const absolute = Math.abs(rounded)
  return `${sign}${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, '0')}`
}

const currencyFormatters = new Map<string, Intl.NumberFormat>()
const compactFormatters = new Map<string, Intl.NumberFormat>()

function formatterFor(currency: string, compact: boolean): Intl.NumberFormat {
  const cache = compact ? compactFormatters : currencyFormatters
  const key = currency
  const cached = cache.get(key)
  if (cached) return cached

  let formatter: Intl.NumberFormat
  try {
    formatter = new Intl.NumberFormat(
      undefined,
      compact
        ? {
            style: 'currency',
            currency: currency || 'USD',
            notation: 'compact',
            maximumFractionDigits: 1
          }
        : {
            style: 'currency',
            currency: currency || 'USD',
            minimumFractionDigits: 2,
            maximumFractionDigits: 2
          }
    )
  } catch {
    formatter = new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    })
  }
  cache.set(key, formatter)
  return formatter
}

export function formatMoney(cents: number, currency = 'USD'): string {
  return formatterFor(currency, false).format(cents / 100)
}

export function formatMoneyCompact(cents: number, currency = 'USD'): string {
  return formatterFor(currency, true).format(cents / 100)
}

const symbolCache = new Map<string, string>()

/**
 * The symbol a currency prints with, for fields that show the unit beside a
 * bare input instead of a formatted amount. A code with no distinct symbol
 * (or an unsupported one) comes back as the code itself, never as a stray `$`.
 */
export function currencySymbol(currency = 'USD'): string {
  const code = currency || 'USD'
  const cached = symbolCache.get(code)
  if (cached) return cached

  let symbol = code
  try {
    const parts = new Intl.NumberFormat(undefined, { style: 'currency', currency: code }).formatToParts(0)
    const found = parts.find((part) => part.type === 'currency')?.value
    // `Intl` prints the generic currency sign for a code it does not know.
    if (found && found !== '¤') symbol = found
  } catch {
    symbol = code
  }
  symbolCache.set(code, symbol)
  return symbol
}

export function percentOf(cents: number, percent: number): number {
  if (!Number.isFinite(cents) || !Number.isFinite(percent)) return 0
  return Math.round((cents * percent) / 100)
}

export function clampPercent(percent: number): number {
  if (!Number.isFinite(percent)) return 0
  return Math.min(100, Math.max(0, Math.round(percent)))
}

export function floorToDollarCents(cents: number): number {
  return Math.floor(cents / 100) * 100
}

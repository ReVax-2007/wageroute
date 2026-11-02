const MONEY_INPUT = /^\d*(\.\d{0,2})?$/

/**
 * What a money field may hold while it is being typed or pasted: digits, one
 * decimal point and at most two decimals. Currency symbols, spaces and thousand
 * separators are dropped rather than rejected, so pasting `$1,850.00` works.
 * A minus sign survives only when the field accepts negative amounts.
 */
export function sanitizeMoneyInput(raw: string, options: { allowNegative?: boolean } = {}): string {
  return sanitizeDecimalInput(raw, options.allowNegative ?? false)
}

/** The same restraint for a percentage: no sign, one decimal point, two decimals. */
export function sanitizePercentInput(raw: string): string {
  return sanitizeDecimalInput(raw, false)
}

function sanitizeDecimalInput(raw: string, allowNegative: boolean): string {
  const text = typeof raw === 'string' ? raw : ''
  // A leading minus may sit after a currency symbol, but not after a digit: the
  // same rule the field always had, now decided before separators are touched.
  const firstValueChar = text.search(/[0-9.]/)
  const minusAt = text.indexOf('-')
  const negative =
    allowNegative && minusAt !== -1 && (firstValueChar === -1 || minusAt < firstValueChar)

  // Clean first, then decide whether a comma is a decimal point or grouping.
  // Dropping commas before parsing turned a typed `12,50` into $1,250.
  const cleaned = text.replace(/[\s$]/g, '').replace(/[^0-9.,]/g, '')
  const normalised = normaliseForInput(cleaned)

  let body = ''
  let seenPoint = false
  let decimals = 0
  for (const char of normalised) {
    if (char === '.' && !seenPoint) {
      seenPoint = true
      body += char
      continue
    }
    if (char >= '0' && char <= '9') {
      if (seenPoint) {
        if (decimals >= 2) continue
        decimals += 1
      }
      body += char
    }
  }

  return `${negative ? '-' : ''}${body}`
}

/** Canonical digits with one decimal point, for a field being typed into. */
function normaliseForInput(text: string): string {
  const lastComma = text.lastIndexOf(',')
  if (lastComma === -1) return text

  const lastDot = text.lastIndexOf('.')
  if (lastDot !== -1) {
    // The rightmost separator is the decimal; the other one only groups.
    if (lastComma > lastDot) {
      const parts = text.split(',')
      const fraction = parts.pop() ?? ''
      return `${parts.join('').replace(/\./g, '')}.${fraction}`
    }
    return text.replace(/,/g, '')
  }

  const groups = text.split(',')
  if (groups.slice(1).every((group) => /^\d{3}$/.test(group))) return groups.join('')

  // One or two digits after the last comma (or nothing yet) reads as a decimal
  // comma; anything else keeps the last comma as the point so typing stays sane.
  const fraction = groups.pop() ?? ''
  return `${groups.join('')}.${fraction}`
}

export function parseMoneyToCents(raw: string): number | null {
  if (typeof raw !== 'string') return null
  let text = raw.trim()
  if (!text) return null

  let negative = false
  if (text.startsWith('(') && text.endsWith(')')) {
    negative = true
    text = text.slice(1, -1).trim()
  }

  text = text.replace(/[\s$]/g, '')
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

  const normalised = normaliseSeparators(text)
  if (normalised === null) return null
  text = normalised

  // Nothing numeric left: a bare "$", "usd" or "-" is not zero.
  if (!MONEY_INPUT.test(text) || text === '' || text === '.') return null

  const [whole, fraction = ''] = text.split('.')
  const dollars = whole === '' ? 0 : Number(whole)
  const cents = Number(`${fraction}00`.slice(0, 2))
  const total = (negative ? -1 : 1) * (dollars * 100 + cents)
  return Number.isSafeInteger(total) ? total : null
}

/**
 * Reads a comma as either a decimal point or a thousands separator without
 * knowing the user's locale. Twelve-fifty is written `12,50` in much of the
 * world and `12.50` in the rest; treating every comma as grouping turned a
 * Dutch bank line into $1,250. A lone comma with one or two trailing digits is
 * a decimal comma, three digits on every group is thousands, and when both
 * separators appear the rightmost one is the decimal.
 */
function normaliseSeparators(text: string): string | null {
  if (!text.includes(',')) return text

  const lastComma = text.lastIndexOf(',')
  const lastDot = text.lastIndexOf('.')
  if (lastDot === -1) {
    const groups = text.split(',')
    if (groups.length === 2 && /^\d{1,2}$/.test(groups[1])) {
      return `${groups[0]}.${groups[1]}`
    }
    if (groups.slice(1).every((group) => /^\d{3}$/.test(group))) return groups.join('')
    return null
  }

  if (lastComma > lastDot) {
    // `1.234,56`: the dot groups, the comma is the decimal point.
    const groups = text.split(',')
    if (groups.length !== 2) return null
    const whole = groups[0].split('.')
    if (
      whole.length > 1 &&
      !whole.slice(1).every((group) => /^\d{3}$/.test(group))
    ) {
      return null
    }
    return `${whole.join('')}.${groups[1]}`
  }

  // `1,234.56`: the comma can only be grouping.
  const point = text.lastIndexOf('.')
  const whole = text.slice(0, point).split(',')
  if (whole.length > 1 && !whole.slice(1).every((group) => /^\d{3}$/.test(group))) {
    return null
  }
  return `${whole.join('')}${text.slice(point)}`
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

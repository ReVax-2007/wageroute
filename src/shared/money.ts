const MONEY_INPUT = /^\d*(\.\d{0,2})?$/

/**
 * What a money field may hold while it is being typed or pasted: digits,
 * separators and an optional leading minus. Currency symbols and spaces are
 * dropped. Commas and extra decimals stay put until the field is left, because
 * `1,850` and `12,50` are the same keystrokes for two very different amounts
 * and only the finished text can tell them apart. Resolving each keystroke
 * turned a typed `1,850` into `1.85`. A minus sign survives only when the
 * field accepts negative amounts.
 */
export function sanitizeMoneyInput(raw: string, options: { allowNegative?: boolean } = {}): string {
  const text = typeof raw === 'string' ? raw : ''
  // A leading minus may sit after a currency symbol, but not after a digit: the
  // same rule the field always had.
  const firstValueChar = text.search(/[0-9.]/)
  const minusAt = text.indexOf('-')
  const negative =
    (options.allowNegative ?? false) &&
    minusAt !== -1 &&
    (firstValueChar === -1 || minusAt < firstValueChar)

  let body = ''
  let seenPoint = false
  for (const char of text.replace(/[\s$]/g, '')) {
    if (char === '.') {
      if (!seenPoint) {
        seenPoint = true
        body += char
      }
      continue
    }
    if ((char >= '0' && char <= '9') || char === ',') body += char
  }

  return `${negative ? '-' : ''}${body}`
}

/**
 * The value a money field settles on when it is left: the typed text read one
 * last time and written in the one form the field then holds — digits, one
 * point, two decimals. Text that cannot be read is returned unchanged, so the
 * form can point at it instead of quietly storing a different number.
 */
export function canonicalMoneyInput(
  raw: string,
  options: { allowNegative?: boolean } = {}
): string {
  const typed = sanitizeMoneyInput(raw, options)
  // A trailing decimal comma is a finished `12,` whose fraction is empty, the
  // same as `12.`; without this the field kept a value the parser refuses.
  const settled = typed.endsWith(',') ? typed.slice(0, -1) : typed
  const cents = parseMoneyToCents(settled)
  return cents === null ? typed : centsToEditable(cents)
}

/**
 * A percentage has no thousands separator to confuse, so a comma is always the
 * decimal point. Reading `0,125` as grouping turned a fraction of a percent
 * into 125%; it now becomes `0.12`, capped at two decimals like the field.
 */
export function sanitizePercentInput(raw: string): string {
  const text = typeof raw === 'string' ? raw : ''
  const cleaned = text
    .replace(/[\s$%]/g, '')
    .replace(/[^0-9.,]/g, '')
    .replace(/,/g, '.')

  let body = ''
  let seenPoint = false
  let decimals = 0
  for (const char of cleaned) {
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

  return body
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

/**
 * Compact notation is for a headline that would otherwise overflow. Below
 * $10,000 the amount prints exactly with its cents, so it matches the rows it
 * summarises instead of showing `$12.5` beside a `$12.50` row.
 */
export function formatMoneyCompact(cents: number, currency = 'USD'): string {
  if (Math.abs(cents) < 1_000_000) return formatMoney(cents, currency)
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

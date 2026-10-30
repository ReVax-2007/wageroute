import { isISODate } from './dates'
import { clampPercent } from './money'
import type {
  AppSettings,
  EmergencyMode,
  PayCadence,
  RoundUpIncrementCents,
  ThemePreference
} from './types'

export const DEFAULT_SETTINGS: AppSettings = {
  currency: 'USD',
  payCadence: 'biweekly',
  paydayLabel: '',
  payAnchorDate: null,
  defaultDepositAccountId: null,
  savingsPercent: 20,
  investmentPercent: 15,
  goalsPercent: 15,
  debtPercent: 0,
  wholeDollarBuckets: true,
  theme: 'dark',
  roundUpEnabled: false,
  roundUpAccountId: null,
  roundUpToCents: 100,
  emergencyMode: 'auto',
  emergencyMonths: 3,
  emergencyIncludeVariable: true,
  emergencyManualTargetCents: 0,
  emergencyActive: true
}

const PAY_CADENCES: readonly PayCadence[] = ['weekly', 'biweekly', 'semimonthly', 'monthly']
const THEMES: readonly ThemePreference[] = ['dark', 'light', 'system']
const ROUND_UP_INCREMENTS: readonly RoundUpIncrementCents[] = [100, 200, 500]
const EMERGENCY_MODES: readonly EmergencyMode[] = ['auto', 'manual']

/**
 * Three capital letters are not a currency: `NumberFormat` accepts `ZZZ` and
 * prints it, so a typo becomes a ledger that shows one currency and no error.
 * `supportedValuesOf` carries the canonical ISO list; older engines without it
 * keep the shape check rather than rejecting everything.
 */
const KNOWN_CURRENCIES = ((): Set<string> | null => {
  const supported = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] })
    .supportedValuesOf
  if (typeof supported !== 'function') return null
  try {
    return new Set(supported('currency'))
  } catch {
    return null
  }
})()

export function isCurrencyCode(value: string | null | undefined): value is string {
  if (!value || !/^[A-Z]{3}$/.test(value)) return false
  return KNOWN_CURRENCIES === null || KNOWN_CURRENCIES.has(value)
}

export function parseSettings(record: Record<string, string>): AppSettings {
  const percentage = (key: keyof AppSettings, fallback: number): number => {
    const raw = record[key]
    if (raw === undefined) return fallback
    const value = Number(raw)
    return Number.isFinite(value) ? clampPercent(value) : fallback
  }

  const bool = (key: keyof AppSettings, fallback: boolean): boolean => {
    const raw = record[key]
    if (raw === undefined) return fallback
    // A backup can carry a JSON boolean, which the importer stringifies as
    // `1`/`0`; both spellings mean the same thing.
    if (raw === 'true' || raw === '1') return true
    if (raw === 'false' || raw === '0') return false
    return fallback
  }

  const choice = <T extends string>(
    key: keyof AppSettings,
    allowed: readonly T[],
    fallback: T
  ): T => {
    const raw = record[key]
    return raw && allowed.includes(raw as T) ? (raw as T) : fallback
  }

  const cadence = record.payCadence
  const currency = record.currency
  const months = Number(record.emergencyMonths)
  const manualTarget = Number(record.emergencyManualTargetCents)
  const roundUpRaw = Number(record.roundUpToCents)

  return {
    currency: isCurrencyCode(currency) ? currency : DEFAULT_SETTINGS.currency,
    payCadence:
      cadence && PAY_CADENCES.includes(cadence as PayCadence)
        ? (cadence as PayCadence)
        : DEFAULT_SETTINGS.payCadence,
    paydayLabel: (record.paydayLabel ?? '').trim(),
    payAnchorDate: isISODate(record.payAnchorDate) ? record.payAnchorDate : null,
    defaultDepositAccountId:
      record.defaultDepositAccountId && record.defaultDepositAccountId.length > 0
        ? record.defaultDepositAccountId
        : DEFAULT_SETTINGS.defaultDepositAccountId,
    savingsPercent: percentage('savingsPercent', DEFAULT_SETTINGS.savingsPercent),
    investmentPercent: percentage('investmentPercent', DEFAULT_SETTINGS.investmentPercent),
    goalsPercent: percentage('goalsPercent', DEFAULT_SETTINGS.goalsPercent),
    debtPercent: percentage('debtPercent', DEFAULT_SETTINGS.debtPercent),
    wholeDollarBuckets: bool('wholeDollarBuckets', DEFAULT_SETTINGS.wholeDollarBuckets),
    theme: choice('theme', THEMES, DEFAULT_SETTINGS.theme),
    roundUpEnabled: bool('roundUpEnabled', DEFAULT_SETTINGS.roundUpEnabled),
    roundUpAccountId:
      record.roundUpAccountId && record.roundUpAccountId.length > 0
        ? record.roundUpAccountId
        : DEFAULT_SETTINGS.roundUpAccountId,
    roundUpToCents: ROUND_UP_INCREMENTS.includes(roundUpRaw as RoundUpIncrementCents)
      ? (roundUpRaw as RoundUpIncrementCents)
      : DEFAULT_SETTINGS.roundUpToCents,
    emergencyMode: choice('emergencyMode', EMERGENCY_MODES, DEFAULT_SETTINGS.emergencyMode),
    emergencyMonths:
      Number.isFinite(months) && months >= 1 && months <= 12
        ? Math.round(months)
        : DEFAULT_SETTINGS.emergencyMonths,
    emergencyIncludeVariable: bool(
      'emergencyIncludeVariable',
      DEFAULT_SETTINGS.emergencyIncludeVariable
    ),
    emergencyManualTargetCents:
      Number.isFinite(manualTarget) && manualTarget > 0
        ? Math.round(manualTarget)
        : DEFAULT_SETTINGS.emergencyManualTargetCents,
    emergencyActive: bool('emergencyActive', DEFAULT_SETTINGS.emergencyActive)
  }
}

export function settingsToRecord(settings: AppSettings): Record<string, string> {
  return {
    currency: settings.currency,
    payCadence: settings.payCadence,
    paydayLabel: settings.paydayLabel,
    payAnchorDate: settings.payAnchorDate ?? '',
    defaultDepositAccountId: settings.defaultDepositAccountId ?? '',
    savingsPercent: String(settings.savingsPercent),
    investmentPercent: String(settings.investmentPercent),
    goalsPercent: String(settings.goalsPercent),
    debtPercent: String(settings.debtPercent),
    wholeDollarBuckets: String(settings.wholeDollarBuckets),
    theme: settings.theme,
    roundUpEnabled: String(settings.roundUpEnabled),
    roundUpAccountId: settings.roundUpAccountId ?? '',
    roundUpToCents: String(settings.roundUpToCents),
    emergencyMode: settings.emergencyMode,
    emergencyMonths: String(settings.emergencyMonths),
    emergencyIncludeVariable: String(settings.emergencyIncludeVariable),
    emergencyManualTargetCents: String(settings.emergencyManualTargetCents),
    emergencyActive: String(settings.emergencyActive)
  }
}

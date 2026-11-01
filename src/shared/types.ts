export type Frequency =
  | 'weekly'
  | 'biweekly'
  | 'semimonthly'
  | 'monthly'
  | 'quarterly'
  | 'annual'

export type PayCadence = 'weekly' | 'biweekly' | 'semimonthly' | 'monthly'

export type AccountKind = 'checking' | 'savings' | 'cash' | 'investment' | 'credit'

export type ThemePreference = 'dark' | 'light' | 'system'

export type RoundUpIncrementCents = 100 | 200 | 500

export type EmergencyMode = 'auto' | 'manual'

export type TransactionKind =
  | 'income'
  | 'expense'
  | 'bill_payment'
  | 'transfer'
  | 'goal_funding'
  | 'investment'
  | 'adjustment'

export type CategoryKind = 'expense' | 'income' | 'transfer' | 'other'

export type AllocationBucket =
  | 'priority'
  | 'savings'
  | 'investment'
  | 'goal'
  | 'debt'
  | 'leisure'

export type PlanHealth = 'covered' | 'tight' | 'shortfall'

export type BillFundingStrategy =
  | 'all_checks'
  | 'closest_due_date'
  | 'specific_check'
  | 'first_check'
  | 'last_check'

export interface SyncMeta {
  createdAt: string
  updatedAt: string
  deletedAt: string | null
  revision: number
}

export interface User extends SyncMeta {
  id: string
  email: string | null
  displayName: string
  currency: string
}

export interface Account extends SyncMeta {
  id: string
  userId: string
  name: string
  kind: AccountKind
  institution: string | null
  startingBalanceCents: number
  creditLimitCents: number | null
  color: string | null
  /** The one goal this account exists to fund; its balance becomes that goal's progress. */
  dedicatedGoalId: string | null
  /** null means "derive from the account kind". */
  inSafeToSpend: boolean | null
  isArchived: boolean
  sortOrder: number
  /** Debt terms, meaningful on a credit account (and on a loan-like account). */
  aprBps: number | null
  minimumPaymentCents: number | null
  /** Card cycle: the day the statement closes and the day its payment is due. */
  statementDay: number | null
  paymentDueDay: number | null
  lastStatementBalanceCents: number | null
}

export interface AccountWithBalance extends Account {
  /** Every non-deleted entry, including ones dated in the future. */
  balanceCents: number
  /** The same sum restricted to entries dated today or earlier. */
  cashCents: number
}

export interface Bill extends SyncMeta {
  id: string
  userId: string
  name: string
  amountCents: number
  frequency: Frequency
  dueDay: number
  category: string
  accountId: string | null
  autopay: boolean
  isActive: boolean
  nextDueOn: string | null
  fundingStrategy: BillFundingStrategy
  fundingPaycheckIndex: number | null
}

export interface Goal extends SyncMeta {
  id: string
  userId: string
  name: string
  targetCents: number
  targetDate: string | null
  priority: number
  color: string
  accountId: string | null
  isEmergency: boolean
  isArchived: boolean
}

export type GoalFundingSource = 'allocations' | 'account'

/** One account whose balance counts as a goal's progress. */
export interface GoalFundingAccount {
  id: string
  name: string
  balanceCents: number
}

export interface GoalWithProgress extends Goal {
  fundedCents: number
  remainingCents: number
  /** 'account' when one or more dedicated accounts make up the progress. */
  fundedFrom: GoalFundingSource
  /** Empty unless fundedFrom is 'account'; their balances add up to fundedCents. */
  dedicatedAccounts: GoalFundingAccount[]
}

export interface Transaction extends SyncMeta {
  id: string
  userId: string
  accountId: string
  kind: TransactionKind
  amountCents: number
  occurredOn: string
  memo: string
  category: string
  /** The category row this entry points at; null for rows imported before schema 8. */
  categoryId: string | null
  /** The bank's own id (OFX FITID or CSV transaction id) when it was stated. */
  externalId: string | null
  billId: string | null
  goalId: string | null
  paycheckId: string | null
  counterAccountId: string | null
  transferGroupId: string | null
}

export interface TransactionRow extends Transaction {
  accountName: string
  /** Joined from the account, tombstoned or not, so an export keeps its bank. */
  accountInstitution: string | null
}

export interface Paycheck extends SyncMeta {
  id: string
  userId: string
  amountCents: number
  receivedOn: string
  source: string
  depositAccountId: string | null
  priorityCents: number
  surplusCents: number
  leisureCents: number
  health: PlanHealth
}

export interface Allocation extends SyncMeta {
  id: string
  userId: string
  paycheckId: string
  bucket: AllocationBucket
  goalId: string | null
  label: string
  amountCents: number
}

export interface PaycheckWithAllocations extends Paycheck {
  allocations: Allocation[]
}

/**
 * Money the wall has already set aside for one bill in one calendar month.
 * `reserved` means the cheque carried it; `paid` means a matching bill payment
 * was recorded. A second cheque in the same cycle must not reserve it again.
 */
export type BillReserveState = 'reserved' | 'paid'

export interface BillReserve extends SyncMeta {
  id: string
  userId: string
  billId: string
  paycheckId: string
  /** Calendar month being funded, `YYYY-MM`. */
  cycle: string
  amountCents: number
  state: BillReserveState
}

export interface Category extends SyncMeta {
  id: string
  userId: string
  name: string
  kind: CategoryKind
  color: string | null
  sortOrder: number
}

/** One account's balance on one calendar day, recorded once per day on open. */
export interface BalanceSnapshot extends SyncMeta {
  id: string
  userId: string
  accountId: string
  onDate: string
  balanceCents: number
}

export interface Snapshot {
  user: User
  settings: Record<string, string>
  accounts: AccountWithBalance[]
  bills: Bill[]
  goals: GoalWithProgress[]
  categories: Category[]
  /** The newest entries only; `transactionTotal` says how many exist. */
  transactions: TransactionRow[]
  /** Every live entry, including any the capped grid leaves out. */
  transactionTotal: number
  /** The newest routed checks only; `paycheckTotal` says how many exist. */
  paychecks: PaycheckWithAllocations[]
  paycheckTotal: number
  billReserves: BillReserve[]
  /** Daily balances for the trend; capped at the newest year. */
  balanceSnapshots: BalanceSnapshot[]
}

/**
 * The snapshot tables one write touched. The screen applies these instead of
 * re-reading the whole ledger, which is what made every grid keystroke refetch
 * every account, goal and payment in the file.
 */
export type SnapshotPatch = Partial<Snapshot>

export interface AccountInput {
  name: string
  kind: AccountKind
  institution: string
  startingBalanceCents: number
  creditLimitCents?: number | null
  color?: string | null
  dedicatedGoalId?: string | null
  inSafeToSpend?: boolean | null
  sortOrder?: number
  aprBps?: number | null
  minimumPaymentCents?: number | null
  statementDay?: number | null
  paymentDueDay?: number | null
  lastStatementBalanceCents?: number | null
}

export interface CategoryInput {
  name: string
  kind: CategoryKind
  color?: string | null
}

export interface BillInput {
  name: string
  amountCents: number
  frequency: Frequency
  dueDay: number
  category: string
  accountId: string | null
  autopay: boolean
  isActive: boolean
  nextDueOn: string | null
  fundingStrategy?: BillFundingStrategy
  fundingPaycheckIndex?: number | null
}

export interface GoalInput {
  name: string
  targetCents: number
  targetDate: string | null
  priority: number
  color: string
  accountId: string | null
  isEmergency?: boolean
  /**
   * Accounts whose balances become this goal's progress. Omitted means "leave
   * the current dedication alone"; an empty array releases every account.
   * Applied in the same transaction as the goal write, so a save is all-or-nothing.
   */
  fundingAccountIds?: string[]
}

export interface TransactionInput {
  accountId: string
  kind: TransactionKind
  amountCents: number
  occurredOn: string
  memo: string
  category: string
  /** The picker's choice; when omitted the name is matched or created. */
  categoryId?: string | null
  billId?: string | null
  goalId?: string | null
  counterAccountId?: string | null
}

export type TransactionPatch = Partial<
  Pick<
    TransactionInput,
    'accountId' | 'kind' | 'amountCents' | 'occurredOn' | 'memo' | 'category' | 'categoryId'
  >
>

/**
 * What the ledger grid is asking for. The main process turns this into one
 * indexed query, so filtering 20,000 rows never means shipping them to the
 * renderer first.
 */
export interface LedgerFilter {
  text?: string
  from?: string | null
  to?: string | null
  accountId?: string | null
  kind?: TransactionKind | null
  categoryId?: string | null
}

export type LedgerSort = 'date_desc' | 'date_asc' | 'amount_desc' | 'amount_asc'

export interface LedgerQuery {
  filter: LedgerFilter
  sort: LedgerSort
  limit: number
  offset: number
}

export interface TransactionPage {
  rows: TransactionRow[]
  /** Rows matching the filter, ignoring the page window. */
  total: number
}

export interface AllocatorSplitsInput {
  savingsPercent: number
  investmentPercent: number
  goalsPercent: number
  debtPercent: number
}

export interface PaycheckDraftInput {
  incomeCents: number
  receivedOn: string
  source: string
  depositAccountId: string | null
  payCadence: PayCadence
  splits: AllocatorSplitsInput
  wholeDollarBuckets: boolean
  /** Set only after the user confirms a likely double entry. */
  allowDuplicate?: boolean
}

export interface AppSettings {
  currency: string
  payCadence: PayCadence
  /** Free text naming the paydays, e.g. "15th and last day". Display only. */
  paydayLabel: string
  /**
   * A known payday. Weekly and biweekly slots are projected from it instead of
   * guessed from day-of-month ranges, so a 15th/30th earner's two checks each
   * reserve the bills assigned to them.
   */
  payAnchorDate: string | null
  /** Preselected by the allocator; falls back to the first checking account. */
  defaultDepositAccountId: string | null
  savingsPercent: number
  investmentPercent: number
  goalsPercent: number
  debtPercent: number
  wholeDollarBuckets: boolean
  theme: ThemePreference
  roundUpEnabled: boolean
  roundUpAccountId: string | null
  roundUpToCents: RoundUpIncrementCents
  emergencyMode: EmergencyMode
  emergencyMonths: number
  emergencyIncludeVariable: boolean
  emergencyManualTargetCents: number
  /**
   * When false the emergency goal is excluded from the allocator, so no
   * paycheck reserves towards it until saving is resumed.
   */
  emergencyActive: boolean
}

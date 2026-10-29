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
}

export interface AccountWithBalance extends Account {
  balanceCents: number
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
  billId: string | null
  goalId: string | null
  paycheckId: string | null
  counterAccountId: string | null
  transferGroupId: string | null
}

export interface TransactionRow extends Transaction {
  accountName: string
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

export interface Snapshot {
  user: User
  settings: Record<string, string>
  accounts: AccountWithBalance[]
  bills: Bill[]
  goals: GoalWithProgress[]
  transactions: TransactionRow[]
  paychecks: PaycheckWithAllocations[]
}

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
  billId?: string | null
  goalId?: string | null
  counterAccountId?: string | null
}

export type TransactionPatch = Partial<
  Pick<
    TransactionInput,
    'accountId' | 'kind' | 'amountCents' | 'occurredOn' | 'memo' | 'category'
  >
>

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
}

export interface AppSettings {
  currency: string
  payCadence: PayCadence
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

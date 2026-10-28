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

export interface GoalWithProgress extends Goal {
  fundedCents: number
  remainingCents: number
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
}

export interface GoalInput {
  name: string
  targetCents: number
  targetDate: string | null
  priority: number
  color: string
  accountId: string | null
  isEmergency?: boolean
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
}

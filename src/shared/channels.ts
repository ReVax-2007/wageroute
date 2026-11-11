import type {
  AppDiagnostics,
  AppInfo,
  BillDeletionSummary,
  CommittedPaycheck,
  ImportNeedsPassphrase,
  ImportPreview,
  ImportResult,
  LegalTexts,
  StorageCandidate,
  StorageLocationInfo,
  StorageMoveMode,
  StorageMoveResult,
  WriteResult
} from './api'
import type { ImportAnswer } from './importRepair'
import type {
  EnableEncryptionRequest,
  EncryptionChange,
  EncryptionStatus,
  KeyCustodyChange
} from './encryption'
import type {
  AccountInput,
  AppliedPlan,
  AppSettings,
  BillInput,
  BillPaymentTotal,
  CategoryInput,
  GoalInput,
  LedgerQuery,
  PaycheckDraftInput,
  PlanMoveTarget,
  Snapshot,
  SplitTransferInput,
  TransactionInput,
  TransactionPage,
  TransactionPatch
} from './types'

/**
 * One place that says what each IPC channel carries in and out. Preload and the
 * main process both derive their signatures from this map, so a renamed channel
 * or a changed payload cannot drift between the two halves of the app.
 *
 * The types describe the wire: the main process still validates every id and
 * option it receives, because a type is not a runtime guarantee.
 */
export interface IpcContract {
  'snapshot:get': { args: []; result: Snapshot }
  'db:path': { args: []; result: string }
  'app:info': { args: []; result: AppInfo }
  'app:diagnostics': { args: []; result: AppDiagnostics }
  'app:legal': { args: []; result: LegalTexts }
  'storage:location': { args: []; result: StorageLocationInfo }
  'storage:choose': { args: []; result: StorageCandidate | null }
  'storage:apply': {
    args: [string, StorageMoveMode]
    result: StorageMoveResult
  }
  'storage:default': { args: []; result: StorageMoveResult }

  /** What the folder reports now: the header's answer plus the marker's. */
  'encryption:status': { args: []; result: EncryptionStatus }
  /**
   * Rewrites every page of the ledger. It does not resolve into a usable
   * session: the transition needs the app's own handle closed to run, and that
   * handle is bound to the state it opened in, so WageRoute restarts either way.
   */
  'encryption:enable': { args: [EnableEncryptionRequest]; result: EncryptionChange }
  'encryption:disable': { args: []; result: EncryptionChange }
  /**
   * Re-wraps the 32-byte key for a different way of holding it. No page moves,
   * so the session survives it and the new status comes straight back.
   */
  'encryption:custody': { args: [KeyCustodyChange]; result: EncryptionStatus }

  'user:set-name': { args: [string]; result: WriteResult<void> }

  'account:create': { args: [AccountInput]; result: WriteResult<string> }
  'account:update': { args: [string, Partial<AccountInput>]; result: WriteResult<void> }
  'account:delete': { args: [string, { withEntries?: boolean }?]; result: WriteResult<void> }
  'account:archive': { args: [string, boolean]; result: WriteResult<void> }
  'account:count-deletion': { args: [string]; result: number }

  'bill:create': { args: [BillInput]; result: WriteResult<string> }
  'bill:update': { args: [string, Partial<BillInput>]; result: WriteResult<void> }
  'bill:delete': { args: [string]; result: WriteResult<void> }
  'bill:payments': { args: [string]; result: BillPaymentTotal[] }
  'bill:count-deletion': { args: [string]; result: BillDeletionSummary }

  'category:create': { args: [CategoryInput]; result: WriteResult<string> }
  'category:update': { args: [string, Partial<CategoryInput>]; result: WriteResult<void> }
  'category:delete': { args: [string]; result: WriteResult<void> }

  'goal:create': { args: [GoalInput]; result: WriteResult<string> }
  'goal:update': { args: [string, Partial<GoalInput>]; result: WriteResult<void> }
  'goal:delete': { args: [string]; result: WriteResult<void> }
  'goal:archive': { args: [string, boolean]; result: WriteResult<void> }

  'transaction:create': { args: [TransactionInput]; result: WriteResult<string> }
  'transaction:create-split': { args: [SplitTransferInput]; result: WriteResult<string[]> }
  'transaction:update': { args: [string, TransactionPatch]; result: WriteResult<void> }
  'transaction:delete': { args: [string]; result: WriteResult<void> }
  'transaction:delete-many': { args: [string[]]; result: WriteResult<number> }
  'transaction:count-deletion': { args: [string[]]; result: number }
  'transaction:query': { args: [LedgerQuery]; result: TransactionPage }

  'paycheck:commit': { args: [PaycheckDraftInput]; result: WriteResult<CommittedPaycheck> }
  'paycheck:apply': { args: [string, PlanMoveTarget[]]; result: WriteResult<AppliedPlan> }
  'settings:save': { args: [AppSettings]; result: WriteResult<void> }

  'backup:export': { args: [string | null]; result: string | null }
  'csv:export': { args: []; result: string | null }
  'statement:reconcile': { args: [string, number, string]; result: WriteResult<number> }
  'data:preview': { args: [], result: ImportPreview | ImportNeedsPassphrase | null }
  'data:passphrase': { args: [string, string]; result: ImportPreview }
  'data:confirm': { args: [string, ImportAnswer[]]; result: ImportResult }
  'data:reset': { args: []; result: WriteResult<void> }
}

export type Channel = keyof IpcContract
export type ChannelArgs<C extends Channel> = IpcContract[C]['args']
export type ChannelResult<C extends Channel> = IpcContract[C]['result']

/**
 * The two messages an unlock prompt can cross, deliberately outside `IpcContract`.
 * The contract is the ledger API, and while the ledger is locked there is no
 * ledger API to have: no channel in it is registered yet. The names are shared so
 * the window and the main process cannot disagree about what is being listened for.
 */
export const UNLOCK_SUBMIT = 'wageroute:unlock-submit'
export const UNLOCK_RETRY = 'wageroute:unlock-retry'

/** The one callable the renderer side hands around; both halves use it. */
export type IpcCaller = <C extends Channel>(
  channel: C,
  ...args: ChannelArgs<C>
) => Promise<ChannelResult<C>>

/** Every channel, for the coverage test and the boot-time registration check. */
export const CHANNELS = [
  'snapshot:get',
  'db:path',
  'app:info',
  'app:diagnostics',
  'app:legal',
  'storage:location',
  'storage:choose',
  'storage:apply',
  'storage:default',
  'encryption:status',
  'encryption:enable',
  'encryption:disable',
  'encryption:custody',
  'user:set-name',
  'account:create',
  'account:update',
  'account:delete',
  'account:archive',
  'account:count-deletion',
  'bill:create',
  'bill:update',
  'bill:delete',
  'bill:payments',
  'bill:count-deletion',
  'category:create',
  'category:update',
  'category:delete',
  'goal:create',
  'goal:update',
  'goal:delete',
  'goal:archive',
  'transaction:create',
  'transaction:create-split',
  'transaction:update',
  'transaction:delete',
  'transaction:delete-many',
  'transaction:count-deletion',
  'transaction:query',
  'paycheck:commit',
  'paycheck:apply',
  'settings:save',
  'backup:export',
  'csv:export',
  'statement:reconcile',
  'data:preview',
  'data:passphrase',
  'data:confirm',
  'data:reset'
] as const satisfies readonly Channel[]

// Adding a channel to the contract without listing it above would leave it out
// of that check, so the omission is a type error.
type UnlistedChannel = Exclude<Channel, (typeof CHANNELS)[number]>
const everyChannelIsListed: UnlistedChannel extends never ? true : never = true
void everyChannelIsListed

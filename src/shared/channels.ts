import type {
  AppDiagnostics,
  AppInfo,
  CommittedPaycheck,
  ImportPreview,
  ImportResult,
  LegalTexts,
  WriteResult
} from './api'
import type { ImportAnswer } from './importRepair'
import type {
  AccountInput,
  AppSettings,
  BillInput,
  CategoryInput,
  GoalInput,
  LedgerQuery,
  PaycheckDraftInput,
  Snapshot,
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

  'account:create': { args: [AccountInput]; result: WriteResult<string> }
  'account:update': { args: [string, Partial<AccountInput>]; result: WriteResult<void> }
  'account:delete': { args: [string, { withEntries?: boolean }?]; result: WriteResult<void> }
  'account:archive': { args: [string, boolean]; result: WriteResult<void> }
  'account:entry-count': { args: [string]; result: number }

  'bill:create': { args: [BillInput]; result: WriteResult<string> }
  'bill:update': { args: [string, Partial<BillInput>]; result: WriteResult<void> }
  'bill:delete': { args: [string]; result: WriteResult<void> }

  'category:create': { args: [CategoryInput]; result: WriteResult<string> }
  'category:update': { args: [string, Partial<CategoryInput>]; result: WriteResult<void> }
  'category:delete': { args: [string]; result: WriteResult<void> }

  'goal:create': { args: [GoalInput]; result: WriteResult<string> }
  'goal:update': { args: [string, Partial<GoalInput>]; result: WriteResult<void> }
  'goal:delete': { args: [string]; result: WriteResult<void> }
  'goal:archive': { args: [string, boolean]; result: WriteResult<void> }

  'transaction:create': { args: [TransactionInput]; result: WriteResult<string> }
  'transaction:update': { args: [string, TransactionPatch]; result: WriteResult<void> }
  'transaction:delete': { args: [string]; result: WriteResult<void> }
  'transaction:delete-many': { args: [string[]]; result: WriteResult<number> }
  'transaction:query': { args: [LedgerQuery]; result: TransactionPage }

  'paycheck:commit': { args: [PaycheckDraftInput]; result: WriteResult<CommittedPaycheck> }
  'settings:save': { args: [AppSettings]; result: WriteResult<void> }

  'backup:export': { args: []; result: string | null }
  'csv:export': { args: []; result: string | null }
  'data:preview': { args: []; result: ImportPreview | null }
  'data:confirm': { args: [string, ImportAnswer[]]; result: ImportResult }
  'data:reset': { args: []; result: WriteResult<void> }
}

export type Channel = keyof IpcContract
export type ChannelArgs<C extends Channel> = IpcContract[C]['args']
export type ChannelResult<C extends Channel> = IpcContract[C]['result']

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
  'account:create',
  'account:update',
  'account:delete',
  'account:archive',
  'account:entry-count',
  'bill:create',
  'bill:update',
  'bill:delete',
  'category:create',
  'category:update',
  'category:delete',
  'goal:create',
  'goal:update',
  'goal:delete',
  'goal:archive',
  'transaction:create',
  'transaction:update',
  'transaction:delete',
  'transaction:delete-many',
  'transaction:query',
  'paycheck:commit',
  'settings:save',
  'backup:export',
  'csv:export',
  'data:preview',
  'data:confirm',
  'data:reset'
] as const satisfies readonly Channel[]

// Adding a channel to the contract without listing it above would leave it out
// of that check, so the omission is a type error.
type UnlistedChannel = Exclude<Channel, (typeof CHANNELS)[number]>
const everyChannelIsListed: UnlistedChannel extends never ? true : never = true
void everyChannelIsListed

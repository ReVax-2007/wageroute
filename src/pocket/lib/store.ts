import { create } from 'zustand'
import type { ImportTables } from '@shared/importRepair'
import { todayISO } from '@shared/dates'
import type { Snapshot } from '@shared/types'
import {
  BackupFileError,
  KNOWN_BACKUP_VERSION,
  backupToJson,
  parseBackup,
  type PocketBackup
} from './backup'
import { createEntryRow, type EntryDraft } from './entry'
import { deleteLedger, readLedger, writeLedger, type StoredLedger } from './idb'
import { buildSnapshot } from './snapshot'

type Status = 'loading' | 'empty' | 'ready'

interface PocketState {
  status: Status
  tables: ImportTables | null
  version: number
  importedAt: string | null
  sourceName: string | null
  localIds: string[]
  notice: string | null
  error: string | null
  /** True when the imported file came from a newer desktop schema. */
  newerSchema: boolean
  load: () => Promise<void>
  importFile: (text: string, name: string) => Promise<void>
  addEntry: (draft: EntryDraft) => Promise<string>
  deleteEntry: (id: string) => Promise<void>
  forget: () => Promise<void>
  exportJson: () => string | null
  dismissNotice: () => void
  dismissError: () => void
}

function summarise(message: string): string {
  return message.endsWith('.') ? message : `${message}.`
}

async function persist(state: PocketState): Promise<void> {
  if (!state.tables || !state.importedAt) return
  const ledger: StoredLedger = {
    tables: state.tables,
    version: state.version,
    importedAt: state.importedAt,
    sourceName: state.sourceName ?? '',
    localIds: state.localIds
  }
  await writeLedger(ledger)
}

export const usePocket = create<PocketState>((set, get) => {
  const commit = async (
    tables: ImportTables,
    localIds: string[],
    notice: string | null = null
  ): Promise<void> => {
    set({ tables, localIds, notice, error: null })
    try {
      await persist(get())
    } catch (error) {
      set({
        error:
          error instanceof Error
            ? summarise(`Saved on this screen only: ${error.message}`)
            : 'Saved on this screen only: phone storage refused the write.'
      })
    }
  }

  return {
    status: 'loading',
    tables: null,
    version: KNOWN_BACKUP_VERSION,
    importedAt: null,
    sourceName: null,
    localIds: [],
    notice: null,
    error: null,
    newerSchema: false,

    load: async () => {
      try {
        const stored = await readLedger()
        if (!stored) {
          set({ status: 'empty' })
          return
        }
        set({
          status: 'ready',
          tables: stored.tables,
          version: stored.version,
          importedAt: stored.importedAt,
          sourceName: stored.sourceName,
          localIds: stored.localIds ?? [],
          newerSchema: stored.version > KNOWN_BACKUP_VERSION
        })
      } catch {
        set({ status: 'empty' })
      }
    },

    importFile: async (text, name) => {
      try {
        const backup = parseBackup(text)
        set({
          status: 'ready',
          tables: backup.tables,
          version: backup.version,
          importedAt: backup.exportedAt || new Date().toISOString(),
          sourceName: name,
          localIds: [],
          newerSchema: backup.version > KNOWN_BACKUP_VERSION,
          error: null,
          notice: 'Your ledger is on this phone now. It stays here.'
        })
        await persist(get())
      } catch (error) {
        if (error instanceof BackupFileError) {
          set({ error: summarise(error.message) })
          return
        }
        throw error
      }
    },

    addEntry: async (draft) => {
      const current = get()
      if (!current.tables) throw new Error('Import a backup first')
      const row = createEntryRow(current.tables, draft)
      const tables: ImportTables = {
        ...current.tables,
        transactions: [...current.tables.transactions, row]
      }
      await commit(tables, [...current.localIds, row.id as string], 'Entry saved on this phone.')
      return row.id as string
    },

    deleteEntry: async (id) => {
      const current = get()
      if (!current.tables) return
      const tables: ImportTables = {
        ...current.tables,
        transactions: current.tables.transactions.filter((row) => row.id !== id)
      }
      await commit(
        tables,
        current.localIds.filter((entryId) => entryId !== id),
        'Entry removed.'
      )
    },

    forget: async () => {
      try {
        await deleteLedger()
      } finally {
        set({
          status: 'empty',
          tables: null,
          importedAt: null,
          sourceName: null,
          localIds: [],
          notice: 'This phone no longer holds your ledger.',
          error: null,
          newerSchema: false
        })
      }
    },

    exportJson: () => {
      const current = get()
      if (!current.tables) return null
      const backup: PocketBackup = {
        format: 'cash-flow-routing-backup',
        version: current.version,
        exportedAt: new Date().toISOString(),
        tables: current.tables
      }
      return backupToJson(backup)
    },

    dismissNotice: () => set({ notice: null }),
    dismissError: () => set({ error: null })
  }
})

/** Built once per tables object, so switching tabs does not re-derive money. */
let cached: { tables: ImportTables; today: string; snapshot: Snapshot } | null = null

export function snapshotFor(tables: ImportTables): Snapshot {
  const today = todayISO()
  if (cached && cached.tables === tables && cached.today === today) return cached.snapshot
  const snapshot = buildSnapshot(tables, today)
  cached = { tables, today, snapshot }
  return snapshot
}

/** A hook that hands every screen the same derived snapshot. */
export function useSnapshot(): Snapshot | null {
  const tables = usePocket((state) => state.tables)
  return tables ? snapshotFor(tables) : null
}

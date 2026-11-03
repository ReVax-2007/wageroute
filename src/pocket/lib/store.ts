import { create } from 'zustand'
import type { ImportTables } from '@shared/importRepair'
import { RepositoryError } from '@shared/errors'
import type { Snapshot } from '@shared/types'
import { todayISO, isISODate } from '@shared/dates'
import { describeMerge, mergeTables } from '@shared/tableMerge'
import {
  BackupFileError,
  KNOWN_BACKUP_VERSION,
  backupToJson,
  parseBackup,
  type PocketBackup
} from './backup'
import { deleteLedger, readLedger, writeLedger, type StoredLedger } from './idb'
import { buildSnapshot } from './snapshot'
import { deleteEntries, insertedEntryIds, type Written } from './write'

type Status = 'loading' | 'empty' | 'ready'

interface PocketState {
  status: Status
  tables: ImportTables | null
  version: number
  importedAt: string | null
  /** The desktop's export date, which is how old the copy on the phone is. */
  exportedAt: string | null
  sourceName: string | null
  /** The live ledger entries this phone created; every other row came from a file. */
  localIds: string[]
  notice: string | null
  error: string | null
  /** Reasons the last merge could not take a row exactly as the file sent it. */
  warnings: string[]
  /** True when the imported file came from a newer desktop schema. */
  newerSchema: boolean
  load: () => Promise<void>
  importFile: (text: string, name: string) => Promise<void>
  /**
   * Runs one writer over the phone's copy and stores the result. A refusal from
   * the shared rules throws before anything is touched, so a form can show the
   * desktop's own reason without the ledger half-changing.
   */
  edit: (mutate: (tables: ImportTables) => ImportTables, notice?: string | null) => Promise<void>
  /** Runs a writer that posts rows, so every row it created is marked as this phone's. */
  add: (mutate: (tables: ImportTables) => Written, notice: string) => Promise<string>
  deleteEntry: (id: string) => Promise<void>
  forget: () => Promise<void>
  exportJson: () => string | null
  dismissNotice: () => void
  dismissError: () => void
}

function summarise(message: string): string {
  return message.endsWith('.') ? message : `${message}.`
}

function isLiveRow(row: Record<string, unknown>): boolean {
  const deleted = row.deleted_at
  return deleted === undefined || deleted === null || deleted === ''
}

function liveIdsOf(tables: ImportTables): Set<string> {
  const ids = new Set<string>()
  for (const row of tables.transactions) {
    if (isLiveRow(row) && typeof row.id === 'string') ids.add(row.id)
  }
  return ids
}

/**
 * The phone's own entries after one write. A form that posts a transfer leaves
 * two rows and a rounded-up purchase leaves three, so the list is read from the
 * rows that appeared rather than from the single id the writer hands back —
 * half a pair left off this list is pruned by the next import as foreign.
 */
function keepLocal(before: ImportTables, after: ImportTables, current: string[]): string[] {
  return [...new Set([...current, ...insertedEntryIds(before, after)])]
}

function storageMessage(error: unknown, prefix = 'Saved on this screen only'): string {
  return error instanceof Error
    ? summarise(`${prefix}: ${error.message}`)
    : `${prefix}: phone storage refused the write.`
}

async function persist(state: PocketState): Promise<void> {
  // Nothing to store is a programming error, not a quiet success: a commit
  // that showed "saved" over an empty record would lie about the ledger.
  if (!state.tables || !state.importedAt) {
    throw new Error('This phone has no ledger to store')
  }
  const ledger: StoredLedger = {
    tables: state.tables,
    version: state.version,
    importedAt: state.importedAt,
    exportedAt: state.exportedAt ?? undefined,
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
    set({ tables, localIds, notice: null, error: null })
    try {
      await persist(get())
      // Only claim it was saved once storage has actually accepted it.
      if (notice) set({ notice })
    } catch (error) {
      set({ error: storageMessage(error) })
    }
  }

  return {
    status: 'loading',
    tables: null,
    version: KNOWN_BACKUP_VERSION,
    importedAt: null,
    exportedAt: null,
    sourceName: null,
    localIds: [],
    notice: null,
    error: null,
    warnings: [],
    newerSchema: false,

    load: async () => {
      try {
        const stored = await readLedger()
        if (!stored) {
          set({ status: 'empty', error: null })
          return
        }
        set({
          status: 'ready',
          tables: stored.tables,
          version: stored.version,
          importedAt: stored.importedAt,
          // Records written before this field existed used the export date as
          // the import date; keep showing that rather than "Unknown".
          exportedAt: stored.exportedAt ?? stored.importedAt,
          sourceName: stored.sourceName,
          localIds: stored.localIds ?? [],
          newerSchema: stored.version > KNOWN_BACKUP_VERSION,
          error: null
        })
      } catch (error) {
        // Storage refused to open, which is not the same as having no ledger.
        // The welcome screen shows this reason instead of a silent empty app.
        set({
          status: 'empty',
          error: storageMessage(error, "This phone's storage could not be opened")
        })
      }
    },

    importFile: async (text, name) => {
      let backup: PocketBackup
      try {
        backup = parseBackup(text)
      } catch (error) {
        if (error instanceof BackupFileError) {
          set({ error: summarise(error.message) })
          return
        }
        throw error
      }
      const importedAt = new Date().toISOString()
      const exportedAt =
        isISODate(backup.exportedAt.slice(0, 10)) ? backup.exportedAt : importedAt
      const current = get()
      if (!current.tables) {
        set({
          status: 'ready',
          tables: backup.tables,
          version: backup.version,
          importedAt,
          exportedAt,
          sourceName: name,
          localIds: [],
          warnings: [],
          newerSchema: backup.version > KNOWN_BACKUP_VERSION,
          error: null,
          notice: null
        })
        try {
          await persist(get())
          set({ notice: 'Your ledger is on this phone now. It stays here.' })
        } catch (error) {
          // The file opened and its numbers are on screen, but it will not
          // survive a reload. Say that rather than claiming it was stored.
          set({
            error: storageMessage(error, 'Opened, but this phone could not store it')
          })
        }
        return
      }

      // A second file is merged, not swapped in: edits made here and edits made
      // on the computer both survive, with the newer version of a row winning.
      // Replacing the copy would silently undo everything typed on this phone
      // since the last import. The file's own export time caps its stamps, so
      // this device and the computer judge the same row the same way.
      const merged = mergeTables(current.tables, backup.tables, importedAt, backup.exportedAt)
      const version = Math.max(current.version, backup.version)
      const live = liveIdsOf(merged.tables)
      const summary = describeMerge(merged.counts)
      set({
        status: 'ready',
        tables: merged.tables,
        version,
        importedAt,
        exportedAt,
        sourceName: name,
        localIds: current.localIds.filter((id) => live.has(id)),
        warnings: merged.warnings,
        newerSchema: version > KNOWN_BACKUP_VERSION,
        error: null,
        notice: null
      })
      try {
        await persist(get())
        const notes = merged.warnings.length
        set({
          notice: summarise(
            notes === 0
              ? `Merged: ${summary}`
              : `Merged: ${summary} · ${notes} ${notes === 1 ? 'note' : 'notes'} on Data`
          )
        })
      } catch (error) {
        set({ error: storageMessage(error, 'Merged on screen, but this phone could not store it') })
      }
    },

    edit: async (mutate, notice = null) => {
      const current = get()
      if (!current.tables) throw new RepositoryError('STATE', 'Import a backup first')
      // Validation happens before anything is set, so a refusal leaves the
      // on-screen ledger exactly as it was.
      const tables = mutate(current.tables)
      await commit(tables, keepLocal(current.tables, tables, current.localIds), notice)
    },

    add: async (mutate, notice) => {
      const current = get()
      if (!current.tables) throw new RepositoryError('STATE', 'Import a backup first')
      // The writer validates before it returns anything, so a refusal leaves the
      // on-screen ledger exactly as it was.
      const written = mutate(current.tables)
      await commit(
        written.tables,
        keepLocal(current.tables, written.tables, current.localIds),
        notice
      )
      return written.id
    },

    deleteEntry: async (id) => {
      const current = get()
      if (!current.tables) return
      // The ledger hides the other side of a transfer and the sweep a purchase
      // rounded up, so removing one row has to retire its partners too. A
      // half-pair left behind would read as money that moved on its own.
      const { tables, removed } = deleteEntries(current.tables, [id])
      if (removed.length === 0) return
      const remaining = liveIdsOf(tables)
      await commit(
        tables,
        current.localIds.filter((entryId) => remaining.has(entryId)),
        removed.length === 1 ? 'Entry removed.' : `${removed.length} entries removed.`
      )
    },

    forget: async () => {
      let failure: string | null = null
      try {
        await deleteLedger()
      } catch (error) {
        failure = storageMessage(
          error,
          'The screen is clear, but phone storage would not erase the copy'
        )
      }
      set({
        status: 'empty',
        tables: null,
        importedAt: null,
        exportedAt: null,
        sourceName: null,
        localIds: [],
        notice: failure ? null : 'This phone no longer holds your ledger.',
        error: failure,
        warnings: [],
        newerSchema: false
      })
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

import { create } from 'zustand'
import type { ImportTables } from '@shared/importRepair'
import { RepositoryError } from '@shared/errors'
import { passphraseProblem } from '@shared/encryption'
import type { Snapshot } from '@shared/types'
import { todayISO, isISODate } from '@shared/dates'
import {
  EnvelopeError,
  envelopeFileName,
  envelopeToJson,
  parseEnvelope,
  textIsEnvelope
} from '@shared/envelope'
import { describeMerge, mergeTables } from '@shared/tableMerge'
import {
  BackupFileError,
  KNOWN_BACKUP_VERSION,
  backupToJson,
  parseBackup,
  type PocketBackup
} from './backup'
import { openEnvelopeFileText, sealEnvelope } from './envelope'
import {
  deleteLedger,
  readLedger,
  writeLedger,
  type StoredLedger
} from './idb'
import { buildSnapshot } from './snapshot'
import { deleteEntries, insertedEntryIds, reconcileAllBillClaims, type Written } from './write'
import {
  VaultError,
  changeVaultPassphrase as resealUnderNewPassphrase,
  createVault,
  lockVault,
  openRecord,
  sealRecord,
  unlockVault,
  type VaultMarker
} from './vault'

/**
 * `locked` is the copy on this phone that exists but cannot be read: the ledger is
 * under the vault's cipher, and only the rows on screen would say what it holds.
 * A screen that showed a spinner here would be pretending the data is on its way
 * without the one thing that makes it arrive.
 */
type Status = 'loading' | 'empty' | 'ready' | 'locked'

/** Whether another try at the passphrase can help, alongside the sentence to show. */
export interface VaultProblem {
  message: string
  /** False when the vault itself is damaged, so the answer is a restore rather than a retype. */
  retry: boolean
}

/** A file that said it was sealed, kept until a passphrase turns it into rows. */
export interface PendingSeal {
  text: string
  name: string
  /** From the header, in the clear: the phone can say when the file was written without opening it. */
  exportedAt: string
}

/** The text of an export and the name it belongs under, decided together so the two cannot disagree. */
export interface PocketExport {
  text: string
  fileName: string
}

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
  /** A file held shut by its passphrase, waiting for one to be typed. */
  pendingSeal: PendingSeal | null
  /**
   * This phone's vault, in the clear: the parameters a reader needs before it can
   * attempt to open the copy. Null means the copy on this phone is plain.
   */
  vault: VaultMarker | null
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
  /**
   * Opens the file `importFile` held shut. Null means the rows are on screen;
   * anything else is what to say under the passphrase box, with the file still
   * waiting — a wrong phrase is the usual reason, and the person typing has to
   * be able to try again in the same place.
   */
  unlockSeal: (passphrase: string) => Promise<SealFailure | null>
  cancelSeal: () => void
  /**
   * Seals this phone's copy from now on. The phrase is checked against the shared
   * rule before any crypto runs and the copy is written once, from the ledger
   * already on screen; nothing is kept and nothing is re-stated on a failure.
   */
  enableVault: (passphrase: string, confirm: string) => Promise<VaultProblem | null>
  /** The other half: read with the key, write the copy plain, forget the key. */
  disableVault: (passphrase: string) => Promise<VaultProblem | null>
  /** A new salt, a new key and one re-seal. The old phrase is proved first. */
  changeVaultPassphrase: (
    current: string,
    next: string,
    confirm: string
  ) => Promise<VaultProblem | null>
  /** Typed at the gate over a locked copy. Null means the ledger is on screen. */
  unlockVaultWith: (passphrase: string) => Promise<VaultProblem | null>
  /** Closes the key without touching the copy, so the phone can be handed over mid-session. */
  lockNow: () => void
  /** The phone's own copy, as plain JSON or sealed under a phrase the desktop can read. */
  exportJson: (passphrase: string | null) => Promise<PocketExport | null>
  dismissNotice: () => void
  dismissError: () => void
}

function summarise(message: string): string {
  return message.endsWith('.') ? message : `${message}.`
}

/** Whether another try at the passphrase can help, alongside the sentence to show. */
export interface SealFailure {
  message: string
  /** False when the file itself is wrong, so the answer is a different file. */
  retry: boolean
}

/**
 * Why a sealed file stayed shut, in the sentence the cause deserves: a phrase
 * that did not open it is worth typing again, a file that is not an envelope
 * is not, and the phone cannot tell which from the ciphertext alone.
 */
function sealMessage(error: unknown): SealFailure {
  if (error instanceof EnvelopeError) {
    return { message: summarise(error.message), retry: error.failure === 'passphrase' }
  }
  return { message: 'This file could not be read as a WageRoute export.', retry: false }
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

/**
 * Why a vault refused, in the sentence the cause deserves. A phrase that did not
 * open this phone's copy is worth typing again; a marker that does not parse is
 * not, and the difference is the line between "try once more" and "restore from a
 * backup" — the two things a person standing at a locked screen can still do.
 */
function vaultProblem(error: unknown): VaultProblem {
  if (error instanceof VaultError) {
    return { message: summarise(error.message), retry: error.failure !== 'shape' }
  }
  return storageProblem(error)
}

/** The catch that is not about the vault at all: storage said no, in Node's words. */
function storageProblem(error: unknown): VaultProblem {
  return {
    message: storageMessage(error, 'This phone could not store the sealed copy'),
    retry: false
  }
}

const NO_VAULT: VaultProblem = {
  message: 'This phone’s copy is not sealed, so there is nothing to unlock.',
  retry: false
}

/**
 * The desktop's own passphrase rule, with the object named, plus the confirmation
 * a phrase with no reset needs: this is the one secret whose loss means the ledger
 * on this phone is gone, and typing it twice is the only check available before it
 * is the thing standing between the data and anyone holding the handset.
 */
function phraseRule(passphrase: string, confirm: string): string | null {
  return (
    passphraseProblem(passphrase, 'this phone’s copy of your ledger') ??
    (passphrase === confirm ? null : 'Both boxes must hold the same passphrase.')
  )
}

/** The ledger exactly as this phone holds it, before any cipher gets near it. */
function ledgerOf(state: PocketState): StoredLedger {
  // Nothing to store is a programming error, not a quiet success: a commit
  // that showed "saved" over an empty record would lie about the ledger.
  if (!state.tables || !state.importedAt) {
    throw new Error('This phone has no ledger to store')
  }
  return {
    tables: state.tables,
    version: state.version,
    importedAt: state.importedAt,
    exportedAt: state.exportedAt ?? undefined,
    sourceName: state.sourceName ?? '',
    localIds: state.localIds
  }
}

/**
 * Write this phone's copy, sealing it first only when a vault is open.
 *
 * One function owns both branches because the branch is the whole difference
 * between an encrypted phone and a plain one, and a caller that picked for itself
 * is where a plaintext ledger would end up beside a sealed one.
 */
async function persist(state: PocketState): Promise<void> {
  const ledger = ledgerOf(state)
  if (!state.vault) {
    await writeLedger(ledger)
    return
  }
  await writeLedger(await sealRecord(state.vault, ledger))
}

/** The fields a readable copy fills in, so `load` and a fresh unlock cannot disagree. */
function stateOfLedger(ledger: StoredLedger): Partial<PocketState> {
  return {
    status: 'ready',
    tables: ledger.tables,
    version: ledger.version,
    importedAt: ledger.importedAt,
    // Records written before this field existed used the export date as the
    // import date; keep showing that rather than "Unknown".
    exportedAt: ledger.exportedAt ?? ledger.importedAt,
    sourceName: ledger.sourceName,
    localIds: ledger.localIds ?? [],
    newerSchema: ledger.version > KNOWN_BACKUP_VERSION,
    notice: null,
    error: null
  }
}

/** A copy this phone cannot read: the marker stays, every row it guards goes. */
function stateOfLocked(marker: VaultMarker | null): Partial<PocketState> {
  return {
    status: 'locked',
    vault: marker,
    tables: null,
    importedAt: null,
    exportedAt: null,
    sourceName: null,
    localIds: [],
    warnings: [],
    newerSchema: false,
    notice: null,
    error: null,
    pendingSeal: null
  }
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
      // The vault closed underneath this write — another tab turned it off, or
      // locked it. The rows stay on screen: dropping them here would throw away
      // the only copy of what was just typed, and the gate re-seals them the
      // moment the passphrase comes back.
      if (error instanceof VaultError && error.failure === 'closed') {
        set({ status: 'locked' })
        return
      }
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
    pendingSeal: null,
    vault: null,

    load: async () => {
      try {
        const stored = await readLedger()
        if (!stored) {
          set({ status: 'empty', error: null })
          return
        }
        if ('vault' in stored) {
          // The marker is in the clear, so the phone can ask for the right thing
          // before it can read any of its own data.
          set(stateOfLocked(stored.vault))
          return
        }
        set(stateOfLedger(stored))
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
      if (textIsEnvelope(text)) {
        // The header is in the clear, so the phone can tell a sealed file from a
        // broken one before it asks for anything. Nothing is counted yet: the
        // rows are under the cipher, and this file waits for a passphrase.
        try {
          set({
            pendingSeal: { text, name, exportedAt: parseEnvelope(text).exportedAt },
            error: null
          })
        } catch (error) {
          set({ pendingSeal: null, error: sealMessage(error).message })
        }
        return
      }
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
      // A file's claims arrive with the states the desktop derived, but the
      // payments that settled them are the file's own news. Replaying them here
      // is what the computer does at the end of every import — see ADR 0028.
      if (!current.tables) {
        const tables = reconcileAllBillClaims(backup.tables)
        set({
          status: 'ready',
          tables,
          version: backup.version,
          importedAt,
          exportedAt,
          sourceName: name,
          localIds: [],
          warnings: [],
          newerSchema: backup.version > KNOWN_BACKUP_VERSION,
          error: null,
          notice: null,
          pendingSeal: null
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
      const tables = reconcileAllBillClaims(merged.tables)
      const version = Math.max(current.version, backup.version)
      const live = liveIdsOf(tables)
      const summary = describeMerge(merged.counts)
      set({
        status: 'ready',
        tables,
        version,
        importedAt,
        exportedAt,
        sourceName: name,
        localIds: current.localIds.filter((id) => live.has(id)),
        warnings: merged.warnings,
        newerSchema: version > KNOWN_BACKUP_VERSION,
        error: null,
        notice: null,
        pendingSeal: null
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
      // The key goes with the record it opens, even when the record refused to go:
      // leaving a session open over storage this app has given up on would let a
      // later write seal something nobody is looking at.
      lockVault()
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
        newerSchema: false,
        pendingSeal: null,
        vault: null
      })
    },

    unlockSeal: async (passphrase) => {
      const pending = get().pendingSeal
      if (!pending) return null
      try {
        const opened = await openEnvelopeFileText(pending.text, passphrase)
        // Cleared before the import runs, so a file that turns out to be
        // unreadable leaves the phone back at the picker rather than stuck
        // asking for a phrase that can no longer help.
        set({ pendingSeal: null })
        await get().importFile(opened, pending.name)
        return null
      } catch (error) {
        // The file stays held: a wrong phrase is the common reason, and the
        // person who typed it has to be able to try it again.
        return sealMessage(error)
      }
    },

    cancelSeal: () => set({ pendingSeal: null }),

    enableVault: async (passphrase, confirm) => {
      const current = get()
      if (current.vault) {
        return { message: 'This phone’s copy is already sealed.', retry: false }
      }
      const problem = phraseRule(passphrase, confirm)
      if (problem) return { message: problem, retry: true }
      if (!current.tables || !current.importedAt) {
        return { message: 'There is no ledger on this phone to seal yet.', retry: false }
      }
      try {
        const marker = await createVault(passphrase)
        await unlockVault(marker, passphrase)
        // The sealed copy is written before the store says a vault is on. A
        // storage refusal then leaves the phone exactly as it was — plain, working,
        // and honest about it — instead of a screen claiming protection the disk
        // does not hold.
        await writeLedger(await sealRecord(marker, ledgerOf(current)))
        set({ vault: marker })
        set({
          notice: 'This phone’s copy is sealed. Close and reopen the app to see what that means.'
        })
        return null
      } catch (error) {
        // Whatever failed, the key this attempt made is not kept.
        lockVault()
        return vaultProblem(error)
      }
    },

    disableVault: async (passphrase) => {
      const marker = get().vault
      if (!marker) return NO_VAULT
      try {
        await unlockVault(marker, passphrase)
        const stored = await readLedger()
        if (!stored || !('vault' in stored)) {
          throw new VaultError(
            'shape',
            'This phone’s sealed copy is not where the screen says it is.'
          )
        }
        const ledger = await openRecord(stored)
        // Read first, then write plain, then let the key go. In no other order can
        // a failure leave the phone holding a copy nothing can open.
        await writeLedger(ledger)
        lockVault()
        set({ vault: null })
        set({
          notice: 'This phone’s copy is no longer sealed. Nothing here needs a passphrase now.'
        })
        return null
      } catch (error) {
        // No key is dropped here: a wrong phrase in this box asked for a vault that
        // was already open, and closing the phone over a typo would be a worse
        // outcome than the refusal the screen is showing.
        return vaultProblem(error)
      }
    },

    changeVaultPassphrase: async (current, next, confirm) => {
      const marker = get().vault
      if (!marker) return NO_VAULT
      const problem = phraseRule(next, confirm)
      if (problem) return { message: problem, retry: true }
      try {
        const created = await resealUnderNewPassphrase(marker, current, next)
        await writeLedger(await sealRecord(created, ledgerOf(get())))
        set({ vault: created })
        set({
          notice: 'This phone’s copy is sealed under the new passphrase. The old one no longer opens it.'
        })
        return null
      } catch (error) {
        // The same reason as above: the phrase that was proved here is the one this
        // phone has been using, and a refusal in the new-phrase box does not change
        // what the copy is sealed under.
        return vaultProblem(error)
      }
    },

    unlockVaultWith: async (passphrase) => {
      const marker = get().vault
      if (!marker) return NO_VAULT
      try {
        await unlockVault(marker, passphrase)
      } catch (error) {
        return vaultProblem(error)
      }
      // A write that found the vault closed kept its rows on screen rather than
      // dropping them. Those are worth more than the older copy on disk, so they go
      // back up before anything is read.
      if (get().tables) {
        try {
          await persist(get())
          set({ status: 'ready', notice: 'This phone’s copy is open again.' })
          return null
        } catch (error) {
          lockVault()
          set(stateOfLocked(marker))
          return vaultProblem(error)
        }
      }
      try {
        const stored = await readLedger()
        if (!stored) {
          // Another tab forgot this phone's copy while the gate was up.
          lockVault()
          set({ status: 'empty', vault: null })
          return null
        }
        if (!('vault' in stored)) {
          // The copy came back plain while this screen was asking, so this page has
          // to stop sealing with a key no record uses.
          lockVault()
          set({ ...stateOfLedger(stored), vault: null })
          return null
        }
        set(stateOfLedger(await openRecord(stored)))
        return null
      } catch (error) {
        lockVault()
        set(stateOfLocked(marker))
        return vaultProblem(error)
      }
    },

    lockNow: () => {
      lockVault()
      set(stateOfLocked(get().vault))
    },

    exportJson: async (passphrase) => {
      const current = get()
      if (!current.tables) return null
      const exportedAt = new Date().toISOString()
      const backup: PocketBackup = {
        format: 'cash-flow-routing-backup',
        version: current.version,
        exportedAt,
        tables: current.tables
      }
      const json = backupToJson(backup)
      if (passphrase === null) {
        return { text: json, fileName: `wageroute-pocket-${todayISO()}.json` }
      }
      // The name and the header both come from this export's own moment, so a
      // desktop reader never sees a file that claims two different times.
      const sealed = await sealEnvelope(json, passphrase, { exportedAt })
      return {
        text: envelopeToJson(sealed),
        fileName: envelopeFileName('wageroute-pocket', exportedAt)
      }
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

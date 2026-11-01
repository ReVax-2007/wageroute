import { useEffect, useState } from 'react'
import {
  ClipboardCheck,
  Coffee,
  Copy,
  Download,
  ExternalLink,
  FileSpreadsheet,
  HardDrive,
  Info,
  Moon,
  RefreshCw,
  ScrollText,
  Sun,
  Trash2,
  Upload
} from 'lucide-react'
import type { AppDiagnostics, LegalTexts } from '@shared/api'
import { PAY_CADENCE_LABEL } from '@shared/cadence'
import { isISODate } from '@shared/dates'
import { currencySymbol, formatMoney } from '@shared/money'
import type { PayCadence, RoundUpIncrementCents, ThemePreference } from '@shared/types'
import { roundUpRemainderCents } from '@shared/transfers'
import { Button, Card, Field, Modal, Segmented, Switch } from '../components/ui'
import { useFinanceStore } from '../store/useFinanceStore'

const INCREMENTS: { value: string; cents: RoundUpIncrementCents }[] = [
  { value: '100', cents: 100 },
  { value: '200', cents: 200 },
  { value: '500', cents: 500 }
]

// A short list of the currencies a personal ledger is most often kept in. A
// hand-edited backup may still carry another valid code, so the select adds it
// rather than silently showing the first option.
const CURRENCIES: { code: string; label: string }[] = [
  { code: 'USD', label: 'US dollar' },
  { code: 'CAD', label: 'Canadian dollar' },
  { code: 'EUR', label: 'Euro' },
  { code: 'GBP', label: 'British pound' },
  { code: 'AUD', label: 'Australian dollar' },
  { code: 'NZD', label: 'New Zealand dollar' },
  { code: 'CHF', label: 'Swiss franc' },
  { code: 'JPY', label: 'Japanese yen' },
  { code: 'SEK', label: 'Swedish krona' },
  { code: 'NOK', label: 'Norwegian krone' },
  { code: 'DKK', label: 'Danish krone' },
  { code: 'INR', label: 'Indian rupee' },
  { code: 'SGD', label: 'Singapore dollar' },
  { code: 'ZAR', label: 'South African rand' },
  { code: 'BRL', label: 'Brazilian real' },
  { code: 'MXN', label: 'Mexican peso' }
]

const CADENCES = Object.keys(PAY_CADENCE_LABEL) as PayCadence[]

/** The text behind Copy diagnostics: no balances, no names, just the shape. */
function describeDiagnostics(info: AppDiagnostics): string {
  const counts = Object.entries(info.counts)
    .map(([table, rows]) => `  ${table}: ${rows}`)
    .join('\n')
  return [
    `WageRoute ${info.version}`,
    `Generated: ${info.generatedAt}`,
    `Schema: v${info.schemaVersion}`,
    `Electron ${info.electron} · Chrome ${info.chrome} · Node ${info.node}`,
    `Platform: ${info.platform} ${info.arch} (${info.packaged ? 'packaged' : 'development'})`,
    `Database: ${info.databasePath} (${(info.databaseBytes / 1024).toFixed(1)} kB)`,
    `Backups: ${info.backupsPath}`,
    `Log: ${info.logPath}`,
    info.logTail ? `Last log lines:\n${info.logTail}` : 'Log: no entries',
    'Row counts:',
    counts
  ].join('\n')
}

export function Settings() {
  const settings = useFinanceStore((state) => state.settings)
  const snapshot = useFinanceStore((state) => state.snapshot)
  const busy = useFinanceStore((state) => state.busy)
  const saveSettings = useFinanceStore((state) => state.saveSettings)
  const exportBackup = useFinanceStore((state) => state.exportBackup)
  const exportCsv = useFinanceStore((state) => state.exportCsv)
  const openImport = useFinanceStore((state) => state.openImport)
  const resetData = useFinanceStore((state) => state.resetData)
  const go = useFinanceStore((state) => state.go)
  const dbPath = useFinanceStore((state) => state.dbPath)
  const appInfo = useFinanceStore((state) => state.appInfo)
  const [eraseStep, setEraseStep] = useState<0 | 1 | 2>(0)
  const [paydayDraft, setPaydayDraft] = useState(settings.paydayLabel)
  const [anchorDraft, setAnchorDraft] = useState(settings.payAnchorDate ?? '')
  const [diagnostics, setDiagnostics] = useState<AppDiagnostics | null>(null)
  const [diagnosticsError, setDiagnosticsError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [legal, setLegal] = useState<{ title: string; body: string } | null>(null)

  useEffect(() => {
    setPaydayDraft(settings.paydayLabel)
  }, [settings.paydayLabel])

  useEffect(() => {
    setAnchorDraft(settings.payAnchorDate ?? '')
  }, [settings.payAnchorDate])

  if (!snapshot) return null

  const currency = settings.currency
  const savingsAccounts = snapshot.accounts.filter(
    (account) => account.kind === 'savings' && !account.isArchived
  )
  // A paycheck cannot land on a credit card or a brokerage account, so the
  // default-deposit list only offers accounts money can actually be paid into.
  const depositAccounts = snapshot.accounts.filter(
    (account) =>
      !account.isArchived && (account.kind === 'checking' || account.kind === 'savings')
  )
  // The visible destination and the one the sweep will use are the same resolved
  // account: a stored id that no longer exists must not silently become another.
  const roundUpAccount =
    savingsAccounts.find((account) => account.id === settings.roundUpAccountId) ?? null
  const roundUpActive = settings.roundUpEnabled && roundUpAccount !== null
  const sampleSweepCents = roundUpRemainderCents(1240, settings.roundUpToCents)

  const commitPaydayLabel = () => {
    const next = paydayDraft.trim()
    if (next !== settings.paydayLabel) update({ paydayLabel: next })
  }

  const update = (patch: Partial<typeof settings>) => {
    void saveSettings({ ...settings, ...patch })
  }

  const loadDiagnostics = async (): Promise<AppDiagnostics | null> => {
    try {
      const data = await window.api.getDiagnostics()
      setDiagnostics(data)
      setDiagnosticsError(null)
      return data
    } catch (error) {
      setDiagnosticsError(error instanceof Error ? error.message : String(error))
      return null
    }
  }

  const copyDiagnostics = async () => {
    const data = diagnostics ?? (await loadDiagnostics())
    if (!data) return
    try {
      await navigator.clipboard.writeText(describeDiagnostics(data))
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      setDiagnosticsError('The clipboard refused the copy. The details below stay selectable.')
      await loadDiagnostics()
    }
  }

  const openLegal = async (which: 'license' | 'notices') => {
    const title = which === 'license' ? 'Licence' : 'Third-party notices'
    try {
      const texts: LegalTexts = await window.api.getLegalTexts()
      setLegal({ title, body: which === 'license' ? texts.license : texts.notices })
    } catch (error) {
      setLegal({ title, body: error instanceof Error ? error.message : String(error) })
    }
  }

  return (
    <>
      <header className="page-head">
        <div>
          <p className="eyebrow">Settings</p>
          <h1 className="page-title" tabIndex={-1}>Make it feel like yours</h1>
          <p className="page-sub">
            Appearance, round-up and data portability. Everything is stored on this machine.
          </p>
        </div>
      </header>

      <div className="settings-grid">
        <Card
          title="Appearance"
          subtitle="The ledger reads the same numbers either way"
          actions={
            settings.theme === 'dark' ? (
              <Moon size={16} className="stat-icon" />
            ) : settings.theme === 'light' ? (
              <Sun size={16} className="stat-icon" />
            ) : (
              <RefreshCw size={16} className="stat-icon" />
            )
          }
        >
          <Segmented<ThemePreference>
            label="Theme"
            value={settings.theme}
            onChange={(theme) => update({ theme })}
            options={[
              { value: 'dark', label: 'Dark' },
              { value: 'light', label: 'Light' },
              { value: 'system', label: 'System' }
            ]}
          />
          <p className="field-hint">
            System follows your macOS or Windows appearance setting and switches live.
          </p>
        </Card>

        <Card title="Money" subtitle="The symbol shown beside every amount">
          <Field
            label="Currency"
            hint="Changes the symbol and grouping only. Amounts already in the ledger are not converted."
          >
            <select
              className="select"
              value={settings.currency}
              onChange={(event) => update({ currency: event.target.value })}
            >
              {!CURRENCIES.some((item) => item.code === settings.currency) && (
                <option value={settings.currency}>{settings.currency}</option>
              )}
              {CURRENCIES.map((item) => (
                <option key={item.code} value={item.code}>
                  {item.code} — {item.label}
                </option>
              ))}
            </select>
          </Field>
        </Card>

        <Card
          title="Paycheck"
          subtitle="How often you are paid, what to call paydays and where the money lands"
        >
          <div className="form-grid compact">
            <Field label="Pay cadence" hint="Sets the Priority Wall's per-check figures">
              <select
                className="select"
                value={settings.payCadence}
                onChange={(event) =>
                  update({ payCadence: event.target.value as PayCadence })
                }
              >
                {CADENCES.map((option) => (
                  <option key={option} value={option}>
                    {PAY_CADENCE_LABEL[option]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Payday label" hint="Free text, shown on the wall">
              <input
                className="input"
                value={paydayDraft}
                placeholder="15th and last day"
                onChange={(event) => setPaydayDraft(event.target.value)}
                onBlur={commitPaydayLabel}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    commitPaydayLabel()
                  }
                }}
              />
            </Field>
            <Field
              label="Pay schedule anchor"
              hint="Any one real payday. Keeps the wall's next-check date on the right weekday. Leave blank to spread evenly."
            >
              <input
                className="input"
                type="date"
                value={anchorDraft}
                onChange={(event) => {
                  const next = event.target.value
                  setAnchorDraft(next)
                  if (next === '') {
                    if (settings.payAnchorDate !== null) update({ payAnchorDate: null })
                    return
                  }
                  if (isISODate(next) && next !== settings.payAnchorDate) {
                    update({ payAnchorDate: next })
                  }
                }}
              />
            </Field>
            <Field
              label="Default paycheck account"
              hint="The allocator preselects this when a paycheck arrives. Applies to new paychecks; past commits are unchanged."
              wide
            >
              <select
                className="select"
                value={settings.defaultDepositAccountId ?? ''}
                onChange={(event) =>
                  update({ defaultDepositAccountId: event.target.value || null })
                }
              >
                <option value="">First checking account</option>
                {depositAccounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.name}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        </Card>

        <Card
          title="Round-up"
          subtitle="Spare change moved to savings the moment you log an expense"
        >
          <div className="setting-row">
            <div>
              <strong>Round up debit spending</strong>
              <p className="field-hint">
                Every purchase — a negative expense on a checking or cash account — sweeps the
                difference to your savings.
              </p>
            </div>
            <Switch
              label="Round up expenses"
              checked={roundUpActive}
              disabled={savingsAccounts.length === 0}
              onChange={(roundUpEnabled) =>
                update({
                  roundUpEnabled,
                  roundUpAccountId: roundUpAccount?.id ?? savingsAccounts[0]?.id ?? null
                })
              }
            />
          </div>

          {savingsAccounts.length === 0 ? (
            <div className="setting-empty">
              <p className="field-hint">Add a savings account before turning round-up on.</p>
              <Button size="sm" onClick={() => go('accounts')}>
                Go to accounts
              </Button>
            </div>
          ) : (
            <>
              <div className="setting-row">
                <Field
                  label="Sweep into"
                  hint={
                    roundUpAccount
                      ? 'Where the spare change lands'
                      : settings.roundUpAccountId
                        ? 'The saved destination no longer exists — choose a savings account.'
                        : 'Choose the savings account the spare change should land in.'
                  }
                >
                  <select
                    className="select"
                    value={roundUpAccount?.id ?? ''}
                    onChange={(event) => update({ roundUpAccountId: event.target.value })}
                  >
                    {!roundUpAccount && (
                      <option value="" disabled>
                        Choose a savings account…
                      </option>
                    )}
                    {savingsAccounts.map((account) => (
                      <option key={account.id} value={account.id}>
                        {account.name}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>

              <div className="setting-row">
                <div>
                  <strong>Round to</strong>
                  <p className="field-hint">
                    A {formatMoney(1240, currency)} coffee sweeps{' '}
                    {formatMoney(sampleSweepCents, currency)}.
                  </p>
                </div>
                <Segmented<string>
                  label="Round up to"
                  value={String(settings.roundUpToCents)}
                  onChange={(value) => update({ roundUpToCents: Number(value) as RoundUpIncrementCents })}
                  options={INCREMENTS.map((item) => ({
                    value: item.value,
                    label: `${currencySymbol(currency)}${item.cents / 100}`
                  }))}
                />
              </div>
            </>
          )}
        </Card>

        <Card
          title="Data"
          subtitle="Your file, your data — no cloud account involved"
          actions={<HardDrive size={16} className="stat-icon" />}
        >
          <div className="data-actions">
            <Button
              icon={<Download size={15} />}
              onClick={() => void exportBackup()}
              disabled={busy}
            >
              Export full backup
            </Button>
            <Button
              icon={<FileSpreadsheet size={15} />}
              onClick={() => void exportCsv()}
              disabled={busy}
            >
              Export transactions CSV
            </Button>
            <Button
              icon={<Upload size={15} />}
              onClick={() => void openImport()}
              disabled={busy}
            >
              Import data
            </Button>
          </div>
          <p className="field-hint">
            A JSON backup holds accounts, bills, goals, paychecks, allocations, transactions and
            every setting — it can be a full backup or just a few tables. The transactions CSV is
            for reviewing the ledger in a spreadsheet, not a backup: it writes a transfer as two
            rows and cannot rebuild them on import, and it carries neither the currency nor the
            links between records. Use the JSON backup to move data between profiles. Importing
            only adds what this app is missing: nothing local is deleted, and settings you have
            already changed stay as they are.
          </p>
          <p className="db-path" title={dbPath}>
            {dbPath}
          </p>
        </Card>

        <Card
          title="Emergency fund"
          subtitle="Auto-calculated from your Priority Wall and recent spending"
        >
          <p className="field-hint">
            The calculator lives with your sinking funds, next to the goal it targets.
          </p>
          <Button onClick={() => go('goals')}>Open sinking funds</Button>
        </Card>

        <Card
          title="About"
          subtitle="The build you are running, and how to say thanks"
          actions={<Info size={16} className="stat-icon" />}
        >
          <div className="setting-row">
            <div>
              <strong>Version</strong>
              <p className="field-hint">Baked into this bundle, not read from the source tree.</p>
            </div>
            <span className="about-value">{appInfo?.version ?? '…'}</span>
          </div>
          <div className="setting-row">
            <div>
              <strong>Database schema</strong>
              <p className="field-hint">The last migration this build applies.</p>
            </div>
            <span className="about-value">
              {appInfo ? `v${appInfo.schemaVersion}` : '…'}
            </span>
          </div>
          <div className="setting-row">
            <div>
              <strong>Electron</strong>
              <p className="field-hint">The runtime bundled with this build.</p>
            </div>
            <span className="about-value">{appInfo?.electron ?? '…'}</span>
          </div>
          <p className="field-hint">
            WageRoute is free and runs entirely on this machine. If it saves you an afternoon, you
            can buy me a coffee — the link opens in your browser.
          </p>
          <div className="data-actions">
            <a
              className="btn btn-ghost btn-md"
              href="https://buymeacoffee.com/revax"
              target="_blank"
              rel="noreferrer"
              aria-label="Buy me a coffee — opens buymeacoffee.com in your browser"
            >
              <Coffee size={15} />
              Buy me a coffee
              <ExternalLink size={13} aria-hidden="true" />
            </a>
          </div>
          <div className="data-actions">
            <Button
              icon={<ScrollText size={15} />}
              onClick={() => void openLegal('license')}
            >
              Licence
            </Button>
            <Button
              icon={<ScrollText size={15} />}
              onClick={() => void openLegal('notices')}
            >
              Third-party notices
            </Button>
          </div>
        </Card>

        <Card
          title="Diagnostics"
          subtitle="What to send when something goes wrong"
          actions={<Info size={16} className="stat-icon" />}
        >
          <p className="field-hint">
            Version, runtime, file paths, the end of the crash log and how many rows each table
            holds. No account names, amounts or settings leave this machine unless you copy them.
          </p>
          <div className="data-actions">
            <Button icon={copied ? <ClipboardCheck size={15} /> : <Copy size={15} />} onClick={() => void copyDiagnostics()} disabled={busy}>
              {copied ? 'Copied' : 'Copy diagnostics'}
            </Button>
            <Button onClick={() => void loadDiagnostics()}>Show details</Button>
          </div>
          {diagnosticsError && (
            <p className="form-error" role="alert">
              {diagnosticsError}
            </p>
          )}
          {diagnostics && (
            <pre className="diagnostics-text" tabIndex={0}>
              {describeDiagnostics(diagnostics)}
            </pre>
          )}
        </Card>

        <Card
          title="Danger zone"
          subtitle="Erase every account, bill, goal, paycheck and entry on this device"
          actions={<Trash2 size={16} className="stat-icon" />}
        >
          <div className="data-actions">
            <Button
              variant="danger"
              icon={<Trash2 size={15} />}
              onClick={() => setEraseStep(1)}
              disabled={busy}
            >
              Erase all data…
            </Button>
          </div>
          <p className="field-hint">
            Erases every account, bill, sinking fund, paycheck, entry and setting, returning
            WageRoute to a blank first-run profile. The database file stays on disk, empty, and a
            last-resort copy is written to the app&apos;s <code>backups</code> folder first (the
            newest three are kept). Exported backups and CSV files are not touched. The live ledger
            cannot be recovered after this.
          </p>
        </Card>
      </div>

      {eraseStep === 1 && (
        <Modal
          title="Erase all data?"
          subtitle="Step 1 of 2"
          onClose={() => setEraseStep(0)}
          footer={
            <>
              <Button variant="quiet" onClick={() => setEraseStep(0)} autoFocus>
                Cancel
              </Button>
              <Button variant="ghost" onClick={() => setEraseStep(2)}>
                Continue
              </Button>
            </>
          }
        >
          <p className="field-hint">
            This deletes every account, bill, sinking fund, paycheck and ledger entry from the live
            database, and resets settings to their defaults.
          </p>
          <p className="field-hint">
            A last-resort copy of the database is written to the app&apos;s <code>backups</code>{' '}
            folder before the erase (the newest three are kept). Exported backups and CSV files on
            disk are not affected. If you will want this data back as a normal import, export a
            backup first.
          </p>
        </Modal>
      )}

      {eraseStep === 2 && (
        <Modal
          title="This cannot be undone"
          subtitle="Step 2 of 2 — final confirmation"
          onClose={() => setEraseStep(0)}
          footer={
            <>
              <Button variant="quiet" onClick={() => setEraseStep(0)} autoFocus>
                Cancel
              </Button>
              <Button
                variant="danger"
                disabled={busy}
                onClick={() => {
                  setEraseStep(0)
                  void resetData()
                }}
              >
                Erase everything
              </Button>
            </>
          }
        >
          <p className="field-hint">
            Clicking <strong>Erase everything</strong> empties the local database immediately and
            drops you back on the dashboard with a blank profile, exactly like a first launch.
          </p>
        </Modal>
      )}

      {legal && (
        <Modal
          title={legal.title}
          subtitle="Shipped with this build, not fetched from the network"
          onClose={() => setLegal(null)}
          wide
          footer={
            <Button variant="quiet" autoFocus onClick={() => setLegal(null)}>
              Close
            </Button>
          }
        >
          <pre className="diagnostics-text" tabIndex={0}>
            {legal.body}
          </pre>
        </Modal>
      )}
    </>
  )
}

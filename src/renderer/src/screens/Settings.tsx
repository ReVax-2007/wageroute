import {
  Download,
  FileSpreadsheet,
  HardDrive,
  Moon,
  RefreshCw,
  Sun,
  Upload
} from 'lucide-react'
import type { RoundUpIncrementCents, ThemePreference } from '@shared/types'
import { roundUpRemainderCents } from '@shared/transfers'
import { Button, Card, Field, Segmented, Switch } from '../components/ui'
import { useFinanceStore } from '../store/useFinanceStore'

const INCREMENTS: { value: string; label: string; cents: RoundUpIncrementCents }[] = [
  { value: '100', label: '$1', cents: 100 },
  { value: '200', label: '$2', cents: 200 },
  { value: '500', label: '$5', cents: 500 }
]

export function Settings() {
  const settings = useFinanceStore((state) => state.settings)
  const snapshot = useFinanceStore((state) => state.snapshot)
  const busy = useFinanceStore((state) => state.busy)
  const saveSettings = useFinanceStore((state) => state.saveSettings)
  const exportBackup = useFinanceStore((state) => state.exportBackup)
  const exportCsv = useFinanceStore((state) => state.exportCsv)
  const importData = useFinanceStore((state) => state.importData)
  const go = useFinanceStore((state) => state.go)
  const dbPath = useFinanceStore((state) => state.dbPath)

  if (!snapshot) return null

  const savingsAccounts = snapshot.accounts.filter(
    (account) => account.kind === 'savings' && !account.isArchived
  )
  const sampleSweepCents = roundUpRemainderCents(1240, settings.roundUpToCents)

  const update = (patch: Partial<typeof settings>) => {
    void saveSettings({ ...settings, ...patch })
  }

  return (
    <>
      <header className="page-head">
        <div>
          <p className="eyebrow">Settings</p>
          <h1 className="page-title">Make it feel like yours</h1>
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

        <Card
          title="Round-up"
          subtitle="Tangerine-style spare change, moved the moment you log an expense"
        >
          <div className="setting-row">
            <div>
              <strong>Round up debit spending</strong>
              <p className="field-hint">
                Every expense on a checking or cash account sweeps the difference to your savings.
              </p>
            </div>
            <Switch
              label="Round up expenses"
              checked={settings.roundUpEnabled}
              disabled={savingsAccounts.length === 0}
              onChange={(roundUpEnabled) =>
                update({
                  roundUpEnabled,
                  roundUpAccountId:
                    settings.roundUpAccountId ?? savingsAccounts[0]?.id ?? null
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
                <Field label="Sweep into" hint="Where the spare change lands">
                  <select
                    className="select"
                    value={settings.roundUpAccountId ?? savingsAccounts[0].id}
                    onChange={(event) => update({ roundUpAccountId: event.target.value })}
                  >
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
                    A $12.40 coffee sweeps ${(sampleSweepCents / 100).toFixed(2)}.
                  </p>
                </div>
                <Segmented<string>
                  value={String(settings.roundUpToCents)}
                  onChange={(value) => update({ roundUpToCents: Number(value) as RoundUpIncrementCents })}
                  options={INCREMENTS.map((item) => ({ value: item.value, label: item.label }))}
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
              onClick={() => void importData()}
              disabled={busy}
            >
              Import data
            </Button>
          </div>
          <p className="field-hint">
            A JSON backup holds accounts, bills, goals, paychecks, allocations, transactions and
            every setting — it can be a full backup or just a few tables. The transactions CSV adds
            entries to accounts with matching names. Importing only adds what this app is missing:
            nothing local is deleted, and settings you have already changed stay as they are.
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
      </div>
    </>
  )
}

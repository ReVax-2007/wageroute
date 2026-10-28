import {
  Landmark,
  LayoutDashboard,
  Moon,
  Plus,
  Settings as SettingsIcon,
  ShieldCheck,
  Sun,
  Table2,
  Target,
  TrendingUp,
  Wallet,
  type LucideIcon
} from 'lucide-react'
import { totalWealthCents } from '@shared/accounts'
import { formatMoneyCompact } from '@shared/money'
import mark from '../assets/wageroute-mark.png'
import { cashOnHand } from '../lib/finance'
import { useFinanceStore, type Screen } from '../store/useFinanceStore'
import { Button, Switch } from './ui'

const NAV: { id: Screen; label: string; hint: string; icon: LucideIcon }[] = [
  { id: 'dashboard', label: 'Overview', hint: 'Balances and activity', icon: LayoutDashboard },
  { id: 'wall', label: 'Priority Wall', hint: 'Bills you cannot touch', icon: ShieldCheck },
  { id: 'goals', label: 'Sinking funds', hint: 'Future expenses', icon: Target },
  { id: 'accounts', label: 'Accounts', hint: 'Banks and credit', icon: Landmark },
  { id: 'ledger', label: 'Spreadsheet', hint: 'Edit everything', icon: Table2 },
  { id: 'settings', label: 'Settings', hint: 'Theme and data', icon: SettingsIcon }
]

export function Sidebar() {
  const screen = useFinanceStore((state) => state.screen)
  const go = useFinanceStore((state) => state.go)
  const openAllocator = useFinanceStore((state) => state.openAllocator)
  const snapshot = useFinanceStore((state) => state.snapshot)
  const settings = useFinanceStore((state) => state.settings)
  const saveSettings = useFinanceStore((state) => state.saveSettings)
  const dbPath = useFinanceStore((state) => state.dbPath)

  if (!snapshot) return null

  const isLight =
    settings.theme === 'light' ||
    (settings.theme === 'system' &&
      window.matchMedia('(prefers-color-scheme: light)').matches)

  const setLight = (next: boolean) => {
    void saveSettings({ ...settings, theme: next ? 'light' : 'dark' })
  }

  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark">
          <img src={mark} alt="" width={34} height={34} />
        </div>
        <div>
          <p className="brand-title">WageRoute</p>
          <p className="brand-sub">Every paycheck, routed</p>
        </div>
      </div>

      <Button
        variant="primary"
        icon={<Plus size={16} />}
        onClick={openAllocator}
        className="sidebar-cta"
      >
        Route a paycheck
      </Button>

      <nav className="nav">
        {NAV.map((item) => {
          const Icon = item.icon
          return (
            <button
              key={item.id}
              type="button"
              className={item.id === screen ? 'nav-item active' : 'nav-item'}
              onClick={() => go(item.id)}
            >
              <Icon size={17} strokeWidth={2} className="nav-icon" />
              <span className="nav-text">
                <span className="nav-label">{item.label}</span>
                <span className="nav-hint">{item.hint}</span>
              </span>
            </button>
          )
        })}
      </nav>

      <div className="sidebar-spacer" />

      <div className="sidebar-theme">
        <span className="sidebar-theme-label">
          {isLight ? <Sun size={14} /> : <Moon size={14} />}
          {isLight ? 'Light mode' : 'Dark mode'}
        </span>
        <Switch checked={isLight} onChange={setLight} label="Light mode" />
      </div>

      <div className="sidebar-stat">
        <div className="sidebar-stat-top">
          <Wallet size={14} />
          <span>Cash on hand</span>
        </div>
        <p className="sidebar-stat-value">
          {formatMoneyCompact(cashOnHand(snapshot.accounts), settings.currency)}
        </p>
        <p className="sidebar-stat-hint">{snapshot.accounts.length} accounts tracked</p>
        <div className="sidebar-stat-row">
          <span className="sidebar-stat-top">
            <TrendingUp size={14} />
            <span>Total wealth</span>
          </span>
          <span className="sidebar-stat-value-sm">
            {formatMoneyCompact(totalWealthCents(snapshot.accounts), settings.currency)}
          </span>
        </div>
      </div>

      <p className="sidebar-foot" title={dbPath}>
        {dbPath}
      </p>
    </aside>
  )
}

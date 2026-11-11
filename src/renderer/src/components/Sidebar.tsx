import {
  ArrowRightLeft,
  Landmark,
  LayoutDashboard,
  Plus,
  Settings as SettingsIcon,
  ShieldCheck,
  Table2,
  Target,
  type LucideIcon
} from 'lucide-react'
import { useFinanceStore, type Screen } from '../store/useFinanceStore'
import { Button } from './ui'

const NAV: { id: Screen; label: string; icon: LucideIcon }[] = [
  { id: 'dashboard', label: 'Home', icon: LayoutDashboard },
  { id: 'wall', label: 'Bills', icon: ShieldCheck },
  { id: 'goals', label: 'Goals', icon: Target },
  { id: 'accounts', label: 'Accounts', icon: Landmark },
  { id: 'transfers', label: 'Transfers', icon: ArrowRightLeft },
  { id: 'ledger', label: 'Spreadsheet', icon: Table2 },
  { id: 'settings', label: 'Settings', icon: SettingsIcon }
]

/**
 * The icon rail. Each screen's name is the button's text, shown as a pill on
 * hover or keyboard focus; the theme lives in Settings and the money summary
 * on Home.
 */
export function Sidebar() {
  const screen = useFinanceStore((state) => state.screen)
  const go = useFinanceStore((state) => state.go)
  const openAllocator = useFinanceStore((state) => state.openAllocator)
  const snapshot = useFinanceStore((state) => state.snapshot)

  if (!snapshot) return null

  return (
    <aside className="sidebar" aria-label="WageRoute sidebar">
      <Button
        variant="primary"
        icon={<Plus size={18} />}
        onClick={openAllocator}
        className="sidebar-cta"
      >
        <span className="nav-label">Route a paycheck</span>
      </Button>

      <nav className="nav" aria-label="Screens">
        {NAV.map((item) => {
          const Icon = item.icon
          return (
            <button
              key={item.id}
              type="button"
              className={item.id === screen ? 'nav-item active' : 'nav-item'}
              aria-current={item.id === screen ? 'page' : undefined}
              onClick={() => go(item.id)}
            >
              <Icon size={17} strokeWidth={2} aria-hidden="true" />
              <span className="nav-label">{item.label}</span>
            </button>
          )
        })}
      </nav>
    </aside>
  )
}

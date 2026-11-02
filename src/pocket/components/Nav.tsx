import { Database, Home, ListOrdered, Receipt, Target } from 'lucide-react'

export type Tab = 'home' | 'bills' | 'goals' | 'ledger' | 'data'

const TABS: { id: Tab; label: string; Icon: typeof Home }[] = [
  { id: 'home', label: 'Home', Icon: Home },
  { id: 'bills', label: 'Bills', Icon: Receipt },
  { id: 'goals', label: 'Goals', Icon: Target },
  { id: 'ledger', label: 'Entries', Icon: ListOrdered },
  { id: 'data', label: 'Data', Icon: Database }
]

export function Nav({ tab, onSelect }: { tab: Tab; onSelect: (tab: Tab) => void }) {
  return (
    <nav className="tabs" aria-label="Sections">
      {TABS.map(({ id, label, Icon }) => (
        <button
          key={id}
          type="button"
          className={id === tab ? 'tab active' : 'tab'}
          aria-current={id === tab ? 'page' : undefined}
          onClick={() => onSelect(id)}
        >
          <Icon size={21} aria-hidden="true" />
          <span>{label}</span>
        </button>
      ))}
    </nav>
  )
}

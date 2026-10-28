import { useEffect } from 'react'
import { useFinanceStore } from './store/useFinanceStore'
import { Sidebar } from './components/Sidebar'
import { Toast } from './components/ui'
import { Dashboard } from './screens/Dashboard'
import { PriorityWall } from './screens/PriorityWall'
import { Goals } from './screens/Goals'
import { Accounts } from './screens/Accounts'
import { Spreadsheet } from './screens/Spreadsheet'
import { Settings } from './screens/Settings'
import { Allocator } from './screens/Allocator'

export default function App() {
  const init = useFinanceStore((state) => state.init)
  const status = useFinanceStore((state) => state.status)
  const error = useFinanceStore((state) => state.error)
  const screen = useFinanceStore((state) => state.screen)
  const theme = useFinanceStore((state) => state.settings.theme)

  useEffect(() => {
    void init()
  }, [init])

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: light)')
    const apply = () => {
      const resolved = theme === 'system' ? (media.matches ? 'light' : 'dark') : theme
      document.documentElement.dataset.theme = resolved
      try {
        localStorage.setItem('cfr-theme', resolved)
      } catch {
        // A cache miss only costs a flash of the default palette on next launch.
      }
    }
    apply()
    if (theme !== 'system') return
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [theme])

  if (status === 'loading') {
    return (
      <div className="boot">
        <div className="boot-mark" />
        <p>Opening your ledger…</p>
      </div>
    )
  }

  if (status === 'error') {
    return (
      <div className="boot boot-error">
        <h1>Could not open the local database</h1>
        <p>{error}</p>
      </div>
    )
  }

  return (
    <div className="app-shell">
      <Sidebar />
      <main className="workspace">
        <div className="page">
          {screen === 'dashboard' && <Dashboard />}
          {screen === 'wall' && <PriorityWall />}
          {screen === 'goals' && <Goals />}
          {screen === 'accounts' && <Accounts />}
          {screen === 'ledger' && <Spreadsheet />}
          {screen === 'settings' && <Settings />}
        </div>
      </main>
      <Allocator />
      <Toast />
    </div>
  )
}

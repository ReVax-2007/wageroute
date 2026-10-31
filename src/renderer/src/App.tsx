import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { useFinanceStore, type Screen } from './store/useFinanceStore'
import { Sidebar } from './components/Sidebar'
import { Button, ConfirmDialog, Toast } from './components/ui'
import { Dashboard } from './screens/Dashboard'
import { PriorityWall } from './screens/PriorityWall'
import { Goals } from './screens/Goals'
import { Accounts } from './screens/Accounts'
import { Settings } from './screens/Settings'

// The grid engine, the wizard and the allocator are only needed once the user
// opens them; keeping them out of the entry chunk keeps the dashboard's first
// paint cheap.
const Spreadsheet = lazy(() =>
  import('./screens/Spreadsheet').then((module) => ({ default: module.Spreadsheet }))
)
const Allocator = lazy(() =>
  import('./screens/Allocator').then((module) => ({ default: module.Allocator }))
)
const ImportWizard = lazy(() =>
  import('./components/ImportWizard').then((module) => ({ default: module.ImportWizard }))
)

const SCREEN_LABEL: Record<Screen, string> = {
  dashboard: 'Overview',
  wall: 'Priority Wall',
  goals: 'Sinking funds',
  accounts: 'Accounts',
  ledger: 'Spreadsheet',
  settings: 'Settings'
}

export default function App() {
  const init = useFinanceStore((state) => state.init)
  const status = useFinanceStore((state) => state.status)
  const error = useFinanceStore((state) => state.error)
  const screen = useFinanceStore((state) => state.screen)
  const theme = useFinanceStore((state) => state.settings.theme)
  const lastScreen = useRef<Screen | null>(null)

  useEffect(() => {
    void init()
  }, [init])

  useEffect(() => {
    document.title = `${SCREEN_LABEL[screen]} — WageRoute`
    if (lastScreen.current === null) {
      // The first paint already starts at the top with nothing to announce.
      lastScreen.current = screen
      return
    }
    lastScreen.current = screen
    // A screen change replaces the whole tree; moving focus to its heading
    // tells a screen reader where it landed instead of leaving it on the nav.
    const heading = document.querySelector<HTMLElement>('#main-content h1')
    ;(heading ?? document.getElementById('main-content'))?.focus()
  }, [screen])

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
    return <BootError error={error} />
  }

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <Sidebar />
      <main
        id="main-content"
        className="workspace"
        aria-label={SCREEN_LABEL[screen]}
        tabIndex={-1}
      >
        <div className={screen === 'ledger' ? 'page page-sheet' : 'page'}>
          <Suspense fallback={<div className="boot"><div className="boot-mark" /></div>}>
            {screen === 'dashboard' && <Dashboard />}
            {screen === 'wall' && <PriorityWall />}
            {screen === 'goals' && <Goals />}
            {screen === 'accounts' && <Accounts />}
            {screen === 'ledger' && <Spreadsheet />}
            {screen === 'settings' && <Settings />}
          </Suspense>
        </div>
      </main>
      <Suspense fallback={null}>
        <Allocator />
        <ImportWizard />
      </Suspense>
      <ConfirmDialog />
      <Toast />
    </div>
  )
}

/**
 * A failed boot is the one screen the user cannot escape with the app open, so
 * it names the file, lets them copy its path, and points at the backup they can
 * import once the file is moved aside.
 */
function BootError({ error }: { error: string | null }) {
  const dbPath = useFinanceStore((state) => state.dbPath)
  const [copied, setCopied] = useState(false)

  const copyPath = async () => {
    if (!dbPath) return
    try {
      await navigator.clipboard.writeText(dbPath)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      // The path is still selectable on screen when the clipboard is refused.
    }
  }

  return (
    <div className="boot boot-error">
      <h1>Could not open the local database</h1>
      <p>{error}</p>
      {dbPath && (
        <div className="boot-path">
          <code>{dbPath}</code>
          <Button size="sm" onClick={() => void copyPath()}>
            {copied ? 'Copied' : 'Copy path'}
          </Button>
        </div>
      )}
      <p className="boot-hint">
        WageRoute leaves the file untouched when it fails its integrity check. Move it aside,
        reopen the app, then import your last JSON backup from Settings → Export full backup.
      </p>
      <Button variant="primary" onClick={() => window.location.reload()}>
        Try again
      </Button>
    </div>
  )
}

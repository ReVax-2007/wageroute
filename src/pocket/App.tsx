import { useEffect, useState } from 'react'
import { ShieldCheck, X } from 'lucide-react'
import { Nav, type Tab } from './components/Nav'
import { usePocket } from './lib/store'
import { Accounts } from './screens/Accounts'
import { Bills } from './screens/Bills'
import { Data } from './screens/Data'
import { Goals } from './screens/Goals'
import { Home } from './screens/Home'
import { Ledger } from './screens/Ledger'
import { Welcome } from './screens/Welcome'

export function App() {
  const status = usePocket((state) => state.status)
  const notice = usePocket((state) => state.notice)
  const error = usePocket((state) => state.error)
  const dismissNotice = usePocket((state) => state.dismissNotice)
  const dismissError = usePocket((state) => state.dismissError)
  const load = usePocket((state) => state.load)
  const [tab, setTab] = useState<Tab>('home')

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(dismissNotice, 3_500)
    return () => window.clearTimeout(timer)
  }, [notice, dismissNotice])

  return (
    <div className="app">
      <header className="top">
        <div className="brand">
          <img src="./favicon.svg" alt="" width={24} height={24} />
          <span>WageRoute</span>
          <span className="brand-tag">Pocket</span>
        </div>
        <span className="privacy-chip">
          <ShieldCheck size={13} aria-hidden="true" /> On this phone
        </span>
      </header>

      <main className="main">
        {status === 'loading' ? <p className="loading">Opening your ledger…</p> : null}
        {status === 'empty' ? <Welcome /> : null}
        {status === 'ready' ? (
          <>
            {tab === 'home' ? <Home go={setTab} /> : null}
            {tab === 'bills' ? <Bills /> : null}
            {tab === 'goals' ? <Goals /> : null}
            {tab === 'accounts' ? <Accounts /> : null}
            {tab === 'ledger' ? <Ledger /> : null}
            {tab === 'data' ? <Data /> : null}
          </>
        ) : null}
      </main>

      {status === 'ready' ? <Nav tab={tab} onSelect={setTab} /> : null}

      {notice ? (
        <div className="toast" role="status">
          {notice}
        </div>
      ) : null}

      {error ? (
        <div className="toast error" role="alert">
          <span>{error}</span>
          <button type="button" className="toast-close" onClick={dismissError} aria-label="Dismiss">
            <X size={15} />
          </button>
        </div>
      ) : null}
    </div>
  )
}

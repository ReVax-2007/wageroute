import { Component, StrictMode, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import 'react-data-grid/lib/styles.css'
import './styles/tokens.css'
import './styles/app.css'
import App from './App'

if (navigator.userAgent.includes('Mac')) {
  document.documentElement.classList.add('is-mac')
}

// Apply the last resolved palette before React paints, so light mode does not
// flash dark on every launch. Settings remain the source of truth.
try {
  const cached = localStorage.getItem('cfr-theme')
  document.documentElement.dataset.theme = cached === 'light' ? 'light' : 'dark'
} catch {
  document.documentElement.dataset.theme = 'dark'
}

class ErrorBoundary extends Component<{ children: ReactNode }, { message: string | null }> {
  override state: { message: string | null } = { message: null }

  static getDerivedStateFromError(error: unknown) {
    return { message: error instanceof Error ? error.message : String(error) }
  }

  override render() {
    if (this.state.message) {
      return (
        <div className="boot boot-error">
          <h1>The interface hit an error</h1>
          <p>{this.state.message}</p>
          <button type="button" className="btn btn-primary" onClick={() => location.reload()}>
            Reload window
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>
)

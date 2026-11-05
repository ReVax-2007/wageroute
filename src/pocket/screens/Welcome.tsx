import { Lock, RefreshCw, ShieldCheck, Smartphone } from 'lucide-react'
import { PickBackup } from '../components/PickBackup'
import { isAppleTouch, useInstallPrompt } from '../lib/install'
import { usePocket } from '../lib/store'

export function Welcome() {
  const error = usePocket((state) => state.error)
  const { canInstall, install } = useInstallPrompt()

  return (
    <div className="welcome screen">
      <img className="welcome-mark" src="./icon-192.png" alt="" width={76} height={76} />
      <h1>Your ledger, in your pocket.</h1>
      <p className="welcome-lead">
        WageRoute Pocket opens a backup from WageRoute on your computer. It is a small, quiet app
        that works with no signal and keeps every number on this phone.
      </p>

      <PickBackup className="button primary block">Choose a WageRoute backup</PickBackup>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}

      <ol className="steps">
        <li>
          <span className="step-icon">
            <RefreshCw size={17} aria-hidden="true" />
          </span>
          <span>On your computer, open WageRoute → Settings → Export full backup.</span>
        </li>
        <li>
          <span className="step-icon">
            <Smartphone size={17} aria-hidden="true" />
          </span>
          <span>Send that file to this phone, then choose it above.</span>
        </li>
        <li>
          <span className="step-icon">
            <ShieldCheck size={17} aria-hidden="true" />
          </span>
          <span>Add this page to your home screen. It opens offline from then on.</span>
        </li>
      </ol>

      <div className="welcome-note">
        <Lock size={16} aria-hidden="true" />
        <span>No account, no upload, no tracking. The file never leaves this phone.</span>
      </div>

      {canInstall ? (
        <button type="button" className="button block" onClick={() => void install()}>
          Add to home screen
        </button>
      ) : isAppleTouch() ? (
        <p className="fine">
          To install: tap Share in Safari, then <b>Add to Home Screen</b>.
        </p>
      ) : null}
    </div>
  )
}

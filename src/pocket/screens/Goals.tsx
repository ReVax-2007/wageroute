import { formatDateLong } from '@shared/dates'
import { formatMoney } from '@shared/money'
import { goalsSummary } from '../../renderer/src/lib/finance'
import { useSnapshot } from '../lib/store'
import { pocketView } from '../lib/compute'

export function Goals() {
  const snapshot = useSnapshot()
  if (!snapshot) return null
  const view = pocketView(snapshot)
  const currency = view.settings.currency
  const goals = snapshot.goals.filter((goal) => !goal.isArchived)
  const summary = goalsSummary(goals)

  return (
    <div className="screen">
      <section className="hero quiet">
        <span className="eyebrow">Set aside for goals</span>
        <p className="hero-number">{formatMoney(summary.fundedCents, currency)}</p>
        <p className="hero-note">
          {summary.targetCents > 0
            ? `Of ${formatMoney(summary.targetCents, currency)} across ${goals.length} goal${
                goals.length === 1 ? '' : 's'
              }.`
            : 'No goals are set up yet.'}
        </p>
        {summary.targetCents > 0 ? (
          <div className="bar wide" aria-hidden="true">
            <span style={{ width: `${Math.min(100, summary.progress * 100)}%` }} />
          </div>
        ) : null}
      </section>

      {goals.length === 0 ? (
        <p className="empty-line">Create a goal in WageRoute on your computer and it will appear here.</p>
      ) : (
        <ul className="list">
          {goals.map((goal) => {
            const progress =
              goal.targetCents > 0 ? Math.min(1, goal.fundedCents / goal.targetCents) : 0
            return (
              <li key={goal.id} className="goal-card">
                <div className="goal-head">
                  <span className="goal-dot" style={{ background: goal.color }} aria-hidden="true" />
                  <div className="row-main">
                    <span className="row-title">{goal.name}</span>
                    <span className="muted small">
                      {goal.isEmergency ? 'Emergency fund' : `${Math.round(progress * 100)}% there`}
                      {goal.targetDate ? ` · by ${formatDateLong(goal.targetDate)}` : ''}
                    </span>
                  </div>
                  <span className="amount">{formatMoney(goal.fundedCents, currency)}</span>
                </div>
                <div className="bar" aria-hidden="true">
                  <span style={{ width: `${progress * 100}%`, background: goal.color }} />
                </div>
                <div className="goal-foot">
                  <span className="muted small">
                    {formatMoney(goal.fundedCents, currency)} of{' '}
                    {formatMoney(goal.targetCents, currency)}
                  </span>
                  <span className="muted small">
                    {formatMoney(goal.remainingCents, currency)} to go
                  </span>
                </div>
              </li>
            )
          })}
        </ul>
      )}

      <p className="fine">
        Progress follows the money your paychecks set aside, or your dedicated account when you gave
        a goal one.
      </p>
    </div>
  )
}

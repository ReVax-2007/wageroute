export interface DonutSlice {
  key: string
  label: string
  cents: number
  color: string
}

export function Donut({
  slices,
  centerLabel,
  centerValue,
  size = 164
}: {
  slices: readonly DonutSlice[]
  centerLabel: string
  centerValue: string
  size?: number
}) {
  const total = slices.reduce((sum, slice) => sum + Math.max(0, slice.cents), 0)
  let offset = 0

  // A single total hides the composition the chart exists to show, so the
  // accessible name carries every slice that has a value.
  const breakdown = slices
    .filter((slice) => slice.cents > 0)
    .map((slice) => `${slice.label} ${Math.round((slice.cents / total) * 100)}%`)
    .join(', ')

  return (
    <svg
      className="donut-svg"
      width={size}
      height={size}
      viewBox="0 0 140 140"
      role="img"
      aria-label={
        breakdown ? `${centerLabel}: ${centerValue}. ${breakdown}` : `${centerLabel}: ${centerValue}`
      }
    >
      <circle cx="70" cy="70" r="54" fill="none" stroke="var(--panel-3)" strokeWidth="18" />
      {total > 0 &&
        slices.map((slice) => {
          if (slice.cents <= 0) return null
          const share = (slice.cents / total) * 100
          const circle = (
            <circle
              key={slice.key}
              cx="70"
              cy="70"
              r="54"
              fill="none"
              stroke={slice.color}
              strokeWidth="18"
              pathLength={100}
              strokeDasharray={`${share} ${100 - share}`}
              strokeDashoffset={-offset}
              transform="rotate(-90 70 70)"
            />
          )
          offset += share
          return circle
        })}
      <text x="70" y="64" textAnchor="middle" className="donut-center-label">
        {centerLabel}
      </text>
      <text x="70" y="86" textAnchor="middle" className="donut-center-value">
        {centerValue}
      </text>
    </svg>
  )
}

export interface SparklinePoint {
  onDate: string
  valueCents: number
}

/**
 * A shape, not a chart: the dashboard already prints the exact number, so this
 * only has to show direction. The label carries the numbers for screen readers.
 */
export function Sparkline({
  points,
  label,
  className
}: {
  points: readonly SparklinePoint[]
  label: string
  className?: string
}) {
  if (points.length < 2) return null

  const width = 240
  const height = 44
  const pad = 3
  const values = points.map((point) => point.valueCents)
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  const stepX = width / (points.length - 1)
  const yOf = (cents: number) => height - pad - ((cents - min) / span) * (height - pad * 2)

  const coords = points
    .map((point, index) => `${(index * stepX).toFixed(1)},${yOf(point.valueCents).toFixed(1)}`)
    .join(' ')
  const first = points[0]
  const last = points[points.length - 1]
  const tone = last.valueCents >= first.valueCents ? 'var(--accent)' : 'var(--danger-text)'

  return (
    <svg
      className={className ? `sparkline ${className}` : 'sparkline'}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={label}
    >
      <polyline
        points={coords}
        fill="none"
        stroke={tone}
        strokeWidth="2"
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  )
}

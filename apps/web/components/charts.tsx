import { formatCompact, formatMetric } from '../lib/format';

export type SeriesPoint = { date: string; value: number | null };

type ChartProps = {
  title: string;
  points: SeriesPoint[];
  color: string;
  format: string;
  grainLabel: string;
  currency?: string;
};

/**
 * A single-series small multiple.
 *
 * Small multiples rather than one combined chart, because spend, installs and
 * revenue are different measures on different grains. Overlaying them on two
 * y-axes would imply a comparison that is not valid, so MART does not draw it.
 *
 * Each chart carries a visible direct label for the latest value and an axis
 * range, which is also what satisfies the contrast relief rule for the lighter
 * series colours.
 */
export function SmallMultiple({
  title,
  points,
  color,
  format,
  grainLabel,
  currency = 'USD',
}: ChartProps) {
  const values = points.map((p) => p.value).filter((v): v is number => v !== null);
  const hasData = values.length > 0;
  const max = hasData ? Math.max(...values, 0) : 0;
  const latest = points.length > 0 ? (points[points.length - 1]?.value ?? null) : null;

  const width = 300;
  const height = 92;
  const padBottom = 16;
  const padTop = 6;
  const plotHeight = height - padBottom - padTop;
  const count = points.length;
  // 2px surface gap between adjacent bars, per the mark spec.
  const gap = 2;
  const barWidth = count > 0 ? Math.max(2, (width - gap * (count - 1)) / count) : 0;

  return (
    <figure className="chart" style={{ margin: 0 }}>
      <figcaption className="chart-head">
        <span className="chart-title">{title}</span>
        <span className="chart-latest" style={{ color }}>
          {hasData ? formatMetric(latest, format, currency) : 'no data'}
        </span>
      </figcaption>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`${title}. ${
          hasData
            ? `Latest ${formatMetric(latest, format, currency)}, peak ${formatMetric(max, format, currency)} across ${count} days.`
            : 'No data for the selected range.'
        }`}
      >
        {hasData ? (
          points.map((point, index) => {
            const value = point.value ?? 0;
            const barHeight = max > 0 ? (value / max) * plotHeight : 0;
            const x = index * (barWidth + gap);
            const y = padTop + (plotHeight - barHeight);
            return (
              <rect
                key={point.date}
                x={x}
                y={y}
                width={barWidth}
                height={Math.max(barHeight, value > 0 ? 1.5 : 0)}
                rx={Math.min(2, barWidth / 2)}
                fill={color}
              >
                <title>{`${point.date}: ${formatMetric(point.value, format, currency)}`}</title>
              </rect>
            );
          })
        ) : (
          <text x={width / 2} y={height / 2} className="axis-text" textAnchor="middle">
            No data in range
          </text>
        )}
        <line
          x1={0}
          y1={height - padBottom}
          x2={width}
          y2={height - padBottom}
          className="axis-line"
        />
        {hasData ? (
          <>
            <text x={0} y={height - 4} className="axis-text">
              {points[0]?.date.slice(5)}
            </text>
            <text x={width} y={height - 4} className="axis-text" textAnchor="end">
              {points[points.length - 1]?.date.slice(5)}
            </text>
            <text x={width / 2} y={height - 4} className="axis-text" textAnchor="middle">
              peak {formatCompact(max)}
            </text>
          </>
        ) : null}
      </svg>
      <span className="chip chip-grain">{grainLabel}</span>
    </figure>
  );
}

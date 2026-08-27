import { formatMetric, statusTone } from '../lib/format';

export type MetricValue = {
  metricKey: string;
  displayName: string;
  value: number | null;
  numerator: number | null;
  denominator: number | null;
  availability: 'available' | 'partial' | 'stale' | 'unavailable';
  reason?: string;
  grain: { primary: string; mixed?: string[]; note: string };
  sources: string[];
  format: string;
  formula: string;
  providers: string[];
  freshnessStatus?: string;
  latestDataDate?: string | null;
};

const GRAIN_LABEL: Record<string, string> = {
  report_date: 'report date',
  install_date: 'install date',
  event_date: 'event date',
  cohort_date: 'cohort date',
};

/**
 * A metric tile.
 *
 * Every tile shows the value, where it came from, the grain it is expressed in
 * and how fresh it is. When a metric is unavailable it says why, in place of the
 * number - a zero would be a different claim.
 */
export function MetricTile({ metric, currency }: { metric: MetricValue; currency?: string }) {
  const unavailable = metric.availability === 'unavailable';
  const grainText = metric.grain.mixed
    ? `mixed: ${metric.grain.mixed.map((g) => GRAIN_LABEL[g] ?? g).join(' / ')}`
    : (GRAIN_LABEL[metric.grain.primary] ?? metric.grain.primary);

  return (
    <div className="tile">
      <div className="tile-label">
        <span>{metric.displayName}</span>
        {metric.availability !== 'available' ? (
          <span className={`chip ${statusTone(metric.availability)}`}>{metric.availability}</span>
        ) : null}
      </div>

      {unavailable ? (
        <div className="tile-value unavailable" title={metric.formula}>
          {metric.reason ?? 'Unavailable'}
        </div>
      ) : (
        <div className="tile-value" title={`${metric.formula} (${grainText})`}>
          {formatMetric(metric.value, metric.format, currency)}
        </div>
      )}

      <div className="tile-meta">
        <span className="chip chip-grain">{grainText}</span>
        {metric.providers.length > 0 ? <span>{metric.providers.join(' + ')}</span> : null}
        {metric.latestDataDate ? <span>data to {metric.latestDataDate}</span> : null}
      </div>
    </div>
  );
}

export function StatusChip({
  status,
  label,
}: {
  status: string | null | undefined;
  label?: string;
}) {
  return <span className={`chip ${statusTone(status)}`}>{label ?? status ?? 'unknown'}</span>;
}

export function EmptyState({
  title,
  message,
  action,
}: {
  title: string;
  message: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="empty-state">
      <h3>{title}</h3>
      <p>{message}</p>
      {action ? (
        <div className="button-row" style={{ marginTop: 6 }}>
          {action}
        </div>
      ) : null}
    </div>
  );
}

export function Card({
  title,
  hint,
  children,
  actions,
}: {
  title?: string;
  hint?: string;
  children: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <section className="card">
      {title ? (
        <header className="card-header">
          <div>
            <h2>{title}</h2>
            {hint ? <div className="hint">{hint}</div> : null}
          </div>
          {actions}
        </header>
      ) : null}
      {children}
    </section>
  );
}

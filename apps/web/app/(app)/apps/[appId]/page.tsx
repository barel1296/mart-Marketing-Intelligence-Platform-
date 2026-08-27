import Link from 'next/link';
import { apiGet } from '../../../../lib/api';
import {
  Card,
  DataSourceBanner,
  EmptyState,
  MetricTile,
  StatusChip,
  type DataSource,
  type MetricValue,
} from '../../../../components/primitives';
import { SmallMultiple } from '../../../../components/charts';
import { RecomputeReconciliationButton, SyncButton } from '../../../../components/actions';
import { formatMetric, relativeTime } from '../../../../lib/format';

type Me = { organizations: Array<{ id: string; name: string; role: string }> };

type CommandCenter = {
  app: {
    id: string;
    name: string;
    default_currency: string;
    primary_attribution_provider: string | null;
  };
  range: { from: string; to: string };
  dataHealth: {
    integrations: Array<{
      role: string;
      providerKey: string;
      connectionStatus: string;
      account: string | null;
      accountName: string | null;
    }>;
    freshness: Array<{
      provider_key: string;
      data_type: string;
      status: string;
      last_success_at: string | null;
      latest_provider_data_date: string | null;
      last_error_class: string | null;
    }>;
    recentRuns: Array<{
      id: string;
      provider_key: string;
      data_type: string;
      status: string;
      window_start: string;
      window_end: string;
      rows_normalized: string | number;
      created_at: string;
      error_message: string | null;
    }>;
    recentErrors: Array<{
      error_class: string;
      user_message: string | null;
      message: string;
      occurred_at: string;
    }>;
    mappingCoverage: { coveragePct: number | null; total: number } | null;
  };
  metrics: MetricValue[];
  timeseries: {
    points: Array<{
      date: string;
      spend: number | null;
      impressions: number | null;
      clicks: number | null;
      attributedInstalls: number | null;
      attributedRevenue: number | null;
    }>;
    grainWarning: string;
  };
  campaigns: {
    total: number;
    rows: Array<{
      externalCampaignId: string;
      campaignName: string | null;
      campaignStatus: string | null;
      spend: number;
      impressions: number;
      clicks: number;
      ctr: number | null;
      cpm: number | null;
      mappingStatus: string;
      attributedInstalls: number | null;
      attributedRevenue: number | null;
      reportedCpi: number | null;
      attributionNote: string | null;
      marketingLatestDate: string | null;
      attributionLatestDate: string | null;
    }>;
  };
  reconciliation: {
    coverage: {
      total: number;
      matchedExact: number;
      matchedConfident: number;
      matchedFallback: number;
      ambiguous: number;
      unmatched: number;
      manuallyVerified: number;
      coveragePct: number | null;
    } | null;
    discrepancies: Array<{
      kind: string;
      externalCampaignId: string | null;
      campaignName: string | null;
      spend: number | null;
      attributedInstalls: number | null;
      detail: string;
    }>;
  };
  dataQuality: Array<{
    check_key: string;
    severity: string;
    message: string;
    observed_date: string | null;
    entity_ref: string | null;
  }>;
  dataSources: DataSource[];
  emptyStates: Array<{ key: string; title: string; message: string; action?: string }>;
};

/**
 * The button that belongs with an empty state.
 *
 * A range with no data has nothing to fix - offering an action would imply the
 * user did something wrong, when the provider simply reported nothing for those
 * dates.
 */
function emptyStateAction(
  action: string | undefined,
  organizationId: string,
  appId: string,
): React.ReactNode {
  if (action === 'run_sync') {
    return (
      <SyncButton organizationId={organizationId} appId={appId} backfill label="Run first sync" />
    );
  }
  if (action === 'widen_range') return null;
  return (
    <Link className="nav-item" href={`/apps/${appId}/integrations`}>
      Open integrations
    </Link>
  );
}

export default async function CommandCenterPage({
  params,
  searchParams,
}: {
  params: Promise<{ appId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { appId } = await params;
  const search = await searchParams;
  const me = await apiGet<Me>('/api/v1/auth/me');
  const organization = me.organizations[0];
  if (!organization) return <EmptyState title="No organization" message="No organization found." />;

  const query = new URLSearchParams();
  for (const key of ['from', 'to', 'country', 'platform']) {
    const value = search[key];
    if (typeof value === 'string' && value.length > 0) query.set(key, value);
  }

  const data = await apiGet<CommandCenter>(
    `/api/v1/organizations/${organization.id}/apps/${appId}/command-center${
      query.size > 0 ? `?${query.toString()}` : ''
    }`,
  );

  const currency = data.app.default_currency;
  const filters = await apiGet<{ countries: string[]; platforms: string[] }>(
    `/api/v1/organizations/${organization.id}/apps/${appId}/filters`,
  );

  const metricByKey = new Map(data.metrics.map((m) => [m.metricKey, m]));
  const primaryOrder = [
    'spend',
    'impressions',
    'clicks',
    'ctr',
    'cpm',
    'cpc',
    'attributed_installs',
    'reported_cpi',
    'attributed_revenue',
    'mapping_coverage',
    'cohort_roas',
  ];

  return (
    <>
      <header className="page-header">
        <div>
          <h1>{data.app.name} — Command Center</h1>
          <p>
            Every number below is read from MART storage, never from a live provider call. Each tile
            states its source, its grain and how fresh it is.
          </p>
        </div>
        <div className="button-row">
          <Link className="nav-item" href={`/apps/${appId}/integrations`}>
            Integrations
          </Link>
          <SyncButton organizationId={organization.id} appId={appId} />
        </div>
      </header>

      <form className="toolbar" method="get">
        <div className="field">
          <label htmlFor="from">From</label>
          <input id="from" name="from" type="date" defaultValue={data.range.from} />
        </div>
        <div className="field">
          <label htmlFor="to">To</label>
          <input id="to" name="to" type="date" defaultValue={data.range.to} />
        </div>
        <div className="field">
          <label htmlFor="country">Country</label>
          <select id="country" name="country" defaultValue={(search['country'] as string) ?? ''}>
            <option value="">All</option>
            {filters.countries.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="platform">Platform</label>
          <select id="platform" name="platform" defaultValue={(search['platform'] as string) ?? ''}>
            <option value="">All</option>
            {filters.platforms.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </div>
        <button type="submit">Apply</button>
      </form>

      <DataSourceBanner sources={data.dataSources} />

      {data.emptyStates.length > 0 ? (
        <div className="stack" style={{ marginBottom: 18 }}>
          {data.emptyStates.map((state) => (
            <EmptyState
              key={state.key}
              title={state.title}
              message={state.message}
              action={emptyStateAction(state.action, organization.id, appId)}
            />
          ))}
        </div>
      ) : null}

      {/* ------------------------------------------------------ 1. data health */}
      <div className="section-title">1 — Data health</div>
      <Card>
        <div className="tile-grid">
          {data.dataHealth.integrations.map((integration) => (
            <div className="tile" key={`${integration.role}-${integration.providerKey}`}>
              <div className="tile-label">
                <span>
                  {integration.role === 'marketing_network'
                    ? 'Marketing network'
                    : 'Attribution (MMP)'}
                </span>
              </div>
              <div className="tile-value" style={{ fontSize: 17 }}>
                {integration.providerKey}
              </div>
              <div className="tile-meta">
                <StatusChip status={integration.connectionStatus} />
                {integration.account ? <span className="mono">{integration.account}</span> : null}
              </div>
            </div>
          ))}
          {data.dataHealth.integrations.length === 0 ? (
            <div className="tile">
              <div className="tile-label">Connections</div>
              <div className="tile-value unavailable">Nothing connected for this app yet.</div>
            </div>
          ) : null}
        </div>

        <div className="table-wrap" style={{ marginTop: 14 }}>
          <table>
            <thead>
              <tr>
                <th>Stream</th>
                <th>Provider</th>
                <th>Freshness</th>
                <th>Last success</th>
                <th>Provider data through</th>
              </tr>
            </thead>
            <tbody>
              {data.dataHealth.freshness.length === 0 ? (
                <tr>
                  <td colSpan={5} className="muted">
                    No sync has run for this app yet.
                  </td>
                </tr>
              ) : (
                data.dataHealth.freshness.map((row) => (
                  <tr key={`${row.provider_key}-${row.data_type}`}>
                    <td>{row.data_type.replace(/_/g, ' ')}</td>
                    <td>{row.provider_key}</td>
                    <td>
                      <StatusChip status={row.status} />
                      {row.last_error_class ? (
                        <span className="cell-note">{row.last_error_class}</span>
                      ) : null}
                    </td>
                    <td className="muted">{relativeTime(row.last_success_at)}</td>
                    <td className="mono">{row.latest_provider_data_date ?? '—'}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {data.dataHealth.recentErrors.length > 0 ? (
          <div className="stack" style={{ marginTop: 12 }}>
            <h3>Latest sync errors</h3>
            {data.dataHealth.recentErrors.map((error, index) => (
              <div key={index} className="inline-meta">
                <StatusChip status="error" label={error.error_class} />
                <span>{error.user_message ?? error.message}</span>
                <span>{relativeTime(error.occurred_at)}</span>
              </div>
            ))}
          </div>
        ) : null}
      </Card>

      {/* --------------------------------------------------- 2. core metrics */}
      <div className="section-title">2 — Core delivery and attribution metrics</div>
      <div className="tile-grid">
        {primaryOrder
          .map((key) => metricByKey.get(key))
          .filter((m): m is MetricValue => Boolean(m))
          .map((metric) => (
            <MetricTile key={metric.metricKey} metric={metric} currency={currency} />
          ))}
      </div>

      {/* ------------------------------------------------------- 3. trend */}
      <div className="section-title">3 — Performance trend</div>
      <Card hint={data.timeseries.grainWarning}>
        <div className="chart-grid">
          <SmallMultiple
            title="Spend"
            points={data.timeseries.points.map((p) => ({ date: p.date, value: p.spend }))}
            color="var(--series-1)"
            format="currency"
            currency={currency}
            grainLabel="report date · Meta"
          />
          <SmallMultiple
            title="Impressions"
            points={data.timeseries.points.map((p) => ({ date: p.date, value: p.impressions }))}
            color="var(--series-1)"
            format="integer"
            grainLabel="report date · Meta"
          />
          <SmallMultiple
            title="Clicks"
            points={data.timeseries.points.map((p) => ({ date: p.date, value: p.clicks }))}
            color="var(--series-1)"
            format="integer"
            grainLabel="report date · Meta"
          />
          <SmallMultiple
            title="Attributed installs"
            points={data.timeseries.points.map((p) => ({
              date: p.date,
              value: p.attributedInstalls,
            }))}
            color="var(--series-2)"
            format="integer"
            grainLabel="install date · MMP"
          />
          <SmallMultiple
            title="Attributed revenue"
            points={data.timeseries.points.map((p) => ({
              date: p.date,
              value: p.attributedRevenue,
            }))}
            color="var(--series-3)"
            format="currency"
            currency={currency}
            grainLabel="event date · MMP"
          />
        </div>
      </Card>

      {/* ---------------------------------------------------- 4. campaigns */}
      <div className="section-title">4 — Campaigns</div>
      <Card
        hint={`${data.campaigns.total} campaign${data.campaigns.total === 1 ? '' : 's'} with delivery in range. Attribution columns are populated only where the campaign mapping is authoritative.`}
      >
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Campaign</th>
                <th>Meta campaign ID</th>
                <th>Mapping</th>
                <th className="num">Spend</th>
                <th className="num">Impressions</th>
                <th className="num">Clicks</th>
                <th className="num">CTR</th>
                <th className="num">CPM</th>
                <th className="num">Attributed installs</th>
                <th className="num">Reported CPI</th>
                <th className="num">Attributed revenue</th>
              </tr>
            </thead>
            <tbody>
              {data.campaigns.rows.length === 0 ? (
                <tr>
                  <td colSpan={11} className="muted">
                    No campaign delivery stored for this range.
                  </td>
                </tr>
              ) : (
                data.campaigns.rows.map((row) => (
                  <tr key={row.externalCampaignId}>
                    <td>
                      {row.campaignName ?? '(unnamed)'}
                      {row.campaignStatus ? (
                        <span className="cell-note">{row.campaignStatus}</span>
                      ) : null}
                    </td>
                    <td className="mono">{row.externalCampaignId}</td>
                    <td>
                      <StatusChip status={row.mappingStatus} />
                      {row.attributionNote ? (
                        <span className="cell-note">{row.attributionNote}</span>
                      ) : null}
                    </td>
                    <td className="num">{formatMetric(row.spend, 'currency', currency)}</td>
                    <td className="num">{formatMetric(row.impressions, 'integer')}</td>
                    <td className="num">{formatMetric(row.clicks, 'integer')}</td>
                    <td className="num">{formatMetric(row.ctr, 'percent')}</td>
                    <td className="num">{formatMetric(row.cpm, 'currency', currency)}</td>
                    <td className="num">
                      {row.attributedInstalls === null ? (
                        <span className="muted">—</span>
                      ) : (
                        formatMetric(row.attributedInstalls, 'integer')
                      )}
                    </td>
                    <td className="num">
                      {row.reportedCpi === null ? (
                        <span className="muted">—</span>
                      ) : (
                        formatMetric(row.reportedCpi, 'currency', currency)
                      )}
                    </td>
                    <td className="num">
                      {row.attributedRevenue === null ? (
                        <span className="muted">—</span>
                      ) : (
                        formatMetric(row.attributedRevenue, 'currency', currency)
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {/* ----------------------------------------------- 5. reconciliation */}
      <div className="section-title">5 — Source reconciliation</div>
      <Card
        hint="MART reveals disagreement between the marketing network and the MMP rather than forcing the numbers to agree."
        actions={<RecomputeReconciliationButton organizationId={organization.id} appId={appId} />}
      >
        {data.reconciliation.coverage === null || data.reconciliation.coverage.total === 0 ? (
          <EmptyState
            title="No mappings computed yet"
            message="MART reconciles campaigns after both a marketing network and an attribution provider have synced. Run a sync, then recompute mappings."
          />
        ) : (
          <>
            <div className="tile-grid">
              <div className="tile">
                <div className="tile-label">Mapping coverage</div>
                <div className="tile-value">
                  {data.reconciliation.coverage.coveragePct === null
                    ? '—'
                    : `${data.reconciliation.coverage.coveragePct}%`}
                </div>
                <div className="tile-meta">
                  <span>authoritative links only (stable id or verified)</span>
                </div>
              </div>
              {(
                [
                  ['Exact id matches', data.reconciliation.coverage.matchedExact, 'matched_exact'],
                  [
                    'Name fallback candidates',
                    data.reconciliation.coverage.matchedFallback,
                    'matched_fallback',
                  ],
                  ['Ambiguous', data.reconciliation.coverage.ambiguous, 'ambiguous'],
                  ['Unmatched', data.reconciliation.coverage.unmatched, 'unmatched'],
                  [
                    'Manually verified',
                    data.reconciliation.coverage.manuallyVerified,
                    'manually_verified',
                  ],
                ] as Array<[string, number, string]>
              ).map(([label, value, status]) => (
                <div className="tile" key={label}>
                  <div className="tile-label">{label}</div>
                  <div className="tile-value">{value}</div>
                  <div className="tile-meta">
                    <StatusChip status={status} />
                  </div>
                </div>
              ))}
            </div>

            {data.reconciliation.discrepancies.length > 0 ? (
              <div className="table-wrap" style={{ marginTop: 14 }}>
                <table>
                  <thead>
                    <tr>
                      <th>Discrepancy</th>
                      <th>Campaign</th>
                      <th className="num">Spend</th>
                      <th className="num">Attributed installs</th>
                      <th>What it means</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.reconciliation.discrepancies.map((row, index) => (
                      <tr key={`${row.kind}-${row.externalCampaignId ?? index}`}>
                        <td>
                          <StatusChip status="ambiguous" label={row.kind.replace(/_/g, ' ')} />
                        </td>
                        <td>
                          {row.campaignName ?? '(no name)'}
                          <span className="cell-note mono">
                            {row.externalCampaignId ?? 'no campaign id'}
                          </span>
                        </td>
                        <td className="num">
                          {row.spend === null ? '—' : formatMetric(row.spend, 'currency', currency)}
                        </td>
                        <td className="num">
                          {row.attributedInstalls === null
                            ? '—'
                            : formatMetric(row.attributedInstalls, 'integer')}
                        </td>
                        <td className="muted">{row.detail}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </>
        )}
      </Card>

      {/* --------------------------------------------------- 6. data quality */}
      <div className="section-title">6 — Data quality</div>
      <Card hint="Deterministic checks run during every sync.">
        {data.dataQuality.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>
            No data-quality findings for this app.
          </p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Check</th>
                  <th>Severity</th>
                  <th>Date</th>
                  <th>Entity</th>
                  <th>Detail</th>
                </tr>
              </thead>
              <tbody>
                {data.dataQuality.map((finding, index) => (
                  <tr key={`${finding.check_key}-${index}`}>
                    <td className="mono">{finding.check_key}</td>
                    <td>
                      <StatusChip
                        status={finding.severity === 'error' ? 'failed' : finding.severity}
                        label={finding.severity}
                      />
                    </td>
                    <td className="mono">{finding.observed_date ?? '—'}</td>
                    <td className="mono">{finding.entity_ref ?? '—'}</td>
                    <td className="muted">{finding.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div className="section-title">Recent syncs</div>
      <Card>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Started</th>
                <th>Provider</th>
                <th>Data type</th>
                <th>Window</th>
                <th>Status</th>
                <th className="num">Rows</th>
              </tr>
            </thead>
            <tbody>
              {data.dataHealth.recentRuns.length === 0 ? (
                <tr>
                  <td colSpan={6} className="muted">
                    No sync runs yet.
                  </td>
                </tr>
              ) : (
                data.dataHealth.recentRuns.map((run) => (
                  <tr key={run.id}>
                    <td className="muted">{relativeTime(run.created_at)}</td>
                    <td>{run.provider_key}</td>
                    <td>{run.data_type.replace(/_/g, ' ')}</td>
                    <td className="mono">
                      {run.window_start} → {run.window_end}
                    </td>
                    <td>
                      <StatusChip status={run.status} />
                      {run.error_message ? (
                        <span className="cell-note">{run.error_message}</span>
                      ) : null}
                    </td>
                    <td className="num">{String(run.rows_normalized)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}

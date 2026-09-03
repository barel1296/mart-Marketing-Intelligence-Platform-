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
import {
  RecomputeReconciliationButton,
  ResolveAmbiguousMapping,
  SyncButton,
} from '../../../../components/actions';
import { formatMetric, relativeTime } from '../../../../lib/format';

type Me = { organizations: Array<{ id: string; name: string; role: string }> };

type SyncErrorRow = {
  error_class: string;
  user_message: string | null;
  message: string;
  occurred_at: string;
};

/** Mirrors CoverageSummary from @mart/integrations. */
type CoverageSummary = {
  total: number;
  matchedExact: number;
  matchedConfident: number;
  matchedNameEmbedded: number;
  matchedFallback: number;
  ambiguous: number;
  unmatched: number;
  manuallyVerified: number;
  notApplicable: number;
  authoritative: number;
  operational: number;
  authoritativeCoveragePct: number | null;
  operationalCoveragePct: number | null;
  coveragePct: number | null;
  eligible?: {
    from: string;
    to: string;
    eligibleCampaigns: number;
    mappedCampaigns: number;
    ambiguousCampaigns: number;
    unmappedCampaigns: number;
    historicalCampaigns: number;
    totalSpend: number;
    mappedSpend: number;
    ambiguousSpend: number;
    unmappedSpend: number;
    spendPct: number | null;
    totalPaidInstalls: number;
    mappedPaidInstalls: number;
    ambiguousPaidInstalls: number;
    unmappedPaidInstalls: number;
    organicInstalls: number;
    installPct: number | null;
    campaignPct: number | null;
  };
};

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
    activeErrors: SyncErrorRow[];
    resolvedErrors: SyncErrorRow[];
    mappingCoverage: CoverageSummary | null;
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
    coverage: CoverageSummary | null;
    ambiguous: Array<{
      id: string;
      source_name: string | null;
      source_external_id: string;
      candidates: Array<{ externalCampaignId?: string | null; campaignName?: string | null }>;
      evidence: Record<string, unknown>;
    }>;
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
  // Provider names come from the payload, never from this file. Hardcoding
  // "Meta" here means the dashboard lies the moment a second network is bound,
  // and it is exactly the provider knowledge the semantic layer exists to keep
  // out of business and presentation code.
  const providerFor = (role: string): string =>
    data.dataHealth.integrations.find((i) => i.role === role)?.providerKey ?? 'provider';
  const marketingProvider = providerFor('marketing_network');
  const attributionProvider = providerFor('primary_attribution');
  const filters = await apiGet<{ countries: string[]; platforms: string[] }>(
    `/api/v1/organizations/${organization.id}/apps/${appId}/filters`,
  );

  // Sections come from each metric's declared family, not from a list kept
  // here. A hand-ordered array of keys is a second definition of the metric
  // set: it silently drops anything the registry adds - as it had already
  // dropped five metrics - and it lets this page disagree with the registry
  // about what a section contains.
  const familyOrder: Array<{ family: string; title: string }> = [
    { family: 'delivery', title: 'Core delivery' },
    { family: 'attribution', title: 'Attribution' },
    { family: 'revenue', title: 'Revenue' },
    { family: 'efficiency', title: 'Efficiency' },
    { family: 'coverage', title: 'Coverage' },
    { family: 'cohort', title: 'Cohort' },
  ];
  const metricsByFamily = new Map<string, MetricValue[]>();
  for (const metric of data.metrics) {
    const bucket = metricsByFamily.get(metric.family);
    if (bucket) bucket.push(metric);
    else metricsByFamily.set(metric.family, [metric]);
  }

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
          <Link className="nav-item" href={`/apps/${appId}/decisions`}>
            Decision Center
          </Link>
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

        {/* Active issues only. An error a later successful sync superseded is
            history and is shown as such, below and clearly labelled. */}
        {data.dataHealth.activeErrors.length > 0 ? (
          <div className="stack" style={{ marginTop: 12 }}>
            <h3>Active issues</h3>
            {data.dataHealth.activeErrors.map((error, index) => (
              <div key={index} className="inline-meta">
                <StatusChip status="error" label={error.error_class} />
                <span>{error.user_message ?? error.message}</span>
                <span>{relativeTime(error.occurred_at)}</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="muted" style={{ marginTop: 12 }}>
            No active sync issues for this app.
          </p>
        )}

        {data.dataHealth.resolvedErrors.length > 0 ? (
          <details className="stack" style={{ marginTop: 12 }}>
            <summary>
              Recently resolved issues ({data.dataHealth.resolvedErrors.length}) — kept for audit,
              superseded by a later successful sync
            </summary>
            {data.dataHealth.resolvedErrors.map((error, index) => (
              <div key={index} className="inline-meta">
                <StatusChip status="completed" label={`resolved: ${error.error_class}`} />
                <span>{error.user_message ?? error.message}</span>
                <span>{relativeTime(error.occurred_at)}</span>
              </div>
            ))}
          </details>
        ) : null}
      </Card>

      {/* --------------------------------------------------- 2. core metrics */}
      <div className="section-title">2 — Metrics</div>
      {familyOrder.map(({ family, title }) => {
        const metrics = metricsByFamily.get(family) ?? [];
        if (metrics.length === 0) return null;
        return (
          <div key={family}>
            <div className="subsection-title">{title}</div>
            <div className="tile-grid">
              {metrics.map((metric) => (
                <MetricTile key={metric.metricKey} metric={metric} currency={currency} />
              ))}
            </div>
          </div>
        );
      })}

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
            grainLabel={`report date · ${marketingProvider}`}
          />
          <SmallMultiple
            title="Impressions"
            points={data.timeseries.points.map((p) => ({ date: p.date, value: p.impressions }))}
            color="var(--series-1)"
            format="integer"
            grainLabel={`report date · ${marketingProvider}`}
          />
          <SmallMultiple
            title="Clicks"
            points={data.timeseries.points.map((p) => ({ date: p.date, value: p.clicks }))}
            color="var(--series-1)"
            format="integer"
            grainLabel={`report date · ${marketingProvider}`}
          />
          <SmallMultiple
            title="Attributed installs"
            points={data.timeseries.points.map((p) => ({
              date: p.date,
              value: p.attributedInstalls,
            }))}
            color="var(--series-2)"
            format="integer"
            grainLabel={`install date · ${attributionProvider}`}
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
            grainLabel={`event date · ${attributionProvider}`}
          />
        </div>
      </Card>

      {/* ---------------------------------------------------- 4. campaigns */}
      <div className="section-title">4 — Campaigns</div>
      <Card
        hint={`${data.campaigns.total} campaign${data.campaigns.total === 1 ? '' : 's'} with delivery in range. Attribution columns are populated where the campaign mapping is authoritative, or a deterministic high-confidence match.`}
      >
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Campaign</th>
                <th>{marketingProvider} campaign ID</th>
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
            {/* Two coverage numbers, never averaged into one: they answer
                different questions and mixing them would let name evidence
                inflate what MART claims as identity. */}
            <div className="tile-grid">
              <div className="tile">
                <div className="tile-label">Authoritative coverage</div>
                <div className="tile-value">
                  {data.reconciliation.coverage.authoritativeCoveragePct === null
                    ? '—'
                    : `${data.reconciliation.coverage.authoritativeCoveragePct}%`}
                </div>
                <div className="tile-meta">
                  <span>stable id or manually verified</span>
                </div>
              </div>
              <div className="tile">
                <div className="tile-label">Operational coverage</div>
                <div className="tile-value">
                  {data.reconciliation.coverage.operationalCoveragePct === null
                    ? '—'
                    : `${data.reconciliation.coverage.operationalCoveragePct}%`}
                </div>
                <div className="tile-meta">
                  <span>+ deterministic high-confidence name matches</span>
                </div>
              </div>
              {(
                [
                  ['Stable ID matches', data.reconciliation.coverage.matchedExact, 'matched_exact'],
                  [
                    'High-confidence name matches',
                    data.reconciliation.coverage.matchedNameEmbedded,
                    'matched_fallback',
                  ],
                  [
                    'Name fallback candidates',
                    data.reconciliation.coverage.matchedFallback -
                      data.reconciliation.coverage.matchedNameEmbedded,
                    'matched_fallback',
                  ],
                  ['Ambiguous', data.reconciliation.coverage.ambiguous, 'ambiguous'],
                  ['Unmatched', data.reconciliation.coverage.unmatched, 'unmatched'],
                  [
                    'Organic / not applicable',
                    data.reconciliation.coverage.notApplicable,
                    'not_applicable',
                  ],
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

            {data.reconciliation.coverage.eligible ? (
              <>
                <h3 style={{ marginTop: 18 }}>
                  This period ({data.reconciliation.coverage.eligible.from} —{' '}
                  {data.reconciliation.coverage.eligible.to})
                </h3>
                <p className="muted">
                  Three separate numbers, never blended. Campaigns with no delivery in the period
                  are excluded: one that stopped running last quarter is not a current gap.
                </p>
                <div className="tile-grid">
                  {(
                    [
                      [
                        'Campaign coverage',
                        data.reconciliation.coverage.eligible.campaignPct,
                        `${data.reconciliation.coverage.eligible.mappedCampaigns} of ${data.reconciliation.coverage.eligible.eligibleCampaigns} campaigns that delivered`,
                      ],
                      [
                        'Spend coverage',
                        data.reconciliation.coverage.eligible.spendPct,
                        `${formatMetric(data.reconciliation.coverage.eligible.mappedSpend, 'currency', currency)} of ${formatMetric(data.reconciliation.coverage.eligible.totalSpend, 'currency', currency)}`,
                      ],
                      [
                        'Attribution coverage',
                        data.reconciliation.coverage.eligible.installPct,
                        `${data.reconciliation.coverage.eligible.mappedPaidInstalls} of ${data.reconciliation.coverage.eligible.totalPaidInstalls} paid installs (organic excluded)`,
                      ],
                    ] as Array<[string, number | null, string]>
                  ).map(([label, pct, meta]) => (
                    <div className="tile" key={label}>
                      <div className="tile-label">{label}</div>
                      <div className="tile-value">{pct === null ? '—' : `${pct}%`}</div>
                      <div className="tile-meta">
                        <span>{meta}</span>
                      </div>
                    </div>
                  ))}
                  <div className="tile">
                    <div className="tile-label">Ambiguous spend</div>
                    <div className="tile-value">
                      {formatMetric(
                        data.reconciliation.coverage.eligible.ambiguousSpend,
                        'currency',
                        currency,
                      )}
                    </div>
                    <div className="tile-meta">
                      <span>
                        {data.reconciliation.coverage.eligible.ambiguousCampaigns} campaign(s) with
                        more than one candidate
                      </span>
                    </div>
                  </div>
                  <div className="tile">
                    <div className="tile-label">Historical / no delivery</div>
                    <div className="tile-value">
                      {data.reconciliation.coverage.eligible.historicalCampaigns}
                    </div>
                    <div className="tile-meta">
                      <span>excluded from this period</span>
                    </div>
                  </div>
                </div>
              </>
            ) : null}

            {data.reconciliation.ambiguous.length > 0 ? (
              <div className="stack" style={{ marginTop: 18 }}>
                <h3>Resolve ambiguous mappings</h3>
                <p className="muted">
                  MART found more than one candidate and will not pick one. A choice made here is
                  recorded as manually verified: it survives later reconciliation, overrides any
                  computed mapping, and is written to the audit log with who made it and when.
                </p>
                {data.reconciliation.ambiguous.map((mapping) => (
                  <ResolveAmbiguousMapping
                    key={mapping.id}
                    organizationId={organization.id}
                    appId={appId}
                    mapping={{
                      id: mapping.id,
                      sourceName: mapping.source_name,
                      sourceExternalId: mapping.source_external_id,
                      candidates: mapping.candidates,
                      reason:
                        typeof mapping.evidence['reason'] === 'string'
                          ? mapping.evidence['reason']
                          : null,
                    }}
                  />
                ))}
              </div>
            ) : null}

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

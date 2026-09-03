import Link from 'next/link';
import { apiGet } from '../../../../../lib/api';
import { Card, EmptyState, StatusChip } from '../../../../../components/primitives';
import { DecisionPolicyForm, type PolicySnapshot } from '../../../../../components/decisions';
import { formatMetric, signalTone, statusLabel } from '../../../../../lib/format';

type Me = { organizations: Array<{ id: string; name: string; role: string }> };

/** Mirrors the decision contract from @mart/metrics, structurally. */
type Evidence = {
  key: string;
  label: string;
  value: number | null;
  format: 'currency' | 'ratio' | 'percent' | 'integer' | 'decimal';
  availability: string;
  blocker?: string;
  reason?: string;
  numerator?: number | null;
  denominator?: number | null;
  window: { from: string; to: string };
  population: string;
  grain: string;
  comparison?: {
    baselineWindow: { from: string; to: string } | null;
    baseline: number | null;
    changePct: number | null;
    direction: string;
  };
};

type Recommendation = {
  id: string;
  ruleVersion: string;
  scope: {
    kind: 'campaign' | 'app';
    marketingCampaignId: string | null;
    campaignName: string | null;
  };
  signal: string;
  category: string;
  headline: string;
  reason: string;
  window: {
    from: string;
    to: string;
    timezone: string;
    evaluated: { from: string | null; to: string | null; days: number };
    baseline: { from: string; to: string } | null;
  };
  population: { numerator: string; denominator?: string; note: string };
  evidence: Evidence[];
  quality: {
    freshness: {
      marketing: string | null;
      attribution: string | null;
      marketingLatestDate: string | null;
      attributionLatestDate: string | null;
    };
    activeSyncErrors: number;
    findings: Array<{ checkKey: string; severity: string; count: number }>;
    maturity: {
      ageDays: number;
      matureDays: number;
      immatureDays: number;
      uncoveredDays: number;
      earlyReadRows: number;
    } | null;
    mapping: {
      status: string | null;
      method: string | null;
      confidence: number | null;
      operational: boolean;
      ambiguous: boolean;
      attributionCampaignIds: string[];
    };
    currencies: { spend: string[]; revenue: string[] };
    anomalies: Array<{ date: string; metric: string; classification: string }>;
  };
  confidence: {
    level: string;
    score: number;
    components: Array<{ input: string; score: number; detail: string }>;
  };
  blockers: string[];
  lineage: {
    metricKeys: string[];
    factFamilies: string[];
    providers: string[];
    inputsHash: string;
    computedAt: string;
  };
  actions: never[];
};

type Pacing = {
  marketingCampaignId: string;
  campaignName: string | null;
  dailyBudget: number | null;
  budgetSource: string | null;
  budgetCurrency: string | null;
  spend: number;
  deliveredDays: number;
  calendarDays: number;
  averageDailySpend: number | null;
  ratio: number | null;
  status: string;
  lifetime: { budget: number; spentToDate: number; sharePct: number } | null;
  blocker?: string;
  reason: string;
};

type Anomaly = {
  date: string;
  metric: string;
  scope: { kind: string; marketingCampaignId: string | null; campaignName: string | null };
  value: number;
  baselineMedian: number;
  baselinePoints: number;
  robustZ: number | null;
  deviationPct: number | null;
  direction: string;
  classification: string;
  explanation: string;
  dataSignals: string[];
};

type DecisionsPayload = {
  app: { id: string; name: string; default_currency: string; timezone: string };
  sources: { marketing: string | null; attribution: string | null };
  decisions: {
    ruleVersion: string;
    window: { from: string; to: string; timezone: string };
    asOf: string | null;
    policy: PolicySnapshot;
    app: Recommendation;
    campaigns: Recommendation[];
    anomalies: Anomaly[];
    pacing: Pacing[];
    automation: 'none';
  };
};

function SignalChip({ value }: { value: string }) {
  return <span className={`chip ${signalTone(value)}`}>{statusLabel(value)}</span>;
}

function pct(value: number | null): string {
  if (value === null) return '—';
  return `${value > 0 ? '+' : ''}${value.toFixed(1)}%`;
}

function EvidenceTable({ evidence, currency }: { evidence: Evidence[]; currency: string }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Figure</th>
            <th>Value</th>
            <th>State</th>
            <th>Window</th>
            <th>Population · grain</th>
            <th>Why</th>
          </tr>
        </thead>
        <tbody>
          {evidence.map((item) => (
            <tr key={item.key}>
              <td>
                {item.label}
                <div className="cell-note mono">{item.key}</div>
              </td>
              <td className="mono">
                {formatMetric(item.value, item.format, currency)}
                {item.numerator !== undefined && item.numerator !== null ? (
                  <div className="cell-note">
                    {formatMetric(item.numerator, 'decimal')} /{' '}
                    {formatMetric(item.denominator ?? null, 'decimal')}
                  </div>
                ) : null}
                {item.comparison && item.comparison.changePct !== null ? (
                  <div className="cell-note">
                    {pct(item.comparison.changePct)} vs prior{' '}
                    <span className={`chip ${signalTone(item.comparison.direction)}`}>
                      {item.comparison.direction}
                    </span>
                  </div>
                ) : null}
              </td>
              <td>
                <StatusChip status={item.availability} />
                {item.blocker ? <div className="cell-note mono">{item.blocker}</div> : null}
              </td>
              <td className="mono">
                {item.window.from} → {item.window.to}
              </td>
              <td>
                {statusLabel(item.population)}
                <div className="cell-note">{statusLabel(item.grain)}</div>
              </td>
              <td className="muted">{item.reason ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function QualityList({ quality }: { quality: Recommendation['quality'] }) {
  return (
    <ul className="list-reset stack">
      <li>
        <strong>Freshness</strong> · marketing {quality.freshness.marketing ?? 'none'} (
        {quality.freshness.marketingLatestDate ?? '—'}), attribution{' '}
        {quality.freshness.attribution ?? 'none'} ({quality.freshness.attributionLatestDate ?? '—'})
        {quality.activeSyncErrors > 0
          ? `, ${quality.activeSyncErrors} unresolved sync error(s)`
          : ''}
      </li>
      {quality.maturity ? (
        <li>
          <strong>Maturity at D{quality.maturity.ageDays}</strong> · {quality.maturity.matureDays}{' '}
          mature, {quality.maturity.immatureDays} too young, {quality.maturity.uncoveredDays} not
          re-read since maturing
          {quality.maturity.earlyReadRows > 0
            ? `, ${quality.maturity.earlyReadRows} row(s) read before the age`
            : ''}
        </li>
      ) : null}
      <li>
        <strong>Mapping</strong> ·{' '}
        {quality.mapping.status
          ? `${statusLabel(quality.mapping.status)} via ${statusLabel(quality.mapping.method)}${
              quality.mapping.confidence !== null ? ` at ${quality.mapping.confidence}` : ''
            }`
          : 'app-wide mapped population'}
        {quality.mapping.attributionCampaignIds.length > 0
          ? ` → ${quality.mapping.attributionCampaignIds.join(', ')}`
          : ''}
      </li>
      <li>
        <strong>Currencies</strong> · spend {quality.currencies.spend.join(', ') || '—'}, revenue{' '}
        {quality.currencies.revenue.join(', ') || '—'}
      </li>
      {quality.findings.length > 0 ? (
        <li>
          <strong>Findings in window</strong> ·{' '}
          {quality.findings.map((f) => `${f.checkKey} (${f.severity} ×${f.count})`).join(', ')}
        </li>
      ) : null}
      {quality.anomalies.length > 0 ? (
        <li>
          <strong>Anomalies</strong> ·{' '}
          {quality.anomalies.map((a) => `${a.date} ${a.metric}: ${a.classification}`).join(', ')}
        </li>
      ) : null}
    </ul>
  );
}

function RecommendationCard({
  recommendation,
  currency,
  title,
}: {
  recommendation: Recommendation;
  currency: string;
  title: string;
}) {
  const r = recommendation;
  return (
    <Card
      title={title}
      hint={`${r.window.from} → ${r.window.to} · rule ${r.ruleVersion} · evaluated ${
        r.window.evaluated.days
      } mature day(s)${r.window.evaluated.from ? ` (${r.window.evaluated.from} → ${r.window.evaluated.to})` : ''}`}
      actions={
        <span className="inline-meta">
          <SignalChip value={r.signal} />
          <span className="chip chip-neutral">{statusLabel(r.category)}</span>
          <span
            className={`chip ${r.confidence.level === 'high' ? 'chip-good' : r.confidence.level === 'medium' ? 'chip-warning' : 'chip-serious'}`}
          >
            confidence {r.confidence.level} ({r.confidence.score})
          </span>
        </span>
      }
    >
      <div className="stack">
        <h3>{r.headline}</h3>
        <p>{r.reason}</p>
        {r.blockers.length > 0 ? (
          <p className="inline-meta">
            <span>Blockers:</span>
            {r.blockers.map((b) => (
              <span key={b} className="chip chip-serious mono">
                {b}
              </span>
            ))}
          </p>
        ) : null}
        <EvidenceTable evidence={r.evidence} currency={currency} />
        <details>
          <summary className="subsection-title">Quality, confidence and lineage</summary>
          <div className="stack">
            <QualityList quality={r.quality} />
            <ul className="list-reset stack">
              {r.confidence.components.map((c) => (
                <li key={c.input}>
                  <strong>{c.input}</strong> {c.score.toFixed(2)} · {c.detail}
                </li>
              ))}
            </ul>
            <p className="muted">
              Population: {r.population.note} Facts: {r.lineage.factFamilies.join(', ')} from{' '}
              {r.lineage.providers.join(', ') || 'no provider'}. Inputs hash{' '}
              <span className="mono">{r.lineage.inputsHash.slice(0, 16)}</span>, computed{' '}
              {r.lineage.computedAt}.
            </p>
          </div>
        </details>
      </div>
    </Card>
  );
}

export default async function DecisionCenterPage({
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
  for (const key of ['from', 'to']) {
    const value = search[key];
    if (typeof value === 'string' && value.length > 0) query.set(key, value);
  }
  const data = await apiGet<DecisionsPayload>(
    `/api/v1/organizations/${organization.id}/apps/${appId}/decisions${
      query.size > 0 ? `?${query.toString()}` : ''
    }`,
  );
  const { decisions } = data;
  const currency = data.app.default_currency;
  const canEdit = organization.role === 'admin' || organization.role === 'owner';

  return (
    <>
      <header className="page-header">
        <div>
          <h1>{data.app.name} — Decision Center</h1>
          <p>
            Deterministic signals read from stored, trusted figures against the targets below. MART
            recommends and shows its evidence; nothing on this page changes a campaign.
          </p>
        </div>
        <div className="button-row">
          <Link className="nav-item" href={`/apps/${appId}`}>
            Command Center
          </Link>
          <Link className="nav-item" href={`/apps/${appId}/integrations`}>
            Integrations
          </Link>
        </div>
      </header>

      <form className="toolbar" method="get">
        <div className="field">
          <label htmlFor="from">From</label>
          <input id="from" name="from" type="date" defaultValue={decisions.window.from} />
        </div>
        <div className="field">
          <label htmlFor="to">To</label>
          <input id="to" name="to" type="date" defaultValue={decisions.window.to} />
        </div>
        <div className="field">
          <label>Attribution horizon</label>
          <span className="mono">{decisions.asOf ?? 'none'}</span>
        </div>
        <div className="field">
          <label>Automation</label>
          <span className="chip chip-neutral">{decisions.automation}</span>
        </div>
        <button type="submit">Apply</button>
      </form>

      <Card
        title="Targets"
        hint={
          decisions.policy.configured
            ? `Stored targets, last updated ${decisions.policy.updatedAt ?? 'unknown'}. Signals compare against these and nothing else.`
            : 'No targets stored. Figures, trends, pacing and anomalies are reported; scale and reduce are withheld until a target exists.'
        }
      >
        <DecisionPolicyForm
          organizationId={organization.id}
          appId={appId}
          policy={decisions.policy}
          defaultCurrency={currency}
          canEdit={canEdit}
        />
      </Card>

      <RecommendationCard
        recommendation={decisions.app}
        currency={currency}
        title="App · mapped population"
      />

      <Card
        title="Campaigns"
        hint={`${decisions.campaigns.length} campaign(s) delivered in the window, largest spend first. Each reading is independent.`}
      >
        {decisions.campaigns.length === 0 ? (
          <EmptyState
            title="No delivered campaigns"
            message="No marketing campaign delivered inside this window, so there is nothing to read."
          />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Campaign</th>
                  <th>Signal</th>
                  <th>Reading</th>
                  <th>Spend</th>
                  <th>Return</th>
                  <th>CPI</th>
                  <th>Mature days</th>
                  <th>Confidence</th>
                </tr>
              </thead>
              <tbody>
                {decisions.campaigns.map((r) => {
                  const spend = r.evidence.find((e) => e.key === 'spend');
                  const roas = r.evidence.find((e) => e.key.startsWith('cohort_'));
                  const cpi = r.evidence.find((e) => e.key === 'mapped_cpi');
                  return (
                    <tr key={r.id}>
                      <td>
                        {r.scope.campaignName ?? r.scope.marketingCampaignId}
                        <div className="cell-note mono">{r.scope.marketingCampaignId}</div>
                      </td>
                      <td>
                        <SignalChip value={r.signal} />
                        <div className="cell-note">{statusLabel(r.category)}</div>
                      </td>
                      <td>
                        {r.headline}
                        {r.blockers.length > 0 ? (
                          <div className="cell-note mono">{r.blockers.join(', ')}</div>
                        ) : null}
                      </td>
                      <td className="mono">
                        {formatMetric(spend?.value ?? null, 'currency', currency)}
                      </td>
                      <td className="mono">
                        {roas ? formatMetric(roas.value, 'ratio') : '—'}
                        {roas ? <div className="cell-note mono">{roas.key}</div> : null}
                      </td>
                      <td className="mono">
                        {formatMetric(cpi?.value ?? null, 'currency', currency)}
                      </td>
                      <td className="mono">{r.window.evaluated.days}</td>
                      <td>
                        {r.confidence.level} <span className="muted">({r.confidence.score})</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {decisions.campaigns.map((r) => (
        <RecommendationCard
          key={r.id}
          recommendation={r}
          currency={currency}
          title={`Campaign · ${r.scope.campaignName ?? r.scope.marketingCampaignId}`}
        />
      ))}

      <Card
        title="Budget pacing"
        hint="Average spend over delivered days against the daily budget MART last observed. Reported, never acted on."
      >
        {decisions.pacing.length === 0 ? (
          <EmptyState title="Nothing to pace" message="No campaign delivered in this window." />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Campaign</th>
                  <th>Status</th>
                  <th>Daily budget</th>
                  <th>Avg daily spend</th>
                  <th>Pace</th>
                  <th>Days</th>
                  <th>Lifetime</th>
                  <th>Why</th>
                </tr>
              </thead>
              <tbody>
                {decisions.pacing.map((p) => (
                  <tr key={p.marketingCampaignId}>
                    <td>
                      {p.campaignName ?? p.marketingCampaignId}
                      <div className="cell-note mono">{p.marketingCampaignId}</div>
                    </td>
                    <td>
                      <SignalChip value={p.status} />
                      {p.blocker ? <div className="cell-note mono">{p.blocker}</div> : null}
                    </td>
                    <td className="mono">
                      {formatMetric(p.dailyBudget, 'currency', p.budgetCurrency ?? currency)}
                      {p.budgetSource ? (
                        <div className="cell-note">{statusLabel(p.budgetSource)}</div>
                      ) : null}
                    </td>
                    <td className="mono">
                      {formatMetric(p.averageDailySpend, 'currency', currency)}
                    </td>
                    <td className="mono">
                      {p.ratio === null ? '—' : `${Math.round(p.ratio * 100)}%`}
                    </td>
                    <td className="mono">
                      {p.deliveredDays} / {p.calendarDays}
                    </td>
                    <td className="mono">
                      {p.lifetime
                        ? `${p.lifetime.sharePct}% of ${formatMetric(p.lifetime.budget, 'currency', currency)}`
                        : '—'}
                    </td>
                    <td className="muted">{p.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card
        title="Anomalies"
        hint="Days that sit far outside their own 14-day history, classified from the data around them. A data gap or a tracking problem is never presented as performance."
      >
        {decisions.anomalies.length === 0 ? (
          <EmptyState
            title="No anomalous days"
            message="No day in the window moved far enough from its recent history to be called out."
          />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Scope</th>
                  <th>Metric</th>
                  <th>Value</th>
                  <th>Baseline median</th>
                  <th>Move</th>
                  <th>Class</th>
                  <th>Explanation</th>
                </tr>
              </thead>
              <tbody>
                {decisions.anomalies.map((a) => (
                  <tr key={`${a.scope.marketingCampaignId ?? 'app'}-${a.date}-${a.metric}`}>
                    <td className="mono">{a.date}</td>
                    <td>
                      {a.scope.kind === 'app'
                        ? 'App'
                        : (a.scope.campaignName ?? a.scope.marketingCampaignId)}
                    </td>
                    <td>{a.metric}</td>
                    <td className="mono">
                      {formatMetric(
                        a.value,
                        a.metric === 'installs' ? 'integer' : 'currency',
                        currency,
                      )}
                    </td>
                    <td className="mono">
                      {formatMetric(
                        a.baselineMedian,
                        a.metric === 'installs' ? 'integer' : 'currency',
                        currency,
                      )}
                      <div className="cell-note">{a.baselinePoints} days</div>
                    </td>
                    <td className="mono">
                      {a.direction} {pct(a.deviationPct)}
                      {a.robustZ !== null ? <div className="cell-note">z {a.robustZ}</div> : null}
                    </td>
                    <td>
                      <SignalChip value={a.classification} />
                      {a.dataSignals.length > 0 ? (
                        <div className="cell-note mono">{a.dataSignals.join(', ')}</div>
                      ) : null}
                    </td>
                    <td className="muted">{a.explanation}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}

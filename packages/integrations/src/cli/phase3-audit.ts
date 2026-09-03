/**
 * Phase 3 exit audit: decision intelligence.
 *
 *   node packages/integrations/dist/cli/phase3-audit.js <organization_id> <from> <to> [app_id]
 *
 * Phase 2 established that MART's cohort figures are true. Phase 3 asks
 * whether the SIGNALS read from them are honest: that the same stored rows
 * always produce the same recommendation, that nothing in the payload can
 * be mistaken for an action, that every figure a signal rests on can be
 * recomputed from stored rows with independent SQL, that every signal can
 * be re-derived from the audit's own reading of the gates and its own band
 * arithmetic, that anomalies are found by an independent median/MAD and
 * classified from the data around them, and - through controlled changes
 * inside transactions that are always rolled back and verified rolled back -
 * that a target drives scale, reduce and hold on a clean synthetic campaign,
 * and that no target, a stale feed, a second currency, an ambiguous mapping,
 * an immature window, a day nobody re-read, a partial return and a
 * tracking-shaped movement each stop a scale or reduce the way the rules say.
 *
 * Like the earlier audits it derives every figure with its own SQL and its
 * own arithmetic, never by importing the predicates it checks. A criterion
 * this database cannot evaluate is UNPROVEN with the reason, never PASS on
 * the strength of a fixture.
 */
import { closePool, decisionsRepo, getPool, queryRows, toNumber, type Queryable } from '@mart/db';
import {
  DECISION_THRESHOLDS,
  MAXIMUM_AMBIGUOUS_SPEND_PCT,
  MINIMUM_SPEND_COVERAGE_PCT,
  computeMetricValues,
  loadAttributionAggregate,
  loadCohortAggregate,
  loadDecisions,
  loadMarketingAggregate,
  snapshotForProof,
  type Anomaly,
  type DecisionSet,
  type MetricContext,
  type MetricFilters,
  type Recommendation,
} from '@mart/metrics';
import {
  ANOMALY_CLASSIFICATIONS,
  DECISION_BLOCKERS,
  DECISION_CATEGORIES,
  DECISION_RULE_VERSION,
  DECISION_SIGNALS,
  METRIC_BLOCKERS,
  METRIC_GRAINS,
  OPERATIONAL_MAPPING_CONFIDENCE,
  addDays,
  eachDate,
  type IsoDate,
} from '@mart/shared';
import {
  assert,
  compare,
  counts,
  createContext,
  heading,
  line,
  note,
  record,
  type AuditContext,
} from '../audit/report.js';

/**
 * The audit's own copies of the rules it checks. Deliberately not imported
 * from the metric layer: recomputing a figure with the code that produced
 * it proves only that the code is deterministic.
 */
const OPERATIONAL = `(m.status IN ('matched_exact','matched_confident','manually_verified')
  OR (m.status = 'matched_fallback' AND m.mapping_confidence >= ${OPERATIONAL_MAPPING_CONFIDENCE}))`;
const PAID = `COALESCE(t.normalized_media_source, 'organic') <> 'organic'`;
/** One marketing campaign per attribution campaign: its strongest operational link. */
const LINKS = `links AS (
  SELECT DISTINCT ON (m.target_external_id)
         m.target_external_id AS attribution_id, m.source_external_id AS marketing_id
    FROM provider_entity_mappings m
   WHERE m.organization_id = $1 AND m.app_id = $2 AND m.entity_type = 'campaign'
     AND m.source_provider = $3 AND m.target_provider = $4
     AND m.target_external_id IS NOT NULL AND ${OPERATIONAL}
   ORDER BY m.target_external_id, m.mapping_confidence DESC, m.source_external_id)`;
/** The revenue sync read `day` in a run that finished after the cohort reached `age`. */
const COVERED = (alias: string, day: string, age: string): string => `EXISTS (
  SELECT 1 FROM sync_runs r, jsonb_array_elements(COALESCE(r.checkpoint->'dataWindows', '[]'::jsonb)) w
   WHERE r.app_id = ${alias}.app_id AND r.data_type = 'attribution_revenue'
     AND r.status IN ('completed', 'partially_completed')
     AND (w->>'from')::date <= ${day} AND ${day} <= (w->>'to')::date
     AND (r.finished_at AT TIME ZONE a.timezone)::date > (${day} + ${age}::int))`;
/** Findings that describe row labelling or the account, never a day's integrity. */
const NOT_A_DAY_SIGNAL = `(check_key IN ('attribution.missing_campaign_id', 'marketing.missing_campaign_id')
  OR check_key LIKE 'reconciliation.%')`;
const PROOF_CAMPAIGN = 'mart-phase3-proof';
const T = DECISION_THRESHOLDS;
const FRESHNESS_ORDER = ['error', 'stale', 'unknown', 'delayed', 'fresh'];

type Row = Record<string, string | null>;

async function main(): Promise<void> {
  const [organizationId, from, to, appArg] = process.argv.slice(2);
  if (!organizationId || !from || !to) {
    process.stderr.write(
      'usage: phase3-audit <organization_id> <from> <to> [app_id]\n' +
        '  e.g. phase3-audit fe8a8112-... 2026-08-01 2026-08-31\n',
    );
    process.exitCode = 2;
    return;
  }

  const ctx = createContext();
  const apps = await queryRows<{ id: string; name: string; timezone: string }>(
    `SELECT id, name, timezone FROM apps
      WHERE organization_id = $1 ${appArg ? 'AND id = $2' : ''} AND status = 'active'
      ORDER BY name`,
    appArg ? [organizationId, appArg] : [organizationId],
  );
  if (apps.length === 0) {
    process.stderr.write('No active app found for this organization.\n');
    process.exitCode = 2;
    return;
  }

  auditVocabulary(ctx);
  await auditStorage(ctx);

  for (const app of apps) {
    await auditApp(ctx, organizationId, app, from as IsoDate, to as IsoDate);
  }

  heading(ctx, 'PHASE 3 EXIT VERDICT');
  const tally = counts(ctx);
  line('PASS', tally.PASS);
  line('FAIL', tally.FAIL);
  line('UNPROVEN', tally.UNPROVEN);
  line('NOT_IMPLEMENTED', tally.NOT_IMPLEMENTED);

  const failed = ctx.results.filter((r) => r.verdict === 'FAIL');
  const unproven = ctx.results.filter((r) => r.verdict === 'UNPROVEN');
  const missing = ctx.results.filter((r) => r.verdict === 'NOT_IMPLEMENTED');
  if (failed.length > 0) {
    process.stdout.write('\n  FAILING:\n');
    for (const r of failed) process.stdout.write(`    ${r.section} / ${r.metric}: ${r.detail}\n`);
  }
  if (unproven.length > 0) {
    process.stdout.write('\n  UNPROVEN (external action required):\n');
    for (const r of unproven) process.stdout.write(`    ${r.section} / ${r.metric}: ${r.detail}\n`);
  }
  if (missing.length > 0) {
    process.stdout.write('\n  NOT BUILT YET:\n');
    for (const r of missing) process.stdout.write(`    ${r.section} / ${r.metric}: ${r.detail}\n`);
  }
}

// ------------------------------------------------------------ vocabulary ---

function auditVocabulary(ctx: AuditContext): void {
  heading(ctx, 'DECISION VOCABULARY');
  line('signals', DECISION_SIGNALS.join(', '));
  line('categories', DECISION_CATEGORIES.join(', '));
  line('anomaly classes', ANOMALY_CLASSIFICATIONS.join(', '));
  line('rule version', DECISION_RULE_VERSION);
  assert(
    ctx,
    'five signals, exactly',
    [...DECISION_SIGNALS].sort().join(',') ===
      ['scale', 'hold', 'reduce', 'investigate', 'insufficient_data'].sort().join(','),
    DECISION_SIGNALS.join(', '),
  );
  assert(
    ctx,
    'no signal is an action',
    !DECISION_SIGNALS.some((s) => /pause|apply|execute|set_budget|update/.test(s)),
    'a signal is a reading, never a verb the network would understand',
  );
  assert(
    ctx,
    'data quality is its own category',
    DECISION_CATEGORIES.includes('data_quality') && DECISION_CATEGORIES.includes('performance'),
    'a tracking problem and a performance problem cannot wear the same label',
  );
  assert(
    ctx,
    'decision blockers extend metric blockers',
    METRIC_BLOCKERS.every((b) => (DECISION_BLOCKERS as readonly string[]).includes(b)) &&
      (DECISION_BLOCKERS as readonly string[]).includes('no_target'),
    `${DECISION_BLOCKERS.length} blockers, ${METRIC_BLOCKERS.length} inherited`,
  );
  line(
    'floors',
    `${T.minimumMatureDays} days / ${T.minimumSpend} spend / ${T.minimumInstalls} installs`,
  );
  line('band', `±${T.tolerancePct}%`);
  line(
    'anomaly',
    `${T.anomalyBaselineDays}-day baseline, >=${T.anomalyMinimumBaselinePoints} points, z>=${T.anomalyRobustZ}, rel>=${T.anomalyMinimumRelativeDeviation}`,
  );
  assert(
    ctx,
    'floors and bands are positive',
    T.minimumMatureDays > 0 &&
      T.minimumSpend > 0 &&
      T.minimumInstalls > 0 &&
      T.tolerancePct > 0 &&
      T.anomalyMinimumBaselinePoints > 0 &&
      T.anomalyRobustZ > 0,
    'a zero floor would let one install move a signal',
  );
}

async function auditStorage(ctx: AuditContext): Promise<void> {
  heading(ctx, 'POLICY STORAGE AND NO AUTOMATION');
  const columns = await queryRows<Row>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_name = 'decision_policies' ORDER BY ordinal_position`,
  );
  const names = columns.map((c) => String(c['column_name']));
  assert(
    ctx,
    'decision_policies stores targets only',
    ['target_roas_d7', 'target_roas_d1', 'max_cpi', 'currency', 'updated_by_user_id'].every((c) =>
      names.includes(c),
    ) && !names.some((c) => /budget|bid|status|action/.test(c)),
    names.join(', ') || 'table missing - run migrations',
  );
  const unique = await queryRows<Row>(
    `SELECT count(*)::text AS n FROM pg_constraint
      WHERE conrelid = 'decision_policies'::regclass AND contype = 'u'`,
  );
  assert(ctx, 'one policy per app', toNumber(unique[0]?.['n']) >= 1, 'unique constraint on app_id');
  const actionTables = await queryRows<Row>(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
        AND (table_name ~ 'action' OR table_name ~ 'automation' OR table_name ~ 'campaign_change'
             OR table_name ~ 'budget_change' OR table_name ~ 'command')`,
  );
  assert(
    ctx,
    'no table stores a campaign action',
    actionTables.length === 0,
    actionTables.map((t) => String(t['table_name'])).join(', ') || 'nothing to execute from',
  );
}

// ------------------------------------------------------------------ app ---

type Binding = {
  role: string;
  provider_key: string;
  connection_id: string;
  integration_account_id: string | null;
};

function worstOf(statuses: string[]): string | null {
  const applicable = statuses.filter((s) => !['unsupported', 'not_implemented'].includes(s));
  if (applicable.length === 0) return null;
  return FRESHNESS_ORDER.find((s) => applicable.includes(s)) ?? 'unknown';
}

async function buildContext(
  organizationId: string,
  appId: string,
  client?: Queryable,
): Promise<MetricContext> {
  const freshness = await queryRows<Row>(
    `SELECT provider_key, data_type, status, latest_provider_data_date::text AS latest
       FROM data_freshness WHERE organization_id = $1 AND app_id = $2`,
    [organizationId, appId],
    client,
  );
  const pick = (kind: string): { status: string; latestDataDate: string | null } | undefined => {
    const rows = freshness.filter((f) => String(f['data_type']).startsWith(kind));
    const status = worstOf(rows.map((r) => String(r['status'])));
    if (status === null) return undefined;
    const latest =
      rows
        .map((r) => r['latest'])
        .filter((d): d is string => Boolean(d))
        .sort()
        .at(-1) ?? null;
    return { status, latestDataDate: latest };
  };
  const providersFor = (kind: string): string[] => [
    ...new Set(
      freshness
        .filter((f) => String(f['data_type']).startsWith(kind))
        .map((f) => String(f['provider_key'])),
    ),
  ];
  const capabilities = await queryRows<Row>(
    `SELECT DISTINCT ON (b.connection_id, pc.capability_key) pc.capability_key, pc.supported::text AS supported,
            pc.detail::text AS detail
       FROM integration_app_bindings b
       JOIN provider_capabilities pc ON pc.connection_id = b.connection_id
        AND (pc.integration_account_id IS NOT DISTINCT FROM b.integration_account_id OR pc.integration_account_id IS NULL)
      WHERE b.organization_id = $1 AND b.app_id = $2 AND b.status = 'active'
      ORDER BY b.connection_id, pc.capability_key, (pc.integration_account_id IS NOT NULL) DESC, pc.discovered_at DESC`,
    [organizationId, appId],
    client,
  );
  const supported = new Set<string>();
  const capabilityNotes: Record<string, string> = {};
  for (const row of capabilities) {
    const key = String(row['capability_key']);
    if (row['supported'] === 'true') supported.add(key);
    else if (row['detail']) {
      try {
        const detail = JSON.parse(row['detail']) as { action?: unknown };
        if (typeof detail.action === 'string') capabilityNotes[key] = detail.action;
      } catch {
        // Detail is informational.
      }
    }
  }
  const bindings = await queryRows<Row>(
    `SELECT b.role FROM integration_app_bindings b
      WHERE b.organization_id = $1 AND b.app_id = $2 AND b.status = 'active'`,
    [organizationId, appId],
    client,
  );
  return {
    hasMarketingConnection: bindings.some((b) => b['role'] === 'marketing_network'),
    hasAttributionConnection: bindings.some((b) => b['role'] === 'primary_attribution'),
    marketingProviders: providersFor('marketing'),
    attributionProviders: providersFor('attribution'),
    supportedCapabilities: supported,
    capabilityNotes,
    marketingFreshness: pick('marketing'),
    attributionFreshness: pick('attribution'),
  };
}

/** The payload with computedAt removed, for exact comparison. */
function canonical(decisions: DecisionSet): string {
  return JSON.stringify(decisions, (key, value: unknown) =>
    key === 'computedAt' ? undefined : value,
  );
}

function ownMedian(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

type OwnMetric = 'spend' | 'installs' | 'revenue';
type OwnAnomaly = { date: IsoDate; metric: OwnMetric; direction: 'up' | 'down' };
type OwnClassified = OwnAnomaly & { classification: string };

/** The audit's own anomaly detector: median and MAD over the prior days, from scratch. */
function ownDetect(
  series: Array<{ date: IsoDate; value: number }>,
  metric: OwnMetric,
  window: { from: IsoDate; to: IsoDate },
): OwnAnomaly[] {
  const out: OwnAnomaly[] = [];
  const sorted = [...series].sort((a, b) => (a.date < b.date ? -1 : 1));
  for (let i = 0; i < sorted.length; i += 1) {
    const point = sorted[i] as { date: IsoDate; value: number };
    if (point.date < window.from || point.date > window.to) continue;
    const earliest = addDays(point.date, -T.anomalyBaselineDays);
    const baseline = sorted
      .slice(0, i)
      .filter((p) => p.date >= earliest && p.date < point.date)
      .map((p) => p.value);
    if (baseline.length < T.anomalyMinimumBaselinePoints) continue;
    const center = ownMedian(baseline);
    const mad = ownMedian(baseline.map((v) => Math.abs(v - center)));
    const absolute = Math.abs(point.value - center);
    if (absolute < T.anomalyMinimumAbsolute[metric]) continue;
    const relative = center > 0 ? absolute / center : absolute > 0 ? Infinity : 0;
    if (relative < T.anomalyMinimumRelativeDeviation) continue;
    if (mad > 0 && absolute / (1.4826 * mad) < T.anomalyRobustZ) continue;
    out.push({ date: point.date, metric, direction: point.value > center ? 'up' : 'down' });
  }
  return out;
}

function evidenceOf(r: Recommendation, key: string) {
  return r.evidence.find((e) => e.key === key);
}
function roasOf(r: Recommendation | undefined) {
  return r?.evidence.find((e) => e.key.startsWith('cohort_'));
}
function scopeName(r: Recommendation): string {
  return r.scope.kind === 'app' ? 'APP' : String(r.scope.marketingCampaignId);
}

/** Run `fn` inside a transaction that is always rolled back, and verify the rollback. */
async function withRollback<R>(
  appId: string,
  fn: (client: Queryable) => Promise<R>,
): Promise<{ result: R | null; error: string | null; verified: boolean; drift: string[] }> {
  const extra = async (): Promise<Record<string, string>> => {
    const policies = await queryRows<{ n: string; sum: string }>(
      `SELECT count(*)::text AS n, COALESCE(md5(string_agg(id::text || COALESCE(target_roas_d7::text, '') || COALESCE(max_cpi::text, ''), ',' ORDER BY id)), '') AS sum
         FROM decision_policies WHERE app_id = $1`,
      [appId],
    );
    const campaigns = await queryRows<{ n: string; sum: string }>(
      `SELECT count(*)::text AS n, COALESCE(md5(string_agg(id::text || COALESCE(name, ''), ',' ORDER BY id)), '') AS sum
         FROM marketing_campaigns WHERE app_id = $1`,
      [appId],
    );
    const capabilities = await queryRows<{ n: string; sum: string }>(
      `SELECT count(*)::text AS n, COALESCE(md5(string_agg(pc.id::text || pc.supported::text, ',' ORDER BY pc.id)), '') AS sum
         FROM provider_capabilities pc
         JOIN integration_app_bindings b ON b.connection_id = pc.connection_id
        WHERE b.app_id = $1`,
      [appId],
    );
    return {
      decision_policies: `${policies[0]?.n ?? '0'}:${policies[0]?.sum ?? ''}`,
      marketing_campaigns: `${campaigns[0]?.n ?? '0'}:${campaigns[0]?.sum ?? ''}`,
      provider_capabilities: `${capabilities[0]?.n ?? '0'}:${capabilities[0]?.sum ?? ''}`,
    };
  };
  const before: Record<string, string> = {
    ...(await snapshotForProof(appId)),
    ...(await extra()),
  };
  const client = await getPool().connect();
  let result: R | null = null;
  let error: string | null = null;
  try {
    await client.query('BEGIN');
    result = await fn(client);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  } finally {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Releasing discards the transaction anyway; the snapshot decides.
    }
    client.release();
  }
  const after: Record<string, string> = {
    ...(await snapshotForProof(appId)),
    ...(await extra()),
  };
  const drift = Object.keys(before).filter((k) => before[k] !== after[k]);
  return { result, error, verified: drift.length === 0, drift };
}

async function auditApp(
  ctx: AuditContext,
  organizationId: string,
  app: { id: string; name: string; timezone: string },
  from: IsoDate,
  to: IsoDate,
): Promise<void> {
  const appId = app.id;
  process.stdout.write(`\n\n########## ${app.name}   ${from} .. ${to} ##########\n`);

  const bindings = await queryRows<Binding>(
    `SELECT b.role, c.provider_key, c.id AS connection_id, b.integration_account_id
       FROM integration_app_bindings b
       JOIN integration_connections c ON c.id = b.connection_id
      WHERE b.organization_id = $1 AND b.app_id = $2 AND b.status = 'active'
      ORDER BY b.role`,
    [organizationId, appId],
  );
  const marketing = bindings.find((b) => b.role === 'marketing_network') ?? null;
  const attribution = bindings.find((b) => b.role === 'primary_attribution') ?? null;
  const marketingProviderKey = marketing?.provider_key ?? null;
  const attributionProviderKey = attribution?.provider_key ?? null;
  const filters: MetricFilters = {
    organizationId,
    appId,
    from,
    to,
    country: null,
    platform: null,
    marketingProviderKey,
    attributionProviderKey,
    marketingAccountExternalId: null,
  };
  const window = { from, to, timezone: app.timezone };
  const context = await buildContext(organizationId, appId);
  const policy = await decisionsRepo.getDecisionPolicy(organizationId, appId);

  // ------------------------------------------------------------ policy ---
  heading(ctx, 'POLICY');
  line('marketing provider', marketingProviderKey ?? '(none)');
  line('attribution provider', attributionProviderKey ?? '(none)');
  line(
    'targets',
    policy
      ? `D7 ROAS ${policy.target_roas_d7 ?? '-'} · D1 ROAS ${policy.target_roas_d1 ?? '-'} · max CPI ${policy.max_cpi ?? '-'} ${policy.currency ?? ''}`
      : '(none stored)',
  );
  assert(
    ctx,
    'targets are operator-stated, never derived',
    !policy ||
      [policy.target_roas_d7, policy.target_roas_d1, policy.max_cpi].every(
        (v) => v === null || Number(v) > 0,
      ),
    policy
      ? `updated ${new Date(policy.updated_at).toISOString()} by ${policy.updated_by_user_id ?? 'unknown'}`
      : 'no policy row; scale and reduce are impossible for this app',
  );

  // --------------------------------------------------- production path ---
  heading(ctx, 'PRODUCTION PATH');
  const run1 = await loadDecisions({
    filters,
    context,
    window,
    policy,
    now: new Date('2026-01-01T00:00:00Z'),
  });
  const run2 = await loadDecisions({
    filters,
    context,
    window,
    policy,
    now: new Date('2026-01-02T00:00:00Z'),
  });
  line('attribution horizon (asOf)', run1.asOf ?? '(none)');
  line('campaigns read', run1.campaigns.length);
  line('anomalies', run1.anomalies.length);
  line('pacing rows', run1.pacing.length);
  const all = [run1.app, ...run1.campaigns];
  for (const r of all) {
    line(
      `  ${r.scope.kind === 'app' ? 'APP' : (r.scope.campaignName ?? r.scope.marketingCampaignId)}`,
      `${r.signal} / ${r.category} · ${r.headline} · blockers=${r.blockers.join(',') || '-'} · confidence=${r.confidence.level}`,
    );
  }
  for (const a of run1.anomalies) {
    line(
      `  anomaly ${a.date} ${a.scope.kind === 'app' ? 'APP' : (a.scope.campaignName ?? a.scope.marketingCampaignId)}`,
      `${a.metric} ${a.value} vs median ${a.baselineMedian} (${a.deviationPct === null ? 'zero baseline' : `${a.deviationPct.toFixed(0)}%`}, z=${a.robustZ ?? '-'}) -> ${a.classification}${a.dataSignals.length ? ` [${a.dataSignals.join(', ')}]` : ''}`,
    );
  }
  assert(
    ctx,
    'same rows, same recommendation',
    canonical(run1) === canonical(run2),
    `two runs a day apart are identical apart from computedAt (${all.length} recommendation(s))`,
  );
  assert(
    ctx,
    'ids and input hashes are stable',
    run1.app.id === run2.app.id &&
      run1.app.lineage.inputsHash === run2.app.lineage.inputsHash &&
      run1.campaigns.every(
        (c, i) =>
          c.id === run2.campaigns[i]?.id &&
          c.lineage.inputsHash === run2.campaigns[i]?.lineage.inputsHash,
      ),
    `app ${run1.app.id}`,
  );
  assert(
    ctx,
    'no automation in the payload',
    run1.automation === 'none' &&
      all.every((r) => Array.isArray(r.actions) && r.actions.length === 0),
    `automation=${run1.automation}, actions on every recommendation empty`,
  );
  assert(
    ctx,
    'payload speaks the vocabulary',
    run1.ruleVersion === DECISION_RULE_VERSION &&
      all.every(
        (r) =>
          (DECISION_SIGNALS as readonly string[]).includes(r.signal) &&
          (DECISION_CATEGORIES as readonly string[]).includes(r.category) &&
          r.blockers.every((b) => (DECISION_BLOCKERS as readonly string[]).includes(b)),
      ) &&
      run1.anomalies.every((a) =>
        (ANOMALY_CLASSIFICATIONS as readonly string[]).includes(a.classification),
      ),
    'signals, categories, blockers and anomaly classes all from the shared vocabulary',
  );

  // --------------------------------------------------- evidence integrity ---
  heading(ctx, 'EVIDENCE INTEGRITY');
  const grains = new Set<string>([...METRIC_GRAINS, 'mixed']);
  const problems: string[] = [];
  for (const r of all) {
    const name = scopeName(r);
    if (r.evidence.length === 0) problems.push(`${name}: no evidence`);
    if (!r.reason || r.reason.length < 20) problems.push(`${name}: no reason`);
    if (!/^[0-9a-f]{32}$/.test(r.id)) problems.push(`${name}: id`);
    if (!/^[0-9a-f]{64}$/.test(r.lineage.inputsHash)) problems.push(`${name}: hash`);
    if (r.window.from !== from || r.window.to !== to || r.window.timezone !== app.timezone) {
      problems.push(`${name}: window`);
    }
    if (!r.population.numerator) problems.push(`${name}: population`);
    for (const e of r.evidence) {
      if (e.window.from < from || e.window.to > to || e.window.from > e.window.to) {
        problems.push(`${name}/${e.key}: evidence window ${e.window.from}..${e.window.to}`);
      }
      if (!e.population) problems.push(`${name}/${e.key}: population`);
      if (!grains.has(e.grain)) problems.push(`${name}/${e.key}: grain ${e.grain}`);
      if (e.availability !== 'available' && e.availability !== 'partial' && !e.blocker) {
        problems.push(`${name}/${e.key}: ${e.availability} without a blocker`);
      }
      if (e.availability === 'available' && e.value === null) {
        problems.push(`${name}/${e.key}: available without a value`);
      }
    }
    const inputs = r.confidence.components.map((c) => c.input);
    for (const needed of ['freshness', 'sample', 'maturity']) {
      if (!inputs.includes(needed)) problems.push(`${name}: confidence lacks ${needed}`);
    }
    if (r.scope.kind === 'campaign' && !inputs.includes('mapping')) {
      problems.push(`${name}: confidence lacks mapping`);
    }
    if (r.confidence.score < 0 || r.confidence.score > 1)
      problems.push(`${name}: confidence score`);
  }
  assert(
    ctx,
    'every recommendation carries evidence, window, population, quality, confidence, reason',
    problems.length === 0,
    problems.slice(0, 5).join('; ') || `${all.length} recommendation(s) complete`,
  );

  // Scale and reduce only where every hard rule holds, read from the
  // recommendation's own quality state.
  const decisive = all.filter((r) => r.signal === 'scale' || r.signal === 'reduce');
  const decisiveProblems: string[] = [];
  for (const r of decisive) {
    const name = scopeName(r);
    const roas = roasOf(r);
    const cpi = evidenceOf(r, 'mapped_cpi');
    const figure =
      roas?.availability === 'available' || roas?.availability === 'partial' ? roas : cpi;
    if (r.blockers.length > 0) decisiveProblems.push(`${name}: blockers ${r.blockers.join(',')}`);
    if (!r.policy.configured) decisiveProblems.push(`${name}: no policy`);
    if (!['fresh', 'delayed'].includes(r.quality.freshness.marketing ?? '')) {
      decisiveProblems.push(`${name}: marketing ${r.quality.freshness.marketing}`);
    }
    if (!['fresh', 'delayed'].includes(r.quality.freshness.attribution ?? '')) {
      decisiveProblems.push(`${name}: attribution ${r.quality.freshness.attribution}`);
    }
    if (r.quality.activeSyncErrors > 0) decisiveProblems.push(`${name}: sync errors`);
    if (!r.quality.mapping.operational || r.quality.mapping.ambiguous) {
      decisiveProblems.push(`${name}: mapping`);
    }
    if (r.quality.currencies.spend.length > 1 || r.quality.currencies.revenue.length > 1) {
      decisiveProblems.push(`${name}: currencies`);
    }
    if (
      r.quality.findings.some(
        (f) =>
          f.severity === 'error' &&
          (r.scope.kind === 'app' || !f.checkKey.startsWith('reconciliation.')),
      )
    ) {
      decisiveProblems.push(`${name}: findings`);
    }
    if (r.quality.anomalies.some((a) => a.classification !== 'delivery')) {
      decisiveProblems.push(`${name}: anomalies`);
    }
    if (!figure || figure.value === null) decisiveProblems.push(`${name}: no figure`);
    if (figure === roas && (r.quality.maturity?.matureDays ?? 0) < T.minimumMatureDays) {
      decisiveProblems.push(`${name}: ${r.quality.maturity?.matureDays ?? 0} mature days`);
    }
    if (r.signal === 'reduce' && roas?.availability === 'partial') {
      decisiveProblems.push(`${name}: reduce on a partial return`);
    }
    if (figure && (figure.denominator ?? 0) < T.minimumSpend && figure === roas) {
      decisiveProblems.push(`${name}: spend below floor`);
    }
  }
  assert(
    ctx,
    'scale/reduce only on fresh, mapped, mature, single-currency, unflagged data with a target',
    decisiveProblems.length === 0,
    decisiveProblems.slice(0, 5).join('; ') ||
      (decisive.length === 0
        ? 'no scale or reduce issued in this window (nothing to violate)'
        : `${decisive.length} decisive signal(s), every hard rule holds`),
  );

  if (!marketing || !attribution) {
    for (const metric of [
      'spend evidence recomputed',
      'cohort return recomputed',
      'installs and CPI recomputed',
      'signal re-derived from own gates and arithmetic',
      'gate reasons hold against stored rows',
      'anomalies recomputed independently',
      'anomaly classes follow the data around them',
      'pacing recomputed independently',
      'Phase 2 cohort ROAS agrees with the app evidence',
      'no target: no scale, no reduce',
      'target below the return: scale',
      'target above the return: reduce',
      'target met: hold',
      'newest cohorts contradict the window: hold',
      'stale feed: no signal',
      'second currency: investigate, never divide',
      'ambiguous mapping: investigate, never read',
      'immature window: no signal',
      'day nobody re-read: not a day that earned nothing',
      'partial return: scale above, never reduce below',
      'partial return below target never reduces',
      'tracking-shaped movement is never performance',
      'sync error over the same movement is a data gap',
    ]) {
      record(ctx, metric, 'UNPROVEN', 'needs both a marketing and an attribution binding');
    }
    return;
  }
  const mp = marketingProviderKey as string;
  const ap = attributionProviderKey as string;

  // ---------------------------------------------- independent recompute ---
  heading(ctx, 'INDEPENDENT RECOMPUTE');
  const readingAge = (r: Recommendation): number => {
    const roas = roasOf(r);
    const match = roas ? /_d(\d)$/.exec(roas.key) : null;
    return match ? Number(match[1]) : 7;
  };
  const revenueTypeOf = (r: Recommendation): 'iap' | 'ad' | 'total' => {
    const roas = roasOf(r);
    if (!roas) return 'total';
    if (roas.key.startsWith('cohort_iap_')) return 'iap';
    if (roas.key.startsWith('cohort_ad_')) return 'ad';
    return 'total';
  };

  type MatureDay = { day: IsoDate; spend: number; installs: number; revenue: number };
  type Own = {
    spend: number;
    installs: number;
    settledSpend: number;
    settledInstalls: number;
    matureDays: MatureDay[];
    matureSpend: number;
    matureInstalls: number;
    matureRevenue: number;
    spendCurrencies: string[];
    revenueCurrencies: string[];
  };
  const parseArray = (value: string | null | undefined): string[] =>
    (value ?? '{}').replace(/[{}"]/g, '').split(',').filter(Boolean).sort();
  const ownFigures = async (
    campaignId: string | null,
    age: number,
    revenueType: 'iap' | 'ad' | 'total',
  ): Promise<Own> => {
    const asOf = run1.asOf;
    // Every statement binds exactly the parameters it references: PostgreSQL
    // rejects a bind with more parameters than the statement declares.
    const spend = campaignId
      ? await queryRows<Row>(
          `SELECT COALESCE(SUM(md.spend), 0)::text AS spend,
                  COALESCE(array_agg(DISTINCT md.currency) FILTER (WHERE md.spend > 0), '{}')::text AS currencies
             FROM marketing_daily_metrics md
            WHERE md.organization_id = $1 AND md.app_id = $2 AND md.provider_key = $3
              AND md.report_date BETWEEN $4 AND $5 AND md.external_campaign_id = $6`,
          [organizationId, appId, mp, from, to, campaignId],
        )
      : await queryRows<Row>(
          `WITH ${LINKS}
           SELECT COALESCE(SUM(md.spend), 0)::text AS spend,
                  COALESCE(array_agg(DISTINCT md.currency) FILTER (WHERE md.spend > 0), '{}')::text AS currencies
             FROM marketing_daily_metrics md
            WHERE md.organization_id = $1 AND md.app_id = $2 AND md.provider_key = $3
              AND md.report_date BETWEEN $5 AND $6
              AND md.external_campaign_id IN (SELECT marketing_id FROM links)`,
          [organizationId, appId, mp, ap, from, to],
        );
    const scopeLink = campaignId ? 'AND l.marketing_id = $8' : '';
    const scopeSpend = campaignId
      ? 'AND md.external_campaign_id = $8'
      : 'AND md.external_campaign_id IN (SELECT marketing_id FROM links)';
    const scoped: unknown[] = [organizationId, appId, mp, ap, from, to, asOf];
    if (campaignId) scoped.push(campaignId);
    const installs = await queryRows<Row>(
      `WITH ${LINKS}
       SELECT COALESCE(SUM(t.attributed_installs), 0)::text AS installs
         FROM attribution_daily_metrics t JOIN links l ON l.attribution_id = t.external_campaign_id
        WHERE t.organization_id = $1 AND t.app_id = $2 AND t.provider_key = $4 AND ${PAID}
          AND t.install_date BETWEEN $5 AND LEAST($6::date, COALESCE($7::date, $6::date))
          ${scopeLink}`,
      scoped,
    );
    // Delivered days the attribution horizon has passed, with their mapped installs.
    const settled = await queryRows<Row>(
      `WITH ${LINKS},
       days AS (
         SELECT md.report_date AS day, SUM(md.spend) AS spend
           FROM marketing_daily_metrics md
          WHERE md.organization_id = $1 AND md.app_id = $2 AND md.provider_key = $3
            AND md.report_date BETWEEN $5 AND $6 ${scopeSpend}
            AND $7::date IS NOT NULL AND md.report_date < $7::date
          GROUP BY md.report_date HAVING SUM(md.spend) > 0
       )
       SELECT COALESCE(SUM(d.spend), 0)::text AS spend,
              COALESCE((SELECT SUM(t.attributed_installs) FROM attribution_daily_metrics t
                          JOIN links l ON l.attribution_id = t.external_campaign_id
                         WHERE t.organization_id = $1 AND t.app_id = $2 AND t.provider_key = $4
                           AND ${PAID} AND t.install_date IN (SELECT day FROM days)
                           ${scopeLink}), 0)::text AS installs
         FROM days d`,
      scoped,
    );
    // Mature delivered days: old enough at the horizon and re-read by the
    // revenue sync since; per day, their spend, mapped installs and cohort
    // revenue at the age.
    const matureScopeLink = campaignId ? 'AND l.marketing_id = $10' : '';
    const matureScopeSpend = campaignId
      ? 'AND md.external_campaign_id = $10'
      : 'AND md.external_campaign_id IN (SELECT marketing_id FROM links)';
    const matureParams: unknown[] = [
      organizationId,
      appId,
      mp,
      ap,
      from,
      to,
      age,
      asOf,
      revenueType,
    ];
    if (campaignId) matureParams.push(campaignId);
    const mature = await queryRows<Row>(
      `WITH ${LINKS},
       days AS (
         SELECT md.report_date AS day, SUM(md.spend) AS spend
           FROM marketing_daily_metrics md JOIN apps a ON a.id = md.app_id
          WHERE md.organization_id = $1 AND md.app_id = $2 AND md.provider_key = $3
            AND md.report_date BETWEEN $5 AND $6 ${matureScopeSpend}
            AND $8::date IS NOT NULL AND (md.report_date + $7::int) < $8::date
            AND ${COVERED('md', 'md.report_date', '$7')}
          GROUP BY md.report_date HAVING SUM(md.spend) > 0
       ),
       installs AS (
         SELECT t.install_date AS day, SUM(t.attributed_installs) AS installs
           FROM attribution_daily_metrics t
           JOIN links l ON l.attribution_id = t.external_campaign_id
          WHERE t.organization_id = $1 AND t.app_id = $2 AND t.provider_key = $4
            AND ${PAID} AND t.install_date IN (SELECT day FROM days) ${matureScopeLink}
          GROUP BY t.install_date
       ),
       revenue AS (
         SELECT t.activity_date AS day, SUM(t.revenue) AS revenue,
                array_agg(DISTINCT t.currency) AS currencies
           FROM attribution_revenue_metrics t
           JOIN apps a ON a.id = t.app_id
           JOIN links l ON l.attribution_id = t.external_campaign_id
          WHERE t.organization_id = $1 AND t.app_id = $2 AND t.provider_key = $4
            AND t.grain = 'cohort_date' AND t.cohort_age_days = $7
            AND ${PAID} AND t.activity_date IN (SELECT day FROM days) ${matureScopeLink}
            AND ($9::text = 'total' OR t.revenue_type = $9)
            AND (t.revenue_type <> 'total' OR NOT EXISTS (
                  SELECT 1 FROM attribution_revenue_metrics c
                   WHERE c.connection_id = t.connection_id AND c.app_id = t.app_id
                     AND c.grain = 'cohort_date' AND c.cohort_age_days = t.cohort_age_days
                     AND c.activity_date = t.activity_date AND c.revenue_type IN ('iap','ad')
                     AND c.media_source IS NOT DISTINCT FROM t.media_source
                     AND c.external_campaign_id IS NOT DISTINCT FROM t.external_campaign_id
                     AND c.country IS NOT DISTINCT FROM t.country
                     AND c.platform = t.platform AND c.currency = t.currency))
            AND (t.activity_date + t.cohort_age_days) < $8::date
            AND (t.observed_at AT TIME ZONE a.timezone)::date > (t.activity_date + t.cohort_age_days)
            AND ${COVERED('t', 't.activity_date', 't.cohort_age_days')}
          GROUP BY t.activity_date
       )
       SELECT d.day::text AS day, d.spend::text AS spend,
              COALESCE(i.installs, 0)::text AS installs,
              COALESCE(r.revenue, 0)::text AS revenue,
              COALESCE(r.currencies, '{}')::text AS currencies
         FROM days d
         LEFT JOIN installs i ON i.day = d.day
         LEFT JOIN revenue r ON r.day = d.day
        ORDER BY d.day`,
      matureParams,
    );
    const matureDays: MatureDay[] = mature.map((r) => ({
      day: String(r['day']),
      spend: toNumber(r['spend']),
      installs: toNumber(r['installs']),
      revenue: toNumber(r['revenue']),
    }));
    return {
      spend: toNumber(spend[0]?.['spend']),
      installs: toNumber(installs[0]?.['installs']),
      settledSpend: toNumber(settled[0]?.['spend']),
      settledInstalls: toNumber(settled[0]?.['installs']),
      matureDays,
      matureSpend: matureDays.reduce((acc, d) => acc + d.spend, 0),
      matureInstalls: matureDays.reduce((acc, d) => acc + d.installs, 0),
      matureRevenue: matureDays.reduce((acc, d) => acc + d.revenue, 0),
      spendCurrencies: parseArray(spend[0]?.['currencies']),
      revenueCurrencies: [...new Set(mature.flatMap((r) => parseArray(r['currencies'])))].sort(),
    };
  };

  // The audit's own reading of the app's data state, shared by every scope.
  const freshnessRows = await queryRows<Row>(
    `SELECT provider_key, data_type, status, latest_provider_data_date::text AS latest
       FROM data_freshness WHERE app_id = $1`,
    [appId],
  );
  const ownMarketingStatus = worstOf(
    freshnessRows
      .filter((r) => String(r['data_type']).startsWith('marketing') && r['provider_key'] === mp)
      .map((r) => String(r['status'])),
  );
  const ownAttributionStatus = worstOf(
    freshnessRows
      .filter(
        (r) =>
          ['attribution_installs', 'attribution_revenue'].includes(String(r['data_type'])) &&
          r['provider_key'] === ap,
      )
      .map((r) => String(r['status'])),
  );
  const ownLatest = (dataType: string): string | null =>
    freshnessRows
      .filter((r) => r['data_type'] === dataType && r['provider_key'] === ap)
      .map((r) => r['latest'])
      .filter((d): d is string => Boolean(d))
      .sort()
      .at(-1) ?? null;
  const ownInstallsLatest = ownLatest('attribution_installs');
  const ownRevenueLatest = ownLatest('attribution_revenue');
  const ownAsOf =
    ownInstallsLatest && ownRevenueLatest
      ? ownInstallsLatest < ownRevenueLatest
        ? ownInstallsLatest
        : ownRevenueLatest
      : null;
  const ownErrors = toNumber(
    (
      await queryRows<Row>(
        `SELECT count(*)::text AS n FROM sync_errors e JOIN sync_runs r ON r.id = e.sync_run_id
          WHERE r.app_id = $1 AND e.resolved_at IS NULL`,
        [appId],
      )
    )[0]?.['n'],
  );
  const ownErrorFindings = await queryRows<Row>(
    `SELECT check_key FROM data_quality_findings
      WHERE app_id = $1 AND severity = 'error'
        AND (observed_date IS NULL OR observed_date BETWEEN $2 AND $3)`,
    [appId, from, to],
  );
  assert(
    ctx,
    'attribution horizon recomputed',
    run1.asOf === ownAsOf,
    `own ${ownAsOf ?? 'none'} (earlier of installs ${ownInstallsLatest ?? 'none'} and revenue ${ownRevenueLatest ?? 'none'}), reported ${run1.asOf ?? 'none'}`,
  );

  // Anomalies, from the audit's own series and detector, classified by the
  // audit's own reading of the data around each day.
  const loadedFrom = addDays(from, -T.anomalyBaselineDays);
  const horizonOf = (dataType: string): string | null =>
    freshnessRows
      .filter((r) => r['data_type'] === dataType)
      .map((r) => r['latest'])
      .filter((d): d is string => Boolean(d))
      .sort()
      .at(-1) ?? null;
  const ownSeries = async (
    campaignId: string | null,
  ): Promise<Record<OwnMetric, Array<{ date: IsoDate; value: number }>>> => {
    const spendRows = await queryRows<Row>(
      `SELECT report_date::text AS date, SUM(spend)::text AS value FROM marketing_daily_metrics
        WHERE app_id = $1 AND provider_key = $2 AND report_date BETWEEN $3 AND $4
          ${campaignId ? 'AND external_campaign_id = $5' : ''}
        GROUP BY report_date`,
      campaignId ? [appId, mp, loadedFrom, to, campaignId] : [appId, mp, loadedFrom, to],
    );
    const installRows = await queryRows<Row>(
      campaignId
        ? `WITH ${LINKS}
           SELECT t.install_date::text AS date, SUM(t.attributed_installs)::text AS value
             FROM attribution_daily_metrics t JOIN links l ON l.attribution_id = t.external_campaign_id
            WHERE t.organization_id = $1 AND t.app_id = $2 AND t.provider_key = $4 AND ${PAID}
              AND t.install_date BETWEEN $5 AND $6 AND l.marketing_id = $7
            GROUP BY t.install_date`
        : `SELECT install_date::text AS date, SUM(attributed_installs)::text AS value
             FROM attribution_daily_metrics
            WHERE app_id = $1 AND provider_key = $2 AND install_date BETWEEN $3 AND $4
            GROUP BY install_date`,
      campaignId
        ? [organizationId, appId, mp, ap, loadedFrom, to, campaignId]
        : [appId, ap, loadedFrom, to],
    );
    const revenueRows = await queryRows<Row>(
      campaignId
        ? `WITH ${LINKS}
           SELECT t.activity_date::text AS date, SUM(t.revenue)::text AS value
             FROM attribution_revenue_metrics t JOIN links l ON l.attribution_id = t.external_campaign_id
            WHERE t.organization_id = $1 AND t.app_id = $2 AND t.provider_key = $4 AND ${PAID}
              AND t.grain = 'event_date' AND t.activity_date BETWEEN $5 AND $6 AND l.marketing_id = $7
            GROUP BY t.activity_date`
        : `SELECT activity_date::text AS date, SUM(revenue)::text AS value
             FROM attribution_revenue_metrics
            WHERE app_id = $1 AND provider_key = $2 AND grain = 'event_date'
              AND activity_date BETWEEN $3 AND $4
            GROUP BY activity_date`,
      campaignId
        ? [organizationId, appId, mp, ap, loadedFrom, to, campaignId]
        : [appId, ap, loadedFrom, to],
    );
    const dense = (
      rows: Row[],
      streamHorizon: string | null,
      first: string | undefined,
    ): Array<{ date: IsoDate; value: number }> => {
      if (!streamHorizon || !first) return [];
      const byDate = new Map(rows.map((r) => [String(r['date']), toNumber(r['value'])] as const));
      return eachDate(loadedFrom, to)
        .filter((d) => d >= first && d <= streamHorizon)
        .map((date) => ({ date, value: byDate.get(date) ?? 0 }));
    };
    const activity = [...spendRows, ...installRows]
      .filter((r) => toNumber(r['value']) > 0)
      .map((r) => String(r['date']))
      .sort();
    const first = campaignId ? activity[0] : [...spendRows.map((r) => String(r['date']))].sort()[0];
    const firstInstalls = campaignId
      ? first
      : [...installRows.map((r) => String(r['date']))].sort()[0];
    const firstRevenue = campaignId
      ? first
      : [...revenueRows.map((r) => String(r['date']))].sort()[0];
    return {
      spend: dense(spendRows, horizonOf('marketing_performance'), first),
      installs: dense(installRows, horizonOf('attribution_installs'), firstInstalls),
      revenue: dense(revenueRows, horizonOf('attribution_revenue'), firstRevenue),
    };
  };
  const ownDaySignals = async (
    date: IsoDate,
  ): Promise<{ syncError: boolean; uncovered: boolean; finding: boolean }> => {
    const errors = await queryRows<Row>(
      `SELECT count(*)::text AS n FROM sync_errors e JOIN sync_runs r ON r.id = e.sync_run_id
        WHERE r.app_id = $1 AND e.resolved_at IS NULL
          AND (e.window_start IS NULL OR e.window_start <= $2::date)
          AND (e.window_end IS NULL OR e.window_end >= $2::date)`,
      [appId, date],
    );
    const covered = await queryRows<Row>(
      `SELECT count(*)::text AS n FROM sync_runs r
        WHERE r.app_id = $1 AND r.data_type = 'attribution_installs'
          AND r.status IN ('completed', 'partially_completed')
          AND (
            (r.status = 'completed' AND r.window_start <= $2::date AND r.window_end >= $2::date)
            OR EXISTS (
              SELECT 1 FROM jsonb_array_elements_text(COALESCE(r.checkpoint->'completedWindows', '[]'::jsonb)) k
               WHERE split_part(k, '..', 1)::date <= $2::date AND split_part(k, '..', 2)::date >= $2::date))`,
      [appId, date],
    );
    const findings = await queryRows<Row>(
      `SELECT count(*)::text AS n FROM data_quality_findings
        WHERE app_id = $1 AND observed_date = $2::date AND severity <> 'info'
          AND NOT ${NOT_A_DAY_SIGNAL}`,
      [appId, date],
    );
    return {
      syncError: toNumber(errors[0]?.['n']) > 0,
      uncovered: toNumber(covered[0]?.['n']) === 0,
      finding: toNumber(findings[0]?.['n']) > 0,
    };
  };
  const ownAnomaliesFor = async (campaignId: string | null): Promise<OwnClassified[]> => {
    const series = await ownSeries(campaignId);
    const found: OwnAnomaly[] = [];
    for (const metric of ['spend', 'installs', 'revenue'] as const) {
      found.push(...ownDetect(series[metric], metric, { from, to }));
    }
    const attributionCurrent = ['fresh', 'delayed'].includes(ownAttributionStatus ?? '');
    const classify = async (a: OwnAnomaly): Promise<string> => {
      const signals = await ownDaySignals(a.date);
      if (a.metric === 'spend') return 'delivery';
      if (signals.syncError || signals.uncovered) return 'data_gap';
      const sameSpend = found.some(
        (b) => b.metric === 'spend' && b.date === a.date && b.direction === a.direction,
      );
      if (a.metric === 'installs') {
        if (sameSpend) return 'delivery';
        if (signals.finding || !attributionCurrent) return 'attribution';
        return 'undetermined';
      }
      const sameInstalls = found.find(
        (b) => b.metric === 'installs' && b.date === a.date && b.direction === a.direction,
      );
      if (sameInstalls) return classify(sameInstalls);
      return signals.finding ? 'attribution' : 'monetization';
    };
    const classified: OwnClassified[] = [];
    for (const a of found) classified.push({ ...a, classification: await classify(a) });
    return classified;
  };

  let spendChecked = 0;
  let returnChecked = 0;
  let cpiChecked = 0;
  const signalProblems: string[] = [];
  const gateProblems: string[] = [];
  const gateChecked = new Set<string>();
  const ownAnomalies = new Map<string, OwnClassified[]>();
  const capabilities = context.supportedCapabilities;
  const target7 = policy?.target_roas_d7 != null ? Number(policy.target_roas_d7) : null;
  const target1 = policy?.target_roas_d1 != null ? Number(policy.target_roas_d1) : null;
  const maxCpi = policy?.max_cpi != null ? Number(policy.max_cpi) : null;
  const ownMeasure = (): { age: number; type: 'iap' | 'ad' | 'total'; target: number } | null => {
    for (const [age, target] of [
      [7, target7],
      [1, target1],
    ] as Array<[number, number | null]>) {
      if (target === null) continue;
      if (capabilities.has(`cohort_total_revenue_d${age}`)) return { age, type: 'total', target };
      const component = (['iap', 'ad'] as const).find((t) =>
        capabilities.has(`cohort_${t}_revenue_d${age}`),
      );
      if (component) return { age, type: component, target };
    }
    return null;
  };
  const band = (target: number) => ({
    upper: target * (1 + T.tolerancePct / 100),
    lower: target * (1 - T.tolerancePct / 100),
  });

  type Expected = { signal: string; category: string; blocker: string | null };
  const ownSignal = async (
    r: Recommendation,
    own: Own,
    anomalies: OwnClassified[],
  ): Promise<Expected> => {
    if (r.scope.kind === 'campaign') {
      const mapping = await queryRows<Row>(
        `SELECT count(*) FILTER (WHERE m.target_external_id IS NOT NULL AND ${OPERATIONAL})::text AS operational,
                count(*) FILTER (WHERE m.status = 'ambiguous')::text AS ambiguous
           FROM provider_entity_mappings m
          WHERE m.organization_id = $1 AND m.app_id = $2 AND m.entity_type = 'campaign'
            AND m.source_provider = $3 AND m.target_provider = $4 AND m.source_external_id = $5`,
        [organizationId, appId, mp, ap, r.scope.marketingCampaignId],
      );
      if (toNumber(mapping[0]?.['operational']) === 0) {
        return toNumber(mapping[0]?.['ambiguous']) > 0
          ? { signal: 'investigate', category: 'coverage', blocker: 'ambiguous_mapping' }
          : {
              signal: 'insufficient_data',
              category: 'coverage',
              blocker: 'insufficient_coverage',
            };
      }
    } else {
      const coverage = await queryRows<Row>(
        `WITH ${LINKS},
         delivered AS (
           SELECT md.external_campaign_id AS cid, SUM(md.spend) AS spend
             FROM marketing_daily_metrics md
            WHERE md.organization_id = $1 AND md.app_id = $2 AND md.provider_key = $3
              AND md.report_date BETWEEN $5 AND $6 AND md.external_campaign_id IS NOT NULL
            GROUP BY md.external_campaign_id
         )
         SELECT COALESCE(SUM(d.spend), 0)::text AS total,
                COALESCE(SUM(d.spend) FILTER (WHERE d.cid IN (SELECT marketing_id FROM links)), 0)::text AS mapped,
                COALESCE(SUM(d.spend) FILTER (WHERE d.cid NOT IN (SELECT marketing_id FROM links)
                  AND EXISTS (SELECT 1 FROM provider_entity_mappings m
                               WHERE m.organization_id = $1 AND m.app_id = $2 AND m.entity_type = 'campaign'
                                 AND m.source_provider = $3 AND m.source_external_id = d.cid
                                 AND m.status = 'ambiguous')), 0)::text AS ambiguous
           FROM delivered d`,
        [organizationId, appId, mp, ap, from, to],
      );
      const total = toNumber(coverage[0]?.['total']);
      const mapped = toNumber(coverage[0]?.['mapped']);
      const ambiguous = toNumber(coverage[0]?.['ambiguous']);
      if (total > 0 && (mapped / total) * 100 < MINIMUM_SPEND_COVERAGE_PCT) {
        return {
          signal: 'insufficient_data',
          category: 'coverage',
          blocker: 'insufficient_coverage',
        };
      }
      if (total > 0 && (ambiguous / total) * 100 > MAXIMUM_AMBIGUOUS_SPEND_PCT) {
        return { signal: 'investigate', category: 'coverage', blocker: 'ambiguous_mapping' };
      }
    }
    const worst = worstOf([ownMarketingStatus ?? 'unknown', ownAttributionStatus ?? 'unknown']);
    if (worst === 'error' || ownErrors > 0) {
      return { signal: 'investigate', category: 'data_quality', blocker: 'provider_stale' };
    }
    if (
      ownMarketingStatus === null ||
      ownAttributionStatus === null ||
      worst === 'stale' ||
      worst === 'unknown' ||
      ownAsOf === null
    ) {
      return { signal: 'insufficient_data', category: 'data_quality', blocker: 'provider_stale' };
    }
    const spendCurrency = own.spendCurrencies[0];
    const revenueCurrency = own.revenueCurrencies[0];
    if (
      own.spendCurrencies.length > 1 ||
      own.revenueCurrencies.length > 1 ||
      (spendCurrency && revenueCurrency && spendCurrency !== revenueCurrency)
    ) {
      return { signal: 'investigate', category: 'data_quality', blocker: 'mixed_currency' };
    }
    const findings = ownErrorFindings.filter(
      (f) => r.scope.kind === 'app' || !String(f['check_key']).startsWith('reconciliation.'),
    );
    if (findings.length > 0) {
      return { signal: 'investigate', category: 'data_quality', blocker: 'data_quality_finding' };
    }
    if (
      anomalies.some((a) => a.classification === 'data_gap' || a.classification === 'attribution')
    ) {
      return { signal: 'investigate', category: 'data_quality', blocker: 'anomalous_data' };
    }
    if (
      anomalies.some(
        (a) => a.classification === 'undetermined' || a.classification === 'monetization',
      )
    ) {
      return { signal: 'investigate', category: 'undetermined', blocker: 'anomalous_data' };
    }
    const measure = ownMeasure();
    if (!measure) {
      if (maxCpi !== null) {
        if (policy?.currency && spendCurrency && policy.currency !== spendCurrency) {
          return { signal: 'hold', category: 'data_quality', blocker: 'mixed_currency' };
        }
        if (own.settledSpend < T.minimumSpend || own.settledInstalls < T.minimumInstalls) {
          return {
            signal: 'insufficient_data',
            category: 'coverage',
            blocker: 'missing_denominator',
          };
        }
        const value = own.settledSpend / own.settledInstalls;
        const { upper, lower } = band(maxCpi);
        return value <= lower
          ? { signal: 'scale', category: 'performance', blocker: null }
          : value >= upper
            ? { signal: 'reduce', category: 'performance', blocker: null }
            : { signal: 'hold', category: 'performance', blocker: null };
      }
      if (target7 !== null || target1 !== null) {
        return { signal: 'hold', category: 'undetermined', blocker: 'unsupported_metric' };
      }
      return { signal: 'hold', category: 'undetermined', blocker: 'no_target' };
    }
    // The figures above were computed for the reported age and type; if the
    // audit's own choice differs, recompute on its own measure.
    const figures =
      measure.age === readingAge(r) && measure.type === revenueTypeOf(r)
        ? own
        : await ownFigures(r.scope.marketingCampaignId, measure.age, measure.type);
    if (figures.matureDays.length === 0) {
      const uncovered =
        r.scope.kind === 'campaign'
          ? await queryRows<Row>(
              `SELECT count(*)::text AS n FROM marketing_daily_metrics md JOIN apps a ON a.id = md.app_id
                WHERE md.organization_id = $1 AND md.app_id = $2 AND md.provider_key = $3
                  AND md.report_date BETWEEN $4 AND $5 AND md.spend > 0
                  AND md.external_campaign_id = $8
                  AND (md.report_date + $6::int) < $7::date
                  AND NOT ${COVERED('md', 'md.report_date', '$6')}`,
              [
                organizationId,
                appId,
                mp,
                from,
                to,
                measure.age,
                ownAsOf,
                r.scope.marketingCampaignId,
              ],
            )
          : await queryRows<Row>(
              `WITH ${LINKS}
               SELECT count(*)::text AS n FROM marketing_daily_metrics md JOIN apps a ON a.id = md.app_id
                WHERE md.organization_id = $1 AND md.app_id = $2 AND md.provider_key = $3
                  AND md.report_date BETWEEN $5 AND $6 AND md.spend > 0
                  AND md.external_campaign_id IN (SELECT marketing_id FROM links)
                  AND (md.report_date + $7::int) < $8::date
                  AND NOT ${COVERED('md', 'md.report_date', '$7')}`,
              [organizationId, appId, mp, ap, from, to, measure.age, ownAsOf],
            );
      return toNumber(uncovered[0]?.['n']) > 0
        ? { signal: 'insufficient_data', category: 'data_quality', blocker: 'provider_stale' }
        : { signal: 'insufficient_data', category: 'coverage', blocker: 'immature_cohort' };
    }
    const floors =
      figures.matureDays.length >= T.minimumMatureDays &&
      figures.matureSpend >= T.minimumSpend &&
      figures.matureInstalls >= T.minimumInstalls;
    if (!floors) {
      return {
        signal: 'insufficient_data',
        category: 'coverage',
        blocker:
          figures.matureDays.length < T.minimumMatureDays
            ? 'immature_cohort'
            : 'missing_denominator',
      };
    }
    const ratio = figures.matureRevenue / figures.matureSpend;
    const partial = measure.type !== 'total';
    const { upper, lower } = band(measure.target);
    // Own trend: the newest seven mature days against the seven before.
    const half = (slice: MatureDay[]): number | null => {
      const s = slice.reduce((acc, d) => acc + d.spend, 0);
      const i = slice.reduce((acc, d) => acc + d.installs, 0);
      const v = slice.reduce((acc, d) => acc + d.revenue, 0);
      return slice.length >= T.minimumMatureDays &&
        s >= T.minimumSpend &&
        i >= T.minimumInstalls &&
        s > 0
        ? v / s
        : null;
    };
    const days = figures.matureDays;
    const current = half(days.slice(-T.trendWindowDays));
    const prior = half(days.slice(-2 * T.trendWindowDays, -T.trendWindowDays));
    const change =
      current !== null && prior !== null && prior > 0 ? ((current - prior) / prior) * 100 : null;
    const deteriorating = change !== null && change <= -T.trendMaterialChangePct;
    const improving = change !== null && change >= T.trendMaterialChangePct;
    if (ratio >= upper) {
      return deteriorating
        ? { signal: 'hold', category: 'performance', blocker: 'trend_contradicts' }
        : { signal: 'scale', category: 'performance', blocker: null };
    }
    if (ratio <= lower) {
      if (partial) return { signal: 'hold', category: 'performance', blocker: 'partial_return' };
      return improving
        ? { signal: 'hold', category: 'performance', blocker: 'trend_contradicts' }
        : { signal: 'reduce', category: 'performance', blocker: null };
    }
    return { signal: 'hold', category: 'performance', blocker: null };
  };

  for (const r of all) {
    const name = scopeName(r);
    const own = await ownFigures(r.scope.marketingCampaignId, readingAge(r), revenueTypeOf(r));
    const anomalies = await ownAnomaliesFor(r.scope.marketingCampaignId);
    ownAnomalies.set(name, anomalies);

    const spend = evidenceOf(r, 'spend');
    if (spend) {
      compare(ctx, `${name} spend`, own.spend, spend.value);
      spendChecked += 1;
    }
    const installs = evidenceOf(r, 'mapped_paid_installs');
    if (installs && installs.availability === 'available') {
      compare(ctx, `${name} mapped installs`, own.installs, installs.value);
    }
    const cpi = evidenceOf(r, 'mapped_cpi');
    if (cpi) {
      compare(ctx, `${name} CPI numerator`, own.settledSpend, cpi.numerator ?? null);
      compare(ctx, `${name} CPI denominator`, own.settledInstalls, cpi.denominator ?? null);
      cpiChecked += 1;
    }
    const roas = roasOf(r);
    if (roas) {
      compare(ctx, `${name} return numerator`, own.matureRevenue, roas.numerator ?? null);
      compare(ctx, `${name} return denominator`, own.matureSpend, roas.denominator ?? null);
      compare(ctx, `${name} mature days`, own.matureDays.length, r.window.evaluated.days);
      returnChecked += 1;
    }

    const expected = await ownSignal(r, own, anomalies);
    if (
      expected.signal !== r.signal ||
      expected.category !== r.category ||
      (expected.blocker !== null && !(r.blockers as string[]).includes(expected.blocker))
    ) {
      signalProblems.push(
        `${name}: own ${expected.signal}/${expected.category}${expected.blocker ? `(${expected.blocker})` : ''}, reported ${r.signal}/${r.category}(${r.blockers.join(',') || '-'})`,
      );
    }
    for (const blocker of r.blockers) gateChecked.add(blocker);
    if (expected.blocker === null && r.blockers.length > 0) {
      gateProblems.push(`${name}: reported ${r.blockers.join(',')} where the audit found no gate`);
    }
    if (expected.blocker !== null && r.blockers.length === 0) {
      gateProblems.push(`${name}: audit found ${expected.blocker}, none reported`);
    }
  }
  assert(
    ctx,
    'spend evidence recomputed',
    spendChecked === all.length,
    `${spendChecked} of ${all.length} recommendation(s) carry a spend figure`,
  );
  record(
    ctx,
    'cohort return recomputed',
    returnChecked > 0 ? 'PASS' : 'UNPROVEN',
    returnChecked > 0
      ? `${returnChecked} return figure(s) recomputed with independent SQL (numerator, denominator, mature days)`
      : 'no recommendation carries a cohort return: store a D7 or D1 ROAS target and make sure the report supplies cohort revenue',
  );
  assert(
    ctx,
    'installs and CPI recomputed',
    cpiChecked === all.length,
    `${cpiChecked} CPI figure(s)`,
  );
  assert(
    ctx,
    'signal re-derived from own gates and arithmetic',
    signalProblems.length === 0,
    signalProblems.slice(0, 5).join('; ') ||
      `${all.length} signal(s) equal the audit's own reading of mapping, freshness, currency, findings, anomalies, target, maturity, floors, band and trend`,
  );
  assert(
    ctx,
    'gate reasons hold against stored rows',
    gateProblems.length === 0,
    gateProblems.slice(0, 5).join('; ') ||
      `${gateChecked.size} distinct blocker(s) reported and re-derived: ${[...gateChecked].sort().join(', ') || 'none'}`,
  );

  // ---------------------------------------------------------- anomalies ---
  heading(ctx, 'ANOMALIES');
  const keyOf = (a: { date: string; metric: string; direction: string }, scope: string): string =>
    `${scope}|${a.date}|${a.metric}|${a.direction}`;
  const reported = new Map(
    run1.anomalies.map((a) => {
      const scope = a.scope.kind === 'app' ? 'APP' : String(a.scope.marketingCampaignId);
      return [keyOf(a, scope), a] as const;
    }),
  );
  const found = new Map<string, OwnClassified>();
  for (const [scope, list] of ownAnomalies) {
    for (const a of list) found.set(keyOf(a, scope), a);
  }
  const missingFromReport = [...found.keys()].filter((k) => !reported.has(k));
  const extraInReport = [...reported.keys()].filter((k) => !found.has(k));
  assert(
    ctx,
    'anomalies recomputed independently',
    missingFromReport.length === 0 && extraInReport.length === 0,
    missingFromReport.length === 0 && extraInReport.length === 0
      ? `${found.size} anomalous day(s) found by the audit's own median/MAD, ${reported.size} reported: identical`
      : `audit found but not reported: ${missingFromReport.slice(0, 3).join(' ')} · reported but not found: ${extraInReport.slice(0, 3).join(' ')}`,
  );
  const classProblems: string[] = [];
  for (const [key, a] of reported) {
    const own = found.get(key);
    if (own && own.classification !== a.classification) {
      classProblems.push(`${key}: own ${own.classification}, reported ${a.classification}`);
    }
  }
  record(
    ctx,
    'anomaly classes follow the data around them',
    classProblems.length > 0 ? 'FAIL' : 'PASS',
    classProblems.slice(0, 5).join('; ') ||
      `${run1.anomalies.length} anomaly(ies) classified as the audit's own reading of sync errors, coverage, findings and same-day delivery says`,
  );

  // ------------------------------------------------------------- pacing ---
  heading(ctx, 'PACING');
  const pacingProblems: string[] = [];
  for (const p of run1.pacing) {
    const budget = await queryRows<Row>(
      `SELECT MAX(c.daily_budget)::text AS daily,
              (SELECT SUM(g.daily_budget)::text FROM marketing_ad_groups g
                WHERE g.app_id = c.app_id AND g.provider_key = c.provider_key
                  AND g.external_campaign_id = c.external_campaign_id) AS ad_sets
         FROM marketing_campaigns c
        WHERE c.app_id = $1 AND c.provider_key = $2 AND c.external_campaign_id = $3
        GROUP BY c.app_id, c.provider_key, c.external_campaign_id`,
      [appId, mp, p.marketingCampaignId],
    );
    const delivered = await queryRows<Row>(
      `SELECT count(*)::text AS days, COALESCE(SUM(s), 0)::text AS spend
         FROM (SELECT report_date, SUM(spend) AS s FROM marketing_daily_metrics
                WHERE app_id = $1 AND provider_key = $2 AND external_campaign_id = $3
                  AND report_date BETWEEN $4 AND $5
                GROUP BY report_date HAVING SUM(spend) > 0) d`,
      [appId, mp, p.marketingCampaignId, from, to],
    );
    const daily =
      budget[0]?.['daily'] && toNumber(budget[0]['daily']) > 0
        ? toNumber(budget[0]['daily'])
        : budget[0]?.['ad_sets'] && toNumber(budget[0]['ad_sets']) > 0
          ? toNumber(budget[0]['ad_sets'])
          : null;
    const days = toNumber(delivered[0]?.['days']);
    const spend = toNumber(delivered[0]?.['spend']);
    const ratio =
      daily !== null && days > 0 && p.spendCurrencies.length <= 1 ? spend / days / daily : null;
    const status =
      ratio === null
        ? 'unknown'
        : ratio < T.pacingUnderRatio
          ? 'under'
          : ratio > T.pacingOverRatio
            ? 'over'
            : 'on';
    if (Math.abs(spend - p.spend) > 1e-6 || days !== p.deliveredDays) {
      pacingProblems.push(
        `${p.marketingCampaignId}: spend/days ${spend}/${days} vs ${p.spend}/${p.deliveredDays}`,
      );
    }
    if (
      (ratio === null) !== (p.ratio === null) ||
      (ratio !== null && Math.abs(ratio - (p.ratio ?? 0)) > 1e-4)
    ) {
      pacingProblems.push(`${p.marketingCampaignId}: ratio ${ratio} vs ${p.ratio}`);
    }
    if (status !== p.status && !(p.blocker === 'mixed_currency' && p.status === 'unknown')) {
      pacingProblems.push(`${p.marketingCampaignId}: status ${status} vs ${p.status}`);
    }
  }
  record(
    ctx,
    'pacing recomputed independently',
    pacingProblems.length > 0 ? 'FAIL' : run1.pacing.length > 0 ? 'PASS' : 'UNPROVEN',
    pacingProblems.slice(0, 5).join('; ') ||
      (run1.pacing.length > 0
        ? `${run1.pacing.length} campaign(s): delivered days, spend, ratio and status agree`
        : 'no campaign delivered in this window'),
  );

  // ------------------------------------------------- Phase 2 consistency ---
  heading(ctx, 'PHASE 0-2 CONSISTENCY');
  const [marketingAggregate, attributionAggregate, cohortAggregate] = await Promise.all([
    loadMarketingAggregate(filters),
    loadAttributionAggregate(filters),
    loadCohortAggregate(filters),
  ]);
  const metrics = computeMetricValues({
    context,
    marketing: marketingAggregate,
    attribution: attributionAggregate,
    cohort: cohortAggregate,
  });
  const appRoas = roasOf(run1.app);
  const phase2 = appRoas ? metrics.find((m) => m.metricKey === appRoas.key) : undefined;
  if (!appRoas) {
    record(
      ctx,
      'Phase 2 cohort ROAS agrees with the app evidence',
      'UNPROVEN',
      'the app recommendation carries no cohort return (no ROAS target stored, or the report supplies no cohort revenue)',
    );
  } else if (!phase2 || phase2.numerator === null || phase2.denominator === null) {
    assert(
      ctx,
      'Phase 2 cohort ROAS agrees with the app evidence',
      appRoas.availability !== 'available',
      `Phase 2 ${appRoas.key} is ${phase2?.availability ?? 'absent'} (${phase2?.blocker ?? '-'}); app evidence is ${appRoas.availability} (${appRoas.blocker ?? '-'})`,
    );
  } else {
    compare(
      ctx,
      `${appRoas.key} numerator (Phase 2 vs Phase 3)`,
      phase2.numerator,
      appRoas.numerator ?? null,
    );
    compare(
      ctx,
      `${appRoas.key} denominator (Phase 2 vs Phase 3)`,
      phase2.denominator,
      appRoas.denominator ?? null,
    );
  }
  assert(
    ctx,
    'Phase 3 reads and never writes provider data',
    metrics.length > 0,
    `${metrics.length} Phase 0-2 metrics computed unchanged beside the decision layer`,
  );

  // ---------------------------------------------- transactional proofs ---
  heading(ctx, 'CONTROLLED PROOFS (transactional, rolled back)');
  // A clean synthetic campaign carries the proofs, so they do not depend on
  // what this dataset happens to contain: steady spend, steady installs, a
  // D7 cohort return of 0.6 per component (1.2 in total), on days the real
  // revenue runs have covered since the cohorts matured.
  const revenueWindows = await queryRows<Row>(
    `SELECT w->>'from' AS "from", w->>'to' AS "to",
            (r.finished_at AT TIME ZONE a.timezone)::date::text AS finished
       FROM sync_runs r JOIN apps a ON a.id = r.app_id,
            jsonb_array_elements(COALESCE(r.checkpoint->'dataWindows', '[]'::jsonb)) w
      WHERE r.app_id = $1 AND r.data_type = 'attribution_revenue'
        AND r.status IN ('completed', 'partially_completed')`,
    [appId],
  );
  const coveredAt = (day: IsoDate, age: number): boolean =>
    revenueWindows.some(
      (w) =>
        String(w['from']) <= day &&
        day <= String(w['to']) &&
        String(w['finished']) > addDays(day, age),
    );
  const installsHorizon = horizonOf('attribution_installs');
  const marketingHorizon = horizonOf('marketing_performance');
  const dropDay = installsHorizon && installsHorizon < to ? installsHorizon : to;
  const matureCandidates = ownAsOf
    ? eachDate(from, to).filter((d) => addDays(d, 7) < ownAsOf && coveredAt(d, 7))
    : [];
  const matureSynthetic = matureCandidates.slice(-14);
  const syntheticFrom = matureSynthetic[0] ?? null;
  const syntheticLast = matureSynthetic[13] ?? null;
  const syntheticOk =
    syntheticFrom !== null &&
    syntheticLast !== null &&
    installsHorizon !== null &&
    marketingHorizon !== null &&
    dropDay > syntheticLast;
  line(
    'synthetic campaign',
    syntheticOk
      ? `${matureSynthetic.length} covered mature days ${syntheticFrom}..${syntheticLast}, live to ${dropDay}`
      : `not possible: ${matureCandidates.length} covered mature day(s) in the window (needs 14), installs horizon ${installsHorizon ?? 'none'}, marketing horizon ${marketingHorizon ?? 'none'}`,
  );
  const cleanFeeds =
    ['fresh', 'delayed'].includes(ownMarketingStatus ?? '') &&
    ['fresh', 'delayed'].includes(ownAttributionStatus ?? '') &&
    ownErrors === 0 &&
    !ownErrorFindings.some((f) => !String(f['check_key']).startsWith('reconciliation.'));
  line(
    'feeds clean for a performance reading',
    cleanFeeds
      ? 'yes'
      : `no (marketing ${ownMarketingStatus}, attribution ${ownAttributionStatus}, ${ownErrors} sync error(s), ${ownErrorFindings.length} error finding(s))`,
  );
  const syntheticPrecondition = !syntheticOk
    ? 'the window has no 14 covered mature days for a synthetic campaign: widen it or run an attribution revenue sync over it'
    : !cleanFeeds
      ? `feeds are not clean (marketing ${ownMarketingStatus}, attribution ${ownAttributionStatus}, ${ownErrors} unresolved sync error(s), ${ownErrorFindings.length} error finding(s)): the reading stops at that gate first, as it must`
      : null;

  type Pattern = {
    /** Revenue per component per mature day, by index into matureSynthetic. */
    revenue: (index: number) => number;
    dropInstalls?: boolean;
  };
  const insertSynthetic = async (client: Queryable, pattern: Pattern): Promise<void> => {
    if (!syntheticFrom) throw new Error('synthetic campaign precondition not met');
    await client.query(
      `INSERT INTO marketing_campaigns (organization_id, app_id, connection_id, provider_key, external_campaign_id, name, status, effective_status, currency, daily_budget)
       VALUES ($1, $2, $3, $4, $5, 'MART Phase 3 proof', 'ACTIVE', 'ACTIVE', 'USD', 20)`,
      [organizationId, appId, marketing.connection_id, mp, PROOF_CAMPAIGN],
    );
    await client.query(
      `INSERT INTO provider_entity_mappings (organization_id, app_id, entity_type, source_provider, source_external_id, source_name, target_provider, target_external_id, target_name, mapping_method, mapping_confidence, status)
       VALUES ($1, $2, 'campaign', $3, $4, 'MART Phase 3 proof', $5, $4, 'MART Phase 3 proof', 'manual', 1, 'manually_verified')`,
      [organizationId, appId, mp, PROOF_CAMPAIGN, ap],
    );
    for (const date of eachDate(syntheticFrom, dropDay)) {
      if (marketingHorizon !== null && date <= marketingHorizon) {
        await client.query(
          `INSERT INTO marketing_daily_metrics (organization_id, app_id, connection_id, provider_key, report_date, external_campaign_id, currency, spend, impressions, clicks, platform, dimension_hash)
           VALUES ($1, $2, $3, $4, $5, $6, 'USD', 20, 4000, 80, 'unknown', $7)`,
          [
            organizationId,
            appId,
            marketing.connection_id,
            mp,
            date,
            PROOF_CAMPAIGN,
            `${PROOF_CAMPAIGN}:md:${date}`,
          ],
        );
      }
      await client.query(
        `INSERT INTO attribution_daily_metrics (organization_id, app_id, connection_id, provider_key, install_date, media_source, normalized_media_source, external_campaign_id, campaign_name, attributed_installs, platform, dimension_hash)
         VALUES ($1, $2, $3, $4, $5, 'mart_proof_network', 'mart_proof_network', $6, 'MART Phase 3 proof', $7, 'unknown', $8)`,
        [
          organizationId,
          appId,
          attribution.connection_id,
          ap,
          date,
          PROOF_CAMPAIGN,
          pattern.dropInstalls && date === dropDay ? 0 : 30,
          `${PROOF_CAMPAIGN}:ad:${date}`,
        ],
      );
      const index = matureSynthetic.indexOf(date);
      if (index >= 0) {
        for (const type of ['iap', 'ad'] as const) {
          await client.query(
            `INSERT INTO attribution_revenue_metrics (organization_id, app_id, connection_id, provider_key, grain, activity_date, cohort_age_days, revenue_type, media_source, normalized_media_source, external_campaign_id, campaign_name, currency, revenue, platform, dimension_hash, observed_at)
             VALUES ($1, $2, $3, $4, 'cohort_date', $5, 7, $6, 'mart_proof_network', 'mart_proof_network', $7, 'MART Phase 3 proof', 'USD', $8, 'unknown', $9, now())`,
            [
              organizationId,
              appId,
              attribution.connection_id,
              ap,
              date,
              type,
              PROOF_CAMPAIGN,
              pattern.revenue(index),
              `${PROOF_CAMPAIGN}:rev:${type}:${date}`,
            ],
          );
        }
      }
    }
  };
  const flat: Pattern = { revenue: () => 12 };
  const syntheticReading = (d: DecisionSet): Recommendation | undefined =>
    d.campaigns.find((c) => c.scope.marketingCampaignId === PROOF_CAMPAIGN);
  const syntheticAnomaly = (d: DecisionSet): Anomaly | undefined =>
    d.anomalies.find(
      (a) =>
        a.scope.marketingCampaignId === PROOF_CAMPAIGN &&
        a.metric === 'installs' &&
        a.date === dropDay,
    );
  const describe = (r: Recommendation | undefined): string =>
    r
      ? `${r.signal}/${r.category}(${r.blockers.join(',') || '-'}) return=${roasOf(r)?.value ?? 'none'} ${roasOf(r)?.availability ?? ''}`
      : 'absent';
  const kindOf = (r: Recommendation | undefined): 'partial' | 'total' | 'none' =>
    roasOf(r)?.availability === 'partial'
      ? 'partial'
      : roasOf(r)?.availability === 'available'
        ? 'total'
        : 'none';

  type ProofCheck = { ok: boolean; detail: string } | { unproven: string };
  const proof = async (
    name: string,
    mutate: (client: Queryable) => Promise<void | 'skip'>,
    check: (decisions: DecisionSet, client: Queryable) => Promise<ProofCheck> | ProofCheck,
    proofWindow: { from: IsoDate; to: IsoDate; timezone: string } = window,
  ): Promise<void> => {
    const outcome = await withRollback(appId, async (client) => {
      const skipped = await mutate(client);
      if (skipped === 'skip') return { unproven: 'precondition not met' } as ProofCheck;
      const proofContext = await buildContext(organizationId, appId, client);
      const proofPolicy = await decisionsRepo.getDecisionPolicy(organizationId, appId, client);
      const decisions = await loadDecisions({
        filters,
        context: proofContext,
        window: proofWindow,
        policy: proofPolicy,
        now: new Date('2026-01-01T00:00:00Z'),
        client,
      });
      return check(decisions, client);
    });
    line(
      'ROLLBACK',
      outcome.verified ? 'verified' : `FAILED - drift in ${outcome.drift.join(', ')}`,
    );
    if (!outcome.verified) {
      assert(ctx, name, false, 'ROLLBACK NOT VERIFIED - a controlled change may have survived');
      return;
    }
    if (outcome.error !== null || outcome.result === null) {
      assert(ctx, name, false, `proof threw: ${outcome.error ?? 'no result'}`);
      return;
    }
    const result = outcome.result;
    if ('unproven' in result) record(ctx, name, 'UNPROVEN', result.unproven);
    else assert(ctx, name, result.ok, result.detail);
  };
  const noDecisive = (d: DecisionSet): boolean =>
    [d.app, ...d.campaigns].every((r) => r.signal !== 'scale' && r.signal !== 'reduce');
  const upsertPolicy = async (client: Queryable, targetRoasD7: number): Promise<void> => {
    await decisionsRepo.upsertDecisionPolicy(
      {
        organizationId,
        appId,
        targetRoasD7,
        targetRoasD1: null,
        maxCpi: null,
        currency: null,
        updatedByUserId: null,
      },
      client,
    );
  };
  /** A proof on the synthetic campaign, UNPROVEN with the reason when it cannot be set up. */
  const syntheticProof = (
    name: string,
    target: number,
    pattern: Pattern,
    extra: (client: Queryable) => Promise<void>,
    check: (reading: Recommendation | undefined, d: DecisionSet) => ProofCheck,
    requireCleanFeeds = true,
  ): Promise<void> =>
    proof(
      name,
      async (client) => {
        if (!syntheticOk || (requireCleanFeeds && !cleanFeeds)) return 'skip';
        await upsertPolicy(client, target);
        await insertSynthetic(client, pattern);
        await extra(client);
      },
      (d) => {
        if (!syntheticOk || (requireCleanFeeds && !cleanFeeds)) {
          return { unproven: syntheticPrecondition ?? 'precondition not met' };
        }
        return check(syntheticReading(d), d);
      },
    );

  await proof(
    'no target: no scale, no reduce',
    async (client) => {
      await decisionsRepo.deleteDecisionPolicy(organizationId, appId, client);
      if (syntheticOk) await insertSynthetic(client, flat);
    },
    (d) => {
      const readings = [d.app, ...d.campaigns];
      const holders = readings.filter((r) => r.blockers.includes('no_target'));
      const synthetic = syntheticReading(d);
      return {
        ok:
          noDecisive(d) &&
          !d.policy.configured &&
          (!syntheticOk || (synthetic !== undefined && synthetic.signal === 'hold')),
        detail: `policy removed: ${readings.length} reading(s), none scale/reduce, ${holders.length} hold on no_target${synthetic ? `; a clean campaign returning 1.2 reads ${describe(synthetic)}` : ''}`,
      };
    },
  );

  await syntheticProof(
    'target below the return: scale',
    0.5,
    flat,
    async () => undefined,
    (r) => ({
      ok: r?.signal === 'scale' && r.category === 'performance' && r.blockers.length === 0,
      detail: `target 0.5 against a return of ${roasOf(r)?.value ?? 'none'} (${kindOf(r)}): ${describe(r)}`,
    }),
  );
  await syntheticProof(
    'target above the return: reduce',
    2,
    flat,
    async () => undefined,
    (r) => {
      const kind = kindOf(r);
      const ok =
        kind === 'total'
          ? r?.signal === 'reduce' && r.category === 'performance' && r.blockers.length === 0
          : kind === 'partial'
            ? r?.signal === 'hold' && r.blockers.includes('partial_return')
            : false;
      return {
        ok,
        detail: `target 2 against a return of ${roasOf(r)?.value ?? 'none'} (${kind}): ${describe(r)}${kind === 'partial' ? ' - a component-only return below target never reduces' : ''}`,
      };
    },
  );
  await syntheticProof(
    'target met: hold',
    1.2,
    flat,
    async () => undefined,
    (r) => {
      const kind = kindOf(r);
      const ok =
        kind === 'total'
          ? r?.signal === 'hold' && r.category === 'performance' && r.blockers.length === 0
          : kind === 'partial'
            ? r?.signal === 'hold' && r.blockers.includes('partial_return')
            : false;
      return {
        ok,
        detail: `target 1.2 against ${roasOf(r)?.value ?? 'none'} (${kind}): ${describe(r)}`,
      };
    },
  );
  await syntheticProof(
    'newest cohorts contradict the window: hold',
    0.5,
    { revenue: (index) => (index < 7 ? 20 : 10) },
    async () => undefined,
    (r) => ({
      ok: r?.signal === 'hold' && r.blockers.includes('trend_contradicts'),
      detail: `first seven mature days return 2.0, newest seven 1.0, window 1.5 against 0.5: ${describe(r)}`,
    }),
  );
  await syntheticProof(
    'stale feed: no signal',
    0.5,
    flat,
    async (client) => {
      await client.query(
        `UPDATE data_freshness SET status = 'stale' WHERE app_id = $1 AND data_type = 'attribution_installs'`,
        [appId],
      );
    },
    (r, d) => ({
      ok:
        noDecisive(d) &&
        r?.signal === 'insufficient_data' &&
        r.category === 'data_quality' &&
        r.blockers.includes('provider_stale'),
      detail: `attribution_installs marked stale under a 0.5 target: ${describe(r)}, no scale/reduce anywhere`,
    }),
    false,
  );
  await syntheticProof(
    'second currency: investigate, never divide',
    0.5,
    flat,
    async (client) => {
      await client.query(
        `UPDATE marketing_daily_metrics SET currency = 'XTS'
          WHERE app_id = $1 AND external_campaign_id = $2 AND report_date = $3`,
        [appId, PROOF_CAMPAIGN, syntheticLast],
      );
    },
    (r) => ({
      ok:
        r?.signal === 'investigate' &&
        r.category === 'data_quality' &&
        r.blockers.includes('mixed_currency') &&
        evidenceOf(r, 'spend')?.availability === 'blocked',
      detail: `one XTS day injected: ${describe(r)} spend=${r ? evidenceOf(r, 'spend')?.availability : '-'}`,
    }),
    false,
  );
  await syntheticProof(
    'ambiguous mapping: investigate, never read',
    0.5,
    flat,
    async (client) => {
      await client.query(
        `UPDATE provider_entity_mappings SET status = 'ambiguous', target_external_id = NULL
          WHERE app_id = $1 AND entity_type = 'campaign' AND source_external_id = $2`,
        [appId, PROOF_CAMPAIGN],
      );
    },
    (r) => ({
      ok:
        r?.signal === 'investigate' &&
        r.category === 'coverage' &&
        r.blockers.includes('ambiguous_mapping') &&
        !r.quality.mapping.operational,
      detail: `mapping made ambiguous: ${describe(r)}`,
    }),
    false,
  );
  await proof(
    'immature window: no signal',
    async (client) => {
      await upsertPolicy(client, 0.000001);
    },
    (d) => {
      const readings = d.campaigns;
      const withheld = readings.filter(
        (r) => r.blockers.includes('immature_cohort') || r.blockers.includes('provider_stale'),
      );
      const roasBlocked = readings.every((r) => {
        const roas = roasOf(r);
        return !roas || roas.value === null;
      });
      return {
        ok: noDecisive(d) && roasBlocked,
        detail: `window ${addDays(to, -3)}..${to} under a 0.000001 target: ${readings.length} campaign(s), ${withheld.length} withheld as immature/unread, no return figure shown, none scale/reduce`,
      };
    },
    { from: addDays(to, -3), to, timezone: app.timezone },
  );
  await syntheticProof(
    'day nobody re-read: not a day that earned nothing',
    0.5,
    flat,
    async (client) => {
      await client.query(
        `UPDATE sync_runs SET checkpoint = checkpoint - 'dataWindows'
          WHERE app_id = $1 AND data_type = 'attribution_revenue'`,
        [appId],
      );
    },
    (r, d) => ({
      ok:
        noDecisive(d) &&
        r?.signal === 'insufficient_data' &&
        r.blockers.includes('provider_stale') &&
        roasOf(r)?.value === null &&
        (r.quality.maturity?.matureDays ?? -1) === 0 &&
        (r.quality.maturity?.uncoveredDays ?? 0) > 0,
      detail: `revenue read-windows removed: ${describe(r)} mature=${r?.quality.maturity?.matureDays} unread=${r?.quality.maturity?.uncoveredDays}`,
    }),
    false,
  );
  const leaveAdOnly = async (client: Queryable): Promise<void> => {
    await client.query(
      `UPDATE provider_capabilities pc SET supported = false
        FROM integration_app_bindings b
       WHERE b.connection_id = pc.connection_id AND b.app_id = $1
         AND pc.capability_key IN ('cohort_total_revenue_d7', 'cohort_iap_revenue_d7')`,
      [appId],
    );
  };
  await syntheticProof(
    'partial return: scale above, never reduce below',
    0.5,
    flat,
    leaveAdOnly,
    (r) => ({
      ok:
        r?.signal === 'scale' &&
        roasOf(r)?.key === 'cohort_ad_roas_d7' &&
        roasOf(r)?.availability === 'partial',
      detail: `only ad revenue reported at D7, 0.6 against a target of 0.5: ${describe(r)} via ${roasOf(r)?.key ?? '-'}`,
    }),
  );
  await syntheticProof('partial return below target never reduces', 2, flat, leaveAdOnly, (r) => ({
    ok: r?.signal === 'hold' && r.blockers.includes('partial_return'),
    detail: `only ad revenue reported at D7, 0.6 against a target of 2: ${describe(r)}`,
  }));
  await syntheticProof(
    'tracking-shaped movement is never performance',
    0.5,
    { revenue: () => 12, dropInstalls: true },
    async () => undefined,
    (r, d) => {
      const anomaly = syntheticAnomaly(d);
      return {
        ok:
          anomaly?.classification === 'undetermined' &&
          r?.signal === 'investigate' &&
          r.category === 'undetermined' &&
          r.blockers.includes('anomalous_data'),
        detail: `installs 30/day then 0 on ${dropDay} with spend steady, return 1.2 against 0.5: anomaly=${anomaly?.classification ?? 'not detected'} reading=${describe(r)}`,
      };
    },
  );
  await syntheticProof(
    'sync error over the same movement is a data gap',
    0.5,
    { revenue: () => 12, dropInstalls: true },
    async (client) => {
      const run = await queryRows<Row>(
        `SELECT id FROM sync_runs WHERE app_id = $1 AND data_type = 'attribution_installs' ORDER BY created_at DESC LIMIT 1`,
        [appId],
        client,
      );
      if (!run[0]) throw new Error('no attribution_installs run to attach the error to');
      await client.query(
        `INSERT INTO sync_errors (organization_id, sync_run_id, error_class, message, window_start, window_end)
         VALUES ($1, $2, 'rate_limited', 'MART Phase 3 proof', $3, $3)`,
        [organizationId, run[0]['id'], dropDay],
      );
    },
    (r, d) => {
      const anomaly = syntheticAnomaly(d);
      return {
        ok:
          anomaly?.classification === 'data_gap' &&
          r?.signal === 'investigate' &&
          r.category === 'data_quality' &&
          noDecisive(d),
        detail: `same movement under an unresolved sync error on ${dropDay}: anomaly=${anomaly?.classification ?? 'not detected'} reading=${describe(r)}, no scale/reduce anywhere`,
      };
    },
  );

  note(
    'every controlled change above ran inside a transaction that was rolled back and verified rolled back',
  );
}

main()
  .catch((error: unknown) => {
    const parts: string[] = [];
    let current: unknown = error;
    for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
      parts.push(current.message);
      current = current.cause;
    }
    if (parts.length === 0) parts.push(String(error));
    process.stderr.write(`phase3-audit failed: ${parts.join(' <- ')}\n`);
    process.exitCode = 1;
  })
  .finally(() => closePool());

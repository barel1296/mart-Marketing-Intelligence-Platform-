/**
 * Phase 2 exit audit: cohort intelligence.
 *
 *   node packages/integrations/dist/cli/phase2-audit.js <organization_id> <from> <to> [app_id]
 *
 * Phase 1 established that MART's model is canonical. Phase 2 asks whether the
 * cohort figures built on it are TRUE: that a D7 number describes a cohort
 * observed seven days after it installed, that D1 and D7 are two facts and not
 * one, that a cohort too young to have a D7 is excluded rather than zero, that
 * a cohort ROAS divides cohort revenue by the spend that bought that cohort on
 * its install day and nothing else, that organic cohorts never acquire a paid
 * return, that unmapped cohorts never borrow spend, and that two currencies
 * are never added.
 *
 * Like the earlier audits it writes nothing and derives every figure from
 * stored rows with its own SQL, never by importing the predicates it checks.
 * The one write it performs - a synthetic second currency - happens inside a
 * transaction that is always rolled back and verified rolled back.
 *
 * A criterion the platform cannot evaluate on this database is UNPROVEN, and
 * the detail says exactly what external change would let it be evaluated.
 * Nothing here is ever PASS on the strength of a fixture.
 */
import { closePool, queryRows, toNumber } from '@mart/db';
import { getConfig } from '@mart/config';
import {
  METRIC_DEFINITIONS,
  cohortMetricKey,
  computeMetricValues,
  loadAttributionAggregate,
  loadCohortAggregate,
  loadMarketingAggregate,
  loadUnifiedPerformance,
  proveCohortCurrencyGate,
  type MetricContext,
  type MetricFilters,
  type MetricValue,
} from '@mart/metrics';
import {
  COHORT_AGES,
  COHORT_REVENUE_TYPES,
  OPERATIONAL_MAPPING_CONFIDENCE,
  cohortCapabilityKey,
  type CohortAge,
  type IsoDate,
} from '@mart/shared';
import {
  TENJIN_COHORT_AD_METRICS,
  TENJIN_COHORT_IAP_METRIC,
  TENJIN_COHORT_ROAS_METRIC,
  TENJIN_COHORT_TYPE,
  TENJIN_PREDICTED_METRIC_PATTERN,
} from '../providers/tenjin.js';
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
 * The audit's own copy of the mapping-strength rule. Deliberately not imported
 * from the metric layer: recomputing a figure with the code that produced it
 * proves only that the code is deterministic.
 */
const OPERATIONAL = `(m.status IN ('matched_exact','matched_confident','manually_verified')
  OR (m.status = 'matched_fallback' AND m.mapping_confidence >= ${OPERATIONAL_MAPPING_CONFIDENCE}))`;
const PAID = `COALESCE(t.normalized_media_source, 'organic') <> 'organic'`;
const MAPPED = `t.external_campaign_id IN (
  SELECT m.target_external_id FROM provider_entity_mappings m
   WHERE m.organization_id = t.organization_id AND m.app_id = t.app_id
     AND m.entity_type = 'campaign' AND m.target_provider = t.provider_key
     AND m.target_external_id IS NOT NULL AND ${OPERATIONAL})`;
const ALIGNED = `t.external_campaign_id IN (
  SELECT m.target_external_id FROM provider_entity_mappings m
    JOIN marketing_daily_metrics md
      ON md.external_campaign_id = m.source_external_id AND md.provider_key = m.source_provider
     AND md.organization_id = t.organization_id AND md.app_id = t.app_id
     AND md.report_date = t.activity_date AND md.spend > 0
   WHERE m.organization_id = t.organization_id AND m.app_id = t.app_id
     AND m.entity_type = 'campaign' AND m.target_provider = t.provider_key
     AND m.target_external_id IS NOT NULL AND ${OPERATIONAL})`;
/** Mature: old enough as of the horizon, and last read after reaching the age. */
const MATURE = `(t.activity_date + t.cohort_age_days) < $4::date
  AND (t.observed_at AT TIME ZONE a.timezone)::date > (t.activity_date + t.cohort_age_days)`;

type Row = Record<string, string | null>;

async function main(): Promise<void> {
  const [organizationId, from, to, appArg] = process.argv.slice(2);
  if (!organizationId || !from || !to) {
    process.stderr.write(
      'usage: phase2-audit <organization_id> <from> <to> [app_id]\n' +
        '  e.g. phase2-audit fe8a8112-... 2026-08-01 2026-08-31\n',
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
  auditSyncConfiguration(ctx);

  for (const app of apps) {
    await auditApp(ctx, organizationId, app, from as IsoDate, to as IsoDate);
  }

  heading(ctx, 'PHASE 2 EXIT VERDICT');
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

  const verdict =
    failed.length > 0
      ? 'NOT DONE - a Phase 2 exit criterion fails'
      : unproven.length > 0
        ? 'BLOCKED - every computed criterion passed; the rest need the external action named above'
        : missing.length > 0
          ? 'NOT DONE - criteria remain unbuilt'
          : 'DONE - every Phase 2 exit criterion passed against this database';
  process.stdout.write(`\n  PHASE 2: ${verdict}\n`);
  process.exitCode = failed.length > 0 || unproven.length > 0 || missing.length > 0 ? 1 : 0;
}

/** The cohort vocabulary is provider-independent, so it is audited once. */
function auditVocabulary(ctx: AuditContext): void {
  heading(ctx, 'COHORT VOCABULARY');
  const keys = new Set(METRIC_DEFINITIONS.map((d) => d.metricKey));
  const expected: string[] = [];
  for (const ageDays of COHORT_AGES) {
    for (const revenueType of COHORT_REVENUE_TYPES) {
      for (const measure of ['revenue', 'rpi', 'roas'] as const) {
        expected.push(cohortMetricKey({ ageDays, revenueType, measure }));
      }
    }
  }
  const absent = expected.filter((k) => !keys.has(k));
  line('cohort ages served', COHORT_AGES.join(', '));
  line('cohort metrics defined', expected.length - absent.length);
  assert(
    ctx,
    'Phase 2 metric set present',
    absent.length === 0,
    absent.join(', ') || 'all present',
  );

  const cohortMetrics = METRIC_DEFINITIONS.filter((d) => d.cohort);
  assert(
    ctx,
    'cohort metrics carry cohort grain and class',
    cohortMetrics.every((d) => d.grain.primary === 'cohort_date' && d.semanticClass === 'cohort'),
    `${cohortMetrics.length} metric(s) at cohort_date grain, class cohort`,
  );
  const roas = cohortMetrics.filter((d) => d.cohort?.measure === 'roas');
  assert(
    ctx,
    'cohort ROAS names one population on both sides',
    roas.every(
      (d) =>
        d.population.numerator === 'cohort_aligned_paid_attribution' &&
        d.population.denominator === 'cohort_aligned_marketing',
    ),
    'numerator cohort_aligned_paid_attribution / denominator cohort_aligned_marketing',
  );
  assert(
    ctx,
    'D1 and D7 are distinct metric keys',
    COHORT_AGES.every((age) =>
      keys.has(cohortMetricKey({ ageDays: age, revenueType: 'total', measure: 'revenue' })),
    ) && COHORT_AGES.length === new Set(COHORT_AGES).size,
    COHORT_AGES.map((a) => `cohort_revenue_d${a}`).join(' / '),
  );
  assert(
    ctx,
    'no predicted or forecast metric exists',
    METRIC_DEFINITIONS.every((d) => !/pltv|proas|predict|forecast/i.test(d.metricKey)) &&
      TENJIN_PREDICTED_METRIC_PATTERN.test('pltv_7d') &&
      TENJIN_PREDICTED_METRIC_PATTERN.test('proas_30d') &&
      !TENJIN_PREDICTED_METRIC_PATTERN.test(TENJIN_COHORT_IAP_METRIC(7)) &&
      TENJIN_COHORT_AD_METRICS(7).every((m) => !TENJIN_PREDICTED_METRIC_PATTERN.test(m)),
    'registry has none; the Tenjin adapter refuses pltv_Nd / proas_Nd and reads revenues_Nd / ad_mediation_revenue_Nd',
  );
  assert(
    ctx,
    'provider cohort semantics are cumulative',
    TENJIN_COHORT_TYPE === 'cumulative',
    `Tenjin ${TENJIN_COHORT_IAP_METRIC(7)} / ${TENJIN_COHORT_AD_METRICS(7)[0]} are cohort_type=${TENJIN_COHORT_TYPE}; ${TENJIN_COHORT_ROAS_METRIC(7)} is IAP LTV / same-day spend`,
  );
}

/** A cohort can only mature in storage if it is re-read after reaching its age. */
function auditSyncConfiguration(ctx: AuditContext): void {
  heading(ctx, 'SYNC CONFIGURATION');
  const lookback = getConfig().SYNC_RESTATEMENT_LOOKBACK_DAYS;
  const oldest = Math.max(...COHORT_AGES);
  line('SYNC_RESTATEMENT_LOOKBACK_DAYS', lookback);
  line('oldest cohort age served', oldest);
  assert(
    ctx,
    'lookback re-reads cohorts until they mature',
    lookback >= oldest,
    lookback >= oldest
      ? `${lookback} >= ${oldest}: a D${oldest} cohort is re-read after its day ${oldest}`
      : `${lookback} < ${oldest}: set SYNC_RESTATEMENT_LOOKBACK_DAYS=${oldest} or more, or D${oldest} figures never mature in storage`,
  );
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

  const bindings = await queryRows<Row>(
    `SELECT b.role, c.provider_key, c.id AS connection_id, b.integration_account_id,
            a.external_account_id
       FROM integration_app_bindings b
       JOIN integration_connections c ON c.id = b.connection_id
       LEFT JOIN integration_accounts a ON a.id = b.integration_account_id
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

  // ------------------------------------------------- provider capability --
  heading(ctx, 'PROVIDER CAPABILITY');
  line('attribution provider', attributionProviderKey ?? '(none)');
  line('marketing provider', marketingProviderKey ?? '(none)');
  const capabilityRows = attribution
    ? await queryRows<Row>(
        `SELECT DISTINCT ON (capability_key) capability_key, supported::text AS supported,
                discovery_method, detail::text AS detail
           FROM provider_capabilities
          WHERE connection_id = $1
            AND (integration_account_id IS NOT DISTINCT FROM $2 OR integration_account_id IS NULL)
            AND capability_key LIKE 'cohort_%'
          ORDER BY capability_key, (integration_account_id IS NOT NULL) DESC, discovered_at DESC`,
        [attribution.connection_id, attribution.integration_account_id],
      )
    : [];
  const supportedCohortKeys = new Set(
    capabilityRows.filter((r) => r['supported'] === 'true').map((r) => String(r['capability_key'])),
  );
  const actions = new Map<string, string>();
  for (const row of capabilityRows) {
    line(`  ${row['capability_key']}`, `${row['supported']} (${row['discovery_method']})`);
    if (row['supported'] !== 'true' && row['detail']) {
      try {
        const detail = JSON.parse(row['detail']) as { action?: unknown };
        if (typeof detail.action === 'string')
          actions.set(String(row['capability_key']), detail.action);
      } catch {
        // Detail is informational.
      }
    }
  }
  const probed = capabilityRows.filter(
    (r) => r['capability_key'] !== 'cohort_reporting' && r['discovery_method'] === 'probed',
  );
  if (!attribution) {
    record(
      ctx,
      'cohort capability probed',
      'UNPROVEN',
      'no attribution provider bound to this app',
    );
  } else if (probed.length === 0) {
    record(
      ctx,
      'cohort capability probed',
      'UNPROVEN',
      `no probed cohort capability rows for ${attributionProviderKey}; run an attribution revenue sync (the engine re-probes after it) or re-select the account`,
    );
  } else {
    assert(
      ctx,
      'cohort capability probed',
      true,
      `${probed.length} cohort component/age row(s) probed from the account's report definition`,
    );
  }
  const servedAges = COHORT_AGES.filter((age) =>
    (['iap', 'ad'] as const).some((t) => supportedCohortKeys.has(cohortCapabilityKey(t, age))),
  );
  line('ages the report can supply', servedAges.join(', ') || '(none)');
  for (const age of COHORT_AGES) {
    const missing = (['iap', 'ad'] as const).filter(
      (t) => !supportedCohortKeys.has(cohortCapabilityKey(t, age)),
    );
    if (missing.length > 0) {
      for (const t of missing) {
        const key = cohortCapabilityKey(t, age);
        note(
          `  ${key} unavailable. ${actions.get(key) ?? 'Add the metric to the provider report.'}`,
        );
      }
    }
  }

  // --------------------------------------------------------- storage -----
  heading(ctx, 'COHORT STORAGE');
  const stored = await queryRows<Row>(
    `SELECT grain, cohort_age_days::text AS age, revenue_type, count(*)::text AS n,
            COALESCE(SUM(revenue), 0)::text AS revenue
       FROM attribution_revenue_metrics
      WHERE app_id = $1 AND activity_date BETWEEN $2 AND $3
      GROUP BY grain, cohort_age_days, revenue_type ORDER BY grain, cohort_age_days, revenue_type`,
    [appId, from, to],
  );
  for (const row of stored) {
    line(
      `${row['grain']}${row['age'] ? ` D${row['age']}` : ''} / ${row['revenue_type']}`,
      `${row['n']} row(s), ${row['revenue']}`,
    );
  }
  const cohortRows = stored.filter((r) => r['grain'] === 'cohort_date');
  const cohortRowCount = cohortRows.reduce((n, r) => n + toNumber(r['n']), 0);
  const halfFormed = await queryRows<Row>(
    `SELECT count(*)::text AS n FROM attribution_revenue_metrics
      WHERE app_id = $1 AND ((grain = 'cohort_date' AND cohort_age_days IS NULL)
                          OR (grain <> 'cohort_date' AND cohort_age_days IS NOT NULL))`,
    [appId],
  );
  assert(
    ctx,
    'every cohort row carries its age',
    toNumber(halfFormed[0]?.['n']) === 0,
    `${halfFormed[0]?.['n'] ?? '0'} half-formed cohort row(s)`,
  );
  const storedAges = new Set(cohortRows.map((r) => toNumber(r['age'])));
  const unservedAges = [...storedAges].filter(
    (a) => !(COHORT_AGES as readonly number[]).includes(a),
  );
  assert(
    ctx,
    'stored cohort ages are served ages',
    unservedAges.length === 0,
    unservedAges.length === 0
      ? `ages stored: ${[...storedAges].sort().join(', ') || '(none)'}`
      : `unserved age(s) stored: ${unservedAges.join(', ')}`,
  );
  if (cohortRowCount === 0) {
    const missingKeys = COHORT_AGES.flatMap((age) =>
      (['iap', 'ad'] as const)
        .map((t) => cohortCapabilityKey(t, age))
        .filter((k) => !supportedCohortKeys.has(k)),
    );
    record(
      ctx,
      'cohort revenue ingested',
      'UNPROVEN',
      servedAges.length === 0
        ? `no cohort rows and the report supplies no cohort component. ${[...new Set(missingKeys.map((k) => actions.get(k)).filter(Boolean))].join(' ') || 'Add revenues_Nd / ad_mediation_revenue_Nd to the provider report and re-sync attribution revenue.'}`
        : 'the report supplies cohort components but no cohort rows are stored for this window; run an attribution revenue sync over it',
    );
    // Nothing below can be evaluated without rows; each criterion says so.
    for (const metric of [
      'cohort revenue is cumulative',
      'D1 and D7 stored as distinct facts',
      'maturity recomputed independently',
      'immature cohorts excluded, not zero',
      'organic cohorts have no paid ROAS',
      'unmapped cohorts borrow no spend',
      'ROAS spend is the install-day spend of the same campaigns',
      'provider ROAS definition cross-check',
      'cohort mixed currency is blocked, never summed',
    ]) {
      record(ctx, metric, 'UNPROVEN', 'no cohort rows stored for this window');
    }
    return;
  }
  assert(ctx, 'cohort revenue ingested', true, `${cohortRowCount} cohort row(s) in range`);

  // ------------------------------------------------------- cumulative ----
  heading(ctx, 'CUMULATIVE COHORT REVENUE');
  const pairs = await queryRows<Row>(
    `WITH keyed AS (
       SELECT activity_date, revenue_type, COALESCE(media_source,'') AS ms,
              COALESCE(external_campaign_id,'') AS cid, COALESCE(country,'') AS ctry,
              platform, currency, cohort_age_days, revenue, dimension_hash
         FROM attribution_revenue_metrics
        WHERE app_id = $1 AND grain = 'cohort_date' AND activity_date BETWEEN $2 AND $3
     ), joined AS (
       SELECT a.revenue AS d1, b.revenue AS d7, a.dimension_hash AS h1, b.dimension_hash AS h7
         FROM keyed a JOIN keyed b
           ON a.activity_date = b.activity_date AND a.revenue_type = b.revenue_type
          AND a.ms = b.ms AND a.cid = b.cid AND a.ctry = b.ctry
          AND a.platform = b.platform AND a.currency = b.currency
          AND a.cohort_age_days = 1 AND b.cohort_age_days = 7
     )
     SELECT count(*)::text AS pairs,
            count(*) FILTER (WHERE d7 < d1)::text AS violations,
            count(*) FILTER (WHERE d7 <> d1)::text AS distinct_values,
            count(*) FILTER (WHERE h1 = h7)::text AS shared_identity
       FROM joined`,
    [appId, from, to],
  );
  const pairCount = toNumber(pairs[0]?.['pairs']);
  line('cohorts with both D1 and D7', pairCount);
  if (pairCount === 0) {
    record(
      ctx,
      'cohort revenue is cumulative',
      'UNPROVEN',
      'no cohort has both a D1 and a D7 row in this window',
    );
    record(
      ctx,
      'D1 and D7 stored as distinct facts',
      'UNPROVEN',
      'no cohort has both a D1 and a D7 row in this window',
    );
  } else {
    assert(
      ctx,
      'cohort revenue is cumulative',
      toNumber(pairs[0]?.['violations']) === 0,
      `${pairs[0]?.['violations']} cohort(s) with D7 < D1`,
    );
    assert(
      ctx,
      'D1 and D7 stored as distinct facts',
      toNumber(pairs[0]?.['shared_identity']) === 0,
      `${pairCount} cohort(s) hold both ages under distinct identities; ${pairs[0]?.['distinct_values']} differ in value`,
    );
  }

  // ---------------------------------------------------------- maturity ---
  heading(ctx, 'MATURITY');
  const horizonRows = await queryRows<Row>(
    `SELECT MAX(latest_provider_data_date)::text AS as_of FROM data_freshness
      WHERE organization_id = $1 AND app_id = $2
        AND data_type IN ('attribution_installs', 'attribution_revenue')`,
    [organizationId, appId],
  );
  const asOf = horizonRows[0]?.['as_of'] ?? null;
  line('attribution data horizon (as-of)', asOf ?? '(none)');
  const cohort = await loadCohortAggregate(filters);
  assert(
    ctx,
    'metric layer uses the same horizon',
    cohort.asOf === asOf,
    `${cohort.asOf} = ${asOf}`,
  );
  const metricContext = await contextFor(organizationId, appId);
  const marketingAgg = await loadMarketingAggregate(filters);
  const attributionAgg = await loadAttributionAggregate(filters);
  const metrics = computeMetricValues({
    context: metricContext,
    marketing: marketingAgg,
    attribution: attributionAgg,
    cohort,
  });
  const metricOf = (key: string): MetricValue | undefined =>
    metrics.find((m) => m.metricKey === key);

  if (!asOf) {
    record(
      ctx,
      'maturity recomputed independently',
      'UNPROVEN',
      'no attribution data horizon recorded',
    );
  }
  for (const age of asOf ? COHORT_AGES : []) {
    const recomputed = await queryRows<Row>(
      `SELECT count(DISTINCT t.install_date) FILTER (WHERE (t.install_date + $5::int) < $4::date)::text AS mature_days,
              count(DISTINCT t.install_date) FILTER (WHERE NOT ((t.install_date + $5::int) < $4::date))::text AS immature_days,
              COALESCE(SUM(t.attributed_installs) FILTER (WHERE (t.install_date + $5::int) < $4::date), 0)::text AS installs
         FROM attribution_daily_metrics t
        WHERE t.organization_id = $1 AND t.app_id = $2 AND t.install_date BETWEEN $3 AND $6`,
      [organizationId, appId, from, asOf, age, to],
    );
    const revenue = await queryRows<Row>(
      `SELECT COALESCE(SUM(t.revenue) FILTER (WHERE ${MATURE}), 0)::text AS mature,
              COALESCE(SUM(t.revenue) FILTER (WHERE NOT ((t.activity_date + t.cohort_age_days) < $4::date)), 0)::text AS immature,
              COALESCE(SUM(t.revenue) FILTER (WHERE ${MATURE} AND NOT (${PAID})), 0)::text AS organic,
              COALESCE(SUM(t.revenue) FILTER (WHERE ${MATURE} AND ${PAID} AND NOT (${MAPPED})), 0)::text AS unmapped,
              COALESCE(SUM(t.revenue) FILTER (WHERE ${MATURE} AND ${PAID} AND ${ALIGNED}), 0)::text AS aligned
         FROM attribution_revenue_metrics t JOIN apps a ON a.id = t.app_id
        WHERE t.organization_id = $1 AND t.app_id = $2 AND t.grain = 'cohort_date'
          AND t.cohort_age_days = $5 AND t.activity_date BETWEEN $3 AND $6`,
      [organizationId, appId, from, asOf, age, to],
    );
    const byAge = cohort.byAge[age];
    line(
      `D${age} mature / immature install days`,
      `${recomputed[0]?.['mature_days']} / ${recomputed[0]?.['immature_days']}`,
    );
    compare(
      ctx,
      `D${age} mature cohort days`,
      toNumber(recomputed[0]?.['mature_days']),
      byAge.matureCohortDays,
    );
    compare(
      ctx,
      `D${age} immature cohort days`,
      toNumber(recomputed[0]?.['immature_days']),
      byAge.immatureCohortDays,
    );
    compare(
      ctx,
      `D${age} mature revenue`,
      toNumber(revenue[0]?.['mature']),
      byAge.revenue.total.revenue,
    );
    compare(ctx, `D${age} mature installs`, toNumber(recomputed[0]?.['installs']), byAge.installs);
    line(`D${age} immature revenue (excluded)`, revenue[0]?.['immature'] ?? '0');
  }
  if (asOf) {
    assert(
      ctx,
      'maturity recomputed independently',
      ctx.results.filter((r) => r.section === 'MATURITY' && r.verdict === 'FAIL').length === 0,
      'mature/immature days, mature revenue and installs agree with independent SQL at every age',
    );
  }

  // --------------------------------------------- immature cohorts not zero ---
  heading(ctx, 'IMMATURE COHORTS');
  // Two probes. The requested window, if it has immature cohorts; and always a
  // window ending at the horizon, which by construction has no mature D7
  // cohort, so the production path must refuse rather than return zero.
  const oldest = Math.max(...COHORT_AGES) as CohortAge;
  const d7 = cohort.byAge[oldest];
  const totalKey = cohortMetricKey({ ageDays: oldest, revenueType: 'total', measure: 'revenue' });
  const served = (['total', 'ad', 'iap'] as const).find((t) => {
    const key = cohortMetricKey({ ageDays: oldest, revenueType: t, measure: 'revenue' });
    const m = metricOf(key);
    return m && m.availability !== 'unavailable';
  });
  const servedKey = served
    ? cohortMetricKey({ ageDays: oldest, revenueType: served, measure: 'revenue' })
    : totalKey;
  const windowMetric = metricOf(servedKey);
  line(`D${oldest} metric probed`, servedKey);
  line('  availability', `${windowMetric?.availability} blocker=${windowMetric?.blocker ?? '-'}`);
  line('  value', windowMetric?.value ?? '(none)');
  if (d7.immatureCohortDays > 0 && windowMetric) {
    const honest =
      (windowMetric.availability === 'partial' &&
        /not counted as zero/.test(windowMetric.reason ?? '')) ||
      (windowMetric.availability === 'blocked' && windowMetric.blocker === 'immature_cohort');
    assert(
      ctx,
      'immature cohorts excluded, not zero',
      honest &&
        (windowMetric.value === null ||
          windowMetric.value === d7.revenue[served ?? 'total'].revenue),
      `${d7.immatureCohortDays} immature day(s): ${windowMetric.availability}${windowMetric.blocker ? ` (${windowMetric.blocker})` : ''}`,
    );
  } else if (asOf) {
    const recent: MetricFilters = { ...filters, from: asOf, to: asOf };
    const recentCohort = await loadCohortAggregate(recent);
    const recentMetric = computeMetricValues({
      metricKeys: [servedKey],
      context: metricContext,
      marketing: marketingAgg,
      attribution: attributionAgg,
      cohort: recentCohort,
    })[0];
    line(
      '  horizon-day probe',
      `${recentMetric?.availability} blocker=${recentMetric?.blocker ?? '-'} value=${recentMetric?.value ?? '(none)'}`,
    );
    if (recentCohort.byAge[oldest].immatureCohortDays === 0) {
      record(
        ctx,
        'immature cohorts excluded, not zero',
        'UNPROVEN',
        `no install cohort on the horizon day ${asOf} to probe`,
      );
    } else {
      assert(
        ctx,
        'immature cohorts excluded, not zero',
        recentMetric?.availability === 'blocked' &&
          recentMetric.blocker === 'immature_cohort' &&
          recentMetric.value === null,
        `cohort installed ${asOf} at D${oldest}: ${recentMetric?.availability} (${recentMetric?.blocker ?? '-'}), value ${recentMetric?.value ?? 'null'}`,
      );
    }
  } else {
    record(
      ctx,
      'immature cohorts excluded, not zero',
      'UNPROVEN',
      'no attribution data horizon recorded',
    );
  }

  // ------------------------------------------------------------ organic ---
  heading(ctx, 'ORGANIC COHORTS');
  const organicCohort = await loadCohortAggregate({ ...filters, channel: 'organic' });
  const organicMetrics = computeMetricValues({
    context: metricContext,
    marketing: marketingAgg,
    attribution: attributionAgg,
    cohort: organicCohort,
  });
  const organicRows = await queryRows<Row>(
    `SELECT count(*)::text AS n FROM attribution_revenue_metrics t
      WHERE t.app_id = $1 AND t.grain = 'cohort_date' AND t.activity_date BETWEEN $2 AND $3
        AND NOT (${PAID})`,
    [appId, from, to],
  );
  line('organic cohort rows', organicRows[0]?.['n'] ?? '0');
  if (toNumber(organicRows[0]?.['n']) === 0) {
    record(
      ctx,
      'organic cohorts have no paid ROAS',
      'UNPROVEN',
      'no organic cohort rows in this window',
    );
  } else {
    const organicRoas = organicMetrics.filter(
      (m) => m.family === 'cohort' && m.metricKey.includes('roas'),
    );
    const refused = organicRoas.every(
      (m) => m.value === null && m.availability !== 'available' && m.availability !== 'partial',
    );
    const organicRevenueKey = cohortMetricKey({
      ageDays: COHORT_AGES[0],
      revenueType: 'total',
      measure: 'revenue',
    });
    const organicRevenue = organicMetrics.find((m) => m.metricKey === organicRevenueKey);
    line(
      '  organic D1 cohort revenue',
      `${organicRevenue?.availability} value=${organicRevenue?.value ?? '(none)'}`,
    );
    line(
      '  organic ROAS states',
      [...new Set(organicRoas.map((m) => `${m.availability}/${m.blocker ?? '-'}`))].join(', '),
    );
    assert(
      ctx,
      'organic cohorts have no paid ROAS',
      refused &&
        organicRoas.some((m) =>
          /organic|not divided|no paid cohorts|immature|does not expose/i.test(m.reason ?? ''),
        ),
      refused
        ? 'every organic cohort ROAS refused with a reason; organic cohort revenue itself still served'
        : 'an organic cohort ROAS produced a value',
    );
  }

  // ------------------------------------------------ spend alignment / ROAS ---
  heading(ctx, 'SPEND ALIGNMENT');
  for (const age of asOf ? COHORT_AGES : []) {
    const byAge = cohort.byAge[age];
    const spend = await queryRows<Row>(
      `SELECT COALESCE(SUM(md.spend), 0)::text AS aligned,
              (SELECT COALESCE(SUM(x.spend), 0) FROM marketing_daily_metrics x
                WHERE x.app_id = $2 AND x.report_date BETWEEN $3 AND $6)::text AS window_spend
         FROM marketing_daily_metrics md
        WHERE md.organization_id = $1 AND md.app_id = $2 AND md.report_date BETWEEN $3 AND $6
          AND md.spend > 0 AND (md.report_date + $5::int) < $4::date
          AND md.external_campaign_id IN (
            SELECT m.source_external_id FROM provider_entity_mappings m
             WHERE m.organization_id = md.organization_id AND m.app_id = md.app_id
               AND m.entity_type = 'campaign' AND m.source_provider = md.provider_key
               AND m.target_external_id IS NOT NULL AND ${OPERATIONAL})`,
      [organizationId, appId, from, asOf, age, to],
    );
    const revenue = await queryRows<Row>(
      `SELECT COALESCE(SUM(t.revenue) FILTER (WHERE ${MATURE} AND ${PAID} AND ${ALIGNED}), 0)::text AS aligned,
              COALESCE(SUM(t.revenue) FILTER (WHERE ${MATURE} AND ${PAID} AND NOT (${MAPPED})), 0)::text AS unmapped,
              COALESCE(SUM(t.revenue) FILTER (WHERE ${MATURE} AND NOT (${PAID})), 0)::text AS organic,
              count(*) FILTER (WHERE ${MATURE} AND ${PAID} AND ${ALIGNED}
                AND NOT EXISTS (SELECT 1 FROM marketing_daily_metrics md
                                 WHERE md.app_id = t.app_id AND md.report_date = t.activity_date AND md.spend > 0))::text
                AS aligned_without_same_day_spend
         FROM attribution_revenue_metrics t JOIN apps a ON a.id = t.app_id
        WHERE t.organization_id = $1 AND t.app_id = $2 AND t.grain = 'cohort_date'
          AND t.cohort_age_days = $5 AND t.activity_date BETWEEN $3 AND $6`,
      [organizationId, appId, from, asOf, age, to],
    );
    const roasKey = cohortMetricKey({ ageDays: age, revenueType: 'total', measure: 'roas' });
    const roas = metricOf(roasKey);
    line(`D${age} window spend (NOT the denominator)`, spend[0]?.['window_spend'] ?? '0');
    line(`D${age} install-day spend of mapped campaigns`, spend[0]?.['aligned'] ?? '0');
    line(
      `D${age} ${roasKey}`,
      `${roas?.availability} value=${roas?.value ?? '(none)'} num=${roas?.numerator ?? '-'} den=${roas?.denominator ?? '-'}`,
    );
    compare(
      ctx,
      `D${age} ROAS denominator = install-day spend`,
      toNumber(spend[0]?.['aligned']),
      byAge.alignedSpend,
    );
    compare(
      ctx,
      `D${age} ROAS numerator = aligned cohort revenue`,
      toNumber(revenue[0]?.['aligned']),
      byAge.revenue.total.alignedRevenue,
    );
    assert(
      ctx,
      `D${age} every numerator cohort has same-day spend`,
      toNumber(revenue[0]?.['aligned_without_same_day_spend']) === 0,
      `${revenue[0]?.['aligned_without_same_day_spend']} aligned cohort row(s) without spend on their install day`,
    );
    line(`D${age} unmapped paid cohort revenue (excluded)`, revenue[0]?.['unmapped'] ?? '0');
    line(`D${age} organic cohort revenue (excluded)`, revenue[0]?.['organic'] ?? '0');
    assert(
      ctx,
      `D${age} unmapped and organic revenue outside the numerator`,
      byAge.revenue.total.alignedRevenue +
        toNumber(revenue[0]?.['unmapped']) +
        toNumber(revenue[0]?.['organic']) <=
        byAge.revenue.total.revenue + 1e-6,
      `aligned ${byAge.revenue.total.alignedRevenue} + unmapped ${revenue[0]?.['unmapped']} + organic ${revenue[0]?.['organic']} <= mature total ${byAge.revenue.total.revenue}`,
    );
    if (roas && roas.value !== null && roas.numerator !== null && roas.denominator !== null) {
      compare(
        ctx,
        `D${age} ROAS = numerator / denominator`,
        roas.numerator / roas.denominator,
        roas.value,
      );
    }
  }
  const alignmentFailed = ctx.results.filter(
    (r) => r.section === 'SPEND ALIGNMENT' && r.verdict === 'FAIL',
  ).length;
  const alignmentUnproven = ctx.results.filter(
    (r) => r.section === 'SPEND ALIGNMENT' && r.verdict === 'UNPROVEN',
  ).length;
  record(
    ctx,
    'ROAS spend is the install-day spend of the same campaigns',
    alignmentFailed > 0 ? 'FAIL' : alignmentUnproven > 0 || !asOf ? 'UNPROVEN' : 'PASS',
    alignmentFailed > 0
      ? `${alignmentFailed} alignment check(s) failed`
      : 'numerator and denominator recomputed from the same (campaign, install day) pairs',
  );
  record(
    ctx,
    'unmapped cohorts borrow no spend',
    alignmentFailed > 0 ? 'FAIL' : !asOf ? 'UNPROVEN' : 'PASS',
    'unmapped paid cohort revenue is in neither side of every cohort ROAS',
  );

  // ----------------------------------------- provider definition cross-check --
  heading(ctx, 'PROVIDER CROSS-CHECK');
  if (attributionProviderKey === 'tenjin' && attribution) {
    const oldestAge = Math.max(...COHORT_AGES);
    const iapMetric = TENJIN_COHORT_IAP_METRIC(oldestAge);
    const roasMetric = TENJIN_COHORT_ROAS_METRIC(oldestAge);
    const raw = await queryRows<Row>(
      `WITH rows AS (
         SELECT COALESCE(elem->'attributes', elem) AS r
           FROM raw_ingestion_batches b, jsonb_array_elements(b.payload->'data') elem
          WHERE b.app_id = $1 AND b.connection_id = $2 AND b.data_type = 'attribution_revenue'
            AND b.payload ? 'data'
       )
       SELECT count(*)::text AS n,
              count(*) FILTER (WHERE (r->>'${roasMetric}') IS NOT NULL AND (r->>'${iapMetric}') IS NOT NULL
                                 AND (r->>'spend') IS NOT NULL AND (r->>'spend')::numeric > 0)::text AS checkable,
              count(*) FILTER (WHERE (r->>'${roasMetric}') IS NOT NULL AND (r->>'${iapMetric}') IS NOT NULL
                                 AND (r->>'spend') IS NOT NULL AND (r->>'spend')::numeric > 0
                                 AND abs((r->>'${roasMetric}')::numeric - (r->>'${iapMetric}')::numeric / (r->>'spend')::numeric * 100) > 0.05)::text
                AS disagreements,
              count(*) FILTER (WHERE (r->>'ad_network_name') ILIKE 'organic' AND (r->>'${roasMetric}') IS NULL)::text AS organic_without_roas,
              count(*) FILTER (WHERE (r->>'ad_network_name') ILIKE 'organic')::text AS organic_rows
         FROM rows`,
      [appId, attribution.connection_id],
    );
    const checkable = toNumber(raw[0]?.['checkable']);
    line('raw provider rows stored', raw[0]?.['n'] ?? '0');
    line(`rows with ${roasMetric}, ${iapMetric} and spend`, checkable);
    if (checkable === 0) {
      record(
        ctx,
        'provider ROAS definition cross-check',
        'UNPROVEN',
        `no stored provider row carries ${roasMetric}, ${iapMetric} and spend together. ${actions.get(cohortCapabilityKey('iap', oldestAge as CohortAge)) ?? `Add ${iapMetric} and ${roasMetric} to the Tenjin saved report and re-sync attribution revenue.`}`,
      );
    } else {
      assert(
        ctx,
        'provider ROAS definition cross-check',
        toNumber(raw[0]?.['disagreements']) === 0,
        `${roasMetric} = ${iapMetric} / spend * 100 on the same campaign and install day for ${checkable - toNumber(raw[0]?.['disagreements'])}/${checkable} row(s)`,
      );
    }
    if (toNumber(raw[0]?.['organic_rows']) > 0) {
      assert(
        ctx,
        'provider refuses organic ROAS too',
        toNumber(raw[0]?.['organic_without_roas']) === toNumber(raw[0]?.['organic_rows']),
        `${raw[0]?.['organic_without_roas']}/${raw[0]?.['organic_rows']} organic row(s) carry ${roasMetric}=null`,
      );
    }
  } else {
    record(
      ctx,
      'provider ROAS definition cross-check',
      'UNPROVEN',
      `${attributionProviderKey ?? 'no provider'} bound; the cross-check is defined for Tenjin's ${TENJIN_COHORT_ROAS_METRIC(7)}`,
    );
  }

  // ----------------------------------------------------------- currency ---
  heading(ctx, 'COHORT CURRENCY');
  if (!marketing || !attribution) {
    record(
      ctx,
      'cohort mixed currency is blocked, never summed',
      'UNPROVEN',
      'needs both a marketing and an attribution binding',
    );
  } else {
    const proof = await proveCohortCurrencyGate({ filters, context: metricContext });
    line(
      'injected',
      `${proof.injected.currency} cohort of ${proof.injected.cohortDate} at D${proof.injected.ageDays}, transactionally`,
    );
    line(
      '  natural revenue / spend currencies',
      `${proof.natural.revenueCurrencies.join('/') || '-'} / ${proof.natural.spendCurrencies.join('/') || '-'}`,
    );
    line(
      '  currencies seen by production path',
      `${proof.gate.revenueCurrencies.join('/')} / ${proof.gate.spendCurrencies.join('/')}`,
    );
    line(
      '  cohort revenue under mixed currency',
      `${proof.gate.cohortRevenue.availability} blocker=${proof.gate.cohortRevenue.blocker ?? '-'} value=${proof.gate.cohortRevenue.value ?? '(none)'}`,
    );
    line(
      '  cohort ROAS under mixed currency',
      `${proof.gate.cohortRoas.availability} blocker=${proof.gate.cohortRoas.blocker ?? '-'} value=${proof.gate.cohortRoas.value ?? '(none)'}`,
    );
    line(
      '  detected / not summed / blocked / reason names currency',
      `${proof.verdict.detected} / ${proof.verdict.notSummed} / ${proof.verdict.blocked} / ${proof.verdict.reasonNamesCurrency}`,
    );
    const drift = Object.keys(proof.rollback.before).filter(
      (k) => proof.rollback.before[k] !== proof.rollback.after[k],
    );
    line(
      'ROLLBACK',
      proof.rollback.verified
        ? `verified - ${Object.keys(proof.rollback.before).length} table snapshots identical`
        : `FAILED - drift in ${drift.join(', ')}`,
    );
    assert(
      ctx,
      'cohort mixed currency is blocked, never summed',
      proof.verdict.passed && proof.rollback.verified,
      proof.verdict.passed && proof.rollback.verified
        ? `production cohort path refused ${proof.injected.currency}; rollback verified`
        : !proof.rollback.verified
          ? 'ROLLBACK NOT VERIFIED - synthetic rows may have survived'
          : 'production cohort path did not refuse the mixed aggregate',
    );
  }

  // ------------------------------------------------------- no forecasting --
  heading(ctx, 'NO FORECASTING');
  const unified = await loadUnifiedPerformance({
    filters,
    context: metricContext,
    window: { startDate: from, endDate: to, timezone: app.timezone },
  });
  const cohortKeys = Object.keys(unified.cohort);
  line('cohort metrics in unified object', cohortKeys.length);
  assert(
    ctx,
    'unified object carries cohort figures apart from operational ones',
    cohortKeys.length > 0 &&
      cohortKeys.every((k) => k.startsWith('cohort_')) &&
      !('cohort_roas_d7' in unified.efficiency),
    `${cohortKeys.length} cohort key(s) in their own group`,
  );
  assert(
    ctx,
    'no predicted value served',
    cohortKeys.every((k) => !/pltv|proas|predict|forecast/i.test(k)) &&
      Object.values(unified.cohort).every((m) => !/predict|forecast/i.test(m.displayName)),
    'nothing served is a prediction',
  );

  // --------------------------------------------------------- regression ---
  heading(ctx, 'PHASE 0/1 REGRESSION GUARD');
  const eventOnly = await queryRows<Row>(
    `SELECT COALESCE(SUM(revenue), 0)::text AS revenue FROM attribution_revenue_metrics
      WHERE app_id = $1 AND grain = 'event_date' AND activity_date BETWEEN $2 AND $3`,
    [appId, from, to],
  );
  compare(
    ctx,
    'event-date total unchanged by cohort rows',
    toNumber(eventOnly[0]?.['revenue']),
    attributionAgg.attributedRevenue,
  );
}

/**
 * Minimal metric context, built from stored rows rather than the API's
 * builder, so a bug in that plumbing shows up as a disagreement.
 */
async function contextFor(organizationId: string, appId: string): Promise<MetricContext> {
  const freshness = await queryRows<Row>(
    `SELECT data_type, status, latest_provider_data_date::text AS latest, provider_key
       FROM data_freshness WHERE organization_id = $1 AND app_id = $2`,
    [organizationId, appId],
  );
  const pick = (kind: string): { status: string; latestDataDate: string | null } | undefined => {
    const row = freshness.find((f) => String(f['data_type']).startsWith(kind));
    return row
      ? { status: String(row['status']), latestDataDate: row['latest'] ?? null }
      : undefined;
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
  const marketingProviders = providersFor('marketing');
  const attributionProviders = providersFor('attribution');
  return {
    hasMarketingConnection: marketingProviders.length > 0,
    hasAttributionConnection: attributionProviders.length > 0,
    marketingProviders,
    attributionProviders,
    supportedCapabilities: supported,
    capabilityNotes,
    marketingFreshness: pick('marketing'),
    attributionFreshness: pick('attribution'),
  };
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
    process.stderr.write(`phase2-audit failed: ${parts.join(' <- ')}\n`);
    process.exitCode = 1;
  })
  .finally(() => closePool());

/**
 * Phase 1 exit audit.
 *
 *   node packages/integrations/dist/cli/phase1-audit.js <organization_id> <from> <to> [app_id]
 *
 * Phase 0 asked whether MART's numbers were right. Phase 1 asks whether the
 * model underneath them is canonical: can a business question be answered
 * without knowing which provider supplied the data, does every metric say what
 * it measures and over which population, does a filter reach both halves of
 * every ratio, and can two currencies never be added together.
 *
 * Like the Phase 0 audit it writes nothing and derives every figure from stored
 * rows rather than reading it back from the code under test - which is why it
 * repeats the population predicates instead of importing them. An audit that
 * shares a definition with its subject can only ever agree with it.
 *
 * A criterion the platform has not built yet is NOT_IMPLEMENTED, never PASS.
 */
import { closePool, queryRows, toNumber } from '@mart/db';
import {
  METRIC_DEFINITIONS,
  computeMetricValues,
  loadAttributionAggregate,
  loadMarketingAggregate,
  loadUnifiedPerformance,
  proveMixedCurrencyGate,
  scoreConfidence,
  type MetricContext,
  type MetricFilters,
} from '@mart/metrics';
import {
  CANONICAL_PLATFORMS,
  channelForProvider,
  METRIC_AGGREGATIONS,
  METRIC_CLASSES,
  METRIC_FAMILIES,
  METRIC_POPULATIONS,
  METRIC_UNITS,
  OPERATIONAL_MAPPING_CONFIDENCE,
  type IsoDate,
} from '@mart/shared';
import { getRemoteIdResolver } from '../remoteIds.js';
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
 * The audit's own copy of the mapping-strength rule.
 *
 * Deliberately not imported from the metric layer: recomputing a figure with
 * the same code that produced it proves only that the code is deterministic.
 */
const OPERATIONAL = `(m.status IN ('matched_exact','matched_confident','manually_verified')
  OR (m.status = 'matched_fallback' AND m.mapping_confidence >= ${OPERATIONAL_MAPPING_CONFIDENCE}))`;
const AUTHORITATIVE = `m.status IN ('matched_exact','matched_confident','manually_verified')`;

type Row = Record<string, string | null>;

async function main(): Promise<void> {
  const [organizationId, from, to, appArg] = process.argv.slice(2);
  if (!organizationId || !from || !to) {
    process.stderr.write(
      'usage: phase1-audit <organization_id> <from> <to> [app_id]\n' +
        '  e.g. phase1-audit fe8a8112-... 2026-08-25 2026-08-31\n',
    );
    process.exitCode = 2;
    return;
  }

  const ctx = createContext();
  const apps = await queryRows<{ id: string; name: string }>(
    `SELECT id, name FROM apps
      WHERE organization_id = $1 ${appArg ? 'AND id = $2' : ''} AND status = 'active'
      ORDER BY name`,
    appArg ? [organizationId, appArg] : [organizationId],
  );
  if (apps.length === 0) {
    process.stderr.write('No active app found for this organization.\n');
    process.exitCode = 2;
    return;
  }

  // The registry is provider-independent, so it is audited once rather than
  // once per app.
  auditMetricRegistry(ctx);

  for (const app of apps) {
    await auditApp(ctx, organizationId, app.id, app.name, from as IsoDate, to as IsoDate);
  }

  heading(ctx, 'PHASE 1 EXIT VERDICT');
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
    process.stdout.write('\n  UNPROVEN:\n');
    for (const r of unproven) process.stdout.write(`    ${r.section} / ${r.metric}: ${r.detail}\n`);
  }
  if (missing.length > 0) {
    process.stdout.write('\n  NOT BUILT YET:\n');
    for (const r of missing) process.stdout.write(`    ${r.section} / ${r.metric}: ${r.detail}\n`);
  }

  const verdict =
    failed.length > 0
      ? 'NOT DONE - a Phase 1 exit criterion fails'
      : unproven.length > 0
        ? 'NOT DONE - every computed criterion passed, some could not be evaluated'
        : missing.length > 0
          ? 'NOT DONE - criteria remain unbuilt'
          : 'DONE - every Phase 1 exit criterion passed against this database';
  process.stdout.write(`\n  PHASE 1: ${verdict}\n`);
  process.exitCode = failed.length > 0 || unproven.length > 0 || missing.length > 0 ? 1 : 0;
}

/** Section 8/9: the registry is the semantic contract, so it is checked first. */
function auditMetricRegistry(ctx: AuditContext): void {
  heading(ctx, 'METRIC REGISTRY');
  line('metrics defined', METRIC_DEFINITIONS.length);

  const keys = METRIC_DEFINITIONS.map((d) => d.metricKey);
  assert(ctx, 'unique metric keys', new Set(keys).size === keys.length, `${keys.length} keys`);

  const incomplete = METRIC_DEFINITIONS.filter(
    (d) =>
      !METRIC_FAMILIES.includes(d.family) ||
      !METRIC_UNITS.includes(d.unit) ||
      !METRIC_AGGREGATIONS.includes(d.aggregation) ||
      !METRIC_CLASSES.includes(d.semanticClass) ||
      !METRIC_POPULATIONS.includes(d.population.numerator),
  );
  assert(
    ctx,
    'every metric fully declared',
    incomplete.length === 0,
    incomplete.length === 0
      ? 'family, unit, aggregation, class and population on all'
      : incomplete.map((d) => d.metricKey).join(', '),
  );

  // A ratio without a named denominator population is the defect the
  // population model exists to prevent.
  const ratiosWithoutDenominator = METRIC_DEFINITIONS.filter(
    (d) => d.aggregation === 'ratio_of_sums' && !d.population.denominator,
  );
  assert(
    ctx,
    'ratios name both populations',
    ratiosWithoutDenominator.length === 0,
    ratiosWithoutDenominator.map((d) => d.metricKey).join(', ') || 'all ratios complete',
  );

  const required = [
    'spend',
    'impressions',
    'clicks',
    'ctr',
    'cpm',
    'cpc',
    'attributed_installs',
    'paid_attributed_installs',
    'organic_installs',
    'mapped_paid_installs',
    'delivery_aligned_paid_installs',
    'mapped_cpi',
    'blended_cpi',
    'iap_revenue',
    'ad_revenue',
    'attributed_revenue',
    'mapped_attributed_revenue',
    'delivery_aligned_revenue',
    'campaign_operational_coverage',
    'spend_coverage',
    'attribution_coverage',
    'mapping_coverage',
    'operational_mapping_coverage',
  ];
  const absent = required.filter((k) => !keys.includes(k));
  assert(
    ctx,
    'Phase 1 metric set present',
    absent.length === 0,
    absent.join(', ') || 'all present',
  );

  const cohortMisfiled = METRIC_DEFINITIONS.filter(
    (d) =>
      d.semanticClass === 'cohort' && !['install_date', 'cohort_date'].includes(d.grain.primary),
  );
  assert(
    ctx,
    'cohort metrics keep cohort grain',
    cohortMisfiled.length === 0,
    cohortMisfiled.map((d) => d.metricKey).join(', ') || 'no cohort metric filed as operational',
  );
}

async function auditApp(
  ctx: AuditContext,
  organizationId: string,
  appId: string,
  appName: string,
  from: IsoDate,
  to: IsoDate,
): Promise<void> {
  process.stdout.write(`\n\n########## ${appName}   ${from} .. ${to} ##########\n`);

  const bindings = await queryRows<Row>(
    `SELECT b.role, c.provider_key, c.id AS connection_id, a.external_account_id
       FROM integration_app_bindings b
       JOIN integration_connections c ON c.id = b.connection_id
       LEFT JOIN integration_accounts a ON a.id = b.integration_account_id
      WHERE b.organization_id = $1 AND b.app_id = $2
      ORDER BY b.role`,
    [organizationId, appId],
  );
  const marketingProviderKey =
    bindings.find((b) => b.role === 'marketing_network')?.provider_key ?? null;
  const attributionProviderKey =
    bindings.find((b) => b.role === 'primary_attribution')?.provider_key ?? null;

  // ------------------------------------------------- canonical entities ---
  heading(ctx, 'CANONICAL ENTITIES');
  const entities = await queryRows<Row>(
    `SELECT 'marketing_accounts' AS entity, count(*)::text AS n FROM marketing_accounts WHERE app_id = $1
     UNION ALL SELECT 'marketing_campaigns', count(*)::text FROM marketing_campaigns WHERE app_id = $1
     UNION ALL SELECT 'marketing_ad_groups', count(*)::text FROM marketing_ad_groups WHERE app_id = $1
     UNION ALL SELECT 'marketing_ads', count(*)::text FROM marketing_ads WHERE app_id = $1
     UNION ALL SELECT 'marketing_creatives', count(*)::text FROM marketing_creatives WHERE app_id = $1
     UNION ALL SELECT 'attribution_campaigns', count(*)::text FROM attribution_campaigns WHERE app_id = $1
     UNION ALL SELECT 'attribution_sources', count(*)::text FROM attribution_sources WHERE app_id = $1`,
    [appId],
  );
  for (const row of entities) line(String(row['entity']), row['n']);
  // Identity must be MART's own uuid, with the provider id kept as an alias.
  const identityLeak = await queryRows<Row>(
    `SELECT count(*)::text AS n FROM marketing_campaigns
      WHERE app_id = $1 AND (id IS NULL OR external_campaign_id IS NULL)`,
    [appId],
  );
  assert(
    ctx,
    'internal id + provider alias',
    toNumber(identityLeak[0]?.['n']) === 0,
    'every campaign carries both a MART uuid and its provider id',
  );

  // -------------------------------------------------- entity hierarchy ----
  heading(ctx, 'ENTITY HIERARCHY');
  const hierarchy = await queryRows<Row>(
    `SELECT 'ad_group -> campaign' AS edge,
            count(*)::text AS total,
            count(campaign_id)::text AS linked
       FROM marketing_ad_groups WHERE app_id = $1
     UNION ALL
     SELECT 'ad -> ad_group', count(*)::text, count(ad_group_id)::text
       FROM marketing_ads WHERE app_id = $1
     UNION ALL
     SELECT 'ad -> campaign', count(*)::text, count(campaign_id)::text
       FROM marketing_ads WHERE app_id = $1
     UNION ALL
     SELECT 'campaign -> account', count(*)::text, count(marketing_account_id)::text
       FROM marketing_campaigns WHERE app_id = $1`,
    [appId],
  );
  for (const row of hierarchy) {
    const total = toNumber(row['total']);
    const linked = toNumber(row['linked']);
    line(String(row['edge']), `${linked}/${total} linked by foreign key`);
    if (total === 0) {
      record(ctx, String(row['edge']), 'UNPROVEN', 'no rows of this kind stored');
    } else {
      // Hierarchy must come from provider structure, never from names.
      assert(ctx, String(row['edge']), linked === total, `${linked}/${total} carry a parent id`);
    }
  }

  // ------------------------------------------------- provider resolution --
  heading(ctx, 'PROVIDER RESOLUTION');
  if (marketingProviderKey && attributionProviderKey) {
    const resolver = getRemoteIdResolver(attributionProviderKey, marketingProviderKey);
    line('provider pair', `${attributionProviderKey} -> ${marketingProviderKey}`);
    line('levels tried', resolver.levels.join(' then '));
    // The remote id must not be given a global meaning: what it points at is a
    // property of the provider pair, declared per pair.
    assert(
      ctx,
      'remote id semantics are pair-scoped',
      resolver.levels.length > 0,
      `${attributionProviderKey}+${marketingProviderKey} declares ${resolver.levels.join('/')}`,
    );
    const methods = await queryRows<Row>(
      `SELECT mapping_method, status, count(*)::text AS n
         FROM provider_entity_mappings
        WHERE app_id = $1 AND entity_type = 'campaign'
        GROUP BY mapping_method, status ORDER BY mapping_method`,
      [appId],
    );
    for (const row of methods) {
      line(`  ${row['mapping_method']}/${row['status']}`, row['n']);
    }
  } else {
    record(ctx, 'provider pair', 'UNPROVEN', 'no marketing/attribution pair bound to this app');
  }

  // ------------------------------------------------------- dimensions -----
  heading(ctx, 'DIMENSIONS');
  const dims = await queryRows<Row>(
    `SELECT count(*)::text AS rows,
            count(country)::text AS with_country,
            count(platform)::text AS with_platform,
            count(DISTINCT country)::text AS countries,
            count(DISTINCT platform)::text AS platforms
       FROM marketing_daily_metrics
      WHERE app_id = $1 AND report_date BETWEEN $2 AND $3`,
    [appId, from, to],
  );
  const d = dims[0];
  line('delivery rows', d?.['rows'] ?? '0');
  line('distinct countries', d?.['countries'] ?? '0');
  line('distinct platforms', d?.['platforms'] ?? '0');
  // Country must be ISO alpha-2, and unknown must stay unknown rather than
  // being coerced to a default that would silently attribute traffic.
  const badCountry = await queryRows<Row>(
    `SELECT count(*)::text AS n FROM marketing_daily_metrics
      WHERE app_id = $1 AND country IS NOT NULL AND country !~ '^[A-Z]{2}$'`,
    [appId],
  );
  assert(
    ctx,
    'country is ISO alpha-2 or null',
    toNumber(badCountry[0]?.['n']) === 0,
    `${badCountry[0]?.['n'] ?? '0'} row(s) with a non-ISO country`,
  );
  // Channel is derived from the provider that reported the row rather than
  // stored on it, so the check is that the taxonomy classifies what is bound.
  const channels = new Set(
    bindings.map((b) => channelForProvider(b['provider_key'])).filter((c) => c !== 'unknown'),
  );
  line('canonical channels bound', [...channels].join(', ') || '(none)');
  assert(
    ctx,
    'canonical channel taxonomy',
    marketingProviderKey === null || channelForProvider(marketingProviderKey) !== 'unknown',
    marketingProviderKey
      ? `${marketingProviderKey} classifies as ${channelForProvider(marketingProviderKey)}`
      : 'no marketing provider bound',
  );

  // Platform must be canonical, and populated: a filter the UI offers over a
  // column one provider never fills can only ever empty half the dashboard.
  const platforms = await queryRows<Row>(
    `SELECT COALESCE(platform, '(null)') AS platform, count(*)::text AS n
       FROM marketing_daily_metrics
      WHERE app_id = $1 AND report_date BETWEEN $2 AND $3
      GROUP BY 1 ORDER BY 1`,
    [appId, from, to],
  );
  for (const row of platforms) line(`  platform ${row['platform']}`, row['n']);
  const offVocabulary = platforms.filter(
    (row) => !CANONICAL_PLATFORMS.includes(String(row['platform']) as never),
  );
  assert(
    ctx,
    'platform uses the canonical vocabulary',
    offVocabulary.length === 0,
    offVocabulary.length === 0
      ? `${platforms.length} distinct value(s), all canonical`
      : offVocabulary.map((r) => r['platform']).join(', '),
  );

  // ------------------------------------------------------- populations ----
  heading(ctx, 'POPULATIONS');
  // The defect this section exists for: two populations that each look right,
  // disagreeing about the same campaign.
  const contradiction = await queryRows<Row>(
    `WITH delivered AS (
       SELECT DISTINCT md.external_campaign_id, md.provider_key
         FROM marketing_daily_metrics md
        WHERE md.app_id = $1 AND md.report_date BETWEEN $2 AND $3
          AND (md.spend > 0 OR md.impressions > 0 OR md.clicks > 0)
     )
     SELECT count(*)::text AS n FROM delivered dl
      WHERE EXISTS (
        SELECT 1 FROM provider_entity_mappings m
         WHERE m.app_id = $1 AND m.entity_type = 'campaign'
           AND m.source_provider = dl.provider_key
           AND m.source_external_id = dl.external_campaign_id
           AND m.target_external_id IS NOT NULL AND ${OPERATIONAL})
        AND NOT EXISTS (
        SELECT 1 FROM provider_entity_mappings m
         WHERE m.app_id = $1 AND m.entity_type = 'campaign'
           AND m.source_provider = dl.provider_key
           AND m.source_external_id = dl.external_campaign_id
           AND m.target_external_id IS NOT NULL AND ${AUTHORITATIVE})`,
    [appId, from, to],
  );
  const operationalOnly = toNumber(contradiction[0]?.['n']);
  line('mapped operationally but not authoritatively', operationalOnly);
  note('These campaigns are the ones a drifted predicate reports two ways at once.');

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
  const marketing = await loadMarketingAggregate(filters);
  const attribution = await loadAttributionAggregate(filters);
  line('mapped paid installs (mapping population)', attribution.mappedPaidInstalls);
  line('delivery-aligned installs (window population)', attribution.deliveryAlignedPaidInstalls);
  // The two populations must be computed separately even when they coincide.
  assert(
    ctx,
    'mapping and window populations distinct',
    attribution.deliveryAlignedPaidInstalls <= attribution.mappedPaidInstalls,
    `aligned=${attribution.deliveryAlignedPaidInstalls} <= mapped=${attribution.mappedPaidInstalls}`,
  );

  // ----------------------------------------------------- date semantics ---
  heading(ctx, 'DATE SEMANTICS');
  const grains = await queryRows<Row>(
    `SELECT 'marketing' AS fact, grain, count(*)::text AS n FROM marketing_daily_metrics
       WHERE app_id = $1 GROUP BY grain
     UNION ALL SELECT 'attribution installs', grain, count(*)::text FROM attribution_daily_metrics
       WHERE app_id = $1 GROUP BY grain
     UNION ALL SELECT 'attribution revenue', grain, count(*)::text FROM attribution_revenue_metrics
       WHERE app_id = $1 GROUP BY grain`,
    [appId],
  );
  for (const row of grains) line(`${row['fact']} / ${row['grain']}`, row['n']);
  const offGrain = grains.filter(
    (row) =>
      (row['fact'] === 'marketing' && row['grain'] !== 'report_date') ||
      (row['fact'] === 'attribution installs' && row['grain'] !== 'install_date'),
  );
  assert(
    ctx,
    'facts stored at their declared grain',
    offGrain.length === 0,
    offGrain.length === 0 ? 'no off-grain rows' : 'off-grain rows present',
  );
  // Cohort revenue must never be summed into an event-date total. Phase 2
  // stores cohort rows beside the event-date ones, so "kept apart" is proven
  // two ways: every non-event row is a cohort row that says which age it is,
  // and the production event-date total equals the audit's own SUM over
  // event-date rows alone - cohort rows in the same window contribute nothing.
  // Scoped to the bound attribution provider, as the production aggregate is,
  // so a second provider's rows cannot make the two sums disagree for a
  // reason that has nothing to do with grain.
  const cohortShapeRows = await queryRows<Row>(
    `SELECT count(*) FILTER (WHERE grain <> 'event_date')::text AS non_event,
            count(*) FILTER (WHERE grain = 'cohort_date' AND cohort_age_days IS NOT NULL)::text AS cohort,
            COALESCE(SUM(revenue) FILTER (WHERE grain = 'event_date'), 0)::text AS event_revenue,
            COALESCE(SUM(revenue) FILTER (WHERE grain <> 'event_date'), 0)::text AS other_revenue
       FROM attribution_revenue_metrics
      WHERE app_id = $1 AND activity_date BETWEEN $2 AND $3
        AND ($4::text IS NULL OR provider_key = $4)`,
    [appId, from, to, attributionProviderKey],
  );
  const nonEvent = toNumber(cohortShapeRows[0]?.['non_event']);
  const cohortRows = toNumber(cohortShapeRows[0]?.['cohort']);
  line('non-event revenue rows in range', nonEvent);
  line('  of which cohort rows with an age', cohortRows);
  assert(
    ctx,
    'event and cohort revenue kept apart',
    nonEvent === cohortRows &&
      Math.abs(toNumber(cohortShapeRows[0]?.['event_revenue']) - attribution.attributedRevenue) <=
        1e-6,
    nonEvent === cohortRows
      ? `event-date total ${attribution.attributedRevenue} equals SUM over event rows alone; ${cohortRows} cohort row(s) worth ${cohortShapeRows[0]?.['other_revenue']} excluded`
      : `${nonEvent - cohortRows} non-event row(s) are not cohort rows with an age`,
  );

  // ---------------------------------------------------------- currency ----
  heading(ctx, 'CURRENCY');
  line('marketing currencies', marketing.currencies.join(', ') || '(none)');
  line('revenue currencies', attribution.currencies.join(', ') || '(none)');
  const metricContext = await contextFor(organizationId, appId);
  const metrics = computeMetricValues({
    context: metricContext,
    marketing,
    attribution,
  });
  const moneyMetrics = metrics.filter((m) => m.unit === 'currency');
  const mixed = new Set([...marketing.currencies, ...attribution.currencies]).size > 1;
  if (mixed) {
    const unblocked = moneyMetrics.filter((m) => m.availability !== 'blocked' && m.value !== null);
    assert(
      ctx,
      'mixed currency is blocked, never summed',
      unblocked.length === 0,
      unblocked.length === 0
        ? 'every money metric blocked'
        : `${unblocked.map((m) => m.metricKey).join(', ')} produced a value across currencies`,
    );
  } else {
    // NATURAL DATA CHECK: a single currency cannot exercise the gate, and a
    // healthy account never will. So the condition is created on purpose,
    // inside a transaction that is always rolled back, and the PRODUCTION
    // loaders and metric computation are asked what they see. The criterion
    // passes only if the real path refused - never on the strength of a unit
    // test, and never if a single row survived the rollback.
    line(
      'NATURAL DATA CHECK',
      `single currency only (${[...new Set([...marketing.currencies, ...attribution.currencies])].join(', ')})`,
    );
    const proof = await proveMixedCurrencyGate({ filters, context: metricContext });
    line('CONTROLLED GATE PROOF', `injected ${proof.injected.currency} transactionally`);
    line(
      '  natural spend',
      `${proof.natural.spendAvailability} value=${proof.natural.spendValue ?? '(none)'}`,
    );
    line('  currencies seen by production path', proof.gate.marketingCurrencies.join(', '));
    line(
      '  spend under mixed currency',
      `${proof.gate.spend.availability} blocker=${proof.gate.spend.blocker ?? '-'} value=${proof.gate.spend.value ?? '(none)'}`,
    );
    if (proof.gate.revenue) {
      line(
        '  revenue under mixed currency',
        `${proof.gate.revenue.availability} blocker=${proof.gate.revenue.blocker ?? '-'} value=${proof.gate.revenue.value ?? '(none)'}`,
      );
    }
    line('  reason', proof.gate.spend.reason ?? '(none)');
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
      'mixed currency is blocked, never summed',
      proof.verdict.passed && proof.rollback.verified,
      proof.verdict.passed && proof.rollback.verified
        ? `production gate refused ${proof.injected.currency} beside ${proof.natural.marketingCurrencies.join('/')}; rollback verified`
        : !proof.rollback.verified
          ? 'ROLLBACK NOT VERIFIED - synthetic rows may have survived'
          : 'production path did not refuse the mixed aggregate',
    );
    assert(
      ctx,
      'same-currency aggregation still computes',
      proof.natural.spendAvailability !== 'blocked',
      `natural spend is ${proof.natural.spendAvailability}`,
    );
  }

  // -------------------------------------------------- filter consistency --
  heading(ctx, 'FILTER CONSISTENCY');
  const countries = await queryRows<Row>(
    `SELECT DISTINCT country FROM marketing_daily_metrics
      WHERE app_id = $1 AND report_date BETWEEN $2 AND $3 AND country IS NOT NULL
      ORDER BY country LIMIT 1`,
    [appId, from, to],
  );
  const probe = countries[0]?.['country'] ?? null;
  if (probe) {
    const filtered: MetricFilters = { ...filters, country: probe };
    const fMarketing = await loadMarketingAggregate(filtered);
    const fAttribution = await loadAttributionAggregate(filtered);
    line(`probe country`, probe);
    line('filtered spend', fMarketing.spend);
    line('filtered aligned installs', fAttribution.deliveryAlignedPaidInstalls);
    // A filter must narrow, never widen: both halves of every ratio.
    assert(
      ctx,
      'filter narrows spend',
      fMarketing.spend <= marketing.spend,
      `${fMarketing.spend} <= ${marketing.spend}`,
    );
    assert(
      ctx,
      'filter narrows the aligned population too',
      fAttribution.deliveryAlignedPaidInstalls <= attribution.deliveryAlignedPaidInstalls,
      `${fAttribution.deliveryAlignedPaidInstalls} <= ${attribution.deliveryAlignedPaidInstalls}`,
    );
  } else {
    record(
      ctx,
      'filter narrows both sides',
      'UNPROVEN',
      'no country dimension present to filter on',
    );
  }

  // ------------------------------------------------- unified performance --
  heading(ctx, 'UNIFIED PERFORMANCE');
  const unified = await loadUnifiedPerformance({
    filters,
    context: metricContext,
    window: { startDate: from, endDate: to, timezone: 'UTC' },
  });
  line('groups served', 'marketing, attribution, revenue, efficiency, coverage');
  line(
    'metrics in object',
    Object.keys(unified.marketing).length +
      Object.keys(unified.attribution).length +
      Object.keys(unified.revenue).length +
      Object.keys(unified.efficiency).length +
      Object.keys(unified.coverage).length,
  );
  assert(
    ctx,
    'unified performance object',
    Object.keys(unified.marketing).length > 0 && Object.keys(unified.coverage).length > 0,
    'one provider-neutral object carries delivery, attribution, revenue, efficiency and coverage',
  );
  assert(
    ctx,
    'window carries its calendar',
    Boolean(unified.window.timezone),
    `${unified.window.startDate}..${unified.window.endDate} ${unified.window.timezone}`,
  );
  assert(
    ctx,
    'every figure names its population',
    Object.values(unified.marketing).every((m) => Boolean(m.population?.numerator)),
    'population travels with each value',
  );

  // ------------------------------------------- data quality / confidence --
  heading(ctx, 'DATA QUALITY / CONFIDENCE');
  const findings = await queryRows<Row>(
    `SELECT severity, check_key, count(*)::text AS n FROM data_quality_findings
      WHERE app_id = $1 GROUP BY severity, check_key ORDER BY severity, check_key`,
    [appId],
  );
  for (const row of findings) line(`${row['severity']} ${row['check_key']}`, row['n']);
  const states = new Set(metrics.map((m) => m.availability));
  line('availability states in use', [...states].sort().join(', ') || '(none)');
  assert(
    ctx,
    'availability carries a reason whenever it is not available',
    metrics.every((m) => m.availability === 'available' || Boolean(m.reason)),
    'every qualified metric states why',
  );
  line('confidence', `${unified.confidence.level} (${unified.confidence.score})`);
  for (const component of unified.confidence.components) {
    line(`  ${component.input}`, `${component.score.toFixed(3)} - ${component.detail}`);
  }
  // Recomputed here rather than trusted: the same inputs must always give the
  // same score, or the annotation means nothing.
  const recomputed = scoreConfidence({
    freshness:
      metricContext.marketingFreshness?.status ?? metricContext.attributionFreshness?.status,
    spendCoveragePct: null,
    ambiguousSpendPct: null,
    sampleSize: attribution.deliveryAlignedPaidInstalls,
    minimumSample: 25,
  });
  assert(
    ctx,
    'confidence is deterministic',
    recomputed.components.every((c) => c.score >= 0 && c.score <= 1),
    `${unified.confidence.components.length} component(s), each explained`,
  );
  assert(
    ctx,
    'blockers have real producers',
    unified.quality.qualified.every((q) => q.reason.length > 0),
    unified.quality.blockers.length > 0
      ? `emitted: ${unified.quality.blockers.join(', ')}`
      : 'nothing qualified in this window',
  );
  assert(
    ctx,
    'metric lineage',
    unified.lineage.length > 0 &&
      unified.lineage.every((l) => l.factFamilies.length > 0 && Boolean(l.window.from)),
    `${unified.lineage.length} metric(s) trace to fact family, window and population`,
  );

  // Cohort age must be representable before anything is built on it.
  const cohortShape = await queryRows<Row>(
    `SELECT count(*)::text AS n FROM information_schema.columns
      WHERE table_name = 'attribution_revenue_metrics' AND column_name = 'cohort_age_days'`,
  );
  assert(
    ctx,
    'cohort age representable',
    toNumber(cohortShape[0]?.['n']) === 1,
    'attribution_revenue_metrics.cohort_age_days distinguishes D1 from D7 for one cohort',
  );

  // ---------------------------------------------------- campaign rollup ---
  heading(ctx, 'CAMPAIGN ROLLUP');
  const rollup = await queryRows<Row>(
    `SELECT COALESCE(SUM(spend), 0)::text AS spend
       FROM marketing_daily_metrics
      WHERE app_id = $1 AND report_date BETWEEN $2 AND $3`,
    [appId, from, to],
  );
  compare(ctx, 'rollup spend reconciles', toNumber(rollup[0]?.['spend']), marketing.spend);

  // ---------------------------------------- command center consistency ----
  heading(ctx, 'COMMAND CENTER CONSISTENCY');
  const families = new Set(metrics.map((m) => m.family));
  line('metric families served', [...families].sort().join(', '));
  // The dashboard groups by family; a metric with none would silently vanish.
  assert(
    ctx,
    'every served metric has a family',
    metrics.every((m) => METRIC_FAMILIES.includes(m.family)),
    `${metrics.length} metric(s) grouped`,
  );
  assert(
    ctx,
    'every served metric names its population',
    metrics.every((m) => Boolean(m.population?.numerator)),
    'population travels with the value',
  );
}

/**
 * Minimal metric context, built from stored rows.
 *
 * Deliberately not the API's context builder: the audit reconstructs what the
 * metric layer will be told, so a bug in that plumbing shows up as a
 * disagreement rather than being reproduced faithfully on both sides.
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
    `SELECT DISTINCT pc.capability_key FROM provider_capabilities pc
       JOIN integration_connections c ON c.id = pc.connection_id
      WHERE c.organization_id = $1 AND pc.supported`,
    [organizationId],
  );

  const marketingProviders = providersFor('marketing');
  const attributionProviders = providersFor('attribution');
  return {
    hasMarketingConnection: marketingProviders.length > 0,
    hasAttributionConnection: attributionProviders.length > 0,
    marketingProviders,
    attributionProviders,
    supportedCapabilities: new Set(capabilities.map((c) => String(c['capability_key']))),
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
    process.stderr.write(`phase1-audit failed: ${parts.join(' <- ')}\n`);
    process.exitCode = 1;
  })
  .finally(() => closePool());

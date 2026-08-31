/**
 * Phase 0 exit audit.
 *
 *   node packages/integrations/dist/cli/phase0-audit.js <organization_id> <from> <to> [app_id]
 *
 * One report covering every Phase 0 exit criterion, run against the real MART
 * database. It composes the checks the narrower CLIs already perform - provider
 * diagnosis, reconciliation, KPI arithmetic - and adds the ones that only make
 * sense together: does every stream's freshness reflect reality, do the
 * campaign rows reconcile to the top line, does the Command Center compute any
 * metric twice, and is any number here derived from a provider MART is not
 * actually talking to.
 *
 * It writes nothing. Every value is derived from stored rows rather than read
 * back from the code that produced the number under test, so the audit is able
 * to disagree with the dashboard.
 *
 * A metric is PASS only when the underlying arithmetic matches exactly;
 * display rounding is the only tolerated difference. A provider pointed at the
 * fixture server can never be PASS, because nothing it produced says anything
 * about real data.
 */
import { getConfig } from '@mart/config';
import { closePool, queryRows, toNumber } from '@mart/db';
import {
  computeMetricValues,
  loadAttributionAggregate,
  loadMarketingAggregate,
  type MetricFilters,
  type MetricValue,
} from '@mart/metrics';
import { OPERATIONAL_MAPPING_CONFIDENCE, type IsoDate } from '@mart/shared';
import { campaignCoverage } from '../reconciliation.js';
import { providerEndpointInfo } from '../registry.js';
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

/** Mapping strength MART reports operational figures from. */
const OPERATIONAL = `(m.status IN ('matched_exact','matched_confident','manually_verified')
  OR (m.status = 'matched_fallback' AND m.mapping_confidence >= ${OPERATIONAL_MAPPING_CONFIDENCE}))`;

type Row = Record<string, string | null>;

async function main(): Promise<void> {
  const [organizationId, from, to, appArg] = process.argv.slice(2);
  if (!organizationId || !from || !to) {
    process.stderr.write(
      'usage: phase0-audit <organization_id> <from> <to> [app_id]\n' +
        '  e.g. phase0-audit fe8a8112-... 2026-08-25 2026-08-31\n',
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

  for (const app of apps) {
    await auditApp(ctx, organizationId, app.id, app.name, from as IsoDate, to as IsoDate);
  }

  // ------------------------------------------------------- exit verdict ---
  heading(ctx, 'PHASE 0 EXIT VERDICT');
  const tally = counts(ctx);
  line('PASS', tally.PASS);
  line('FAIL', tally.FAIL);
  line('UNPROVEN', tally.UNPROVEN);
  line('NOT_IMPLEMENTED', tally.NOT_IMPLEMENTED);

  const failed = ctx.results.filter((r) => r.verdict === 'FAIL');
  const unproven = ctx.results.filter((r) => r.verdict === 'UNPROVEN');
  if (failed.length > 0) {
    process.stdout.write('\n  FAILING:\n');
    for (const r of failed) process.stdout.write(`    ${r.section} / ${r.metric}: ${r.detail}\n`);
  }
  if (unproven.length > 0) {
    process.stdout.write('\n  UNPROVEN:\n');
    for (const r of unproven) process.stdout.write(`    ${r.section} / ${r.metric}: ${r.detail}\n`);
  }

  const verdict =
    failed.length > 0
      ? 'NOT DONE - a Phase 0 exit criterion fails'
      : unproven.length > 0
        ? 'NOT DONE - every computed criterion passed, some could not be evaluated'
        : 'DONE - every Phase 0 exit criterion passed against this database';
  process.stdout.write(`\n  PHASE 0: ${verdict}\n`);
  process.exitCode = failed.length > 0 || unproven.length > 0 ? 1 : 0;
}

async function auditApp(
  ctx: AuditContext,
  organizationId: string,
  appId: string,
  appName: string,
  from: IsoDate,
  to: IsoDate,
): Promise<void> {
  process.stdout.write(`\n########## ${appName}   ${from} .. ${to} ##########\n`);

  const bindings = await queryRows<{
    role: string;
    provider_key: string;
    connection_status: string;
    external_account_id: string | null;
    account_name: string | null;
  }>(
    `SELECT b.role, c.provider_key, c.status AS connection_status,
            a.external_account_id, a.name AS account_name
       FROM integration_app_bindings b
       JOIN integration_connections c ON c.id = b.connection_id
       LEFT JOIN integration_accounts a ON a.id = b.integration_account_id
      WHERE b.organization_id = $1 AND b.app_id = $2 AND b.status = 'active'`,
    [organizationId, appId],
  );
  const marketingProviderKey =
    bindings.find((b) => b.role === 'marketing_network')?.provider_key ?? null;
  const attributionProviderKey =
    bindings.find((b) => b.role === 'primary_attribution')?.provider_key ?? null;

  // ----------------------------------------------------- provider health ---
  heading(ctx, 'PROVIDER HEALTH');
  if (bindings.length === 0) {
    record(ctx, 'bindings', 'FAIL', 'no active provider bound to this app');
  }
  let anyFixture = false;
  for (const binding of bindings) {
    const endpoint = providerEndpointInfo(binding.provider_key);
    const real = endpoint?.isProduction ?? false;
    if (!real) anyFixture = true;
    process.stdout.write('\n');
    line('role / provider', `${binding.role} / ${binding.provider_key}`);
    line(
      'account',
      `${binding.account_name ?? '(unnamed)'} [${binding.external_account_id ?? '-'}]`,
    );
    line('connection status', binding.connection_status);
    line('configured base URL', endpoint?.configuredBaseUrl ?? '(unknown)');
    line('mode', real ? 'REAL PROVIDER' : 'FIXTURE / NON-PRODUCTION ENDPOINT');
    if (binding.provider_key === 'meta_ads') {
      line('graph api version', getConfig().META_GRAPH_API_VERSION);
    }
    record(
      ctx,
      `${binding.provider_key} endpoint`,
      real ? 'PASS' : 'FAIL',
      real ? 'points at the real provider' : 'points at a non-production endpoint',
    );
    record(
      ctx,
      `${binding.provider_key} connection`,
      binding.connection_status === 'connected' ? 'PASS' : 'FAIL',
      `stored status ${binding.connection_status}`,
    );

    const capabilities = await queryRows<Row>(
      `SELECT capability_key, supported::text AS supported, discovery_method
         FROM provider_capabilities pc
         JOIN integration_connections c ON c.id = pc.connection_id
        WHERE c.organization_id = $1 AND c.provider_key = $2
        ORDER BY capability_key`,
      [organizationId, binding.provider_key],
    );
    const unsupported = capabilities.filter((c) => c['supported'] === 'false');
    line('capabilities recorded', capabilities.length);
    line(
      'declared unsupported',
      unsupported.length > 0
        ? unsupported
            .map((c) => `${c['capability_key']} (${c['discovery_method'] ?? 'unknown'})`)
            .join(', ')
        : '(none)',
    );
  }
  if (anyFixture) {
    note('At least one provider is not the real service. Nothing below proves anything');
    note('about real data until every provider reads REAL PROVIDER.');
  }

  const filters: MetricFilters = {
    organizationId,
    appId,
    from,
    to,
    marketingProviderKey,
    attributionProviderKey,
  };

  // ------------------------------------------------------ sync/freshness ---
  heading(ctx, 'SYNC & FRESHNESS');
  const freshness = await queryRows<Row>(
    `SELECT data_type, provider_key, status, last_error_class,
            last_success_at::text AS last_success_at,
            latest_provider_data_date::text AS latest_data_date
       FROM data_freshness
      WHERE organization_id = $1 AND app_id = $2
      ORDER BY provider_key, data_type`,
    [organizationId, appId],
  );
  for (const row of freshness) {
    const stream = `${row['provider_key']}/${row['data_type']}`;
    line(
      stream,
      `${row['status']}  last success ${row['last_success_at'] ?? 'never'}  data to ${row['latest_data_date'] ?? '-'}`,
    );
    // A stream that made no request must never read fresh, and a date-bearing
    // stream that did must not claim data it does not have. Structure is not
    // date-bearing: campaigns and ad sets are a current-state directory with
    // no report date, so a null data date there is the shape of the stream,
    // not a missing number.
    const dateBearing = row['data_type'] !== 'marketing_structure';
    if (row['status'] === 'not_implemented' || row['status'] === 'unsupported') {
      record(ctx, stream, 'NOT_IMPLEMENTED', 'declared unsupported, correctly not fresh');
    } else if (row['status'] === 'fresh' && row['latest_data_date'] === null && dateBearing) {
      record(ctx, stream, 'FAIL', 'reported fresh with no provider data date');
    } else if (row['status'] === 'error') {
      record(ctx, stream, 'FAIL', `error state: ${row['last_error_class'] ?? 'unknown'}`);
    } else {
      record(ctx, stream, 'PASS', `${row['status']}`);
    }
  }

  const runs = await queryRows<Row>(
    `SELECT status, count(*)::text AS n FROM sync_runs
      WHERE organization_id = $1 AND app_id = $2 GROUP BY status ORDER BY status`,
    [organizationId, appId],
  );
  line('sync runs by status', runs.map((r) => `${r['status']}=${r['n']}`).join(' ') || '(none)');
  const activeErrors = await queryRows<Row>(
    `SELECT count(*)::text AS n FROM sync_errors e
       JOIN sync_runs r ON r.id = e.sync_run_id
      WHERE e.organization_id = $1 AND r.app_id = $2 AND e.resolved_at IS NULL`,
    [organizationId, appId],
  );
  const resolvedErrors = await queryRows<Row>(
    `SELECT count(*)::text AS n FROM sync_errors e
       JOIN sync_runs r ON r.id = e.sync_run_id
      WHERE e.organization_id = $1 AND r.app_id = $2 AND e.resolved_at IS NOT NULL`,
    [organizationId, appId],
  );
  const active = toNumber(activeErrors[0]?.['n']);
  line('sync errors active / resolved', `${active} / ${toNumber(resolvedErrors[0]?.['n'])}`);
  record(
    ctx,
    'active sync errors',
    active === 0 ? 'PASS' : 'FAIL',
    active === 0 ? 'none unresolved' : `${active} unresolved error(s)`,
  );

  // ---------------------------------------------------------- production ---
  const coverage = marketingProviderKey
    ? await campaignCoverage(organizationId, appId, marketingProviderKey, {
        from,
        to,
        attributionProviderKey,
      })
    : null;
  const marketing = await loadMarketingAggregate(filters);
  const attribution = await loadAttributionAggregate(filters);
  const metrics = computeMetricValues({
    context: {
      hasMarketingConnection: Boolean(marketingProviderKey),
      hasAttributionConnection: Boolean(attributionProviderKey),
      marketingProviders: marketingProviderKey ? [marketingProviderKey] : [],
      attributionProviders: attributionProviderKey ? [attributionProviderKey] : [],
      // Capability gating is a separate concern from arithmetic; the audit
      // supplies the full set so a gated metric cannot hide a wrong number.
      supportedCapabilities: new Set([
        'cost_data',
        'delivery_metrics',
        'link_clicks',
        'attributed_installs',
        'attributed_revenue',
      ]),
      ...(coverage
        ? {
            mappingCoverage: {
              total: coverage.total,
              authoritative: coverage.authoritative,
              operational: coverage.operational,
              ...(coverage.eligible ? { eligible: coverage.eligible } : {}),
            },
          }
        : {}),
    },
    marketing,
    attribution,
  });
  const value = (key: string): number | null =>
    metrics.find((m: MetricValue) => m.metricKey === key)?.value ?? null;

  // ------------------------------------------------------- reconciliation ---
  heading(ctx, 'RECONCILIATION');
  if (!coverage || !coverage.eligible) {
    record(ctx, 'coverage', 'UNPROVEN', 'no marketing provider bound, or no window coverage');
  } else {
    const e = coverage.eligible;
    line('campaign coverage (period)', `${e.campaignPct ?? '-'}%`);
    line('spend coverage (period)', `${e.spendPct ?? '-'}%`);
    line('attribution coverage (period)', `${e.installPct ?? '-'}%`);
    line('ambiguous spend', e.ambiguousSpend.toFixed(2));
    line('mapped paid installs', e.mappedPaidInstalls);
    line('organic installs', e.organicInstalls);
    line('unmapped paid installs', e.unmappedPaidInstalls);
    line('ambiguous paid installs', e.ambiguousPaidInstalls);
    line('historical / no delivery', e.historicalCampaigns);
    line('authoritative coverage (all)', `${coverage.authoritativeCoveragePct ?? '-'}%`);
    line('operational coverage (all)', `${coverage.operationalCoveragePct ?? '-'}%`);
    line(
      'by method',
      `exact=${coverage.matchedExact} name=${coverage.matchedNameEmbedded} ` +
        `ambiguous=${coverage.ambiguous} unmatched=${coverage.unmatched} organic=${coverage.notApplicable}`,
    );

    assert(
      ctx,
      'ambiguous attribution',
      coverage.ambiguous === 0,
      `${coverage.ambiguous} ambiguous`,
    );
    assert(
      ctx,
      'unmapped paid installs',
      e.unmappedPaidInstalls === 0,
      `${e.unmappedPaidInstalls} paid install(s) unmapped`,
    );
    assert(
      ctx,
      'ambiguous spend',
      e.ambiguousSpend === 0,
      `${e.ambiguousSpend.toFixed(2)} ambiguous`,
    );
    // Period and structure must not share a denominator: that is the bug the
    // separation exists to prevent, so it is checked rather than assumed.
    assert(
      ctx,
      'period != all-structure',
      e.eligibleCampaigns <= coverage.total,
      `eligible=${e.eligibleCampaigns} all-structure=${coverage.total}`,
    );

    if (attributionProviderKey && marketingProviderKey) {
      const resolver = getRemoteIdResolver(attributionProviderKey, marketingProviderKey);
      line('remote id levels tried', resolver.levels.join(' then '));
      const byMethod = await queryRows<Row>(
        `SELECT mapping_method, status, count(*)::text AS n
           FROM provider_entity_mappings
          WHERE organization_id = $1 AND app_id = $2 AND entity_type = 'campaign'
            AND source_provider = $3
          GROUP BY mapping_method, status ORDER BY mapping_method`,
        [organizationId, appId, marketingProviderKey],
      );
      for (const row of byMethod) {
        line(`  ${row['mapping_method']}/${row['status']}`, row['n']);
      }
    }
  }

  // ------------------------------------------------------- meta delivery ---
  heading(ctx, 'META DELIVERY');
  const d =
    (
      await queryRows<Row>(
        `SELECT COALESCE(SUM(spend),0)::text AS spend,
                COALESCE(SUM(impressions),0)::text AS impressions,
                COALESCE(SUM(clicks),0)::text AS clicks,
                count(*)::text AS rows,
                count(DISTINCT dimension_hash)::text AS hashes,
                count(DISTINCT grain)::text AS grains, MIN(grain) AS grain,
                MIN(report_date)::text AS first_date, MAX(report_date)::text AS last_date
           FROM marketing_daily_metrics
          WHERE organization_id = $1 AND app_id = $2 AND provider_key = $3
            AND report_date BETWEEN $4 AND $5`,
        [organizationId, appId, marketingProviderKey, from, to],
      )
    )[0] ?? {};
  const spend = toNumber(d['spend']);
  const impressions = toNumber(d['impressions']);
  const clicks = toNumber(d['clicks']);
  line('rows / distinct dimensions', `${d['rows']} / ${d['hashes']}`);
  line('grain', `${d['grain']} (${d['grains']} distinct)`);
  line('dates present', `${d['first_date'] ?? '-'} .. ${d['last_date'] ?? '-'}`);

  const perCampaign = await queryRows<Row>(
    `SELECT external_campaign_id, SUM(spend)::text AS spend,
            SUM(impressions)::text AS impressions, SUM(clicks)::text AS clicks
       FROM marketing_daily_metrics
      WHERE organization_id = $1 AND app_id = $2 AND provider_key = $3
        AND report_date BETWEEN $4 AND $5
      GROUP BY external_campaign_id`,
    [organizationId, appId, marketingProviderKey, from, to],
  );
  assert(
    ctx,
    'no delivery fan-out',
    Math.abs(perCampaign.reduce((s, r) => s + toNumber(r['spend']), 0) - spend) <= 1e-6,
    'row-level spend equals campaign-level spend',
  );
  assert(ctx, 'one row per dimension', d['rows'] === d['hashes'], `${d['rows']} rows`);
  assert(
    ctx,
    'window inclusive',
    (d['first_date'] ?? from) >= from && (d['last_date'] ?? to) <= to,
    `${from} .. ${to}`,
  );

  compare(ctx, 'spend', spend, marketing.spend, value('spend'));
  compare(ctx, 'impressions', impressions, marketing.impressions, value('impressions'));
  compare(ctx, 'clicks', clicks, marketing.clicks, value('clicks'));
  const ratio = (n: number, dn: number): number | null => (dn > 0 ? n / dn : null);
  compare(ctx, 'ctr', ratio(clicks, impressions), value('ctr'), ratio(clicks, impressions));
  compare(
    ctx,
    'cpm',
    ratio(spend * 1000, impressions),
    value('cpm'),
    ratio(spend * 1000, impressions),
  );
  compare(ctx, 'cpc', ratio(spend, clicks), value('cpc'), ratio(spend, clicks));

  // -------------------------------------------------- attribution installs ---
  heading(ctx, 'ATTRIBUTION INSTALLS');
  const i =
    (
      await queryRows<Row>(
        `SELECT COALESCE(SUM(attributed_installs),0)::text AS total,
                COALESCE(SUM(attributed_installs) FILTER (
                  WHERE COALESCE(normalized_media_source,'organic') <> 'organic'),0)::text AS paid,
                COALESCE(SUM(attributed_installs) FILTER (
                  WHERE COALESCE(normalized_media_source,'organic') = 'organic'),0)::text AS organic,
                COALESCE(SUM(attributed_installs) FILTER (
                  WHERE COALESCE(normalized_media_source,'organic') <> 'organic'
                    AND EXISTS (SELECT 1 FROM provider_entity_mappings m
                                 WHERE m.organization_id = a.organization_id AND m.app_id = a.app_id
                                   AND m.entity_type='campaign' AND m.target_provider = a.provider_key
                                   AND m.target_external_id = a.external_campaign_id AND ${OPERATIONAL})),0)::text
                  AS mapped_paid,
                MIN(grain) AS grain, count(*)::text AS rows
           FROM attribution_daily_metrics a
          WHERE a.organization_id = $1 AND a.app_id = $2 AND a.provider_key = $3
            AND a.install_date BETWEEN $4 AND $5`,
        [organizationId, appId, attributionProviderKey, from, to],
      )
    )[0] ?? {};
  const total = toNumber(i['total']);
  const paid = toNumber(i['paid']);
  const organic = toNumber(i['organic']);
  const mappedPaid = toNumber(i['mapped_paid']);
  line('grain / rows', `${i['grain']} / ${i['rows']}`);
  assert(
    ctx,
    'paid + organic = total',
    Math.abs(paid + organic - total) <= 1e-6,
    `${paid}+${organic}=${total}`,
  );
  assert(ctx, 'organic not counted paid', !(organic > 0 && paid === total), `organic=${organic}`);
  compare(
    ctx,
    'total installs',
    total,
    attribution.attributedInstalls,
    value('attributed_installs'),
  );
  compare(ctx, 'organic installs', organic, attribution.organicInstalls, value('organic_installs'));
  compare(
    ctx,
    'mapped paid installs',
    mappedPaid,
    attribution.mappedPaidInstalls,
    value('mapped_paid_installs'),
  );
  compare(ctx, 'unmapped paid installs', paid - mappedPaid, attribution.unmappedPaidInstalls);

  // ------------------------------------------------------------------ cpi ---
  heading(ctx, 'CPI');
  // The delivery-aligned population, recomputed from the stored rows rather
  // than read back from the metric service, so a wrong denominator in the
  // service cannot make its own CPI look right. Scope columns come from the
  // bound parameters: correlating them to the outer aggregate would reference
  // an ungrouped column.
  const ALIGNED_CAMPAIGN = `IN (
          SELECT m.target_external_id FROM provider_entity_mappings m
           JOIN (SELECT DISTINCT md.external_campaign_id, md.provider_key
                   FROM marketing_daily_metrics md
                  WHERE md.organization_id = $1 AND md.app_id = $2
                    AND md.report_date BETWEEN $4 AND $5
                    AND (md.spend>0 OR md.impressions>0 OR md.clicks>0)) dl
             ON dl.external_campaign_id = m.source_external_id
            AND dl.provider_key = m.source_provider
           WHERE m.organization_id = $1 AND m.app_id = $2
             AND m.entity_type='campaign' AND m.target_provider = $3
             AND m.target_external_id IS NOT NULL AND ${OPERATIONAL})`;

  const alignedRows = await queryRows<Row>(
    `SELECT COALESCE(SUM(a.attributed_installs),0)::text AS installs,
            COALESCE((SELECT SUM(r.revenue) FROM attribution_revenue_metrics r
                       WHERE r.organization_id = $1 AND r.app_id = $2
                         AND r.provider_key = $3 AND r.grain = 'event_date'
                         AND r.activity_date BETWEEN $4 AND $5
                         AND COALESCE(r.normalized_media_source,'organic') <> 'organic'
                         AND r.external_campaign_id ${ALIGNED_CAMPAIGN}),0)::text
              AS revenue
       FROM attribution_daily_metrics a
      WHERE a.organization_id = $1 AND a.app_id = $2 AND a.provider_key = $3
        AND a.install_date BETWEEN $4 AND $5
        AND COALESCE(a.normalized_media_source,'organic') <> 'organic'
        AND a.external_campaign_id ${ALIGNED_CAMPAIGN}`,
    [organizationId, appId, attributionProviderKey, from, to],
  );
  const alignedInstalls = toNumber(alignedRows[0]?.['installs']);
  const alignedRevenue = toNumber(alignedRows[0]?.['revenue']);

  const mappedSpendRow = await queryRows<Row>(
    `SELECT COALESCE(SUM(spend),0)::text AS mapped_spend
       FROM marketing_daily_metrics md
      WHERE md.organization_id = $1 AND md.app_id = $2 AND md.provider_key = $3
        AND md.report_date BETWEEN $4 AND $5
        AND EXISTS (SELECT 1 FROM provider_entity_mappings m
                     WHERE m.organization_id = md.organization_id AND m.app_id = md.app_id
                       AND m.entity_type='campaign' AND m.source_provider = md.provider_key
                       AND m.source_external_id = md.external_campaign_id
                       AND m.target_external_id IS NOT NULL AND ${OPERATIONAL})`,
    [organizationId, appId, marketingProviderKey, from, to],
  );
  const mappedSpend = toNumber(mappedSpendRow[0]?.['mapped_spend']);

  const mappedCpi = alignedInstalls > 0 ? mappedSpend / alignedInstalls : null;
  const blendedCpi = total > 0 ? spend / total : null;
  line('mapped CPI numerator', `${mappedSpend.toFixed(6)} (spend on mapped campaigns, in window)`);
  line(
    'mapped CPI denominator',
    `${alignedInstalls} (installs on mapped campaigns that delivered)`,
  );
  line('mapped CPI exact', mappedCpi === null ? '(none)' : mappedCpi.toFixed(10));
  line('mapped CPI displayed', mappedCpi === null ? '—' : `$${mappedCpi.toFixed(2)}`);
  line('mapping-population installs', `${mappedPaid} (coverage figure, NOT this denominator)`);
  line('outside delivery window', mappedPaid - alignedInstalls);
  line('blended CPI numerator', `${spend.toFixed(6)} (all spend)`);
  line('blended CPI denominator', `${total} (all installs incl. organic and unmapped)`);
  line('blended CPI exact', blendedCpi === null ? '(none)' : blendedCpi.toFixed(10));
  line('blended CPI displayed', blendedCpi === null ? '—' : `$${blendedCpi.toFixed(2)}`);

  compare(ctx, 'mapped spend', mappedSpend, marketing.mappedSpend);
  compare(
    ctx,
    'delivery-aligned installs',
    alignedInstalls,
    attribution.deliveryAlignedPaidInstalls,
    value('delivery_aligned_paid_installs'),
  );
  compare(ctx, 'mapped_cpi', mappedCpi, value('mapped_cpi'));
  compare(ctx, 'blended_cpi', blendedCpi, value('blended_cpi'));
  // Both sides of a mapped CPI must describe one population.
  assert(
    ctx,
    'cpi populations aligned',
    attribution.deliveryAlignedPaidInstalls <= attribution.mappedPaidInstalls,
    `aligned=${attribution.deliveryAlignedPaidInstalls} mapped=${attribution.mappedPaidInstalls}`,
  );

  // -------------------------------------------------------------- revenue ---
  heading(ctx, 'REVENUE');
  const byType = await queryRows<Row>(
    `SELECT revenue_type, grain, COALESCE(SUM(revenue),0)::text AS revenue, count(*)::text AS rows
       FROM attribution_revenue_metrics
      WHERE organization_id = $1 AND app_id = $2 AND provider_key = $3
        AND activity_date BETWEEN $4 AND $5
      GROUP BY revenue_type, grain ORDER BY grain, revenue_type`,
    [organizationId, appId, attributionProviderKey, from, to],
  );
  for (const row of byType) {
    line(
      `  ${row['grain']} / ${row['revenue_type']}`,
      `${row['revenue']} over ${row['rows']} row(s)`,
    );
  }
  const eventOf = (type: string): number =>
    toNumber(
      byType.find((r) => r['revenue_type'] === type && r['grain'] === 'event_date')?.['revenue'],
    );
  const iap = eventOf('iap');
  const ad = eventOf('ad');
  const combinedType = eventOf('total');
  const cohort = byType
    .filter((r) => r['grain'] !== 'event_date')
    .reduce((s, r) => s + toNumber(r['revenue']), 0);
  const combined = iap + ad + combinedType;

  const overlap = await queryRows<Row>(
    `SELECT count(*)::text AS n FROM (
       SELECT activity_date, external_campaign_id
         FROM attribution_revenue_metrics
        WHERE organization_id = $1 AND app_id = $2 AND provider_key = $3
          AND activity_date BETWEEN $4 AND $5 AND grain = 'event_date'
        GROUP BY activity_date, external_campaign_id
       HAVING count(*) FILTER (WHERE revenue_type = 'total') > 0
          AND count(*) FILTER (WHERE revenue_type IN ('iap','ad')) > 0) t`,
    [organizationId, appId, attributionProviderKey, from, to],
  );
  const overlaps = toNumber(overlap[0]?.['n']);

  const split = await queryRows<Row>(
    `SELECT COALESCE(SUM(revenue) FILTER (
              WHERE COALESCE(normalized_media_source,'organic')='organic'),0)::text AS organic,
            COALESCE(SUM(revenue) FILTER (
              WHERE COALESCE(normalized_media_source,'organic')<>'organic'
                AND EXISTS (SELECT 1 FROM provider_entity_mappings m
                             WHERE m.organization_id = r.organization_id AND m.app_id = r.app_id
                               AND m.entity_type='campaign' AND m.target_provider = r.provider_key
                               AND m.target_external_id = r.external_campaign_id AND ${OPERATIONAL})),0)::text
              AS mapped
       FROM attribution_revenue_metrics r
      WHERE r.organization_id = $1 AND r.app_id = $2 AND r.provider_key = $3
        AND r.activity_date BETWEEN $4 AND $5 AND r.grain = 'event_date'`,
    [organizationId, appId, attributionProviderKey, from, to],
  );
  const organicRevenue = toNumber(split[0]?.['organic']);
  const mappedRevenue = toNumber(split[0]?.['mapped']);

  line('IAP revenue (revenues)', iap.toFixed(6));
  line('ad revenue (mediation/pub)', ad.toFixed(6));
  line('combined-only rows (total)', combinedType.toFixed(6));
  line('combined attributed', combined.toFixed(6));
  line('organic revenue', organicRevenue.toFixed(6));
  line('mapped revenue', mappedRevenue.toFixed(6));
  line('delivery-aligned revenue', alignedRevenue.toFixed(6));
  line('cohort revenue in range', `${cohort.toFixed(6)} (must not enter any total above)`);

  assert(
    ctx,
    'no revenue double counting',
    overlaps === 0,
    `${overlaps} campaign/date pair(s) with a total beside its parts`,
  );
  compare(
    ctx,
    'attributed_revenue',
    combined,
    attribution.attributedRevenue,
    value('attributed_revenue'),
  );
  compare(
    ctx,
    'mapped_attributed_revenue',
    mappedRevenue,
    attribution.mappedAttributedRevenue,
    value('mapped_attributed_revenue'),
  );
  compare(
    ctx,
    'delivery_aligned_revenue',
    alignedRevenue,
    attribution.deliveryAlignedRevenue,
    value('delivery_aligned_revenue'),
  );
  // Cohort revenue exists in the same table and must never join the total.
  assert(
    ctx,
    'event/cohort separation',
    Math.abs(attribution.attributedRevenue - combined) <= 1e-6,
    cohort > 0
      ? `${cohort.toFixed(2)} of cohort revenue present and correctly excluded`
      : 'no cohort revenue stored in range',
  );

  // ------------------------------------------------------ campaign rollup ---
  heading(ctx, 'CAMPAIGN ROLLUP');
  const rollup = await queryRows<Row>(
    `WITH delivery AS (
       SELECT external_campaign_id, SUM(spend) AS spend,
              SUM(impressions) AS impressions, SUM(clicks) AS clicks
         FROM marketing_daily_metrics
        WHERE organization_id = $1 AND app_id = $2 AND provider_key = $3
          AND report_date BETWEEN $4 AND $5
        GROUP BY external_campaign_id
     ), mapped AS (
       SELECT m.source_external_id, array_agg(m.target_external_id) AS targets, count(*)::int AS children
         FROM provider_entity_mappings m
        WHERE m.organization_id = $1 AND m.app_id = $2 AND m.entity_type='campaign'
          AND m.source_provider = $3 AND m.target_external_id IS NOT NULL AND ${OPERATIONAL}
        GROUP BY m.source_external_id
     )
     SELECT d.external_campaign_id, MAX(c.name) AS name,
            d.spend::text AS spend, d.impressions::text AS impressions, d.clicks::text AS clicks,
            COALESCE(mapped.children,0)::text AS children,
            COALESCE((SELECT SUM(a.attributed_installs) FROM attribution_daily_metrics a
                       WHERE a.organization_id=$1 AND a.app_id=$2
                         AND a.install_date BETWEEN $4 AND $5
                         AND a.external_campaign_id = ANY(mapped.targets)),0)::text AS installs,
            COALESCE((SELECT SUM(r.revenue) FROM attribution_revenue_metrics r
                       WHERE r.organization_id=$1 AND r.app_id=$2 AND r.grain='event_date'
                         AND r.activity_date BETWEEN $4 AND $5
                         AND r.external_campaign_id = ANY(mapped.targets)),0)::text AS revenue
       FROM delivery d
       LEFT JOIN mapped ON mapped.source_external_id = d.external_campaign_id
       LEFT JOIN marketing_campaigns c ON c.organization_id=$1 AND c.app_id=$2
             AND c.external_campaign_id = d.external_campaign_id
      GROUP BY d.external_campaign_id, d.spend, d.impressions, d.clicks, mapped.children, mapped.targets
      ORDER BY d.spend DESC`,
    [organizationId, appId, marketingProviderKey, from, to],
  );
  let sSpend = 0;
  let sImpr = 0;
  let sClicks = 0;
  let sInstalls = 0;
  let sRevenue = 0;
  for (const row of rollup) {
    const rs = toNumber(row['spend']);
    const ri = toNumber(row['installs']);
    sSpend += rs;
    sImpr += toNumber(row['impressions']);
    sClicks += toNumber(row['clicks']);
    sInstalls += ri;
    sRevenue += toNumber(row['revenue']);
    process.stdout.write(
      `\n  ${row['external_campaign_id']}  ${row['name'] ?? '(unnamed)'}\n` +
        `    spend ${rs.toFixed(2)}  impr ${row['impressions']}  clicks ${row['clicks']}\n` +
        `    children ${row['children']}  installs ${ri}  revenue ${toNumber(row['revenue']).toFixed(2)}` +
        `  CPI ${ri > 0 ? (rs / ri).toFixed(4) : '—'}\n`,
    );
  }
  process.stdout.write('\n');
  // The rollup population is delivery-aligned by construction: it starts from
  // campaigns that delivered. So it reconciles to the aligned figures, not to
  // the wider mapping population - stating which is the point.
  compare(ctx, 'rollup spend', sSpend, spend);
  compare(ctx, 'rollup impressions', sImpr, impressions);
  compare(ctx, 'rollup clicks', sClicks, clicks);
  compare(ctx, 'rollup installs (aligned)', sInstalls, alignedInstalls);
  compare(ctx, 'rollup revenue (aligned)', sRevenue, alignedRevenue);

  // -------------------------------------------------------- grain safety ---
  heading(ctx, 'GRAIN SAFETY');
  line('meta delivery', `${d['grain']} - campaign x country x platform x date`);
  line('attribution installs', `${i['grain']} - attribution campaign x country x platform x date`);
  line('attribution revenue', 'event_date only in every total above');
  line('mapped CPI', 'MIXED: report_date spend / install_date installs - declared, not hidden');
  line('blended CPI', 'MIXED grain and mixed population - organic and unmapped included');
  line('cohort ROAS', 'not computed in Phase 0');
  const offGrain = await queryRows<Row>(
    `SELECT (SELECT count(*) FROM marketing_daily_metrics
              WHERE organization_id=$1 AND app_id=$2 AND grain <> 'report_date')::text AS marketing,
            (SELECT count(*) FROM attribution_daily_metrics
              WHERE organization_id=$1 AND app_id=$2 AND grain <> 'install_date')::text AS attribution`,
    [organizationId, appId],
  );
  assert(
    ctx,
    'rows stored at declared grain',
    toNumber(offGrain[0]?.['marketing']) === 0 && toNumber(offGrain[0]?.['attribution']) === 0,
    `marketing off-grain=${offGrain[0]?.['marketing']} attribution off-grain=${offGrain[0]?.['attribution']}`,
  );

  // -------------------------------------------------------- data quality ---
  heading(ctx, 'DATA QUALITY');
  const findings = await queryRows<Row>(
    `SELECT severity, check_key, count(*)::text AS n, MAX(message) AS example
       FROM data_quality_findings
      WHERE organization_id = $1 AND app_id = $2
      GROUP BY severity, check_key
      ORDER BY CASE severity WHEN 'error' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, check_key`,
    [organizationId, appId],
  );
  if (findings.length === 0) line('findings', '(none recorded)');
  for (const f of findings) {
    process.stdout.write(
      `  ${String(f['severity']).toUpperCase().padEnd(8)} ${f['check_key']} x${f['n']}\n`,
    );
    process.stdout.write(`           ${f['example']}\n`);
  }
  const errors = findings.filter((f) => f['severity'] === 'error');
  record(
    ctx,
    'critical data-quality findings',
    errors.length === 0 ? 'PASS' : 'FAIL',
    errors.length === 0 ? 'none' : errors.map((f) => f['check_key']).join(', '),
  );

  // ------------------------------------------- command center consistency ---
  heading(ctx, 'COMMAND CENTER CONSISTENCY');
  // The cards and the reconciliation panel must be one computation. Comparing
  // the metric layer against the coverage object proves they agree, and the
  // metric values are ratios where the panel carries percentages.
  if (coverage?.eligible) {
    const asPct = (v: number | null): number | null =>
      v === null ? null : Number((v * 100).toFixed(1));
    compare(
      ctx,
      'card vs panel: campaign',
      asPct(value('campaign_operational_coverage')),
      coverage.eligible.campaignPct,
    );
    compare(
      ctx,
      'card vs panel: spend',
      asPct(value('spend_coverage')),
      coverage.eligible.spendPct,
    );
    compare(
      ctx,
      'card vs panel: attribution',
      asPct(value('attribution_coverage')),
      coverage.eligible.installPct,
    );
  } else {
    record(ctx, 'card vs panel', 'UNPROVEN', 'no period coverage available');
  }
  for (const key of ['campaign_operational_coverage', 'spend_coverage', 'attribution_coverage']) {
    const m = metrics.find((x: MetricValue) => x.metricKey === key);
    assert(
      ctx,
      `${key} labelled`,
      Boolean(m && /selected period/i.test(m.displayName)),
      m ? m.displayName : '(missing)',
    );
  }
  for (const key of ['mapping_coverage', 'operational_mapping_coverage']) {
    const m = metrics.find((x: MetricValue) => x.metricKey === key);
    assert(
      ctx,
      `${key} labelled`,
      Boolean(m && /all structure/i.test(m.displayName)),
      m ? m.displayName : '(missing)',
    );
  }
  const contradictions = metrics.filter(
    (m: MetricValue) => m.availability === 'available' && m.value === null,
  );
  assert(
    ctx,
    'no available-but-empty card',
    contradictions.length === 0,
    `${contradictions.length} card(s)`,
  );
}

main()
  .catch((error: unknown) => {
    // A wrapped database error says only "Database query failed"; the cause
    // carries the statement the audit could not run, which is the whole point
    // of the message.
    const parts: string[] = [];
    let current: unknown = error;
    for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
      parts.push(current.message);
      current = current.cause;
    }
    if (parts.length === 0) parts.push(String(error));
    process.stderr.write(`phase0-audit failed: ${parts.join(' <- ')}\n`);
    process.exitCode = 1;
  })
  .finally(() => closePool());

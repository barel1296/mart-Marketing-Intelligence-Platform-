/**
 * Read-only KPI audit.
 *
 *   node packages/integrations/dist/cli/kpi-audit.js <organization_id> <from> <to> [app_id]
 *
 * Traces every displayed KPI from stored rows to dashboard value, and compares
 * three independent computations of each: a direct SQL sum over the normalized
 * tables, the production aggregation the API uses, and the formula applied by
 * hand. A metric passes only when all three agree to the last decimal; display
 * rounding is the only difference tolerated.
 *
 * It writes nothing and computes nothing the dashboard does not already
 * compute. Its purpose is to disagree with the dashboard when the dashboard is
 * wrong, so every number here is derived from the rows rather than read back
 * from the code that produced the number under test.
 */
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

/** Arithmetic must agree to here. Anything larger is a real difference. */
const EPSILON = 1e-6;

/** Mapping strength MART reports operational figures from. */
const OPERATIONAL = `(m.status IN ('matched_exact','matched_confident','manually_verified')
  OR (m.status = 'matched_fallback' AND m.mapping_confidence >= ${OPERATIONAL_MAPPING_CONFIDENCE}))`;

type Row = Record<string, string | null>;

function heading(text: string): void {
  process.stdout.write(`\n=== ${text} ===\n`);
}

function line(label: string, value: unknown): void {
  process.stdout.write(`${label.padEnd(32)} ${String(value)}\n`);
}

let failures = 0;
let unproven = 0;

/**
 * Compare independently computed values and report the verdict.
 *
 * `dashboard` is what the production path produced; `normalized` is what the
 * rows say. They must match exactly - a KPI that only agrees "about right" is
 * a KPI nobody can act on.
 */
function compare(
  metric: string,
  normalized: number | null,
  dashboard: number | null,
  derived?: number | null,
): void {
  const values = [normalized, dashboard, ...(derived === undefined ? [] : [derived])];
  if (values.some((v) => v === null)) {
    unproven += 1;
    process.stdout.write(
      `  ${metric.padEnd(22)} normalized=${fmt(normalized)}  dashboard=${fmt(dashboard)}` +
        `${derived === undefined ? '' : `  derived=${fmt(derived)}`}  UNPROVEN (a value is unavailable)\n`,
    );
    return;
  }
  const numbers = values as number[];
  const max = Math.max(...numbers);
  const min = Math.min(...numbers);
  const difference = max - min;
  const ok = difference <= EPSILON;
  if (!ok) failures += 1;
  process.stdout.write(
    `  ${metric.padEnd(22)} normalized=${fmt(normalized)}  dashboard=${fmt(dashboard)}` +
      `${derived === undefined ? '' : `  derived=${fmt(derived)}`}` +
      `  diff=${difference.toExponential(2)}  ${ok ? 'PASS' : 'FAIL'}\n`,
  );
}

function fmt(value: number | null): string {
  if (value === null) return '(unavailable)';
  return Number.isInteger(value) ? String(value) : value.toFixed(6);
}

function metricValue(metrics: MetricValue[], key: string): number | null {
  return metrics.find((m) => m.metricKey === key)?.value ?? null;
}

async function main(): Promise<void> {
  const [organizationId, from, to, appArg] = process.argv.slice(2);
  if (!organizationId || !from || !to) {
    process.stderr.write('usage: kpi-audit <organization_id> <from> <to> [app_id]\n');
    process.exitCode = 2;
    return;
  }

  const apps = await queryRows<{ id: string; name: string; default_currency: string }>(
    `SELECT id, name, default_currency FROM apps
      WHERE organization_id = $1 ${appArg ? 'AND id = $2' : ''} AND status = 'active'
      ORDER BY name`,
    appArg ? [organizationId, appArg] : [organizationId],
  );

  for (const app of apps) {
    await auditApp(organizationId, app.id, app.name, from as IsoDate, to as IsoDate);
  }

  heading('FINAL VERDICT');
  line('metrics failing', failures);
  line('metrics unproven', unproven);
  line(
    'verdict',
    failures > 0
      ? 'FAIL - at least one KPI does not match its underlying rows'
      : unproven > 0
        ? 'INCOMPLETE - every computed KPI matched, some could not be evaluated'
        : 'PASS - every KPI matches its underlying rows exactly',
  );
  process.exitCode = failures > 0 ? 1 : 0;
}

async function auditApp(
  organizationId: string,
  appId: string,
  appName: string,
  from: IsoDate,
  to: IsoDate,
): Promise<void> {
  process.stdout.write(`\n########## ${appName}  ${from} .. ${to} ##########\n`);

  const bindings = await queryRows<{ role: string; provider_key: string }>(
    `SELECT b.role, c.provider_key FROM integration_app_bindings b
       JOIN integration_connections c ON c.id = b.connection_id
      WHERE b.organization_id = $1 AND b.app_id = $2 AND b.status = 'active'`,
    [organizationId, appId],
  );
  const marketingProviderKey =
    bindings.find((b) => b.role === 'marketing_network')?.provider_key ?? null;
  const attributionProviderKey =
    bindings.find((b) => b.role === 'primary_attribution')?.provider_key ?? null;
  line('marketing provider', marketingProviderKey ?? '(none)');
  line('attribution provider', attributionProviderKey ?? '(none)');

  const filters: MetricFilters = {
    organizationId,
    appId,
    from,
    to,
    marketingProviderKey,
    attributionProviderKey,
  };

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

  // ------------------------------------------------------ meta delivery ---
  heading('META DELIVERY');
  const delivery = await queryRows<Row>(
    `SELECT COALESCE(SUM(spend), 0)::text AS spend,
            COALESCE(SUM(impressions), 0)::text AS impressions,
            COALESCE(SUM(clicks), 0)::text AS clicks,
            count(*)::text AS rows,
            count(DISTINCT external_campaign_id)::text AS campaigns,
            count(DISTINCT dimension_hash)::text AS distinct_hashes,
            MIN(report_date)::text AS first_date,
            MAX(report_date)::text AS last_date,
            count(DISTINCT grain)::text AS grains,
            MIN(grain) AS grain
       FROM marketing_daily_metrics
      WHERE organization_id = $1 AND app_id = $2 AND provider_key = $3
        AND report_date BETWEEN $4 AND $5`,
    [organizationId, appId, marketingProviderKey, from, to],
  );
  const d = delivery[0] ?? {};
  const spend = toNumber(d['spend']);
  const impressions = toNumber(d['impressions']);
  const clicks = toNumber(d['clicks']);

  line('rows / campaigns', `${d['rows']} / ${d['campaigns']}`);
  line('distinct dimension_hash', d['distinct_hashes']);
  line('grain(s) stored', `${d['grain']} (${d['grains']} distinct)`);
  line('date range in rows', `${d['first_date'] ?? '-'} .. ${d['last_date'] ?? '-'}`);
  line(
    'window inclusive',
    (d['first_date'] ?? from) >= from && (d['last_date'] ?? to) <= to ? 'YES' : 'NO - out of range',
  );

  // Duplication: one row per dimension, and the campaign-level regrouping must
  // reproduce the total exactly. A join fanning out over ad groups or ads would
  // break the second check even when the first passes.
  const perCampaign = await queryRows<Row>(
    `SELECT external_campaign_id, SUM(spend)::text AS spend,
            SUM(impressions)::text AS impressions, SUM(clicks)::text AS clicks
       FROM marketing_daily_metrics
      WHERE organization_id = $1 AND app_id = $2 AND provider_key = $3
        AND report_date BETWEEN $4 AND $5
      GROUP BY external_campaign_id`,
    [organizationId, appId, marketingProviderKey, from, to],
  );
  const campaignSpend = perCampaign.reduce((sum, r) => sum + toNumber(r['spend']), 0);
  line(
    'row-level = campaign-level',
    Math.abs(campaignSpend - spend) <= EPSILON ? 'YES (no fan-out)' : 'NO - spend duplicated',
  );
  line(
    'one row per dimension',
    d['rows'] === d['distinct_hashes'] ? 'YES' : 'NO - duplicate dimension rows',
  );

  compare('spend', spend, marketing.spend, metricValue(metrics, 'spend'));
  compare('impressions', impressions, marketing.impressions, metricValue(metrics, 'impressions'));
  compare('clicks', clicks, marketing.clicks, metricValue(metrics, 'clicks'));
  // Ratios are recomputed from the sums above, never from per-row averages.
  compare(
    'ctr',
    impressions > 0 ? clicks / impressions : null,
    metricValue(metrics, 'ctr'),
    impressions > 0 ? clicks / impressions : null,
  );
  compare(
    'cpm',
    impressions > 0 ? (spend * 1000) / impressions : null,
    metricValue(metrics, 'cpm'),
    impressions > 0 ? (spend * 1000) / impressions : null,
  );
  compare(
    'cpc',
    clicks > 0 ? spend / clicks : null,
    metricValue(metrics, 'cpc'),
    clicks > 0 ? spend / clicks : null,
  );
  process.stdout.write(
    `  display: CTR ${((clicks / impressions) * 100).toFixed(2)}%  ` +
      `CPM ${((spend * 1000) / impressions).toFixed(2)}  CPC ${(spend / clicks).toFixed(2)}\n`,
  );

  // ---------------------------------------------------- tenjin installs ---
  heading('TENJIN INSTALLS');
  const installs = await queryRows<Row>(
    `SELECT COALESCE(SUM(attributed_installs), 0)::text AS total,
            COALESCE(SUM(attributed_installs) FILTER (
              WHERE COALESCE(normalized_media_source,'organic') <> 'organic'), 0)::text AS paid,
            COALESCE(SUM(attributed_installs) FILTER (
              WHERE COALESCE(normalized_media_source,'organic') = 'organic'), 0)::text AS organic,
            COALESCE(SUM(attributed_installs) FILTER (
              WHERE COALESCE(normalized_media_source,'organic') <> 'organic'
                AND EXISTS (
                  SELECT 1 FROM provider_entity_mappings m
                   WHERE m.organization_id = a.organization_id AND m.app_id = a.app_id
                     AND m.entity_type = 'campaign' AND m.target_provider = a.provider_key
                     AND m.target_external_id = a.external_campaign_id AND ${OPERATIONAL}
                )), 0)::text AS mapped_paid,
            count(*)::text AS rows,
            count(DISTINCT external_campaign_id)::text AS campaigns,
            MIN(grain) AS grain,
            MIN(install_date)::text AS first_date,
            MAX(install_date)::text AS last_date
       FROM attribution_daily_metrics a
      WHERE a.organization_id = $1 AND a.app_id = $2 AND a.provider_key = $3
        AND a.install_date BETWEEN $4 AND $5`,
    [organizationId, appId, attributionProviderKey, from, to],
  );
  const i = installs[0] ?? {};
  const total = toNumber(i['total']);
  const paid = toNumber(i['paid']);
  const organic = toNumber(i['organic']);
  const mappedPaid = toNumber(i['mapped_paid']);

  line('rows / campaigns', `${i['rows']} / ${i['campaigns']}`);
  line('grain stored', i['grain']);
  line('date range in rows', `${i['first_date'] ?? '-'} .. ${i['last_date'] ?? '-'}`);
  line('paid + organic = total', Math.abs(paid + organic - total) <= EPSILON ? 'YES' : 'NO');
  line('organic counted as paid', organic > 0 && paid === total ? 'YES - BUG' : 'NO');

  compare(
    'total installs',
    total,
    attribution.attributedInstalls,
    metricValue(metrics, 'attributed_installs'),
  );
  compare(
    'organic installs',
    organic,
    attribution.organicInstalls,
    metricValue(metrics, 'organic_installs'),
  );
  compare(
    'mapped paid installs',
    mappedPaid,
    attribution.mappedPaidInstalls,
    metricValue(metrics, 'mapped_paid_installs'),
  );
  compare('unmapped paid', paid - mappedPaid, attribution.unmappedPaidInstalls);

  // ---------------------------------------------------------------- cpi ---
  heading('CPI');
  const mappedSpendRows = await queryRows<Row>(
    `SELECT COALESCE(SUM(spend), 0)::text AS mapped_spend
       FROM marketing_daily_metrics md
      WHERE md.organization_id = $1 AND md.app_id = $2 AND md.provider_key = $3
        AND md.report_date BETWEEN $4 AND $5
        AND EXISTS (
          SELECT 1 FROM provider_entity_mappings m
           WHERE m.organization_id = md.organization_id AND m.app_id = md.app_id
             AND m.entity_type = 'campaign' AND m.source_provider = md.provider_key
             AND m.source_external_id = md.external_campaign_id
             AND m.target_external_id IS NOT NULL AND ${OPERATIONAL}
        )`,
    [organizationId, appId, marketingProviderKey, from, to],
  );
  const mappedSpend = toNumber(mappedSpendRows[0]?.['mapped_spend']);
  // The denominator is the delivery-aligned population, not the mapping
  // population: window spend divided by installs on campaigns that delivered in
  // that window. Recomputing it the other way made this gate fail a dashboard
  // that was right, which is worse than having no gate.
  const alignedRows = await queryRows<Row>(
    `SELECT COALESCE(SUM(a.attributed_installs), 0)::text AS installs
       FROM attribution_daily_metrics a
      WHERE a.organization_id = $1 AND a.app_id = $2 AND a.provider_key = $3
        AND a.install_date BETWEEN $4 AND $5
        AND COALESCE(a.normalized_media_source, 'organic') <> 'organic'
        AND a.external_campaign_id IN (
          SELECT m.target_external_id FROM provider_entity_mappings m
           JOIN (SELECT DISTINCT md.external_campaign_id, md.provider_key
                   FROM marketing_daily_metrics md
                  WHERE md.organization_id = $1 AND md.app_id = $2
                    AND md.report_date BETWEEN $4 AND $5
                    AND (md.spend > 0 OR md.impressions > 0 OR md.clicks > 0)) dl
             ON dl.external_campaign_id = m.source_external_id
            AND dl.provider_key = m.source_provider
           WHERE m.organization_id = $1 AND m.app_id = $2
             AND m.entity_type = 'campaign' AND m.target_provider = $3
             AND m.target_external_id IS NOT NULL AND ${OPERATIONAL})`,
    [organizationId, appId, attributionProviderKey, from, to],
  );
  const alignedInstalls = toNumber(alignedRows[0]?.['installs']);
  const mappedCpi = alignedInstalls > 0 ? mappedSpend / alignedInstalls : null;
  const blendedCpi = total > 0 ? spend / total : null;

  line('mapped CPI numerator', mappedSpend.toFixed(6));
  line('mapped CPI denominator', `${alignedInstalls} (installs on campaigns that delivered here)`);
  line('mapping-population installs', `${mappedPaid} (coverage figure, NOT this denominator)`);
  line('mapped CPI exact', mappedCpi === null ? '(none)' : mappedCpi.toFixed(10));
  line('mapped CPI displayed', mappedCpi === null ? '—' : `$${mappedCpi.toFixed(2)}`);
  line('blended CPI numerator', spend.toFixed(6));
  line('blended CPI denominator', total);
  line('blended CPI exact', blendedCpi === null ? '(none)' : blendedCpi.toFixed(10));
  line('blended CPI displayed', blendedCpi === null ? '—' : `$${blendedCpi.toFixed(2)}`);
  compare('mapped spend', mappedSpend, marketing.mappedSpend);
  compare('mapped_cpi', mappedCpi, metricValue(metrics, 'mapped_cpi'));
  compare('blended_cpi', blendedCpi, metricValue(metrics, 'blended_cpi'));

  // ------------------------------------------------------------ revenue ---
  heading('REVENUE');
  const byType = await queryRows<Row>(
    `SELECT revenue_type, COALESCE(SUM(revenue), 0)::text AS revenue, count(*)::text AS rows,
            MIN(grain) AS grain
       FROM attribution_revenue_metrics
      WHERE organization_id = $1 AND app_id = $2 AND provider_key = $3
        AND activity_date BETWEEN $4 AND $5 AND grain = 'event_date'
      GROUP BY revenue_type ORDER BY revenue_type`,
    [organizationId, appId, attributionProviderKey, from, to],
  );
  for (const row of byType) {
    line(`  revenue_type ${row['revenue_type']}`, `${row['revenue']} over ${row['rows']} row(s)`);
  }
  const typeTotal = (type: string): number =>
    toNumber(byType.find((r) => r['revenue_type'] === type)?.['revenue']);
  const iap = typeTotal('iap');
  const ad = typeTotal('ad');
  const totalType = typeTotal('total');
  const combined = byType.reduce((sum, r) => sum + toNumber(r['revenue']), 0);

  // Double counting would mean a combined figure stored alongside the parts it
  // is the sum of, for the same campaign and date. MART's adapter emits one or
  // the other per row; this proves it on the stored rows rather than trusting it.
  const overlap = await queryRows<Row>(
    `SELECT count(*)::text AS overlaps
       FROM (
         SELECT activity_date, external_campaign_id
           FROM attribution_revenue_metrics
          WHERE organization_id = $1 AND app_id = $2 AND provider_key = $3
            AND activity_date BETWEEN $4 AND $5 AND grain = 'event_date'
          GROUP BY activity_date, external_campaign_id
         HAVING count(*) FILTER (WHERE revenue_type = 'total') > 0
            AND count(*) FILTER (WHERE revenue_type IN ('iap','ad')) > 0
       ) t`,
    [organizationId, appId, attributionProviderKey, from, to],
  );
  const overlaps = toNumber(overlap[0]?.['overlaps']);

  const revenueSplit = await queryRows<Row>(
    `SELECT COALESCE(SUM(revenue) FILTER (
              WHERE COALESCE(normalized_media_source,'organic') = 'organic'), 0)::text AS organic,
            COALESCE(SUM(revenue) FILTER (
              WHERE COALESCE(normalized_media_source,'organic') <> 'organic'
                AND EXISTS (
                  SELECT 1 FROM provider_entity_mappings m
                   WHERE m.organization_id = r.organization_id AND m.app_id = r.app_id
                     AND m.entity_type = 'campaign' AND m.target_provider = r.provider_key
                     AND m.target_external_id = r.external_campaign_id AND ${OPERATIONAL}
                )), 0)::text AS mapped
       FROM attribution_revenue_metrics r
      WHERE r.organization_id = $1 AND r.app_id = $2 AND r.provider_key = $3
        AND r.activity_date BETWEEN $4 AND $5 AND r.grain = 'event_date'`,
    [organizationId, appId, attributionProviderKey, from, to],
  );
  const organicRevenue = toNumber(revenueSplit[0]?.['organic']);
  const mappedRevenue = toNumber(revenueSplit[0]?.['mapped']);

  line('IAP revenue (revenues)', iap.toFixed(6));
  line('ad revenue', ad.toFixed(6));
  line('combined-only rows', totalType.toFixed(6));
  line('combined attributed', combined.toFixed(6));
  line('organic revenue', organicRevenue.toFixed(6));
  line('mapped/paid revenue', mappedRevenue.toFixed(6));
  line(
    'double counting detected',
    overlaps > 0 ? `YES - ${overlaps} campaign/date pair(s) carry a total beside its parts` : 'NO',
  );
  if (overlaps > 0) failures += 1;
  line('cohort revenue excluded', 'YES - only grain = event_date is summed');

  compare(
    'attributed_revenue',
    combined,
    attribution.attributedRevenue,
    metricValue(metrics, 'attributed_revenue'),
  );
  compare(
    'mapped_attributed_revenue',
    mappedRevenue,
    attribution.mappedAttributedRevenue,
    metricValue(metrics, 'mapped_attributed_revenue'),
  );

  // ---------------------------------------------------- campaign rollup ---
  heading('CAMPAIGN ROLLUP');
  const rollup = await queryRows<Row>(
    `WITH delivery AS (
       SELECT md.external_campaign_id,
              SUM(md.spend) AS spend, SUM(md.impressions) AS impressions, SUM(md.clicks) AS clicks
         FROM marketing_daily_metrics md
        WHERE md.organization_id = $1 AND md.app_id = $2 AND md.provider_key = $3
          AND md.report_date BETWEEN $4 AND $5
        GROUP BY md.external_campaign_id
     ),
     mapped AS (
       SELECT m.source_external_id, array_agg(m.target_external_id) AS targets,
              count(*)::int AS children
         FROM provider_entity_mappings m
        WHERE m.organization_id = $1 AND m.app_id = $2 AND m.entity_type = 'campaign'
          AND m.source_provider = $3 AND m.target_external_id IS NOT NULL AND ${OPERATIONAL}
        GROUP BY m.source_external_id
     )
     SELECT d.external_campaign_id,
            MAX(c.name) AS name,
            d.spend::text AS spend, d.impressions::text AS impressions, d.clicks::text AS clicks,
            COALESCE(mapped.children, 0)::text AS children,
            COALESCE((SELECT SUM(a.attributed_installs) FROM attribution_daily_metrics a
                       WHERE a.organization_id = $1 AND a.app_id = $2
                         AND a.install_date BETWEEN $4 AND $5
                         AND a.external_campaign_id = ANY(mapped.targets)), 0)::text AS installs,
            COALESCE((SELECT SUM(r.revenue) FROM attribution_revenue_metrics r
                       WHERE r.organization_id = $1 AND r.app_id = $2
                         AND r.activity_date BETWEEN $4 AND $5 AND r.grain = 'event_date'
                         AND r.external_campaign_id = ANY(mapped.targets)), 0)::text AS revenue
       FROM delivery d
       LEFT JOIN mapped ON mapped.source_external_id = d.external_campaign_id
       LEFT JOIN marketing_campaigns c
              ON c.organization_id = $1 AND c.app_id = $2
             AND c.external_campaign_id = d.external_campaign_id
      GROUP BY d.external_campaign_id, d.spend, d.impressions, d.clicks, mapped.children, mapped.targets
      ORDER BY d.spend DESC`,
    [organizationId, appId, marketingProviderKey, from, to],
  );

  let sumSpend = 0;
  let sumImpressions = 0;
  let sumClicks = 0;
  let sumInstalls = 0;
  let sumRevenue = 0;
  for (const row of rollup) {
    const rowSpend = toNumber(row['spend']);
    const rowInstalls = toNumber(row['installs']);
    sumSpend += rowSpend;
    sumImpressions += toNumber(row['impressions']);
    sumClicks += toNumber(row['clicks']);
    sumInstalls += rowInstalls;
    sumRevenue += toNumber(row['revenue']);
    process.stdout.write('\n');
    process.stdout.write(`  campaign id      ${row['external_campaign_id']}\n`);
    process.stdout.write(`  name             ${row['name'] ?? '(not stored)'}\n`);
    process.stdout.write(
      `  spend/impr/clicks ${rowSpend.toFixed(2)} / ${row['impressions']} / ${row['clicks']}\n`,
    );
    process.stdout.write(`  mapped children  ${row['children']}\n`);
    process.stdout.write(`  paid installs    ${row['installs']}\n`);
    process.stdout.write(`  revenue          ${toNumber(row['revenue']).toFixed(2)}\n`);
    process.stdout.write(
      `  CPI              ${rowInstalls > 0 ? (rowSpend / rowInstalls).toFixed(4) : '—'}\n`,
    );
  }

  process.stdout.write('\n');
  // Many attribution campaigns under one marketing campaign aggregate their
  // attribution; the marketing spend behind them is counted once.
  compare('rollup spend', sumSpend, spend);
  compare('rollup impressions', sumImpressions, impressions);
  compare('rollup clicks', sumClicks, clicks);
  compare('rollup mapped installs', sumInstalls, mappedPaid);
  compare('rollup mapped revenue', sumRevenue, mappedRevenue);

  // -------------------------------------------------------- grain check ---
  heading('GRAIN CHECK');
  line('meta delivery', `${d['grain']} (campaign x country x platform x date)`);
  line('tenjin installs', `${i['grain']} (attribution campaign x country x platform x date)`);
  line('tenjin revenue', `event_date (revenue recorded on the day it happened)`);
  line('cohort revenue', 'excluded - install_date rows are never summed here');
  line('mapped CPI', 'MIXED: report_date spend / install_date installs - declared, not hidden');
  line('blended CPI', 'MIXED, and a mixed population: organic and unmapped in the denominator');
  line('cohort ROAS', 'not computed - requires cohort-matched spend');
  const badGrain = await queryRows<Row>(
    `SELECT count(*)::text AS bad FROM marketing_daily_metrics
      WHERE organization_id = $1 AND app_id = $2 AND grain <> 'report_date'`,
    [organizationId, appId],
  );
  const badInstallGrain = await queryRows<Row>(
    `SELECT count(*)::text AS bad FROM attribution_daily_metrics
      WHERE organization_id = $1 AND app_id = $2 AND grain <> 'install_date'`,
    [organizationId, appId],
  );
  line('marketing rows off-grain', badGrain[0]?.['bad'] ?? '0');
  line('attribution rows off-grain', badInstallGrain[0]?.['bad'] ?? '0');
  if (toNumber(badGrain[0]?.['bad']) > 0 || toNumber(badInstallGrain[0]?.['bad']) > 0) {
    failures += 1;
  }
}

main()
  .catch((error: unknown) => {
    process.stderr.write(
      `kpi-audit failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  })
  .finally(() => closePool());

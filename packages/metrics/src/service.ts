import type { IsoDate, MetricAvailability } from '@mart/shared';
import { queryRows, toNumber } from '@mart/db';
import {
  getMetricDefinition,
  listMetricDefinitions,
  safeRatio,
  type MetricDefinition,
  type MetricValue,
} from './registry.js';

export type MetricFilters = {
  organizationId: string;
  appId: string;
  from: IsoDate;
  to: IsoDate;
  country?: string | null;
  platform?: string | null;
  marketingProviderKey?: string | null;
  attributionProviderKey?: string | null;
  marketingAccountExternalId?: string | null;
};

/**
 * What MART knows about the app's connections when a metric is requested.
 *
 * Availability is decided from this rather than from whether a query happened
 * to return rows: "no Meta connection" and "Meta connected but zero spend" are
 * different answers and must look different on screen.
 */
export type MetricContext = {
  hasMarketingConnection: boolean;
  hasAttributionConnection: boolean;
  marketingProviders: string[];
  attributionProviders: string[];
  supportedCapabilities: Set<string>;
  marketingFreshness?: { status: string; latestDataDate: string | null } | undefined;
  attributionFreshness?: { status: string; latestDataDate: string | null } | undefined;
  mappingCoverage?: { total: number; authoritative: number } | undefined;
};

export type MarketingAggregate = {
  spend: number;
  impressions: number;
  clicks: number;
  linkClicks: number | null;
  rows: number;
  currencies: string[];
  latestDate: IsoDate | null;
};

export type AttributionAggregate = {
  attributedInstalls: number;
  attributedRevenue: number;
  rows: number;
  latestInstallDate: IsoDate | null;
  latestRevenueDate: IsoDate | null;
};

function marketingWhere(filters: MetricFilters, params: unknown[]): string {
  params.push(filters.organizationId, filters.appId, filters.from, filters.to);
  let sql = `organization_id = $1 AND app_id = $2 AND report_date BETWEEN $3 AND $4`;
  if (filters.marketingProviderKey) {
    params.push(filters.marketingProviderKey);
    sql += ` AND provider_key = $${params.length}`;
  }
  if (filters.country) {
    params.push(filters.country);
    sql += ` AND country = $${params.length}`;
  }
  if (filters.platform) {
    params.push(filters.platform);
    sql += ` AND platform = $${params.length}`;
  }
  if (filters.marketingAccountExternalId) {
    params.push(filters.marketingAccountExternalId);
    sql += ` AND external_account_id = $${params.length}`;
  }
  return sql;
}

export async function loadMarketingAggregate(filters: MetricFilters): Promise<MarketingAggregate> {
  const params: unknown[] = [];
  const where = marketingWhere(filters, params);
  const rows = await queryRows<{
    spend: string;
    impressions: string;
    clicks: string;
    link_clicks: string | null;
    row_count: string;
    currencies: string[];
    latest_date: string | null;
  }>(
    `SELECT COALESCE(SUM(spend), 0)::text AS spend,
            COALESCE(SUM(impressions), 0)::text AS impressions,
            COALESCE(SUM(clicks), 0)::text AS clicks,
            SUM(link_clicks)::text AS link_clicks,
            count(*)::text AS row_count,
            COALESCE(array_agg(DISTINCT currency) FILTER (WHERE currency IS NOT NULL), '{}') AS currencies,
            MAX(report_date)::text AS latest_date
     FROM marketing_daily_metrics
     WHERE ${where}`,
    params,
  );
  const row = rows[0];
  return {
    spend: toNumber(row?.spend),
    impressions: toNumber(row?.impressions),
    clicks: toNumber(row?.clicks),
    linkClicks:
      row?.link_clicks === null || row?.link_clicks === undefined
        ? null
        : toNumber(row.link_clicks),
    rows: toNumber(row?.row_count),
    currencies: row?.currencies ?? [],
    latestDate: (row?.latest_date as IsoDate | null) ?? null,
  };
}

export async function loadAttributionAggregate(
  filters: MetricFilters,
): Promise<AttributionAggregate> {
  const installParams: unknown[] = [
    filters.organizationId,
    filters.appId,
    filters.from,
    filters.to,
  ];
  let installWhere = `organization_id = $1 AND app_id = $2 AND install_date BETWEEN $3 AND $4`;
  if (filters.attributionProviderKey) {
    installParams.push(filters.attributionProviderKey);
    installWhere += ` AND provider_key = $${installParams.length}`;
  }
  if (filters.country) {
    installParams.push(filters.country);
    installWhere += ` AND country = $${installParams.length}`;
  }
  if (filters.platform) {
    installParams.push(filters.platform);
    installWhere += ` AND platform = $${installParams.length}`;
  }

  const installRows = await queryRows<{
    installs: string;
    row_count: string;
    latest_date: string | null;
  }>(
    `SELECT COALESCE(SUM(attributed_installs), 0)::text AS installs,
            count(*)::text AS row_count,
            MAX(install_date)::text AS latest_date
     FROM attribution_daily_metrics WHERE ${installWhere}`,
    installParams,
  );

  const revenueParams: unknown[] = [
    filters.organizationId,
    filters.appId,
    filters.from,
    filters.to,
  ];
  // Only event-date revenue is summed here. Install-date (cohort) revenue is a
  // different fact and is never added to it.
  let revenueWhere = `organization_id = $1 AND app_id = $2 AND activity_date BETWEEN $3 AND $4 AND grain = 'event_date'`;
  if (filters.attributionProviderKey) {
    revenueParams.push(filters.attributionProviderKey);
    revenueWhere += ` AND provider_key = $${revenueParams.length}`;
  }
  if (filters.country) {
    revenueParams.push(filters.country);
    revenueWhere += ` AND country = $${revenueParams.length}`;
  }
  if (filters.platform) {
    revenueParams.push(filters.platform);
    revenueWhere += ` AND platform = $${revenueParams.length}`;
  }

  const revenueRows = await queryRows<{ revenue: string; latest_date: string | null }>(
    `SELECT COALESCE(SUM(revenue), 0)::text AS revenue, MAX(activity_date)::text AS latest_date
     FROM attribution_revenue_metrics WHERE ${revenueWhere}`,
    revenueParams,
  );

  return {
    attributedInstalls: toNumber(installRows[0]?.installs),
    attributedRevenue: toNumber(revenueRows[0]?.revenue),
    rows: toNumber(installRows[0]?.row_count),
    latestInstallDate: (installRows[0]?.latest_date as IsoDate | null) ?? null,
    latestRevenueDate: (revenueRows[0]?.latest_date as IsoDate | null) ?? null,
  };
}

/**
 * Decide availability before looking at the number.
 *
 * Returning zero when a source is missing is the failure mode this exists to
 * prevent: an unconnected provider and a genuinely zero day must not look alike.
 */
export function determineAvailability(
  definition: MetricDefinition,
  context: MetricContext,
): { availability: MetricAvailability; reason?: string } {
  if (definition.unavailableReason) {
    return { availability: 'unavailable', reason: definition.unavailableReason };
  }
  if (definition.sources.includes('marketing') && !context.hasMarketingConnection) {
    return {
      availability: 'unavailable',
      reason: 'No marketing network is connected for this app.',
    };
  }
  if (definition.sources.includes('attribution') && !context.hasAttributionConnection) {
    return {
      availability: 'unavailable',
      reason: 'No attribution provider is configured for this app.',
    };
  }
  const missing = definition.requiredCapabilities.filter(
    (capability) => !context.supportedCapabilities.has(capability),
  );
  if (missing.length > 0) {
    return {
      availability: 'unavailable',
      reason: `The connected provider does not expose: ${missing.join(', ')}.`,
    };
  }

  const relevant: Array<{ status: string } | undefined> = [];
  if (definition.sources.includes('marketing')) relevant.push(context.marketingFreshness);
  if (definition.sources.includes('attribution')) relevant.push(context.attributionFreshness);
  if (relevant.some((f) => f?.status === 'stale' || f?.status === 'error')) {
    return { availability: 'stale', reason: 'Underlying data is stale; re-run the sync.' };
  }
  if (relevant.some((f) => f?.status === 'delayed')) {
    return { availability: 'partial', reason: 'Underlying data is behind its expected freshness.' };
  }
  return { availability: 'available' };
}

export function computeMetricValues(input: {
  metricKeys?: string[];
  context: MetricContext;
  marketing: MarketingAggregate;
  attribution: AttributionAggregate;
}): MetricValue[] {
  const definitions = input.metricKeys
    ? input.metricKeys
        .map((key) => getMetricDefinition(key))
        .filter((d): d is MetricDefinition => Boolean(d))
    : listMetricDefinitions();

  return definitions.map((definition) => buildMetricValue(definition, input));
}

function buildMetricValue(
  definition: MetricDefinition,
  input: {
    context: MetricContext;
    marketing: MarketingAggregate;
    attribution: AttributionAggregate;
  },
): MetricValue {
  const { context, marketing, attribution } = input;
  const base: MetricValue = {
    metricKey: definition.metricKey,
    displayName: definition.displayName,
    value: null,
    numerator: null,
    denominator: null,
    availability: 'unavailable',
    grain: definition.grain,
    sources: definition.sources,
    format: definition.format,
    formula: definition.formula,
    providers: providersFor(definition, context),
  };

  const gate = determineAvailability(definition, context);
  if (gate.availability === 'unavailable') {
    return {
      ...base,
      availability: 'unavailable',
      ...(gate.reason ? { reason: gate.reason } : {}),
    };
  }

  const freshness = definition.sources.includes('attribution')
    ? context.attributionFreshness
    : context.marketingFreshness;

  const withFreshness = (value: MetricValue): MetricValue => ({
    ...value,
    availability: gate.availability,
    ...(gate.reason ? { reason: gate.reason } : {}),
    ...(freshness
      ? { freshnessStatus: freshness.status, latestDataDate: freshness.latestDataDate }
      : {}),
  });

  switch (definition.metricKey) {
    case 'spend':
      return withFreshness({ ...base, value: marketing.spend, numerator: marketing.spend });
    case 'impressions':
      return withFreshness({
        ...base,
        value: marketing.impressions,
        numerator: marketing.impressions,
      });
    case 'clicks':
      return withFreshness({ ...base, value: marketing.clicks, numerator: marketing.clicks });
    case 'link_clicks':
      return marketing.linkClicks === null
        ? {
            ...base,
            availability: 'unavailable',
            reason: 'The marketing network did not report link clicks for this period.',
          }
        : withFreshness({ ...base, value: marketing.linkClicks, numerator: marketing.linkClicks });
    case 'ctr': {
      const ratio = safeRatio(
        marketing.clicks,
        marketing.impressions,
        definition.minimumDenominator,
      );
      return finishRatio(base, withFreshness, ratio, marketing.clicks, marketing.impressions);
    }
    case 'cpm': {
      const ratio = safeRatio(
        marketing.spend * 1000,
        marketing.impressions,
        definition.minimumDenominator,
      );
      return finishRatio(base, withFreshness, ratio, marketing.spend * 1000, marketing.impressions);
    }
    case 'cpc': {
      const ratio = safeRatio(marketing.spend, marketing.clicks, definition.minimumDenominator);
      return finishRatio(base, withFreshness, ratio, marketing.spend, marketing.clicks);
    }
    case 'attributed_installs':
      return withFreshness({
        ...base,
        value: attribution.attributedInstalls,
        numerator: attribution.attributedInstalls,
      });
    case 'attributed_revenue':
      return withFreshness({
        ...base,
        value: attribution.attributedRevenue,
        numerator: attribution.attributedRevenue,
      });
    case 'reported_cpi': {
      const ratio = safeRatio(
        marketing.spend,
        attribution.attributedInstalls,
        definition.minimumDenominator,
      );
      return finishRatio(
        base,
        withFreshness,
        ratio,
        marketing.spend,
        attribution.attributedInstalls,
      );
    }
    case 'mapping_coverage': {
      const coverage = context.mappingCoverage;
      if (!coverage || coverage.total === 0) {
        return {
          ...base,
          availability: 'unavailable',
          reason: 'No campaign mappings have been computed yet. Run a sync for both providers.',
        };
      }
      const ratio = safeRatio(
        coverage.authoritative,
        coverage.total,
        definition.minimumDenominator,
      );
      return finishRatio(base, withFreshness, ratio, coverage.authoritative, coverage.total);
    }
    default:
      return {
        ...base,
        availability: 'unavailable',
        reason: 'Metric is defined but not implemented in this phase.',
      };
  }
}

function finishRatio(
  base: MetricValue,
  withFreshness: (v: MetricValue) => MetricValue,
  ratio: { value: number | null; reason?: string },
  numerator: number,
  denominator: number,
): MetricValue {
  if (ratio.value === null) {
    return {
      ...base,
      numerator,
      denominator,
      availability: 'unavailable',
      ...(ratio.reason ? { reason: ratio.reason } : {}),
    };
  }
  return withFreshness({ ...base, value: ratio.value, numerator, denominator });
}

function providersFor(definition: MetricDefinition, context: MetricContext): string[] {
  const providers: string[] = [];
  if (definition.sources.includes('marketing')) providers.push(...context.marketingProviders);
  if (definition.sources.includes('attribution')) providers.push(...context.attributionProviders);
  return [...new Set(providers)];
}

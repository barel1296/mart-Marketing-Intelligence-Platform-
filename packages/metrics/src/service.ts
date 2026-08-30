import type { IsoDate, MetricAvailability } from '@mart/shared';
import { OPERATIONAL_MAPPING_CONFIDENCE } from '@mart/shared';
import { queryRows, toNumber } from '@mart/db';

/**
 * Organic is unpaid traffic. It is real attribution and stays in the totals,
 * but it can never belong to a paid campaign, so it is excluded from every
 * mapped figure.
 */
const NOT_ORGANIC = `COALESCE(t.normalized_media_source, 'organic') <> 'organic'`;

/**
 * The attribution campaign resolves to a marketing campaign, by stable id,
 * human verification, or a deterministic high-confidence name match.
 */
const MAPPED_ATTRIBUTION_CAMPAIGN = `t.external_campaign_id IN (
  SELECT m.target_external_id FROM provider_entity_mappings m
  WHERE m.organization_id = t.organization_id AND m.app_id = t.app_id
    AND m.entity_type = 'campaign'
    AND m.target_provider = t.provider_key
    AND m.target_external_id IS NOT NULL
    AND (m.status IN ('matched_exact', 'matched_confident', 'manually_verified')
         OR (m.status = 'matched_fallback'
             AND m.mapping_confidence >= ${OPERATIONAL_MAPPING_CONFIDENCE}))
)`;
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
  mappingCoverage?:
    | {
        total: number;
        authoritative: number;
        operational: number;
        /** Restricted to the selected reporting window; absent when unknown. */
        eligible?: {
          eligibleCampaigns: number;
          mappedCampaigns: number;
          ambiguousCampaigns: number;
          unmappedCampaigns: number;
          historicalCampaigns: number;
          totalSpend: number;
          mappedSpend: number;
          ambiguousSpend: number;
          unmappedSpend: number;
          totalPaidInstalls: number;
          mappedPaidInstalls: number;
          ambiguousPaidInstalls: number;
          unmappedPaidInstalls: number;
        };
      }
    | undefined;
};

export type MarketingAggregate = {
  spend: number;
  /** Spend on campaigns that have an operational mapping to attribution. */
  mappedSpend: number;
  impressions: number;
  clicks: number;
  linkClicks: number | null;
  rows: number;
  currencies: string[];
  latestDate: IsoDate | null;
};

/**
 * Attribution totals, split by what they can honestly be divided into.
 *
 * The whole point of the split: dividing network spend by *every* attributed
 * install - organic included - produces a number that looks like CPI and is
 * not one. Each denominator is therefore reported separately and labelled.
 */
export type AttributionAggregate = {
  /** Everything the MMP attributed, organic included. */
  attributedInstalls: number;
  attributedRevenue: number;
  /** Paid installs on campaigns mapped to the marketing network. */
  mappedPaidInstalls: number;
  mappedAttributedRevenue: number;
  /** Unpaid traffic. Never part of a paid campaign's CPI or ROAS. */
  organicInstalls: number;
  organicRevenue: number;
  /** Paid installs whose campaign has no usable mapping yet. */
  unmappedPaidInstalls: number;
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
    mapped_spend: string;
    impressions: string;
    clicks: string;
    link_clicks: string | null;
    row_count: string;
    currencies: string[];
    latest_date: string | null;
  }>(
    // mapped_spend is the numerator of a mapped CPI: only campaigns that
    // actually resolve to attribution may contribute to it, or the ratio is
    // spend for one set of campaigns over installs for another.
    `SELECT COALESCE(SUM(spend), 0)::text AS spend,
            COALESCE(SUM(spend) FILTER (WHERE external_campaign_id IN (
              SELECT source_external_id FROM provider_entity_mappings m
              WHERE m.organization_id = marketing_daily_metrics.organization_id
                AND m.app_id = marketing_daily_metrics.app_id
                AND m.entity_type = 'campaign'
                AND m.source_provider = marketing_daily_metrics.provider_key
                AND m.target_external_id IS NOT NULL
                AND (m.status IN ('matched_exact', 'matched_confident', 'manually_verified')
                     OR (m.status = 'matched_fallback'
                         AND m.mapping_confidence >= ${OPERATIONAL_MAPPING_CONFIDENCE}))
            )), 0)::text AS mapped_spend,
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
    mappedSpend: toNumber(row?.mapped_spend),
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
    mapped_installs: string;
    organic_installs: string;
    row_count: string;
    latest_date: string | null;
  }>(
    `SELECT COALESCE(SUM(attributed_installs), 0)::text AS installs,
            COALESCE(SUM(attributed_installs) FILTER (
              WHERE ${NOT_ORGANIC} AND ${MAPPED_ATTRIBUTION_CAMPAIGN}), 0)::text AS mapped_installs,
            COALESCE(SUM(attributed_installs) FILTER (WHERE NOT (${NOT_ORGANIC})), 0)::text
              AS organic_installs,
            count(*)::text AS row_count,
            MAX(install_date)::text AS latest_date
     FROM attribution_daily_metrics t WHERE ${installWhere}`,
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

  const revenueRows = await queryRows<{
    revenue: string;
    mapped_revenue: string;
    organic_revenue: string;
    latest_date: string | null;
  }>(
    `SELECT COALESCE(SUM(revenue), 0)::text AS revenue,
            COALESCE(SUM(revenue) FILTER (
              WHERE ${NOT_ORGANIC} AND ${MAPPED_ATTRIBUTION_CAMPAIGN}), 0)::text AS mapped_revenue,
            COALESCE(SUM(revenue) FILTER (WHERE NOT (${NOT_ORGANIC})), 0)::text AS organic_revenue,
            MAX(activity_date)::text AS latest_date
     FROM attribution_revenue_metrics t WHERE ${revenueWhere}`,
    revenueParams,
  );

  const attributedInstalls = toNumber(installRows[0]?.installs);
  const mappedPaidInstalls = toNumber(installRows[0]?.mapped_installs);
  const organicInstalls = toNumber(installRows[0]?.organic_installs);

  return {
    attributedInstalls,
    attributedRevenue: toNumber(revenueRows[0]?.revenue),
    mappedPaidInstalls,
    mappedAttributedRevenue: toNumber(revenueRows[0]?.mapped_revenue),
    organicInstalls,
    organicRevenue: toNumber(revenueRows[0]?.organic_revenue),
    // Paid installs MART cannot yet attach to a marketing campaign. Reported
    // rather than folded into either side.
    unmappedPaidInstalls: attributedInstalls - organicInstalls - mappedPaidInstalls,
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
    case 'mapped_paid_installs':
      return withFreshness({
        ...base,
        value: attribution.mappedPaidInstalls,
        numerator: attribution.mappedPaidInstalls,
      });
    case 'organic_installs':
      return withFreshness({
        ...base,
        value: attribution.organicInstalls,
        numerator: attribution.organicInstalls,
      });
    case 'mapped_attributed_revenue':
      return withFreshness({
        ...base,
        value: attribution.mappedAttributedRevenue,
        numerator: attribution.mappedAttributedRevenue,
      });
    case 'mapped_cpi': {
      // Both sides describe the same mapped campaigns. When nothing is mapped
      // the honest answer is the reason, not a number computed from a
      // denominator that does not match its numerator.
      if (attribution.mappedPaidInstalls === 0) {
        return {
          ...base,
          numerator: marketing.mappedSpend,
          denominator: 0,
          availability: 'unavailable',
          reason:
            attribution.attributedInstalls > 0
              ? 'No attribution campaign is mapped to a marketing campaign yet, so spend and installs cannot be attributed to the same campaigns. Reconcile campaigns first.'
              : 'No attributed installs for the selected filters.',
        };
      }
      const ratio = safeRatio(
        marketing.mappedSpend,
        attribution.mappedPaidInstalls,
        definition.minimumDenominator,
      );
      const value = finishRatio(
        base,
        withFreshness,
        ratio,
        marketing.mappedSpend,
        attribution.mappedPaidInstalls,
      );
      // Available, but not the whole picture: say how much paid attribution is
      // still outside the mapping rather than letting the number imply it all.
      if (value.availability === 'available' && attribution.unmappedPaidInstalls > 0) {
        return {
          ...value,
          availability: 'partial',
          reason: `${attribution.unmappedPaidInstalls} paid install(s) are on campaigns MART cannot map yet and are excluded from this figure.`,
        };
      }
      return value;
    }
    case 'blended_cpi': {
      const ratio = safeRatio(
        marketing.spend,
        attribution.attributedInstalls,
        definition.minimumDenominator,
      );
      const value = finishRatio(
        base,
        withFreshness,
        ratio,
        marketing.spend,
        attribution.attributedInstalls,
      );
      // The denominator contains installs the numerator did not buy. That is
      // the definition of this metric, and it is stated on every render.
      if (value.availability === 'available') {
        const mixedIn = attribution.organicInstalls + attribution.unmappedPaidInstalls;
        return mixedIn > 0
          ? {
              ...value,
              availability: 'partial',
              reason: `Denominator includes ${attribution.organicInstalls} organic and ${attribution.unmappedPaidInstalls} unmapped paid install(s). This is a blended figure, not a campaign CPI.`,
            }
          : value;
      }
      return value;
    }
    case 'spend_coverage':
    case 'attribution_coverage':
    case 'campaign_operational_coverage': {
      const eligible = context.mappingCoverage?.eligible;
      if (!eligible) {
        return {
          ...base,
          availability: 'unavailable',
          reason:
            'Period coverage needs a reconciled mapping set for the selected window. Run a sync for both providers, then recompute mappings.',
        };
      }
      // Three separate questions, never blended: how many campaigns, how much
      // money, how much attribution.
      const [numerator, denominator, ambiguousShare] =
        definition.metricKey === 'spend_coverage'
          ? [eligible.mappedSpend, eligible.totalSpend, eligible.ambiguousSpend]
          : definition.metricKey === 'attribution_coverage'
            ? [
                eligible.mappedPaidInstalls,
                eligible.totalPaidInstalls,
                eligible.ambiguousPaidInstalls,
              ]
            : [eligible.mappedCampaigns, eligible.eligibleCampaigns, eligible.ambiguousCampaigns];

      if (denominator === 0) {
        return {
          ...base,
          numerator,
          denominator,
          availability: 'unavailable',
          reason: 'Nothing delivered in the selected period for this to be a share of.',
        };
      }
      const ratio = safeRatio(numerator, denominator, definition.minimumDenominator);
      const value = finishRatio(base, withFreshness, ratio, numerator, denominator);
      // An ambiguous slice is not merely missing: MART found candidates and
      // refused to guess, and a person can resolve it.
      return value.availability === 'available' && ambiguousShare > 0
        ? {
            ...value,
            availability: 'partial',
            reason: `${ambiguousShare} of the denominator is ambiguous: MART found more than one candidate and will not pick one. Resolve it on the reconciliation screen.`,
          }
        : value;
    }
    case 'mapping_coverage':
    case 'operational_mapping_coverage': {
      const coverage = context.mappingCoverage;
      if (!coverage || coverage.total === 0) {
        return {
          ...base,
          availability: 'unavailable',
          reason: 'No campaign mappings have been computed yet. Run a sync for both providers.',
        };
      }
      // Two different questions, kept apart: what MART would stake identity on,
      // and what it can operate on.
      const numerator =
        definition.metricKey === 'operational_mapping_coverage'
          ? coverage.operational
          : coverage.authoritative;
      const ratio = safeRatio(numerator, coverage.total, definition.minimumDenominator);
      return finishRatio(base, withFreshness, ratio, numerator, coverage.total);
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

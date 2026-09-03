import type {
  CohortAge,
  CohortRevenueType,
  IsoDate,
  MetricAvailability,
  MetricBlocker,
} from '@mart/shared';
import {
  COHORT_AGES,
  channelForProvider,
  mediaSourcesForChannel,
  type CanonicalChannel,
} from '@mart/shared';
import {
  cohortSpendAlignedCampaign,
  deliveryAlignedCampaign,
  mappedAttributionCampaign,
  mappedMarketingCampaign,
  notOrganic,
  operationalMapping,
  organic,
} from './populations.js';
import { queryRows, toNumber, type Queryable } from '@mart/db';
import { MAXIMUM_AMBIGUOUS_SPEND_PCT, MINIMUM_SPEND_COVERAGE_PCT } from './thresholds.js';

/**
 * The population predicates every figure below is built from.
 *
 * Defined once in ./populations.ts and bound to this file's table aliases here,
 * so mapped spend, mapped installs and the coverage cards cannot drift apart.
 */
const NOT_ORGANIC = notOrganic('t');
const MAPPED_ATTRIBUTION_CAMPAIGN = mappedAttributionCampaign('t');
/**
 * Build the delivery-aligned predicate for one query.
 *
 * Not a constant, because the delivery side has to carry the same dimension
 * filters as the rows being counted: $3 and $4 are always the window, but the
 * country and platform binds land at whatever position the caller pushed them.
 */
function deliveryAligned(dimensions: string): string {
  return deliveryAlignedCampaign({ from: '$3', to: '$4', delivery: dimensions }, 't');
}

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
  /**
   * Canonical channel - paid_social, paid_search, paid_network, organic.
   *
   * Resolved against the providers that reported the rows rather than stored on
   * them: channel is a property of who delivered the traffic, and deriving it
   * per row would make it drift the moment a provider's classification changed.
   */
  channel?: string | null;
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
  /**
   * For a capability the provider does NOT support: the exact external action
   * that would enable it, as recorded when the capability was probed (for
   * example which metric to add to a Tenjin saved report). Surfaced in the
   * metric's reason so an unavailable figure says what to change, not just
   * that it cannot be shown.
   */
  capabilityNotes?: Record<string, string> | undefined;
  marketingFreshness?:
    | { status: string; latestDataDate: string | null; minutesSinceSuccess?: number | null }
    | undefined;
  attributionFreshness?:
    | { status: string; latestDataDate: string | null; minutesSinceSuccess?: number | null }
    | undefined;
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
  /**
   * The subset of the mapped population whose marketing campaign also
   * delivered in the selected window. This is the only install population a
   * window's spend may be divided by: the other one contains installs the
   * window's spend did not buy.
   */
  deliveryAlignedPaidInstalls: number;
  deliveryAlignedRevenue: number;
  /**
   * Attributed revenue split by what produced it. In-app purchases and ad
   * mediation are different businesses with different margins, and a single
   * "revenue" number hides which one moved. Both are event-date, and they sum
   * to the attributed total for rows that report components.
   */
  iapRevenue: number;
  adRevenue: number;
  /**
   * Every distinct currency present in the revenue rows. More than one means
   * the total is not a number: summing them would invent an exchange rate.
   */
  currencies: string[];
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

/**
 * Whether the bound providers can serve this channel filter at all.
 *
 * Channel is provider-derived, so a filter naming a channel no bound provider
 * belongs to selects nothing. Saying so is the honest answer; returning zeros
 * would look like an account with no such traffic.
 */
export function channelMatchesProvider(
  channel: string | null | undefined,
  providerKey: string | null | undefined,
): boolean {
  if (!channel) return true;
  return channelForProvider(providerKey ?? null) === channel;
}

/**
 * `client` lets a caller run this exact production path inside its own
 * transaction. The currency-gate proof depends on that: it injects a second
 * currency, asks THIS function what it sees, and rolls back - so the audit
 * exercises the real code rather than a copy of it. Omitted, the pool is used
 * as before.
 */
export async function loadMarketingAggregate(
  filters: MetricFilters,
  client?: Queryable,
): Promise<MarketingAggregate> {
  const params: unknown[] = [];
  // Channel is derived from the provider that reported the row, so a filter
  // naming a channel the bound network does not belong to matches nothing.
  // Narrowing the WHERE to a contradiction says that in one place rather than
  // leaving each measure to arrive at zero separately.
  const channelExcluded = !channelMatchesProvider(filters.channel, filters.marketingProviderKey);
  const where = channelExcluded ? 'false' : marketingWhere(filters, params);
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
                AND ${operationalMapping('m')}
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
    client,
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
  client?: Queryable,
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
  // Channel on the attribution side is a property of the media source that
  // delivered the install, so it narrows rows rather than short-circuiting.
  // The source list is generated from the same taxonomy the labels use.
  if (filters.channel === 'organic') {
    installWhere += ` AND ${organic('t')}`;
  } else if (filters.channel) {
    installParams.push(mediaSourcesForChannel(filters.channel as CanonicalChannel));
    installWhere += ` AND normalized_media_source = ANY($${installParams.length}::text[])`;
  }

  let installDelivery = '';
  if (filters.country) {
    installParams.push(filters.country);
    installWhere += ` AND country = $${installParams.length}`;
    installDelivery += ` AND md.country = $${installParams.length}`;
  }
  if (filters.platform) {
    installParams.push(filters.platform);
    installWhere += ` AND platform = $${installParams.length}`;
    installDelivery += ` AND md.platform = $${installParams.length}`;
  }
  const installAligned = deliveryAligned(installDelivery);

  const installRows = await queryRows<{
    installs: string;
    mapped_installs: string;
    delivery_aligned_installs: string;
    organic_installs: string;
    row_count: string;
    latest_date: string | null;
  }>(
    `SELECT COALESCE(SUM(attributed_installs), 0)::text AS installs,
            COALESCE(SUM(attributed_installs) FILTER (
              WHERE ${NOT_ORGANIC} AND ${MAPPED_ATTRIBUTION_CAMPAIGN}), 0)::text AS mapped_installs,
            COALESCE(SUM(attributed_installs) FILTER (
              WHERE ${NOT_ORGANIC} AND ${installAligned}), 0)::text
              AS delivery_aligned_installs,
            COALESCE(SUM(attributed_installs) FILTER (WHERE NOT (${NOT_ORGANIC})), 0)::text
              AS organic_installs,
            count(*)::text AS row_count,
            MAX(install_date)::text AS latest_date
     FROM attribution_daily_metrics t WHERE ${installWhere}`,
    installParams,
    client,
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
  if (filters.channel === 'organic') {
    revenueWhere += ` AND ${organic('t')}`;
  } else if (filters.channel) {
    revenueParams.push(mediaSourcesForChannel(filters.channel as CanonicalChannel));
    revenueWhere += ` AND normalized_media_source = ANY($${revenueParams.length}::text[])`;
  }

  let revenueDelivery = '';
  if (filters.country) {
    revenueParams.push(filters.country);
    revenueWhere += ` AND country = $${revenueParams.length}`;
    revenueDelivery += ` AND md.country = $${revenueParams.length}`;
  }
  if (filters.platform) {
    revenueParams.push(filters.platform);
    revenueWhere += ` AND platform = $${revenueParams.length}`;
    revenueDelivery += ` AND md.platform = $${revenueParams.length}`;
  }
  const revenueAligned = deliveryAligned(revenueDelivery);

  const revenueRows = await queryRows<{
    revenue: string;
    mapped_revenue: string;
    delivery_aligned_revenue: string;
    organic_revenue: string;
    iap_revenue: string;
    ad_revenue: string;
    currencies: string[];
    latest_date: string | null;
  }>(
    `SELECT COALESCE(SUM(revenue), 0)::text AS revenue,
            COALESCE(SUM(revenue) FILTER (
              WHERE ${NOT_ORGANIC} AND ${MAPPED_ATTRIBUTION_CAMPAIGN}), 0)::text AS mapped_revenue,
            COALESCE(SUM(revenue) FILTER (
              WHERE ${NOT_ORGANIC} AND ${revenueAligned}), 0)::text
              AS delivery_aligned_revenue,
            COALESCE(SUM(revenue) FILTER (WHERE NOT (${NOT_ORGANIC})), 0)::text AS organic_revenue,
            COALESCE(SUM(revenue) FILTER (WHERE revenue_type = 'iap'), 0)::text AS iap_revenue,
            COALESCE(SUM(revenue) FILTER (WHERE revenue_type = 'ad'), 0)::text AS ad_revenue,
            COALESCE(array_agg(DISTINCT currency) FILTER (WHERE currency IS NOT NULL), '{}')
              AS currencies,
            MAX(activity_date)::text AS latest_date
     FROM attribution_revenue_metrics t WHERE ${revenueWhere}`,
    revenueParams,
    client,
  );

  const attributedInstalls = toNumber(installRows[0]?.installs);
  const mappedPaidInstalls = toNumber(installRows[0]?.mapped_installs);
  const organicInstalls = toNumber(installRows[0]?.organic_installs);

  return {
    attributedInstalls,
    attributedRevenue: toNumber(revenueRows[0]?.revenue),
    mappedPaidInstalls,
    mappedAttributedRevenue: toNumber(revenueRows[0]?.mapped_revenue),
    deliveryAlignedPaidInstalls: toNumber(installRows[0]?.delivery_aligned_installs),
    deliveryAlignedRevenue: toNumber(revenueRows[0]?.delivery_aligned_revenue),
    organicInstalls,
    organicRevenue: toNumber(revenueRows[0]?.organic_revenue),
    iapRevenue: toNumber(revenueRows[0]?.iap_revenue),
    adRevenue: toNumber(revenueRows[0]?.ad_revenue),
    currencies: revenueRows[0]?.currencies ?? [],
    // Paid installs MART cannot yet attach to a marketing campaign. Reported
    // rather than folded into either side.
    unmappedPaidInstalls: attributedInstalls - organicInstalls - mappedPaidInstalls,
    rows: toNumber(installRows[0]?.row_count),
    latestInstallDate: (installRows[0]?.latest_date as IsoDate | null) ?? null,
    latestRevenueDate: (revenueRows[0]?.latest_date as IsoDate | null) ?? null,
  };
}

/**
 * One revenue component of the window's cohorts at one age.
 *
 * Every figure is over MATURE cohorts only: cohorts whose install day plus the
 * age is strictly before the provider's data horizon, and whose stored row was
 * last read after that day. The two immature figures are carried so a caller
 * can say how much was excluded - they are never added to anything.
 */
export type CohortRevenueSlice = {
  /** Mature cohorts, every media source. */
  revenue: number;
  organicRevenue: number;
  mappedPaidRevenue: number;
  /** Paid cohorts on campaigns with no operational mapping: no spend to borrow. */
  unmappedPaidRevenue: number;
  /** Mature, paid, mapped, and the marketing campaign spent on the install day. */
  alignedRevenue: number;
  /** Cohorts in the window younger than this age. Reported, never summed. */
  immatureRevenue: number;
  /** Old enough by the calendar, but last read before reaching the age. */
  earlyReadRevenue: number;
  earlyReadRows: number;
  currencies: string[];
  alignedCurrencies: string[];
  rows: number;
};

export type CohortAgeAggregate = {
  ageDays: CohortAge;
  /** Distinct install days in the window old enough for this age, from install rows. */
  matureCohortDays: number;
  /** Distinct install days in the window not yet this old. Counted, never zeroed. */
  immatureCohortDays: number;
  /**
   * Distinct install days old enough for this age that the revenue stream has
   * not read since they reached it. A day the provider was never asked about
   * after the cohort matured is not a day the cohort earned nothing on; it is
   * excluded from BOTH sides and reported, like an immature day.
   */
  uncoveredCohortDays: number;
  /** Installs of mature cohorts: the RPI denominator. */
  installs: number;
  paidInstalls: number;
  organicInstalls: number;
  /**
   * Spend on (mapped campaign, install day) pairs for mature install days -
   * the only spend a cohort ROAS may be divided by.
   */
  alignedSpend: number;
  alignedSpendCurrencies: string[];
  alignedCampaignDays: number;
  revenue: Record<CohortRevenueType, CohortRevenueSlice>;
};

export type CohortAggregate = {
  /**
   * The attribution provider's data horizon: the latest date any attribution
   * stream has data for. A cohort is mature at age N only when its install
   * day plus N is strictly before this. Null until a sync has landed.
   */
  asOf: IsoDate | null;
  byAge: Record<CohortAge, CohortAgeAggregate>;
};

function emptySlice(): CohortRevenueSlice {
  return {
    revenue: 0,
    organicRevenue: 0,
    mappedPaidRevenue: 0,
    unmappedPaidRevenue: 0,
    alignedRevenue: 0,
    immatureRevenue: 0,
    earlyReadRevenue: 0,
    earlyReadRows: 0,
    currencies: [],
    alignedCurrencies: [],
    rows: 0,
  };
}

function emptyAge(ageDays: CohortAge): CohortAgeAggregate {
  return {
    ageDays,
    matureCohortDays: 0,
    immatureCohortDays: 0,
    uncoveredCohortDays: 0,
    installs: 0,
    paidInstalls: 0,
    organicInstalls: 0,
    alignedSpend: 0,
    alignedSpendCurrencies: [],
    alignedCampaignDays: 0,
    revenue: { iap: emptySlice(), ad: emptySlice(), total: emptySlice() },
  };
}

export function emptyCohortAggregate(asOf: IsoDate | null = null): CohortAggregate {
  const byAge = {} as Record<CohortAge, CohortAgeAggregate>;
  for (const age of COHORT_AGES) byAge[age] = emptyAge(age);
  return { asOf, byAge };
}

/**
 * Whether the attribution revenue stream READ `dayExpr` after the cohort that
 * installed that day reached `ageParam` days, in the app's own calendar.
 *
 * Coverage comes from the revenue sync's own record of the dates its rows
 * carried (sync_runs.checkpoint.dataWindows), never from the rows in storage:
 * a cohort that earned nothing leaves no row, and that must stay distinct
 * from a day MART never read - or read only before the cohort matured. A day
 * that is not covered is excluded from every side of every cohort figure and
 * reported, exactly like an immature day. This is what keeps a shorter saved
 * report, a failed window or a sync that has not run yet from reading as
 * "these cohorts earned nothing".
 */
function revenueCovered(input: {
  alias: string;
  dayExpr: string;
  ageParam: string;
  timezoneExpr: string;
  providerParam?: string | undefined;
}): string {
  const { alias, dayExpr, ageParam, timezoneExpr, providerParam } = input;
  return `EXISTS (
    SELECT 1 FROM sync_runs r,
         jsonb_array_elements(COALESCE(r.checkpoint->'dataWindows', '[]'::jsonb)) w
     WHERE r.organization_id = ${alias}.organization_id AND r.app_id = ${alias}.app_id
       AND r.data_type = 'attribution_revenue'
       AND r.status IN ('completed', 'partially_completed')${
         providerParam ? `\n       AND r.provider_key = ${providerParam}` : ''
       }
       AND (w->>'from')::date <= ${dayExpr} AND ${dayExpr} <= (w->>'to')::date
       AND (r.finished_at AT TIME ZONE ${timezoneExpr})::date > (${dayExpr} + ${ageParam}::int)
  )`;
}

/**
 * The window's install cohorts, at every age MART serves.
 *
 * Three questions, each answered from its own fact table and never from
 * another's rows:
 *
 *  - Which install days exist and how old are they? From the install rows,
 *    so an immature cohort is counted even when it has earned nothing yet.
 *  - What did the mature cohorts earn by D{N}? From cohort_date revenue rows,
 *    split by who can honestly claim it: organic, mapped, unmapped, aligned.
 *  - What was spent acquiring them? From marketing rows on report_date = the
 *    install day, for the campaigns those cohorts map to.
 *
 * `client` lets the currency proof run this exact path inside a transaction.
 */
export async function loadCohortAggregate(
  filters: MetricFilters,
  client?: Queryable,
): Promise<CohortAggregate> {
  // The data horizon: the latest day BOTH attribution streams have data for.
  // Installs define the cohorts and revenue rows define what they earned, so
  // a day only one stream has reached is a day nothing can be said about. The
  // earlier of the two, never the later: a cohort's age is measured against
  // this rather than the wall clock, so a lagging stream cannot make a cohort
  // look mature - or look like it earned nothing - before the provider said so.
  const horizonParams: unknown[] = [filters.organizationId, filters.appId];
  let horizonWhere = `organization_id = $1 AND app_id = $2
       AND data_type IN ('attribution_installs', 'attribution_revenue')`;
  if (filters.attributionProviderKey) {
    horizonParams.push(filters.attributionProviderKey);
    horizonWhere += ` AND provider_key = $${horizonParams.length}`;
  }
  const horizon = await queryRows<{ as_of: string | null }>(
    `SELECT CASE WHEN count(*) = 2 AND count(latest) = 2 THEN MIN(latest) END::text AS as_of
       FROM (SELECT data_type, MAX(latest_provider_data_date) AS latest
               FROM data_freshness WHERE ${horizonWhere} GROUP BY data_type) streams`,
    horizonParams,
    client,
  );
  const asOf = (horizon[0]?.as_of as IsoDate | null | undefined) ?? null;
  const aggregate = emptyCohortAggregate(asOf);
  if (!asOf) return aggregate;

  // ----------------------------------------------------- cohort revenue ---
  const revenueParams: unknown[] = [
    filters.organizationId,
    filters.appId,
    filters.from,
    filters.to,
    asOf,
    [...COHORT_AGES],
  ];
  let revenueWhere = `t.organization_id = $1 AND t.app_id = $2 AND t.activity_date BETWEEN $3 AND $4
       AND t.grain = 'cohort_date' AND t.cohort_age_days = ANY($6::int[])`;
  let revenueProvider: string | undefined;
  if (filters.attributionProviderKey) {
    revenueParams.push(filters.attributionProviderKey);
    revenueProvider = `$${revenueParams.length}`;
    revenueWhere += ` AND t.provider_key = ${revenueProvider}`;
  }
  if (filters.channel === 'organic') {
    revenueWhere += ` AND ${organic('t')}`;
  } else if (filters.channel) {
    revenueParams.push(mediaSourcesForChannel(filters.channel as CanonicalChannel));
    revenueWhere += ` AND t.normalized_media_source = ANY($${revenueParams.length}::text[])`;
  }
  let revenueDelivery = '';
  if (filters.country) {
    revenueParams.push(filters.country);
    revenueWhere += ` AND t.country = $${revenueParams.length}`;
    revenueDelivery += ` AND md.country = $${revenueParams.length}`;
  }
  if (filters.platform) {
    revenueParams.push(filters.platform);
    revenueWhere += ` AND t.platform = $${revenueParams.length}`;
    revenueDelivery += ` AND md.platform = $${revenueParams.length}`;
  }
  // The spend side of "aligned" is narrowed by exactly the marketing binds the
  // denominator query applies below. Without this a cohort mapped to another
  // account's campaign would sit in the numerator while that account's spend
  // is filtered out of the denominator.
  if (filters.marketingProviderKey) {
    revenueParams.push(filters.marketingProviderKey);
    revenueDelivery += ` AND md.provider_key = $${revenueParams.length}`;
  }
  if (filters.marketingAccountExternalId) {
    revenueParams.push(filters.marketingAccountExternalId);
    revenueDelivery += ` AND md.external_account_id = $${revenueParams.length}`;
  }

  const revenueRows = await queryRows<{
    age: number;
    revenue_type: string;
    revenue: string;
    organic_revenue: string;
    mapped_paid_revenue: string;
    unmapped_paid_revenue: string;
    aligned_revenue: string;
    immature_revenue: string;
    early_read_revenue: string;
    early_read_rows: string;
    currencies: string[];
    aligned_currencies: string[];
    row_count: string;
  }>(
    `WITH cohort AS (
       SELECT t.cohort_age_days AS age, t.revenue_type, t.revenue, t.currency,
              (t.activity_date + t.cohort_age_days) < $5::date AS matured,
              -- Read after the cohort reached this age, in the app's own
              -- calendar. A value read on day 3 and labelled D7 is a partial
              -- figure whatever the column says.
              (t.observed_at AT TIME ZONE a.timezone)::date > (t.activity_date + t.cohort_age_days)
                AS read_after,
              -- Mature: old enough, read after reaching the age, AND the day
              -- is one the revenue stream covered after that - the same test
              -- the install and spend sides apply, so the three describe the
              -- same days.
              ((t.activity_date + t.cohort_age_days) < $5::date
                AND (t.observed_at AT TIME ZONE a.timezone)::date > (t.activity_date + t.cohort_age_days)
                AND ${revenueCovered({
                  alias: 't',
                  dayExpr: 't.activity_date',
                  ageParam: 't.cohort_age_days',
                  timezoneExpr: 'a.timezone',
                  providerParam: revenueProvider,
                })}) AS mature,
              (${NOT_ORGANIC}) AS paid,
              (${MAPPED_ATTRIBUTION_CAMPAIGN}) AS mapped,
              (${cohortSpendAlignedCampaign(revenueDelivery, 't')}) AS aligned
         FROM attribution_revenue_metrics t
         JOIN apps a ON a.id = t.app_id
        WHERE ${revenueWhere}
          -- A provider total is read only where no component row exists for
          -- the same cohort. A report that gains the split later leaves its
          -- old totals behind, and those must not be added to the parts.
          AND (t.revenue_type <> 'total' OR NOT EXISTS (
                SELECT 1 FROM attribution_revenue_metrics c
                 WHERE c.connection_id = t.connection_id AND c.app_id = t.app_id
                   AND c.grain = 'cohort_date' AND c.cohort_age_days = t.cohort_age_days
                   AND c.activity_date = t.activity_date AND c.revenue_type IN ('iap', 'ad')
                   AND c.media_source IS NOT DISTINCT FROM t.media_source
                   AND c.external_campaign_id IS NOT DISTINCT FROM t.external_campaign_id
                   AND c.country IS NOT DISTINCT FROM t.country
                   AND c.platform = t.platform AND c.currency = t.currency))
     )
     SELECT age, revenue_type,
            COALESCE(SUM(revenue) FILTER (WHERE mature), 0)::text AS revenue,
            COALESCE(SUM(revenue) FILTER (WHERE mature AND NOT paid), 0)::text
              AS organic_revenue,
            COALESCE(SUM(revenue) FILTER (WHERE mature AND paid AND mapped), 0)::text
              AS mapped_paid_revenue,
            COALESCE(SUM(revenue) FILTER (WHERE mature AND paid AND NOT mapped), 0)::text
              AS unmapped_paid_revenue,
            COALESCE(SUM(revenue) FILTER (WHERE mature AND paid AND aligned), 0)::text
              AS aligned_revenue,
            COALESCE(SUM(revenue) FILTER (WHERE NOT matured), 0)::text AS immature_revenue,
            COALESCE(SUM(revenue) FILTER (WHERE matured AND NOT read_after), 0)::text
              AS early_read_revenue,
            count(*) FILTER (WHERE matured AND NOT read_after)::text AS early_read_rows,
            COALESCE(array_agg(DISTINCT currency) FILTER (WHERE mature), '{}')
              AS currencies,
            COALESCE(array_agg(DISTINCT currency)
              FILTER (WHERE mature AND paid AND aligned), '{}') AS aligned_currencies,
            count(*)::text AS row_count
       FROM cohort
      GROUP BY age, revenue_type`,
    revenueParams,
    client,
  );

  const sliceFrom = (row: (typeof revenueRows)[number]): CohortRevenueSlice => ({
    revenue: toNumber(row.revenue),
    organicRevenue: toNumber(row.organic_revenue),
    mappedPaidRevenue: toNumber(row.mapped_paid_revenue),
    unmappedPaidRevenue: toNumber(row.unmapped_paid_revenue),
    alignedRevenue: toNumber(row.aligned_revenue),
    immatureRevenue: toNumber(row.immature_revenue),
    earlyReadRevenue: toNumber(row.early_read_revenue),
    earlyReadRows: toNumber(row.early_read_rows),
    currencies: row.currencies ?? [],
    alignedCurrencies: row.aligned_currencies ?? [],
    rows: toNumber(row.row_count),
  });
  const addSlice = (into: CohortRevenueSlice, from: CohortRevenueSlice): void => {
    into.revenue += from.revenue;
    into.organicRevenue += from.organicRevenue;
    into.mappedPaidRevenue += from.mappedPaidRevenue;
    into.unmappedPaidRevenue += from.unmappedPaidRevenue;
    into.alignedRevenue += from.alignedRevenue;
    into.immatureRevenue += from.immatureRevenue;
    into.earlyReadRevenue += from.earlyReadRevenue;
    into.earlyReadRows += from.earlyReadRows;
    into.currencies = [...new Set([...into.currencies, ...from.currencies])].sort();
    into.alignedCurrencies = [
      ...new Set([...into.alignedCurrencies, ...from.alignedCurrencies]),
    ].sort();
    into.rows += from.rows;
  };
  for (const row of revenueRows) {
    const age = aggregate.byAge[toNumber(row.age) as CohortAge];
    if (!age) continue;
    const slice = sliceFrom(row);
    if (row.revenue_type === 'iap' || row.revenue_type === 'ad') {
      addSlice(age.revenue[row.revenue_type], slice);
    }
    // `total` is every component stored at this age, plus a provider total
    // only where the query above found no component for the same cohort - a
    // report that gained the split later cannot count both.
    addSlice(age.revenue.total, slice);
  }

  // ---------------------------------------------------- cohort installs ---
  for (const ageDays of COHORT_AGES) {
    const installParams: unknown[] = [
      filters.organizationId,
      filters.appId,
      filters.from,
      filters.to,
      asOf,
      ageDays,
    ];
    let installWhere = `t.organization_id = $1 AND t.app_id = $2 AND t.install_date BETWEEN $3 AND $4`;
    let installProvider: string | undefined;
    if (filters.attributionProviderKey) {
      installParams.push(filters.attributionProviderKey);
      installProvider = `$${installParams.length}`;
      installWhere += ` AND t.provider_key = ${installProvider}`;
    }
    if (filters.channel === 'organic') {
      installWhere += ` AND ${organic('t')}`;
    } else if (filters.channel) {
      installParams.push(mediaSourcesForChannel(filters.channel as CanonicalChannel));
      installWhere += ` AND t.normalized_media_source = ANY($${installParams.length}::text[])`;
    }
    if (filters.country) {
      installParams.push(filters.country);
      installWhere += ` AND t.country = $${installParams.length}`;
    }
    if (filters.platform) {
      installParams.push(filters.platform);
      installWhere += ` AND t.platform = $${installParams.length}`;
    }
    // Three states for an install day, never two: old enough and read by the
    // revenue stream since (mature), not old enough (immature), or old enough
    // but never read since it matured (uncovered). Only the first is counted.
    const oldEnough = `(t.install_date + $6::int) < $5::date`;
    const covered = revenueCovered({
      alias: 't',
      dayExpr: 't.install_date',
      ageParam: '$6',
      timezoneExpr: 'a.timezone',
      providerParam: installProvider,
    });
    const mature = `(${oldEnough} AND ${covered})`;
    const installRows = await queryRows<{
      installs: string;
      paid_installs: string;
      organic_installs: string;
      mature_days: string;
      immature_days: string;
      uncovered_days: string;
    }>(
      `SELECT COALESCE(SUM(t.attributed_installs) FILTER (WHERE ${mature}), 0)::text AS installs,
              COALESCE(SUM(t.attributed_installs) FILTER (WHERE ${mature} AND ${NOT_ORGANIC}), 0)::text
                AS paid_installs,
              COALESCE(SUM(t.attributed_installs) FILTER (WHERE ${mature} AND NOT (${NOT_ORGANIC})), 0)::text
                AS organic_installs,
              count(DISTINCT t.install_date) FILTER (WHERE ${mature})::text AS mature_days,
              count(DISTINCT t.install_date) FILTER (WHERE NOT (${oldEnough}))::text AS immature_days,
              count(DISTINCT t.install_date) FILTER (WHERE ${oldEnough} AND NOT (${covered}))::text
                AS uncovered_days
         FROM attribution_daily_metrics t
         JOIN apps a ON a.id = t.app_id
        WHERE ${installWhere}`,
      installParams,
      client,
    );
    const age = aggregate.byAge[ageDays];
    age.installs = toNumber(installRows[0]?.installs);
    age.paidInstalls = toNumber(installRows[0]?.paid_installs);
    age.organicInstalls = toNumber(installRows[0]?.organic_installs);
    age.matureCohortDays = toNumber(installRows[0]?.mature_days);
    age.immatureCohortDays = toNumber(installRows[0]?.immature_days);
    age.uncoveredCohortDays = toNumber(installRows[0]?.uncovered_days);

    // ------------------------------------------------ cohort-aligned spend ---
    // Spend on the install day, for campaigns that map to the bound
    // attribution provider's campaigns. Organic has no spend by definition, and
    // a channel the marketing provider does not belong to matches nothing.
    const channelExcluded = !channelMatchesProvider(filters.channel, filters.marketingProviderKey);
    if (channelExcluded) continue;
    const spendParams: unknown[] = [
      filters.organizationId,
      filters.appId,
      filters.from,
      filters.to,
      asOf,
      ageDays,
    ];
    let spendWhere = `md.organization_id = $1 AND md.app_id = $2 AND md.report_date BETWEEN $3 AND $4
         AND md.spend > 0 AND (md.report_date + $6::int) < $5::date`;
    if (filters.marketingProviderKey) {
      spendParams.push(filters.marketingProviderKey);
      spendWhere += ` AND md.provider_key = $${spendParams.length}`;
    }
    if (filters.marketingAccountExternalId) {
      spendParams.push(filters.marketingAccountExternalId);
      spendWhere += ` AND md.external_account_id = $${spendParams.length}`;
    }
    if (filters.country) {
      spendParams.push(filters.country);
      spendWhere += ` AND md.country = $${spendParams.length}`;
    }
    if (filters.platform) {
      spendParams.push(filters.platform);
      spendWhere += ` AND md.platform = $${spendParams.length}`;
    }
    let targetProvider: string | undefined;
    if (filters.attributionProviderKey) {
      spendParams.push(filters.attributionProviderKey);
      targetProvider = `$${spendParams.length}`;
    }
    const spendRows = await queryRows<{
      spend: string;
      currencies: string[];
      campaign_days: string;
    }>(
      // The same coverage test as the install and revenue sides: spend on a
      // day the revenue stream has not read since the cohort matured is spend
      // whose return MART does not know, not spend that returned nothing.
      `SELECT COALESCE(SUM(md.spend), 0)::text AS spend,
              COALESCE(array_agg(DISTINCT md.currency), '{}') AS currencies,
              count(DISTINCT (md.external_campaign_id, md.report_date))::text AS campaign_days
         FROM marketing_daily_metrics md
         JOIN apps a ON a.id = md.app_id
        WHERE ${spendWhere} AND ${mappedMarketingCampaign('md', targetProvider)}
          AND ${revenueCovered({
            alias: 'md',
            dayExpr: 'md.report_date',
            ageParam: '$6',
            timezoneExpr: 'a.timezone',
            providerParam: targetProvider,
          })}`,
      spendParams,
      client,
    );
    age.alignedSpend = toNumber(spendRows[0]?.spend);
    age.alignedSpendCurrencies = spendRows[0]?.currencies ?? [];
    age.alignedCampaignDays = toNumber(spendRows[0]?.campaign_days);
  }

  return aggregate;
}

/**
 * Decide availability before looking at the number.
 *
 * Returning zero when a source is missing is the failure mode this exists to
 * prevent: an unconnected provider and a genuinely zero day must not look alike.
 */
/**
 * Decide whether a metric can be shown, and name the condition if not.
 *
 * Every non-available state carries both a reason a person can read and a
 * blocker a machine can act on. The two are produced together on purpose: a
 * blocker without prose is unactionable to the reader, and prose without a
 * blocker is unactionable to anything downstream.
 */
export function determineAvailability(
  definition: MetricDefinition,
  context: MetricContext,
): { availability: MetricAvailability; reason?: string; blocker?: MetricBlocker } {
  if (definition.unavailableReason) {
    return {
      availability: 'unavailable',
      reason: definition.unavailableReason,
      blocker: 'unsupported_metric',
    };
  }
  if (definition.sources.includes('marketing') && !context.hasMarketingConnection) {
    return {
      availability: 'unavailable',
      reason: 'No marketing network is connected for this app.',
      blocker: 'missing_provider',
    };
  }
  if (definition.sources.includes('attribution') && !context.hasAttributionConnection) {
    return {
      availability: 'unavailable',
      reason: 'No attribution provider is configured for this app.',
      blocker: 'missing_provider',
    };
  }
  const missing = definition.requiredCapabilities.filter(
    (capability) => !context.supportedCapabilities.has(capability),
  );
  if (missing.length > 0) {
    // The probe that recorded the gap may also have recorded what would close
    // it. Saying so here is the difference between "cannot" and "cannot yet".
    const actions = missing
      .map((key) => context.capabilityNotes?.[key])
      .filter((note): note is string => Boolean(note));
    return {
      availability: 'unavailable',
      reason:
        `The connected provider does not expose: ${missing.join(', ')}.` +
        (actions.length > 0 ? ` ${[...new Set(actions)].join(' ')}` : ''),
      blocker: 'unsupported_metric',
    };
  }

  const relevant: Array<{ status: string; minutesSinceSuccess?: number | null } | undefined> = [];
  if (definition.sources.includes('marketing')) relevant.push(context.marketingFreshness);
  if (definition.sources.includes('attribution')) relevant.push(context.attributionFreshness);
  if (relevant.some((f) => f?.status === 'stale' || f?.status === 'error')) {
    return {
      availability: 'stale',
      reason: 'Underlying data is stale; re-run the sync.',
      blocker: 'provider_stale',
    };
  }

  // The registry's per-metric staleness tolerance, finally consulted. A daily
  // spend figure and a revenue figure that restates for two days do not go
  // stale at the same rate, which is why the tolerance is declared per metric
  // rather than assumed.
  const overdue = relevant.find(
    (f) =>
      typeof f?.minutesSinceSuccess === 'number' &&
      f.minutesSinceSuccess > definition.maxAcceptableStalenessMinutes,
  );
  if (overdue && typeof overdue.minutesSinceSuccess === 'number') {
    const hours = Math.floor(overdue.minutesSinceSuccess / 60);
    return {
      availability: 'stale',
      reason: `Last successful sync was ${hours}h ago; this metric is defined to tolerate ${Math.floor(definition.maxAcceptableStalenessMinutes / 60)}h.`,
      blocker: 'provider_stale',
    };
  }

  if (relevant.some((f) => f?.status === 'delayed')) {
    return {
      availability: 'partial',
      reason: 'Underlying data is behind its expected freshness.',
      blocker: 'provider_stale',
    };
  }

  // Coverage below the documented floor does not stop the arithmetic - it
  // stops the answer meaning what the reader will take it to mean. A CPI drawn
  // from half the spend describes MART's reconciliation, not the campaigns.
  const eligible = context.mappingCoverage?.eligible;
  if (
    eligible &&
    definition.semanticClass === 'operational' &&
    definition.sources.includes('marketing') &&
    definition.sources.includes('attribution') &&
    eligible.totalSpend > 0
  ) {
    const coveragePct = (eligible.mappedSpend / eligible.totalSpend) * 100;
    if (coveragePct < MINIMUM_SPEND_COVERAGE_PCT) {
      // Qualified, not withheld. The arithmetic is sound and an operator may
      // legitimately want the figure; what they must not do is read it as a
      // description of the whole account. Blocking it outright would remove a
      // usable number to make a point the caveat already makes - and the
      // difference between "here, with this caveat" and "no" is the difference
      // between a gate and an opinion.
      return {
        availability: 'partial',
        reason: `Only ${coveragePct.toFixed(1)}% of spend in this period is on mapped campaigns, below the ${MINIMUM_SPEND_COVERAGE_PCT}% this figure needs to describe the whole account.`,
        blocker: 'insufficient_coverage',
      };
    }
    if (eligible.ambiguousSpend > 0) {
      const ambiguousPct = (eligible.ambiguousSpend / eligible.totalSpend) * 100;
      if (ambiguousPct > MAXIMUM_AMBIGUOUS_SPEND_PCT) {
        return {
          availability: 'partial',
          reason: `${ambiguousPct.toFixed(1)}% of spend is on campaigns with several equally good mapping candidates, which MART will not choose between.`,
          blocker: 'ambiguous_mapping',
        };
      }
    }
  }

  return { availability: 'available' };
}

export function computeMetricValues(input: {
  metricKeys?: string[];
  context: MetricContext;
  marketing: MarketingAggregate;
  attribution: AttributionAggregate;
  /**
   * The window's cohorts. Optional because the operational metrics never need
   * it; a cohort metric computed without it reports that it was not loaded
   * rather than pretending the cohorts earned nothing.
   */
  cohort?: CohortAggregate;
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
    cohort?: CohortAggregate;
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
    family: definition.family,
    unit: definition.unit,
    aggregation: definition.aggregation,
    semanticClass: definition.semanticClass,
    population: definition.population,
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
      ...(gate.blocker ? { blocker: gate.blocker } : {}),
    };
  }

  // A blocked gate stops here too: the arithmetic is possible, the answer is
  // not one MART is willing to state.
  if (gate.availability === 'blocked') {
    return {
      ...base,
      availability: 'blocked',
      ...(gate.reason ? { reason: gate.reason } : {}),
      ...(gate.blocker ? { blocker: gate.blocker } : {}),
    };
  }

  // Cohort metrics have their own arithmetic and their own currency sets, and
  // every one of them - D1 or D7, IAP or ad, revenue, RPI or ROAS - goes
  // through one rule, so the ages cannot drift apart.
  if (definition.cohort) {
    return buildCohortMetric(definition, definition.cohort, base, gate, context, input.cohort);
  }

  // A money metric drawn from rows in more than one currency is not a number
  // MART can state. Adding 100 USD to 100 EUR requires a rate MART does not
  // have and must not invent, and the sum would look entirely ordinary. Blocked
  // rather than unavailable: the arithmetic is possible, the meaning is not.
  if (definition.unit === 'currency') {
    // Only the currencies that actually feed THIS metric's arithmetic. A CPI
    // reads spend and installs - the revenue table's currency is not in the
    // calculation, so blocking a well-defined USD cost per install because some
    // revenue row arrived in JPY would be a false refusal, and a refusal that
    // cannot be acted on is as unhelpful as a wrong number.
    const currencies = new Set<string>(
      definition.family === 'revenue' ? attribution.currencies : marketing.currencies,
    );
    if (currencies.size > 1) {
      const listed = [...currencies].sort().join(', ');
      return {
        ...base,
        availability: 'blocked',
        blocker: 'mixed_currency',
        reason: `The rows behind this figure are in ${currencies.size} currencies (${listed}). MART does not convert between them, so there is no single number to show.`,
      };
    }
  }

  const freshness = definition.sources.includes('attribution')
    ? context.attributionFreshness
    : context.marketingFreshness;

  const withFreshness = (value: MetricValue): MetricValue => ({
    ...value,
    availability: gate.availability,
    ...(gate.reason ? { reason: gate.reason } : {}),
    ...(gate.blocker ? { blocker: gate.blocker } : {}),
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
    case 'paid_attributed_installs':
      return withFreshness({
        ...base,
        value: attribution.attributedInstalls - attribution.organicInstalls,
        numerator: attribution.attributedInstalls - attribution.organicInstalls,
      });
    case 'iap_revenue':
      return withFreshness({
        ...base,
        value: attribution.iapRevenue,
        numerator: attribution.iapRevenue,
      });
    case 'ad_revenue':
      return withFreshness({
        ...base,
        value: attribution.adRevenue,
        numerator: attribution.adRevenue,
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
    case 'delivery_aligned_paid_installs':
      return withFreshness({
        ...base,
        value: attribution.deliveryAlignedPaidInstalls,
        numerator: attribution.deliveryAlignedPaidInstalls,
      });
    case 'delivery_aligned_revenue':
      return withFreshness({
        ...base,
        value: attribution.deliveryAlignedRevenue,
        numerator: attribution.deliveryAlignedRevenue,
      });
    case 'mapped_cpi': {
      // Both sides describe the campaigns that delivered in this window. The
      // wider mapped population is a coverage figure, not a denominator: an
      // install mapped to a campaign that spent nothing here was not bought by
      // this window's spend.
      if (attribution.deliveryAlignedPaidInstalls === 0) {
        return {
          ...base,
          numerator: marketing.mappedSpend,
          denominator: 0,
          availability: 'unavailable',
          reason:
            attribution.mappedPaidInstalls > 0
              ? "Installs are mapped, but to campaigns that did not deliver in this period. This period's spend did not buy them, so it cannot be divided by them."
              : attribution.attributedInstalls > 0
                ? 'No attribution campaign is mapped to a marketing campaign yet, so spend and installs cannot be attributed to the same campaigns. Reconcile campaigns first.'
                : 'No attributed installs for the selected filters.',
        };
      }
      const ratio = safeRatio(
        marketing.mappedSpend,
        attribution.deliveryAlignedPaidInstalls,
        definition.minimumDenominator,
      );
      const value = finishRatio(
        base,
        withFreshness,
        ratio,
        marketing.mappedSpend,
        attribution.deliveryAlignedPaidInstalls,
      );
      // Available, but not the whole picture. Two different exclusions, both
      // named rather than folded into the number.
      const outsideDelivery =
        attribution.mappedPaidInstalls - attribution.deliveryAlignedPaidInstalls;
      if (
        value.availability === 'available' &&
        (attribution.unmappedPaidInstalls > 0 || outsideDelivery > 0)
      ) {
        const reasons: string[] = [];
        if (attribution.unmappedPaidInstalls > 0) {
          reasons.push(
            `${attribution.unmappedPaidInstalls} paid install(s) are on campaigns MART cannot map yet`,
          );
        }
        if (outsideDelivery > 0) {
          reasons.push(
            `${outsideDelivery} mapped install(s) are on campaigns that did not deliver in this period`,
          );
        }
        return {
          ...value,
          availability: 'partial',
          reason: `${reasons.join(', and ')}. Both are excluded from this figure.`,
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
            'This metric is computed over the selected reporting period, and no period reached the metric layer with this request.',
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

/**
 * One rule for every cohort figure.
 *
 * The order matters and is the same for revenue, RPI and ROAS:
 *
 *  1. No data horizon: nothing can be mature, say so.
 *  2. No mature cohort in the window: the value does not exist yet. Blocked as
 *     immature_cohort, with the count of cohorts still growing - never zero,
 *     never the partial figure Tenjin returns for a young cohort.
 *  3. Currency: the rows that feed THIS figure, on both sides for a ratio.
 *  4. The arithmetic, over mature cohorts only.
 *  5. Qualification: immature cohorts excluded, rows read too early excluded,
 *     unmapped paid cohorts excluded from a ROAS - each named in the reason.
 */
function buildCohortMetric(
  definition: MetricDefinition,
  spec: NonNullable<MetricDefinition['cohort']>,
  base: MetricValue,
  gate: ReturnType<typeof determineAvailability>,
  context: MetricContext,
  cohort: CohortAggregate | undefined,
): MetricValue {
  const N = spec.ageDays;
  if (!cohort) {
    return {
      ...base,
      availability: 'unavailable',
      reason: 'Cohort aggregates were not loaded for this request.',
    };
  }
  if (!cohort.asOf) {
    return {
      ...base,
      availability: 'unavailable',
      blocker: 'provider_stale',
      reason:
        'No attribution sync has completed for this app, so no cohort has an observed age yet.',
    };
  }
  const age = cohort.byAge[N];
  const slice = age.revenue[spec.revenueType];
  const cohortDays = age.matureCohortDays + age.immatureCohortDays + age.uncoveredCohortDays;
  const freshness = context.attributionFreshness;
  const finish = (value: MetricValue): MetricValue => ({
    ...value,
    ...(freshness
      ? { freshnessStatus: freshness.status, latestDataDate: freshness.latestDataDate }
      : {}),
  });

  if (cohortDays === 0) {
    return finish({
      ...base,
      availability: 'unavailable',
      reason: 'No install cohorts in the selected window.',
    });
  }
  if (age.matureCohortDays === 0) {
    // Old enough but never read since: the revenue stream owes MART a read,
    // and until it happens these cohorts are unknown - not zero, not young.
    // Named first even when younger days sit beside them, because it is the
    // condition a person can act on now.
    if (age.uncoveredCohortDays > 0) {
      return finish({
        ...base,
        availability: 'blocked',
        blocker: 'provider_stale',
        reason:
          `${age.uncoveredCohortDays} install day(s) in this window are ${N} day(s) old, but the attribution revenue sync has not read them since they reached D${N}. Run an attribution revenue sync over these days (a backfill after upgrading); until then their D${N} figure is unknown, not zero.` +
          (age.immatureCohortDays > 0
            ? ` A further ${age.immatureCohortDays} day(s) have not reached D${N} as of ${cohort.asOf}.`
            : ''),
      });
    }
    return finish({
      ...base,
      availability: 'blocked',
      blocker: 'immature_cohort',
      reason:
        `None of the ${age.immatureCohortDays} install day(s) in this window is ${N} day(s) old as of ${cohort.asOf}. A D${N} figure does not exist for them yet; it is not zero.` +
        (age.uncoveredCohortDays > 0
          ? ` A further ${age.uncoveredCohortDays} day(s) are old enough but have not been read by the revenue sync since reaching D${N}.`
          : ''),
    });
  }

  // Currency: only what feeds this figure. A ROAS reads the aligned cohort
  // rows and the aligned spend rows; revenue and RPI read every mature row.
  const currencies = new Set<string>(
    spec.measure === 'roas'
      ? [...slice.alignedCurrencies, ...age.alignedSpendCurrencies]
      : slice.currencies,
  );
  if (currencies.size > 1) {
    const listed = [...currencies].sort().join(', ');
    return finish({
      ...base,
      availability: 'blocked',
      blocker: 'mixed_currency',
      reason: `The rows behind this figure are in ${currencies.size} currencies (${listed}). MART does not convert between them, so there is no single number to show.`,
    });
  }

  // The caveats every cohort figure carries when they apply. Immature cohorts
  // are the normal case at the end of any window and are stated, not hidden.
  const caveats: string[] = [];
  if (age.immatureCohortDays > 0) {
    caveats.push(
      `${age.immatureCohortDays} of ${cohortDays} install day(s) have not reached D${N} as of ${cohort.asOf} and are excluded, not counted as zero`,
    );
  }
  if (age.uncoveredCohortDays > 0) {
    caveats.push(
      `${age.uncoveredCohortDays} of ${cohortDays} install day(s) are old enough for D${N} but the attribution revenue sync has not read them since they reached it; they are excluded from both sides, not counted as zero - run an attribution revenue sync over them`,
    );
  }
  if (slice.earlyReadRows > 0) {
    caveats.push(
      `${slice.earlyReadRows} cohort row(s) were last read from the provider before reaching D${N} and are excluded; keep SYNC_RESTATEMENT_LOOKBACK_DAYS at ${N} or more so they are re-read`,
    );
  }

  // Caveats travel with any value that is shown, whatever the gate said: a
  // stale figure that also excludes three immature cohorts must say both.
  const qualify = (value: MetricValue, extra: string[] = []): MetricValue => {
    const all = [...caveats, ...extra];
    if (value.value === null || all.length === 0) return value;
    const availability = value.availability === 'available' ? 'partial' : value.availability;
    const reason = [value.reason, `${all.join('; ')}.`].filter(Boolean).join(' ');
    return { ...value, availability, reason };
  };
  const withGate = (value: MetricValue): MetricValue =>
    finish({
      ...value,
      availability: gate.availability,
      ...(gate.reason ? { reason: gate.reason } : {}),
      ...(gate.blocker ? { blocker: gate.blocker } : {}),
    });

  switch (spec.measure) {
    case 'revenue':
      return qualify(withGate({ ...base, value: slice.revenue, numerator: slice.revenue }));
    case 'rpi': {
      const ratio = safeRatio(slice.revenue, age.installs, definition.minimumDenominator);
      const value = finishRatio(base, withGate, ratio, slice.revenue, age.installs);
      return qualify(value);
    }
    case 'roas': {
      // Organic cohorts have no acquisition spend. Filtering to organic is a
      // legitimate question with no ROAS answer, and the answer is not zero.
      if (age.alignedSpend === 0) {
        const reason =
          age.organicInstalls > 0 && age.paidInstalls === 0
            ? 'These are organic cohorts. Nothing was spent to acquire them, so a return on spend does not exist for them.'
            : slice.mappedPaidRevenue + slice.unmappedPaidRevenue > 0 || age.paidInstalls > 0
              ? age.alignedCampaignDays === 0
                ? 'No marketing campaign that maps to these cohorts spent on their install days. Reconcile campaigns first; spend from other days or other campaigns is not divided into cohort revenue.'
                : 'No spend on the install days of the mature cohorts.'
              : 'No paid cohorts in the selected window.';
        return finish({
          ...base,
          numerator: slice.alignedRevenue,
          denominator: 0,
          availability: 'unavailable',
          blocker: 'missing_denominator',
          reason,
        });
      }
      const ratio = safeRatio(
        slice.alignedRevenue,
        age.alignedSpend,
        definition.minimumDenominator,
      );
      const value = finishRatio(base, withGate, ratio, slice.alignedRevenue, age.alignedSpend);
      const extra: string[] = [];
      if (slice.unmappedPaidRevenue > 0) {
        extra.push(
          `${slice.unmappedPaidRevenue.toFixed(2)} of paid D${N} ${spec.revenueType} revenue is on campaigns MART cannot map and is in neither side of this ratio`,
        );
      }
      const outsideSpend = slice.mappedPaidRevenue - slice.alignedRevenue;
      if (outsideSpend > 0) {
        extra.push(
          `${outsideSpend.toFixed(2)} of mapped D${N} ${spec.revenueType} revenue is on cohorts whose campaign did not spend on their install day and is in neither side`,
        );
      }
      return qualify(value, extra);
    }
    default:
      return { ...base, availability: 'unavailable', reason: 'Unknown cohort measure.' };
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

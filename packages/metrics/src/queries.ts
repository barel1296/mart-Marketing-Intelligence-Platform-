import type { IsoDate, MappingStatus } from '@mart/shared';
import { queryRows, toNumber, toNullableNumber } from '@mart/db';
import type { MetricFilters } from './service.js';
import { safeRatio } from './registry.js';

/**
 * Time series.
 *
 * Marketing and attribution are returned as separate series carrying their own
 * grain label. They are never merged into one row, because a report-date point
 * and an install-date point are different facts that happen to share an x-axis.
 */
export type TimeseriesPoint = {
  date: IsoDate;
  spend: number | null;
  impressions: number | null;
  clicks: number | null;
  attributedInstalls: number | null;
  attributedRevenue: number | null;
};

export type TimeseriesResult = {
  points: TimeseriesPoint[];
  marketingGrain: 'report_date';
  attributionInstallGrain: 'install_date';
  attributionRevenueGrain: 'event_date';
  grainWarning: string;
};

export async function loadTimeseries(filters: MetricFilters): Promise<TimeseriesResult> {
  const params: unknown[] = [filters.organizationId, filters.appId, filters.from, filters.to];
  const marketingFilter = optionalFilters(filters, params, {
    provider: filters.marketingProviderKey,
    table: 'marketing',
  });
  const attributionParams: unknown[] = [
    filters.organizationId,
    filters.appId,
    filters.from,
    filters.to,
  ];
  const attributionFilter = optionalFilters(filters, attributionParams, {
    provider: filters.attributionProviderKey,
    table: 'attribution',
  });

  const marketing = await queryRows<{
    date: string;
    spend: string;
    impressions: string;
    clicks: string;
  }>(
    `SELECT report_date::text AS date,
            SUM(spend)::text AS spend,
            SUM(impressions)::text AS impressions,
            SUM(clicks)::text AS clicks
     FROM marketing_daily_metrics
     WHERE organization_id = $1 AND app_id = $2 AND report_date BETWEEN $3 AND $4 ${marketingFilter}
     GROUP BY report_date ORDER BY report_date`,
    params,
  );

  const installs = await queryRows<{ date: string; installs: string }>(
    `SELECT install_date::text AS date, SUM(attributed_installs)::text AS installs
     FROM attribution_daily_metrics
     WHERE organization_id = $1 AND app_id = $2 AND install_date BETWEEN $3 AND $4 ${attributionFilter}
     GROUP BY install_date ORDER BY install_date`,
    attributionParams,
  );

  const revenueParams: unknown[] = [
    filters.organizationId,
    filters.appId,
    filters.from,
    filters.to,
  ];
  const revenueFilter = optionalFilters(filters, revenueParams, {
    provider: filters.attributionProviderKey,
    table: 'attribution',
  });
  const revenue = await queryRows<{ date: string; revenue: string }>(
    `SELECT activity_date::text AS date, SUM(revenue)::text AS revenue
     FROM attribution_revenue_metrics
     WHERE organization_id = $1 AND app_id = $2 AND activity_date BETWEEN $3 AND $4
       AND grain = 'event_date' ${revenueFilter}
     GROUP BY activity_date ORDER BY activity_date`,
    revenueParams,
  );

  const byDate = new Map<string, TimeseriesPoint>();
  const ensure = (date: string): TimeseriesPoint => {
    const existing = byDate.get(date);
    if (existing) return existing;
    const created: TimeseriesPoint = {
      date,
      spend: null,
      impressions: null,
      clicks: null,
      attributedInstalls: null,
      attributedRevenue: null,
    };
    byDate.set(date, created);
    return created;
  };

  for (const row of marketing) {
    const point = ensure(row.date);
    point.spend = toNumber(row.spend);
    point.impressions = toNumber(row.impressions);
    point.clicks = toNumber(row.clicks);
  }
  for (const row of installs) ensure(row.date).attributedInstalls = toNumber(row.installs);
  for (const row of revenue) ensure(row.date).attributedRevenue = toNumber(row.revenue);

  return {
    points: [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)),
    marketingGrain: 'report_date',
    attributionInstallGrain: 'install_date',
    attributionRevenueGrain: 'event_date',
    grainWarning:
      'Spend, impressions and clicks are report-date facts. Attributed installs are install-date facts and attributed revenue is event-date. Points share an axis but are not the same grain.',
  };
}

function optionalFilters(
  filters: MetricFilters,
  params: unknown[],
  options: { provider: string | null | undefined; table: 'marketing' | 'attribution' },
): string {
  let sql = '';
  if (options.provider) {
    params.push(options.provider);
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
  if (options.table === 'marketing' && filters.marketingAccountExternalId) {
    params.push(filters.marketingAccountExternalId);
    sql += ` AND external_account_id = $${params.length}`;
  }
  return sql;
}

// ------------------------------------------------------------ campaigns -----

export type CampaignTableRow = {
  externalCampaignId: string;
  campaignName: string | null;
  campaignStatus: string | null;
  spend: number;
  impressions: number;
  clicks: number;
  ctr: number | null;
  cpm: number | null;
  mappingStatus: MappingStatus | 'not_computed';
  mappingMethod: string | null;
  mappingConfidence: number | null;
  attributionCampaignId: string | null;
  /** Null unless the mapping is authoritative; see the note on each row. */
  attributedInstalls: number | null;
  attributedRevenue: number | null;
  reportedCpi: number | null;
  attributionNote: string | null;
  marketingLatestDate: string | null;
  attributionLatestDate: string | null;
};

export type CampaignTableResult = {
  rows: CampaignTableRow[];
  total: number;
};

/**
 * Campaign table.
 *
 * Attribution figures are attached only where the campaign mapping is
 * authoritative (matched by stable id, or verified by a human). A name-based
 * fallback is shown as a mapping status with an explanatory note, and its
 * attribution columns stay empty, because attaching numbers through a guessed
 * join is how a dashboard starts lying.
 */
export async function loadCampaignTable(
  filters: MetricFilters & {
    limit?: number;
    offset?: number;
    sort?: 'spend' | 'impressions' | 'clicks' | 'name';
    direction?: 'asc' | 'desc';
    mappingStatus?: MappingStatus;
  },
): Promise<CampaignTableResult> {
  // No marketing network bound means there are no campaigns to list. Defaulting
  // to a particular provider here would both hardcode a provider into core and
  // quietly answer a question the caller has no data for.
  if (!filters.marketingProviderKey) return { rows: [], total: 0 };
  const marketingProvider = filters.marketingProviderKey;
  const attributionProvider = filters.attributionProviderKey ?? null;
  const limit = Math.min(filters.limit ?? 50, 500);
  const offset = Math.max(filters.offset ?? 0, 0);

  const sortColumn =
    filters.sort === 'impressions'
      ? 'impressions'
      : filters.sort === 'clicks'
        ? 'clicks'
        : filters.sort === 'name'
          ? 'campaign_name'
          : 'spend';
  const direction = filters.direction === 'asc' ? 'ASC' : 'DESC';

  const params: unknown[] = [
    filters.organizationId,
    filters.appId,
    filters.from,
    filters.to,
    marketingProvider,
    attributionProvider,
  ];
  let extra = '';
  if (filters.country) {
    params.push(filters.country);
    extra += ` AND m.country = $${params.length}`;
  }
  if (filters.platform) {
    params.push(filters.platform);
    extra += ` AND m.platform = $${params.length}`;
  }
  if (filters.marketingAccountExternalId) {
    params.push(filters.marketingAccountExternalId);
    extra += ` AND m.external_account_id = $${params.length}`;
  }

  let mappingFilter = '';
  if (filters.mappingStatus) {
    params.push(filters.mappingStatus);
    mappingFilter = ` AND COALESCE(map.status, 'unmatched') = $${params.length}`;
  }

  params.push(limit, offset);
  const limitParam = params.length - 1;
  const offsetParam = params.length;

  const rows = await queryRows<{
    external_campaign_id: string;
    campaign_name: string | null;
    campaign_status: string | null;
    spend: string;
    impressions: string;
    clicks: string;
    marketing_latest_date: string | null;
    mapping_status: MappingStatus | null;
    mapping_method: string | null;
    mapping_confidence: string | null;
    attribution_campaign_id: string | null;
    attributed_installs: string | null;
    attributed_revenue: string | null;
    attribution_latest_date: string | null;
    total_count: string;
  }>(
    `WITH marketing AS (
       SELECT m.external_campaign_id,
              MAX(c.name) AS campaign_name,
              MAX(c.effective_status) AS campaign_status,
              SUM(m.spend) AS spend,
              SUM(m.impressions) AS impressions,
              SUM(m.clicks) AS clicks,
              MAX(m.report_date) AS marketing_latest_date
       FROM marketing_daily_metrics m
       LEFT JOIN marketing_campaigns c
              ON c.connection_id = m.connection_id AND c.app_id = m.app_id
             AND c.external_campaign_id = m.external_campaign_id
       WHERE m.organization_id = $1 AND m.app_id = $2
         AND m.report_date BETWEEN $3 AND $4
         AND m.provider_key = $5
         AND m.external_campaign_id IS NOT NULL
         ${extra}
       GROUP BY m.external_campaign_id
     ),
     map AS (
       SELECT source_external_id, target_external_id, status, mapping_method, mapping_confidence
       FROM provider_entity_mappings
       WHERE organization_id = $1 AND app_id = $2 AND entity_type = 'campaign'
         AND source_provider = $5
         AND ($6::text IS NULL OR target_provider = $6)
     ),
     attribution AS (
       SELECT external_campaign_id,
              SUM(attributed_installs) AS attributed_installs,
              MAX(install_date) AS attribution_latest_date
       FROM attribution_daily_metrics
       WHERE organization_id = $1 AND app_id = $2
         AND install_date BETWEEN $3 AND $4
         AND ($6::text IS NULL OR provider_key = $6)
         AND external_campaign_id IS NOT NULL
       GROUP BY external_campaign_id
     ),
     attribution_revenue AS (
       SELECT external_campaign_id, SUM(revenue) AS attributed_revenue
       FROM attribution_revenue_metrics
       WHERE organization_id = $1 AND app_id = $2
         AND activity_date BETWEEN $3 AND $4
         AND grain = 'event_date'
         AND ($6::text IS NULL OR provider_key = $6)
         AND external_campaign_id IS NOT NULL
       GROUP BY external_campaign_id
     )
     SELECT marketing.external_campaign_id,
            marketing.campaign_name,
            marketing.campaign_status,
            marketing.spend::text AS spend,
            marketing.impressions::text AS impressions,
            marketing.clicks::text AS clicks,
            marketing.marketing_latest_date::text AS marketing_latest_date,
            map.status AS mapping_status,
            map.mapping_method,
            map.mapping_confidence::text AS mapping_confidence,
            map.target_external_id AS attribution_campaign_id,
            CASE WHEN map.status IN ('matched_exact','matched_confident','manually_verified')
                 THEN attribution.attributed_installs::text END AS attributed_installs,
            CASE WHEN map.status IN ('matched_exact','matched_confident','manually_verified')
                 THEN attribution_revenue.attributed_revenue::text END AS attributed_revenue,
            attribution.attribution_latest_date::text AS attribution_latest_date,
            count(*) OVER ()::text AS total_count
     FROM marketing
     LEFT JOIN map ON map.source_external_id = marketing.external_campaign_id
     LEFT JOIN attribution ON attribution.external_campaign_id = map.target_external_id
     LEFT JOIN attribution_revenue ON attribution_revenue.external_campaign_id = map.target_external_id
     WHERE true ${mappingFilter}
     ORDER BY ${sortColumn} ${direction} NULLS LAST
     LIMIT $${limitParam} OFFSET $${offsetParam}`,
    params,
  );

  const total = rows.length > 0 ? toNumber(rows[0]?.total_count) : 0;

  return {
    total,
    rows: rows.map((row) => {
      const spend = toNumber(row.spend);
      const impressions = toNumber(row.impressions);
      const clicks = toNumber(row.clicks);
      const installs = row.attributed_installs === null ? null : toNumber(row.attributed_installs);
      const status: MappingStatus | 'not_computed' = row.mapping_status ?? 'not_computed';
      return {
        externalCampaignId: row.external_campaign_id,
        campaignName: row.campaign_name,
        campaignStatus: row.campaign_status,
        spend,
        impressions,
        clicks,
        ctr: safeRatio(clicks, impressions, 1000).value,
        cpm: safeRatio(spend * 1000, impressions, 1000).value,
        mappingStatus: status,
        mappingMethod: row.mapping_method,
        mappingConfidence: toNullableNumber(row.mapping_confidence),
        attributionCampaignId: row.attribution_campaign_id,
        attributedInstalls: installs,
        attributedRevenue:
          row.attributed_revenue === null ? null : toNumber(row.attributed_revenue),
        reportedCpi: installs === null ? null : safeRatio(spend, installs, 25).value,
        attributionNote: attributionNoteFor(status),
        marketingLatestDate: row.marketing_latest_date,
        attributionLatestDate: row.attribution_latest_date,
      };
    }),
  };
}

function attributionNoteFor(status: MappingStatus | 'not_computed'): string | null {
  switch (status) {
    case 'matched_exact':
    case 'matched_confident':
    case 'manually_verified':
      return null;
    case 'matched_fallback':
      return 'Name-based candidate match only. Attribution figures are withheld until the mapping is verified.';
    case 'ambiguous':
      return 'Several attribution campaigns share this name. MART will not pick one.';
    case 'unmatched':
      return 'No attribution campaign could be linked to this campaign.';
    case 'rejected':
      return 'This mapping was rejected by a user.';
    default:
      return 'Reconciliation has not run for this app yet.';
  }
}

// -------------------------------------------------------- reconciliation ----

export type ReconciliationDiscrepancy = {
  kind: 'delivery_without_attribution' | 'attribution_without_mapping' | 'missing_campaign_id';
  externalCampaignId: string | null;
  campaignName: string | null;
  spend: number | null;
  attributedInstalls: number | null;
  detail: string;
};

export async function loadReconciliationDiscrepancies(
  filters: MetricFilters,
  limit = 25,
): Promise<ReconciliationDiscrepancy[]> {
  // Nothing to reconcile without a marketing network; see loadCampaignTable.
  if (!filters.marketingProviderKey) return [];
  const marketingProvider = filters.marketingProviderKey;
  const attributionProvider = filters.attributionProviderKey ?? null;
  const out: ReconciliationDiscrepancy[] = [];

  const spendWithoutAttribution = await queryRows<{
    external_campaign_id: string;
    campaign_name: string | null;
    spend: string;
  }>(
    `SELECT m.external_campaign_id,
            MAX(c.name) AS campaign_name,
            SUM(m.spend)::text AS spend
     FROM marketing_daily_metrics m
     LEFT JOIN marketing_campaigns c
            ON c.connection_id = m.connection_id AND c.app_id = m.app_id
           AND c.external_campaign_id = m.external_campaign_id
     LEFT JOIN provider_entity_mappings map
            ON map.app_id = m.app_id AND map.entity_type = 'campaign'
           AND map.source_provider = m.provider_key
           AND map.source_external_id = m.external_campaign_id
           AND map.status IN ('matched_exact','matched_confident','manually_verified')
     WHERE m.organization_id = $1 AND m.app_id = $2
       AND m.report_date BETWEEN $3 AND $4
       AND m.provider_key = $5
       AND map.id IS NULL
     GROUP BY m.external_campaign_id
     HAVING SUM(m.spend) > 0
     ORDER BY SUM(m.spend) DESC
     LIMIT $6`,
    [filters.organizationId, filters.appId, filters.from, filters.to, marketingProvider, limit],
  );

  for (const row of spendWithoutAttribution) {
    out.push({
      kind: 'delivery_without_attribution',
      externalCampaignId: row.external_campaign_id,
      campaignName: row.campaign_name,
      spend: toNumber(row.spend),
      attributedInstalls: null,
      detail:
        'This campaign has delivery and spend but no authoritative link to an attribution campaign.',
    });
  }

  const attributionWithoutMapping = await queryRows<{
    external_campaign_id: string | null;
    campaign_name: string | null;
    installs: string;
  }>(
    `SELECT a.external_campaign_id,
            MAX(a.campaign_name) AS campaign_name,
            SUM(a.attributed_installs)::text AS installs
     FROM attribution_daily_metrics a
     LEFT JOIN provider_entity_mappings map
            ON map.app_id = a.app_id AND map.entity_type = 'campaign'
           AND map.target_provider = a.provider_key
           AND map.target_external_id = a.external_campaign_id
           AND map.status IN ('matched_exact','matched_confident','manually_verified')
     WHERE a.organization_id = $1 AND a.app_id = $2
       AND a.install_date BETWEEN $3 AND $4
       AND ($5::text IS NULL OR a.provider_key = $5)
       AND map.id IS NULL
     GROUP BY a.external_campaign_id
     HAVING SUM(a.attributed_installs) > 0
     ORDER BY SUM(a.attributed_installs) DESC
     LIMIT $6`,
    [filters.organizationId, filters.appId, filters.from, filters.to, attributionProvider, limit],
  );

  for (const row of attributionWithoutMapping) {
    out.push({
      kind:
        row.external_campaign_id === null ? 'missing_campaign_id' : 'attribution_without_mapping',
      externalCampaignId: row.external_campaign_id,
      campaignName: row.campaign_name,
      spend: null,
      attributedInstalls: toNumber(row.installs),
      detail:
        row.external_campaign_id === null
          ? 'The attribution provider did not supply a campaign id for these installs, so they cannot be reconciled by id.'
          : 'These attributed installs have no authoritative link to a marketing-network campaign.',
    });
  }

  return out;
}

/** Distinct filter values actually present in stored data. */
export async function loadFilterOptions(
  organizationId: string,
  appId: string,
): Promise<{ countries: string[]; platforms: string[]; marketingAccounts: string[] }> {
  const countries = await queryRows<{ value: string }>(
    `SELECT DISTINCT country AS value FROM marketing_daily_metrics
     WHERE organization_id = $1 AND app_id = $2 AND country IS NOT NULL
     UNION
     SELECT DISTINCT country AS value FROM attribution_daily_metrics
     WHERE organization_id = $1 AND app_id = $2 AND country IS NOT NULL
     ORDER BY value`,
    [organizationId, appId],
  );
  const platforms = await queryRows<{ value: string }>(
    `SELECT DISTINCT platform AS value FROM attribution_daily_metrics
     WHERE organization_id = $1 AND app_id = $2 AND platform IS NOT NULL
     ORDER BY value`,
    [organizationId, appId],
  );
  const accounts = await queryRows<{ value: string }>(
    `SELECT DISTINCT external_account_id AS value FROM marketing_daily_metrics
     WHERE organization_id = $1 AND app_id = $2 AND external_account_id IS NOT NULL
     ORDER BY value`,
    [organizationId, appId],
  );
  return {
    countries: countries.map((r) => r.value),
    platforms: platforms.map((r) => r.value),
    marketingAccounts: accounts.map((r) => r.value),
  };
}

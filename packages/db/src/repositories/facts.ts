import type {
  CanonicalAd,
  CanonicalAdGroup,
  CanonicalAttributionDailyMetric,
  CanonicalAttributionEventMetric,
  CanonicalAttributionRevenueMetric,
  CanonicalCampaign,
  CanonicalCreative,
  CanonicalMarketingAccount,
  CanonicalMarketingDailyMetric,
  IsoDate,
  SyncDataType,
} from '@mart/shared';
import { dimensionHash } from '@mart/shared';
import { query, queryOne, queryRows, type Queryable } from '../pool.js';
import { chunkRowsForBind, valuesClause } from '../sql.js';

export type FactScope = {
  organizationId: string;
  appId: string;
  connectionId: string;
  providerKey: string;
  syncRunId: string | null;
};

export type UpsertOutcome = { inserted: number; restated: number; unchanged: number };

function emptyOutcome(): UpsertOutcome {
  return { inserted: 0, restated: 0, unchanged: 0 };
}

function accumulate(
  outcome: UpsertOutcome,
  rows: Array<{ inserted: boolean; restated: boolean }>,
): void {
  for (const row of rows) {
    if (row.inserted) outcome.inserted += 1;
    else if (row.restated) outcome.restated += 1;
    else outcome.unchanged += 1;
  }
}

// ------------------------------------------------------- raw ingestion ------
export async function recordRawBatch(
  input: {
    scope: FactScope;
    providerCategory: string;
    dataType: SyncDataType;
    windowStart: IsoDate | null;
    windowEnd: IsoDate | null;
    pageNumber: number;
    payloadHash: string;
    schemaVersion: string;
    recordCount: number;
    payload: unknown;
  },
  client?: Queryable,
): Promise<{ stored: boolean }> {
  const result = await query(
    `INSERT INTO raw_ingestion_batches
       (organization_id, app_id, connection_id, sync_run_id, provider_key, provider_category,
        data_type, request_window_start, request_window_end, page_number, payload_hash,
        schema_version, record_count, payload)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     ON CONFLICT (connection_id, app_id, data_type, payload_hash,
                  COALESCE(request_window_start, DATE '1970-01-01'), page_number)
     DO NOTHING`,
    [
      input.scope.organizationId,
      input.scope.appId,
      input.scope.connectionId,
      input.scope.syncRunId,
      input.scope.providerKey,
      input.providerCategory,
      input.dataType,
      input.windowStart,
      input.windowEnd,
      input.pageNumber,
      input.payloadHash,
      input.schemaVersion,
      input.recordCount,
      JSON.stringify(input.payload ?? null),
    ],
    client,
  );
  return { stored: (result.rowCount ?? 0) > 0 };
}

export async function countRawBatches(
  organizationId: string,
  appId: string,
  client?: Queryable,
): Promise<number> {
  const row = await queryOne<{ count: string }>(
    'SELECT count(*)::text AS count FROM raw_ingestion_batches WHERE organization_id = $1 AND app_id = $2',
    [organizationId, appId],
    client,
  );
  return Number(row?.count ?? 0);
}

// ------------------------------------------------ marketing dimensions ------
export async function upsertMarketingAccounts(
  scope: FactScope,
  accounts: readonly CanonicalMarketingAccount[],
  client?: Queryable,
): Promise<void> {
  for (const account of accounts) {
    await query(
      `INSERT INTO marketing_accounts
         (organization_id, app_id, connection_id, provider_key, external_account_id, name, currency, timezone, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (connection_id, app_id, external_account_id) DO UPDATE SET
         name = EXCLUDED.name, currency = EXCLUDED.currency,
         timezone = EXCLUDED.timezone, status = EXCLUDED.status, observed_at = now()`,
      [
        scope.organizationId,
        scope.appId,
        scope.connectionId,
        scope.providerKey,
        account.externalAccountId,
        account.name,
        account.currency,
        account.timezone,
        account.status,
      ],
      client,
    );
  }
}

export async function upsertCampaigns(
  scope: FactScope,
  campaigns: readonly CanonicalCampaign[],
  client?: Queryable,
): Promise<void> {
  for (const campaign of campaigns) {
    await query(
      `INSERT INTO marketing_campaigns
         (organization_id, app_id, connection_id, provider_key, marketing_account_id,
          external_campaign_id, name, status, effective_status, objective,
          daily_budget, lifetime_budget, currency, provider_created_at, sync_run_id)
       VALUES ($1,$2,$3,$4,
               (SELECT id FROM marketing_accounts
                 WHERE connection_id = $3 AND app_id = $2 AND external_account_id = $5),
               $6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT (connection_id, app_id, external_campaign_id) DO UPDATE SET
         name = EXCLUDED.name, status = EXCLUDED.status,
         effective_status = EXCLUDED.effective_status, objective = EXCLUDED.objective,
         daily_budget = EXCLUDED.daily_budget, lifetime_budget = EXCLUDED.lifetime_budget,
         currency = EXCLUDED.currency, observed_at = now(), sync_run_id = EXCLUDED.sync_run_id,
         restatement_generation = marketing_campaigns.restatement_generation + 1`,
      [
        scope.organizationId,
        scope.appId,
        scope.connectionId,
        scope.providerKey,
        campaign.externalAccountId,
        campaign.externalCampaignId,
        campaign.name,
        campaign.status,
        campaign.effectiveStatus,
        campaign.objective,
        campaign.dailyBudget,
        campaign.lifetimeBudget,
        campaign.currency,
        campaign.providerCreatedAt,
        scope.syncRunId,
      ],
      client,
    );
  }
}

export async function upsertAdGroups(
  scope: FactScope,
  adGroups: readonly CanonicalAdGroup[],
  client?: Queryable,
): Promise<void> {
  for (const group of adGroups) {
    await query(
      `INSERT INTO marketing_ad_groups
         (organization_id, app_id, connection_id, provider_key, campaign_id,
          external_ad_group_id, external_campaign_id, name, status, effective_status, daily_budget, bid_strategy, sync_run_id)
       VALUES ($1,$2,$3,$4,
               (SELECT id FROM marketing_campaigns
                 WHERE connection_id = $3 AND app_id = $2 AND external_campaign_id = $6),
               $5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (connection_id, app_id, external_ad_group_id) DO UPDATE SET
         campaign_id = EXCLUDED.campaign_id, external_campaign_id = EXCLUDED.external_campaign_id,
         name = EXCLUDED.name, status = EXCLUDED.status, effective_status = EXCLUDED.effective_status,
         daily_budget = EXCLUDED.daily_budget, bid_strategy = EXCLUDED.bid_strategy,
         observed_at = now(), sync_run_id = EXCLUDED.sync_run_id`,
      [
        scope.organizationId,
        scope.appId,
        scope.connectionId,
        scope.providerKey,
        group.externalAdGroupId,
        group.externalCampaignId,
        group.name,
        group.status,
        group.effectiveStatus,
        group.dailyBudget,
        group.bidStrategy,
        scope.syncRunId,
      ],
      client,
    );
  }
}

export async function upsertCreatives(
  scope: FactScope,
  creatives: readonly CanonicalCreative[],
  client?: Queryable,
): Promise<void> {
  for (const creative of creatives) {
    await query(
      `INSERT INTO marketing_creatives
         (organization_id, app_id, connection_id, provider_key, external_creative_id, name, object_type, thumbnail_url, sync_run_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (connection_id, app_id, external_creative_id) DO UPDATE SET
         name = EXCLUDED.name, object_type = EXCLUDED.object_type,
         thumbnail_url = EXCLUDED.thumbnail_url, observed_at = now(),
         sync_run_id = EXCLUDED.sync_run_id`,
      [
        scope.organizationId,
        scope.appId,
        scope.connectionId,
        scope.providerKey,
        creative.externalCreativeId,
        creative.name,
        creative.objectType,
        creative.thumbnailUrl,
        scope.syncRunId,
      ],
      client,
    );
  }
}

export async function upsertAds(
  scope: FactScope,
  ads: readonly CanonicalAd[],
  client?: Queryable,
): Promise<void> {
  for (const ad of ads) {
    await query(
      `INSERT INTO marketing_ads
         (organization_id, app_id, connection_id, provider_key, campaign_id, ad_group_id, creative_id,
          external_ad_id, external_ad_group_id, external_campaign_id, external_creative_id,
          name, status, effective_status, sync_run_id)
       VALUES ($1,$2,$3,$4,
               (SELECT id FROM marketing_campaigns WHERE connection_id = $3 AND app_id = $2 AND external_campaign_id = $7),
               (SELECT id FROM marketing_ad_groups WHERE connection_id = $3 AND app_id = $2 AND external_ad_group_id = $6),
               (SELECT id FROM marketing_creatives WHERE connection_id = $3 AND app_id = $2 AND external_creative_id = $8),
               $5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (connection_id, app_id, external_ad_id) DO UPDATE SET
         campaign_id = EXCLUDED.campaign_id, ad_group_id = EXCLUDED.ad_group_id,
         creative_id = EXCLUDED.creative_id, external_ad_group_id = EXCLUDED.external_ad_group_id,
         external_campaign_id = EXCLUDED.external_campaign_id,
         external_creative_id = EXCLUDED.external_creative_id,
         name = EXCLUDED.name, status = EXCLUDED.status, effective_status = EXCLUDED.effective_status,
         observed_at = now(), sync_run_id = EXCLUDED.sync_run_id`,
      [
        scope.organizationId,
        scope.appId,
        scope.connectionId,
        scope.providerKey,
        ad.externalAdId,
        ad.externalAdGroupId,
        ad.externalCampaignId,
        ad.externalCreativeId,
        ad.name,
        ad.status,
        ad.effectiveStatus,
        scope.syncRunId,
      ],
      client,
    );
  }
}

// ------------------------------------------------------ marketing facts -----
const MARKETING_MEASURES = [
  'spend',
  'impressions',
  'clicks',
  'link_clicks',
  'outbound_clicks',
  'reach',
  'frequency',
] as const;

export function marketingDimensionHash(
  scope: Pick<FactScope, 'providerKey'>,
  metric: CanonicalMarketingDailyMetric,
): string {
  return dimensionHash({
    provider: scope.providerKey,
    grain: 'report_date',
    report_date: metric.reportDate,
    account: metric.externalAccountId,
    campaign: metric.externalCampaignId,
    ad_group: metric.externalAdGroupId,
    ad: metric.externalAdId,
    creative: metric.externalCreativeId,
    country: metric.country,
    platform: metric.platform,
  });
}

/**
 * Idempotent, restatement-aware upsert of delivery facts.
 *
 * Re-running the same window updates in place (never duplicates), and
 * restatement_generation only advances when a measure actually changed, so a
 * provider revising yesterday's spend is distinguishable from a no-op refresh.
 */
export async function upsertMarketingDailyMetrics(
  scope: FactScope,
  metrics: readonly CanonicalMarketingDailyMetric[],
  client?: Queryable,
): Promise<UpsertOutcome> {
  const outcome = emptyOutcome();
  const columns = [
    'organization_id',
    'app_id',
    'connection_id',
    'provider_key',
    'report_date',
    'external_account_id',
    'external_campaign_id',
    'external_ad_group_id',
    'external_ad_id',
    'external_creative_id',
    'country',
    'platform',
    'currency',
    'spend',
    'impressions',
    'clicks',
    'link_clicks',
    'outbound_clicks',
    'reach',
    'frequency',
    'dimension_hash',
    'sync_run_id',
  ];

  for (const chunk of chunkRowsForBind(metrics, columns.length)) {
    const params: unknown[] = [];
    for (const metric of chunk) {
      params.push(
        scope.organizationId,
        scope.appId,
        scope.connectionId,
        scope.providerKey,
        metric.reportDate,
        metric.externalAccountId,
        metric.externalCampaignId,
        metric.externalAdGroupId,
        metric.externalAdId,
        metric.externalCreativeId,
        metric.country,
        metric.platform,
        metric.currency,
        metric.spend,
        metric.impressions,
        metric.clicks,
        metric.linkClicks,
        metric.outboundClicks,
        metric.reach,
        metric.frequency,
        marketingDimensionHash(scope, metric),
        scope.syncRunId,
      );
    }
    const changed = MARKETING_MEASURES.map(
      (c) => `marketing_daily_metrics.${c} IS DISTINCT FROM EXCLUDED.${c}`,
    ).join(' OR ');
    const rows = await queryRows<{ inserted: boolean; restated: boolean }>(
      `INSERT INTO marketing_daily_metrics (${columns.join(',')})
       VALUES ${valuesClause(chunk.length, columns.length)}
       ON CONFLICT (connection_id, app_id, dimension_hash) DO UPDATE SET
         ${MARKETING_MEASURES.map((c) => `${c} = EXCLUDED.${c}`).join(', ')},
         currency = EXCLUDED.currency,
         observed_at = now(),
         sync_run_id = EXCLUDED.sync_run_id,
         restatement_generation = marketing_daily_metrics.restatement_generation
           + (CASE WHEN ${changed} THEN 1 ELSE 0 END),
         last_restated_at = CASE WHEN ${changed} THEN now()
                                 ELSE marketing_daily_metrics.last_restated_at END
       RETURNING (xmax = 0) AS inserted,
                 (xmax <> 0 AND last_restated_at = now()) AS restated`,
      params,
      client,
    );
    accumulate(outcome, rows);
  }

  // Attach foreign keys once the dimension rows exist. Kept as a separate pass
  // so a missing dimension row never blocks fact ingestion.
  await query(
    `UPDATE marketing_daily_metrics m SET
       campaign_id = c.id
     FROM marketing_campaigns c
     WHERE m.connection_id = $1 AND m.app_id = $2 AND m.campaign_id IS NULL
       AND c.connection_id = m.connection_id AND c.app_id = m.app_id
       AND c.external_campaign_id = m.external_campaign_id`,
    [scope.connectionId, scope.appId],
    client,
  );

  return outcome;
}

// ---------------------------------------------------- attribution facts -----
export function attributionInstallDimensionHash(
  providerKey: string,
  metric: CanonicalAttributionDailyMetric,
): string {
  return dimensionHash({
    provider: providerKey,
    grain: 'install_date',
    install_date: metric.installDate,
    media_source: metric.mediaSource,
    campaign: metric.externalCampaignId,
    campaign_name: metric.externalCampaignId ? null : metric.campaignName,
    ad_group: metric.externalAdGroupId,
    ad: metric.externalAdId,
    creative: metric.externalCreativeId,
    country: metric.country,
    platform: metric.platform,
    certainty: metric.attributionCertainty,
  });
}

export async function upsertAttributionInstalls(
  scope: FactScope,
  metrics: readonly CanonicalAttributionDailyMetric[],
  client?: Queryable,
): Promise<UpsertOutcome> {
  const outcome = emptyOutcome();
  const columns = [
    'organization_id',
    'app_id',
    'connection_id',
    'provider_key',
    'install_date',
    'media_source',
    'normalized_media_source',
    'external_campaign_id',
    'campaign_name',
    'external_ad_group_id',
    'ad_group_name',
    'external_ad_id',
    'ad_name',
    'external_creative_id',
    'creative_name',
    'country',
    'platform',
    'attribution_certainty',
    'attributed_installs',
    'attributed_clicks',
    'attributed_impressions',
    'dimension_hash',
    'sync_run_id',
  ];
  const measures = ['attributed_installs', 'attributed_clicks', 'attributed_impressions'];

  for (const chunk of chunkRowsForBind(metrics, columns.length)) {
    const params: unknown[] = [];
    for (const metric of chunk) {
      params.push(
        scope.organizationId,
        scope.appId,
        scope.connectionId,
        scope.providerKey,
        metric.installDate,
        metric.mediaSource,
        normalizeMediaSource(metric.mediaSource),
        metric.externalCampaignId,
        metric.campaignName,
        metric.externalAdGroupId,
        metric.adGroupName,
        metric.externalAdId,
        metric.adName,
        metric.externalCreativeId,
        metric.creativeName,
        metric.country,
        metric.platform,
        metric.attributionCertainty,
        metric.attributedInstalls,
        metric.attributedClicks,
        metric.attributedImpressions,
        attributionInstallDimensionHash(scope.providerKey, metric),
        scope.syncRunId,
      );
    }
    const changed = measures
      .map((c) => `attribution_daily_metrics.${c} IS DISTINCT FROM EXCLUDED.${c}`)
      .join(' OR ');
    const rows = await queryRows<{ inserted: boolean; restated: boolean }>(
      `INSERT INTO attribution_daily_metrics (${columns.join(',')})
       VALUES ${valuesClause(chunk.length, columns.length)}
       ON CONFLICT (connection_id, app_id, dimension_hash) DO UPDATE SET
         ${measures.map((c) => `${c} = EXCLUDED.${c}`).join(', ')},
         campaign_name = EXCLUDED.campaign_name,
         ad_group_name = EXCLUDED.ad_group_name,
         ad_name = EXCLUDED.ad_name,
         creative_name = EXCLUDED.creative_name,
         observed_at = now(),
         sync_run_id = EXCLUDED.sync_run_id,
         restatement_generation = attribution_daily_metrics.restatement_generation
           + (CASE WHEN ${changed} THEN 1 ELSE 0 END),
         last_restated_at = CASE WHEN ${changed} THEN now()
                                 ELSE attribution_daily_metrics.last_restated_at END
       RETURNING (xmax = 0) AS inserted,
                 (xmax <> 0 AND last_restated_at = now()) AS restated`,
      params,
      client,
    );
    accumulate(outcome, rows);
  }
  return outcome;
}

export async function upsertAttributionEvents(
  scope: FactScope,
  metrics: readonly CanonicalAttributionEventMetric[],
  client?: Queryable,
): Promise<UpsertOutcome> {
  const outcome = emptyOutcome();
  const columns = [
    'organization_id',
    'app_id',
    'connection_id',
    'provider_key',
    'event_date',
    'event_name',
    'media_source',
    'normalized_media_source',
    'external_campaign_id',
    'campaign_name',
    'country',
    'platform',
    'event_count',
    'unique_users',
    'dimension_hash',
    'sync_run_id',
  ];
  for (const chunk of chunkRowsForBind(metrics, columns.length)) {
    const params: unknown[] = [];
    for (const metric of chunk) {
      params.push(
        scope.organizationId,
        scope.appId,
        scope.connectionId,
        scope.providerKey,
        metric.eventDate,
        metric.eventName,
        metric.mediaSource,
        normalizeMediaSource(metric.mediaSource),
        metric.externalCampaignId,
        metric.campaignName,
        metric.country,
        metric.platform,
        metric.eventCount,
        metric.uniqueUsers,
        dimensionHash({
          provider: scope.providerKey,
          grain: 'event_date',
          event_date: metric.eventDate,
          event_name: metric.eventName,
          media_source: metric.mediaSource,
          campaign: metric.externalCampaignId,
          country: metric.country,
          platform: metric.platform,
        }),
        scope.syncRunId,
      );
    }
    const rows = await queryRows<{ inserted: boolean; restated: boolean }>(
      `INSERT INTO attribution_event_metrics (${columns.join(',')})
       VALUES ${valuesClause(chunk.length, columns.length)}
       ON CONFLICT (connection_id, app_id, dimension_hash) DO UPDATE SET
         event_count = EXCLUDED.event_count,
         unique_users = EXCLUDED.unique_users,
         observed_at = now(),
         sync_run_id = EXCLUDED.sync_run_id,
         restatement_generation = attribution_event_metrics.restatement_generation
           + (CASE WHEN attribution_event_metrics.event_count IS DISTINCT FROM EXCLUDED.event_count THEN 1 ELSE 0 END),
         last_restated_at = CASE WHEN attribution_event_metrics.event_count IS DISTINCT FROM EXCLUDED.event_count
                                 THEN now() ELSE attribution_event_metrics.last_restated_at END
       RETURNING (xmax = 0) AS inserted, (xmax <> 0 AND last_restated_at = now()) AS restated`,
      params,
      client,
    );
    accumulate(outcome, rows);
  }
  return outcome;
}

export async function upsertAttributionRevenue(
  scope: FactScope,
  metrics: readonly CanonicalAttributionRevenueMetric[],
  client?: Queryable,
): Promise<UpsertOutcome> {
  const outcome = emptyOutcome();
  const columns = [
    'organization_id',
    'app_id',
    'connection_id',
    'provider_key',
    'grain',
    'activity_date',
    'revenue_type',
    'media_source',
    'normalized_media_source',
    'external_campaign_id',
    'campaign_name',
    'country',
    'platform',
    'currency',
    'revenue',
    'dimension_hash',
    'sync_run_id',
  ];
  for (const chunk of chunkRowsForBind(metrics, columns.length)) {
    const params: unknown[] = [];
    for (const metric of chunk) {
      params.push(
        scope.organizationId,
        scope.appId,
        scope.connectionId,
        scope.providerKey,
        metric.grain,
        metric.activityDate,
        metric.revenueType,
        metric.mediaSource,
        normalizeMediaSource(metric.mediaSource),
        metric.externalCampaignId,
        metric.campaignName,
        metric.country,
        metric.platform,
        metric.currency,
        metric.revenue,
        dimensionHash({
          provider: scope.providerKey,
          grain: metric.grain,
          activity_date: metric.activityDate,
          revenue_type: metric.revenueType,
          media_source: metric.mediaSource,
          campaign: metric.externalCampaignId,
          country: metric.country,
          platform: metric.platform,
          currency: metric.currency,
        }),
        scope.syncRunId,
      );
    }
    const rows = await queryRows<{ inserted: boolean; restated: boolean }>(
      `INSERT INTO attribution_revenue_metrics (${columns.join(',')})
       VALUES ${valuesClause(chunk.length, columns.length)}
       ON CONFLICT (connection_id, app_id, dimension_hash) DO UPDATE SET
         revenue = EXCLUDED.revenue,
         observed_at = now(),
         sync_run_id = EXCLUDED.sync_run_id,
         restatement_generation = attribution_revenue_metrics.restatement_generation
           + (CASE WHEN attribution_revenue_metrics.revenue IS DISTINCT FROM EXCLUDED.revenue THEN 1 ELSE 0 END),
         last_restated_at = CASE WHEN attribution_revenue_metrics.revenue IS DISTINCT FROM EXCLUDED.revenue
                                 THEN now() ELSE attribution_revenue_metrics.last_restated_at END
       RETURNING (xmax = 0) AS inserted, (xmax <> 0 AND last_restated_at = now()) AS restated`,
      params,
      client,
    );
    accumulate(outcome, rows);
  }
  return outcome;
}

export async function upsertAttributionSources(
  scope: FactScope,
  mediaSources: readonly string[],
  client?: Queryable,
): Promise<void> {
  for (const source of new Set(mediaSources.filter(Boolean))) {
    await query(
      `INSERT INTO attribution_sources
         (organization_id, app_id, connection_id, provider_key, media_source, normalized_media_source, is_organic)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (connection_id, app_id, media_source) DO UPDATE SET observed_at = now()`,
      [
        scope.organizationId,
        scope.appId,
        scope.connectionId,
        scope.providerKey,
        source,
        normalizeMediaSource(source),
        isOrganicSource(source),
      ],
      client,
    );
  }
}

/**
 * Canonical media-source form used for cross-provider comparison.
 *
 * This is deliberately conservative: it lowercases, strips punctuation and maps
 * only well-known synonyms. It is used for grouping and for locating the MMP
 * rows that correspond to a marketing network - never as an entity-identity
 * decision on its own.
 */
export function normalizeMediaSource(source: string | null | undefined): string | null {
  if (!source) return null;
  const cleaned = source
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '');
  const synonyms: Record<string, string> = {
    facebook: 'meta',
    facebookads: 'meta',
    facebookinstallads: 'meta',
    meta: 'meta',
    metaads: 'meta',
    googleadwords: 'google',
    googleadwordsint: 'google',
    googleads: 'google',
    adwords: 'google',
    tiktokads: 'tiktok',
    tiktokglobal: 'tiktok',
    bytedanceglobalint: 'tiktok',
    unityads: 'unity',
    applovinint: 'applovin',
    organic: 'organic',
  };
  return synonyms[cleaned] ?? cleaned;
}

export function isOrganicSource(source: string | null | undefined): boolean {
  if (!source) return true;
  return normalizeMediaSource(source) === 'organic';
}

// ------------------------------------------- attribution campaign directory --

export type AttributionCampaignUpsert = {
  externalCampaignId: string;
  name: string | null;
  remoteCampaignId: string | null;
  channelId: string | null;
  channelName: string | null;
};

/**
 * Store the MMP's campaign directory.
 *
 * This is provider metadata, not a fact table: it is refreshed wholesale each
 * sync and carries no measures, so there is no restatement to track. What it
 * does carry is `remote_campaign_id` - the ad network's own campaign id - which
 * is what lets reconciliation match on an identifier instead of a name.
 */
export async function upsertAttributionCampaigns(
  scope: FactScope,
  campaigns: readonly AttributionCampaignUpsert[],
  client?: Queryable,
): Promise<number> {
  for (const campaign of campaigns) {
    await query(
      `INSERT INTO attribution_campaigns
         (organization_id, app_id, connection_id, provider_key, external_campaign_id,
          name, remote_campaign_id, channel_id, channel_name, observed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())
       ON CONFLICT (connection_id, app_id, external_campaign_id) DO UPDATE SET
         name = EXCLUDED.name,
         remote_campaign_id = EXCLUDED.remote_campaign_id,
         channel_id = EXCLUDED.channel_id,
         channel_name = EXCLUDED.channel_name,
         observed_at = now()`,
      [
        scope.organizationId,
        scope.appId,
        scope.connectionId,
        scope.providerKey,
        campaign.externalCampaignId,
        campaign.name,
        campaign.remoteCampaignId,
        campaign.channelId,
        campaign.channelName,
      ],
      client,
    );
  }
  return campaigns.length;
}

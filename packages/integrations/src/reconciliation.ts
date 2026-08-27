import type { MappingStatus } from '@mart/shared';
import { queryRows, mappingsRepo, normalizeMediaSource, type MappingUpsert } from '@mart/db';

/**
 * Meta <-> MMP entity reconciliation.
 *
 * The governing rule: identity comes from stable provider IDs. A name match is
 * recorded as an explicitly-labelled fallback candidate and never promoted to
 * an authoritative link on its own, because two campaigns can share a name and
 * silently merging them would corrupt every number computed from the join.
 */

export type ReconcileInput = {
  organizationId: string;
  appId: string;
  marketingProviderKey: string;
  attributionProviderKey: string;
};

export type ReconcileSummary = {
  entityType: 'campaign';
  marketingEntities: number;
  attributionEntities: number;
  matchedExact: number;
  matchedFallback: number;
  ambiguous: number;
  unmatchedMarketing: number;
  unmatchedAttribution: number;
};

type MarketingCampaign = { external_campaign_id: string; name: string | null };
type AttributionCampaign = {
  external_campaign_id: string | null;
  campaign_name: string | null;
  media_source: string | null;
};

/** Conservative name key: case, punctuation and spacing are not identity. */
export function nameKey(name: string | null | undefined): string | null {
  if (!name) return null;
  const key = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return key.length === 0 ? null : key;
}

export async function reconcileCampaigns(input: ReconcileInput): Promise<ReconcileSummary> {
  const marketing = await queryRows<MarketingCampaign>(
    `SELECT DISTINCT external_campaign_id, name
     FROM marketing_campaigns
     WHERE organization_id = $1 AND app_id = $2 AND provider_key = $3
       AND external_campaign_id IS NOT NULL`,
    [input.organizationId, input.appId, input.marketingProviderKey],
  );

  // Only attribution rows whose media source is the marketing network in
  // question are candidates: a TikTok-attributed campaign must never reconcile
  // against a Meta campaign.
  const expectedSource = normalizeMediaSource(input.marketingProviderKey.replace('_ads', ''));
  const attribution = await queryRows<AttributionCampaign>(
    `SELECT DISTINCT external_campaign_id, campaign_name, media_source
     FROM attribution_daily_metrics
     WHERE organization_id = $1 AND app_id = $2 AND provider_key = $3
       AND (normalized_media_source = $4 OR $4 IS NULL)`,
    [input.organizationId, input.appId, input.attributionProviderKey, expectedSource],
  );

  const attributionById = new Map<string, AttributionCampaign>();
  const attributionByName = new Map<string, AttributionCampaign[]>();
  for (const row of attribution) {
    if (row.external_campaign_id) attributionById.set(row.external_campaign_id, row);
    const key = nameKey(row.campaign_name);
    if (key) {
      const bucket = attributionByName.get(key) ?? [];
      bucket.push(row);
      attributionByName.set(key, bucket);
    }
  }

  const marketingById = new Map<string, MarketingCampaign>();
  const marketingByName = new Map<string, MarketingCampaign[]>();
  for (const row of marketing) {
    marketingById.set(row.external_campaign_id, row);
    const key = nameKey(row.name);
    if (key) {
      const bucket = marketingByName.get(key) ?? [];
      bucket.push(row);
      marketingByName.set(key, bucket);
    }
  }

  const mappings: MappingUpsert[] = [];
  const summary: ReconcileSummary = {
    entityType: 'campaign',
    marketingEntities: marketing.length,
    attributionEntities: attribution.length,
    matchedExact: 0,
    matchedFallback: 0,
    ambiguous: 0,
    unmatchedMarketing: 0,
    unmatchedAttribution: 0,
  };

  const matchedAttributionIds = new Set<string>();
  const matchedAttributionNames = new Set<string>();

  for (const campaign of marketing) {
    const byId = attributionById.get(campaign.external_campaign_id);
    if (byId) {
      matchedAttributionIds.add(campaign.external_campaign_id);
      summary.matchedExact += 1;
      mappings.push({
        entityType: 'campaign',
        sourceProvider: input.marketingProviderKey,
        sourceExternalId: campaign.external_campaign_id,
        sourceName: campaign.name,
        targetProvider: input.attributionProviderKey,
        targetExternalId: byId.external_campaign_id,
        targetName: byId.campaign_name,
        mappingMethod: 'stable_external_id',
        mappingConfidence: 1,
        status: 'matched_exact',
        candidates: [],
        evidence: { matchedOn: 'external_campaign_id' },
      });
      continue;
    }

    const key = nameKey(campaign.name);
    const nameCandidates = key ? (attributionByName.get(key) ?? []) : [];
    if (nameCandidates.length === 1) {
      const candidate = nameCandidates[0] as AttributionCampaign;
      if (key) matchedAttributionNames.add(key);
      summary.matchedFallback += 1;
      mappings.push({
        entityType: 'campaign',
        sourceProvider: input.marketingProviderKey,
        sourceExternalId: campaign.external_campaign_id,
        sourceName: campaign.name,
        targetProvider: input.attributionProviderKey,
        targetExternalId: candidate.external_campaign_id,
        targetName: candidate.campaign_name,
        mappingMethod: 'name_fallback',
        // Deliberately below the authoritative threshold: a name is evidence,
        // not identity.
        mappingConfidence: 0.5,
        status: 'matched_fallback',
        candidates: nameCandidates.map(toCandidate),
        evidence: {
          matchedOn: 'normalized_name',
          note: 'Name-based candidate. Not authoritative; verify before relying on it.',
        },
      });
      continue;
    }

    if (nameCandidates.length > 1) {
      summary.ambiguous += 1;
      mappings.push({
        entityType: 'campaign',
        sourceProvider: input.marketingProviderKey,
        sourceExternalId: campaign.external_campaign_id,
        sourceName: campaign.name,
        targetProvider: input.attributionProviderKey,
        targetExternalId: null,
        targetName: null,
        mappingMethod: 'name_fallback',
        mappingConfidence: 0.25,
        status: 'ambiguous',
        candidates: nameCandidates.map(toCandidate),
        evidence: {
          reason: `${nameCandidates.length} attribution campaigns share this name`,
        },
      });
      continue;
    }

    summary.unmatchedMarketing += 1;
    mappings.push({
      entityType: 'campaign',
      sourceProvider: input.marketingProviderKey,
      sourceExternalId: campaign.external_campaign_id,
      sourceName: campaign.name,
      targetProvider: input.attributionProviderKey,
      targetExternalId: null,
      targetName: null,
      mappingMethod: 'stable_external_id',
      mappingConfidence: 0,
      status: 'unmatched',
      candidates: [],
      evidence: {
        reason: 'No attribution campaign carries this campaign id, and no unique name match exists',
      },
    });
  }

  // Reverse direction, so attribution campaigns with no marketing counterpart
  // stay visible instead of disappearing from the reconciliation view.
  for (const row of attribution) {
    const id = row.external_campaign_id;
    const key = nameKey(row.campaign_name);
    const matchedById = id ? marketingById.has(id) : false;
    const matchedByName = key ? (marketingByName.get(key) ?? []).length === 1 : false;
    const status: MappingStatus = matchedById
      ? 'matched_exact'
      : matchedByName
        ? 'matched_fallback'
        : 'unmatched';
    if (status === 'unmatched') summary.unmatchedAttribution += 1;

    const sourceId = id ?? (key ? `name:${key}` : null);
    if (!sourceId) continue;

    mappings.push({
      entityType: 'campaign',
      sourceProvider: input.attributionProviderKey,
      sourceExternalId: sourceId,
      sourceName: row.campaign_name,
      targetProvider: input.marketingProviderKey,
      targetExternalId: matchedById ? id : null,
      targetName: matchedById ? (marketingById.get(id as string)?.name ?? null) : null,
      mappingMethod: matchedById ? 'stable_external_id' : 'name_fallback',
      mappingConfidence: matchedById ? 1 : matchedByName ? 0.5 : 0,
      status,
      candidates: [],
      evidence: id
        ? { matchedOn: matchedById ? 'external_campaign_id' : 'none' }
        : { note: 'Attribution provider did not supply a campaign id for this row' },
    });
  }

  await mappingsRepo.upsertMappings(input.organizationId, input.appId, mappings);
  return summary;
}

function toCandidate(row: AttributionCampaign): Record<string, unknown> {
  return {
    externalCampaignId: row.external_campaign_id,
    campaignName: row.campaign_name,
    mediaSource: row.media_source,
  };
}

/**
 * Mapping coverage for the dashboard.
 *
 * Coverage counts only authoritative links (exact id matches and human
 * verification). Fallback and ambiguous rows are reported separately so a low
 * coverage number cannot be inflated by name guessing.
 */
export type CoverageSummary = {
  total: number;
  matchedExact: number;
  matchedConfident: number;
  matchedFallback: number;
  ambiguous: number;
  unmatched: number;
  manuallyVerified: number;
  rejected: number;
  coveragePct: number | null;
};

export async function campaignCoverage(
  organizationId: string,
  appId: string,
  marketingProviderKey: string,
): Promise<CoverageSummary> {
  const rows = await queryRows<{ status: MappingStatus; count: string }>(
    `SELECT status, count(*)::text AS count
     FROM provider_entity_mappings
     WHERE organization_id = $1 AND app_id = $2 AND entity_type = 'campaign'
       AND source_provider = $3
     GROUP BY status`,
    [organizationId, appId, marketingProviderKey],
  );

  const counts = new Map(rows.map((r) => [r.status, Number(r.count)]));
  const get = (status: MappingStatus): number => counts.get(status) ?? 0;
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  const authoritative = get('matched_exact') + get('matched_confident') + get('manually_verified');

  return {
    total,
    matchedExact: get('matched_exact'),
    matchedConfident: get('matched_confident'),
    matchedFallback: get('matched_fallback'),
    ambiguous: get('ambiguous'),
    unmatched: get('unmatched'),
    manuallyVerified: get('manually_verified'),
    rejected: get('rejected'),
    coveragePct: total === 0 ? null : Number(((authoritative / total) * 100).toFixed(1)),
  };
}

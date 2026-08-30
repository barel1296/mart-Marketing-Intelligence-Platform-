import type { IsoDate, MappingStatus } from '@mart/shared';
import { OPERATIONAL_MAPPING_CONFIDENCE } from '@mart/shared';
import {
  queryRows,
  dataQualityRepo,
  isOrganicSource,
  mappingsRepo,
  normalizeMediaSource,
  type MappingUpsert,
} from '@mart/db';
import { checkReconciliationHealth } from './dataQuality.js';

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
  /** Paid attribution campaigns for this network. Organic is counted apart. */
  attributionEntities: number;
  organicEntities: number;
  matchedExact: number;
  /** Deterministic matches found inside the MMP's own campaign name. */
  matchedNameEmbedded: number;
  matchedFallback: number;
  ambiguous: number;
  unmatchedMarketing: number;
  unmatchedAttribution: number;
  notApplicable: number;
};

type MarketingCampaign = { external_campaign_id: string; name: string | null };
type AttributionCampaign = {
  external_campaign_id: string | null;
  campaign_name: string | null;
  media_source: string | null;
  normalized_media_source: string | null;
};

/**
 * Conservative name key: case, punctuation and spacing are not identity.
 *
 * Everything else is. Numbers, dates, country codes and creative markers are
 * left intact, so `..._26/08/26` and `..._29/08/26` stay different campaigns.
 */
export function nameKey(name: string | null | undefined): string | null {
  if (!name) return null;
  const key = name
    // Unicode differences that are typography rather than identity: a
    // non-breaking space is a space, and composed and decomposed accents are
    // the same letter.
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return key.length === 0 ? null : key;
}

/**
 * Names embedded in parentheses inside an MMP campaign name.
 *
 * Tenjin names a campaign for the creative or ad set and carries the ad
 * network's own campaign name in parentheses:
 *
 *   CPI_Broad_US_static (FB_Reveal_Rush_CPI_Broad_US_26/08/26)
 *   New App promotion Ad Set (FB_Reveal_Rush_CPI_Broad_US_NEW_CR__29/08/26)
 *
 * The parenthesized text is the network's name verbatim, so extracting it and
 * requiring an exact match after the same conservative normalization is a
 * deterministic rule, not a fuzzy one. Nothing is stripped from inside it:
 * `NEW_CR__29/08/26` must not match `26/08/26`.
 *
 * Several groups are returned when a name carries several, so a nested or
 * trailing annotation cannot hide the real one.
 */
export function embeddedNames(name: string | null | undefined): string[] {
  if (!name) return [];
  const out: string[] = [];
  // Non-greedy, innermost-first: each parenthesized run is one candidate.
  for (const match of name.matchAll(/\(([^()]+)\)/g)) {
    const inner = match[1]?.trim();
    if (inner && inner.length > 0) out.push(inner);
  }
  return out;
}

/**
 * Deterministic candidate keys for one attribution campaign name.
 *
 * The whole name first - an MMP that reports the network's name unchanged is
 * the easy case - then each embedded name. A key appears at most once.
 */
export function attributionNameKeys(name: string | null | undefined): string[] {
  const keys: string[] = [];
  const whole = nameKey(name);
  if (whole) keys.push(whole);
  for (const embedded of embeddedNames(name)) {
    const key = nameKey(embedded);
    if (key && !keys.includes(key)) keys.push(key);
  }
  return keys;
}

export async function reconcileCampaigns(input: ReconcileInput): Promise<ReconcileSummary> {
  // Everything this run writes is stamped after this instant, so anything older
  // is a link the run no longer believes in.
  const runStartedAt = new Date();
  const marketing = await queryRows<MarketingCampaign>(
    `SELECT DISTINCT external_campaign_id, name
     FROM marketing_campaigns
     WHERE organization_id = $1 AND app_id = $2 AND provider_key = $3
       AND external_campaign_id IS NOT NULL`,
    [input.organizationId, input.appId, input.marketingProviderKey],
  );

  // Every attribution campaign, with its media source, so organic rows can be
  // recorded as explicitly not-applicable rather than silently dropped. Only
  // rows whose media source is this marketing network are ever candidates: a
  // TikTok-attributed campaign must never reconcile against a Meta campaign,
  // and organic must never reconcile against anything.
  const expectedSource = normalizeMediaSource(input.marketingProviderKey.replace('_ads', ''));
  const allAttribution = await queryRows<AttributionCampaign>(
    `SELECT DISTINCT external_campaign_id, campaign_name, media_source, normalized_media_source
     FROM attribution_daily_metrics
     WHERE organization_id = $1 AND app_id = $2 AND provider_key = $3`,
    [input.organizationId, input.appId, input.attributionProviderKey],
  );

  const organic = allAttribution.filter((row) => isOrganicSource(row.media_source));
  const attribution = allAttribution.filter(
    (row) =>
      !isOrganicSource(row.media_source) &&
      (expectedSource === null || row.normalized_media_source === expectedSource),
  );

  const attributionById = new Map<string, AttributionCampaign>();
  /** Every deterministic name key an attribution campaign answers to. */
  const attributionByName = new Map<string, AttributionCampaign[]>();
  for (const row of attribution) {
    if (row.external_campaign_id) attributionById.set(row.external_campaign_id, row);
    for (const key of attributionNameKeys(row.campaign_name)) {
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
    organicEntities: organic.length,
    matchedExact: 0,
    matchedNameEmbedded: 0,
    matchedFallback: 0,
    ambiguous: 0,
    unmatchedMarketing: 0,
    unmatchedAttribution: 0,
    notApplicable: 0,
  };

  for (const campaign of marketing) {
    const byId = attributionById.get(campaign.external_campaign_id);
    if (byId) {
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

    if (nameCandidates.length > 0) {
      // How the match was reached decides the method and the confidence. A
      // whole-name equality is a bare shared name; a name found inside the
      // MMP's own parentheses is the provider's own annotation of which
      // network campaign this is.
      const embeddedOnly = nameCandidates.every(
        (candidate) =>
          nameKey(candidate.campaign_name) !== key &&
          embeddedNames(candidate.campaign_name).some((inner) => nameKey(inner) === key),
      );

      if (embeddedOnly) {
        // MANY attribution campaigns to ONE marketing campaign is the normal
        // shape here - static and video creatives of one Meta campaign - and
        // is aggregation, not ambiguity. Each gets its own mapping row.
        for (const candidate of nameCandidates) {
          summary.matchedNameEmbedded += 1;
          mappings.push({
            entityType: 'campaign',
            sourceProvider: input.marketingProviderKey,
            sourceExternalId: campaign.external_campaign_id,
            sourceName: campaign.name,
            targetProvider: input.attributionProviderKey,
            targetExternalId: candidate.external_campaign_id,
            targetName: candidate.campaign_name,
            mappingMethod: 'provider_name_embedding',
            // High, and deliberately still below authoritative: the evidence
            // is the provider's own naming, not a shared identifier.
            mappingConfidence: OPERATIONAL_MAPPING_CONFIDENCE,
            status: 'matched_fallback',
            candidates: nameCandidates.map(toCandidate),
            evidence: {
              matchedOn: 'provider_name_embedding',
              marketingName: campaign.name,
              attributionName: candidate.campaign_name,
              note: 'The marketing campaign name appears verbatim inside the attribution campaign name. Deterministic, but a name: not authoritative.',
              siblings: nameCandidates.length,
            },
          });
        }
        continue;
      }

      if (nameCandidates.length === 1) {
        const candidate = nameCandidates[0] as AttributionCampaign;
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
          // Deliberately below the operational threshold: a bare shared name
          // is evidence, not identity.
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
        reason: 'No attribution campaign carries this campaign id, and no name match exists',
      },
    });
  }

  // Reverse direction, so attribution campaigns with no marketing counterpart
  // stay visible instead of disappearing from the reconciliation view.
  for (const row of attribution) {
    const id = row.external_campaign_id;
    const keys = attributionNameKeys(row.campaign_name);
    const matchedById = id ? marketingById.has(id) : false;
    const marketingMatches = keys.flatMap((key) => marketingByName.get(key) ?? []);
    const embedded = keys.some(
      (key, index) => index > 0 && (marketingByName.get(key) ?? []).length === 1,
    );
    const status: MappingStatus = matchedById
      ? 'matched_exact'
      : marketingMatches.length === 1
        ? 'matched_fallback'
        : 'unmatched';
    if (status === 'unmatched') summary.unmatchedAttribution += 1;

    const sourceId = id ?? (keys[0] ? `name:${keys[0]}` : null);
    if (!sourceId) continue;

    const target = matchedById
      ? (marketingById.get(id as string) ?? null)
      : marketingMatches.length === 1
        ? (marketingMatches[0] ?? null)
        : null;

    mappings.push({
      entityType: 'campaign',
      sourceProvider: input.attributionProviderKey,
      sourceExternalId: sourceId,
      sourceName: row.campaign_name,
      targetProvider: input.marketingProviderKey,
      targetExternalId: target?.external_campaign_id ?? null,
      targetName: target?.name ?? null,
      mappingMethod: matchedById
        ? 'stable_external_id'
        : embedded
          ? 'provider_name_embedding'
          : 'name_fallback',
      mappingConfidence: matchedById
        ? 1
        : target
          ? embedded
            ? OPERATIONAL_MAPPING_CONFIDENCE
            : 0.5
          : 0,
      status,
      candidates: [],
      evidence: id
        ? {
            matchedOn: matchedById
              ? 'external_campaign_id'
              : embedded
                ? 'provider_name_embedding'
                : 'none',
          }
        : { note: 'Attribution provider did not supply a campaign id for this row' },
    });
  }

  // Organic is recorded, never matched. It is unpaid traffic that belongs to no
  // campaign, so treating it as an unmatched gap would make a healthy account
  // look broken - and letting it become a candidate would put organic installs
  // in a paid campaign's CPI.
  for (const row of organic) {
    const sourceId = row.external_campaign_id ?? `name:${nameKey(row.campaign_name) ?? 'organic'}`;
    summary.notApplicable += 1;
    mappings.push({
      entityType: 'campaign',
      sourceProvider: input.attributionProviderKey,
      sourceExternalId: sourceId,
      sourceName: row.campaign_name,
      targetProvider: input.marketingProviderKey,
      targetExternalId: null,
      targetName: null,
      mappingMethod: 'not_applicable',
      mappingConfidence: 0,
      status: 'not_applicable',
      candidates: [],
      evidence: {
        reason: 'Organic attribution: unpaid traffic, which belongs to no paid campaign',
        mediaSource: row.media_source,
      },
    });
  }

  await mappingsRepo.upsertMappings(input.organizationId, input.appId, mappings);
  await mappingsRepo.pruneStaleMappings(
    input.organizationId,
    input.appId,
    'campaign',
    runStartedAt,
  );
  await recordReconciliationFindings(input, summary);
  return summary;
}

/** Check keys this module owns and recomputes on every run. */
const RECONCILIATION_CHECK_KEYS = [
  'reconciliation.paid_spend_without_mapping',
  'reconciliation.attributed_campaigns_unmapped',
  'reconciliation.ambiguous_campaigns',
] as const;

/**
 * Turn the reconciliation outcome into data-quality findings.
 *
 * Without this the dashboard says "no data-quality findings" while spend sits
 * next to attribution that nothing links it to - the single most misleading
 * state the Command Center can be in, because every derived number looks fine.
 */
async function recordReconciliationFindings(
  input: ReconcileInput,
  summary: ReconcileSummary,
): Promise<void> {
  const coverage = await campaignCoverage(
    input.organizationId,
    input.appId,
    input.marketingProviderKey,
  );

  const spendRows = await queryRows<{ spend: string | null; latest: string | null }>(
    `SELECT SUM(spend)::text AS spend, MAX(report_date)::text AS latest
       FROM marketing_daily_metrics
      WHERE organization_id = $1 AND app_id = $2 AND provider_key = $3`,
    [input.organizationId, input.appId, input.marketingProviderKey],
  );

  const findings = checkReconciliationHealth({
    organizationId: input.organizationId,
    appId: input.appId,
    connectionId: null,
    syncRunId: null,
    observedDate: (spendRows[0]?.latest ?? new Date().toISOString().slice(0, 10)) as IsoDate,
    spend: Number(spendRows[0]?.spend ?? 0),
    marketingCampaigns: summary.marketingEntities,
    operationalCoveragePct: coverage.operationalCoveragePct,
    authoritativeCoveragePct: coverage.authoritativeCoveragePct,
    unmappedPaidCampaigns: summary.unmatchedAttribution,
    ambiguousCampaigns: summary.ambiguous,
  });

  // Replaced rather than appended: these describe the join as it stands now.
  await dataQualityRepo.clearDataQualityFindings(
    input.organizationId,
    input.appId,
    RECONCILIATION_CHECK_KEYS,
  );
  await dataQualityRepo.recordDataQualityFindings(findings);
}

function toCandidate(row: AttributionCampaign): Record<string, unknown> {
  return {
    externalCampaignId: row.external_campaign_id,
    campaignName: row.campaign_name,
    mediaSource: row.media_source,
  };
}

/**
 * Mapping coverage for the dashboard, reported as two separate numbers.
 *
 * They answer different questions and must never be mixed:
 *
 *  - **Authoritative** counts only links MART would stake a number on without
 *    a caveat: a shared stable id, or a human who verified it.
 *  - **Operational** adds deterministic high-confidence matches - a network
 *    campaign name found verbatim inside the MMP's own campaign name - which
 *    are good enough to compute a labelled mapped CPI from, and not good
 *    enough to call identity.
 *
 * Organic is excluded from both denominators. It is unpaid traffic that
 * belongs to no campaign, so counting it as an unmapped gap would make a
 * healthy account look broken.
 */
export type CoverageSummary = {
  total: number;
  matchedExact: number;
  matchedConfident: number;
  /** High-confidence deterministic matches (provider_name_embedding). */
  matchedNameEmbedded: number;
  /** Bare shared-name candidates, below the operational threshold. */
  matchedFallback: number;
  ambiguous: number;
  unmatched: number;
  manuallyVerified: number;
  rejected: number;
  notApplicable: number;
  authoritative: number;
  operational: number;
  authoritativeCoveragePct: number | null;
  operationalCoveragePct: number | null;
  /**
   * Retained under its original name for existing callers, and equal to
   * authoritative coverage: the stricter of the two is the safe default.
   */
  coveragePct: number | null;
};

export async function campaignCoverage(
  organizationId: string,
  appId: string,
  marketingProviderKey: string,
): Promise<CoverageSummary> {
  const rows = await queryRows<{
    status: MappingStatus;
    mapping_method: string;
    confident: string;
    count: string;
  }>(
    `SELECT status, mapping_method,
            count(*) FILTER (WHERE mapping_confidence >= $4)::text AS confident,
            count(*)::text AS count
     FROM provider_entity_mappings
     WHERE organization_id = $1 AND app_id = $2 AND entity_type = 'campaign'
       -- Organic is recorded from the attribution side, so it is matched on
       -- status rather than on source provider. It is counted for display and
       -- left out of the coverage denominator below.
       AND (source_provider = $3 OR status = 'not_applicable')
     GROUP BY status, mapping_method`,
    [organizationId, appId, marketingProviderKey, OPERATIONAL_MAPPING_CONFIDENCE],
  );

  const byStatus = new Map<MappingStatus, number>();
  let matchedNameEmbedded = 0;
  let operationalFallback = 0;
  for (const row of rows) {
    const count = Number(row.count);
    byStatus.set(row.status, (byStatus.get(row.status) ?? 0) + count);
    if (row.mapping_method === 'provider_name_embedding' && row.status === 'matched_fallback') {
      matchedNameEmbedded += count;
    }
    if (row.status === 'matched_fallback') operationalFallback += Number(row.confident);
  }

  const get = (status: MappingStatus): number => byStatus.get(status) ?? 0;
  // Organic is not a mapping opportunity, so it is out of the denominator.
  const total = [...byStatus.entries()]
    .filter(([status]) => status !== 'not_applicable')
    .reduce((sum, [, count]) => sum + count, 0);
  const authoritative = get('matched_exact') + get('matched_confident') + get('manually_verified');
  const operational = authoritative + operationalFallback;
  const pct = (value: number): number | null =>
    total === 0 ? null : Number(((value / total) * 100).toFixed(1));

  return {
    total,
    matchedExact: get('matched_exact'),
    matchedConfident: get('matched_confident'),
    matchedNameEmbedded,
    matchedFallback: get('matched_fallback'),
    ambiguous: get('ambiguous'),
    unmatched: get('unmatched'),
    manuallyVerified: get('manually_verified'),
    rejected: get('rejected'),
    notApplicable: get('not_applicable'),
    authoritative,
    operational,
    authoritativeCoveragePct: pct(authoritative),
    operationalCoveragePct: pct(operational),
    coveragePct: pct(authoritative),
  };
}

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
  /**
   * Campaign ids the MMP published that MART's marketing structure does not
   * contain - usually a different ad account, or a structure sync that has not
   * reached them. Reported rather than silently ignored: it is the difference
   * between "the MMP said nothing" and "the MMP said something MART cannot use".
   */
  declarationsOutsideStructure: number;
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
  const marketingIds = new Set(marketing.map((row) => row.external_campaign_id));

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

  // The MMP's own campaign directory: its campaign id alongside the ad
  // network's campaign id, as the MMP resolved it. This is a stable
  // cross-provider identifier, so a match through it is authoritative - and it
  // is the only thing that can tell two network campaigns with identical names
  // apart.
  const directory = await queryRows<{
    external_campaign_id: string;
    remote_campaign_id: string | null;
  }>(
    `SELECT external_campaign_id, remote_campaign_id
       FROM attribution_campaigns
      WHERE organization_id = $1 AND app_id = $2 AND provider_key = $3
        AND remote_campaign_id IS NOT NULL`,
    [input.organizationId, input.appId, input.attributionProviderKey],
  );
  /** Ad-network campaign id -> the MMP campaign ids that declare it. */
  const byRemoteId = new Map<string, string[]>();
  /**
   * MMP campaign id -> the network campaign id it declares, kept ONLY where
   * that network campaign is one MART actually holds.
   *
   * A declaration naming a campaign MART does not have cannot discriminate
   * between the campaigns it does have, so it must not be allowed to veto the
   * name evidence. Treating it as a veto is fail-closed: it silently unmatched
   * every campaign on an account whose MMP tracks a different ad account than
   * the one MART is bound to.
   */
  const declaredRemoteFor = new Map<string, string>();
  let declarationsOutsideStructure = 0;
  for (const row of directory) {
    const remote = row.remote_campaign_id;
    if (!remote) continue;
    byRemoteId.set(remote, [...(byRemoteId.get(remote) ?? []), row.external_campaign_id]);
    if (marketingIds.has(remote)) declaredRemoteFor.set(row.external_campaign_id, remote);
    else declarationsOutsideStructure += 1;
  }

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

  // Campaigns a person has already decided. Recomputing them would put a
  // freshly computed row beside the human's, and a decision that has to be
  // re-made after every sync is not a decision.
  const decided = await queryRows<{ source_external_id: string }>(
    `SELECT DISTINCT source_external_id FROM provider_entity_mappings
      WHERE organization_id = $1 AND app_id = $2 AND entity_type = 'campaign'
        AND status IN ('manually_verified', 'rejected')`,
    [input.organizationId, input.appId],
  );
  const humanDecided = new Set(decided.map((row) => row.source_external_id));

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
    declarationsOutsideStructure: 0,
  };

  for (const campaign of marketing) {
    if (humanDecided.has(campaign.external_campaign_id)) continue;
    // The MMP declared this network campaign id itself. An identifier beats
    // every name rule, so it is checked first and recorded as authoritative.
    const declared = (byRemoteId.get(campaign.external_campaign_id) ?? [])
      .map((id) => attributionById.get(id))
      .filter((row): row is AttributionCampaign => row !== undefined);
    if (declared.length > 0) {
      for (const candidate of declared) {
        summary.matchedExact += 1;
        mappings.push({
          entityType: 'campaign',
          sourceProvider: input.marketingProviderKey,
          sourceExternalId: campaign.external_campaign_id,
          sourceName: campaign.name,
          targetProvider: input.attributionProviderKey,
          targetExternalId: candidate.external_campaign_id,
          targetName: candidate.campaign_name,
          // The MMP published the network's id for this campaign: an explicit
          // provider-supplied link, not something MART inferred.
          mappingMethod: 'explicit_provider_mapping',
          mappingConfidence: 1,
          status: 'matched_exact',
          candidates: declared.map(toCandidate),
          evidence: {
            matchedOn: 'remote_campaign_id',
            remoteCampaignId: campaign.external_campaign_id,
            note: 'The attribution provider published this network campaign id for its own campaign. A stable identifier, not a name.',
          },
        });
      }
      continue;
    }

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
    // A candidate that already declares a different network campaign id is not
    // a candidate for this one, whatever the names say. This is what resolves
    // two network campaigns with identical names: the MMP already told MART
    // which of them each of its campaigns belongs to.
    // A candidate that already declares a DIFFERENT network campaign MART
    // holds is not a candidate for this one, whatever the names say: that is
    // what separates two network campaigns with identical names. A declaration
    // MART cannot resolve is not in this map at all, so it never vetoes.
    const nameCandidates = (key ? (attributionByName.get(key) ?? []) : []).filter((candidate) => {
      const declaredFor = candidate.external_campaign_id
        ? declaredRemoteFor.get(candidate.external_campaign_id)
        : undefined;
      return declaredFor === undefined || declaredFor === campaign.external_campaign_id;
    });

    // Several marketing campaigns sharing one name is the mirror image of the
    // many-to-one case and is NOT aggregation: an attribution campaign naming
    // that name cannot say which of them it came from. Matching it to each in
    // turn would credit the same installs to every duplicate and inflate their
    // mapped spend, so both sides are left ambiguous instead.
    const duplicateMarketingNames = key ? (marketingByName.get(key) ?? []).length : 0;
    if (nameCandidates.length > 0 && duplicateMarketingNames > 1) {
      summary.ambiguous += 1;
      mappings.push({
        entityType: 'campaign',
        sourceProvider: input.marketingProviderKey,
        sourceExternalId: campaign.external_campaign_id,
        sourceName: campaign.name,
        targetProvider: input.attributionProviderKey,
        targetExternalId: null,
        targetName: null,
        mappingMethod: 'provider_name_embedding',
        mappingConfidence: 0.25,
        status: 'ambiguous',
        candidates: nameCandidates.map(toCandidate),
        evidence: {
          reason: `${duplicateMarketingNames} marketing campaigns share this name, so an attribution campaign naming it cannot be attributed to one of them`,
          duplicateMarketingCampaigns: duplicateMarketingNames,
        },
      });
      continue;
    }

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
  const declaredAttributionIds = new Set(
    [...byRemoteId.entries()]
      .filter(([remote]) => marketingById.has(remote))
      .flatMap(([, ids]) => ids),
  );

  for (const row of attribution) {
    const id = row.external_campaign_id;
    // Already linked by identifier from the other direction.
    if (id && declaredAttributionIds.has(id)) continue;
    if (id && humanDecided.has(id)) continue;
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

  summary.declarationsOutsideStructure = declarationsOutsideStructure;

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
  'reconciliation.current_period_spend_unmapped',
  'reconciliation.paid_installs_unmapped',
  'reconciliation.ambiguous_campaigns',
  'reconciliation.historical_campaigns_without_activity',
  // Retired keys, cleared so a stale finding from an earlier release cannot
  // linger on the dashboard as if it were current.
  'reconciliation.paid_spend_without_mapping',
  'reconciliation.attributed_campaigns_unmapped',
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
  // The window the findings describe. Reconciliation has no reporting range of
  // its own, so it reviews the trailing 30 days - the period a dashboard is
  // usually looking at, and the one where "is today's spend accounted for?"
  // is a live question.
  const to = new Date();
  const from = new Date(to.getTime() - 29 * 86400000);
  const window = {
    from: from.toISOString().slice(0, 10) as IsoDate,
    to: to.toISOString().slice(0, 10) as IsoDate,
    attributionProviderKey: input.attributionProviderKey,
  };

  const coverage = await campaignCoverage(
    input.organizationId,
    input.appId,
    input.marketingProviderKey,
    window,
  );
  const eligible = coverage.eligible;
  if (!eligible) return;

  const findings = checkReconciliationHealth({
    organizationId: input.organizationId,
    appId: input.appId,
    connectionId: null,
    syncRunId: null,
    observedDate: window.to,
    spend: eligible.totalSpend,
    mappedSpend: eligible.mappedSpend,
    ambiguousSpend: eligible.ambiguousSpend,
    unmappedSpend: eligible.unmappedSpend,
    eligibleCampaigns: eligible.eligibleCampaigns,
    ambiguousCampaigns: eligible.ambiguousCampaigns,
    historicalCampaigns: eligible.historicalCampaigns,
    paidInstalls: eligible.totalPaidInstalls,
    mappedPaidInstalls: eligible.mappedPaidInstalls,
  });
  void summary;

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
  /** Present when a reporting window was given; see EligibleCoverage. */
  eligible?: EligibleCoverage;
};

/**
 * Coverage restricted to what the selected reporting window is about.
 *
 * Three separate numbers, never combined - they answer different questions and
 * a single blended percentage would hide the one that matters:
 *
 *  - **campaignPct**  how many of the campaigns that actually delivered in the
 *    window are mapped. A campaign that spent nothing in the window is not a
 *    current-period gap, so it is out of this denominator.
 *  - **spendPct**     how much of the money is accounted for. This is the one
 *    that exposes a single large campaign sitting unmapped: nine dormant
 *    campaigns cannot drag it down, and one live one can.
 *  - **installPct**   how much of the paid attribution is accounted for.
 *    Organic is excluded: it belongs to no campaign.
 */
export type EligibleCoverage = {
  from: IsoDate;
  to: IsoDate;
  /** Campaigns with spend, impressions or clicks in the window. */
  eligibleCampaigns: number;
  mappedCampaigns: number;
  ambiguousCampaigns: number;
  unmappedCampaigns: number;
  /** Known to the structure sync but with no delivery in the window. */
  historicalCampaigns: number;
  campaignPct: number | null;

  totalSpend: number;
  mappedSpend: number;
  ambiguousSpend: number;
  unmappedSpend: number;
  spendPct: number | null;

  totalPaidInstalls: number;
  mappedPaidInstalls: number;
  ambiguousPaidInstalls: number;
  unmappedPaidInstalls: number;
  organicInstalls: number;
  installPct: number | null;
};

/** SQL for "this mapping is strong enough to operate on". */
const OPERATIONAL_MAPPING = `(m.status IN ('matched_exact', 'matched_confident', 'manually_verified')
  OR (m.status = 'matched_fallback' AND m.mapping_confidence >= ${OPERATIONAL_MAPPING_CONFIDENCE}))`;

export async function campaignCoverage(
  organizationId: string,
  appId: string,
  marketingProviderKey: string,
  window?: { from: IsoDate; to: IsoDate; attributionProviderKey?: string | null },
): Promise<CoverageSummary> {
  // One row per campaign, not per mapping. A marketing campaign with three
  // attribution children is one campaign that is mapped, not three - counting
  // rows would let a well-mapped campaign raise coverage simply by having more
  // children beneath it, which is the opposite of what coverage measures.
  const rows = await queryRows<{
    status: MappingStatus;
    mapping_method: string;
    operational: boolean;
    count: string;
  }>(
    `WITH best AS (
       SELECT DISTINCT ON (source_provider, source_external_id)
              source_external_id, status, mapping_method, mapping_confidence
       FROM provider_entity_mappings
       WHERE organization_id = $1 AND app_id = $2 AND entity_type = 'campaign'
         -- Organic is recorded from the attribution side, so it is matched on
         -- status rather than on source provider. It is counted for display and
         -- left out of the coverage denominator below.
         AND (source_provider = $3 OR status = 'not_applicable')
       -- The strongest link a campaign has is the one that describes it.
       ORDER BY source_provider, source_external_id, mapping_confidence DESC, status
     )
     SELECT status, mapping_method,
            (status IN ('matched_exact', 'matched_confident', 'manually_verified')
             OR (status = 'matched_fallback' AND mapping_confidence >= $4)) AS operational,
            count(*)::text AS count
     FROM best
     GROUP BY status, mapping_method, operational`,
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
    if (row.status === 'matched_fallback' && row.operational) operationalFallback += count;
  }

  const get = (status: MappingStatus): number => byStatus.get(status) ?? 0;
  // Organic is not a mapping opportunity, so it is out of the denominator.
  const total = [...byStatus.entries()]
    .filter(([status]) => status !== 'not_applicable')
    .reduce((sum, [, count]) => sum + count, 0);
  const authoritative = get('matched_exact') + get('matched_confident') + get('manually_verified');
  const operational = authoritative + operationalFallback;
  const pct = (value: number, denominator: number): number | null =>
    denominator === 0 ? null : Number(((value / denominator) * 100).toFixed(1));

  const summary: CoverageSummary = {
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
    authoritativeCoveragePct: pct(authoritative, total),
    operationalCoveragePct: pct(operational, total),
    coveragePct: pct(authoritative, total),
  };

  if (!window) return summary;
  return {
    ...summary,
    eligible: await eligibleCoverage(organizationId, appId, marketingProviderKey, window),
  };
}

/**
 * Coverage over the selected reporting window.
 *
 * Nine campaigns that stopped running last quarter are not a current-period
 * reconciliation gap, and counting them as one makes today's coverage look
 * broken while hiding the one live campaign that really is unmapped.
 */
async function eligibleCoverage(
  organizationId: string,
  appId: string,
  marketingProviderKey: string,
  window: { from: IsoDate; to: IsoDate; attributionProviderKey?: string | null },
): Promise<EligibleCoverage> {
  // Each query binds exactly the parameters it references: Postgres rejects a
  // bind carrying more than the statement uses.
  const campaignParams = [organizationId, appId, marketingProviderKey, window.from, window.to];
  const installParams = [
    organizationId,
    appId,
    window.from,
    window.to,
    window.attributionProviderKey ?? null,
  ];

  const campaigns = await queryRows<{
    state: 'mapped' | 'ambiguous' | 'unmapped';
    campaigns: string;
    spend: string;
  }>(
    // Eligible = delivered something in the window. A campaign with no spend,
    // impressions or clicks had nothing to attribute.
    `WITH delivered AS (
       SELECT external_campaign_id,
              SUM(spend) AS spend
       FROM marketing_daily_metrics
       WHERE organization_id = $1 AND app_id = $2 AND provider_key = $3
         AND report_date BETWEEN $4 AND $5
         AND external_campaign_id IS NOT NULL
       GROUP BY external_campaign_id
       HAVING SUM(spend) > 0 OR SUM(impressions) > 0 OR SUM(clicks) > 0
     ),
     state AS (
       SELECT d.external_campaign_id, d.spend,
              CASE
                WHEN EXISTS (
                  SELECT 1 FROM provider_entity_mappings m
                  WHERE m.organization_id = $1 AND m.app_id = $2
                    AND m.entity_type = 'campaign' AND m.source_provider = $3
                    AND m.source_external_id = d.external_campaign_id
                    AND m.target_external_id IS NOT NULL AND ${OPERATIONAL_MAPPING}
                ) THEN 'mapped'
                WHEN EXISTS (
                  SELECT 1 FROM provider_entity_mappings m
                  WHERE m.organization_id = $1 AND m.app_id = $2
                    AND m.entity_type = 'campaign' AND m.source_provider = $3
                    AND m.source_external_id = d.external_campaign_id
                    AND m.status = 'ambiguous'
                ) THEN 'ambiguous'
                ELSE 'unmapped'
              END AS state
       FROM delivered d
     )
     SELECT state, count(*)::text AS campaigns, COALESCE(SUM(spend), 0)::text AS spend
     FROM state GROUP BY state`,
    campaignParams,
  );

  const known = await queryRows<{ count: string }>(
    `SELECT count(DISTINCT external_campaign_id)::text AS count
       FROM marketing_campaigns
      WHERE organization_id = $1 AND app_id = $2 AND provider_key = $3`,
    [organizationId, appId, marketingProviderKey],
  );

  const installs = await queryRows<{
    state: 'mapped' | 'ambiguous' | 'unmapped' | 'organic';
    installs: string;
  }>(
    `SELECT CASE
              WHEN COALESCE(a.normalized_media_source, 'organic') = 'organic' THEN 'organic'
              WHEN EXISTS (
                SELECT 1 FROM provider_entity_mappings m
                WHERE m.organization_id = $1 AND m.app_id = $2
                  AND m.entity_type = 'campaign' AND m.target_provider = a.provider_key
                  AND m.target_external_id = a.external_campaign_id AND ${OPERATIONAL_MAPPING}
              ) THEN 'mapped'
              WHEN EXISTS (
                SELECT 1 FROM provider_entity_mappings m
                WHERE m.organization_id = $1 AND m.app_id = $2
                  AND m.entity_type = 'campaign' AND m.status = 'ambiguous'
                  AND m.candidates::text LIKE '%' || a.external_campaign_id || '%'
              ) THEN 'ambiguous'
              ELSE 'unmapped'
            END AS state,
            COALESCE(SUM(a.attributed_installs), 0)::text AS installs
       FROM attribution_daily_metrics a
      WHERE a.organization_id = $1 AND a.app_id = $2
        AND a.install_date BETWEEN $3 AND $4
        AND ($5::text IS NULL OR a.provider_key = $5)
      GROUP BY state`,
    installParams,
  );

  const campaignBy = (state: string): { campaigns: number; spend: number } => {
    const row = campaigns.find((r) => r.state === state);
    return { campaigns: Number(row?.campaigns ?? 0), spend: Number(row?.spend ?? 0) };
  };
  const installsBy = (state: string): number =>
    Number(installs.find((r) => r.state === state)?.installs ?? 0);

  const mapped = campaignBy('mapped');
  const ambiguous = campaignBy('ambiguous');
  const unmapped = campaignBy('unmapped');
  const eligibleCampaigns = mapped.campaigns + ambiguous.campaigns + unmapped.campaigns;
  const totalSpend = mapped.spend + ambiguous.spend + unmapped.spend;

  const mappedInstalls = installsBy('mapped');
  const ambiguousInstalls = installsBy('ambiguous');
  const unmappedInstalls = installsBy('unmapped');
  const organicInstalls = installsBy('organic');
  const totalPaidInstalls = mappedInstalls + ambiguousInstalls + unmappedInstalls;

  const pct = (value: number, denominator: number): number | null =>
    denominator === 0 ? null : Number(((value / denominator) * 100).toFixed(1));

  return {
    from: window.from,
    to: window.to,
    eligibleCampaigns,
    mappedCampaigns: mapped.campaigns,
    ambiguousCampaigns: ambiguous.campaigns,
    unmappedCampaigns: unmapped.campaigns,
    historicalCampaigns: Math.max(0, Number(known[0]?.count ?? 0) - eligibleCampaigns),
    campaignPct: pct(mapped.campaigns, eligibleCampaigns),
    totalSpend,
    mappedSpend: mapped.spend,
    ambiguousSpend: ambiguous.spend,
    unmappedSpend: unmapped.spend,
    spendPct: pct(mapped.spend, totalSpend),
    totalPaidInstalls,
    mappedPaidInstalls: mappedInstalls,
    ambiguousPaidInstalls: ambiguousInstalls,
    unmappedPaidInstalls: unmappedInstalls,
    organicInstalls,
    installPct: pct(mappedInstalls, totalPaidInstalls),
  };
}

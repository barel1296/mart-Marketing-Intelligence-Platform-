import { OPERATIONAL_MAPPING_CONFIDENCE } from '@mart/shared';

/**
 * The populations MART computes over, as one definition each.
 *
 * A ratio means something only when its numerator and denominator describe the
 * same set of things, and the way that goes wrong is never dramatic: two
 * individually correct numbers get divided and the answer looks plausible. The
 * defence is not care - it is having one definition of each population that
 * every query builds from.
 *
 * Before this module the operational-mapping test was written out twelve times
 * across six files and the organic test fifteen times. They agreed, until they
 * did not: the coverage metrics counted a deterministic name match as mapped
 * while the discrepancy lists counted the same campaign as unmapped, so the
 * Command Center could report 100% coverage above a list of unmapped campaigns.
 * Nobody wrote that rule; it emerged from two copies drifting apart.
 *
 * Each builder takes the table alias it should read, because that is the only
 * thing the call sites legitimately differ on. The audit CLIs deliberately do
 * NOT import these: an audit that recomputes a figure with the same code it is
 * checking proves nothing, so their copies are independent by design.
 */

/**
 * Links MART treats as established: a stable provider id, a human's decision,
 * or a match the provider's own structure confirms.
 *
 * Authoritative coverage is the honest number to report to someone asking how
 * much of the account is genuinely reconciled.
 */
export function authoritativeMapping(alias = 'm'): string {
  return `${alias}.status IN ('matched_exact', 'matched_confident', 'manually_verified')`;
}

/**
 * Links MART is willing to compute on: authoritative ones, plus deterministic
 * high-confidence matches.
 *
 * This is the population every operational figure uses - mapped spend, mapped
 * installs, the campaign table's attribution columns and the coverage cards
 * beside them. A bare shared name (0.5) never qualifies; a name embedded in the
 * provider's own structure (0.9) does.
 */
export function operationalMapping(alias = 'm'): string {
  return `(${authoritativeMapping(alias)}
    OR (${alias}.status = 'matched_fallback'
        AND ${alias}.mapping_confidence >= ${OPERATIONAL_MAPPING_CONFIDENCE}))`;
}

/**
 * Paid traffic.
 *
 * Organic is real attribution and belongs in the totals, but it belongs to no
 * campaign: letting it into a paid population puts installs nobody bought into
 * a campaign's CPI. A NULL media source is treated as organic, never as paid -
 * the conservative direction, since crediting a campaign with unknown traffic
 * is the error that flatters.
 */
export function notOrganic(alias = 't'): string {
  return `COALESCE(${alias}.normalized_media_source, 'organic') <> 'organic'`;
}

/** Unpaid traffic - the exact complement of {@link notOrganic}. */
export function organic(alias = 't'): string {
  return `COALESCE(${alias}.normalized_media_source, 'organic') = 'organic'`;
}

/**
 * Attribution rows whose campaign resolves to a marketing campaign.
 *
 * Answers "how much of the account is mapped". It says nothing about when those
 * campaigns ran, which is why it must never be the denominator under a windowed
 * numerator.
 */
export function mappedAttributionCampaign(alias = 't'): string {
  return `${alias}.external_campaign_id IN (
    SELECT m.target_external_id FROM provider_entity_mappings m
    WHERE m.organization_id = ${alias}.organization_id AND m.app_id = ${alias}.app_id
      AND m.entity_type = 'campaign'
      AND m.target_provider = ${alias}.provider_key
      AND m.target_external_id IS NOT NULL
      AND ${operationalMapping('m')}
  )`;
}

/**
 * Attribution rows whose marketing campaign also DELIVERED in the window.
 *
 * The distinction from {@link mappedAttributionCampaign} is the reason a mapped
 * CPI can be quietly wrong. Spend is summed over the window, so a campaign that
 * spent nothing in it contributes zero to the numerator - while its installs,
 * mapped perfectly well, still land in the denominator. The result understates
 * cost per install and looks entirely reasonable.
 *
 * `from` and `to` are the bind placeholders for the window, so the caller keeps
 * control of parameter order.
 */
export function deliveryAlignedCampaign(window: { from: string; to: string }, alias = 't'): string {
  return `${alias}.external_campaign_id IN (
    SELECT m.target_external_id FROM provider_entity_mappings m
    JOIN (
      SELECT DISTINCT md.external_campaign_id, md.provider_key
      FROM marketing_daily_metrics md
      WHERE md.organization_id = ${alias}.organization_id AND md.app_id = ${alias}.app_id
        AND md.report_date BETWEEN ${window.from} AND ${window.to}
        AND (md.spend > 0 OR md.impressions > 0 OR md.clicks > 0)
    ) delivered
      ON delivered.external_campaign_id = m.source_external_id
     AND delivered.provider_key = m.source_provider
    WHERE m.organization_id = ${alias}.organization_id AND m.app_id = ${alias}.app_id
      AND m.entity_type = 'campaign'
      AND m.target_provider = ${alias}.provider_key
      AND m.target_external_id IS NOT NULL
      AND ${operationalMapping('m')}
  )`;
}

/**
 * Marketing rows for campaigns that delivered something in the window.
 *
 * "Delivered" means spend, impressions or clicks - not merely a row, since a
 * provider may report an all-zero day for a paused campaign, and counting that
 * as participation would put campaigns into the current-period population that
 * did nothing in it.
 */
export function delivered(alias = 'md'): string {
  return `(${alias}.spend > 0 OR ${alias}.impressions > 0 OR ${alias}.clicks > 0)`;
}

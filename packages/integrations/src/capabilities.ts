/**
 * Provider capability model.
 *
 * MART never assumes two providers expose the same data. A capability is either
 * declared by the adapter (a documented, plan-independent property of the API)
 * or probed against the live account (a property that depends on the customer's
 * plan and permissions). The dashboard reads the resulting rows to decide
 * whether a field may be displayed at all, so an unavailable dimension shows an
 * explicit unavailable state instead of a fabricated value.
 */
import { COHORT_AGES, COHORT_REVENUE_TYPES, cohortCapabilityKey } from '@mart/shared';

/**
 * One key per (revenue type, cohort age) MART can serve, e.g.
 * `cohort_ad_revenue_d7`. Probed from the account's saved report definition,
 * so a cohort metric can name the exact provider field it is missing.
 */
export const COHORT_CAPABILITY_KEYS = COHORT_REVENUE_TYPES.flatMap((revenueType) =>
  COHORT_AGES.map((age) => cohortCapabilityKey(revenueType, age)),
);

export const CAPABILITY_KEYS = [
  // Datasets
  'installs',
  'events',
  'revenue',
  'cost_data',
  'delivery_metrics',
  'raw_data',
  'cohort_reporting',
  'skan_data',
  // Cohort revenue, per component and age. Declared here as literals so the
  // key type stays closed; the generated list above must match it, which the
  // capabilities unit test asserts.
  'cohort_iap_revenue_d1',
  'cohort_iap_revenue_d7',
  'cohort_ad_revenue_d1',
  'cohort_ad_revenue_d7',
  'cohort_total_revenue_d1',
  'cohort_total_revenue_d7',
  // Dimensions
  'media_source',
  'campaign',
  'campaign_id',
  'ad_group',
  'ad_group_id',
  'ad',
  'ad_id',
  'creative',
  'creative_id',
  'country',
  'platform',
  'install_timestamp',
  // Measures
  'impressions',
  'clicks',
  'link_clicks',
  'reach_frequency',
  'attributed_installs',
  'attributed_revenue',
] as const;

export type CapabilityKey = (typeof CAPABILITY_KEYS)[number];

export type DiscoveryMethod = 'declared' | 'probed' | 'inferred' | 'manual';

export type CapabilityDeclaration = {
  key: CapabilityKey;
  supported: boolean;
  discoveryMethod: DiscoveryMethod;
  /** Non-sensitive explanation, surfaced in the integrations UI. */
  detail?: Record<string, unknown>;
};

export type CapabilitySet = ReadonlyMap<CapabilityKey, CapabilityDeclaration>;

export function toCapabilitySet(declarations: readonly CapabilityDeclaration[]): CapabilitySet {
  return new Map(declarations.map((d) => [d.key, d]));
}

export function supports(set: CapabilitySet, key: CapabilityKey): boolean {
  return set.get(key)?.supported === true;
}

/**
 * Build declarations from a simple map. Anything omitted is absent rather than
 * false, which keeps "we have not checked" distinguishable from "not supported".
 */
export function declare(
  entries: Partial<Record<CapabilityKey, boolean>>,
  discoveryMethod: DiscoveryMethod = 'declared',
  detail?: Record<string, unknown>,
): CapabilityDeclaration[] {
  return Object.entries(entries).map(([key, supported]) => ({
    key: key as CapabilityKey,
    supported: Boolean(supported),
    discoveryMethod,
    ...(detail ? { detail } : {}),
  }));
}

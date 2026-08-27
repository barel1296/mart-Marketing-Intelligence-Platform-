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

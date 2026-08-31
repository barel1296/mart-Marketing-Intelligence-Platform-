/**
 * MART canonical domain vocabulary.
 *
 * Everything in this file is provider-independent by design. Provider-specific
 * naming must never leak past an adapter boundary (see packages/integrations).
 */

export const ORGANIZATION_ROLES = ['owner', 'admin', 'analyst', 'viewer'] as const;
export type OrganizationRole = (typeof ORGANIZATION_ROLES)[number];

export const APP_PLATFORMS = ['ios', 'android', 'cross_platform'] as const;
export type AppPlatform = (typeof APP_PLATFORMS)[number];

/** Integration families. A provider belongs to exactly one category. */
export const PROVIDER_CATEGORIES = [
  'marketing_network',
  'attribution_mmp',
  'product_analytics',
  'monetization',
  'store',
  'backend',
  'crm',
] as const;
export type ProviderCategory = (typeof PROVIDER_CATEGORIES)[number];

/** Providers known to the platform. Only a subset is implemented in Phase 0A. */
export const PROVIDER_KEYS = [
  'meta_ads',
  'tiktok_ads',
  'google_ads',
  'unity_ads',
  'applovin',
  'mintegral',
  'pangle',
  'appsflyer',
  'tenjin',
  'adjust',
  'singular',
  'kochava',
  'firebase',
  'mixpanel',
  'amplitude',
  'cas_ai',
  'applovin_max',
  'levelplay',
  'admob',
  'revenuecat',
] as const;
export type ProviderKey = (typeof PROVIDER_KEYS)[number];

export const ATTRIBUTION_PROVIDER_KEYS = ['appsflyer', 'tenjin'] as const;
export type AttributionProviderKey = (typeof ATTRIBUTION_PROVIDER_KEYS)[number];

/**
 * Analytical grain. MART never mixes grains silently: every stored fact and
 * every governed metric declares the grain it is expressed in.
 *
 * - report_date  : the date the ad network reported delivery/cost against.
 * - install_date : the date a user installed (cohort anchor).
 * - event_date   : the date an in-app event/revenue was recorded.
 * - cohort_date  : an install_date cohort observed at a specific age (D0..DN).
 */
export const METRIC_GRAINS = ['report_date', 'install_date', 'event_date', 'cohort_date'] as const;
export type MetricGrain = (typeof METRIC_GRAINS)[number];

/** Data domains a connector can synchronize. */
export const SYNC_DATA_TYPES = [
  'marketing_structure',
  'marketing_performance',
  'attribution_installs',
  'attribution_events',
  'attribution_revenue',
] as const;
export type SyncDataType = (typeof SYNC_DATA_TYPES)[number];

export const SYNC_RUN_STATUSES = [
  'queued',
  'running',
  'partially_completed',
  'completed',
  'failed',
  'cancelled',
  /**
   * The adapter does not implement this stream, so no request was made and no
   * rows moved. Distinct from 'completed' with zero rows, which means MART
   * asked and the provider had nothing.
   */
  'not_implemented',
] as const;
export type SyncRunStatus = (typeof SYNC_RUN_STATUSES)[number];

export const SYNC_TRIGGERS = ['manual', 'scheduled', 'backfill', 'retry'] as const;
export type SyncTrigger = (typeof SYNC_TRIGGERS)[number];

/**
 * Connector error taxonomy. Never collapse failures into "unknown_error":
 * the class determines whether MART retries, alerts, or asks a human to act.
 */
export const PROVIDER_ERROR_CLASSES = [
  'authentication_error',
  'authorization_error',
  'expired_credential',
  'rate_limited',
  'provider_unavailable',
  'timeout',
  'invalid_request',
  'schema_change',
  'pagination_failure',
  'data_validation_error',
  'normalization_error',
  'database_error',
  /**
   * The credential works and the request was well formed, but something the
   * provider account must contain does not exist yet - a saved report, an
   * export definition. Distinct from authorization_error (permission) and
   * invalid_request (MART's fault): only the account owner can resolve it, and
   * MART must say exactly what to create rather than mutating their account.
   */
  'configuration_required',
  'unknown_error',
] as const;
export type ProviderErrorClass = (typeof PROVIDER_ERROR_CLASSES)[number];

/** Which error classes are worth retrying automatically. */
export const RETRYABLE_ERROR_CLASSES: readonly ProviderErrorClass[] = [
  'rate_limited',
  'provider_unavailable',
  'timeout',
];

export const CONNECTION_STATUSES = [
  'pending',
  'connected',
  'degraded',
  'invalid_credentials',
  'disconnected',
] as const;
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

export const FRESHNESS_STATUSES = [
  'fresh',
  'delayed',
  'stale',
  'unknown',
  'error',
  /** The provider does not offer this data at all. */
  'unsupported',
  /** MART has not built this stream for this provider. */
  'not_implemented',
] as const;
export type FreshnessStatus = (typeof FRESHNESS_STATUSES)[number];

/**
 * Whether a stream can be fetched at all.
 *
 * A stream that returns nothing because MART never asked is not fresh, and
 * must never be recorded as if it were. Adapters say which case they are in;
 * the sync engine turns that into the matching freshness state.
 */
export const STREAM_SUPPORT = ['supported', 'unsupported', 'not_implemented'] as const;
export type StreamSupport = (typeof STREAM_SUPPORT)[number];

/** Entity-mapping vocabulary (Meta <-> MMP reconciliation). */
export const MAPPING_ENTITY_TYPES = ['campaign', 'ad_group', 'ad', 'creative'] as const;
export type MappingEntityType = (typeof MAPPING_ENTITY_TYPES)[number];

export const MAPPING_METHODS = [
  'stable_external_id',
  'tracking_parameter',
  'explicit_provider_mapping',
  /**
   * The attribution provider published a network identifier, and it resolved
   * against the network's own structure at ad-group level - the level Tenjin
   * publishes for Meta. Attribution is rolled up to the parent campaign.
   */
  'provider_remote_ad_group',
  /** The same, resolved at campaign level. */
  'provider_remote_campaign',
  /**
   * One provider's campaign name is embedded verbatim inside the other's, the
   * way an MMP wraps the network's name: `Creative_A (NETWORK_CAMPAIGN_NAME)`.
   * Deterministic - an exact match of an extracted substring, never a fuzzy
   * resemblance - but still a name, so it is never authoritative.
   */
  'provider_name_embedding',
  'name_fallback',
  'manual',
  /** No matching applies: organic attribution belongs to no paid campaign. */
  'not_applicable',
] as const;
export type MappingMethod = (typeof MAPPING_METHODS)[number];

export const MAPPING_STATUSES = [
  'matched_exact',
  'matched_confident',
  'matched_fallback',
  'ambiguous',
  'unmatched',
  'manually_verified',
  'rejected',
  /** Organic and other unpaid traffic: correctly unmapped, not a gap. */
  'not_applicable',
] as const;
export type MappingStatus = (typeof MAPPING_STATUSES)[number];

/** Statuses that MART treats as an established link between two entities. */
export const AUTHORITATIVE_MAPPING_STATUSES: readonly MappingStatus[] = [
  'matched_exact',
  'matched_confident',
  'manually_verified',
];

/**
 * Confidence at or above which a non-authoritative match is trusted for
 * operational reporting - a mapped CPI, say - while still being excluded from
 * authoritative coverage. Deterministic name-embedding matches sit here; a
 * bare shared name (0.5) does not.
 */
export const OPERATIONAL_MAPPING_CONFIDENCE = 0.9;

/** Governed-metric availability. `unavailable` always carries a reason. */
export const METRIC_AVAILABILITY = ['available', 'partial', 'stale', 'unavailable'] as const;
export type MetricAvailability = (typeof METRIC_AVAILABILITY)[number];

export type Iso8601 = string;
/** Calendar date in YYYY-MM-DD, always interpreted in the app's reporting timezone. */
export type IsoDate = string;

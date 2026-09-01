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

/**
 * Canonical channel taxonomy.
 *
 * The question "how much of this came from paid social" must not require
 * knowing which networks MART happens to be connected to. Channel is the axis
 * that survives adding TikTok next quarter; provider_key stays beside it and
 * answers the narrower question of who reported the row.
 *
 * Deliberately small. A taxonomy invented ahead of the providers that would
 * populate it is a taxonomy nobody can validate, so this covers the shapes MART
 * actually has and leaves room for the rest.
 */
export const CANONICAL_CHANNELS = [
  'paid_social',
  'paid_search',
  'paid_network',
  'organic',
  'unknown',
] as const;
export type CanonicalChannel = (typeof CANONICAL_CHANNELS)[number];

/**
 * What a provider is, as a channel.
 *
 * Declared per provider key, never inferred from a campaign name. Campaign
 * names are free text an operator can change at any time; deriving a business
 * dimension from them means the dimension changes when somebody renames a
 * campaign, which is not a property of the traffic.
 *
 * A provider MART does not yet classify is `unknown`, not a guess: downstream,
 * a guess is indistinguishable from knowledge.
 */
const PROVIDER_CHANNELS: Readonly<Record<string, CanonicalChannel>> = {
  meta_ads: 'paid_social',
  tiktok_ads: 'paid_social',
  google_ads: 'paid_search',
  unity_ads: 'paid_network',
  applovin: 'paid_network',
};

/**
 * How an MMP spells a network, mapped to MART's provider key.
 *
 * MMPs report the network that delivered the install - "facebook", "google
 * adwords" - and never MART's key. Keeping the aliases beside the channel table
 * means a new spelling is one line here rather than a second classification
 * rule somewhere else.
 */
const MEDIA_SOURCE_PROVIDERS: Readonly<Record<string, string>> = {
  facebook: 'meta_ads',
  facebook_ads: 'meta_ads',
  meta: 'meta_ads',
  meta_ads: 'meta_ads',
  tiktok: 'tiktok_ads',
  tiktok_ads: 'tiktok_ads',
  bytedance: 'tiktok_ads',
  google: 'google_ads',
  google_ads: 'google_ads',
  googleadwords_int: 'google_ads',
  adwords: 'google_ads',
  unity: 'unity_ads',
  unity_ads: 'unity_ads',
  applovin: 'applovin',
  applovin_int: 'applovin',
};

export function channelForProvider(providerKey: string | null | undefined): CanonicalChannel {
  if (!providerKey) return 'unknown';
  return PROVIDER_CHANNELS[providerKey] ?? 'unknown';
}

/**
 * The channel an attributed row belongs to.
 *
 * Organic is its own channel rather than an absent one: unpaid traffic is a
 * real acquisition source, and calling it `unknown` would put it in the same
 * bucket as a provider MART has simply not classified yet.
 */
export function channelForMediaSource(
  normalizedMediaSource: string | null | undefined,
): CanonicalChannel {
  const source = (normalizedMediaSource ?? 'organic').trim().toLowerCase();
  if (!source || source === 'organic') return 'organic';
  const providerKey = MEDIA_SOURCE_PROVIDERS[source];
  return providerKey ? channelForProvider(providerKey) : 'unknown';
}

/** Whether a channel is bought traffic. Organic is the only unpaid member. */
export function isPaidChannel(channel: CanonicalChannel): boolean {
  return channel !== 'organic' && channel !== 'unknown';
}

/**
 * The normalized media-source names that belong to a channel.
 *
 * Derived by inverting the alias table rather than written out again, so a
 * query filtering on channel and a metric labelled with one cannot disagree.
 */
export function mediaSourcesForChannel(channel: CanonicalChannel): string[] {
  if (channel === 'organic') return ['organic'];
  return Object.entries(MEDIA_SOURCE_PROVIDERS)
    .filter(([, providerKey]) => channelForProvider(providerKey) === channel)
    .map(([source]) => source)
    .sort();
}

/**
 * Canonical platform vocabulary.
 *
 * Deliberately tiny and stable. Providers spell the same device a dozen ways -
 * iphone, ipad, android_smartphone, android_tablet, mobile_web - and a
 * dimension that admits every spelling is not a dimension anyone can filter on.
 *
 * `unknown` is a real member, not a gap. A provider that does not report the
 * device still produced the row, and recording that as `unknown` rather than
 * NULL keeps "we asked and it does not say" distinct from "nobody looked" -
 * which is what lets a platform filter behave predictably across providers
 * instead of silently emptying one side of the dashboard.
 */
export const CANONICAL_PLATFORMS = ['ios', 'android', 'web', 'unknown'] as const;
export type CanonicalPlatform = (typeof CANONICAL_PLATFORMS)[number];

/**
 * Map a provider's platform spelling onto the canonical vocabulary.
 *
 * One definition for every adapter. Two normalizers had already diverged - one
 * passed unrecognised values through as free text, the other dropped them - so
 * the same device could be stored two ways depending on which stream carried
 * it, and neither could be filtered reliably.
 *
 * Anything unrecognised becomes `unknown` rather than being passed through.
 * Inventing a canonical value from a string MART does not understand is how a
 * filter starts silently excluding real rows.
 */
export function normalizePlatform(value: string | null | undefined): CanonicalPlatform {
  if (!value) return 'unknown';
  const lower = value.trim().toLowerCase();
  if (!lower) return 'unknown';
  // iPhone, iPad and iPod are all iOS. The test also catches "ios_app",
  // "iOS 17" and Meta's impression_device spellings.
  if (/(^|[^a-z])i(os|phone|pad|pod)/.test(lower) || lower.startsWith('ios')) return 'ios';
  if (lower.includes('android')) return 'android';
  if (lower.includes('web') || lower.includes('desktop') || lower.includes('browser')) return 'web';
  return 'unknown';
}

/**
 * Governed-metric availability.
 *
 * `partial`, `stale` and `blocked` all carry a reason, and so does
 * `unavailable`: a number the reader has to qualify is a different claim from a
 * plain one, and a missing number is a different claim again.
 *
 * `blocked` is not a softer `unavailable`. It says MART could compute the
 * metric arithmetically but refuses to, because doing so would state something
 * untrue - summing two currencies, dividing populations that do not correspond.
 * The distinction matters to anything reading these values downstream: an
 * unavailable metric may become available when data arrives, while a blocked
 * one needs the blocker resolved.
 */
export const METRIC_AVAILABILITY = [
  'available',
  'partial',
  'stale',
  'blocked',
  'unavailable',
] as const;
export type MetricAvailability = (typeof METRIC_AVAILABILITY)[number];

/**
 * Why a metric is blocked. Each names a condition MART can detect, never a
 * judgement call, so the same data always produces the same blocker.
 */
export const METRIC_BLOCKERS = [
  /** The stream this metric reads has not synced recently enough to be trusted. */
  'provider_stale',
  /** No provider is bound for one of the metric's sources. */
  'missing_provider',
  /** The mapping this metric depends on has candidates rather than an answer. */
  'ambiguous_mapping',
  /** The rows carry more than one currency; summing them would invent a number. */
  'mixed_currency',
  /** Numerator and denominator are expressed in grains that do not correspond. */
  'incompatible_grain',
  /** Too little of the population is mapped for the figure to describe the account. */
  'insufficient_coverage',
  /** The provider does not offer the capability this metric needs. */
  'unsupported_metric',
  /** The denominator is zero, absent, or below the metric's floor. */
  'missing_denominator',
] as const;
export type MetricBlocker = (typeof METRIC_BLOCKERS)[number];

/**
 * What a metric measures. Families group the Command Center and let the UI stop
 * carrying its own list of which metric belongs where.
 */
export const METRIC_FAMILIES = [
  'delivery',
  'attribution',
  'revenue',
  'efficiency',
  'coverage',
  'cohort',
] as const;
export type MetricFamily = (typeof METRIC_FAMILIES)[number];

/** The unit a value is expressed in, independent of how it is formatted. */
export const METRIC_UNITS = ['currency', 'count', 'ratio', 'percentage', 'duration'] as const;
export type MetricUnit = (typeof METRIC_UNITS)[number];

/** How a metric combines across rows - the thing a naive SUM gets wrong. */
export const METRIC_AGGREGATIONS = ['sum', 'ratio_of_sums', 'weighted', 'latest'] as const;
export type MetricAggregation = (typeof METRIC_AGGREGATIONS)[number];

/**
 * The semantic class of a metric, which decides how it may be read.
 *
 * An operational figure describes what happened in a reporting window. A cohort
 * figure describes a group of users followed over time, and the two must never
 * be compared as if they were the same measurement.
 */
export const METRIC_CLASSES = ['operational', 'cohort', 'mapping', 'structural'] as const;
export type MetricClass = (typeof METRIC_CLASSES)[number];

/**
 * The named populations a metric can be computed over.
 *
 * Naming them is the point. A ratio is only meaningful when its numerator and
 * denominator describe the same set of things, and the way that goes wrong is
 * never dramatic: two populations that are each individually correct get
 * divided, and the answer looks entirely plausible.
 */
export const METRIC_POPULATIONS = [
  /** Every attributed install, paid and organic alike. */
  'all_attribution',
  /** Attributed installs excluding organic. */
  'paid_attribution',
  /** Paid installs on an attribution campaign linked to a marketing campaign. */
  'mapped_paid_attribution',
  /** Mapped paid installs whose marketing campaign also delivered in this window. */
  'delivery_aligned_paid_attribution',
  /** Organic installs only. */
  'organic_attribution',
  /** Marketing campaigns with delivery inside the selected window. */
  'current_period_marketing',
  /** Every marketing entity MART knows, whenever it last delivered. */
  'all_structure',
  /** The metric is not a share of anything - a raw measure. */
  'not_applicable',
] as const;
export type MetricPopulation = (typeof METRIC_POPULATIONS)[number];

export type Iso8601 = string;
/** Calendar date in YYYY-MM-DD, always interpreted in the app's reporting timezone. */
export type IsoDate = string;

import type { IsoDate, ProviderKey } from './types.js';

/**
 * Canonical MART records.
 *
 * Provider adapters translate their own payloads into exactly these shapes.
 * Nothing downstream of an adapter - not the sync engine, not the metric layer,
 * not the dashboard - ever sees a provider-specific field name.
 */

export type CanonicalMarketingAccount = {
  externalAccountId: string;
  name: string | null;
  currency: string | null;
  timezone: string | null;
  status: string | null;
};

export type CanonicalCampaign = {
  externalCampaignId: string;
  externalAccountId: string | null;
  name: string | null;
  status: string | null;
  effectiveStatus: string | null;
  objective: string | null;
  dailyBudget: number | null;
  lifetimeBudget: number | null;
  currency: string | null;
  providerCreatedAt: string | null;
};

export type CanonicalAdGroup = {
  externalAdGroupId: string;
  externalCampaignId: string | null;
  name: string | null;
  status: string | null;
  effectiveStatus: string | null;
  dailyBudget: number | null;
  bidStrategy: string | null;
};

export type CanonicalCreative = {
  externalCreativeId: string;
  name: string | null;
  objectType: string | null;
  thumbnailUrl: string | null;
};

export type CanonicalAd = {
  externalAdId: string;
  externalAdGroupId: string | null;
  externalCampaignId: string | null;
  externalCreativeId: string | null;
  name: string | null;
  status: string | null;
  effectiveStatus: string | null;
};

/** Delivery fact. Always report_date grain. */
export type CanonicalMarketingDailyMetric = {
  reportDate: IsoDate;
  externalAccountId: string | null;
  externalCampaignId: string | null;
  externalAdGroupId: string | null;
  externalAdId: string | null;
  externalCreativeId: string | null;
  country: string | null;
  /** Canonical vocabulary: ios | android | web | unknown. Never free text. */
  platform: string | null;
  /**
   * What the provider actually called it - "iphone", "android_smartphone".
   * Kept beside the canonical value because normalization is lossy and the
   * original is what a support question is asked about. It is an attribute,
   * not a dimension: it never enters the identity hash.
   */
  nativePlatform?: string | null;
  currency: string;
  spend: number;
  impressions: number;
  clicks: number;
  linkClicks: number | null;
  outboundClicks: number | null;
  reach: number | null;
  frequency: number | null;
};

/** Attribution install fact. Always install_date (cohort anchor) grain. */
export type CanonicalAttributionDailyMetric = {
  installDate: IsoDate;
  mediaSource: string | null;
  externalCampaignId: string | null;
  campaignName: string | null;
  externalAdGroupId: string | null;
  adGroupName: string | null;
  externalAdId: string | null;
  adName: string | null;
  externalCreativeId: string | null;
  creativeName: string | null;
  country: string | null;
  platform: string | null;
  attributionCertainty: 'deterministic' | 'modeled' | 'unknown';
  attributedInstalls: number;
  attributedClicks: number | null;
  attributedImpressions: number | null;
};

/** In-app event fact. Always event_date grain. */
export type CanonicalAttributionEventMetric = {
  eventDate: IsoDate;
  eventName: string;
  mediaSource: string | null;
  externalCampaignId: string | null;
  campaignName: string | null;
  country: string | null;
  platform: string | null;
  eventCount: number;
  uniqueUsers: number | null;
};

/**
 * Revenue fact. The grain is declared per record because providers differ:
 * revenue recognized on the day it happened is not the same fact as cohort LTV.
 */
export type CanonicalAttributionRevenueMetric = {
  /**
   * Days since the install cohort anchor: 0 for D0, 7 for D7.
   *
   * Set only when grain is 'cohort_date', and required then - a cohort row
   * without an age cannot say which cohort day it describes, and two ages for
   * one cohort would otherwise share an identity and overwrite each other.
   */
  cohortAgeDays?: number | null;
  activityDate: IsoDate;
  grain: 'event_date' | 'install_date';
  revenueType: 'iap' | 'ad' | 'total' | 'subscription';
  mediaSource: string | null;
  externalCampaignId: string | null;
  campaignName: string | null;
  country: string | null;
  platform: string | null;
  currency: string;
  revenue: number;
};

/** Everything one adapter call produces, ready for persistence. */
export type CanonicalMarketingBatch = {
  accounts: CanonicalMarketingAccount[];
  campaigns: CanonicalCampaign[];
  adGroups: CanonicalAdGroup[];
  ads: CanonicalAd[];
  creatives: CanonicalCreative[];
  dailyMetrics: CanonicalMarketingDailyMetric[];
};

export type CanonicalAttributionBatch = {
  installs: CanonicalAttributionDailyMetric[];
  events: CanonicalAttributionEventMetric[];
  revenue: CanonicalAttributionRevenueMetric[];
};

export type ProviderScopedBatch<T> = {
  providerKey: ProviderKey;
  batch: T;
};

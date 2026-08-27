import { describe, expect, it } from 'vitest';
import {
  addDays,
  chunkDateRange,
  daysBetween,
  dimensionHash,
  eachDate,
  isIsoDate,
} from '@mart/shared';
import {
  computeFreshnessStatus,
  nameKey,
  worstFreshness,
  expectedFreshnessMinutes,
} from '@mart/integrations';
import { normalizeMediaSource, isOrganicSource } from '@mart/db';
import {
  checkMarketingBatch,
  checkAttributionBatch,
  checkRowCountAnomaly,
} from '@mart/integrations';

describe('date handling', () => {
  it('validates ISO dates strictly', () => {
    expect(isIsoDate('2026-08-20')).toBe(true);
    expect(isIsoDate('2026-02-30')).toBe(false);
    expect(isIsoDate('20-08-2026')).toBe(false);
    expect(isIsoDate('')).toBe(false);
  });

  it('chunks an inclusive range without gaps or overlaps', () => {
    const chunks = chunkDateRange('2026-08-01', '2026-08-10', 3);
    expect(chunks).toEqual([
      { from: '2026-08-01', to: '2026-08-03' },
      { from: '2026-08-04', to: '2026-08-06' },
      { from: '2026-08-07', to: '2026-08-09' },
      { from: '2026-08-10', to: '2026-08-10' },
    ]);
    const covered = chunks.flatMap((c) => eachDate(c.from, c.to));
    expect(covered).toHaveLength(10);
    expect(new Set(covered).size).toBe(10);
  });

  it('handles a single-day window and an inverted range', () => {
    expect(chunkDateRange('2026-08-01', '2026-08-01', 7)).toEqual([
      { from: '2026-08-01', to: '2026-08-01' },
    ]);
    expect(chunkDateRange('2026-08-05', '2026-08-01', 7)).toEqual([]);
  });

  it('adds days across month and year boundaries', () => {
    expect(addDays('2026-08-31', 1)).toBe('2026-09-01');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(daysBetween('2026-08-01', '2026-08-31')).toBe(30);
  });
});

describe('dimension hashing (fact idempotency)', () => {
  it('is stable regardless of key ordering', () => {
    const a = dimensionHash({ report_date: '2026-08-20', campaign: '900', country: 'US' });
    const b = dimensionHash({ country: 'US', campaign: '900', report_date: '2026-08-20' });
    expect(a).toBe(b);
  });

  it('treats null and undefined identically but distinctly from empty-adjacent values', () => {
    expect(dimensionHash({ a: null })).toBe(dimensionHash({ a: undefined }));
    expect(dimensionHash({ a: null })).toBe(dimensionHash({ a: '' }));
    expect(dimensionHash({ a: null })).not.toBe(dimensionHash({ a: '0' }));
  });

  it('separates facts that differ in any single dimension', () => {
    const base = { report_date: '2026-08-20', campaign: '900', country: 'US', platform: 'ios' };
    expect(dimensionHash(base)).not.toBe(dimensionHash({ ...base, country: 'GB' }));
    expect(dimensionHash(base)).not.toBe(dimensionHash({ ...base, report_date: '2026-08-21' }));
  });

  it('cannot be confused by delimiter injection in a dimension value', () => {
    // Two different tuples must not collide just because a value contains the
    // separator character.
    expect(dimensionHash({ a: 'x|b=y', b: '' })).not.toBe(dimensionHash({ a: 'x', b: 'y' }));
  });
});

describe('media source normalization', () => {
  it('maps provider synonyms onto one canonical form', () => {
    expect(normalizeMediaSource('Facebook Ads')).toBe('meta');
    expect(normalizeMediaSource('facebook')).toBe('meta');
    expect(normalizeMediaSource('meta_ads')).toBe('meta');
    expect(normalizeMediaSource('googleadwords_int')).toBe('google');
    expect(normalizeMediaSource('TikTok Ads')).toBe('tiktok');
  });

  it('passes unknown sources through lowercased rather than guessing', () => {
    expect(normalizeMediaSource('Some New Network')).toBe('somenewnetwork');
    expect(normalizeMediaSource(null)).toBeNull();
  });

  it('recognizes organic traffic', () => {
    expect(isOrganicSource('organic')).toBe(true);
    expect(isOrganicSource(null)).toBe(true);
    expect(isOrganicSource('facebook')).toBe(false);
  });
});

describe('name keys for reconciliation fallback', () => {
  it('ignores case, punctuation and spacing', () => {
    expect(nameKey('Summer Sale 2026')).toBe(nameKey('summer-sale-2026'));
    expect(nameKey('  US | iOS | Prospecting ')).toBe('us ios prospecting');
  });

  it('returns null for empty names so they never match each other', () => {
    expect(nameKey('')).toBeNull();
    expect(nameKey(null)).toBeNull();
    expect(nameKey('   ')).toBeNull();
  });
});

describe('freshness', () => {
  const now = new Date('2026-08-26T12:00:00Z');

  it('is fresh when the sync is recent and the data is current', () => {
    expect(
      computeFreshnessStatus({
        lastSuccessAt: new Date('2026-08-26T11:00:00Z'),
        latestProviderDataDate: '2026-08-26',
        expectedFreshnessMinutes: 180,
        now,
      }),
    ).toBe('fresh');
  });

  it('is delayed when the sync is overdue but not badly so', () => {
    expect(
      computeFreshnessStatus({
        lastSuccessAt: new Date('2026-08-26T07:00:00Z'),
        latestProviderDataDate: '2026-08-26',
        expectedFreshnessMinutes: 180,
        now,
      }),
    ).toBe('delayed');
  });

  it('is stale when the provider data itself is days behind, even after a successful sync', () => {
    expect(
      computeFreshnessStatus({
        lastSuccessAt: new Date('2026-08-26T11:59:00Z'),
        latestProviderDataDate: '2026-08-22',
        expectedFreshnessMinutes: 180,
        now,
      }),
    ).toBe('stale');
  });

  it('is unknown before the first success and error after a failure', () => {
    expect(
      computeFreshnessStatus({
        lastSuccessAt: null,
        latestProviderDataDate: null,
        expectedFreshnessMinutes: 180,
        now,
      }),
    ).toBe('unknown');
    expect(
      computeFreshnessStatus({
        lastSuccessAt: new Date(),
        latestProviderDataDate: '2026-08-26',
        expectedFreshnessMinutes: 180,
        hasError: true,
        now,
      }),
    ).toBe('error');
  });

  it('summarizes a set by its worst member', () => {
    expect(worstFreshness(['fresh', 'delayed', 'stale'])).toBe('stale');
    expect(worstFreshness(['fresh', 'fresh'])).toBe('fresh');
    expect(worstFreshness(['fresh', 'error'])).toBe('error');
  });

  it('expects different freshness per data type', () => {
    expect(expectedFreshnessMinutes('marketing_performance')).toBeLessThan(
      expectedFreshnessMinutes('marketing_structure'),
    );
  });
});

describe('deterministic data-quality checks', () => {
  const ctx = {
    organizationId: 'org',
    appId: 'app',
    connectionId: 'conn',
    syncRunId: 'run',
    windowStart: '2026-08-20',
    windowEnd: '2026-08-21',
  };

  const baseMetric = {
    reportDate: '2026-08-20',
    externalAccountId: 'act_1',
    externalCampaignId: '900',
    externalAdGroupId: null,
    externalAdId: null,
    externalCreativeId: null,
    country: 'US',
    platform: null,
    currency: 'USD',
    spend: 10,
    impressions: 1000,
    clicks: 20,
    linkClicks: null,
    outboundClicks: null,
    reach: null,
    frequency: null,
  };

  const emptyBatch = {
    accounts: [],
    campaigns: [],
    adGroups: [],
    ads: [],
    creatives: [],
    dailyMetrics: [] as (typeof baseMetric)[],
  };

  it('passes clean data', () => {
    expect(checkMarketingBatch(ctx, { ...emptyBatch, dailyMetrics: [baseMetric] })).toEqual([]);
  });

  it('flags dates outside the requested window', () => {
    const findings = checkMarketingBatch(ctx, {
      ...emptyBatch,
      dailyMetrics: [{ ...baseMetric, reportDate: '2026-07-01' }],
    });
    expect(findings.map((f) => f.checkKey)).toContain('marketing.date_outside_window');
  });

  it('flags implausible click-to-impression ratios and spend without delivery', () => {
    const findings = checkMarketingBatch(ctx, {
      ...emptyBatch,
      dailyMetrics: [
        { ...baseMetric, clicks: 5000 },
        { ...baseMetric, impressions: 0, clicks: 0, spend: 25 },
      ],
    });
    const keys = findings.map((f) => f.checkKey);
    expect(keys).toContain('marketing.clicks_exceed_impressions');
    expect(keys).toContain('marketing.spend_without_delivery');
  });

  it('flags a missing campaign id as an error, because it breaks reconciliation', () => {
    const findings = checkMarketingBatch(ctx, {
      ...emptyBatch,
      dailyMetrics: [{ ...baseMetric, externalCampaignId: null }],
    });
    const finding = findings.find((f) => f.checkKey === 'marketing.missing_campaign_id');
    expect(finding?.severity).toBe('error');
  });

  it('flags duplicate dimension tuples inside one window', () => {
    const findings = checkMarketingBatch(ctx, {
      ...emptyBatch,
      dailyMetrics: [baseMetric, { ...baseMetric }],
    });
    expect(findings.map((f) => f.checkKey)).toContain('marketing.duplicate_dimension_tuple');
  });

  it('flags attribution rows without campaign ids as a reconciliation warning', () => {
    const findings = checkAttributionBatch(ctx, {
      installs: [
        {
          installDate: '2026-08-20',
          mediaSource: 'facebook',
          externalCampaignId: null,
          campaignName: 'Summer',
          externalAdGroupId: null,
          adGroupName: null,
          externalAdId: null,
          adName: null,
          externalCreativeId: null,
          creativeName: null,
          country: 'US',
          platform: 'ios',
          attributionCertainty: 'unknown' as const,
          attributedInstalls: 10,
          attributedClicks: null,
          attributedImpressions: null,
        },
      ],
      events: [],
      revenue: [],
    });
    expect(findings.map((f) => f.checkKey)).toContain('attribution.missing_campaign_id');
  });

  it('flags order-of-magnitude row-count changes only', () => {
    expect(checkRowCountAnomaly(ctx, 100, 90)).toEqual([]);
    expect(checkRowCountAnomaly(ctx, 5, 500)).toHaveLength(1);
    expect(checkRowCountAnomaly(ctx, 100, null)).toEqual([]);
  });
});

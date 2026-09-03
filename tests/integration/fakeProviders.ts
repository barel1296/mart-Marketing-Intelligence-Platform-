import type { CanonicalAttributionBatch, CanonicalMarketingBatch, IsoDate } from '@mart/shared';
import { ProviderError, normalizePlatform } from '@mart/shared';
import {
  clearProviderOverrides,
  declare,
  setProviderOverride,
  type AttributionCampaignRef,
  type AttributionProvider,
  type CapabilityDeclaration,
  type ConnectionHealth,
  type MarketingNetworkProvider,
  type ProviderAccount,
  type SyncParams,
  type SyncResult,
} from '@mart/integrations';

/**
 * Deterministic in-memory providers.
 *
 * These stand in for the real adapters so integration tests can exercise the
 * sync engine, persistence, reconciliation and dashboard end to end without a
 * network. The real adapters' request construction and normalization are
 * covered by unit tests against recorded payloads.
 */
export type FakeControls = {
  marketingRows: Array<{
    reportDate: IsoDate;
    campaignId: string;
    campaignName: string;
    spend: number;
    impressions: number;
    clicks: number;
    country?: string | null;
    platform?: string | null;
  }>;
  attributionRows: Array<{
    installDate: IsoDate;
    campaignId: string | null;
    campaignName: string;
    installs: number;
    country?: string | null;
    platform?: string | null;
    revenue?: number;
    /** Defaults to the paid network. Set 'Organic' to exercise unpaid traffic. */
    mediaSource?: string;
    /**
     * Cumulative cohort revenue for this install cohort, by component and
     * age, the way an MMP's `<metric>_Nd` columns carry it. Emitted at
     * cohort_date grain beside the event-date row, never instead of it.
     */
    cohort?: Partial<Record<'iap' | 'ad', Partial<Record<1 | 7, number>>>>;
    /**
     * Revenue currency for this row. Defaults to USD; a second currency is
     * how the mixed-currency gate is exercised end to end.
     */
    currency?: string;
  }>;
  /** Windows (from..to) that should fail, to exercise partial completion. */
  failWindows: Set<string>;
  failureClass: 'invalid_request' | 'rate_limited' | 'authentication_error';
  /** Count of provider calls, to assert idempotent re-runs actually re-fetch. */
  calls: { structure: number; performance: number; installs: number; revenue: number };
  attributionCapabilities: Partial<Record<string, boolean>>;
  /** The MMP's campaign directory, carrying the ad network's campaign id. */
  attributionCampaigns: AttributionCampaignRef[];
  /** Marketing ad groups, so remote ids can resolve below campaign level. */
  marketingAdGroups: Array<{
    externalAdGroupId: string;
    externalCampaignId: string;
    name: string;
  }>;
};

export const controls: FakeControls = {
  marketingRows: [],
  attributionRows: [],
  failWindows: new Set(),
  failureClass: 'invalid_request',
  calls: { structure: 0, performance: 0, installs: 0, revenue: 0 },
  attributionCampaigns: [],
  marketingAdGroups: [],
  attributionCapabilities: {},
};

export function resetControls(): void {
  controls.marketingRows = [];
  controls.attributionRows = [];
  controls.failWindows = new Set();
  controls.failureClass = 'invalid_request';
  controls.calls = { structure: 0, performance: 0, installs: 0, revenue: 0 };
  controls.attributionCapabilities = {};
  controls.attributionCampaigns = [];
  controls.marketingAdGroups = [];
}

function windowKey(params: SyncParams): string {
  return `${params.from}..${params.to}`;
}

function maybeFail(params: SyncParams): void {
  if (!controls.failWindows.has(windowKey(params))) return;
  throw new ProviderError({
    provider: 'fake',
    errorClass: controls.failureClass,
    message: `injected ${controls.failureClass} for ${windowKey(params)}`,
    userMessage: 'Injected failure',
    retryable: controls.failureClass === 'rate_limited',
    httpStatus: 400,
    // What a real adapter attaches: the provider's sanitized words.
    context: { bodyPreview: '{"error":{"message":"(#100) injected","code":100}}' },
  });
}

function inWindow(date: IsoDate, params: SyncParams): boolean {
  return date >= params.from && date <= params.to;
}

class FakeMetaProvider implements MarketingNetworkProvider {
  readonly providerKey = 'meta_ads' as const;
  readonly category = 'marketing_network' as const;

  async validateConnection(): Promise<ConnectionHealth> {
    return {
      ok: true,
      status: 'connected',
      message: 'Fake Meta connection is valid.',
      checkedAt: new Date().toISOString(),
    };
  }

  async listAccounts(): Promise<ProviderAccount[]> {
    return [
      {
        externalAccountId: 'act_1000',
        name: 'Fake Ad Account',
        accountType: 'ad_account',
        currency: 'USD',
        timezone: 'UTC',
      },
    ];
  }

  async getCapabilities(): Promise<CapabilityDeclaration[]> {
    return declare({
      cost_data: true,
      delivery_metrics: true,
      campaign: true,
      campaign_id: true,
      impressions: true,
      clicks: true,
      link_clicks: true,
      country: true,
    });
  }

  async syncStructure(params: SyncParams): Promise<SyncResult<CanonicalMarketingBatch>> {
    controls.calls.structure += 1;
    maybeFail(params);
    const campaigns = new Map<string, string>();
    for (const row of controls.marketingRows) campaigns.set(row.campaignId, row.campaignName);
    await params.onRawPage?.({
      pageNumber: 1,
      payload: { campaigns: [...campaigns.keys()] },
      recordCount: campaigns.size,
      schemaVersion: 'fake-v1',
      windowStart: params.from,
      windowEnd: params.to,
    });
    return {
      batch: {
        accounts: [
          {
            externalAccountId: params.externalAccountId,
            name: 'Fake Ad Account',
            currency: 'USD',
            timezone: 'UTC',
            status: 'active',
          },
        ],
        campaigns: [...campaigns.entries()].map(([id, name]) => ({
          externalCampaignId: id,
          externalAccountId: params.externalAccountId,
          name,
          status: 'ACTIVE',
          effectiveStatus: 'ACTIVE',
          objective: 'APP_INSTALLS',
          dailyBudget: 100,
          lifetimeBudget: null,
          currency: 'USD',
          providerCreatedAt: null,
        })),
        adGroups: controls.marketingAdGroups.map((group) => ({
          externalAdGroupId: group.externalAdGroupId,
          externalCampaignId: group.externalCampaignId,
          name: group.name,
          status: 'ACTIVE',
          effectiveStatus: 'ACTIVE',
          dailyBudget: null,
          bidStrategy: null,
        })),
        ads: [],
        creatives: [],
        dailyMetrics: [],
      },
      pagesFetched: 1,
      rowsFetched: campaigns.size,
      rowsRejected: 0,
      warnings: [],
      latestDataDate: null,
    };
  }

  async syncPerformance(params: SyncParams): Promise<SyncResult<CanonicalMarketingBatch>> {
    controls.calls.performance += 1;
    maybeFail(params);
    const rows = controls.marketingRows.filter((r) => inWindow(r.reportDate, params));
    await params.onRawPage?.({
      pageNumber: 1,
      payload: { rows },
      recordCount: rows.length,
      schemaVersion: 'fake-v1',
      windowStart: params.from,
      windowEnd: params.to,
    });
    let latest: IsoDate | null = null;
    const dailyMetrics = rows.map((row) => {
      if (!latest || row.reportDate > latest) latest = row.reportDate;
      return {
        reportDate: row.reportDate,
        externalAccountId: params.externalAccountId,
        externalCampaignId: row.campaignId,
        externalAdGroupId: null,
        externalAdId: null,
        externalCreativeId: null,
        country: row.country ?? null,
        platform: normalizePlatform(row.platform),
        currency: 'USD',
        spend: row.spend,
        impressions: row.impressions,
        clicks: row.clicks,
        linkClicks: Math.floor(row.clicks * 0.8),
        outboundClicks: null,
        reach: null,
        frequency: null,
      };
    });
    return {
      batch: { accounts: [], campaigns: [], adGroups: [], ads: [], creatives: [], dailyMetrics },
      pagesFetched: 1,
      rowsFetched: rows.length,
      rowsRejected: 0,
      warnings: [],
      latestDataDate: latest,
    };
  }
}

class FakeAttributionProvider implements AttributionProvider {
  readonly category = 'attribution_mmp' as const;

  constructor(readonly providerKey: 'appsflyer' | 'tenjin') {}

  async validateConnection(): Promise<ConnectionHealth> {
    return {
      ok: true,
      status: 'connected',
      message: `Fake ${this.providerKey} connection is valid.`,
      checkedAt: new Date().toISOString(),
    };
  }

  async listApps(): Promise<ProviderAccount[]> {
    return [
      {
        externalAccountId: 'id123456',
        name: 'Fake MMP App',
        accountType: 'mmp_app',
        currency: 'USD',
      },
    ];
  }

  async getCapabilities(): Promise<CapabilityDeclaration[]> {
    return declare({
      installs: true,
      attributed_installs: true,
      attributed_revenue: true,
      revenue: true,
      media_source: true,
      campaign: true,
      country: true,
      // Overridable so a test can simulate a provider without campaign IDs.
      campaign_id: controls.attributionCapabilities['campaign_id'] ?? true,
      // The fake carries every cohort component at both ages, the way a
      // fully configured saved report would. A test that wants to see a
      // missing component overrides the specific key.
      cohort_reporting: true,
      cohort_iap_revenue_d1: true,
      cohort_iap_revenue_d7: true,
      cohort_ad_revenue_d1: true,
      cohort_ad_revenue_d7: true,
      cohort_total_revenue_d1: true,
      cohort_total_revenue_d7: true,
      ...controls.attributionCapabilities,
    });
  }

  async syncInstalls(params: SyncParams): Promise<SyncResult<CanonicalAttributionBatch>> {
    controls.calls.installs += 1;
    maybeFail(params);
    const rows = controls.attributionRows.filter((r) => inWindow(r.installDate, params));
    await params.onRawPage?.({
      pageNumber: 1,
      payload: { rows },
      recordCount: rows.length,
      schemaVersion: 'fake-v1',
      windowStart: params.from,
      windowEnd: params.to,
    });
    let latest: IsoDate | null = null;
    const installs = rows.map((row) => {
      if (!latest || row.installDate > latest) latest = row.installDate;
      return {
        installDate: row.installDate,
        mediaSource: row.mediaSource ?? 'facebook',
        externalCampaignId: row.campaignId,
        campaignName: row.campaignName,
        externalAdGroupId: null,
        adGroupName: null,
        externalAdId: null,
        adName: null,
        externalCreativeId: null,
        creativeName: null,
        country: row.country ?? null,
        platform: normalizePlatform(row.platform ?? 'ios'),
        attributionCertainty: 'deterministic' as const,
        attributedInstalls: row.installs,
        attributedClicks: null,
        attributedImpressions: null,
      };
    });
    return {
      batch: { installs, events: [], revenue: [] },
      pagesFetched: 1,
      rowsFetched: rows.length,
      rowsRejected: 0,
      warnings: [],
      latestDataDate: latest,
    };
  }

  async listCampaigns(): Promise<AttributionCampaignRef[]> {
    return controls.attributionCampaigns;
  }

  /** Mirrors the real Tenjin adapter: no event source, and it says so. */
  async syncEvents(): Promise<SyncResult<CanonicalAttributionBatch>> {
    return {
      batch: { installs: [], events: [], revenue: [] },
      pagesFetched: 0,
      rowsFetched: 0,
      rowsRejected: 0,
      warnings: ['This fake provider implements no in-app event source.'],
      latestDataDate: null,
      support: 'not_implemented',
    };
  }

  async syncRevenue(params: SyncParams): Promise<SyncResult<CanonicalAttributionBatch>> {
    controls.calls.revenue += 1;
    maybeFail(params);
    const rows = controls.attributionRows.filter(
      (r) => inWindow(r.installDate, params) && (typeof r.revenue === 'number' || r.cohort),
    );
    const revenue: CanonicalAttributionBatch['revenue'] = [];
    for (const row of rows) {
      const dims = {
        mediaSource: row.mediaSource ?? 'facebook',
        externalCampaignId: row.campaignId,
        campaignName: row.campaignName,
        country: row.country ?? null,
        platform: normalizePlatform(row.platform ?? 'ios'),
        currency: row.currency ?? 'USD',
      };
      if (typeof row.revenue === 'number') {
        revenue.push({
          activityDate: row.installDate,
          // Event-date grain: revenue on the day it happened, never cohort LTV.
          grain: 'event_date',
          revenueType: 'iap',
          ...dims,
          revenue: row.revenue,
        });
      }
      // Cohort grain: the same install day, observed N days later. A distinct
      // fact with its own age, emitted beside the event-date row.
      for (const revenueType of ['iap', 'ad'] as const) {
        for (const age of [1, 7] as const) {
          const value = row.cohort?.[revenueType]?.[age];
          if (typeof value !== 'number') continue;
          revenue.push({
            activityDate: row.installDate,
            grain: 'cohort_date',
            cohortAgeDays: age,
            revenueType,
            ...dims,
            revenue: value,
          });
        }
      }
    }
    return {
      batch: { installs: [], events: [], revenue },
      pagesFetched: 1,
      rowsFetched: rows.length,
      rowsRejected: 0,
      warnings: [],
      latestDataDate: rows.at(-1)?.installDate ?? null,
    };
  }
}

export function installFakeProviders(): void {
  setProviderOverride('meta_ads', () => new FakeMetaProvider());
  setProviderOverride('appsflyer', () => new FakeAttributionProvider('appsflyer'));
  setProviderOverride('tenjin', () => new FakeAttributionProvider('tenjin'));
}

export function removeFakeProviders(): void {
  clearProviderOverrides();
}

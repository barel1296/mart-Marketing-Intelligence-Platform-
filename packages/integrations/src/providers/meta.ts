import type {
  CanonicalAd,
  CanonicalAdGroup,
  CanonicalCampaign,
  CanonicalCreative,
  CanonicalMarketingBatch,
  CanonicalMarketingDailyMetric,
  IsoDate,
} from '@mart/shared';
import { ProviderError, isProviderError } from '@mart/shared';
import { getLogger } from '@mart/observability';
import { ProviderHttpClient, userMessageFor } from '../http.js';
import { declare, type CapabilityDeclaration } from '../capabilities.js';
import {
  emptyMarketingBatch,
  type ConnectionHealth,
  type MarketingNetworkProvider,
  type ProviderAccount,
  type SyncParams,
  type SyncResult,
} from '../types.js';
import type { MetaAdsCredentials } from '../credentials.js';

/**
 * Meta Ads (Marketing API) read-only adapter.
 *
 * Verified against the Graph API contract for v21.0. MART issues GET requests
 * only: no campaign mutation endpoint is reachable from this adapter, by
 * construction rather than by convention.
 *
 * Two Meta-specific realities are handled here and nowhere else:
 *  - Insights are restated for days after first reporting, so the sync engine
 *    always re-reads a recent window and upserts.
 *  - Breakdown availability varies by account and campaign type, so the country
 *    breakdown is probed and degraded gracefully rather than assumed.
 */
export type MetaProviderOptions = {
  credentials: MetaAdsCredentials;
  baseUrl: string;
  apiVersion: string;
  http?: ProviderHttpClient;
};

type GraphPaging = { paging?: { next?: string; cursors?: { after?: string } } };
type GraphList<T> = { data?: T[] } & GraphPaging;

type MetaAdAccount = {
  id: string;
  account_id?: string;
  name?: string;
  currency?: string;
  timezone_name?: string;
  account_status?: number;
};

type MetaCampaign = {
  id: string;
  name?: string;
  status?: string;
  effective_status?: string;
  objective?: string;
  daily_budget?: string;
  lifetime_budget?: string;
  created_time?: string;
  account_id?: string;
};

type MetaAdSet = {
  id: string;
  name?: string;
  campaign_id?: string;
  status?: string;
  effective_status?: string;
  daily_budget?: string;
  bid_strategy?: string;
};

type MetaAd = {
  id: string;
  name?: string;
  adset_id?: string;
  campaign_id?: string;
  status?: string;
  effective_status?: string;
  creative?: { id?: string; name?: string; object_type?: string; thumbnail_url?: string };
};

type MetaInsightRow = {
  date_start?: string;
  date_stop?: string;
  account_id?: string;
  account_name?: string;
  account_currency?: string;
  campaign_id?: string;
  campaign_name?: string;
  adset_id?: string;
  adset_name?: string;
  ad_id?: string;
  ad_name?: string;
  spend?: string;
  impressions?: string;
  clicks?: string;
  inline_link_clicks?: string;
  outbound_clicks?: Array<{ action_type?: string; value?: string }>;
  reach?: string;
  frequency?: string;
  country?: string;
};

const CAMPAIGN_FIELDS =
  'id,name,status,effective_status,objective,daily_budget,lifetime_budget,created_time,account_id';
const ADSET_FIELDS = 'id,name,campaign_id,status,effective_status,daily_budget,bid_strategy';
const AD_FIELDS =
  'id,name,adset_id,campaign_id,status,effective_status,creative{id,name,object_type,thumbnail_url}';
const INSIGHT_FIELDS = [
  'account_id',
  'account_name',
  'account_currency',
  'campaign_id',
  'campaign_name',
  'adset_id',
  'adset_name',
  'ad_id',
  'ad_name',
  'spend',
  'impressions',
  'clicks',
  'inline_link_clicks',
  'outbound_clicks',
  'reach',
  'frequency',
].join(',');

const PAGE_LIMIT = 200;
const MAX_PAGES = 200;

export class MetaAdsProvider implements MarketingNetworkProvider {
  readonly providerKey = 'meta_ads' as const;
  readonly category = 'marketing_network' as const;

  private readonly http: ProviderHttpClient;
  private readonly baseUrl: string;
  private readonly apiVersion: string;
  private readonly accessToken: string;

  constructor(options: MetaProviderOptions) {
    this.accessToken = options.credentials.accessToken;
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.apiVersion = options.apiVersion;
    this.http =
      options.http ??
      new ProviderHttpClient({ provider: 'meta_ads', minIntervalMs: 120, maxAttempts: 3 });
  }

  private url(path: string): string {
    return `${this.baseUrl}/${this.apiVersion}/${path.replace(/^\/+/, '')}`;
  }

  /** Bearer auth keeps the token out of URLs, logs and provider error echoes. */
  private headers(): Record<string, string> {
    return { authorization: `Bearer ${this.accessToken}` };
  }

  private async getPage<T>(
    url: string,
    query?: Record<string, string | number | undefined>,
  ): Promise<GraphList<T>> {
    const response = await this.http.request<GraphList<T>>({
      url,
      ...(query ? { query } : {}),
      headers: this.headers(),
      responseType: 'json',
    });
    const body = response.body;
    if (!body || typeof body !== 'object' || !Array.isArray(body.data)) {
      throw new ProviderError({
        provider: 'meta_ads',
        errorClass: 'schema_change',
        message: 'Meta response did not contain a data array',
        userMessage: userMessageFor('meta_ads', 'schema_change'),
      });
    }
    return body;
  }

  /** Follow Graph cursor pagination, bounded so a broken cursor cannot loop. */
  private async *paginate<T>(
    initialUrl: string,
    query: Record<string, string | number | undefined>,
  ): AsyncGenerator<{ rows: T[]; pageNumber: number; raw: unknown }> {
    let url = initialUrl;
    let nextQuery: Record<string, string | number | undefined> | undefined = query;
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const body: GraphList<T> = await this.getPage<T>(url, nextQuery);
      yield { rows: body.data ?? [], pageNumber: page, raw: body };
      const next = body.paging?.next;
      if (!next) return;
      url = next;
      // `next` already carries every parameter; re-sending them would duplicate.
      nextQuery = undefined;
    }
    throw new ProviderError({
      provider: 'meta_ads',
      errorClass: 'pagination_failure',
      message: `Meta pagination exceeded ${MAX_PAGES} pages`,
      userMessage: 'The Meta report was larger than MART will page through in one run.',
    });
  }

  async validateConnection(): Promise<ConnectionHealth> {
    const checkedAt = new Date().toISOString();
    try {
      const body = await this.getPage<MetaAdAccount>(this.url('me/adaccounts'), {
        fields: 'id,name',
        limit: 1,
      });
      return {
        ok: true,
        status: 'connected',
        message: 'Meta Ads credential is valid and can list ad accounts.',
        checkedAt,
        details: { adAccountsVisible: (body.data ?? []).length > 0 },
      };
    } catch (error) {
      return toHealth(error, checkedAt);
    }
  }

  async listAccounts(): Promise<ProviderAccount[]> {
    const accounts: ProviderAccount[] = [];
    for await (const page of this.paginate<MetaAdAccount>(this.url('me/adaccounts'), {
      fields: 'id,account_id,name,currency,timezone_name,account_status',
      limit: PAGE_LIMIT,
    })) {
      for (const account of page.rows) {
        accounts.push({
          externalAccountId: account.id,
          name: account.name ?? account.id,
          accountType: 'ad_account',
          currency: account.currency ?? null,
          timezone: account.timezone_name ?? null,
          status: account.account_status === 1 ? 'active' : String(account.account_status ?? ''),
          metadata: { accountNumber: account.account_id ?? null },
        });
      }
    }
    return accounts;
  }

  /**
   * Confirm the token can actually read this specific ad account.
   *
   * Listing accounts proves the token works; it does not prove read access to
   * the account the user picked, which can differ when permissions are scoped
   * per account.
   */
  async validateAccount(externalAccountId: string): Promise<ConnectionHealth> {
    const checkedAt = new Date().toISOString();
    try {
      await this.getPage<MetaCampaign>(this.url(`${externalAccountId}/campaigns`), {
        fields: 'id,name',
        limit: 1,
      });
      return {
        ok: true,
        status: 'connected',
        message: `Meta ad account ${externalAccountId} is readable with the stored token.`,
        checkedAt,
      };
    } catch (error) {
      return toHealth(error, checkedAt);
    }
  }

  /**
   * Capabilities.
   *
   * Everything except the country breakdown is a documented property of the
   * Marketing API. The breakdown is probed against the live account because
   * availability varies by account and campaign type.
   */
  async getCapabilities(externalAccountId?: string): Promise<CapabilityDeclaration[]> {
    const base = declare(
      {
        cost_data: true,
        delivery_metrics: true,
        campaign: true,
        campaign_id: true,
        ad_group: true,
        ad_group_id: true,
        ad: true,
        ad_id: true,
        creative: true,
        creative_id: true,
        platform: false,
        impressions: true,
        clicks: true,
        link_clicks: true,
        reach_frequency: true,
        // A marketing network reports delivery, never attribution.
        installs: false,
        events: false,
        revenue: false,
        attributed_installs: false,
        attributed_revenue: false,
        raw_data: false,
        cohort_reporting: false,
        skan_data: false,
      },
      'declared',
      { note: 'Meta Marketing API reports delivery at report-date grain only.' },
    );

    if (!externalAccountId) return base;

    const probe = await this.probeCountryBreakdown(externalAccountId);
    return [
      ...base,
      {
        key: 'country',
        supported: probe.supported,
        discoveryMethod: 'probed',
        detail: probe.detail,
      },
    ];
  }

  private async probeCountryBreakdown(
    externalAccountId: string,
  ): Promise<{ supported: boolean; detail: Record<string, unknown> }> {
    const today = new Date().toISOString().slice(0, 10);
    try {
      await this.getPage<MetaInsightRow>(this.url(`${externalAccountId}/insights`), {
        level: 'campaign',
        fields: 'campaign_id,impressions',
        breakdowns: 'country',
        time_range: JSON.stringify({ since: today, until: today }),
        limit: 1,
      });
      return { supported: true, detail: { probedAt: new Date().toISOString() } };
    } catch (error) {
      const errorClass = isProviderError(error) ? error.errorClass : 'unknown_error';
      // Only a rejected request proves absence; an outage proves nothing.
      if (errorClass === 'invalid_request') {
        return {
          supported: false,
          detail: {
            reason: 'Account rejected the country breakdown',
            probedAt: new Date().toISOString(),
          },
        };
      }
      throw error;
    }
  }

  async syncStructure(params: SyncParams): Promise<SyncResult<CanonicalMarketingBatch>> {
    const batch = emptyMarketingBatch();
    const warnings: string[] = [];
    let pagesFetched = 0;
    let rowsFetched = 0;
    const account = params.externalAccountId;

    const campaignsByAccount = new Map<string, string>();

    for await (const page of this.paginate<MetaCampaign>(this.url(`${account}/campaigns`), {
      fields: CAMPAIGN_FIELDS,
      limit: PAGE_LIMIT,
    })) {
      pagesFetched += 1;
      rowsFetched += page.rows.length;
      await params.onRawPage?.({
        pageNumber: pagesFetched,
        payload: page.raw,
        recordCount: page.rows.length,
        schemaVersion: this.apiVersion,
        windowStart: null,
        windowEnd: null,
      });
      for (const campaign of page.rows) {
        campaignsByAccount.set(campaign.id, campaign.account_id ?? account);
        batch.campaigns.push(toCanonicalCampaign(campaign, account));
      }
    }

    for await (const page of this.paginate<MetaAdSet>(this.url(`${account}/adsets`), {
      fields: ADSET_FIELDS,
      limit: PAGE_LIMIT,
    })) {
      pagesFetched += 1;
      rowsFetched += page.rows.length;
      await params.onRawPage?.({
        pageNumber: pagesFetched,
        payload: page.raw,
        recordCount: page.rows.length,
        schemaVersion: this.apiVersion,
        windowStart: null,
        windowEnd: null,
      });
      for (const adSet of page.rows) batch.adGroups.push(toCanonicalAdGroup(adSet));
    }

    const seenCreatives = new Set<string>();
    for await (const page of this.paginate<MetaAd>(this.url(`${account}/ads`), {
      fields: AD_FIELDS,
      limit: PAGE_LIMIT,
    })) {
      pagesFetched += 1;
      rowsFetched += page.rows.length;
      await params.onRawPage?.({
        pageNumber: pagesFetched,
        payload: page.raw,
        recordCount: page.rows.length,
        schemaVersion: this.apiVersion,
        windowStart: null,
        windowEnd: null,
      });
      for (const ad of page.rows) {
        const { canonicalAd, creative } = toCanonicalAd(ad);
        batch.ads.push(canonicalAd);
        if (creative && !seenCreatives.has(creative.externalCreativeId)) {
          seenCreatives.add(creative.externalCreativeId);
          batch.creatives.push(creative);
        }
      }
    }

    batch.accounts.push({
      externalAccountId: account,
      name: account,
      currency: params.currency,
      timezone: params.timezone,
      status: null,
    });

    return { batch, pagesFetched, rowsFetched, rowsRejected: 0, warnings, latestDataDate: null };
  }

  async syncPerformance(params: SyncParams): Promise<SyncResult<CanonicalMarketingBatch>> {
    const attempt = await this.fetchInsights(params, true).catch(async (error) => {
      // Degrade to no breakdown rather than failing the window outright.
      if (isProviderError(error) && error.errorClass === 'invalid_request') {
        getLogger().warn(
          { provider: 'meta_ads', account: params.externalAccountId },
          'country breakdown rejected; retrying without breakdown',
        );
        const fallback = await this.fetchInsights(params, false);
        fallback.warnings.push(
          'Meta rejected the country breakdown for this account; delivery data was imported without a country dimension.',
        );
        return fallback;
      }
      throw error;
    });
    return attempt;
  }

  private async fetchInsights(
    params: SyncParams,
    withCountry: boolean,
  ): Promise<SyncResult<CanonicalMarketingBatch>> {
    const batch = emptyMarketingBatch();
    const warnings: string[] = [];
    let pagesFetched = 0;
    let rowsFetched = 0;
    let rowsRejected = 0;
    let latestDataDate: IsoDate | null = null;

    const query: Record<string, string | number | undefined> = {
      level: 'campaign',
      fields: INSIGHT_FIELDS,
      time_range: JSON.stringify({ since: params.from, until: params.to }),
      time_increment: 1,
      limit: PAGE_LIMIT,
      ...(withCountry ? { breakdowns: 'country' } : {}),
    };

    for await (const page of this.paginate<MetaInsightRow>(
      this.url(`${params.externalAccountId}/insights`),
      query,
    )) {
      pagesFetched += 1;
      rowsFetched += page.rows.length;
      await params.onRawPage?.({
        pageNumber: pagesFetched,
        payload: page.raw,
        recordCount: page.rows.length,
        schemaVersion: this.apiVersion,
        windowStart: params.from,
        windowEnd: params.to,
      });

      for (const row of page.rows) {
        const metric = toCanonicalMetric(row, params);
        if (!metric) {
          rowsRejected += 1;
          continue;
        }
        batch.dailyMetrics.push(metric);
        if (!latestDataDate || metric.reportDate > latestDataDate)
          latestDataDate = metric.reportDate;
      }
    }

    if (rowsRejected > 0) {
      warnings.push(
        `${rowsRejected} Meta insight rows were rejected (missing date or campaign id).`,
      );
    }
    return { batch, pagesFetched, rowsFetched, rowsRejected, warnings, latestDataDate };
  }
}

// ------------------------------------------------------------ normalizers ---

export function toCanonicalCampaign(campaign: MetaCampaign, accountId: string): CanonicalCampaign {
  return {
    externalCampaignId: campaign.id,
    externalAccountId: campaign.account_id ? `act_${campaign.account_id}` : accountId,
    name: campaign.name ?? null,
    status: campaign.status ?? null,
    effectiveStatus: campaign.effective_status ?? null,
    objective: campaign.objective ?? null,
    // Meta returns budgets as minor units in the account currency.
    dailyBudget: campaign.daily_budget ? Number(campaign.daily_budget) / 100 : null,
    lifetimeBudget: campaign.lifetime_budget ? Number(campaign.lifetime_budget) / 100 : null,
    currency: null,
    providerCreatedAt: campaign.created_time ?? null,
  };
}

export function toCanonicalAdGroup(adSet: MetaAdSet): CanonicalAdGroup {
  return {
    externalAdGroupId: adSet.id,
    externalCampaignId: adSet.campaign_id ?? null,
    name: adSet.name ?? null,
    status: adSet.status ?? null,
    effectiveStatus: adSet.effective_status ?? null,
    dailyBudget: adSet.daily_budget ? Number(adSet.daily_budget) / 100 : null,
    bidStrategy: adSet.bid_strategy ?? null,
  };
}

export function toCanonicalAd(ad: MetaAd): {
  canonicalAd: CanonicalAd;
  creative: CanonicalCreative | null;
} {
  const creativeId = ad.creative?.id ?? null;
  return {
    canonicalAd: {
      externalAdId: ad.id,
      externalAdGroupId: ad.adset_id ?? null,
      externalCampaignId: ad.campaign_id ?? null,
      externalCreativeId: creativeId,
      name: ad.name ?? null,
      status: ad.status ?? null,
      effectiveStatus: ad.effective_status ?? null,
    },
    creative: creativeId
      ? {
          externalCreativeId: creativeId,
          name: ad.creative?.name ?? null,
          objectType: ad.creative?.object_type ?? null,
          thumbnailUrl: ad.creative?.thumbnail_url ?? null,
        }
      : null,
  };
}

function sumOutboundClicks(rows: MetaInsightRow['outbound_clicks']): number | null {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  let total = 0;
  for (const row of rows) {
    const value = Number(row?.value ?? 0);
    if (Number.isFinite(value)) total += value;
  }
  return total;
}

export function toCanonicalMetric(
  row: MetaInsightRow,
  params: Pick<SyncParams, 'currency' | 'externalAccountId'>,
): CanonicalMarketingDailyMetric | null {
  const reportDate = row.date_start;
  // A row without a date or a campaign id cannot be placed in the model; it is
  // rejected and counted rather than being coerced into something plausible.
  if (!reportDate || !row.campaign_id) return null;
  return {
    reportDate,
    externalAccountId: row.account_id ? `act_${row.account_id}` : params.externalAccountId,
    externalCampaignId: row.campaign_id,
    externalAdGroupId: row.adset_id ?? null,
    externalAdId: row.ad_id ?? null,
    externalCreativeId: null,
    country: normalizeCountry(row.country),
    platform: null,
    currency: row.account_currency ?? params.currency,
    spend: numberOrZero(row.spend),
    impressions: numberOrZero(row.impressions),
    clicks: numberOrZero(row.clicks),
    linkClicks: row.inline_link_clicks !== undefined ? numberOrZero(row.inline_link_clicks) : null,
    outboundClicks: sumOutboundClicks(row.outbound_clicks),
    reach: row.reach !== undefined ? numberOrZero(row.reach) : null,
    frequency: row.frequency !== undefined ? Number(row.frequency) : null,
  };
}

function numberOrZero(value: string | number | undefined): number {
  if (value === undefined) return 0;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function normalizeCountry(value: string | undefined): string | null {
  if (!value) return null;
  const upper = value.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(upper) ? upper : null;
}

export function toHealth(error: unknown, checkedAt: string): ConnectionHealth {
  if (isProviderError(error)) {
    const invalidCredential =
      error.errorClass === 'authentication_error' || error.errorClass === 'expired_credential';
    return {
      ok: false,
      status: invalidCredential ? 'invalid_credentials' : 'degraded',
      message: error.userMessage,
      errorClass: error.errorClass,
      checkedAt,
    };
  }
  return {
    ok: false,
    status: 'degraded',
    message: 'Connection validation failed for an unexpected reason.',
    errorClass: 'unknown_error',
    checkedAt,
  };
}

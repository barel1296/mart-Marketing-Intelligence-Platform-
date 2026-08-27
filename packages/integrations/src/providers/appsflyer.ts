import type {
  CanonicalAttributionBatch,
  CanonicalAttributionDailyMetric,
  CanonicalAttributionEventMetric,
  CanonicalAttributionRevenueMetric,
  IsoDate,
} from '@mart/shared';
import { isProviderError, ProviderError } from '@mart/shared';
import { ProviderHttpClient, userMessageFor } from '../http.js';
import { declare, type CapabilityDeclaration } from '../capabilities.js';
import { csvNumber, csvText, parseCsvTable, type CsvTable } from '../csv.js';
import {
  emptyAttributionBatch,
  type AttributionProvider,
  type ConnectionHealth,
  type ProviderAccount,
  type SyncParams,
  type SyncResult,
} from '../types.js';
import { toHealth } from './meta.js';
import type { AppsFlyerCredentials } from '../credentials.js';

/**
 * AppsFlyer read-only MMP adapter.
 *
 * Contract verified against AppsFlyer's Pull API v5 documentation:
 *   base      https://hq1.appsflyer.com
 *   raw       /api/raw-data/export/app/{app-id}/{report}/v5
 *   aggregate /api/agg-data/export/app/{app-id}/{report}/v5
 *   auth      Authorization: Bearer <V2 API token>
 *   params    from, to, timezone, currency, maximum_rows, additional_fields, ...
 *   response  CSV
 *
 * Raw-data access depends on the customer's plan, so MART probes for it instead
 * of assuming it. With raw data the adapter produces campaign/adset/ad IDs
 * (which reconcile against Meta by stable id); without it, only the aggregate
 * report is available and campaign IDs genuinely do not exist - which is
 * recorded as a capability so the dashboard shows an explicit unavailable state
 * rather than a name-matched guess.
 */
export type AppsFlyerProviderOptions = {
  credentials: AppsFlyerCredentials;
  baseUrl: string;
  http?: ProviderHttpClient;
};

const RAW_BASE = '/api/raw-data/export/app';
const AGG_BASE = '/api/agg-data/export/app';
const MAX_ROWS = 200_000;

const RAW_ADDITIONAL_FIELDS = ['af_c_id', 'af_adset_id', 'af_ad_id', 'af_channel'].join(',');

export class AppsFlyerAttributionProvider implements AttributionProvider {
  readonly providerKey = 'appsflyer' as const;
  readonly category = 'attribution_mmp' as const;

  private readonly http: ProviderHttpClient;
  private readonly baseUrl: string;
  private readonly apiToken: string;
  /** Cached per instance so one sync does not re-probe on every window. */
  private rawDataSupported: boolean | null = null;

  constructor(options: AppsFlyerProviderOptions) {
    this.apiToken = options.credentials.apiToken;
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.http =
      options.http ??
      new ProviderHttpClient({ provider: 'appsflyer', minIntervalMs: 250, maxAttempts: 3 });
  }

  private headers(): Record<string, string> {
    return { authorization: `Bearer ${this.apiToken}` };
  }

  private async fetchCsv(
    path: string,
    query: Record<string, string | number | undefined>,
  ): Promise<CsvTable> {
    const response = await this.http.request<string>({
      url: `${this.baseUrl}${path}`,
      query,
      headers: this.headers(),
      responseType: 'text',
    });
    const text = response.body ?? '';
    // AppsFlyer returns a plain-text explanation (HTTP 200) when a report is not
    // enabled for the account. Treat that as authorization, not as data.
    if (/only supported for accounts|not supported for your account|no permission/i.test(text)) {
      throw new ProviderError({
        provider: 'appsflyer',
        errorClass: 'authorization_error',
        message: 'AppsFlyer reported the requested report is not enabled for this account',
        userMessage:
          'This AppsFlyer account or plan does not expose the requested report. MART will use the reports that are available.',
      });
    }
    return parseCsvTable(text);
  }

  async validateConnection(): Promise<ConnectionHealth> {
    const checkedAt = new Date().toISOString();
    // The Pull API is per-app, so a token can only be validated against an app.
    // Connection-level validation confirms the token is well-formed and that
    // AppsFlyer answers; app-level validation happens when an app is selected.
    if (!this.apiToken || this.apiToken.length < 20) {
      return {
        ok: false,
        status: 'invalid_credentials',
        message:
          'The AppsFlyer API token looks malformed. Paste the V2 token from your AppsFlyer account.',
        errorClass: 'authentication_error',
        checkedAt,
      };
    }
    return {
      ok: true,
      status: 'pending',
      message:
        'Token stored. AppsFlyer validates per app, so select an app ID to complete validation.',
      checkedAt,
      details: { appDiscovery: 'manual', requiresAppId: true },
    };
  }

  /**
   * AppsFlyer's Pull API has no account-wide app-listing endpoint, so app
   * discovery is genuinely unavailable here. MART asks for the app ID and then
   * validates it, rather than pretending to enumerate.
   */
  async listApps(): Promise<ProviderAccount[]> {
    return [];
  }

  /** Validate a specific app id by probing a one-day aggregate report. */
  async validateAccount(externalAppId: string): Promise<ConnectionHealth> {
    const checkedAt = new Date().toISOString();
    const day = new Date().toISOString().slice(0, 10);
    try {
      await this.fetchCsv(
        `${AGG_BASE}/${encodeURIComponent(externalAppId)}/partners_by_date_report/v5`,
        {
          from: day,
          to: day,
          maximum_rows: 1,
        },
      );
      return {
        ok: true,
        status: 'connected',
        message: `AppsFlyer app ${externalAppId} is reachable with the stored token.`,
        checkedAt,
      };
    } catch (error) {
      return toHealth(error, checkedAt);
    }
  }

  async getCapabilities(externalAccountId?: string): Promise<CapabilityDeclaration[]> {
    const declared = declare(
      {
        installs: true,
        events: true,
        revenue: true,
        media_source: true,
        campaign: true,
        country: true,
        platform: true,
        attributed_installs: true,
        attributed_revenue: true,
        // A marketing network reports these; an MMP reports attribution.
        cost_data: false,
        delivery_metrics: false,
        cohort_reporting: false,
      },
      'declared',
      { note: 'AppsFlyer Pull API v5' },
    );

    if (!externalAccountId) return declared;

    const raw = await this.probeRawData(externalAccountId);
    return [
      ...declared,
      { key: 'raw_data', supported: raw, discoveryMethod: 'probed', detail: rawDetail(raw) },
      // Campaign/adset/ad IDs only exist in the raw reports. Without raw access
      // AppsFlyer aggregate reports carry names only.
      { key: 'campaign_id', supported: raw, discoveryMethod: 'probed', detail: rawDetail(raw) },
      { key: 'ad_group_id', supported: raw, discoveryMethod: 'probed', detail: rawDetail(raw) },
      { key: 'ad_id', supported: raw, discoveryMethod: 'probed', detail: rawDetail(raw) },
      { key: 'ad_group', supported: raw, discoveryMethod: 'probed', detail: rawDetail(raw) },
      { key: 'ad', supported: raw, discoveryMethod: 'probed', detail: rawDetail(raw) },
      {
        key: 'install_timestamp',
        supported: raw,
        discoveryMethod: 'probed',
        detail: rawDetail(raw),
      },
      { key: 'creative', supported: false, discoveryMethod: 'declared' },
      { key: 'creative_id', supported: false, discoveryMethod: 'declared' },
    ];
  }

  private async probeRawData(externalAppId: string): Promise<boolean> {
    if (this.rawDataSupported !== null) return this.rawDataSupported;
    const day = new Date().toISOString().slice(0, 10);
    try {
      await this.fetchCsv(`${RAW_BASE}/${encodeURIComponent(externalAppId)}/installs_report/v5`, {
        from: day,
        to: day,
        maximum_rows: 1,
      });
      this.rawDataSupported = true;
    } catch (error) {
      if (
        isProviderError(error) &&
        (error.errorClass === 'authorization_error' || error.errorClass === 'invalid_request')
      ) {
        this.rawDataSupported = false;
      } else {
        throw error;
      }
    }
    return this.rawDataSupported;
  }

  async syncInstalls(params: SyncParams): Promise<SyncResult<CanonicalAttributionBatch>> {
    const raw = await this.probeRawData(params.externalAccountId);
    return raw ? this.syncInstallsRaw(params) : this.syncInstallsAggregate(params);
  }

  private async syncInstallsRaw(
    params: SyncParams,
  ): Promise<SyncResult<CanonicalAttributionBatch>> {
    const batch = emptyAttributionBatch();
    const warnings: string[] = [];
    const table = await this.fetchCsv(
      `${RAW_BASE}/${encodeURIComponent(params.externalAccountId)}/installs_report/v5`,
      {
        from: params.from,
        to: params.to,
        timezone: params.timezone,
        currency: params.currency,
        maximum_rows: MAX_ROWS,
        additional_fields: RAW_ADDITIONAL_FIELDS,
      },
    );

    await params.onRawPage?.({
      pageNumber: 1,
      payload: { headers: table.headers, rowCount: table.rows.length },
      recordCount: table.rows.length,
      schemaVersion: 'raw-v5',
      windowStart: params.from,
      windowEnd: params.to,
    });

    const grouped = new Map<string, CanonicalAttributionDailyMetric>();
    let rejected = 0;
    let latestDataDate: IsoDate | null = null;

    for (const row of table.rows) {
      const installDate = toIsoDay(pick(row, ['install_time', 'install_date', 'event_time']));
      if (!installDate) {
        rejected += 1;
        continue;
      }
      const metric: CanonicalAttributionDailyMetric = {
        installDate,
        mediaSource: pick(row, ['media_source', 'af_channel']),
        externalCampaignId: pick(row, ['campaign_id', 'af_c_id']),
        campaignName: pick(row, ['campaign', 'af_campaign']),
        externalAdGroupId: pick(row, ['adset_id', 'af_adset_id']),
        adGroupName: pick(row, ['adset', 'af_adset']),
        externalAdId: pick(row, ['ad_id', 'af_ad_id']),
        adName: pick(row, ['ad', 'af_ad']),
        externalCreativeId: null,
        creativeName: null,
        country: normalizeCountryCode(pick(row, ['country_code', 'country'])),
        platform: normalizePlatform(pick(row, ['platform'])),
        attributionCertainty: 'deterministic',
        attributedInstalls: 1,
        attributedClicks: null,
        attributedImpressions: null,
      };
      const key = installKey(metric);
      const existing = grouped.get(key);
      if (existing) existing.attributedInstalls += 1;
      else grouped.set(key, metric);
      if (!latestDataDate || installDate > latestDataDate) latestDataDate = installDate;
    }

    batch.installs = [...grouped.values()];
    if (rejected > 0)
      warnings.push(`${rejected} AppsFlyer install rows had no usable install time.`);
    return {
      batch,
      pagesFetched: 1,
      rowsFetched: table.rows.length,
      rowsRejected: rejected,
      warnings,
      latestDataDate,
    };
  }

  private async syncInstallsAggregate(
    params: SyncParams,
  ): Promise<SyncResult<CanonicalAttributionBatch>> {
    const batch = emptyAttributionBatch();
    const warnings: string[] = [
      'AppsFlyer raw data is not available for this account; installs were imported from the aggregate report, which does not include campaign, ad set or ad IDs.',
    ];
    const table = await this.fetchCsv(
      `${AGG_BASE}/${encodeURIComponent(params.externalAccountId)}/partners_by_date_report/v5`,
      { from: params.from, to: params.to, timezone: params.timezone, currency: params.currency },
    );

    await params.onRawPage?.({
      pageNumber: 1,
      payload: { headers: table.headers, rowCount: table.rows.length },
      recordCount: table.rows.length,
      schemaVersion: 'agg-v5',
      windowStart: params.from,
      windowEnd: params.to,
    });

    let rejected = 0;
    let latestDataDate: IsoDate | null = null;
    for (const row of table.rows) {
      const installDate = toIsoDay(pick(row, ['date']));
      if (!installDate) {
        rejected += 1;
        continue;
      }
      batch.installs.push({
        installDate,
        mediaSource: pick(row, ['media_source']),
        // These IDs genuinely do not exist in the aggregate report.
        externalCampaignId: null,
        campaignName: pick(row, ['campaign', 'campaign_c']),
        externalAdGroupId: null,
        adGroupName: null,
        externalAdId: null,
        adName: null,
        externalCreativeId: null,
        creativeName: null,
        country: normalizeCountryCode(pick(row, ['country_code', 'geo', 'country'])),
        platform: null,
        attributionCertainty: 'unknown',
        attributedInstalls: csvNumber(row['installs'] ?? row['total_installs']),
        attributedClicks: optionalNumber(row['clicks']),
        attributedImpressions: optionalNumber(row['impressions']),
      });
      if (!latestDataDate || installDate > latestDataDate) latestDataDate = installDate;
    }

    return {
      batch,
      pagesFetched: 1,
      rowsFetched: table.rows.length,
      rowsRejected: rejected,
      warnings,
      latestDataDate,
    };
  }

  async syncEvents(params: SyncParams): Promise<SyncResult<CanonicalAttributionBatch>> {
    const raw = await this.probeRawData(params.externalAccountId);
    if (!raw) {
      return {
        batch: emptyAttributionBatch(),
        pagesFetched: 0,
        rowsFetched: 0,
        rowsRejected: 0,
        warnings: [
          'AppsFlyer in-app event data requires raw-data access, which is not enabled for this account.',
        ],
        latestDataDate: null,
      };
    }

    const table = await this.fetchCsv(
      `${RAW_BASE}/${encodeURIComponent(params.externalAccountId)}/in_app_events_report/v5`,
      {
        from: params.from,
        to: params.to,
        timezone: params.timezone,
        currency: params.currency,
        maximum_rows: MAX_ROWS,
        additional_fields: RAW_ADDITIONAL_FIELDS,
      },
    );

    await params.onRawPage?.({
      pageNumber: 1,
      payload: { headers: table.headers, rowCount: table.rows.length },
      recordCount: table.rows.length,
      schemaVersion: 'raw-v5',
      windowStart: params.from,
      windowEnd: params.to,
    });

    const events = new Map<string, CanonicalAttributionEventMetric>();
    const revenue = new Map<string, CanonicalAttributionRevenueMetric>();
    let rejected = 0;
    let latestDataDate: IsoDate | null = null;

    for (const row of table.rows) {
      const eventDate = toIsoDay(pick(row, ['event_time', 'event_date']));
      const eventName = pick(row, ['event_name']);
      if (!eventDate || !eventName) {
        rejected += 1;
        continue;
      }
      const dims = {
        mediaSource: pick(row, ['media_source', 'af_channel']),
        externalCampaignId: pick(row, ['campaign_id', 'af_c_id']),
        campaignName: pick(row, ['campaign', 'af_campaign']),
        country: normalizeCountryCode(pick(row, ['country_code', 'country'])),
        platform: normalizePlatform(pick(row, ['platform'])),
      };
      const eventKey = [
        eventDate,
        eventName,
        dims.mediaSource,
        dims.externalCampaignId,
        dims.country,
        dims.platform,
      ].join('|');
      const existingEvent = events.get(eventKey);
      if (existingEvent) existingEvent.eventCount += 1;
      else
        events.set(eventKey, { eventDate, eventName, ...dims, eventCount: 1, uniqueUsers: null });

      const amount = Number(pick(row, ['event_revenue_usd', 'event_revenue']) ?? '');
      if (Number.isFinite(amount) && amount !== 0) {
        const currency =
          pick(row, ['event_revenue_currency']) ??
          (row['event_revenue_usd'] ? 'USD' : params.currency);
        const revenueKey = [
          eventDate,
          dims.mediaSource,
          dims.externalCampaignId,
          dims.country,
          dims.platform,
          currency,
        ].join('|');
        const existingRevenue = revenue.get(revenueKey);
        if (existingRevenue) existingRevenue.revenue += amount;
        else {
          revenue.set(revenueKey, {
            activityDate: eventDate,
            // Revenue recorded on the day it happened. This is NOT cohort LTV,
            // and the grain field keeps the two from ever being conflated.
            grain: 'event_date',
            revenueType: 'iap',
            ...dims,
            currency,
            revenue: amount,
          });
        }
      }
      if (!latestDataDate || eventDate > latestDataDate) latestDataDate = eventDate;
    }

    const batch = emptyAttributionBatch();
    batch.events = [...events.values()];
    batch.revenue = [...revenue.values()];
    return {
      batch,
      pagesFetched: 1,
      rowsFetched: table.rows.length,
      rowsRejected: rejected,
      warnings: rejected > 0 ? [`${rejected} AppsFlyer event rows were unusable.`] : [],
      latestDataDate,
    };
  }

  /**
   * Attributed IAP revenue arrives with the in-app event report, so revenue is
   * produced by the same pass rather than issuing a second identical request.
   */
  async syncRevenue(params: SyncParams): Promise<SyncResult<CanonicalAttributionBatch>> {
    const result = await this.syncEvents(params);
    return {
      ...result,
      batch: { installs: [], events: [], revenue: result.batch.revenue },
    };
  }
}

// ------------------------------------------------------------- helpers ------

function rawDetail(supported: boolean): Record<string, unknown> {
  return supported
    ? { source: 'raw-data Pull API v5' }
    : { reason: 'Raw-data Pull API is not enabled for this AppsFlyer account or plan' };
}

/** Read the first present candidate column, so header variants do not break mapping. */
export function pick(row: Record<string, string>, candidates: string[]): string | null {
  for (const candidate of candidates) {
    const value = csvText(row[candidate]);
    if (value !== null) return value;
  }
  return null;
}

export function toIsoDay(value: string | null): IsoDate | null {
  if (!value) return null;
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(value.trim());
  return match ? (match[1] as IsoDate) : null;
}

export function normalizeCountryCode(value: string | null): string | null {
  if (!value) return null;
  const upper = value.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(upper) ? upper : null;
}

export function normalizePlatform(value: string | null): string | null {
  if (!value) return null;
  const lower = value.trim().toLowerCase();
  if (lower.includes('ios')) return 'ios';
  if (lower.includes('android')) return 'android';
  return lower || null;
}

function optionalNumber(value: string | undefined): number | null {
  if (value === undefined || value === '') return null;
  const n = Number(value.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

function installKey(metric: CanonicalAttributionDailyMetric): string {
  return [
    metric.installDate,
    metric.mediaSource,
    metric.externalCampaignId,
    metric.externalAdGroupId,
    metric.externalAdId,
    metric.country,
    metric.platform,
  ].join('|');
}

export { userMessageFor };

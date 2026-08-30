import type {
  CanonicalAttributionBatch,
  CanonicalAttributionDailyMetric,
  CanonicalAttributionRevenueMetric,
  IsoDate,
} from '@mart/shared';
import { ProviderError } from '@mart/shared';
import { ProviderHttpClient, userMessageFor } from '../http.js';
import { declare, type CapabilityDeclaration } from '../capabilities.js';
import {
  emptyAttributionBatch,
  type AttributionProvider,
  type ConnectionHealth,
  type ProviderAccount,
  type SyncParams,
  type SyncResult,
} from '../types.js';
import { toHealth } from './meta.js';
import type { TenjinCredentials } from '../credentials.js';

/**
 * Tenjin read-only MMP adapter.
 *
 * Metric and dimension vocabulary verified against Tenjin's published
 * user-acquisition reporting catalogue. Two properties of that catalogue shape
 * this adapter and are worth stating explicitly, because getting them wrong
 * would silently corrupt MART's grain discipline:
 *
 *  - Tenjin reports BOTH network-reported and Tenjin-tracked counts. `installs`
 *    is what the ad network claims; `tracked_installs` is what Tenjin
 *    attributed. Only `tracked_installs` is attribution, so only it is written
 *    to MART's attribution model.
 *  - Non-N-day revenue metrics (`revenues`, `pub_rev`) are revenue recorded on
 *    the report date, whereas `*_Nd` metrics are cohort LTV. MART imports the
 *    former at event_date grain and does not import cohort LTV in Phase 0A, so
 *    the two can never be conflated.
 *
 * The wire format (endpoint path and parameter names) is configurable because
 * it could not be verified against a live account in this environment; see
 * INTEGRATIONS.md for the verification status.
 */
export type TenjinProviderOptions = {
  credentials: TenjinCredentials;
  baseUrl: string;
  http?: ProviderHttpClient;
  /** Overridable so a contract change does not require a code change. */
  endpoints?: Partial<TenjinEndpoints>;
};

export type TenjinEndpoints = {
  userAcquisition: string;
  apps: string;
};

/**
 * Paths relative to TENJIN_BASE_URL, which already carries the /v2 prefix
 * (https://api.tenjin.com/v2). Keeping the version in the base URL rather than
 * in every path is what stops the two being concatenated into
 * .../v2/api/v2/apps when an operator sets the documented base URL.
 */
const DEFAULT_ENDPOINTS: TenjinEndpoints = {
  userAcquisition: '/user_acquisition',
  apps: '/apps',
};

/** Verified metric ids from Tenjin's user-acquisition report catalogue. */
export const TENJIN_ATTRIBUTION_METRICS = [
  'tracked_installs',
  'tracked_clicks',
  'tracked_impressions',
] as const;

export const TENJIN_REVENUE_METRICS = ['revenues', 'pub_rev', 'total_rev'] as const;

export const TENJIN_GROUP_BY = [
  'date',
  'app',
  'campaign',
  'campaign_id',
  'ad_network',
  'country',
  'platform',
] as const;

type TenjinRow = Record<string, string | number | null | undefined>;

export class TenjinAttributionProvider implements AttributionProvider {
  readonly providerKey = 'tenjin' as const;
  readonly category = 'attribution_mmp' as const;

  private readonly http: ProviderHttpClient;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly endpoints: TenjinEndpoints;

  constructor(options: TenjinProviderOptions) {
    this.apiKey = options.credentials.apiKey;
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.endpoints = { ...DEFAULT_ENDPOINTS, ...options.endpoints };
    this.http =
      options.http ??
      new ProviderHttpClient({ provider: 'tenjin', minIntervalMs: 250, maxAttempts: 3 });
  }

  private async get<T>(
    path: string,
    query: Record<string, string | number | undefined>,
  ): Promise<T> {
    const response = await this.http.request<T>({
      url: `${this.baseUrl}${path}`,
      query,
      // Bearer header, never a query parameter: a token in a URL leaks through
      // logs, proxies and the provider's own error echoes.
      headers: { authorization: `Bearer ${this.apiKey}` },
      responseType: 'json',
    });
    return response.body;
  }

  /**
   * Tenjin responses have been observed in several envelopes across API
   * versions. Accept the known shapes and fail loudly on anything else rather
   * than silently returning zero rows.
   */
  private extractRows(body: unknown): TenjinRow[] {
    if (Array.isArray(body)) return body as TenjinRow[];
    if (body && typeof body === 'object') {
      const record = body as Record<string, unknown>;
      for (const key of ['data', 'results', 'rows', 'report']) {
        const value = record[key];
        if (Array.isArray(value)) return value as TenjinRow[];
      }
    }
    throw new ProviderError({
      provider: 'tenjin',
      errorClass: 'schema_change',
      message: 'Tenjin response did not contain a recognizable rows array',
      userMessage: userMessageFor('tenjin', 'schema_change'),
    });
  }

  async validateConnection(): Promise<ConnectionHealth> {
    const checkedAt = new Date().toISOString();
    try {
      const body = await this.get<unknown>(this.endpoints.apps, {});
      const rows = this.extractRows(body);
      return {
        ok: true,
        status: 'connected',
        message: `Tenjin API key is valid; ${rows.length} app(s) visible.`,
        checkedAt,
        details: { appsVisible: rows.length },
      };
    } catch (error) {
      return toHealth(error, checkedAt);
    }
  }

  /**
   * Confirm the chosen app is one this key can actually see.
   *
   * Tenjin exposes an app list, so membership in it is the check. When the list
   * comes back empty MART says so rather than inventing a pass: an empty list is
   * not proof that the app is readable.
   */
  async validateAccount(externalAccountId: string): Promise<ConnectionHealth> {
    const checkedAt = new Date().toISOString();
    try {
      const apps = await this.listApps();
      const match = apps.find((app) => app.externalAccountId === externalAccountId);
      if (match) {
        return {
          ok: true,
          status: 'connected',
          message: `Tenjin app ${externalAccountId} is visible to this API key.`,
          checkedAt,
        };
      }
      if (apps.length === 0) {
        return {
          ok: true,
          status: 'pending',
          message:
            'Tenjin returned no app list for this key, so the app id could not be confirmed. It will be proven by the first sync.',
          checkedAt,
          details: { appsVisible: 0 },
        };
      }
      return {
        ok: false,
        status: 'degraded',
        message: `Tenjin app ${externalAccountId} is not among the ${apps.length} app(s) this API key can see.`,
        errorClass: 'authorization_error',
        checkedAt,
      };
    } catch (error) {
      return toHealth(error, checkedAt);
    }
  }

  async listApps(): Promise<ProviderAccount[]> {
    const body = await this.get<unknown>(this.endpoints.apps, {});
    const rows = this.extractRows(body);
    return rows
      .map((row): ProviderAccount | null => {
        // Never fall back to an api_key field as the identifier: Tenjin issues
        // per-app keys, and an id is displayed in the UI and stored in the
        // database. A row with no real id is skipped rather than labelled with
        // something key-shaped.
        const id = str(row['id'] ?? row['app_id']);
        if (!id) return null;
        return {
          externalAccountId: id,
          name: str(row['name'] ?? row['app_name']) ?? id,
          accountType: 'mmp_app' as const,
          currency: null,
          timezone: str(row['timezone']),
          status: str(row['status']),
          metadata: {
            bundleId: str(row['bundle_id'] ?? row['package_name']),
            platform: str(row['platform']),
          },
        };
      })
      .filter((a): a is ProviderAccount => a !== null);
  }

  async getCapabilities(externalAccountId?: string): Promise<CapabilityDeclaration[]> {
    const declared = declare(
      {
        installs: true,
        revenue: true,
        media_source: true,
        campaign: true,
        campaign_id: true,
        country: true,
        platform: true,
        attributed_installs: true,
        attributed_revenue: true,
        // Tenjin's UA report exposes cost alongside attribution, but MART takes
        // cost from the marketing network so the two are never double counted.
        cost_data: false,
        delivery_metrics: false,
        // Cohort (N-day) reporting exists in the catalogue but is intentionally
        // not imported in Phase 0A: MART does not display cohort economics yet.
        cohort_reporting: true,
        raw_data: false,
        events: false,
        ad_group: false,
        ad_group_id: false,
        ad: false,
        ad_id: false,
        creative: false,
        creative_id: false,
        install_timestamp: false,
        skan_data: true,
      },
      'declared',
      {
        note: 'Tenjin user-acquisition report catalogue',
        cohortReportingNote:
          'N-day cohort metrics (retention_Nd, roas_Nd, revenues_Nd) exist but are not imported in Phase 0A.',
      },
    );

    if (!externalAccountId) return declared;
    return declared;
  }

  async syncInstalls(params: SyncParams): Promise<SyncResult<CanonicalAttributionBatch>> {
    const rows = await this.fetchUserAcquisition(params, [...TENJIN_ATTRIBUTION_METRICS]);
    const batch = emptyAttributionBatch();
    let rejected = 0;
    let latestDataDate: IsoDate | null = null;

    for (const row of rows.rows) {
      const installDate = isoDay(str(row['date'] ?? row['day']));
      if (!installDate) {
        rejected += 1;
        continue;
      }
      const metric: CanonicalAttributionDailyMetric = {
        installDate,
        mediaSource: str(row['ad_network'] ?? row['network'] ?? row['media_source']),
        externalCampaignId: str(row['campaign_id'] ?? row['campaign_ref_id']),
        campaignName: str(row['campaign'] ?? row['campaign_name']),
        externalAdGroupId: null,
        adGroupName: null,
        externalAdId: null,
        adName: null,
        externalCreativeId: null,
        creativeName: null,
        country: countryCode(str(row['country'] ?? row['country_code'])),
        platform: platform(str(row['platform'])),
        attributionCertainty: 'deterministic',
        // Only Tenjin-tracked installs are attribution. The network-reported
        // `installs` metric is deliberately not read here.
        attributedInstalls: num(row['tracked_installs']),
        attributedClicks: optionalNum(row['tracked_clicks']),
        attributedImpressions: optionalNum(row['tracked_impressions']),
      };
      batch.installs.push(metric);
      if (!latestDataDate || installDate > latestDataDate) latestDataDate = installDate;
    }

    return {
      batch,
      pagesFetched: rows.pages,
      rowsFetched: rows.rows.length,
      rowsRejected: rejected,
      warnings: rejected > 0 ? [`${rejected} Tenjin rows had no usable date.`] : [],
      latestDataDate,
    };
  }

  /**
   * Tenjin's user-acquisition report has no in-app event breakdown, so MART
   * reports the capability as absent rather than approximating it.
   */
  async syncEvents(): Promise<SyncResult<CanonicalAttributionBatch>> {
    return {
      batch: emptyAttributionBatch(),
      pagesFetched: 0,
      rowsFetched: 0,
      rowsRejected: 0,
      warnings: ['Tenjin does not expose per-event breakdowns in the user-acquisition report.'],
      latestDataDate: null,
    };
  }

  async syncRevenue(params: SyncParams): Promise<SyncResult<CanonicalAttributionBatch>> {
    const rows = await this.fetchUserAcquisition(params, [...TENJIN_REVENUE_METRICS]);
    const batch = emptyAttributionBatch();
    let rejected = 0;
    let latestDataDate: IsoDate | null = null;

    for (const row of rows.rows) {
      const activityDate = isoDay(str(row['date'] ?? row['day']));
      if (!activityDate) {
        rejected += 1;
        continue;
      }
      const dims = {
        mediaSource: str(row['ad_network'] ?? row['network'] ?? row['media_source']),
        externalCampaignId: str(row['campaign_id'] ?? row['campaign_ref_id']),
        campaignName: str(row['campaign'] ?? row['campaign_name']),
        country: countryCode(str(row['country'] ?? row['country_code'])),
        platform: platform(str(row['platform'])),
      };
      const emit = (
        revenueType: CanonicalAttributionRevenueMetric['revenueType'],
        value: number,
      ) => {
        if (!value) return;
        batch.revenue.push({
          activityDate,
          // Revenue recorded on this date, not cohort LTV.
          grain: 'event_date',
          revenueType,
          ...dims,
          currency: params.currency,
          revenue: value,
        });
      };
      emit('iap', num(row['revenues']));
      emit('ad', num(row['pub_rev']));
      if (!latestDataDate || activityDate > latestDataDate) latestDataDate = activityDate;
    }

    return {
      batch,
      pagesFetched: rows.pages,
      rowsFetched: rows.rows.length,
      rowsRejected: rejected,
      warnings: [],
      latestDataDate,
    };
  }

  private async fetchUserAcquisition(
    params: SyncParams,
    metrics: string[],
  ): Promise<{ rows: TenjinRow[]; pages: number }> {
    const body = await this.get<unknown>(this.endpoints.userAcquisition, {
      app_id: params.externalAccountId,
      start_date: params.from,
      end_date: params.to,
      group_by: TENJIN_GROUP_BY.join(','),
      metrics: metrics.join(','),
      timezone: params.timezone,
    });
    const rows = this.extractRows(body);
    await params.onRawPage?.({
      pageNumber: 1,
      payload: body,
      recordCount: rows.length,
      schemaVersion: 'ua-v2',
      windowStart: params.from,
      windowEnd: params.to,
    });
    return { rows, pages: 1 };
  }
}

// ------------------------------------------------------------- helpers ------

function str(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s.length === 0 ? null : s;
}

function num(value: unknown): number {
  if (value === null || value === undefined || value === '') return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function optionalNum(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function isoDay(value: string | null): IsoDate | null {
  if (!value) return null;
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(value);
  return match ? (match[1] as IsoDate) : null;
}

function countryCode(value: string | null): string | null {
  if (!value) return null;
  const upper = value.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(upper) ? upper : null;
}

function platform(value: string | null): string | null {
  if (!value) return null;
  const lower = value.trim().toLowerCase();
  if (lower.includes('ios')) return 'ios';
  if (lower.includes('android')) return 'android';
  return lower;
}

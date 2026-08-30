import type {
  CanonicalAttributionBatch,
  CanonicalAttributionDailyMetric,
  CanonicalAttributionRevenueMetric,
  IsoDate,
} from '@mart/shared';
import { ProviderError, SENSITIVE_KEY_PATTERN, isProviderError } from '@mart/shared';
import { getLogger } from '@mart/observability';
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
  /**
   * Documented fallback lookup that returns id + name for a set of app ids.
   * Absolute, because it sits outside the /v2 base. Only used when the app
   * detail endpoint still yields no name.
   */
  dataExportsApps: string;
};

/**
 * Paths relative to TENJIN_BASE_URL, which already carries the /v2 prefix
 * (https://api.tenjin.com/v2). Keeping the version in the base URL rather than
 * in every path is what stops the two being concatenated into
 * .../v2/api/v2/apps when an operator sets the documented base URL.
 */
const DEFAULT_ENDPOINTS: Omit<TenjinEndpoints, 'dataExportsApps'> = {
  // Reporting lives under /reports, alongside /reports/sk_ad_network and
  // /reports/ad_monetization - not at the API root beside /apps.
  userAcquisition: '/reports/user_acquisition',
  apps: '/apps',
};

/** Bounded so a broken cursor cannot page forever. */
const MAX_REPORT_PAGES = 200;

/** Bounded so a large account cannot turn discovery into hundreds of requests. */
const MAX_APPS_TO_ENRICH = 100;

/** Verified metric ids from Tenjin's user-acquisition report catalogue. */
export const TENJIN_ATTRIBUTION_METRICS = [
  'tracked_installs',
  'tracked_clicks',
  'tracked_impressions',
] as const;

export const TENJIN_REVENUE_METRICS = ['revenues', 'pub_rev', 'total_rev'] as const;

/**
 * `group_by` is a closed enum, not a free list of dimensions. The allowed
 * values are: app, channel, country, site, campaign, "campaign,country",
 * "channel,app", "channel,app,country", creative. Sending anything else - a
 * date, a platform, an ad_network - is rejected.
 *
 * "campaign,country" is the richest grouping MART can use: the row still
 * carries app, ad network, platform and date, so nothing is lost by not naming
 * them. Daily bucketing comes from `granularity`, not from grouping by date.
 */
export const TENJIN_GROUP_BY = 'campaign,country';

/** Daily rows; the date arrives as a `date` attribute on each row. */
export const TENJIN_GRANULARITY = 'daily';

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
    // Derived from the configured origin rather than hardcoded, so fixture
    // mode stays self-consistent: pointing TENJIN_BASE_URL at the fixture
    // server must not send this one request to the real Tenjin.
    const dataExportsApps = new URL('/data_exports/v1/apps', `${this.baseUrl}/`).toString();
    this.endpoints = { ...DEFAULT_ENDPOINTS, dataExportsApps, ...options.endpoints };
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
  /**
   * Normalize a response into resources with an id and an attribute bag.
   *
   * Tenjin's app endpoints are JSON:API: `{data: [{id, type, attributes}]}`, and
   * the collection form omits `attributes` entirely. Report endpoints return
   * flat rows. Both are handled here so the rest of the adapter sees one shape.
   */
  private extractResources(
    body: unknown,
  ): Array<{ id: string | null; attributes: Record<string, unknown> }> {
    const rows = this.extractRows(body);
    return rows.map((row) => {
      const record = row as unknown as Record<string, unknown>;
      const attributes = record['attributes'];
      return {
        id: str(record['id'] as string | undefined),
        attributes:
          attributes && typeof attributes === 'object'
            ? (attributes as Record<string, unknown>)
            : record,
      };
    });
  }

  private extractRows(body: unknown): TenjinRow[] {
    if (Array.isArray(body)) return body as TenjinRow[];
    if (body && typeof body === 'object') {
      const record = body as Record<string, unknown>;
      for (const key of ['data', 'results', 'rows', 'report']) {
        const value = record[key];
        if (Array.isArray(value)) return value as TenjinRow[];
        // The single-resource form: {data: {id, type, attributes}}.
        if (value && typeof value === 'object') return [value as TenjinRow];
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

  /**
   * Discover apps.
   *
   * The collection endpoint returns JSON:API resource identifiers - `{id, type}`
   * with no attributes - so the list alone cannot name anything. Each id is
   * therefore enriched with GET /v2/apps/{id}, which carries the attributes.
   * A per-app failure is recorded against that app instead of failing the whole
   * discovery: two named apps and one that 403s is a better answer than none.
   */
  async listApps(): Promise<ProviderAccount[]> {
    const body = await this.get<unknown>(this.endpoints.apps, {});
    const resources = this.extractResources(body);

    const out: ProviderAccount[] = [];
    for (const resource of resources.slice(0, MAX_APPS_TO_ENRICH)) {
      // JSON:API puts the id on the resource; a flat row carries it inline.
      const idFromAttributes = pick(resource.attributes, ID_KEYS);
      const id = idFromAttributes.value ?? resource.id;
      if (!id) continue;
      const idSource = idFromAttributes.key ?? 'data.id';

      let attributes = resource.attributes;
      let detailStatus = 'not needed';

      if (!hasIdentifyingAttributes(attributes)) {
        const detail = await this.fetchAppDetail(id);
        detailStatus = detail.status;
        attributes = { ...attributes, ...detail.attributes };
      }

      let name = pick(attributes, NAME_KEYS);
      let nameSource = name.key;

      // Documented fallback, used only when the detail call still produced no
      // name - never speculatively, because it is a second endpoint the token
      // may not be entitled to.
      if (!name.value) {
        const fallback = await this.fetchNameFromDataExports(id);
        if (fallback) {
          name = { value: fallback, key: 'data_exports:name' };
          nameSource = 'data_exports:name';
          detailStatus = `${detailStatus} + data_exports fallback`;
        }
      }

      const bundleId = pick(attributes, BUNDLE_KEYS);
      const platform = pick(attributes, PLATFORM_KEYS);
      const storeId = pick(attributes, STORE_ID_KEYS);

      out.push({
        externalAccountId: id,
        // Falls back to the id so the field stays populated; fieldSources
        // records that no real name arrived, so nothing presents a UUID as a
        // title.
        name: name.value ?? id,
        accountType: 'mmp_app' as const,
        currency: null,
        timezone: str(attributes['timezone'] as string | undefined),
        status: str(attributes['status'] as string | undefined),
        metadata: {
          bundleId: bundleId.value,
          platform: platform.value ? normalizeTenjinPlatform(platform.value) : null,
          storeId: storeId.value,
          tenjinAppId: id,
          detailStatus,
          fieldSources: {
            id: idSource,
            name: nameSource,
            bundleId: bundleId.key,
            platform: platform.key,
            storeId: storeId.key,
          },
          raw: safeRow(attributes),
        },
      });
    }
    return out;
  }

  /**
   * GET /v2/apps/{id} -> data.attributes.
   *
   * Returns a status string rather than throwing: one inaccessible app must not
   * hide the ones that are readable.
   */
  private async fetchAppDetail(
    id: string,
  ): Promise<{ status: string; attributes: Record<string, unknown> }> {
    try {
      const body = await this.get<unknown>(`${this.endpoints.apps}/${encodeURIComponent(id)}`, {});
      const data = (body as { data?: unknown } | null)?.data;
      const attributes = (data as { attributes?: unknown } | undefined)?.attributes;
      if (attributes && typeof attributes === 'object') {
        return { status: 'ok', attributes: attributes as Record<string, unknown> };
      }
      // A 200 with no attributes is a contract change, not a missing app.
      return { status: 'ok but no attributes', attributes: {} };
    } catch (error) {
      const status = isProviderError(error)
        ? `${error.errorClass}${error.httpStatus ? ` (${error.httpStatus})` : ''}`
        : 'request failed';
      getLogger().warn({ provider: 'tenjin', tenjinAppId: id, status }, 'tenjin app detail failed');
      return { status, attributes: {} };
    }
  }

  /** Documented id -> name lookup, used only after the detail call yields none. */
  private async fetchNameFromDataExports(id: string): Promise<string | null> {
    try {
      const response = await this.http.request<unknown>({
        url: this.endpoints.dataExportsApps,
        query: { 'ids[]': id },
        headers: { authorization: `Bearer ${this.apiKey}` },
        responseType: 'json',
      });
      for (const resource of this.extractResources(response.body)) {
        if (resource.id && resource.id !== id) continue;
        const name = pick(resource.attributes, NAME_KEYS);
        if (name.value) return name.value;
      }
      return null;
    } catch (error) {
      const status = isProviderError(error) ? error.errorClass : 'request failed';
      getLogger().warn(
        { provider: 'tenjin', tenjinAppId: id, status },
        'tenjin data-exports name lookup failed',
      );
      return null;
    }
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
        mediaSource: str(row['ad_network_name'] ?? row['ad_network'] ?? row['media_source']),
        // Tenjin's own campaign UUID, not the ad network's campaign id, so it
        // cannot match Meta by stable id. Reconciliation falls back to names
        // and labels those candidates non-authoritative, which is correct.
        externalCampaignId: str(row['campaign_id'] ?? row['campaign_ref_id']),
        campaignName: str(row['campaign_name'] ?? row['campaign'] ?? row['name']),
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
      warnings: [
        ...rows.warnings,
        ...(rejected > 0 ? [`${rejected} Tenjin rows had no usable date.`] : []),
      ],
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
        mediaSource: str(row['ad_network_name'] ?? row['ad_network'] ?? row['media_source']),
        externalCampaignId: str(row['campaign_id'] ?? row['campaign_ref_id']),
        campaignName: str(row['campaign_name'] ?? row['campaign'] ?? row['name']),
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
      warnings: rows.warnings,
      latestDataDate,
    };
  }

  /**
   * GET /reports/user_acquisition.
   *
   * Rows come back as JSON:API resources - `{data: [{type: "report",
   * attributes: {...}}], has_more}` - so the metrics live under `attributes`,
   * not at the top of each row. Pagination is an opaque cursor plus a
   * `has_more` flag.
   */
  private async fetchUserAcquisition(
    params: SyncParams,
    metrics: string[],
  ): Promise<{ rows: TenjinRow[]; pages: number; warnings: string[] }> {
    const rows: TenjinRow[] = [];
    const warnings: string[] = [];
    let cursor: string | undefined;
    let pages = 0;

    for (let page = 1; page <= MAX_REPORT_PAGES; page += 1) {
      const body = await this.get<unknown>(this.endpoints.userAcquisition, {
        start_date: params.from,
        end_date: params.to,
        granularity: TENJIN_GRANULARITY,
        group_by: TENJIN_GROUP_BY,
        // Plural, comma-separated app UUIDs. The bundle id is not accepted here.
        app_ids: params.externalAccountId,
        metrics: metrics.join(','),
        format: 'json',
        ...(cursor ? { cursor } : {}),
      });
      pages += 1;

      const pageRows = this.extractResources(body).map(
        (resource) => resource.attributes as TenjinRow,
      );
      rows.push(...pageRows);

      await params.onRawPage?.({
        pageNumber: page,
        payload: body,
        recordCount: pageRows.length,
        schemaVersion: 'reports-ua-v2',
        windowStart: params.from,
        windowEnd: params.to,
      });

      const envelope = (body ?? {}) as Record<string, unknown>;
      if (envelope['has_more'] !== true) break;
      cursor = readCursor(envelope);
      if (!cursor) {
        // Stopping with a warning beats looping: a missing cursor on a
        // has_more page is a contract change, and silently truncating the
        // window would look like real data.
        warnings.push(
          'Tenjin reported more pages but returned no pagination cursor; the window may be incomplete.',
        );
        break;
      }
    }

    return { rows, pages, warnings };
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

/**
 * Candidate field names for each identifying attribute, most specific first.
 *
 * These are aliases MART looks for, not an invented schema: whichever one the
 * response actually carries is used, the key it came from is recorded, and if
 * none is present the value stays null rather than being derived from the id.
 */
const ID_KEYS = ['id', 'app_id', 'application_id', 'uuid'] as const;
const NAME_KEYS = [
  'name',
  'app_name',
  'title',
  'display_name',
  'label',
  'application_name',
] as const;
const BUNDLE_KEYS = [
  'bundle_id',
  'bundleId',
  'package_name',
  'packageName',
  'store_id',
  'storeId',
  'app_store_id',
  'store_app_id',
  'app_identifier',
  'identifier',
] as const;
const PLATFORM_KEYS = ['platform', 'os', 'device_platform', 'app_platform', 'store'] as const;
const STORE_ID_KEYS = ['store_id', 'storeId', 'app_store_id', 'store_app_id'] as const;

/** Whether a resource already carries enough to identify the app without a second call. */
function hasIdentifyingAttributes(attributes: Record<string, unknown>): boolean {
  return (
    pick(attributes, NAME_KEYS).value !== null ||
    pick(attributes, BUNDLE_KEYS).value !== null ||
    pick(attributes, STORE_ID_KEYS).value !== null
  );
}

/** First present value plus the key it came from, so provenance is reportable. */
function pick(
  row: Record<string, unknown>,
  keys: readonly string[],
): { value: string | null; key: string | null } {
  for (const key of keys) {
    const value = str(row[key] as string | number | null | undefined);
    if (value) return { value, key };
  }
  return { value: null, key: null };
}

/** ios / android / amazon as the provider spells them, lowercased. */
function normalizeTenjinPlatform(value: string): string {
  const lower = value.trim().toLowerCase();
  if (lower.includes('ios') || lower.includes('iphone') || lower.includes('apple')) return 'ios';
  if (lower.includes('android') || lower.includes('google') || lower.includes('play')) {
    return 'android';
  }
  return lower;
}

/**
 * Every scalar field from the row except anything secret-shaped.
 *
 * Tenjin app payloads can include a per-app SDK key; that must not be stored in
 * the database or rendered in the dashboard just because it arrived alongside
 * the fields we do want.
 */
function safeRow(row: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(row)) {
    if (isSensitiveAttribute(key)) continue;
    if (value === null || value === undefined) continue;
    if (typeof value === 'object') continue;
    out[key] = String(value);
  }
  return out;
}

/**
 * Broader than the shared redaction pattern, which matches `api_key` and
 * `private_key` but not `public_key` or `facebook_referrer_decryption_key`.
 * Tenjin's app resource carries several of those, and none of them belongs in
 * the database or on screen just because it arrived beside a bundle id.
 * Substring matching, deliberately: an identification field never contains any
 * of these words.
 */
const SENSITIVE_ATTRIBUTE_WORDS = /(key|secret|token|password|credential|signature|salt|hash)/i;

export function isSensitiveAttribute(key: string): boolean {
  return SENSITIVE_ATTRIBUTE_WORDS.test(key) || SENSITIVE_KEY_PATTERN.test(key);
}

/** The cursor Tenjin returns alongside has_more, wherever it puts it. */
function readCursor(envelope: Record<string, unknown>): string | undefined {
  for (const key of ['cursor', 'next_cursor', 'next']) {
    const value = envelope[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  const meta = envelope['meta'];
  if (meta && typeof meta === 'object') {
    return readCursor(meta as Record<string, unknown>);
  }
  return undefined;
}

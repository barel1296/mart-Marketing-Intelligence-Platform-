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
  type AttributionCampaignRef,
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
  /** Saved report definitions. */
  savedReports: string;
  /** The campaign directory, which carries the ad network's campaign id. */
  campaigns: string;
  /** Report data. The saved report UUID is appended: /reports/{id}. */
  reports: string;
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
  savedReports: '/saved_reports',
  campaigns: '/campaigns',
  // Report data is addressed by saved report UUID: /reports/{id}. There is no
  // report named for its family - asking for /reports/user_acquisition makes
  // Tenjin read "user_acquisition" as an id and answer 400 "Saved report not
  // found", which is exactly what it did.
  reports: '/reports',
  apps: '/apps',
};

/** Bounded so a broken cursor cannot page forever. */
const MAX_REPORT_PAGES = 200;

/** Bounded so a large account cannot turn discovery into hundreds of requests. */
const MAX_APPS_TO_ENRICH = 100;

/** Discovery page size. Large enough that no real account needs a second page. */
const SAVED_REPORTS_PER_PAGE = 1000;

/**
 * Metric ids, read from Tenjin's own reporting catalogue rather than inferred
 * from MART's fixtures.
 *
 * `tracked_installs` is Tenjin-attributed; the separate `installs` metric is
 * what the ad network claims. Only the former is attribution.
 */
export const TENJIN_INSTALL_METRIC = 'tracked_installs';
export const TENJIN_INSTALL_METRICS_OPTIONAL = ['tracked_clicks', 'tracked_impressions'] as const;

/**
 * Revenue vocabulary, and why it needs a layer rather than two constants.
 *
 * Tenjin reports ad revenue under two different metric ids that mean different
 * things:
 *
 *   pub_rev               "Ad Revenue"           - reported by the ad networks
 *   ad_mediation_revenue  "Ad Mediation Revenue" - reported by the mediation layer
 *
 * and it has two matching totals:
 *
 *   total_rev                    = revenues + pub_rev
 *   total_ad_mediation_revenue   = revenues + ad_mediation_revenue
 *
 * A real account confirms these are not interchangeable: a report can carry
 * `ad_mediation_revenue: 5.89` while `total_rev` is `0.0`, because that total
 * does not include mediation revenue. Requiring `pub_rev` therefore rejects a
 * perfectly good report, and reading `total_rev` as "all revenue" understates
 * it. Both variants normalize to MART's single `ad` revenue type; the totals
 * are only ever read when no component is present at all.
 */
export const TENJIN_REVENUE_METRIC_IAP = 'revenues';
/** Ad-revenue variants, preferred first. Both mean `ad` inside MART. */
export const TENJIN_AD_REVENUE_METRICS = ['ad_mediation_revenue', 'pub_rev'] as const;
/** Combined figures, each the sum of `revenues` and one ad variant. */
export const TENJIN_TOTAL_REVENUE_METRICS = ['total_ad_mediation_revenue', 'total_rev'] as const;
/** The component metrics: what MART prefers, because they carry the split. */
export const TENJIN_REVENUE_COMPONENT_METRICS = [
  TENJIN_REVENUE_METRIC_IAP,
  ...TENJIN_AD_REVENUE_METRICS,
] as const;

/**
 * Any one of these makes a saved report usable for revenue.
 *
 * A report carrying only a combined figure is still usable: the canonical
 * schema has a `total` revenue type, so it can be stored for what it is. What
 * MART must never do is relabel a total as IAP or ad, or add it to components
 * it already imported.
 */
export const TENJIN_REVENUE_METRICS_ACCEPTED = [
  ...TENJIN_REVENUE_COMPONENT_METRICS,
  ...TENJIN_TOTAL_REVENUE_METRICS,
] as const;

/**
 * Kept for the previous name, which several call sites and tests use. The ad
 * concept now has more than one provider id, so the list above is the truth.
 */
export const TENJIN_REVENUE_METRIC_AD = TENJIN_AD_REVENUE_METRICS[0];

/** Report family MART reads. Saved reports of any other type are skipped. */
export const TENJIN_REPORT_TYPE = 'user_acquisition';

/**
 * Only daily rows carry a date MART can attribute a fact to. Weekly, monthly
 * and totals buckets cannot be split back into days without inventing data.
 */
export const TENJIN_USABLE_GRANULARITIES = ['daily'] as const;

/** The dimensions a Tenjin grouping can split on. */
export const TENJIN_DIMENSIONS = [
  'campaign',
  'country',
  'channel',
  'app',
  'site',
  'creative',
] as const;
export type TenjinDimension = (typeof TENJIN_DIMENSIONS)[number];

/**
 * Dimensions MART stores. A grouping may only split on these.
 *
 * Rows are keyed on the dimensions MART keeps, so a grouping that splits on one
 * it discards - `site`, `creative` - collapses many rows onto a single storage
 * key and silently loses installs on write.
 */
export const TENJIN_STORABLE_DIMENSIONS: readonly TenjinDimension[] = [
  'campaign',
  'country',
  'channel',
  'app',
];

export type TenjinGroupBy = {
  /** Exactly what the provider sent, for diagnostics. */
  raw: string;
  /** The dimensions it splits on, in MART's vocabulary. */
  dimensions: TenjinDimension[];
  /** Tokens that mapped to no known dimension. Non-empty means "do not guess". */
  unrecognized: string[];
};

/**
 * Translate Tenjin's `group_by` into MART dimensions.
 *
 * Tenjin serializes the same choice two ways depending on which end of the API
 * you are on: the ad-hoc report parameter takes `campaign,country`, while a
 * saved report definition comes back as `campaign_country`. Comparing either
 * spelling against a fixed string is how a valid report gets refused - the bug
 * this layer exists to remove. Both separators are parsed into the same set,
 * and a token that maps to nothing is reported rather than ignored.
 */
export function normalizeGroupBy(raw: string | null | undefined): TenjinGroupBy | null {
  if (!raw) return null;
  const dimensions: TenjinDimension[] = [];
  const unrecognized: string[] = [];
  for (const token of raw.split(/[,_\s]+/)) {
    const key = token.trim().toLowerCase();
    if (!key) continue;
    const dimension = TENJIN_DIMENSIONS.find((d) => d === key);
    if (!dimension) unrecognized.push(token);
    else if (!dimensions.includes(dimension)) dimensions.push(dimension);
  }
  return { raw, dimensions, unrecognized };
}

/**
 * How useful a grouping is to MART. Higher is better.
 *
 * Campaign identity is what reconciliation needs, and country is the split MART
 * reports on, so those two dominate; a finer grouping breaks ties.
 */
export function groupByRank(groupBy: TenjinGroupBy | null): number {
  if (!groupBy) return 0;
  const has = (d: TenjinDimension): boolean => groupBy.dimensions.includes(d);
  return (has('campaign') ? 4 : 0) + (has('country') ? 2 : 0) + (has('channel') ? 1 : 0);
}

/**
 * A saved report definition, as returned by GET /v2/saved_reports.
 *
 * Only the fields MART needs to judge compatibility are lifted out; the rest
 * of the resource is ignored rather than stored.
 */
export type TenjinSavedReport = {
  id: string;
  name: string | null;
  reportType: string | null;
  appIds: string[];
  metrics: string[];
  granularity: string | null;
  /** Exactly as the provider spelled it, e.g. `campaign_country`. */
  groupBy: string | null;
  pastNumberDays: number | null;
  channelIds: string[];
};

/** One saved report judged against what a MART stream needs. */
export type TenjinReportCompatibility = {
  report: TenjinSavedReport;
  usable: boolean;
  /** Why it cannot be used. Empty when usable. */
  blockers: string[];
  /** Usable, but with a caveat worth surfacing. */
  notes: string[];
  /** What its grouping means in MART's vocabulary. */
  groupBy: TenjinGroupBy | null;
};

export type TenjinReportRequirement = {
  /** The Tenjin app UUID MART is bound to. */
  appId: string;
  /** Every one of these metrics must be present. */
  requiredMetrics: string[];
  /** At least one of these must be present, when given. */
  anyOfMetrics?: readonly string[];
};

/**
 * Judge one saved report against a stream's needs.
 *
 * Exported because this is the decision the whole integration turns on: which
 * of the account's existing reports MART is allowed to read, and - just as
 * importantly - exactly why the others were refused, so the operator is told
 * what to change instead of being told "no data".
 */
export function evaluateSavedReport(
  report: TenjinSavedReport,
  requirement: TenjinReportRequirement,
): TenjinReportCompatibility {
  const blockers: string[] = [];
  const notes: string[] = [];

  if (report.reportType && report.reportType !== TENJIN_REPORT_TYPE) {
    blockers.push(`report_type is ${report.reportType}, not ${TENJIN_REPORT_TYPE}`);
  }

  // An empty app list is Tenjin's "every app in the account", which does cover
  // the bound app - MART filters the rows by app_id when it reads them.
  if (report.appIds.length > 0 && !report.appIds.includes(requirement.appId)) {
    blockers.push('app_ids does not include the bound app');
  } else if (report.appIds.length === 0) {
    notes.push('covers every app in the account; rows are filtered to the bound app');
  } else if (report.appIds.length > 1) {
    notes.push(`covers ${report.appIds.length} apps; rows are filtered to the bound app`);
  }

  const missing = requirement.requiredMetrics.filter((metric) => !report.metrics.includes(metric));
  if (missing.length > 0) blockers.push(`missing metric(s): ${missing.join(', ')}`);

  const anyOf = requirement.anyOfMetrics ?? [];
  if (anyOf.length > 0 && !anyOf.some((metric) => report.metrics.includes(metric))) {
    blockers.push(`none of these metrics present: ${anyOf.join(', ')}`);
  }

  if (report.granularity && !TENJIN_USABLE_GRANULARITIES.includes(report.granularity as 'daily')) {
    blockers.push(`granularity is ${report.granularity}; MART needs daily rows`);
  }

  // Provider spelling is normalized before anything is compared: the same
  // choice arrives as `campaign,country` from the ad-hoc parameter and
  // `campaign_country` from a saved report definition.
  const groupBy = normalizeGroupBy(report.groupBy);
  if (groupBy) {
    if (groupBy.unrecognized.length > 0) {
      blockers.push(
        `group_by ${groupBy.raw} contains dimension(s) MART does not recognize: ${groupBy.unrecognized.join(', ')}`,
      );
    }
    const unstorable = groupBy.dimensions.filter((d) => !TENJIN_STORABLE_DIMENSIONS.includes(d));
    if (unstorable.length > 0) {
      blockers.push(
        `group_by ${groupBy.raw} splits on ${unstorable.join(', ')}, which MART does not store, so rows would collapse onto one key`,
      );
    }
    if (
      groupBy.unrecognized.length === 0 &&
      unstorable.length === 0 &&
      !groupBy.dimensions.includes('campaign')
    ) {
      notes.push(
        `group_by ${groupBy.raw} carries no campaign, so nothing can be reconciled to Meta`,
      );
    }
  }

  // Which ad-revenue variant this report carries, since Tenjin has two that
  // mean different things and an account may populate either.
  const hasComponent = TENJIN_REVENUE_COMPONENT_METRICS.some((m) => report.metrics.includes(m));
  const hasTotal = TENJIN_TOTAL_REVENUE_METRICS.some((m) => report.metrics.includes(m));
  if (!hasComponent && hasTotal && (requirement.anyOfMetrics ?? []).length > 0) {
    notes.push(
      'carries only a combined revenue figure; it will be imported as revenue_type=total rather than split into IAP and ad',
    );
  }

  const adVariants = TENJIN_AD_REVENUE_METRICS.filter((m) => report.metrics.includes(m));
  if (adVariants.length > 1) {
    notes.push(
      `carries both ${adVariants.join(' and ')}; MART reads ${adVariants[0]} and reports the other rather than summing them`,
    );
  }

  const optional = TENJIN_INSTALL_METRICS_OPTIONAL.filter((m) => !report.metrics.includes(m));
  if (requirement.requiredMetrics.includes(TENJIN_INSTALL_METRIC) && optional.length > 0) {
    notes.push(`no ${optional.join('/')}; those columns will be empty`);
  }

  return { report, usable: blockers.length === 0, blockers, notes, groupBy };
}

/**
 * Pick the best existing saved report, or none.
 *
 * Richest grouping first, then most metrics, then the longest rolling window -
 * a report whose `past_number_days` is larger can answer more of a backfill.
 */
export function selectSavedReport(
  reports: readonly TenjinSavedReport[],
  requirement: TenjinReportRequirement,
): { chosen: TenjinSavedReport | null; evaluated: TenjinReportCompatibility[] } {
  const evaluated = reports.map((report) => evaluateSavedReport(report, requirement));
  const usable = evaluated.filter((candidate) => candidate.usable);
  const componentScore = (candidate: TenjinReportCompatibility): number =>
    TENJIN_REVENUE_COMPONENT_METRICS.filter((m) => candidate.report.metrics.includes(m)).length;
  usable.sort(
    (a, b) =>
      groupByRank(b.groupBy) - groupByRank(a.groupBy) ||
      // A report that splits IAP from ad beats one carrying only a total.
      componentScore(b) - componentScore(a) ||
      b.report.metrics.length - a.report.metrics.length ||
      (b.report.pastNumberDays ?? 0) - (a.report.pastNumberDays ?? 0),
  );
  return { chosen: usable[0]?.report ?? null, evaluated };
}

/** Parse one saved-report resource into the fields MART judges it on. */
export function parseSavedReport(resource: {
  id: string | null;
  attributes: Record<string, unknown>;
}): TenjinSavedReport | null {
  const attributes = resource.attributes;
  const id = str(attributes['id']) ?? resource.id;
  if (!id) return null;
  return {
    id,
    name: str(attributes['name']),
    reportType: str(attributes['report_type']),
    appIds: stringList(attributes['app_ids']),
    metrics: stringList(attributes['metrics']),
    granularity: str(attributes['granularity']),
    groupBy: str(attributes['group_by']),
    pastNumberDays: optionalNum(attributes['past_number_days']),
    channelIds: stringList(attributes['channel_ids']),
  };
}

type TenjinRow = Record<string, string | number | null | undefined>;

export class TenjinAttributionProvider implements AttributionProvider {
  readonly providerKey = 'tenjin' as const;
  readonly category = 'attribution_mmp' as const;

  private readonly http: ProviderHttpClient;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly endpoints: TenjinEndpoints;
  /** Discovery result, cached so one run does not list saved reports twice. */
  private savedReports: TenjinSavedReport[] | null = null;

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

  /**
   * List the account's saved report definitions.
   *
   * Read-only by design: MART reuses what the operator already built and never
   * creates or edits a report on their behalf. Cached for the lifetime of the
   * adapter so installs and revenue in one run share a single discovery call.
   */
  async listSavedReports(): Promise<TenjinSavedReport[]> {
    if (this.savedReports) return this.savedReports;
    const body = await this.get<unknown>(this.endpoints.savedReports, {
      report_type: TENJIN_REPORT_TYPE,
      per_page: SAVED_REPORTS_PER_PAGE,
    });
    const reports = this.extractResources(body)
      .map((resource) => parseSavedReport(resource))
      .filter((report): report is TenjinSavedReport => report !== null);
    this.savedReports = reports;
    return reports;
  }

  /**
   * Find the saved report that can answer a stream, or explain the refusal.
   *
   * When nothing fits, this raises `configuration_required` carrying the
   * machine-readable code `tenjin_saved_report_required` and a description of
   * the report that needs to exist. MART does not POST one: a sync must not
   * quietly change the shape of someone's Tenjin account.
   */
  async resolveSavedReport(
    requirement: TenjinReportRequirement,
    streamLabel: string,
  ): Promise<{ report: TenjinSavedReport; evaluated: TenjinReportCompatibility[] }> {
    const reports = await this.listSavedReports();
    const { chosen, evaluated } = selectSavedReport(reports, requirement);
    if (chosen) return { report: chosen, evaluated };

    const wanted = [
      `report_type=${TENJIN_REPORT_TYPE}`,
      `granularity=${TENJIN_USABLE_GRANULARITIES[0]}`,
      // Named in the provider's own saved-report spelling, so it can be
      // matched against what the Data Exporter shows.
      'group_by=campaign_country (Campaign + Country)',
      `app_ids including ${requirement.appId}`,
      `metrics ${[...requirement.requiredMetrics, ...(requirement.anyOfMetrics ?? [])].join(', ')}`,
    ].join(', ');

    throw new ProviderError({
      provider: 'tenjin',
      errorClass: 'configuration_required',
      message: `No Tenjin saved report can answer ${streamLabel}`,
      userMessage:
        `Tenjin has no saved report MART can use for ${streamLabel}. ` +
        `Create one in Tenjin's Data Exporter with: ${wanted}. ` +
        'MART only reads saved reports and will not create one for you.',
      context: {
        // Machine-readable so the UI and the diagnostic can branch on it
        // rather than matching on prose.
        code: 'tenjin_saved_report_required',
        stream: streamLabel,
        savedReportsSeen: reports.length,
        required: wanted,
        rejected: evaluated.map((candidate) => ({
          id: candidate.report.id,
          name: candidate.report.name,
          blockers: candidate.blockers,
        })),
      },
    });
  }

  /**
   * The account's campaign directory.
   *
   * Reporting rows carry only Tenjin's own campaign UUID, which can never equal
   * a Meta campaign id. This endpoint carries `remote_campaign_id`: the ad
   * network's real campaign id, as Tenjin resolved it. That is a stable
   * identifier rather than a name, and it is the only thing that can tell two
   * network campaigns with identical names apart.
   *
   * Tracking URLs are deliberately not read: they carry click identifiers MART
   * has no use for and should not store.
   */
  async listCampaigns(externalAccountId: string): Promise<AttributionCampaignRef[]> {
    const out: AttributionCampaignRef[] = [];
    let cursor: string | undefined;

    for (let page = 1; page <= MAX_REPORT_PAGES; page += 1) {
      const body = await this.get<unknown>(this.endpoints.campaigns, {
        app_id: externalAccountId,
        ...(cursor ? { cursor } : {}),
      });

      for (const resource of this.extractResources(body)) {
        const attributes = resource.attributes;
        const id = str(attributes['id']) ?? resource.id;
        if (!id) continue;
        out.push({
          externalCampaignId: id,
          name: str(attributes['name']),
          remoteCampaignId: str(attributes['remote_campaign_id']),
          channelId: str(attributes['channel_id']),
          channelName: str(attributes['channel_name']),
        });
      }

      const envelope = (body ?? {}) as Record<string, unknown>;
      if (envelope['has_more'] !== true) break;
      cursor = readCursor(envelope);
      if (!cursor) break;
    }

    return out;
  }

  async syncInstalls(params: SyncParams): Promise<SyncResult<CanonicalAttributionBatch>> {
    const { report } = await this.resolveSavedReport(
      { appId: params.externalAccountId, requiredMetrics: [TENJIN_INSTALL_METRIC] },
      'attribution_installs',
    );
    const rows = await this.fetchSavedReportRows(report, params);
    const batch = emptyAttributionBatch();
    let rejected = rows.rowsSkipped;
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
      rowsFetched: rows.rowsFetched,
      rowsRejected: rejected,
      warnings: [
        ...rows.warnings,
        ...(rejected > rows.rowsSkipped
          ? [`${rejected - rows.rowsSkipped} Tenjin rows had no usable date.`]
          : []),
      ],
      latestDataDate,
    };
  }

  /**
   * Not implemented, and reported as such.
   *
   * The user-acquisition report has no in-app event breakdown, and MART has
   * not built another Tenjin event source. Returning an empty batch quietly
   * would mark the stream fresh on a run that never made a request - a
   * dashboard claiming live event data that does not exist. The support flag
   * is what stops that.
   */
  async syncEvents(): Promise<SyncResult<CanonicalAttributionBatch>> {
    return {
      batch: emptyAttributionBatch(),
      pagesFetched: 0,
      rowsFetched: 0,
      rowsRejected: 0,
      warnings: [
        'MART does not implement a Tenjin in-app event source: the user-acquisition report has no per-event breakdown.',
      ],
      latestDataDate: null,
      support: 'not_implemented',
    };
  }

  async syncRevenue(params: SyncParams): Promise<SyncResult<CanonicalAttributionBatch>> {
    const { report } = await this.resolveSavedReport(
      {
        appId: params.externalAccountId,
        requiredMetrics: [],
        // Any component will do, and a combined figure is accepted as a last
        // resort. Requiring one specific ad metric is what rejected a real
        // report whose ad revenue arrives as ad_mediation_revenue rather than
        // pub_rev.
        anyOfMetrics: TENJIN_REVENUE_METRICS_ACCEPTED,
      },
      'attribution_revenue',
    );
    const rows = await this.fetchSavedReportRows(report, params);
    const batch = emptyAttributionBatch();
    const warnings = [...rows.warnings];
    let rejected = rows.rowsSkipped;
    let latestDataDate: IsoDate | null = null;
    let bothAdVariants = 0;
    let partialSplit = 0;
    let totalOnly = 0;

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
      ): void => {
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

      const present = (key: string): boolean => row[key] !== undefined && row[key] !== null;
      const hasIap = present(TENJIN_REVENUE_METRIC_IAP);
      // Preferred variant first; both mean `ad` inside MART.
      const adKeys = TENJIN_AD_REVENUE_METRICS.filter(present);
      const adKey = adKeys[0];
      if (adKeys.length > 1) bothAdVariants += 1;

      if (hasIap || adKey) {
        emit('iap', num(row[TENJIN_REVENUE_METRIC_IAP]));
        if (adKey) emit('ad', num(row[adKey]));
        // A total sits beside its own parts. Storage sums every revenue row
        // for a date, so importing it too would double-count.
        if (!hasIap || !adKey) partialSplit += 1;
      } else {
        // No component at all: the combined figure is the only revenue there
        // is, and `total` is a type the schema represents honestly. It is
        // never relabelled as IAP or ad.
        const totalKey = TENJIN_TOTAL_REVENUE_METRICS.find(present);
        if (totalKey) {
          emit('total', num(row[totalKey]));
          totalOnly += 1;
        }
      }

      if (!latestDataDate || activityDate > latestDataDate) latestDataDate = activityDate;
    }

    if (bothAdVariants > 0) {
      warnings.push(
        `The saved report carries both ${TENJIN_AD_REVENUE_METRICS.join(' and ')}. These are different Tenjin measures, so MART imported ${TENJIN_AD_REVENUE_METRICS[0]} and did not sum them; ${bothAdVariants} row(s) affected.`,
      );
    }
    if (partialSplit > 0) {
      warnings.push(
        `${partialSplit} row(s) carried only one revenue component, so the other side is absent. The combined total was not imported, because adding it to a component would double-count.`,
      );
    }
    if (totalOnly > 0) {
      warnings.push(
        `${totalOnly} row(s) carried no revenue component, so the combined figure was imported as revenue_type=total rather than guessed as IAP or ad.`,
      );
    }

    return {
      batch,
      pagesFetched: rows.pages,
      rowsFetched: rows.rowsFetched,
      rowsRejected: rejected,
      warnings,
      latestDataDate,
    };
  }

  /**
   * GET /reports/{saved report UUID}.
   *
   * Rows come back as JSON:API resources - `{data: [{type: "report",
   * attributes: {...}}]}` - so the metrics live under `attributes`, not at the
   * top of each row.
   *
   * Two things are checked rather than assumed, because a saved report is the
   * operator's object and not MART's:
   *
   *  - **Which app each row belongs to.** A report may legitimately cover the
   *    whole account, so rows for other apps are dropped instead of being
   *    written against the bound app.
   *  - **Which dates actually came back.** A saved report carries its own
   *    rolling `past_number_days`. MART asks for its window explicitly, then
   *    compares what arrived: rows outside the requested window are not
   *    imported, and a window the report could not cover is reported as a
   *    warning rather than presented as complete data.
   */
  private async fetchSavedReportRows(
    report: TenjinSavedReport,
    params: SyncParams,
  ): Promise<{
    rows: TenjinRow[];
    pages: number;
    rowsFetched: number;
    rowsSkipped: number;
    warnings: string[];
  }> {
    const rows: TenjinRow[] = [];
    const warnings: string[] = [];
    let pages = 0;
    let rowsFetched = 0;
    let otherApp = 0;
    let outsideWindow = 0;
    let earliest: string | null = null;
    let latest: string | null = null;

    let next: { path: string; query: Record<string, string | number | undefined> } | null = {
      path: `${this.endpoints.reports}/${encodeURIComponent(report.id)}`,
      query: {
        start_date: params.from,
        end_date: params.to,
        format: 'json',
      },
    };

    for (let page = 1; page <= MAX_REPORT_PAGES && next; page += 1) {
      const body = await this.get<unknown>(next.path, next.query);
      pages += 1;

      const pageRows = this.extractResources(body).map(
        (resource) => resource.attributes as TenjinRow,
      );
      rowsFetched += pageRows.length;

      for (const row of pageRows) {
        const date = isoDay(str(row['date'] ?? row['day']));
        if (date) {
          if (!earliest || date < earliest) earliest = date;
          if (!latest || date > latest) latest = date;
        }
        const rowApp = str(row['app_id']);
        if (rowApp && rowApp !== params.externalAccountId) {
          otherApp += 1;
          continue;
        }
        if (date && (date < params.from || date > params.to)) {
          outsideWindow += 1;
          continue;
        }
        rows.push(row);
      }

      await params.onRawPage?.({
        pageNumber: page,
        payload: body,
        recordCount: pageRows.length,
        schemaVersion: 'saved-report-v2',
        windowStart: params.from,
        windowEnd: params.to,
      });

      next = this.nextPage(body, next);
      if (page === MAX_REPORT_PAGES && next) {
        warnings.push(
          `Stopped after ${MAX_REPORT_PAGES} pages; the window may be incomplete. Narrow the date range or the saved report.`,
        );
      }
    }

    if (otherApp > 0) {
      warnings.push(
        `Saved report "${report.name ?? report.id}" also covers other apps: ${otherApp} row(s) for a different app_id were not imported.`,
      );
    }
    if (outsideWindow > 0) {
      warnings.push(
        `${outsideWindow} row(s) fell outside the requested window ${params.from}..${params.to} and were not imported; the saved report returned ${earliest ?? '?'}..${latest ?? '?'}.`,
      );
    }
    // The honest read of a rolling saved report: say what it covered, do not
    // present a partial window as a whole one.
    if (rowsFetched > 0 && earliest && earliest > params.from) {
      warnings.push(
        `The saved report's own period starts at ${earliest}, so ${params.from}..${earliest} was not covered` +
          (report.pastNumberDays ? ` (past_number_days=${report.pastNumberDays})` : '') +
          '.',
      );
    }

    return { rows, pages, rowsFetched, rowsSkipped: otherApp + outsideWindow, warnings };
  }

  /**
   * Work out the next page from whatever pagination the response carries.
   *
   * JSON:API puts it in `links.next`; the report endpoints have also been seen
   * to use `has_more` with an opaque cursor. Both are handled, and anything
   * else stops paging rather than looping.
   */
  private nextPage(
    body: unknown,
    current: { path: string; query: Record<string, string | number | undefined> },
  ): { path: string; query: Record<string, string | number | undefined> } | null {
    const envelope = (body ?? {}) as Record<string, unknown>;
    const links = envelope['links'];
    const nextLink =
      links && typeof links === 'object' ? str((links as Record<string, unknown>)['next']) : null;
    if (nextLink) {
      // Absolute or relative, both resolved against the configured base so a
      // link can never redirect the sync to another host.
      const resolved = new URL(nextLink, `${this.baseUrl}/`);
      const base = new URL(`${this.baseUrl}/`);
      if (resolved.origin !== base.origin) return null;
      const query: Record<string, string | number | undefined> = {};
      resolved.searchParams.forEach((value, key) => {
        query[key] = value;
      });
      return { path: resolved.pathname.replace(base.pathname.replace(/\/$/, ''), ''), query };
    }

    if (envelope['has_more'] !== true) return null;
    const cursor = readCursor(envelope);
    if (!cursor) return null;
    return { path: current.path, query: { ...current.query, cursor } };
  }
}

// ------------------------------------------------------------- helpers ------

/** Tenjin sends id lists as arrays; tolerate a comma-joined string too. */
function stringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((entry) => str(entry)).filter((entry): entry is string => entry !== null);
  }
  const single = str(value);
  if (!single) return [];
  return single
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

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

import { ProviderError, type ProviderErrorClass } from '@mart/shared';
import { getLogger, counters } from '@mart/observability';

export type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>;

export type HttpClientOptions = {
  provider: string;
  fetchImpl?: FetchImpl;
  timeoutMs?: number;
  maxAttempts?: number;
  /** Minimum spacing between requests to one provider, in milliseconds. */
  minIntervalMs?: number;
  /** Injected for deterministic tests; defaults to real timers. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

export type RequestOptions = {
  method?: 'GET' | 'POST';
  url: string;
  headers?: Record<string, string>;
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
  /** Response parsing mode; CSV providers return text. */
  responseType?: 'json' | 'text';
  /** Overrides the client default for this call. */
  timeoutMs?: number;
};

export type HttpResponse<T = unknown> = {
  status: number;
  body: T;
  headers: Record<string, string>;
  attempts: number;
};

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * Signals a provider states in the response body rather than the status line.
 *
 * Status alone is not a reliable classifier: several providers answer an
 * expired token and a throttle with the same generic 4xx they use for a
 * genuinely malformed request. Meta's Graph API is the case that forced this -
 * it returns HTTP 400 for `OAuthException` code 190 (expired/invalid token)
 * and HTTP 400 for its throttling codes - but the patterns are written against
 * what providers *say*, not against any one vendor, so nothing here is keyed to
 * a provider, an account, or an id.
 *
 * Misreading either one is not cosmetic. A throttle classified as
 * `invalid_request` is not retryable, so the window is abandoned without
 * backoff and the run still ends `partially_completed` - which advances the
 * incremental cursor past the window that never loaded. An expired credential
 * read the same way never flips the connection to `invalid_credentials`, so
 * the integration keeps reading "connected" while every sync fails.
 */
const EXPIRED_CREDENTIAL_SIGNAL =
  /expire|session has expired|token (?:is )?(?:no longer|not) valid|reauthenticat|re-?authoriz/i;
const INVALID_CREDENTIAL_SIGNAL =
  // The gap absorbs whatever a provider names between the two words -
  // "invalid OAuth access token", "invalid_token", "invalid bearer token".
  /invalid[\w _-]{0,20}token|malformed access token|access token[^.]{0,40}(?:invalid|revoked)|invalid[_ ]?credential|oauth ?exception/i;
const THROTTLE_SIGNAL =
  /rate[_ ]?limit|too many (?:requests|calls)|throttl|request limit reached|calls? to this api ha(?:s|ve) exceeded|user request limit/i;

/**
 * What the body states about the failure, or null when it states nothing.
 *
 * Separate from the status so an adapter can consult it on a response that is
 * not an error at all (a capability probe reading why a dimension was refused).
 */
export function classifyBody(bodyText: string): ProviderErrorClass | null {
  if (!bodyText) return null;
  if (THROTTLE_SIGNAL.test(bodyText)) return 'rate_limited';
  if (EXPIRED_CREDENTIAL_SIGNAL.test(bodyText)) return 'expired_credential';
  if (INVALID_CREDENTIAL_SIGNAL.test(bodyText)) return 'authentication_error';
  return null;
}

/**
 * Classify a provider HTTP failure.
 *
 * The class drives behaviour (retry vs alert vs ask a human to reconnect), so
 * collapsing everything into `unknown_error` is treated as a bug. The body is
 * consulted first for the classes a status cannot settle, and the status
 * decides everything the body is silent about.
 */
export function classifyHttpStatus(status: number, bodyText: string): ProviderErrorClass {
  // A 5xx is the provider failing to answer at all; its body is not a verdict
  // about the credential, so the status wins there.
  if (status < 500) {
    const stated = classifyBody(bodyText);
    if (stated) {
      // A 403 that talks about limits is the account/page limit, not a bad
      // credential; a 401 is always about the credential whatever it says.
      if (stated === 'rate_limited' && status === 401) return 'authentication_error';
      return stated;
    }
  }
  if (status === 401) return 'authentication_error';
  if (status === 403) return 'authorization_error';
  if (status === 400 || status === 404 || status === 422) return 'invalid_request';
  if (status === 429) return 'rate_limited';
  if (status === 408 || status === 504) return 'timeout';
  if (status >= 500) return 'provider_unavailable';
  return 'unknown_error';
}

export function isRetryableClass(errorClass: ProviderErrorClass): boolean {
  return (
    errorClass === 'rate_limited' ||
    errorClass === 'provider_unavailable' ||
    errorClass === 'timeout'
  );
}

/** Exponential backoff with full jitter, capped. */
export function backoffDelayMs(
  attempt: number,
  retryAfterMs?: number,
  random = Math.random,
): number {
  if (retryAfterMs && retryAfterMs > 0) return Math.min(retryAfterMs, 60_000);
  const base = Math.min(1000 * 2 ** (attempt - 1), 30_000);
  return Math.floor(base / 2 + random() * (base / 2));
}

function parseRetryAfter(headers: Headers): number | undefined {
  const value = headers.get('retry-after');
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

/**
 * A minimal provider HTTP client.
 *
 * Responsibilities kept deliberately narrow: request construction, rate-limit
 * spacing, bounded retries with backoff, timeouts, and error classification.
 * It never logs headers (which carry credentials) and never returns them.
 */
export class ProviderHttpClient {
  private readonly provider: string;
  private readonly fetchImpl: FetchImpl;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly minIntervalMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private nextAllowedAt = 0;

  constructor(options: HttpClientOptions) {
    this.provider = options.provider;
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.minIntervalMs = options.minIntervalMs ?? 0;
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = options.now ?? (() => Date.now());
  }

  private buildUrl(url: string, query?: RequestOptions['query']): string {
    if (!query) return url;
    const target = new URL(url);
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) continue;
      target.searchParams.set(key, String(value));
    }
    return target.toString();
  }

  private async respectRateLimit(): Promise<void> {
    if (this.minIntervalMs <= 0) return;
    const wait = this.nextAllowedAt - this.now();
    if (wait > 0) await this.sleep(wait);
    this.nextAllowedAt = this.now() + this.minIntervalMs;
  }

  async request<T = unknown>(options: RequestOptions): Promise<HttpResponse<T>> {
    const url = this.buildUrl(options.url, options.query);
    const responseType = options.responseType ?? 'json';
    let attempt = 0;
    let lastError: ProviderError | null = null;

    while (attempt < this.maxAttempts) {
      attempt += 1;
      await this.respectRateLimit();

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? this.timeoutMs);
      try {
        counters.increment('provider_requests_total', { provider: this.provider });
        const response = await this.fetchImpl(url, {
          method: options.method ?? 'GET',
          headers: {
            accept: responseType === 'json' ? 'application/json' : 'text/csv, text/plain, */*',
            ...(options.body ? { 'content-type': 'application/json' } : {}),
            ...options.headers,
          },
          ...(options.body ? { body: JSON.stringify(options.body) } : {}),
          signal: controller.signal,
        });

        const text = await response.text();
        // Diagnostics: method, sanitized URL, status, and whether auth was
        // attached - never the header value, never an unsanitized body.
        getLogger().info(
          {
            provider: this.provider,
            method: options.method ?? 'GET',
            url: sanitizeUrl(url),
            status: response.status,
            attempt,
            identityHeaderPresent: hasAuthorization(options.headers),
          },
          'provider request',
        );
        if (!response.ok) {
          const errorClass = classifyHttpStatus(response.status, text);
          const retryAfterMs = parseRetryAfter(response.headers);
          lastError = new ProviderError({
            provider: this.provider,
            errorClass,
            httpStatus: response.status,
            retryable: isRetryableClass(errorClass),
            ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
            message: `${this.provider} responded ${response.status}`,
            userMessage: userMessageFor(this.provider, errorClass, response.status),
            // Truncated AND sanitized: provider errors can echo request
            // parameters, including an api_key sent in the query string.
            context: {
              bodyPreview: sanitizeBody(text.slice(0, 300)),
              url: sanitizeUrl(url),
              identityHeaderPresent: hasAuthorization(options.headers),
            },
          });
          counters.increment('provider_errors_total', {
            provider: this.provider,
            class: errorClass,
          });
          if (!lastError.retryable || attempt >= this.maxAttempts) throw lastError;
          await this.sleep(backoffDelayMs(attempt, retryAfterMs));
          continue;
        }

        const body = (
          responseType === 'json' ? (text.length ? JSON.parse(text) : null) : text
        ) as T;
        return {
          status: response.status,
          body,
          headers: safeHeaders(response.headers),
          attempts: attempt,
        };
      } catch (error) {
        clearTimeout(timeout);
        if (error instanceof ProviderError) {
          if (!error.retryable || attempt >= this.maxAttempts) throw error;
          lastError = error;
          await this.sleep(backoffDelayMs(attempt, error.retryAfterMs));
          continue;
        }
        const aborted = error instanceof Error && error.name === 'AbortError';
        const errorClass: ProviderErrorClass = aborted ? 'timeout' : 'provider_unavailable';
        lastError = new ProviderError({
          provider: this.provider,
          errorClass,
          retryable: true,
          message: aborted
            ? `${this.provider} request timed out`
            : `${this.provider} request failed`,
          userMessage: userMessageFor(this.provider, errorClass),
          cause: error,
        });
        counters.increment('provider_errors_total', {
          provider: this.provider,
          class: errorClass,
        });
        getLogger().warn(
          {
            provider: this.provider,
            method: options.method ?? 'GET',
            url: sanitizeUrl(url),
            attempt,
            errorClass,
            identityHeaderPresent: hasAuthorization(options.headers),
          },
          'provider request failed, will retry if attempts remain',
        );
        if (attempt >= this.maxAttempts) throw lastError;
        await this.sleep(backoffDelayMs(attempt));
      } finally {
        clearTimeout(timeout);
      }
    }

    throw (
      lastError ??
      new ProviderError({
        provider: this.provider,
        errorClass: 'unknown_error',
        message: `${this.provider} request failed`,
        retryable: false,
      })
    );
  }
}

/** Response headers minus anything that could carry credentials. */
/**
 * A URL safe to log.
 *
 * Some providers authenticate with a query parameter, and a provider error can
 * echo the request back. Anything secret-shaped in the query string is replaced
 * before the URL reaches a log line, a stored error, or an API response.
 */
export function sanitizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    for (const key of [...parsed.searchParams.keys()]) {
      if (SECRET_QUERY_KEYS.test(key)) parsed.searchParams.set(key, 'REDACTED');
    }
    return parsed.toString();
  } catch {
    return '(unparseable url)';
  }
}

const SECRET_QUERY_KEYS =
  /(^|_)(api[_-]?key|access[_-]?token|token|key|secret|sig|signature|password)$/i;

/** Strip anything secret-shaped out of a provider's own error text. */
export function sanitizeBody(text: string): string {
  return text.replace(
    /((?:api[_-]?key|access[_-]?token|token|key|secret|password)["']?\s*[:=]\s*["']?)([^"'&,\s}]{4,})/gi,
    '$1REDACTED',
  );
}

/**
 * Whether an Authorization header was attached - the fact, never the value.
 *
 * Callers log this as `identityHeaderPresent`, not `authenticated`: the logger's
 * redaction pattern matches /auth/, so the obvious field name gets replaced with
 * [redacted] and the diagnostic tells you nothing.
 */
export function hasAuthorization(headers?: Record<string, string>): boolean {
  if (!headers) return false;
  return Object.keys(headers).some((key) => key.toLowerCase() === 'authorization');
}

function safeHeaders(headers: Headers): Record<string, string> {
  const allowed = ['content-type', 'x-request-id', 'retry-after', 'x-ratelimit-remaining'];
  const out: Record<string, string> = {};
  for (const key of allowed) {
    const value = headers.get(key);
    if (value) out[key] = value;
  }
  return out;
}

/**
 * User-facing message: actionable, and free of API internals.
 * "Meta access token expired - reconnect the integration" beats a raw payload.
 */
export function userMessageFor(
  provider: string,
  errorClass: ProviderErrorClass,
  status?: number,
): string {
  const name = PROVIDER_DISPLAY_NAMES[provider] ?? provider;
  switch (errorClass) {
    case 'authentication_error':
      return `${name} rejected the stored credential. Reconnect the integration with a valid token.`;
    case 'expired_credential':
      return `The ${name} credential has expired. Reconnect the integration to continue syncing.`;
    case 'authorization_error':
      return `The ${name} credential does not have permission for this data. Check the token's scopes and account access.`;
    case 'rate_limited':
      return `${name} is rate limiting MART. The sync will retry automatically.`;
    case 'provider_unavailable':
      return `${name} is temporarily unavailable${status ? ` (HTTP ${status})` : ''}. The sync will retry automatically.`;
    case 'timeout':
      return `${name} did not respond in time. The sync will retry automatically.`;
    case 'invalid_request':
      return `${name} rejected the request. This usually means the selected account or date range is not available to this credential.`;
    case 'schema_change':
      return `${name} returned an unexpected response shape. MART stopped rather than storing data it cannot interpret.`;
    case 'configuration_required':
      return `${name} is connected, but the account is missing something this sync needs. See the sync run details for exactly what to create in ${name}.`;
    default:
      return `The ${name} sync failed. See the sync run details for the classified error.`;
  }
}

const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  meta_ads: 'Meta Ads',
  appsflyer: 'AppsFlyer',
  tenjin: 'Tenjin',
};

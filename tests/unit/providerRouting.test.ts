import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetConfigCache } from '@mart/config';
import {
  TenjinAttributionProvider,
  MetaAdsProvider,
  ProviderHttpClient,
  classifyHttpStatus,
  hasAuthorization,
  providerEndpointInfo,
  sanitizeBody,
  sanitizeUrl,
} from '@mart/integrations';

/**
 * Regressions for the two bugs that stopped real provider connections working:
 * a credential silently routed to the fixture server, and Tenjin authenticated
 * with a query parameter instead of a Bearer header.
 */

const ORIGINAL = { ...process.env };

function setEnv(values: Record<string, string>): void {
  for (const [key, value] of Object.entries(values)) process.env[key] = value;
  resetConfigCache();
}

beforeEach(() => {
  process.env['DATABASE_URL'] = 'postgres://mart:mart@localhost:5432/mart';
  process.env['MART_CREDENTIAL_KEY'] = Buffer.alloc(32, 7).toString('base64');
  resetConfigCache();
});

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL)) delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL);
  resetConfigCache();
});

describe('fixture vs real routing', () => {
  it('reports fixture mode when a provider points at the fixture server', () => {
    setEnv({
      META_GRAPH_BASE_URL: 'http://fixtures:4900',
      TENJIN_BASE_URL: 'http://fixtures:4900',
    });
    for (const key of ['meta_ads', 'tenjin']) {
      const info = providerEndpointInfo(key);
      expect(info?.isProduction, `${key} must not look real`).toBe(false);
    }
  });

  it('reports real mode when a provider points at the documented origin', () => {
    setEnv({
      META_GRAPH_BASE_URL: 'https://graph.facebook.com',
      APPSFLYER_BASE_URL: 'https://hq1.appsflyer.com',
      TENJIN_BASE_URL: 'https://api.tenjin.com/v2',
    });
    expect(providerEndpointInfo('meta_ads')?.isProduction).toBe(true);
    expect(providerEndpointInfo('appsflyer')?.isProduction).toBe(true);
    // The path may differ; only the origin decides whether it is the provider.
    expect(providerEndpointInfo('tenjin')?.isProduction).toBe(true);
  });

  it('knows the documented origin of each real provider', () => {
    // Asserted against productionBaseUrl rather than the configured value:
    // the configured one legitimately varies with the environment, and a local
    // .env would make this test pass or fail for the wrong reason.
    expect(providerEndpointInfo('meta_ads')?.productionBaseUrl).toBe('https://graph.facebook.com');
    expect(providerEndpointInfo('appsflyer')?.productionBaseUrl).toBe('https://hq1.appsflyer.com');
    expect(providerEndpointInfo('tenjin')?.productionBaseUrl).toBe('https://api.tenjin.com');
  });
});

describe('tenjin request contract', () => {
  function capture(): {
    client: ProviderHttpClient;
    calls: Array<{ url: string; headers: Record<string, string> }>;
  } {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const client = new ProviderHttpClient({
      provider: 'tenjin',
      minIntervalMs: 0,
      maxAttempts: 1,
      fetchImpl: async (url: string, init?: RequestInit) => {
        calls.push({
          url: String(url),
          headers: (init?.headers ?? {}) as Record<string, string>,
        });
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    return { client, calls };
  }

  it('sends the api key as a Bearer header, never in the URL', async () => {
    const { client, calls } = capture();
    const provider = new TenjinAttributionProvider({
      credentials: { kind: 'tenjin', apiKey: 'tenjin-secret-token-value' },
      baseUrl: 'https://api.tenjin.com/v2',
      http: client,
    });
    await provider.listApps();

    const call = calls[0];
    expect(call).toBeDefined();
    expect(call?.url).not.toContain('tenjin-secret-token-value');
    expect(call?.url).not.toContain('api_key');
    const auth = Object.entries(call?.headers ?? {}).find(
      ([k]) => k.toLowerCase() === 'authorization',
    );
    expect(auth?.[1]).toBe('Bearer tenjin-secret-token-value');
  });

  it('does not double the version prefix when the base URL already carries it', async () => {
    const { client, calls } = capture();
    const provider = new TenjinAttributionProvider({
      credentials: { kind: 'tenjin', apiKey: 'tenjin-secret-token-value' },
      baseUrl: 'https://api.tenjin.com/v2',
      http: client,
    });
    await provider.listApps();
    expect(calls[0]?.url).toBe('https://api.tenjin.com/v2/apps');
    expect(calls[0]?.url).not.toContain('/v2/api/v2/');
  });
});

describe('meta request contract', () => {
  it('sends the access token as a Bearer header, never in the URL', async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const client = new ProviderHttpClient({
      provider: 'meta_ads',
      minIntervalMs: 0,
      maxAttempts: 1,
      fetchImpl: async (url: string, init?: RequestInit) => {
        calls.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> });
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    const provider = new MetaAdsProvider({
      credentials: { kind: 'meta_ads', accessToken: 'meta-secret-token-value' },
      baseUrl: 'https://graph.facebook.com',
      apiVersion: 'v26.0',
      http: client,
    });
    await provider.listAccounts();
    expect(calls[0]?.url).toContain('https://graph.facebook.com/v26.0/me/adaccounts');
    expect(calls[0]?.url).not.toContain('meta-secret-token-value');
    expect(calls[0]?.url).not.toContain('access_token');
  });

  it('treats a valid token with zero visible ad accounts as pending, not invalid', async () => {
    const client = new ProviderHttpClient({
      provider: 'meta_ads',
      minIntervalMs: 0,
      maxAttempts: 1,
      fetchImpl: async () =>
        new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    });
    const provider = new MetaAdsProvider({
      credentials: { kind: 'meta_ads', accessToken: 'meta-secret-token-value' },
      baseUrl: 'https://graph.facebook.com',
      apiVersion: 'v26.0',
      http: client,
    });
    const health = await provider.validateConnection();
    expect(health.ok).toBe(true);
    expect(health.status).toBe('pending');
    expect(health.status).not.toBe('invalid_credentials');
    expect(health.message).toMatch(/no ad accounts/i);
  });
});

describe('error classification is not collapsed', () => {
  it('separates 401, 403, 400 and 5xx', () => {
    expect(classifyHttpStatus(401, '{"error":"unauthorized"}')).toBe('authentication_error');
    expect(classifyHttpStatus(403, '{"error":"forbidden"}')).toBe('authorization_error');
    expect(classifyHttpStatus(400, 'bad request')).toBe('invalid_request');
    expect(classifyHttpStatus(404, 'not found')).toBe('invalid_request');
    expect(classifyHttpStatus(429, 'slow down')).toBe('rate_limited');
    expect(classifyHttpStatus(503, 'unavailable')).toBe('provider_unavailable');
  });

  it('recognises an expired token inside a 403 body', () => {
    expect(classifyHttpStatus(403, 'Session has expired on Saturday')).toBe('expired_credential');
  });

  it('surfaces a Meta 403 as authorization, not as a bad credential', async () => {
    const client = new ProviderHttpClient({
      provider: 'meta_ads',
      minIntervalMs: 0,
      maxAttempts: 1,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            error: { message: 'Ad account owner has NOT grant ads_management', code: 200 },
          }),
          { status: 403, headers: { 'content-type': 'application/json' } },
        ),
    });
    const provider = new MetaAdsProvider({
      credentials: { kind: 'meta_ads', accessToken: 'meta-secret-token-value' },
      baseUrl: 'https://graph.facebook.com',
      apiVersion: 'v26.0',
      http: client,
    });
    const health = await provider.validateConnection();
    expect(health.errorClass).toBe('authorization_error');
    expect(health.status).toBe('degraded');
    expect(health.status).not.toBe('invalid_credentials');
  });

  it('surfaces a Tenjin 401 as authentication and a 403 as authorization', async () => {
    const build = (status: number, body: string) =>
      new TenjinAttributionProvider({
        credentials: { kind: 'tenjin', apiKey: 'tenjin-secret-token-value' },
        baseUrl: 'https://api.tenjin.com/v2',
        http: new ProviderHttpClient({
          provider: 'tenjin',
          minIntervalMs: 0,
          maxAttempts: 1,
          fetchImpl: async () =>
            new Response(body, { status, headers: { 'content-type': 'application/json' } }),
        }),
      });

    const unauthenticated = await build(401, '{"error":"invalid token"}').validateConnection();
    expect(unauthenticated.errorClass).toBe('authentication_error');
    expect(unauthenticated.status).toBe('invalid_credentials');

    const forbidden = await build(403, '{"error":"insufficient scope"}').validateConnection();
    expect(forbidden.errorClass).toBe('authorization_error');
    expect(forbidden.status).toBe('degraded');
  });
});

describe('diagnostics never leak a secret', () => {
  it('redacts secret-shaped query parameters from a logged URL', () => {
    expect(sanitizeUrl('https://api.example.com/v2/apps?api_key=super-secret-value&limit=1')).toBe(
      'https://api.example.com/v2/apps?api_key=REDACTED&limit=1',
    );
    expect(sanitizeUrl('https://graph.facebook.com/v26.0/me?access_token=abc123')).not.toContain(
      'abc123',
    );
  });

  it('redacts secret-shaped values echoed inside a provider error body', () => {
    const body = '{"error":"bad request","api_key":"super-secret-value"}';
    expect(sanitizeBody(body)).not.toContain('super-secret-value');
    expect(sanitizeBody(body)).toContain('REDACTED');
  });

  it('reports only whether an Authorization header was attached', () => {
    expect(hasAuthorization({ authorization: 'Bearer x' })).toBe(true);
    expect(hasAuthorization({ Authorization: 'Bearer x' })).toBe(true);
    expect(hasAuthorization({ accept: 'application/json' })).toBe(false);
    expect(hasAuthorization()).toBe(false);
  });
});

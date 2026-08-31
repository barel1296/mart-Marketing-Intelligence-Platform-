import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetConfigCache } from '@mart/config';
import {
  TenjinAttributionProvider,
  MetaAdsProvider,
  ProviderHttpClient,
  classifyHttpStatus,
  computeFreshnessStatus,
  evaluateSavedReport,
  hasAuthorization,
  parseSavedReport,
  providerEndpointInfo,
  sanitizeBody,
  sanitizeUrl,
  normalizeGroupBy,
  selectSavedReport,
  worstFreshness,
  TENJIN_REVENUE_COMPONENT_METRICS,
  TENJIN_REVENUE_METRICS_ACCEPTED,
  type TenjinSavedReport,
} from '@mart/integrations';
import { accountLabel } from '../../apps/web/lib/format';

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

describe('tenjin app identification', () => {
  function providerReturning(rows: unknown[]): TenjinAttributionProvider {
    return new TenjinAttributionProvider({
      credentials: { kind: 'tenjin', apiKey: 'tenjin-secret-token-value' },
      baseUrl: 'https://api.tenjin.com/v2',
      http: new ProviderHttpClient({
        provider: 'tenjin',
        minIntervalMs: 0,
        maxAttempts: 1,
        fetchImpl: async () =>
          new Response(JSON.stringify({ data: rows }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      }),
    });
  }

  it('keeps name, platform and bundle id whichever field names Tenjin uses', async () => {
    const apps = await providerReturning([
      {
        id: '2d4e5c5b-6206-4737-8be0-e21f885ce515',
        app_name: 'Bubble Blast',
        platform: 'iOS',
        bundle_id: 'com.studio.bubbleblast',
      },
      {
        app_id: '4cb0cb0b-dd0d-49ca-8d9b-df710219632b',
        name: 'Tower Rush',
        os: 'android',
        package_name: 'com.studio.towerrush',
      },
      {
        uuid: 'b6861802-21c7-4e6f-994d-44783bbda367',
        title: 'Merge Kingdom',
        device_platform: 'Google Play',
        store_id: '1234567890',
      },
    ]).listApps();

    expect(apps).toHaveLength(3);
    expect(apps[0]?.name).toBe('Bubble Blast');
    expect(apps[0]?.metadata?.['platform']).toBe('ios');
    expect(apps[0]?.metadata?.['bundleId']).toBe('com.studio.bubbleblast');
    expect(apps[1]?.name).toBe('Tower Rush');
    expect(apps[1]?.metadata?.['platform']).toBe('android');
    expect(apps[1]?.metadata?.['bundleId']).toBe('com.studio.towerrush');
    expect(apps[2]?.name).toBe('Merge Kingdom');
    expect(apps[2]?.metadata?.['platform']).toBe('android');
    expect(apps[2]?.metadata?.['bundleId']).toBe('1234567890');
  });

  it('records which response field each value came from', async () => {
    const [app] = await providerReturning([
      { app_id: 'uuid-1', title: 'Merge Kingdom', os: 'ios', store_id: '999' },
    ]).listApps();
    expect(app?.metadata?.['fieldSources']).toEqual({
      id: 'app_id',
      name: 'title',
      bundleId: 'store_id',
      platform: 'os',
      storeId: 'store_id',
    });
  });

  it('preserves every other non-secret field, and drops key-shaped ones', async () => {
    const [app] = await providerReturning([
      {
        id: 'uuid-1',
        name: 'Bubble Blast',
        some_future_field: 'keep me',
        api_key: 'per-app-sdk-key-must-not-be-stored',
        app_secret: 'also-not-stored',
      },
    ]).listApps();
    const raw = app?.metadata?.['raw'] as Record<string, string>;
    expect(raw['some_future_field']).toBe('keep me');
    expect(JSON.stringify(app?.metadata)).not.toContain('per-app-sdk-key-must-not-be-stored');
    expect(JSON.stringify(app?.metadata)).not.toContain('also-not-stored');
  });

  it('never derives a name from the id when Tenjin returns none', async () => {
    const [app] = await providerReturning([
      { id: '2d4e5c5b-6206-4737-8be0-e21f885ce515', platform: 'ios' },
    ]).listApps();
    // name falls back to the id so the field stays populated, but nothing
    // pretends the UUID is a title.
    expect(app?.name).toBe('2d4e5c5b-6206-4737-8be0-e21f885ce515');
    expect(app?.metadata?.['fieldSources']).toMatchObject({ name: null });
  });
});

describe('provider account labels', () => {
  it('reads as Name - Platform - Bundle ID', () => {
    expect(
      accountLabel({
        external_account_id: '2d4e5c5b-6206-4737-8be0-e21f885ce515',
        name: 'Bubble Blast',
        metadata: { platform: 'ios', bundleId: 'com.studio.bubbleblast' },
      }),
    ).toBe('Bubble Blast — ios — com.studio.bubbleblast');
  });

  it('omits parts the provider did not return', () => {
    expect(
      accountLabel({
        external_account_id: 'uuid-1',
        name: 'Tower Rush',
        metadata: { platform: 'android' },
      }),
    ).toBe('Tower Rush — android');
  });

  it('shows the raw id rather than dressing a UUID up as a name', () => {
    const id = 'b6861802-21c7-4e6f-994d-44783bbda367';
    expect(accountLabel({ external_account_id: id, name: id, metadata: { platform: 'ios' } })).toBe(
      `ios (${id})`,
    );
    expect(accountLabel({ external_account_id: id, name: id, metadata: {} })).toBe(id);
  });
});

describe('tenjin app detail enrichment', () => {
  /** Responds per URL, so list and detail calls can differ as they really do. */
  function providerFor(handler: (url: string) => { status?: number; body: unknown }): {
    provider: TenjinAttributionProvider;
    urls: string[];
  } {
    const urls: string[] = [];
    const provider = new TenjinAttributionProvider({
      credentials: { kind: 'tenjin', apiKey: 'tenjin-secret-token-value' },
      baseUrl: 'https://api.tenjin.com/v2',
      http: new ProviderHttpClient({
        provider: 'tenjin',
        minIntervalMs: 0,
        maxAttempts: 1,
        fetchImpl: async (url: string) => {
          urls.push(String(url));
          const { status = 200, body } = handler(String(url));
          return new Response(JSON.stringify(body), {
            status,
            headers: { 'content-type': 'application/json' },
          });
        },
      }),
    });
    return { provider, urls };
  }

  // The shape the real API returns today: resource identifiers only.
  const LIST_ONLY_IDS = {
    data: [
      { id: '2d4e5c5b-6206-4737-8be0-e21f885ce515', type: 'app' },
      { id: '4cb0cb0b-dd0d-49ca-8d9b-df710219632b', type: 'app' },
      { id: 'b6861802-21c7-4e6f-994d-44783bbda367', type: 'app' },
    ],
  };

  const DETAILS: Record<string, Record<string, unknown>> = {
    '2d4e5c5b-6206-4737-8be0-e21f885ce515': {
      name: 'Bubble Blast',
      bundle_id: 'com.studio.bubbleblast',
      platform: 'ios',
      store_id: '1112223334',
    },
    '4cb0cb0b-dd0d-49ca-8d9b-df710219632b': {
      name: 'Tower Rush',
      bundle_id: 'com.studio.towerrush',
      platform: 'android',
      store_id: 'com.studio.towerrush',
    },
    'b6861802-21c7-4e6f-994d-44783bbda367': {
      name: 'Merge Kingdom',
      bundle_id: 'com.studio.mergekingdom',
      platform: 'ios',
      store_id: '9998887776',
    },
  };

  it('enriches id-only resources via GET /v2/apps/{id}', async () => {
    const { provider, urls } = providerFor((url) => {
      const match = /\/v2\/apps\/([^/?]+)$/.exec(url);
      if (match?.[1]) {
        const id = decodeURIComponent(match[1]);
        return { body: { data: { id, type: 'app', attributes: DETAILS[id] } } };
      }
      return { body: LIST_ONLY_IDS };
    });

    const apps = await provider.listApps();

    // One list call plus one detail call per app.
    expect(urls[0]).toBe('https://api.tenjin.com/v2/apps');
    expect(urls).toHaveLength(4);
    expect(urls).toContain('https://api.tenjin.com/v2/apps/2d4e5c5b-6206-4737-8be0-e21f885ce515');

    expect(apps.map((a) => a.name)).toEqual(['Bubble Blast', 'Tower Rush', 'Merge Kingdom']);
    expect(apps[0]?.externalAccountId).toBe('2d4e5c5b-6206-4737-8be0-e21f885ce515');
    expect(apps[0]?.metadata?.['platform']).toBe('ios');
    expect(apps[0]?.metadata?.['bundleId']).toBe('com.studio.bubbleblast');
    expect(apps[0]?.metadata?.['storeId']).toBe('1112223334');
    expect(apps[0]?.metadata?.['detailStatus']).toBe('ok');
  });

  it('labels the enriched apps as Name - Platform - Bundle ID', async () => {
    const { provider } = providerFor((url) => {
      const match = /\/v2\/apps\/([^/?]+)$/.exec(url);
      if (match?.[1]) {
        const id = decodeURIComponent(match[1]);
        return { body: { data: { id, type: 'app', attributes: DETAILS[id] } } };
      }
      return { body: LIST_ONLY_IDS };
    });
    const apps = await provider.listApps();
    const labels = apps.map((a) =>
      accountLabel({
        external_account_id: a.externalAccountId,
        name: a.name,
        metadata: a.metadata ?? null,
      }),
    );
    expect(labels).toEqual([
      'Bubble Blast — ios — com.studio.bubbleblast',
      'Tower Rush — android — com.studio.towerrush',
      'Merge Kingdom — ios — com.studio.mergekingdom',
    ]);
  });

  it('never stores or exposes key-shaped attributes from the detail response', async () => {
    const { provider } = providerFor((url) => {
      if (/\/v2\/apps\/[^/?]+$/.test(url)) {
        return {
          body: {
            data: {
              id: '2d4e5c5b-6206-4737-8be0-e21f885ce515',
              type: 'app',
              attributes: {
                name: 'Bubble Blast',
                bundle_id: 'com.studio.bubbleblast',
                platform: 'ios',
                public_key: 'PUBLIC-KEY-MUST-NOT-PERSIST',
                ios_shared_secret: 'SHARED-SECRET-MUST-NOT-PERSIST',
                facebook_referrer_decryption_key: 'FB-KEY-MUST-NOT-PERSIST',
              },
            },
          },
        };
      }
      return { body: { data: [{ id: '2d4e5c5b-6206-4737-8be0-e21f885ce515', type: 'app' }] } };
    });
    const [app] = await provider.listApps();
    const serialized = JSON.stringify(app);
    expect(serialized).toContain('Bubble Blast');
    expect(serialized).not.toContain('PUBLIC-KEY-MUST-NOT-PERSIST');
    expect(serialized).not.toContain('SHARED-SECRET-MUST-NOT-PERSIST');
    expect(serialized).not.toContain('FB-KEY-MUST-NOT-PERSIST');
  });

  it('keeps the other apps when one detail call is forbidden', async () => {
    const { provider } = providerFor((url) => {
      const match = /\/v2\/apps\/([^/?]+)$/.exec(url);
      if (match?.[1]) {
        const id = decodeURIComponent(match[1]);
        if (id === '4cb0cb0b-dd0d-49ca-8d9b-df710219632b') {
          return { status: 403, body: { error: 'forbidden' } };
        }
        return { body: { data: { id, type: 'app', attributes: DETAILS[id] } } };
      }
      return { body: LIST_ONLY_IDS };
    });
    const apps = await provider.listApps();
    expect(apps).toHaveLength(3);
    expect(apps[0]?.name).toBe('Bubble Blast');
    expect(apps[1]?.name).toBe('4cb0cb0b-dd0d-49ca-8d9b-df710219632b');
    expect(String(apps[1]?.metadata?.['detailStatus'])).toContain('authorization_error');
    expect(apps[2]?.name).toBe('Merge Kingdom');
  });

  it('does not call the data-exports fallback when the detail call names the app', async () => {
    const { provider, urls } = providerFor((url) => {
      const match = /\/v2\/apps\/([^/?]+)$/.exec(url);
      if (match?.[1]) {
        const id = decodeURIComponent(match[1]);
        return { body: { data: { id, type: 'app', attributes: DETAILS[id] } } };
      }
      return { body: LIST_ONLY_IDS };
    });
    await provider.listApps();
    expect(urls.some((u) => u.includes('data_exports'))).toBe(false);
  });

  it('falls back to the data-exports lookup only when no name was found', async () => {
    const { provider, urls } = providerFor((url) => {
      if (url.includes('/data_exports/v1/apps')) {
        return { body: { data: [{ id: 'only-app', attributes: { name: 'Recovered Name' } }] } };
      }
      if (/\/v2\/apps\/[^/?]+$/.test(url)) {
        // Detail responds, but with nothing identifying.
        return { body: { data: { id: 'only-app', type: 'app', attributes: { timezone: 'UTC' } } } };
      }
      return { body: { data: [{ id: 'only-app', type: 'app' }] } };
    });
    const [app] = await provider.listApps();
    expect(urls.some((u) => u.startsWith('https://api.tenjin.com/data_exports/v1/apps'))).toBe(
      true,
    );
    expect(app?.name).toBe('Recovered Name');
    expect(String(app?.metadata?.['detailStatus'])).toContain('data_exports fallback');
  });

  it('keeps the fallback on the configured origin, so fixture mode stays local', async () => {
    const urls: string[] = [];
    const provider = new TenjinAttributionProvider({
      credentials: { kind: 'tenjin', apiKey: 'tenjin-secret-token-value' },
      baseUrl: 'http://fixtures:4900',
      http: new ProviderHttpClient({
        provider: 'tenjin',
        minIntervalMs: 0,
        maxAttempts: 1,
        fetchImpl: async (url: string) => {
          urls.push(String(url));
          if (String(url).includes('data_exports')) {
            return new Response(JSON.stringify({ data: [] }), { status: 200 });
          }
          if (/\/apps\/[^/?]+$/.test(String(url))) {
            return new Response(
              JSON.stringify({ data: { id: 'x', type: 'app', attributes: {} } }),
              {
                status: 200,
              },
            );
          }
          return new Response(JSON.stringify({ data: [{ id: 'x', type: 'app' }] }), {
            status: 200,
          });
        },
      }),
    });
    await provider.listApps();
    expect(urls.some((u) => u.startsWith('http://fixtures:4900/data_exports/'))).toBe(true);
    expect(urls.some((u) => u.includes('api.tenjin.com'))).toBe(false);
  });
});

/**
 * The saved-report reporting architecture, pinned.
 *
 * Tenjin's reporting API addresses data by saved report UUID:
 * `GET /v2/reports/{id}`. Asking for `/v2/reports/user_acquisition` makes it
 * read "user_acquisition" as an id, and it answers 400 "Saved report not
 * found" - which is exactly what a real account returned. Every assertion here
 * exists because getting it wrong produced no data at all.
 */
describe('tenjin saved-report reporting', () => {
  type Reply = { status?: number; body: unknown };

  function providerFor(handler: (url: URL, call: number) => Reply): {
    provider: TenjinAttributionProvider;
    urls: URL[];
  } {
    const urls: URL[] = [];
    const provider = new TenjinAttributionProvider({
      credentials: { kind: 'tenjin', apiKey: 'tenjin-secret-token-value' },
      baseUrl: 'https://api.tenjin.com/v2',
      http: new ProviderHttpClient({
        provider: 'tenjin',
        minIntervalMs: 0,
        maxAttempts: 1,
        fetchImpl: async (url: string) => {
          const parsed = new URL(String(url));
          urls.push(parsed);
          const { status = 200, body } = handler(parsed, urls.length);
          return new Response(JSON.stringify(body), {
            status,
            headers: { 'content-type': 'application/json' },
          });
        },
      }),
    });
    return { provider, urls };
  }

  const APP = 'b6861802-21c7-4e6f-994d-44783bbda367';
  // The real saved report on the account this was debugged against.
  const REPORT_ID = 'e2d46476-7ce3-4264-975e-1e1f3ef68339';

  const params = {
    externalAccountId: APP,
    from: '2026-08-01',
    to: '2026-08-28',
    timezone: 'UTC',
    currency: 'USD',
  };

  function savedReport(overrides: Record<string, unknown> = {}): unknown {
    return {
      id: REPORT_ID,
      type: 'saved_report',
      attributes: {
        // Verbatim from the real definition, including the metric set and the
        // provider's underscore spelling of Campaign + Country.
        name: 'MART - Reveal Rush UA',
        report_type: 'user_acquisition',
        app_ids: [APP],
        metrics: [
          'tracked_installs',
          'revenues',
          'ad_mediation_revenue',
          'total_rev',
          'spend',
          'cpm',
          'cpi',
          'ctr',
          'cvr',
          'ad_mediation_revenue_7d',
          'roas_7d',
        ],
        granularity: 'daily',
        group_by: 'campaign_country',
        past_number_days: 30,
        channel_ids: [],
        ...overrides,
      },
    };
  }

  /**
   * One row, exactly as the live API returns it for this grouping.
   *
   * Note `ad_mediation_revenue` is populated while `total_rev` is 0.0: that
   * total is `revenues + pub_rev` and does not include mediation revenue, so
   * reading it as "all revenue" would understate the account.
   */
  const ROW = {
    ad_mediation_revenue: 5.896744,
    ad_network_id: 3,
    ad_network_name: 'Meta',
    app_id: APP,
    app_name: 'Reveal Rush',
    // A Tenjin campaign UUID - deliberately not a Meta campaign id.
    campaign_id: 'b47f71fd-4c12-48ba-b49a-f78e5d7a7fa3',
    country: 'US',
    date: '2026-08-28',
    name: 'CPI_Broad_US_static (FB_Reveal_Rush_CPI_Broad_US_26/08/26)',
    platform: 'android',
    revenues: 12.5,
    spend: 9.05,
    total_rev: 0.0,
    tracked_clicks: 140,
    tracked_installs: 28,
  };

  const ROWS = { data: [{ attributes: ROW, type: 'report' }] };

  /** Discovery first, then the report pull. */
  function twoStep(rows: unknown = ROWS, reports: unknown[] = [savedReport()]) {
    return (url: URL): Reply =>
      url.pathname.endsWith('/saved_reports') ? { body: { data: reports } } : { body: rows };
  }

  it('discovers saved reports of the user-acquisition type', async () => {
    const { provider, urls } = providerFor(twoStep());
    await provider.syncInstalls(params);

    const discovery = urls[0];
    expect(discovery?.pathname).toBe('/v2/saved_reports');
    expect(discovery?.searchParams.get('report_type')).toBe('user_acquisition');
    expect(discovery?.searchParams.get('per_page')).toBe('1000');
  });

  it('pulls the data by saved report UUID, never by report family name', async () => {
    const { provider, urls } = providerFor(twoStep());
    await provider.syncInstalls(params);

    const pull = urls[1];
    expect(pull?.pathname).toBe(`/v2/reports/${REPORT_ID}`);
    // The bug this whole change exists to fix.
    expect(pull?.pathname).not.toContain('user_acquisition');
    expect(pull?.searchParams.get('start_date')).toBe('2026-08-01');
    expect(pull?.searchParams.get('end_date')).toBe('2026-08-28');
    expect(pull?.searchParams.get('format')).toBe('json');
  });

  it('reads metrics from data[].attributes, not from the top of the row', async () => {
    const { provider } = providerFor(twoStep());
    const result = await provider.syncInstalls(params);

    expect(result.rowsFetched).toBe(1);
    expect(result.rowsRejected).toBe(0);
    const install = result.batch.installs[0];
    expect(install?.installDate).toBe('2026-08-28');
    expect(install?.attributedInstalls).toBe(28);
    expect(install?.attributedClicks).toBe(140);
    expect(install?.mediaSource).toBe('Meta');
    expect(install?.externalCampaignId).toBe('b47f71fd-4c12-48ba-b49a-f78e5d7a7fa3');
    expect(install?.campaignName).toBe(
      'CPI_Broad_US_static (FB_Reveal_Rush_CPI_Broad_US_26/08/26)',
    );
    expect(install?.country).toBe('US');
    expect(install?.platform).toBe('android');
    expect(result.latestDataDate).toBe('2026-08-28');
  });

  it('counts only Tenjin-tracked installs, never the network-reported figure', async () => {
    const { provider } = providerFor(
      twoStep({ data: [{ attributes: { ...ROW, installs: 999 }, type: 'report' }] }),
    );
    const result = await provider.syncInstalls(params);
    expect(result.batch.installs[0]?.attributedInstalls).toBe(28);
  });

  it('takes revenue from the same saved report, at event_date grain', async () => {
    const { provider, urls } = providerFor(twoStep());
    const result = await provider.syncRevenue(params);

    expect(urls[1]?.pathname).toBe(`/v2/reports/${REPORT_ID}`);
    const byType = Object.fromEntries(result.batch.revenue.map((r) => [r.revenueType, r] as const));
    expect(byType['iap']?.revenue).toBe(12.5);
    // The account's ad revenue arrives as ad_mediation_revenue, not pub_rev.
    expect(byType['ad']?.revenue).toBe(5.896744);
    // A combined figure sits beside its own parts, and storage sums every
    // revenue row for a date: importing it too would double-count.
    expect(result.batch.revenue).toHaveLength(2);
    expect(result.batch.revenue.some((r) => r.revenueType === 'total')).toBe(false);
    for (const row of result.batch.revenue) {
      expect(row.grain).toBe('event_date');
      expect(row.activityDate).toBe('2026-08-28');
      expect(row.currency).toBe('USD');
    }
  });

  it('treats pub_rev as the same ad-revenue concept on an account that reports it', async () => {
    const { provider } = providerFor(
      twoStep(
        {
          data: [
            {
              attributes: { ...ROW, ad_mediation_revenue: undefined, pub_rev: 3.25 },
              type: 'report',
            },
          ],
        },
        [savedReport({ metrics: ['tracked_installs', 'revenues', 'pub_rev', 'total_rev'] })],
      ),
    );
    const result = await provider.syncRevenue(params);
    const byType = Object.fromEntries(result.batch.revenue.map((r) => [r.revenueType, r] as const));
    expect(byType['ad']?.revenue).toBe(3.25);
    expect(byType['iap']?.revenue).toBe(12.5);
  });

  it('never sums the two ad-revenue variants, and says so', async () => {
    const { provider } = providerFor(
      twoStep({ data: [{ attributes: { ...ROW, pub_rev: 3.25 }, type: 'report' }] }),
    );
    const result = await provider.syncRevenue(params);
    const ad = result.batch.revenue.filter((r) => r.revenueType === 'ad');
    // Different Tenjin measures: one of them, never their sum.
    expect(ad).toHaveLength(1);
    expect(ad[0]?.revenue).toBe(5.896744);
    expect(result.warnings.join(' ')).toContain('did not sum them');
  });

  it('imports a combined figure as total only when no component exists', async () => {
    const { provider } = providerFor(
      twoStep(
        {
          data: [
            {
              attributes: {
                date: '2026-08-28',
                app_id: APP,
                campaign_id: 'c1',
                name: 'Campaign',
                country: 'US',
                total_rev: 42.5,
              },
              type: 'report',
            },
          ],
        },
        [savedReport({ metrics: ['tracked_installs', 'total_rev'] })],
      ),
    );
    const result = await provider.syncRevenue(params);
    expect(result.batch.revenue).toHaveLength(1);
    // Explicitly total - never relabelled as IAP or ad.
    expect(result.batch.revenue[0]?.revenueType).toBe('total');
    expect(result.batch.revenue[0]?.revenue).toBe(42.5);
    expect(result.warnings.join(' ')).toContain('revenue_type=total');
  });

  it('reuses one discovery call across both streams', async () => {
    const { provider, urls } = providerFor(twoStep());
    await provider.syncInstalls(params);
    await provider.syncRevenue(params);
    expect(urls.filter((u) => u.pathname.endsWith('/saved_reports'))).toHaveLength(1);
  });

  it('follows links.next for pagination, and only on the configured host', async () => {
    const { provider, urls } = providerFor((url, call) => {
      if (url.pathname.endsWith('/saved_reports')) return { body: { data: [savedReport()] } };
      if (call === 2) {
        return {
          body: {
            data: [{ attributes: ROW, type: 'report' }],
            links: { next: `https://api.tenjin.com/v2/reports/${REPORT_ID}?page=2` },
          },
        };
      }
      return { body: { data: [{ attributes: { ...ROW, date: '2026-08-27' }, type: 'report' }] } };
    });
    const result = await provider.syncInstalls(params);

    expect(urls).toHaveLength(3);
    expect(urls[2]?.pathname).toBe(`/v2/reports/${REPORT_ID}`);
    expect(urls[2]?.searchParams.get('page')).toBe('2');
    expect(result.pagesFetched).toBe(2);
    expect(result.batch.installs).toHaveLength(2);
  });

  it('ignores a next link that points at another host', async () => {
    const { provider, urls } = providerFor((url) => {
      if (url.pathname.endsWith('/saved_reports')) return { body: { data: [savedReport()] } };
      return {
        body: {
          data: [{ attributes: ROW, type: 'report' }],
          links: { next: 'https://attacker.example.com/v2/reports/x' },
        },
      };
    });
    await provider.syncInstalls(params);
    expect(urls).toHaveLength(2);
    expect(urls.every((u) => u.origin === 'https://api.tenjin.com')).toBe(true);
  });

  it('falls back to has_more plus cursor when there are no links', async () => {
    const { provider, urls } = providerFor((url, call) => {
      if (url.pathname.endsWith('/saved_reports')) return { body: { data: [savedReport()] } };
      return call === 2
        ? { body: { data: [{ attributes: ROW, type: 'report' }], has_more: true, cursor: 'PAGE2' } }
        : {
            body: {
              data: [{ attributes: { ...ROW, date: '2026-08-27' }, type: 'report' }],
              has_more: false,
            },
          };
    });
    await provider.syncInstalls(params);
    expect(urls[2]?.searchParams.get('cursor')).toBe('PAGE2');
  });

  it('does not import rows belonging to another app', async () => {
    const { provider } = providerFor(
      twoStep(
        {
          data: [
            { attributes: ROW, type: 'report' },
            { attributes: { ...ROW, app_id: 'some-other-app-uuid' }, type: 'report' },
          ],
        },
        // An account-wide saved report legitimately covers the bound app.
        [savedReport({ app_ids: [] })],
      ),
    );
    const result = await provider.syncInstalls(params);

    expect(result.rowsFetched).toBe(2);
    expect(result.batch.installs).toHaveLength(1);
    expect(result.rowsRejected).toBe(1);
    expect(result.warnings.join(' ')).toContain('different app_id');
  });

  it('does not import rows outside the requested window, and says the window was short', async () => {
    const { provider } = providerFor(
      twoStep({
        data: [
          { attributes: { ...ROW, date: '2026-08-20' }, type: 'report' },
          // The saved report's own rolling period reached further back than
          // MART asked for.
          { attributes: { ...ROW, date: '2026-07-01' }, type: 'report' },
        ],
      }),
    );
    const result = await provider.syncInstalls(params);

    expect(result.batch.installs.map((i) => i.installDate)).toEqual(['2026-08-20']);
    expect(result.warnings.join(' ')).toContain('outside the requested window');
  });

  it('warns when the saved report period does not reach the start of the window', async () => {
    const { provider } = providerFor(
      twoStep({ data: [{ attributes: { ...ROW, date: '2026-08-25' }, type: 'report' }] }),
    );
    const result = await provider.syncInstalls(params);
    // 2026-08-01..2026-08-25 was requested but not covered - saying so beats
    // presenting a partial window as a complete one.
    expect(result.warnings.join(' ')).toContain('was not covered');
  });

  it('asks for a saved report instead of creating one when none is compatible', async () => {
    const { provider, urls } = providerFor((url) =>
      url.pathname.endsWith('/saved_reports')
        ? { body: { data: [savedReport({ metrics: ['cost', 'clicks'] })] } }
        : { body: ROWS },
    );

    await expect(provider.syncInstalls(params)).rejects.toMatchObject({
      errorClass: 'configuration_required',
    });
    // Read-only: no POST, and no attempt to pull a report anyway.
    expect(urls).toHaveLength(1);

    const error = await provider.syncInstalls(params).catch((e: unknown) => e);
    const context = (error as { context?: Record<string, unknown> }).context ?? {};
    expect(context['code']).toBe('tenjin_saved_report_required');
    expect(String(context['required'])).toContain('tracked_installs');
    expect(JSON.stringify(context['rejected'])).toContain('missing metric(s)');
  });

  it('never puts the api key in a reporting URL', async () => {
    const { provider, urls } = providerFor(twoStep());
    await provider.syncInstalls(params);
    for (const url of urls) {
      expect(url.toString()).not.toContain('tenjin-secret-token-value');
      expect(url.searchParams.has('api_key')).toBe(false);
    }
  });

  it('reports events as not implemented rather than empty-and-fresh', async () => {
    const { provider, urls } = providerFor(twoStep());
    const result = await provider.syncEvents();

    expect(result.support).toBe('not_implemented');
    expect(result.rowsFetched).toBe(0);
    // The point: no request was made, so nothing about this stream is fresh.
    expect(urls).toHaveLength(0);
    expect(
      computeFreshnessStatus({
        lastSuccessAt: new Date(),
        latestProviderDataDate: null,
        expectedFreshnessMinutes: 360,
        support: result.support,
      }),
    ).toBe('not_implemented');
  });
});

describe('tenjin saved-report compatibility', () => {
  const APP = 'b6861802-21c7-4e6f-994d-44783bbda367';

  function report(overrides: Partial<TenjinSavedReport> = {}): TenjinSavedReport {
    return {
      id: 'e2d46476-7ce3-4264-975e-1e1f3ef68339',
      name: 'MART - Reveal Rush UA',
      reportType: 'user_acquisition',
      appIds: [APP],
      metrics: ['tracked_installs', 'revenues', 'ad_mediation_revenue', 'total_rev'],
      granularity: 'daily',
      // The provider's own spelling of Campaign + Country.
      groupBy: 'campaign_country',
      pastNumberDays: 30,
      channelIds: [],
      ...overrides,
    };
  }

  const installs = { appId: APP, requiredMetrics: ['tracked_installs'] };

  it('accepts the real saved report for installs and for revenue', () => {
    // The exact definition that MART used to refuse with
    // "group_by campaign_country is not one MART can normalize".
    const real = report();
    expect(evaluateSavedReport(real, installs).usable).toBe(true);
    expect(
      evaluateSavedReport(real, {
        appId: APP,
        requiredMetrics: [],
        anyOfMetrics: TENJIN_REVENUE_METRICS_ACCEPTED,
      }).usable,
    ).toBe(true);
    // Both streams resolve to the same report id.
    expect(selectSavedReport([real], installs).chosen?.id).toBe(
      'e2d46476-7ce3-4264-975e-1e1f3ef68339',
    );
  });

  it('parses a saved report resource into the fields it is judged on', () => {
    const parsed = parseSavedReport({
      id: 'abc',
      attributes: {
        name: 'UA daily',
        report_type: 'user_acquisition',
        app_ids: [APP],
        metrics: ['tracked_installs'],
        granularity: 'daily',
        group_by: 'campaign',
        past_number_days: 14,
        channel_ids: [3, 5],
      },
    });
    expect(parsed).toMatchObject({
      id: 'abc',
      reportType: 'user_acquisition',
      appIds: [APP],
      metrics: ['tracked_installs'],
      granularity: 'daily',
      groupBy: 'campaign',
      pastNumberDays: 14,
      channelIds: ['3', '5'],
    });
  });

  it('accepts a report that covers the app with the needed metrics', () => {
    expect(evaluateSavedReport(report(), installs).usable).toBe(true);
  });

  it('accepts an account-wide report, stating what makes a row importable', () => {
    // The note is the contract the reader relies on. "Rows are filtered to the
    // bound app" overstates it: filtering needs an app_id on the row, and a
    // report grouped by campaign and country does not carry one. The note says
    // which rows are imported, so the promise matches what the reader does.
    const verdict = evaluateSavedReport(report({ appIds: [] }), installs);
    expect(verdict.usable).toBe(true);
    expect(verdict.notes.join(' ')).toContain('rows carrying an app_id for the bound app');
  });

  it('refuses a report for other apps, another type, or a missing metric', () => {
    expect(evaluateSavedReport(report({ appIds: ['other'] }), installs).usable).toBe(false);
    expect(evaluateSavedReport(report({ reportType: 'ad_monetization' }), installs).usable).toBe(
      false,
    );
    expect(evaluateSavedReport(report({ metrics: ['cost'] }), installs).usable).toBe(false);
  });

  it('refuses a granularity that cannot be attributed to a day', () => {
    for (const granularity of ['weekly', 'monthly', 'totals-daily']) {
      expect(evaluateSavedReport(report({ granularity }), installs).usable).toBe(false);
    }
    expect(evaluateSavedReport(report({ granularity: 'daily' }), installs).usable).toBe(true);
  });

  it('reads both provider spellings of the same grouping', () => {
    // A saved report says campaign_country; the ad-hoc report parameter says
    // campaign,country. Comparing either against a fixed string is the bug.
    expect(normalizeGroupBy('campaign_country')?.dimensions).toEqual(['campaign', 'country']);
    expect(normalizeGroupBy('campaign,country')?.dimensions).toEqual(['campaign', 'country']);
    expect(normalizeGroupBy('channel_app_country')?.dimensions).toEqual([
      'channel',
      'app',
      'country',
    ]);
    expect(normalizeGroupBy('channel,app')?.dimensions).toEqual(['channel', 'app']);
    expect(normalizeGroupBy('campaign')?.dimensions).toEqual(['campaign']);
    expect(normalizeGroupBy(null)).toBeNull();
  });

  it('accepts every spelling of a grouping MART can store', () => {
    for (const groupBy of ['campaign_country', 'campaign,country', 'campaign', 'channel_app']) {
      expect(evaluateSavedReport(report({ groupBy }), installs).usable, groupBy).toBe(true);
    }
  });

  it('refuses groupings that would collapse rows onto one key', () => {
    // MART stores no site or creative dimension, so many rows would share a
    // key and overwrite each other on write.
    for (const groupBy of ['site', 'creative', 'campaign_site']) {
      const verdict = evaluateSavedReport(report({ groupBy }), installs);
      expect(verdict.usable, groupBy).toBe(false);
      expect(verdict.blockers.join(' ')).toContain('collapse');
    }
  });

  it('refuses a grouping it does not recognize rather than guessing', () => {
    const verdict = evaluateSavedReport(report({ groupBy: 'campaign_wormhole' }), installs);
    expect(verdict.usable).toBe(false);
    expect(verdict.blockers.join(' ')).toContain('does not recognize');
    expect(normalizeGroupBy('campaign_wormhole')?.unrecognized).toEqual(['wormhole']);
  });

  it('accepts a campaign-less grouping but says nothing can be reconciled', () => {
    const verdict = evaluateSavedReport(report({ groupBy: 'app' }), installs);
    expect(verdict.usable).toBe(true);
    expect(verdict.notes.join(' ')).toContain('no campaign');
  });

  it('accepts any usable revenue component, in either provider spelling', () => {
    const revenue = {
      appId: APP,
      requiredMetrics: [],
      anyOfMetrics: TENJIN_REVENUE_METRICS_ACCEPTED,
    };
    for (const metric of TENJIN_REVENUE_COMPONENT_METRICS) {
      expect(evaluateSavedReport(report({ metrics: [metric] }), revenue).usable, metric).toBe(true);
    }
    // A combined figure alone is usable, but says what it will become.
    const totalOnly = evaluateSavedReport(report({ metrics: ['total_rev'] }), revenue);
    expect(totalOnly.usable).toBe(true);
    expect(totalOnly.notes.join(' ')).toContain('revenue_type=total');
    // A report with no revenue at all is still refused.
    expect(evaluateSavedReport(report({ metrics: ['tracked_installs'] }), revenue).usable).toBe(
      false,
    );
  });

  it('prefers a report that splits IAP from ad over one carrying only a total', () => {
    const revenue = {
      appId: APP,
      requiredMetrics: [],
      anyOfMetrics: TENJIN_REVENUE_METRICS_ACCEPTED,
    };
    const { chosen } = selectSavedReport(
      [
        report({ id: 'total-only', metrics: ['total_rev'] }),
        report({ id: 'split', metrics: ['revenues', 'ad_mediation_revenue'] }),
      ],
      revenue,
    );
    expect(chosen?.id).toBe('split');
  });

  it('notes, rather than sums, a report carrying both ad-revenue variants', () => {
    const verdict = evaluateSavedReport(
      report({ metrics: ['revenues', 'ad_mediation_revenue', 'pub_rev'] }),
      { appId: APP, requiredMetrics: [], anyOfMetrics: TENJIN_REVENUE_COMPONENT_METRICS },
    );
    expect(verdict.usable).toBe(true);
    expect(verdict.notes.join(' ')).toContain('rather than summing them');
  });

  it('prefers the richest grouping among compatible reports', () => {
    const { chosen } = selectSavedReport(
      [
        report({ id: 'coarse', groupBy: 'app' }),
        report({ id: 'rich', groupBy: 'campaign_country' }),
        report({ id: 'mid', groupBy: 'campaign' }),
      ],
      installs,
    );
    expect(chosen?.id).toBe('rich');
  });

  it('chooses nothing, and explains each refusal, when none fits', () => {
    const { chosen, evaluated } = selectSavedReport(
      [report({ id: 'a', metrics: ['cost'] }), report({ id: 'b', granularity: 'weekly' })],
      installs,
    );
    expect(chosen).toBeNull();
    expect(evaluated.every((c) => c.blockers.length > 0)).toBe(true);
  });
});

describe('freshness never calls an unfetched stream fresh', () => {
  it('reports the support state instead of a data age', () => {
    for (const support of ['unsupported', 'not_implemented'] as const) {
      expect(
        computeFreshnessStatus({
          lastSuccessAt: new Date(),
          latestProviderDataDate: null,
          expectedFreshnessMinutes: 360,
          support,
        }),
      ).toBe(support);
    }
  });

  it('leaves a genuinely fetched stream alone', () => {
    expect(
      computeFreshnessStatus({
        lastSuccessAt: new Date(),
        latestProviderDataDate: new Date().toISOString().slice(0, 10),
        expectedFreshnessMinutes: 360,
        support: 'supported',
      }),
    ).toBe('fresh');
  });

  it('does not let an unimplemented stream decide an app data health', () => {
    // The whole point: installs are fine, so the app is fine.
    expect(worstFreshness(['fresh', 'not_implemented'])).toBe('fresh');
    expect(worstFreshness(['error', 'not_implemented'])).toBe('error');
    expect(worstFreshness(['not_implemented'])).toBe('not_implemented');
  });
});

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
 * The real user-acquisition report, pinned.
 *
 * Every value asserted here was observed against a live Tenjin account, and
 * each one was wrong in the version of the adapter that reported
 * `attribution_installs` and `attribution_revenue` as failing: the endpoint
 * sat at the API root instead of under /reports, the app filter was singular,
 * `group_by` was a free-form dimension list rather than one of the enum's
 * members, `granularity` was absent, and the rows were read flat when they
 * actually arrive as JSON:API resources.
 */
describe('tenjin user acquisition report', () => {
  type Reply = { status?: number; body: unknown };

  function providerFor(handler: (url: URL, page: number) => Reply): {
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

  const params = {
    externalAccountId: APP,
    from: '2026-08-01',
    to: '2026-08-28',
    timezone: 'UTC',
    currency: 'USD',
  };

  /** One row, exactly as the live API returns it. */
  const ROW = {
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
    pub_rev: 3.25,
    total_rev: 15.75,
    tracked_clicks: 140,
    tracked_installs: 28,
  };

  const ONE_PAGE = { data: [{ attributes: ROW, type: 'report' }], has_more: false };

  it('requests /reports/user_acquisition with the parameters the API accepts', async () => {
    const { provider, urls } = providerFor(() => ({ body: ONE_PAGE }));
    await provider.syncInstalls(params);

    const url = urls[0];
    expect(url?.origin + url?.pathname).toBe('https://api.tenjin.com/v2/reports/user_acquisition');
    const q = url?.searchParams;
    expect(q?.get('start_date')).toBe('2026-08-01');
    expect(q?.get('end_date')).toBe('2026-08-28');
    expect(q?.get('granularity')).toBe('daily');
    expect(q?.get('format')).toBe('json');
    // Plural. The singular form is silently ignored, which is what produced
    // whole-account rows or none at all.
    expect(q?.get('app_ids')).toBe(APP);
    expect(q?.has('app_id')).toBe(false);
    expect(q?.get('metrics')).toContain('tracked_installs');
  });

  it('groups by a member of the closed group_by enum', async () => {
    const { provider, urls } = providerFor(() => ({ body: ONE_PAGE }));
    await provider.syncInstalls(params);

    const groupBy = urls[0]?.searchParams.get('group_by');
    // The enum, verbatim. Anything outside it is rejected by the API.
    expect([
      'app',
      'channel',
      'country',
      'site',
      'campaign',
      'campaign,country',
      'channel,app',
      'channel,app,country',
      'creative',
    ]).toContain(groupBy);
    // The two that were previously sent and are not groupable at all.
    expect(groupBy).not.toContain('date');
    expect(groupBy).not.toContain('platform');
  });

  it('reads metrics from data[].attributes, not from the top of the row', async () => {
    const { provider } = providerFor(() => ({ body: ONE_PAGE }));
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
    const { provider } = providerFor(() => ({
      body: { data: [{ attributes: { ...ROW, installs: 999 }, type: 'report' }], has_more: false },
    }));
    const result = await provider.syncInstalls(params);
    expect(result.batch.installs[0]?.attributedInstalls).toBe(28);
  });

  it('takes revenue from the same report, at event_date grain', async () => {
    const { provider, urls } = providerFor(() => ({ body: ONE_PAGE }));
    const result = await provider.syncRevenue(params);

    // No second API family: revenue is columns on the user-acquisition report.
    expect(urls).toHaveLength(1);
    expect(urls[0]?.pathname).toBe('/v2/reports/user_acquisition');
    expect(urls[0]?.searchParams.get('metrics')).toContain('revenues');

    const byType = Object.fromEntries(result.batch.revenue.map((r) => [r.revenueType, r] as const));
    expect(byType['iap']?.revenue).toBe(12.5);
    expect(byType['ad']?.revenue).toBe(3.25);
    // total_rev is the sum of the other two; emitting it would double-count.
    expect(result.batch.revenue).toHaveLength(2);
    for (const row of result.batch.revenue) {
      // Revenue recorded on the date, not cohort LTV.
      expect(row.grain).toBe('event_date');
      expect(row.activityDate).toBe('2026-08-28');
      expect(row.currency).toBe('USD');
    }
  });

  it('does not import the N-day cohort revenue columns', async () => {
    const { provider, urls } = providerFor(() => ({ body: ONE_PAGE }));
    await provider.syncRevenue(params);
    const metrics = urls[0]?.searchParams.get('metrics') ?? '';
    expect(metrics).not.toMatch(/_\d+d\b/);
  });

  it('follows the cursor while has_more is true', async () => {
    const { provider, urls } = providerFor((_url, page) =>
      page === 1
        ? { body: { data: [{ attributes: ROW, type: 'report' }], has_more: true, cursor: 'PAGE2' } }
        : {
            body: {
              data: [{ attributes: { ...ROW, date: '2026-08-27' }, type: 'report' }],
              has_more: false,
            },
          },
    );
    const result = await provider.syncInstalls(params);

    expect(urls).toHaveLength(2);
    expect(urls[0]?.searchParams.has('cursor')).toBe(false);
    expect(urls[1]?.searchParams.get('cursor')).toBe('PAGE2');
    expect(result.pagesFetched).toBe(2);
    expect(result.batch.installs).toHaveLength(2);
    expect(result.latestDataDate).toBe('2026-08-28');
  });

  it('stops and warns when has_more is true but no cursor comes back', async () => {
    const { provider, urls } = providerFor(() => ({
      body: { data: [{ attributes: ROW, type: 'report' }], has_more: true },
    }));
    const result = await provider.syncInstalls(params);

    // One request, not two hundred: a missing cursor must not become a loop,
    // and the truncated window must not look like a complete one.
    expect(urls).toHaveLength(1);
    expect(result.warnings.join(' ')).toContain('cursor');
  });

  it('rejects rows with no date rather than dropping them silently', async () => {
    const { provider } = providerFor(() => ({
      body: {
        data: [
          { attributes: { ...ROW, date: undefined }, type: 'report' },
          { attributes: ROW, type: 'report' },
        ],
        has_more: false,
      },
    }));
    const result = await provider.syncInstalls(params);
    expect(result.rowsFetched).toBe(2);
    expect(result.rowsRejected).toBe(1);
    expect(result.batch.installs).toHaveLength(1);
    expect(result.warnings.join(' ')).toContain('no usable date');
  });

  it('never puts the api key in the report URL', async () => {
    const { provider, urls } = providerFor(() => ({ body: ONE_PAGE }));
    await provider.syncInstalls(params);
    expect(urls[0]?.toString()).not.toContain('tenjin-secret-token-value');
    expect(urls[0]?.searchParams.has('api_key')).toBe(false);
  });
});

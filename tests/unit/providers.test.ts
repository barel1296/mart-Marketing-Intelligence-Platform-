import { beforeEach, describe, expect, it } from 'vitest';
import {
  AppsFlyerAttributionProvider,
  MetaAdsProvider,
  ProviderHttpClient,
  TenjinAttributionProvider,
  parseCsvTable,
  toCanonicalAd,
  toCanonicalAdGroup,
  toCanonicalCampaign,
  toCanonicalMetric,
  type AttributionProvider,
  type SyncParams,
} from '@mart/integrations';

/** Deterministic fetch stub: returns queued responses and records requests. */
function stubFetch(
  responses: Array<{ status?: number; body: string; headers?: Record<string, string> }>,
) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  let index = 0;
  const impl = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    const response = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return new Response(response?.body ?? '', {
      status: response?.status ?? 200,
      headers: response?.headers ?? {},
    });
  };
  return { impl, calls };
}

function client(fetchImpl: ReturnType<typeof stubFetch>['impl'], provider: string) {
  return new ProviderHttpClient({
    provider,
    fetchImpl,
    maxAttempts: 2,
    minIntervalMs: 0,
    sleep: async () => undefined,
  });
}

const params: SyncParams = {
  externalAccountId: 'act_123',
  from: '2026-08-20',
  to: '2026-08-21',
  timezone: 'UTC',
  currency: 'USD',
};

describe('Meta Ads adapter', () => {
  it('normalizes insight rows into canonical report-date facts', () => {
    const metric = toCanonicalMetric(
      {
        date_start: '2026-08-20',
        account_id: '123',
        account_currency: 'EUR',
        campaign_id: '900',
        adset_id: '901',
        spend: '12.50',
        impressions: '1000',
        clicks: '25',
        inline_link_clicks: '20',
        outbound_clicks: [{ action_type: 'outbound_click', value: '18' }],
        country: 'us',
      },
      { currency: 'USD', externalAccountId: 'act_123' },
    );
    expect(metric).not.toBeNull();
    expect(metric?.reportDate).toBe('2026-08-20');
    expect(metric?.externalCampaignId).toBe('900');
    expect(metric?.spend).toBe(12.5);
    expect(metric?.linkClicks).toBe(20);
    expect(metric?.outboundClicks).toBe(18);
    // Currency comes from the account, not from the caller's default.
    expect(metric?.currency).toBe('EUR');
    expect(metric?.country).toBe('US');
  });

  it('rejects rows with no date or campaign id instead of inventing values', () => {
    expect(
      toCanonicalMetric(
        { campaign_id: '900', spend: '1' },
        { currency: 'USD', externalAccountId: 'act_1' },
      ),
    ).toBeNull();
    expect(
      toCanonicalMetric(
        { date_start: '2026-08-20', spend: '1' },
        { currency: 'USD', externalAccountId: 'act_1' },
      ),
    ).toBeNull();
  });

  it('converts Meta minor-unit budgets to major units', () => {
    const campaign = toCanonicalCampaign(
      { id: '900', name: 'Test', daily_budget: '5000', account_id: '123' },
      'act_123',
    );
    expect(campaign.dailyBudget).toBe(50);
    expect(campaign.externalAccountId).toBe('act_123');
    const adGroup = toCanonicalAdGroup({ id: '901', campaign_id: '900', daily_budget: '2500' });
    expect(adGroup.dailyBudget).toBe(25);
  });

  it('extracts the creative as a separate canonical entity', () => {
    const { canonicalAd, creative } = toCanonicalAd({
      id: '902',
      adset_id: '901',
      campaign_id: '900',
      creative: { id: 'cr1', name: 'Hook A', object_type: 'VIDEO' },
    });
    expect(canonicalAd.externalCreativeId).toBe('cr1');
    expect(creative?.externalCreativeId).toBe('cr1');
    expect(creative?.objectType).toBe('VIDEO');
  });

  it('sends the access token as a bearer header, never in the URL', async () => {
    const stub = stubFetch([{ body: JSON.stringify({ data: [] }) }]);
    const provider = new MetaAdsProvider({
      credentials: { kind: 'meta_ads', accessToken: 'SECRET-TOKEN' },
      baseUrl: 'https://graph.example.com',
      apiVersion: 'v21.0',
      http: client(stub.impl, 'meta_ads'),
    });
    await provider.validateConnection();
    const call = stub.calls[0];
    expect(call?.url).not.toContain('SECRET-TOKEN');
    const headers = call?.init?.headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer SECRET-TOKEN');
  });

  it('follows cursor pagination and aggregates all pages', async () => {
    const stub = stubFetch([
      {
        body: JSON.stringify({
          data: [{ id: 'act_1', name: 'One' }],
          paging: { next: 'https://graph.example.com/v21.0/me/adaccounts?after=abc' },
        }),
      },
      { body: JSON.stringify({ data: [{ id: 'act_2', name: 'Two' }] }) },
    ]);
    const provider = new MetaAdsProvider({
      credentials: { kind: 'meta_ads', accessToken: 't'.repeat(30) },
      baseUrl: 'https://graph.example.com',
      apiVersion: 'v21.0',
      http: client(stub.impl, 'meta_ads'),
    });
    const accounts = await provider.listAccounts();
    expect(accounts.map((a) => a.externalAccountId)).toEqual(['act_1', 'act_2']);
    expect(stub.calls).toHaveLength(2);
  });

  it('degrades to no country breakdown when the account rejects it', async () => {
    let call = 0;
    const impl = async (url: string): Promise<Response> => {
      call += 1;
      if (url.includes('breakdowns=country')) {
        return new Response(JSON.stringify({ error: { message: 'bad breakdown' } }), {
          status: 400,
        });
      }
      return new Response(
        JSON.stringify({
          data: [
            {
              date_start: '2026-08-20',
              campaign_id: '900',
              spend: '1',
              impressions: '10',
              clicks: '1',
            },
          ],
        }),
      );
    };
    const provider = new MetaAdsProvider({
      credentials: { kind: 'meta_ads', accessToken: 't'.repeat(30) },
      baseUrl: 'https://graph.example.com',
      apiVersion: 'v21.0',
      http: client(impl, 'meta_ads'),
    });
    const result = await provider.syncPerformance(params);
    expect(result.batch.dailyMetrics).toHaveLength(1);
    expect(result.warnings.join(' ')).toMatch(/country breakdown/i);
    expect(call).toBeGreaterThan(1);
  });
});

describe('AppsFlyer adapter', () => {
  it('parses raw install CSV into install-date grain facts with stable ids', async () => {
    const csv = [
      'Install Time,Media Source,Campaign,af_c_id,af_adset_id,af_ad_id,Country Code,Platform',
      '2026-08-20 10:00:00,facebook,Summer,900,901,902,US,ios',
      '2026-08-20 11:00:00,facebook,Summer,900,901,902,US,ios',
      '2026-08-21 09:00:00,facebook,Summer,900,901,902,GB,ios',
    ].join('\n');
    const stub = stubFetch([{ body: csv }]);
    const provider = new AppsFlyerAttributionProvider({
      credentials: { kind: 'appsflyer', apiToken: 'x'.repeat(40) },
      baseUrl: 'https://af.example.com',
      http: client(stub.impl, 'appsflyer'),
    });

    const result = await provider.syncInstalls(params);
    const installs = result.batch.installs;
    // Two US installs on the same day collapse into one fact with a count of 2.
    const us = installs.find((i) => i.country === 'US');
    expect(us?.attributedInstalls).toBe(2);
    expect(us?.externalCampaignId).toBe('900');
    expect(us?.externalAdGroupId).toBe('901');
    expect(us?.attributionCertainty).toBe('deterministic');
    expect(installs.find((i) => i.country === 'GB')?.attributedInstalls).toBe(1);
    expect(result.latestDataDate).toBe('2026-08-21');
  });

  it('falls back to the aggregate report and reports the missing ids honestly', async () => {
    let callCount = 0;
    const impl = async (url: string): Promise<Response> => {
      callCount += 1;
      if (url.includes('/raw-data/')) {
        return new Response('Raw data reports are only supported for accounts on higher plans', {
          status: 200,
        });
      }
      return new Response(
        [
          'Date,Media Source,Campaign,Impressions,Clicks,Installs',
          '2026-08-20,facebook,Summer,1000,50,10',
        ].join('\n'),
      );
    };
    const provider = new AppsFlyerAttributionProvider({
      credentials: { kind: 'appsflyer', apiToken: 'x'.repeat(40) },
      baseUrl: 'https://af.example.com',
      http: client(impl, 'appsflyer'),
    });

    const capabilities = await provider.getCapabilities('id123');
    const byKey = new Map(capabilities.map((c) => [c.key, c]));
    expect(byKey.get('raw_data')?.supported).toBe(false);
    // Campaign IDs genuinely do not exist in the aggregate report; MART says so
    // rather than inventing them from names.
    expect(byKey.get('campaign_id')?.supported).toBe(false);
    expect(byKey.get('campaign_id')?.discoveryMethod).toBe('probed');

    const result = await provider.syncInstalls(params);
    expect(result.batch.installs[0]?.attributedInstalls).toBe(10);
    expect(result.batch.installs[0]?.externalCampaignId).toBeNull();
    expect(result.batch.installs[0]?.campaignName).toBe('Summer');
    expect(result.warnings.join(' ')).toMatch(/does not include campaign/i);
    expect(callCount).toBeGreaterThan(1);
  });

  it('produces event-date revenue from in-app events, never cohort revenue', async () => {
    const csv = [
      'Event Time,Event Name,Media Source,af_c_id,Country Code,Platform,Event Revenue,Event Revenue Currency',
      '2026-08-20 10:00:00,af_purchase,facebook,900,US,ios,9.99,USD',
      '2026-08-20 12:00:00,af_purchase,facebook,900,US,ios,4.01,USD',
    ].join('\n');
    let first = true;
    const impl = async (): Promise<Response> => {
      if (first) {
        first = false;
        return new Response('Install Time\n2026-08-20 10:00:00');
      }
      return new Response(csv);
    };
    const provider = new AppsFlyerAttributionProvider({
      credentials: { kind: 'appsflyer', apiToken: 'x'.repeat(40) },
      baseUrl: 'https://af.example.com',
      http: client(impl, 'appsflyer'),
    });
    const result = await provider.syncEvents(params);
    expect(result.batch.events[0]?.eventCount).toBe(2);
    expect(result.batch.revenue).toHaveLength(1);
    expect(result.batch.revenue[0]?.revenue).toBeCloseTo(14, 5);
    expect(result.batch.revenue[0]?.grain).toBe('event_date');
    expect(result.batch.revenue[0]?.revenueType).toBe('iap');
  });

  it('does not enumerate apps it cannot enumerate', async () => {
    const provider = new AppsFlyerAttributionProvider({
      credentials: { kind: 'appsflyer', apiToken: 'x'.repeat(40) },
      baseUrl: 'https://af.example.com',
      http: client(stubFetch([{ body: '' }]).impl, 'appsflyer'),
    });
    expect(await provider.listApps()).toEqual([]);
    const health = await provider.validateConnection();
    expect(health.details?.['requiresAppId']).toBe(true);
  });
});

describe('Tenjin adapter', () => {
  // Reporting data is addressed by saved report UUID, so every sync makes two
  // calls: discover the saved reports, then pull the chosen one.
  const savedReports = JSON.stringify({
    data: [
      {
        id: 'aa11bb22-cc33-dd44-ee55-ff6677889900',
        type: 'saved_report',
        attributes: {
          name: 'MART UA daily',
          report_type: 'user_acquisition',
          app_ids: ['app-1'],
          metrics: [
            'tracked_installs',
            'tracked_clicks',
            'tracked_impressions',
            'revenues',
            'pub_rev',
          ],
          granularity: 'daily',
          group_by: 'campaign,country',
          past_number_days: 30,
        },
      },
    ],
  });

  const body = JSON.stringify({
    data: [
      {
        date: '2026-08-20',
        ad_network: 'facebook',
        campaign: 'Summer',
        campaign_id: '900',
        country: 'US',
        platform: 'ios',
        installs: 120, // network-reported: NOT attribution
        tracked_installs: 100,
        tracked_clicks: 900,
        tracked_impressions: 40_000,
      },
    ],
  });

  it('uses tracked installs for attribution and ignores network-reported installs', async () => {
    const stub = stubFetch([{ body: savedReports }, { body }]);
    const provider = new TenjinAttributionProvider({
      credentials: { kind: 'tenjin', apiKey: 'k'.repeat(30) },
      baseUrl: 'https://tenjin.example.com',
      http: client(stub.impl, 'tenjin'),
    });
    const result = await provider.syncInstalls({ ...params, externalAccountId: 'app-1' });
    const install = result.batch.installs[0];
    expect(install?.attributedInstalls).toBe(100);
    expect(install?.attributedInstalls).not.toBe(120);
    expect(install?.externalCampaignId).toBe('900');
    expect(install?.country).toBe('US');
  });

  it('drops rows an account-wide saved report cannot attribute to an app', async () => {
    // A saved report with an empty app_ids covers every app in the account,
    // and is admitted only because MART filters the rows by app_id. The
    // grouping MART itself ranks highest, campaign+country, carries no app
    // dimension - so this is exactly where the column is missing, and a filter
    // that skips when the column is absent writes another app's installs
    // against the bound app with no warning at all.
    const accountWide = JSON.stringify({
      data: [
        {
          id: 'bb22cc33-dd44-ee55-ff66-778899001122',
          type: 'saved_report',
          attributes: {
            name: 'Account-wide UA',
            report_type: 'user_acquisition',
            app_ids: [],
            metrics: ['tracked_installs'],
            granularity: 'daily',
            group_by: 'campaign,country',
            past_number_days: 30,
          },
        },
      ],
    });
    const rowsWithoutApp = JSON.stringify({
      data: [
        { date: '2026-08-20', campaign_id: '900', country: 'US', tracked_installs: 100 },
        { date: '2026-08-20', campaign_id: '901', country: 'GB', tracked_installs: 40 },
      ],
    });
    const stub = stubFetch([{ body: accountWide }, { body: rowsWithoutApp }]);
    const provider = new TenjinAttributionProvider({
      credentials: { kind: 'tenjin', apiKey: 'k'.repeat(30) },
      baseUrl: 'https://tenjin.example.com',
      http: client(stub.impl, 'tenjin'),
    });
    const result = await provider.syncInstalls({ ...params, externalAccountId: 'app-1' });
    expect(result.batch.installs).toHaveLength(0);
    expect(result.rowsRejected).toBe(2);
    expect(result.warnings.join(' ')).toMatch(/no app_id column/i);
  });

  it('keeps every row of a report Tenjin already scoped to the bound app', async () => {
    // The same rows, from a report saved for this app alone: Tenjin has done
    // the scoping, so a missing app_id column proves nothing and drops nothing.
    const rowsWithoutApp = JSON.stringify({
      data: [{ date: '2026-08-20', campaign_id: '900', country: 'US', tracked_installs: 100 }],
    });
    const stub = stubFetch([{ body: savedReports }, { body: rowsWithoutApp }]);
    const provider = new TenjinAttributionProvider({
      credentials: { kind: 'tenjin', apiKey: 'k'.repeat(30) },
      baseUrl: 'https://tenjin.example.com',
      http: client(stub.impl, 'tenjin'),
    });
    const result = await provider.syncInstalls({ ...params, externalAccountId: 'app-1' });
    expect(result.batch.installs).toHaveLength(1);
    expect(result.rowsRejected).toBe(0);
  });

  it('emits IAP and ad revenue at event-date grain', async () => {
    const revenueBody = JSON.stringify({
      data: [
        {
          date: '2026-08-20',
          ad_network: 'facebook',
          campaign_id: '900',
          revenues: 50,
          pub_rev: 20,
        },
      ],
    });
    const stub = stubFetch([{ body: savedReports }, { body: revenueBody }]);
    const provider = new TenjinAttributionProvider({
      credentials: { kind: 'tenjin', apiKey: 'k'.repeat(30) },
      baseUrl: 'https://tenjin.example.com',
      http: client(stub.impl, 'tenjin'),
    });
    const result = await provider.syncRevenue({ ...params, externalAccountId: 'app-1' });
    const types = result.batch.revenue.map((r) => `${r.revenueType}:${r.revenue}:${r.grain}`);
    expect(types).toContain('iap:50:event_date');
    expect(types).toContain('ad:20:event_date');
  });

  it('declares cohort reporting as a capability without importing cohort metrics', async () => {
    const provider = new TenjinAttributionProvider({
      credentials: { kind: 'tenjin', apiKey: 'k'.repeat(30) },
      baseUrl: 'https://tenjin.example.com',
      http: client(stubFetch([{ body: '{"data":[]}' }]).impl, 'tenjin'),
    });
    const capabilities = new Map((await provider.getCapabilities()).map((c) => [c.key, c]));
    expect(capabilities.get('cohort_reporting')?.supported).toBe(true);
    expect(capabilities.get('ad_id')?.supported).toBe(false);
    expect(capabilities.get('events')?.supported).toBe(false);
  });

  it('fails loudly on an unrecognized response envelope', async () => {
    const stub = stubFetch([{ body: JSON.stringify({ unexpected: true }) }]);
    const provider = new TenjinAttributionProvider({
      credentials: { kind: 'tenjin', apiKey: 'k'.repeat(30) },
      baseUrl: 'https://tenjin.example.com',
      http: client(stub.impl, 'tenjin'),
    });
    await expect(provider.syncInstalls({ ...params, externalAccountId: 'a' })).rejects.toThrow(
      /rows array/i,
    );
  });
});

describe('attribution provider abstraction', () => {
  let providers: AttributionProvider[];

  beforeEach(() => {
    const impl = stubFetch([{ body: '{"data":[]}' }]).impl;
    providers = [
      new AppsFlyerAttributionProvider({
        credentials: { kind: 'appsflyer', apiToken: 'x'.repeat(40) },
        baseUrl: 'https://af.example.com',
        http: client(impl, 'appsflyer'),
      }),
      new TenjinAttributionProvider({
        credentials: { kind: 'tenjin', apiKey: 'k'.repeat(30) },
        baseUrl: 'https://tenjin.example.com',
        http: client(impl, 'tenjin'),
      }),
    ];
  });

  /**
   * The contract test that keeps MART provider-independent: both MMPs expose
   * exactly the same surface, so nothing downstream needs to know which one is
   * configured.
   */
  it('exposes an identical contract for every MMP', () => {
    for (const provider of providers) {
      expect(provider.category).toBe('attribution_mmp');
      expect(typeof provider.validateConnection).toBe('function');
      expect(typeof provider.listApps).toBe('function');
      expect(typeof provider.getCapabilities).toBe('function');
      expect(typeof provider.syncInstalls).toBe('function');
      expect(typeof provider.syncEvents).toBe('function');
      expect(typeof provider.syncRevenue).toBe('function');
    }
  });

  it('returns capability declarations drawn from the shared vocabulary', async () => {
    for (const provider of providers) {
      const capabilities = await provider.getCapabilities();
      expect(capabilities.length).toBeGreaterThan(0);
      for (const capability of capabilities) {
        expect(typeof capability.supported).toBe('boolean');
        expect(['declared', 'probed', 'inferred', 'manual']).toContain(capability.discoveryMethod);
      }
    }
  });
});

describe('CSV parsing', () => {
  it('handles quoted fields, embedded commas, quotes and newlines', () => {
    const table = parseCsvTable(
      ['Campaign,Spend', '"Summer, 2026","1,234.50"', '"He said ""hi""",2'].join('\n'),
    );
    expect(table.rows[0]?.['campaign']).toBe('Summer, 2026');
    expect(table.rows[0]?.['spend']).toBe('1,234.50');
    expect(table.rows[1]?.['campaign']).toBe('He said "hi"');
  });

  it('normalizes header names but preserves the originals', () => {
    const table = parseCsvTable('Install Time,af_c_id\n2026-08-20,900');
    expect(table.headers).toEqual(['Install Time', 'af_c_id']);
    expect(table.rows[0]?.['install_time']).toBe('2026-08-20');
    expect(table.rows[0]?.['af_c_id']).toBe('900');
  });

  it('returns an empty table for empty input rather than throwing', () => {
    expect(parseCsvTable('')).toEqual({ headers: [], rows: [] });
  });
});

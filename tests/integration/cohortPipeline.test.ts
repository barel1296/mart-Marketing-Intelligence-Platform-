import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { query, queryRows, toNumber } from '@mart/db';
import { proveCohortCurrencyGate, type MetricContext, type MetricFilters } from '@mart/metrics';
import {
  closeServer,
  connectProvider,
  createApp,
  drainSyncQueue,
  reconcile,
  registerUser,
  request,
  truncateAll,
  type TestUser,
} from './helpers.js';
import {
  controls,
  installFakeProviders,
  removeFakeProviders,
  resetControls,
} from './fakeProviders.js';

/**
 * Cohort facts end to end: fake providers -> real sync engine -> PostgreSQL ->
 * the production metric layer -> the API. Each Phase 2 hard rule is asserted
 * on what the API returns, with the underlying rows read back for the
 * arithmetic.
 *
 * Dates are relative to today, because freshness is judged against the wall
 * clock: a fixed August window would be "stale" by September and every
 * expectation would be about staleness rather than cohorts. With H = today:
 *   - the H-10 and H-9 cohorts are mature at D1 and D7 ((H-9)+7 < H)
 *   - the H-8 day has spend and no cohort at all
 *   - the H cohort is immature at both ages ((H)+1 is not < H)
 */

function day(offset: number): string {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - offset);
  return d.toISOString().slice(0, 10);
}
const H = day(0);
const A = day(10);
const B = day(9);
const NO_COHORT_DAY = day(8);
const FROM = A;
const TO = H;

type Ctx = { user: TestUser; appId: string; metaConnectionId: string; mmpConnectionId: string };

type ApiMetric = {
  metricKey: string;
  value: number | null;
  numerator: number | null;
  denominator: number | null;
  availability: string;
  blocker?: string;
  reason?: string;
  grain: { primary: string; mixed?: string[] };
};

async function bindProvider(
  user: TestUser,
  appId: string,
  connectionId: string,
  role: 'marketing_network' | 'primary_attribution',
): Promise<void> {
  const accounts = await request(
    user,
    'GET',
    `/api/v1/organizations/${user.organizationId}/connections/${connectionId}/accounts?refresh=true`,
  );
  let accountId = (accounts.json() as { accounts: Array<{ id: string }> }).accounts[0]?.id;
  if (!accountId) {
    const manual = await request(
      user,
      'POST',
      `/api/v1/organizations/${user.organizationId}/connections/${connectionId}/accounts`,
      { externalAccountId: 'id123456', name: 'Manual MMP App' },
    );
    accountId = (manual.json() as { account: { id: string } }).account.id;
  }
  const response = await request(
    user,
    'POST',
    `/api/v1/organizations/${user.organizationId}/apps/${appId}/bindings`,
    { connectionId, integrationAccountId: accountId, role },
  );
  if (response.statusCode !== 201) {
    throw new Error(`binding failed: ${response.statusCode} ${response.body}`);
  }
}

async function setup(): Promise<Ctx> {
  const user = await registerUser();
  const app = await createApp(user);
  const meta = await connectProvider(user, 'meta_ads', { accessToken: 'a'.repeat(40) });
  const mmp = await connectProvider(user, 'appsflyer', { apiToken: 'x'.repeat(40) });
  await bindProvider(user, app.id, meta.connectionId, 'marketing_network');
  await bindProvider(user, app.id, mmp.connectionId, 'primary_attribution');
  return {
    user,
    appId: app.id,
    metaConnectionId: meta.connectionId,
    mmpConnectionId: mmp.connectionId,
  };
}

async function syncAndReconcile(ctx: Ctx): Promise<void> {
  const response = await request(
    ctx.user,
    'POST',
    `/api/v1/organizations/${ctx.user.organizationId}/apps/${ctx.appId}/sync`,
    { from: FROM, to: TO },
  );
  if (response.statusCode !== 202) throw new Error(`sync failed: ${response.body}`);
  await drainSyncQueue();
  await reconcile(ctx.user.organizationId, ctx.appId, 'meta_ads', 'appsflyer');
}

async function metricsFor(
  ctx: Ctx,
  query = '',
  from = FROM,
  to = TO,
): Promise<Map<string, ApiMetric>> {
  const response = await request(
    ctx.user,
    'GET',
    `/api/v1/organizations/${ctx.user.organizationId}/apps/${ctx.appId}/metrics?from=${from}&to=${to}${query}`,
  );
  if (response.statusCode !== 200) throw new Error(`metrics failed: ${response.body}`);
  return new Map(
    (response.json() as { metrics: ApiMetric[] }).metrics.map((m) => [m.metricKey, m]),
  );
}

const MARKETING = [
  {
    reportDate: A,
    campaignId: '900',
    campaignName: 'Summer US',
    spend: 100,
    impressions: 20_000,
    clicks: 400,
    country: 'US',
  },
  {
    reportDate: B,
    campaignId: '900',
    campaignName: 'Summer US',
    spend: 150,
    impressions: 30_000,
    clicks: 500,
    country: 'US',
  },
  // Spend on a day the mapped campaign bought no install at all. That spend
  // had a return of zero, so it belongs in the denominator.
  {
    reportDate: NO_COHORT_DAY,
    campaignId: '900',
    campaignName: 'Summer US',
    spend: 999,
    impressions: 30_000,
    clicks: 500,
    country: 'US',
  },
  // A campaign the MMP never reports: never mapped, never in a cohort ROAS.
  {
    reportDate: A,
    campaignId: '901',
    campaignName: 'Never attributed',
    spend: 50,
    impressions: 1_000,
    clicks: 10,
    country: 'US',
  },
  // Today's spend keeps the marketing stream fresh; its cohort is immature.
  {
    reportDate: H,
    campaignId: '900',
    campaignName: 'Summer US',
    spend: 10,
    impressions: 1_000,
    clicks: 20,
    country: 'US',
  },
];

const ATTRIBUTION = [
  {
    installDate: A,
    campaignId: '900',
    campaignName: 'Summer US',
    installs: 40,
    country: 'US',
    revenue: 30,
    cohort: { iap: { 1: 10, 7: 25 }, ad: { 1: 4, 7: 9 } },
  },
  {
    installDate: B,
    campaignId: '900',
    campaignName: 'Summer US',
    installs: 50,
    country: 'US',
    revenue: 20,
    cohort: { iap: { 1: 12, 7: 30 }, ad: { 1: 5, 7: 11 } },
  },
  // Organic: real cohort revenue, no campaign, no spend.
  {
    installDate: A,
    campaignId: null,
    campaignName: 'Organic',
    mediaSource: 'Organic',
    installs: 20,
    country: 'US',
    cohort: { iap: { 1: 3, 7: 6 } },
  },
  // Paid, on a campaign the marketing network never reported: unmapped.
  {
    installDate: B,
    campaignId: '777',
    campaignName: 'Unmapped network campaign',
    installs: 10,
    country: 'US',
    cohort: { iap: { 1: 2, 7: 5 } },
  },
  // The horizon day. Installed, but younger than every age MART serves. Its
  // cumulative-so-far figure is exactly what must never be shown as D1/D7.
  {
    installDate: H,
    campaignId: '900',
    campaignName: 'Summer US',
    installs: 30,
    country: 'US',
    revenue: 5,
    cohort: { iap: { 1: 7, 7: 7 }, ad: { 1: 1, 7: 1 } },
  },
];

beforeAll(() => installFakeProviders());
afterAll(async () => {
  removeFakeProviders();
  await closeServer();
});

beforeEach(async () => {
  await truncateAll();
  resetControls();
  controls.marketingRows = structuredClone(MARKETING);
  controls.attributionRows = structuredClone(ATTRIBUTION);
});

describe('cohort pipeline', () => {
  it('stores cohort revenue at cohort_date grain with its age, apart from event-date revenue', async () => {
    const ctx = await setup();
    await syncAndReconcile(ctx);
    const rows = await queryRows<{
      grain: string;
      age: number | null;
      revenue_type: string;
      n: string;
      revenue: string;
    }>(
      `SELECT grain, cohort_age_days AS age, revenue_type, count(*)::text AS n, SUM(revenue)::text AS revenue
         FROM attribution_revenue_metrics WHERE app_id = $1
        GROUP BY grain, cohort_age_days, revenue_type ORDER BY grain, cohort_age_days, revenue_type`,
      [ctx.appId],
    );
    const summary = rows.map(
      (r) => `${r.grain}:${r.age ?? '-'}:${r.revenue_type}=${toNumber(r.revenue)}`,
    );
    expect(summary).toEqual([
      'cohort_date:1:ad=10',
      'cohort_date:1:iap=34',
      'cohort_date:7:ad=21',
      'cohort_date:7:iap=73',
      'event_date:-:iap=55',
    ]);

    const metrics = await metricsFor(ctx);
    // Event-date revenue is untouched by the 138 of cohort revenue beside it.
    expect(metrics.get('attributed_revenue')?.value).toBe(55);
    expect(metrics.get('iap_revenue')?.value).toBe(55);
  });

  it('serves D1 and D7 as distinct facts over mature cohorts, excluding the immature one', async () => {
    const ctx = await setup();
    await syncAndReconcile(ctx);
    const metrics = await metricsFor(ctx);

    // Mature cohorts only: A and B. The H cohort's 7 (its D1 column) and 7
    // (its D7 column) are neither added nor shown.
    const d1 = metrics.get('cohort_iap_revenue_d1');
    const d7 = metrics.get('cohort_iap_revenue_d7');
    expect(d1?.value).toBe(10 + 12 + 3 + 2);
    expect(d7?.value).toBe(25 + 30 + 6 + 5);
    expect(d1?.grain.primary).toBe('cohort_date');
    for (const m of [d1, d7]) {
      expect(m?.availability).toBe('partial');
      expect(m?.reason).toMatch(
        new RegExp(`1 of 3 install day\\(s\\) have not reached D[17] as of ${H}`),
      );
      expect(m?.reason).toMatch(/not counted as zero/);
    }
    expect(metrics.get('cohort_ad_revenue_d7')?.value).toBe(9 + 11);
    expect(metrics.get('cohort_revenue_d7')?.value).toBe(25 + 30 + 6 + 5 + 9 + 11);
  });

  it('divides cohort ROAS by the install-day spend of the mapped campaigns, and nothing else', async () => {
    const ctx = await setup();
    await syncAndReconcile(ctx);
    const metrics = await metricsFor(ctx);

    // Window spend is 100 + 150 + 999 + 50 + 10 = 1309. The denominator is
    // 1249: campaign 900's spend on the mature days A, B and NO_COHORT_DAY -
    // the last of which bought nothing and so returned nothing. Not campaign
    // 901 (never attributed, never mapped) and not today's 10 (immature).
    expect(metrics.get('spend')?.value).toBe(1309);
    const roas = metrics.get('cohort_iap_roas_d7');
    expect(roas?.numerator).toBe(25 + 30);
    expect(roas?.denominator).toBe(1249);
    expect(roas?.value).toBeCloseTo(55 / 1249, 10);
    expect(roas?.availability).toBe('partial');
    // The unmapped campaign's 5 is in neither side, and the reason says so.
    expect(roas?.reason).toMatch(/5\.00 of paid D7 iap revenue is on campaigns MART cannot map/);
    expect(roas?.grain.mixed).toEqual(['cohort_date', 'report_date']);

    expect(metrics.get('cohort_ad_roas_d7')?.value).toBeCloseTo(20 / 1249, 10);
    expect(metrics.get('cohort_roas_d7')?.value).toBeCloseTo(75 / 1249, 10);
    expect(metrics.get('cohort_iap_roas_d1')?.value).toBeCloseTo(22 / 1249, 10);
    // The two ages disagree, as two facts about the same cohorts should.
    expect(metrics.get('cohort_iap_roas_d1')?.value).not.toBe(roas?.value);
  });

  it('refuses a ROAS for organic cohorts while still serving their revenue', async () => {
    const ctx = await setup();
    await syncAndReconcile(ctx);
    const organic = await metricsFor(ctx, '&channel=organic');

    expect(organic.get('cohort_iap_revenue_d7')?.value).toBe(6);
    const roas = organic.get('cohort_iap_roas_d7');
    expect(roas?.value).toBeNull();
    expect(roas?.availability).toBe('unavailable');
    expect(roas?.blocker).toBe('missing_denominator');
    expect(roas?.reason).toMatch(/organic cohorts/i);
  });

  it('blocks every cohort figure as immature when no cohort in the window is old enough', async () => {
    const ctx = await setup();
    await syncAndReconcile(ctx);
    const metrics = await metricsFor(ctx, '', H, H);
    for (const key of [
      'cohort_iap_revenue_d1',
      'cohort_iap_revenue_d7',
      'cohort_iap_roas_d7',
      'cohort_rpi_d1',
    ]) {
      const m = metrics.get(key);
      expect(m?.value, key).toBeNull();
      expect(m?.availability, key).toBe('blocked');
      expect(m?.blocker, key).toBe('immature_cohort');
      expect(m?.reason, key).toMatch(/it is not zero/);
    }
  });

  it('computes RPI over the installs of the same mature cohorts', async () => {
    const ctx = await setup();
    await syncAndReconcile(ctx);
    const metrics = await metricsFor(ctx);
    const rpi = metrics.get('cohort_rpi_d7');
    // A: 40 + 20 organic; B: 50 + 10 unmapped = 120 installs.
    expect(rpi?.denominator).toBe(120);
    expect(rpi?.numerator).toBe(86);
    expect(rpi?.value).toBeCloseTo(86 / 120, 10);
  });

  it('records the provider cohort capabilities after a revenue sync', async () => {
    const ctx = await setup();
    await syncAndReconcile(ctx);
    const rows = await queryRows<{ capability_key: string; supported: boolean }>(
      `SELECT pc.capability_key, pc.supported FROM provider_capabilities pc
        WHERE pc.connection_id = $1 AND pc.integration_account_id IS NOT NULL
          AND pc.capability_key LIKE 'cohort_%' ORDER BY 1`,
      [ctx.mmpConnectionId],
    );
    expect(rows.map((r) => r.capability_key)).toContain('cohort_iap_revenue_d7');
    expect(rows.every((r) => r.supported)).toBe(true);
  });

  it('reports a missing cohort component as unavailable, never as zero revenue', async () => {
    controls.attributionCapabilities = {
      cohort_ad_revenue_d7: false,
      cohort_total_revenue_d7: false,
    };
    const ctx = await setup();
    await syncAndReconcile(ctx);
    const metrics = await metricsFor(ctx);
    const ad = metrics.get('cohort_ad_revenue_d7');
    expect(ad?.value).toBeNull();
    expect(ad?.availability).toBe('unavailable');
    expect(ad?.blocker).toBe('unsupported_metric');
    expect(ad?.reason).toContain('cohort_ad_revenue_d7');
    expect(metrics.get('cohort_roas_d7')?.availability).toBe('unavailable');
    // The component the report does carry is still served.
    expect(metrics.get('cohort_iap_revenue_d7')?.value).toBe(66);
  });

  it('blocks cohort figures, not the event-date ones, when a cohort row arrives in another currency', async () => {
    controls.attributionRows.push({
      installDate: A,
      campaignId: '900',
      campaignName: 'Summer US',
      installs: 0,
      country: 'DE',
      currency: 'EUR',
      cohort: { iap: { 7: 3 } },
    });
    const ctx = await setup();
    await syncAndReconcile(ctx);
    const metrics = await metricsFor(ctx);
    const d7 = metrics.get('cohort_iap_revenue_d7');
    expect(d7?.value).toBeNull();
    expect(d7?.availability).toBe('blocked');
    expect(d7?.blocker).toBe('mixed_currency');
    expect(d7?.reason).toContain('EUR');
    // D1 rows are all USD and unaffected; so is event-date revenue.
    expect(metrics.get('cohort_iap_revenue_d1')?.availability).toBe('partial');
    expect(metrics.get('attributed_revenue')?.value).toBe(55);
  });

  it('proves the cohort currency gate through the production path, inside a rollback', async () => {
    const ctx = await setup();
    await syncAndReconcile(ctx);
    const filters: MetricFilters = {
      organizationId: ctx.user.organizationId,
      appId: ctx.appId,
      from: FROM,
      to: TO,
      country: null,
      platform: null,
      marketingProviderKey: 'meta_ads',
      attributionProviderKey: 'appsflyer',
      marketingAccountExternalId: null,
    };
    const context: MetricContext = {
      hasMarketingConnection: true,
      hasAttributionConnection: true,
      marketingProviders: ['meta_ads'],
      attributionProviders: ['appsflyer'],
      supportedCapabilities: new Set([
        'cost_data',
        'attributed_installs',
        'cohort_reporting',
        'cohort_iap_revenue_d1',
        'cohort_ad_revenue_d1',
        'cohort_total_revenue_d1',
      ]),
      attributionFreshness: { status: 'fresh', latestDataDate: H },
      marketingFreshness: { status: 'fresh', latestDataDate: H },
    };
    const before = await queryRows<{ n: string }>(
      `SELECT count(*)::text AS n FROM attribution_revenue_metrics WHERE app_id = $1`,
      [ctx.appId],
    );
    const proof = await proveCohortCurrencyGate({ filters, context });
    expect(proof.natural.revenueCurrencies).toEqual(['USD']);
    expect(proof.gate.revenueCurrencies).toContain(proof.injected.currency);
    expect(proof.gate.cohortRevenue.blocker).toBe('mixed_currency');
    expect(proof.gate.cohortRoas.blocker).toBe('mixed_currency');
    expect(proof.verdict.passed).toBe(true);
    expect(proof.rollback.verified).toBe(true);
    const after = await queryRows<{ n: string }>(
      `SELECT count(*)::text AS n FROM attribution_revenue_metrics WHERE app_id = $1`,
      [ctx.appId],
    );
    expect(after[0]?.n).toBe(before[0]?.n);
  });
});

describe('cohort coverage and storage guards', () => {
  it('treats install days the revenue sync never read as unknown, on every side', async () => {
    const ctx = await setup();
    await syncAndReconcile(ctx);
    // Forget what the revenue runs read. The rows are still there; what is
    // gone is the evidence that any day was read after its cohort matured.
    await query(
      `UPDATE sync_runs SET checkpoint = checkpoint - 'dataWindows'
        WHERE app_id = $1 AND data_type = 'attribution_revenue'`,
      [ctx.appId],
    );
    const metrics = await metricsFor(ctx);
    for (const key of [
      'cohort_iap_revenue_d7',
      'cohort_rpi_d7',
      'cohort_iap_roas_d7',
      'cohort_iap_revenue_d1',
    ]) {
      const m = metrics.get(key);
      expect(m?.value, key).toBeNull();
      expect(m?.availability, key).toBe('blocked');
      expect(m?.blocker, key).toBe('provider_stale');
      expect(m?.reason, key).toMatch(/unknown, not zero/);
    }
    // Event-date figures do not depend on cohort coverage.
    expect(metrics.get('attributed_revenue')?.value).toBe(55);
  });

  it('excludes a day only the installs stream reached', async () => {
    // A revenue run that only ever read up to B: the H-8 spend day and the H
    // cohort are beyond what the revenue stream covered, so the denominator
    // loses the 999 and the numerator is unchanged.
    const ctx = await setup();
    await syncAndReconcile(ctx);
    await query(
      `UPDATE sync_runs
          SET checkpoint = jsonb_set(checkpoint, '{dataWindows}', jsonb_build_array(jsonb_build_object('from', $2::text, 'to', $3::text)))
        WHERE app_id = $1 AND data_type = 'attribution_revenue'`,
      [ctx.appId, A, B],
    );
    const metrics = await metricsFor(ctx);
    const roas = metrics.get('cohort_iap_roas_d7');
    expect(roas?.numerator).toBe(55);
    expect(roas?.denominator).toBe(250);
    expect(roas?.reason).toMatch(/1 of 3 install day\(s\) have not reached D7/);
  });

  it('does not add a provider total to the components it was later split into', async () => {
    const ctx = await setup();
    await syncAndReconcile(ctx);
    const before = (await metricsFor(ctx)).get('cohort_revenue_d7')?.value;
    const connection = await queryRows<{ id: string }>(
      `SELECT connection_id AS id FROM attribution_revenue_metrics WHERE app_id = $1 LIMIT 1`,
      [ctx.appId],
    );
    // The leftover a report gains its split leaves behind: a total for cohort
    // A at D7, beside the iap and ad rows the later sync stored.
    await query(
      `INSERT INTO attribution_revenue_metrics
         (organization_id, app_id, connection_id, provider_key, grain, activity_date, cohort_age_days,
          revenue_type, media_source, normalized_media_source, external_campaign_id, campaign_name,
          country, platform, currency, revenue, dimension_hash)
       VALUES ($1, $2, $3, 'appsflyer', 'cohort_date', $4, 7, 'total', 'facebook', 'meta', '900',
               'Summer US', 'US', 'ios', 'USD', 34, 'leftover-total')`,
      [ctx.user.organizationId, ctx.appId, connection[0]?.id, A],
    );
    const after = (await metricsFor(ctx)).get('cohort_revenue_d7')?.value;
    expect(after).toBe(before);
  });

  it('refuses a reporting timezone PostgreSQL would not recognize', async () => {
    const user = await registerUser();
    const response = await request(
      user,
      'POST',
      `/api/v1/organizations/${user.organizationId}/apps`,
      {
        name: 'Bad zone',
        platform: 'ios',
        bundleId: 'com.example.badzone',
        timezone: 'Europe/Lodnon',
        defaultCurrency: 'USD',
      },
    );
    expect(response.statusCode).toBe(400);
  });
});

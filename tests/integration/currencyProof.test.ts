import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { queryRows } from '@mart/db';
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
import {
  loadMarketingAggregate,
  proveMixedCurrencyGate,
  snapshotForProof,
  type MetricContext,
  type MetricFilters,
} from '@mart/metrics';

type Ctx = { user: TestUser; appId: string; metaConnectionId: string; mmpConnectionId: string };

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

  // AppsFlyer's Pull API cannot enumerate apps, so the product flow is manual
  // entry of the app id. Exercise that path rather than assuming discovery.
  if (!accountId) {
    const manual = await request(
      user,
      'POST',
      `/api/v1/organizations/${user.organizationId}/connections/${connectionId}/accounts`,
      { externalAccountId: 'id123456', name: 'Manual MMP App' },
    );
    if (manual.statusCode !== 201) {
      throw new Error(`manual account failed: ${manual.statusCode} ${manual.body}`);
    }
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

async function setup(mmp: 'appsflyer' | 'tenjin' = 'appsflyer'): Promise<Ctx> {
  const user = await registerUser();
  const app = await createApp(user);
  const meta = await connectProvider(user, 'meta_ads', { accessToken: 'a'.repeat(40) });
  const attribution = await connectProvider(
    user,
    mmp,
    mmp === 'appsflyer' ? { apiToken: 'x'.repeat(40) } : { apiKey: 'k'.repeat(40) },
  );
  await bindProvider(user, app.id, meta.connectionId, 'marketing_network');
  await bindProvider(user, app.id, attribution.connectionId, 'primary_attribution');
  return {
    user,
    appId: app.id,
    metaConnectionId: meta.connectionId,
    mmpConnectionId: attribution.connectionId,
  };
}

async function triggerSync(ctx: Ctx, from: string, to: string): Promise<void> {
  const response = await request(
    ctx.user,
    'POST',
    `/api/v1/organizations/${ctx.user.organizationId}/apps/${ctx.appId}/sync`,
    { from, to },
  );
  if (response.statusCode !== 202) {
    throw new Error(`sync trigger failed: ${response.statusCode} ${response.body}`);
  }
  await drainSyncQueue();
}

const BASE_MARKETING = [
  {
    reportDate: '2026-08-20',
    campaignId: '900',
    campaignName: 'Summer',
    spend: 100,
    impressions: 5000,
    clicks: 100,
  },
];
const BASE_ATTRIBUTION = [
  {
    installDate: '2026-08-20',
    campaignId: '900',
    campaignName: 'Summer',
    installs: 40,
    revenue: 30,
  },
];

async function filtersFor(ctx: Awaited<ReturnType<typeof setup>>): Promise<MetricFilters> {
  return {
    organizationId: ctx.user.organizationId,
    appId: ctx.appId,
    from: '2026-08-20',
    to: '2026-08-20',
    marketingProviderKey: 'meta_ads',
    attributionProviderKey: 'appsflyer',
  };
}

const CONTEXT: MetricContext = {
  hasMarketingConnection: true,
  hasAttributionConnection: true,
  marketingProviders: ['meta_ads'],
  attributionProviders: ['appsflyer'],
  supportedCapabilities: new Set([
    'cost_data',
    'delivery_metrics',
    'installs',
    'revenue',
    'attributed_installs',
    'attributed_revenue',
  ]),
  marketingFreshness: { status: 'fresh', latestDataDate: '2026-08-20' },
  attributionFreshness: { status: 'fresh', latestDataDate: '2026-08-20' },
};

const PROOF_TAG = 'mart-currency-proof';

async function syntheticRowCount(appId: string): Promise<number> {
  const rows = await queryRows<{ n: string }>(
    `SELECT (SELECT count(*) FROM marketing_daily_metrics WHERE app_id = $1 AND external_campaign_id LIKE $2)
          + (SELECT count(*) FROM attribution_revenue_metrics WHERE app_id = $1 AND external_campaign_id LIKE $2) AS n`,
    [appId, `${PROOF_TAG}%`],
  );
  return Number(rows[0]?.n ?? 0);
}

/**
 * The gate only fires on a condition a healthy account never produces, so the
 * proof creates it on purpose and undoes it unconditionally. These tests pin
 * both halves: that the PRODUCTION path refuses, and that nothing survives.
 */
describe('mixed-currency gate proof', () => {
  beforeAll(() => installFakeProviders());
  afterAll(async () => {
    removeFakeProviders();
    await closeServer();
  });
  beforeEach(async () => {
    await truncateAll();
    resetControls();
    controls.marketingRows = structuredClone(BASE_MARKETING);
    controls.attributionRows = structuredClone(BASE_ATTRIBUTION);
  });

  it('computes same-currency aggregation as a plain number', async () => {
    const ctx = await setup();
    await triggerSync(ctx, '2026-08-20', '2026-08-20');
    const proof = await proveMixedCurrencyGate({
      filters: await filtersFor(ctx),
      context: CONTEXT,
    });
    expect(proof.natural.marketingCurrencies).toEqual(['USD']);
    expect(proof.natural.spendAvailability).not.toBe('blocked');
    expect(proof.natural.spendValue).toBe(100);
  });

  it('proves the production path refuses USD + EUR rather than summing them', async () => {
    const ctx = await setup();
    await triggerSync(ctx, '2026-08-20', '2026-08-20');
    const proof = await proveMixedCurrencyGate({
      filters: await filtersFor(ctx),
      context: CONTEXT,
    });

    expect(proof.injected.currency).toBe('EUR');
    // Detected by the real loaders...
    expect(proof.gate.marketingCurrencies.sort()).toEqual(['EUR', 'USD']);
    expect(proof.gate.revenueCurrencies.sort()).toEqual(['EUR', 'USD']);
    // ...refused by the real metric computation, on both fact families...
    expect(proof.gate.spend.availability).toBe('blocked');
    expect(proof.gate.spend.blocker).toBe('mixed_currency');
    expect(proof.gate.revenue?.availability).toBe('blocked');
    expect(proof.gate.revenue?.blocker).toBe('mixed_currency');
    // ...with no number produced: 100 USD + 1 EUR is not 101 of anything.
    expect(proof.gate.spend.value).toBeNull();
    expect(proof.gate.spend.numerator).toBeNull();
    expect(proof.gate.spend.value).not.toBe(101);
    // ...and the reason says which currencies.
    expect(proof.gate.spend.reason).toMatch(/EUR/);
    expect(proof.gate.spend.reason).toMatch(/USD/);
    expect(proof.verdict.passed).toBe(true);
  });

  it('leaves the database exactly as it found it', async () => {
    const ctx = await setup();
    await triggerSync(ctx, '2026-08-20', '2026-08-20');
    await reconcile(ctx.user.organizationId, ctx.appId);

    const before = await snapshotForProof(ctx.appId);
    const proof = await proveMixedCurrencyGate({
      filters: await filtersFor(ctx),
      context: CONTEXT,
    });
    const after = await snapshotForProof(ctx.appId);

    expect(proof.rollback.verified).toBe(true);
    expect(after).toEqual(before);
    expect(await syntheticRowCount(ctx.appId)).toBe(0);
    // And the natural figure is still the natural figure.
    const again = await proveMixedCurrencyGate({
      filters: await filtersFor(ctx),
      context: CONTEXT,
    });
    expect(again.natural.spendValue).toBe(100);
  });

  it('rolls back even when the proof dies half-way', async () => {
    const ctx = await setup();
    await triggerSync(ctx, '2026-08-20', '2026-08-20');
    const before = await snapshotForProof(ctx.appId);

    await expect(
      proveMixedCurrencyGate({
        filters: await filtersFor(ctx),
        context: CONTEXT,
        afterInject: async () => {
          // The synthetic rows exist at this moment. Prove it, then die.
          // (Visible only inside the transaction; the pool cannot see them.)
          throw new Error('simulated failure after injection');
        },
      }),
    ).rejects.toThrow(/simulated failure/);

    expect(await snapshotForProof(ctx.appId)).toEqual(before);
    expect(await syntheticRowCount(ctx.appId)).toBe(0);
  });

  it('never leaves reconciliation, freshness, errors or connection state changed', async () => {
    const ctx = await setup();
    await triggerSync(ctx, '2026-08-20', '2026-08-20');
    await reconcile(ctx.user.organizationId, ctx.appId);
    const before = await snapshotForProof(ctx.appId);
    await proveMixedCurrencyGate({ filters: await filtersFor(ctx), context: CONTEXT });
    const after = await snapshotForProof(ctx.appId);
    for (const table of [
      'provider_entity_mappings',
      'data_freshness',
      'sync_errors',
      'sync_runs',
      'integration_connections',
      'data_quality_findings',
    ]) {
      expect(after[table], table).toBe(before[table]);
    }
  });

  it('does not change what Phase 0 measures', async () => {
    // The proof reads through the production loaders; it must not have
    // changed what they return for real data.
    const ctx = await setup();
    await triggerSync(ctx, '2026-08-20', '2026-08-20');
    const filters = await filtersFor(ctx);
    const plain = await loadMarketingAggregate(filters);
    await proveMixedCurrencyGate({ filters, context: CONTEXT });
    const afterProof = await loadMarketingAggregate(filters);
    expect(afterProof).toEqual(plain);
    expect(afterProof.spend).toBe(100);
    expect(afterProof.currencies).toEqual(['USD']);
  });
});

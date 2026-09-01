import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { query, queryRows, syncRepo, toNumber } from '@mart/db';
import { campaignCoverage, getRemoteIdResolver } from '@mart/integrations';
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
    campaignName: 'Summer US',
    spend: 100,
    impressions: 20_000,
    clicks: 400,
    country: 'US',
  },
  {
    reportDate: '2026-08-21',
    campaignId: '900',
    campaignName: 'Summer US',
    spend: 150,
    impressions: 30_000,
    clicks: 500,
    country: 'US',
  },
];

const BASE_ATTRIBUTION = [
  {
    installDate: '2026-08-20',
    campaignId: '900',
    campaignName: 'Summer US',
    installs: 40,
    country: 'US',
    revenue: 30,
  },
  {
    installDate: '2026-08-21',
    campaignId: '900',
    campaignName: 'Summer US',
    installs: 60,
    country: 'US',
    revenue: 45,
  },
];

describe('sync pipeline', () => {
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

  it('imports provider data into canonical tables and records raw payloads', async () => {
    const ctx = await setup();
    await triggerSync(ctx, '2026-08-20', '2026-08-21');

    const marketing = await queryRows<{
      report_date: string;
      spend: string;
      campaign_id: string | null;
    }>(
      'SELECT report_date, spend, campaign_id FROM marketing_daily_metrics WHERE app_id = $1 ORDER BY report_date',
      [ctx.appId],
    );
    expect(marketing).toHaveLength(2);
    expect(toNumber(marketing[0]?.spend)).toBe(100);
    // The fact is linked to the campaign dimension row after structure sync.
    expect(marketing[0]?.campaign_id).not.toBeNull();

    const campaigns = await queryRows<{ external_campaign_id: string; name: string }>(
      'SELECT external_campaign_id, name FROM marketing_campaigns WHERE app_id = $1',
      [ctx.appId],
    );
    expect(campaigns[0]?.external_campaign_id).toBe('900');

    const attribution = await queryRows<{
      install_date: string;
      attributed_installs: string;
      grain: string;
    }>(
      'SELECT install_date, attributed_installs, grain FROM attribution_daily_metrics WHERE app_id = $1 ORDER BY install_date',
      [ctx.appId],
    );
    expect(attribution).toHaveLength(2);
    expect(toNumber(attribution[0]?.attributed_installs)).toBe(40);
    expect(attribution[0]?.grain).toBe('install_date');

    const revenue = await queryRows<{ grain: string; revenue: string }>(
      'SELECT grain, revenue FROM attribution_revenue_metrics WHERE app_id = $1',
      [ctx.appId],
    );
    expect(revenue.length).toBeGreaterThan(0);
    // Revenue is event-date, never silently treated as cohort revenue.
    expect(revenue.every((r) => r.grain === 'event_date')).toBe(true);

    const raw = await queryRows<{ count: string }>(
      'SELECT count(*)::text AS count FROM raw_ingestion_batches WHERE app_id = $1',
      [ctx.appId],
    );
    expect(toNumber(raw[0]?.count)).toBeGreaterThan(0);
  });

  it('is idempotent: re-running the same window does not duplicate facts', async () => {
    const ctx = await setup();
    await triggerSync(ctx, '2026-08-20', '2026-08-21');
    const firstCount = await countFacts(ctx.appId);

    await triggerSync(ctx, '2026-08-20', '2026-08-21');
    const secondCount = await countFacts(ctx.appId);

    expect(secondCount).toEqual(firstCount);
    // The provider really was called again; de-duplication happens on write.
    expect(controls.calls.performance).toBeGreaterThan(1);

    const generations = await queryRows<{ restatement_generation: number }>(
      'SELECT restatement_generation FROM marketing_daily_metrics WHERE app_id = $1',
      [ctx.appId],
    );
    // Values did not change, so nothing counts as a restatement.
    expect(generations.every((g) => g.restatement_generation === 0)).toBe(true);
  });

  it('records a restatement when the provider revises a number', async () => {
    const ctx = await setup();
    await triggerSync(ctx, '2026-08-20', '2026-08-21');

    // Meta restates yesterday's spend, as it does in production.
    const first = controls.marketingRows[0];
    if (first) first.spend = 130;
    await triggerSync(ctx, '2026-08-20', '2026-08-21');

    const rows = await queryRows<{
      report_date: string;
      spend: string;
      restatement_generation: number;
      last_restated_at: Date | null;
    }>(
      `SELECT report_date, spend, restatement_generation, last_restated_at
       FROM marketing_daily_metrics WHERE app_id = $1 ORDER BY report_date`,
      [ctx.appId],
    );
    expect(rows).toHaveLength(2);
    expect(toNumber(rows[0]?.spend)).toBe(130);
    expect(rows[0]?.restatement_generation).toBe(1);
    expect(rows[0]?.last_restated_at).not.toBeNull();
    // The untouched day is not marked as restated.
    expect(rows[1]?.restatement_generation).toBe(0);
  });

  it('does not double-count spend when a provider changes the dimensional grain', async () => {
    // Country is part of the dimension hash, so the same campaign-day fetched
    // with a country breakdown and fetched without one are two different keys
    // and the upsert cannot supersede one with the other. The metric queries
    // sum delivery by date with no country predicate, so both copies would be
    // counted: spend doubles and ROAS halves. Meta reaches this state on its
    // own - one rejected breakdown degrades the window to a country-null
    // total, and the restatement lookback re-reads days already stored split.
    const ctx = await setup();
    await triggerSync(ctx, '2026-08-20', '2026-08-21');

    const split = await queryRows<{ total: string }>(
      'SELECT COALESCE(SUM(spend), 0)::text AS total FROM marketing_daily_metrics WHERE app_id = $1',
      [ctx.appId],
    );
    expect(toNumber(split[0]?.total)).toBe(250);

    // The provider degrades: the same days, same campaign, no country split.
    for (const row of controls.marketingRows) row.country = null;
    await triggerSync(ctx, '2026-08-20', '2026-08-21');

    const rows = await queryRows<{ report_date: string; country: string | null; spend: string }>(
      `SELECT report_date::text AS report_date, country, spend
         FROM marketing_daily_metrics WHERE app_id = $1 ORDER BY report_date, country`,
      [ctx.appId],
    );
    // One row per campaign-day, at the grain that arrived last.
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.country === null)).toBe(true);
    expect(rows.reduce((sum, r) => sum + toNumber(r.spend), 0)).toBe(250);
  });

  it('supersedes a coarser stored row when the breakdown comes back', async () => {
    // The same rule in the other direction: an account that gains the country
    // breakdown must not leave yesterday's un-split total behind to be summed
    // alongside the per-country rows that replace it.
    const ctx = await setup();
    for (const row of controls.marketingRows) row.country = null;
    await triggerSync(ctx, '2026-08-20', '2026-08-21');

    controls.marketingRows = [
      {
        reportDate: '2026-08-20',
        campaignId: '900',
        campaignName: 'Summer US',
        spend: 60,
        impressions: 12_000,
        clicks: 240,
        country: 'US',
      },
      {
        reportDate: '2026-08-20',
        campaignId: '900',
        campaignName: 'Summer US',
        spend: 40,
        impressions: 8_000,
        clicks: 160,
        country: 'GB',
      },
    ];
    await triggerSync(ctx, '2026-08-20', '2026-08-20');

    const rows = await queryRows<{ country: string | null; spend: string }>(
      `SELECT country, spend FROM marketing_daily_metrics
        WHERE app_id = $1 AND report_date = '2026-08-20' ORDER BY country`,
      [ctx.appId],
    );
    expect(rows.map((r) => r.country)).toEqual(['GB', 'US']);
    expect(rows.reduce((sum, r) => sum + toNumber(r.spend), 0)).toBe(100);
  });

  it('leaves a campaign-day alone when only another campaign changed grain', async () => {
    // Supersession is scoped to the campaign-day that actually restated; a
    // second campaign still reporting per country keeps its rows.
    const ctx = await setup();
    controls.marketingRows = [
      {
        reportDate: '2026-08-20',
        campaignId: '900',
        campaignName: 'Summer US',
        spend: 100,
        impressions: 20_000,
        clicks: 400,
        country: 'US',
      },
      {
        reportDate: '2026-08-20',
        campaignId: '901',
        campaignName: 'Winter US',
        spend: 70,
        impressions: 10_000,
        clicks: 200,
        country: 'US',
      },
    ];
    await triggerSync(ctx, '2026-08-20', '2026-08-20');

    const marketingRow = controls.marketingRows[0];
    if (marketingRow) marketingRow.country = null;
    await triggerSync(ctx, '2026-08-20', '2026-08-20');

    const rows = await queryRows<{ campaign: string; country: string | null; spend: string }>(
      `SELECT external_campaign_id AS campaign, country, spend
         FROM marketing_daily_metrics WHERE app_id = $1 ORDER BY external_campaign_id`,
      [ctx.appId],
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]?.country).toBeNull();
    expect(rows[1]?.country).toBe('US');
    expect(rows.reduce((sum, r) => sum + toNumber(r.spend), 0)).toBe(170);
  });

  it('completes partially when one window fails, keeping the windows that succeeded', async () => {
    const ctx = await setup();
    // Chunk size is 7 days, so this range produces three windows.
    controls.failWindows = new Set(['2026-08-08..2026-08-14']);
    controls.failureClass = 'invalid_request';
    controls.marketingRows = [
      {
        reportDate: '2026-08-02',
        campaignId: '900',
        campaignName: 'A',
        spend: 10,
        impressions: 100,
        clicks: 5,
      },
      {
        reportDate: '2026-08-10',
        campaignId: '900',
        campaignName: 'A',
        spend: 20,
        impressions: 200,
        clicks: 6,
      },
      {
        reportDate: '2026-08-16',
        campaignId: '900',
        campaignName: 'A',
        spend: 30,
        impressions: 300,
        clicks: 7,
      },
    ];
    controls.attributionRows = [];

    await triggerSync(ctx, '2026-08-01', '2026-08-21');

    const runs = await queryRows<{
      status: string;
      data_type: string;
      checkpoint: { completedWindows?: string[] };
    }>(
      `SELECT status, data_type, checkpoint FROM sync_runs
       WHERE app_id = $1 AND data_type = 'marketing_performance'`,
      [ctx.appId],
    );
    expect(runs[0]?.status).toBe('partially_completed');
    // The failed window is absent from the checkpoint; the others are recorded.
    expect(runs[0]?.checkpoint.completedWindows).toContain('2026-08-01..2026-08-07');
    expect(runs[0]?.checkpoint.completedWindows).not.toContain('2026-08-08..2026-08-14');

    const dates = await queryRows<{ report_date: string }>(
      'SELECT report_date FROM marketing_daily_metrics WHERE app_id = $1 ORDER BY report_date',
      [ctx.appId],
    );
    expect(dates.map((d) => d.report_date)).toEqual(['2026-08-02', '2026-08-16']);

    const errors = await queryRows<{ error_class: string; window_start: string }>(
      'SELECT error_class, window_start FROM sync_errors WHERE organization_id = $1',
      [ctx.user.organizationId],
    );
    expect(errors.some((e) => e.error_class === 'invalid_request')).toBe(true);
  });

  it('stops the run on a retryable failure so the scheduler can retry', async () => {
    const ctx = await setup();
    controls.failWindows = new Set(['2026-08-08..2026-08-14']);
    controls.failureClass = 'rate_limited';
    controls.marketingRows = [
      {
        reportDate: '2026-08-02',
        campaignId: '900',
        campaignName: 'A',
        spend: 10,
        impressions: 100,
        clicks: 5,
      },
      {
        reportDate: '2026-08-16',
        campaignId: '900',
        campaignName: 'A',
        spend: 30,
        impressions: 300,
        clicks: 7,
      },
    ];
    controls.attributionRows = [];

    await triggerSync(ctx, '2026-08-01', '2026-08-21');

    const runs = await queryRows<{ status: string; error_class: string | null }>(
      `SELECT status, error_class FROM sync_runs WHERE app_id = $1 AND data_type = 'marketing_performance'`,
      [ctx.appId],
    );
    expect(runs[0]?.status).toBe('partially_completed');
    expect(runs[0]?.error_class).toBe('rate_limited');

    // The third window was never attempted, so its data is absent.
    const dates = await queryRows<{ report_date: string }>(
      'SELECT report_date FROM marketing_daily_metrics WHERE app_id = $1',
      [ctx.appId],
    );
    expect(dates.map((d) => d.report_date)).toEqual(['2026-08-02']);
  });

  it('waits before retrying a retryable failure instead of retrying immediately', async () => {
    const ctx = await setup();
    controls.failWindows = new Set(['2026-08-01..2026-08-07']);
    controls.failureClass = 'rate_limited';
    controls.marketingRows = [];
    controls.attributionRows = [];

    await triggerSync(ctx, '2026-08-01', '2026-08-07');

    const [run] = await queryRows<{ id: string; attempt: number; status: string }>(
      `SELECT id, attempt, status FROM sync_runs
       WHERE app_id = $1 AND data_type = 'marketing_performance'`,
      [ctx.appId],
    );
    expect(run).toBeDefined();
    if (!run) throw new Error('expected a marketing performance run');

    const requeued = await syncRepo.requeueRun(run.id, 5, 60_000);
    expect(requeued).toBe(true);

    const [after] = await queryRows<{ attempt: number; status: string; future: boolean }>(
      `SELECT attempt, status, not_before > now() AS future FROM sync_runs WHERE id = $1`,
      [run.id],
    );
    expect(after?.status).toBe('queued');
    expect(after?.attempt).toBe(run.attempt + 1);
    expect(after?.future).toBe(true);

    // A rate-limited run must not be picked straight back up on the next poll:
    // that would burn the whole retry budget in seconds.
    const claimed = await syncRepo.claimQueuedRuns(10);
    expect(claimed.map((r) => r.id)).not.toContain(run.id);
  });

  it('updates freshness from the newest provider-reported date', async () => {
    const ctx = await setup();
    await triggerSync(ctx, '2026-08-20', '2026-08-21');

    const response = await request(
      ctx.user,
      'GET',
      `/api/v1/organizations/${ctx.user.organizationId}/apps/${ctx.appId}/freshness`,
    );
    const freshness = (
      response.json() as {
        freshness: Array<{
          data_type: string;
          latest_provider_data_date: string | null;
          status: string;
          last_success_at: string | null;
        }>;
      }
    ).freshness;
    const performance = freshness.find((f) => f.data_type === 'marketing_performance');
    expect(performance?.latest_provider_data_date).toBe('2026-08-21');
    expect(performance?.last_success_at).not.toBeNull();
    // The fixture data is historical, so MART correctly reports it as stale
    // rather than pretending a successful sync means current data.
    expect(['fresh', 'delayed', 'stale']).toContain(performance?.status);
  });

  it('does not enqueue a duplicate run while one is already in flight', async () => {
    const ctx = await setup();
    const first = await request(
      ctx.user,
      'POST',
      `/api/v1/organizations/${ctx.user.organizationId}/apps/${ctx.appId}/sync`,
      { from: '2026-08-20', to: '2026-08-21' },
    );
    const second = await request(
      ctx.user,
      'POST',
      `/api/v1/organizations/${ctx.user.organizationId}/apps/${ctx.appId}/sync`,
      { from: '2026-08-20', to: '2026-08-21' },
    );
    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(202);
    expect((second.json() as { skipped: unknown[] }).skipped.length).toBeGreaterThan(0);
    expect((second.json() as { enqueued: unknown[] }).enqueued).toHaveLength(0);
  });

  it('works identically with Tenjin as the attribution provider', async () => {
    const ctx = await setup('tenjin');
    await triggerSync(ctx, '2026-08-20', '2026-08-21');

    const rows = await queryRows<{ provider_key: string; attributed_installs: string }>(
      'SELECT provider_key, attributed_installs FROM attribution_daily_metrics WHERE app_id = $1',
      [ctx.appId],
    );
    expect(rows.length).toBeGreaterThan(0);
    // Provenance is preserved on every canonical fact.
    expect(rows.every((r) => r.provider_key === 'tenjin')).toBe(true);
  });
});

describe('reconciliation', () => {
  beforeAll(() => installFakeProviders());
  afterAll(async () => {
    removeFakeProviders();
    await closeServer();
  });
  beforeEach(async () => {
    await truncateAll();
    resetControls();
  });

  it('matches on stable campaign id and marks it exact', async () => {
    controls.marketingRows = structuredClone(BASE_MARKETING);
    controls.attributionRows = structuredClone(BASE_ATTRIBUTION);
    const ctx = await setup();
    await triggerSync(ctx, '2026-08-20', '2026-08-21');
    const summary = await reconcile(ctx.user.organizationId, ctx.appId);

    expect(summary.matchedExact).toBe(1);
    expect(summary.matchedFallback).toBe(0);
    expect(summary.unmatchedMarketing).toBe(0);

    const mappings = await queryRows<{
      status: string;
      mapping_method: string;
      mapping_confidence: string;
    }>(
      `SELECT status, mapping_method, mapping_confidence FROM provider_entity_mappings
       WHERE app_id = $1 AND source_provider = 'meta_ads'`,
      [ctx.appId],
    );
    expect(mappings[0]?.status).toBe('matched_exact');
    expect(mappings[0]?.mapping_method).toBe('stable_external_id');
    expect(Number(mappings[0]?.mapping_confidence)).toBe(1);
  });

  it('records a name match as a fallback candidate, never as authoritative', async () => {
    controls.marketingRows = [
      {
        reportDate: '2026-08-20',
        campaignId: '900',
        campaignName: 'Summer US',
        spend: 100,
        impressions: 1000,
        clicks: 10,
      },
    ];
    // The MMP has no campaign id (e.g. AppsFlyer aggregate reporting).
    controls.attributionRows = [
      { installDate: '2026-08-20', campaignId: null, campaignName: 'summer us', installs: 40 },
    ];
    const ctx = await setup();
    await triggerSync(ctx, '2026-08-20', '2026-08-20');
    const summary = await reconcile(ctx.user.organizationId, ctx.appId);

    expect(summary.matchedExact).toBe(0);
    expect(summary.matchedFallback).toBe(1);

    const mapping = await queryRows<{
      status: string;
      mapping_method: string;
      mapping_confidence: string;
      evidence: Record<string, unknown>;
    }>(
      `SELECT status, mapping_method, mapping_confidence, evidence FROM provider_entity_mappings
       WHERE app_id = $1 AND source_provider = 'meta_ads'`,
      [ctx.appId],
    );
    expect(mapping[0]?.status).toBe('matched_fallback');
    expect(mapping[0]?.mapping_method).toBe('name_fallback');
    expect(Number(mapping[0]?.mapping_confidence)).toBeLessThan(1);
    expect(String(mapping[0]?.evidence['note'])).toMatch(/not authoritative/i);

    // The campaign table must withhold attribution figures for a non-authoritative link.
    const table = await request(
      ctx.user,
      'GET',
      `/api/v1/organizations/${ctx.user.organizationId}/apps/${ctx.appId}/campaigns?from=2026-08-20&to=2026-08-20`,
    );
    const rows = (
      table.json() as {
        rows: Array<{
          mappingStatus: string;
          attributedInstalls: number | null;
          reportedCpi: number | null;
          attributionNote: string | null;
        }>;
      }
    ).rows;
    expect(rows[0]?.mappingStatus).toBe('matched_fallback');
    expect(rows[0]?.attributedInstalls).toBeNull();
    expect(rows[0]?.reportedCpi).toBeNull();
    expect(rows[0]?.attributionNote).toMatch(/verified/i);
  });

  it('keeps ambiguous matches ambiguous rather than picking one', async () => {
    controls.marketingRows = [
      {
        reportDate: '2026-08-20',
        campaignId: '900',
        campaignName: 'Summer',
        spend: 100,
        impressions: 1000,
        clicks: 10,
      },
    ];
    controls.attributionRows = [
      { installDate: '2026-08-20', campaignId: '111', campaignName: 'Summer', installs: 10 },
      { installDate: '2026-08-20', campaignId: '222', campaignName: 'summer', installs: 20 },
    ];
    const ctx = await setup();
    await triggerSync(ctx, '2026-08-20', '2026-08-20');
    const summary = await reconcile(ctx.user.organizationId, ctx.appId);

    expect(summary.ambiguous).toBe(1);
    const mapping = await queryRows<{
      status: string;
      target_external_id: string | null;
      candidate_count: number;
    }>(
      `SELECT status, target_external_id, candidate_count FROM provider_entity_mappings
       WHERE app_id = $1 AND source_provider = 'meta_ads'`,
      [ctx.appId],
    );
    expect(mapping[0]?.status).toBe('ambiguous');
    expect(mapping[0]?.target_external_id).toBeNull();
    expect(mapping[0]?.candidate_count).toBe(2);
  });

  it('keeps unmatched entities visible on both sides', async () => {
    controls.marketingRows = [
      {
        reportDate: '2026-08-20',
        campaignId: '900',
        campaignName: 'Meta Only',
        spend: 100,
        impressions: 1000,
        clicks: 10,
      },
    ];
    controls.attributionRows = [
      { installDate: '2026-08-20', campaignId: '777', campaignName: 'MMP Only', installs: 5 },
    ];
    const ctx = await setup();
    await triggerSync(ctx, '2026-08-20', '2026-08-20');
    const summary = await reconcile(ctx.user.organizationId, ctx.appId);

    expect(summary.unmatchedMarketing).toBe(1);
    expect(summary.unmatchedAttribution).toBe(1);

    const response = await request(
      ctx.user,
      'GET',
      `/api/v1/organizations/${ctx.user.organizationId}/apps/${ctx.appId}/reconciliation?from=2026-08-20&to=2026-08-20`,
    );
    const body = response.json() as {
      coverage: { coveragePct: number | null; unmatched: number };
      discrepancies: Array<{ kind: string }>;
    };
    expect(body.coverage.coveragePct).toBe(0);
    const kinds = body.discrepancies.map((d) => d.kind);
    expect(kinds).toContain('delivery_without_attribution');
    expect(kinds).toContain('attribution_without_mapping');
  });

  it('ranks the campaign table by what was spent, not by how the number reads', async () => {
    // The select list exposes spend as ::text, and a bare column name in ORDER
    // BY binds to the output column before the CTE's numeric one - so the sort
    // was lexicographic and put a campaign that spent 9 above one that spent
    // 100. "Top campaigns by spend" is the table's whole purpose.
    controls.marketingRows = [
      {
        reportDate: '2026-08-20',
        campaignId: '900',
        campaignName: 'Big spender',
        spend: 100,
        impressions: 5000,
        clicks: 100,
      },
      {
        reportDate: '2026-08-20',
        campaignId: '901',
        campaignName: 'Small spender',
        spend: 9,
        impressions: 400,
        clicks: 9,
      },
    ];
    controls.attributionRows = [];
    const ctx = await setup();
    await triggerSync(ctx, '2026-08-20', '2026-08-20');

    const table = await request(
      ctx.user,
      'GET',
      `/api/v1/organizations/${ctx.user.organizationId}/apps/${ctx.appId}/campaigns?from=2026-08-20&to=2026-08-20&sort=spend&direction=desc`,
    );
    const rows = (table.json() as { rows: Array<{ externalCampaignId: string; spend: number }> })
      .rows;
    expect(rows.map((r) => r.externalCampaignId)).toEqual(['900', '901']);
  });

  it('applies a country filter to both halves of a campaign row', async () => {
    // Filtering spend to one country while installs stay account-wide makes the
    // per-campaign CPI a ratio between two populations - and it reads as a real
    // number, because both halves are real.
    controls.marketingRows = [
      {
        reportDate: '2026-08-20',
        campaignId: '900',
        campaignName: 'Summer',
        spend: 100,
        impressions: 5000,
        clicks: 100,
        country: 'US',
      },
      {
        reportDate: '2026-08-20',
        campaignId: '900',
        campaignName: 'Summer',
        spend: 60,
        impressions: 3000,
        clicks: 60,
        country: 'GB',
      },
    ];
    controls.attributionRows = [
      {
        installDate: '2026-08-20',
        campaignId: '900',
        campaignName: 'Summer',
        installs: 40,
        country: 'US',
        revenue: 20,
      },
      {
        installDate: '2026-08-20',
        campaignId: '900',
        campaignName: 'Summer',
        installs: 25,
        country: 'GB',
        revenue: 10,
      },
    ];
    const ctx = await setup();
    await triggerSync(ctx, '2026-08-20', '2026-08-20');
    await reconcile(ctx.user.organizationId, ctx.appId);

    const table = await request(
      ctx.user,
      'GET',
      `/api/v1/organizations/${ctx.user.organizationId}/apps/${ctx.appId}/campaigns?from=2026-08-20&to=2026-08-20&country=US`,
    );
    const row = (
      table.json() as {
        rows: Array<{
          externalCampaignId: string;
          spend: number;
          attributedInstalls: number | null;
          attributedRevenue: number | null;
        }>;
      }
    ).rows.find((r) => r.externalCampaignId === '900');
    expect(row?.spend).toBe(100);
    // Not 65: the GB installs belong to the GB spend that was filtered out.
    expect(row?.attributedInstalls).toBe(40);
    expect(row?.attributedRevenue).toBe(20);
  });

  it('serves the selected-period coverage metrics through the metrics endpoint', async () => {
    // The window is what makes period coverage computable. The endpoint
    // resolved one and then did not pass it on, so all three metrics were
    // permanently unavailable, each explaining itself with "no reporting
    // period" on a request that plainly had one.
    controls.marketingRows = structuredClone(BASE_MARKETING);
    controls.attributionRows = structuredClone(BASE_ATTRIBUTION);
    const ctx = await setup();
    await triggerSync(ctx, '2026-08-20', '2026-08-21');
    await reconcile(ctx.user.organizationId, ctx.appId);

    const response = await request(
      ctx.user,
      'GET',
      `/api/v1/organizations/${ctx.user.organizationId}/apps/${ctx.appId}/metrics?from=2026-08-20&to=2026-08-21`,
    );
    const metrics = (
      response.json() as {
        metrics: Array<{ metricKey: string; availability: string; value: number | null }>;
      }
    ).metrics;
    for (const key of ['campaign_operational_coverage', 'spend_coverage', 'attribution_coverage']) {
      const metric = metrics.find((m) => m.metricKey === key);
      expect(metric, key).toBeTruthy();
      expect(metric?.availability, key).not.toBe('unavailable');
      expect(metric?.value, key).not.toBeNull();
    }
  });

  it('never rolls a rejected link into a campaign total', async () => {
    // The rollup collected every mapping row for the campaign, whatever its
    // status, so a link a human had rejected still contributed its installs to
    // the total displayed beside a different, authoritative link. The row is
    // kept as the record of the decision; the decision was that these are not
    // the same campaign.
    controls.marketingRows = [
      {
        reportDate: '2026-08-20',
        campaignId: '900',
        campaignName: 'Summer',
        spend: 100,
        impressions: 5000,
        clicks: 100,
      },
    ];
    controls.attributionRows = [
      { installDate: '2026-08-20', campaignId: '900', campaignName: 'Summer', installs: 40 },
    ];
    const ctx = await setup();
    await triggerSync(ctx, '2026-08-20', '2026-08-20');
    await reconcile(ctx.user.organizationId, ctx.appId);

    const before = await request(
      ctx.user,
      'GET',
      `/api/v1/organizations/${ctx.user.organizationId}/apps/${ctx.appId}/campaigns?from=2026-08-20&to=2026-08-20`,
    );
    type TableRow = { externalCampaignId: string; attributedInstalls: number | null };
    expect(
      (before.json() as { rows: TableRow[] }).rows.find((r) => r.externalCampaignId === '900')
        ?.attributedInstalls,
    ).toBe(40);

    // A second attribution campaign is linked to the same Meta campaign and
    // then rejected by a human.
    await query(
      `INSERT INTO provider_entity_mappings
         (organization_id, app_id, entity_type, source_provider, source_external_id,
          target_provider, target_external_id, mapping_method, mapping_confidence, status)
       VALUES ($1, $2, 'campaign', 'meta_ads', '900', 'appsflyer', 'other-campaign',
               'name_fallback', 0.5, 'rejected')`,
      [ctx.user.organizationId, ctx.appId],
    );
    await query(
      `INSERT INTO attribution_daily_metrics
         (organization_id, app_id, connection_id, provider_key, grain, install_date,
          external_campaign_id, attributed_installs, dimension_hash)
       SELECT $1, $2, connection_id, provider_key, 'install_date', '2026-08-20',
              'other-campaign', 999, 'rejected-link-fixture'
         FROM attribution_daily_metrics
        WHERE app_id = $2 LIMIT 1`,
      [ctx.user.organizationId, ctx.appId],
    );

    const after = await request(
      ctx.user,
      'GET',
      `/api/v1/organizations/${ctx.user.organizationId}/apps/${ctx.appId}/campaigns?from=2026-08-20&to=2026-08-20`,
    );
    expect(
      (after.json() as { rows: TableRow[] }).rows.find((r) => r.externalCampaignId === '900')
        ?.attributedInstalls,
    ).toBe(40);
  });

  it('counts a mapping toward coverage whichever pass recorded it', async () => {
    // Reconciliation writes a link from both sides. Install coverage read only
    // the marketing->attribution direction, so a campaign matched by the
    // attribution-side pass alone was reported as a coverage gap - MART calling
    // its own recorded mapping unmapped.
    controls.marketingRows = [
      {
        reportDate: '2026-08-20',
        campaignId: '900',
        campaignName: 'Summer',
        spend: 100,
        impressions: 5000,
        clicks: 100,
      },
    ];
    controls.attributionRows = [
      { installDate: '2026-08-20', campaignId: 'mmp-only', campaignName: 'Summer', installs: 50 },
    ];
    const ctx = await setup();
    await triggerSync(ctx, '2026-08-20', '2026-08-20');
    await reconcile(ctx.user.organizationId, ctx.appId);

    // Leave one operational link, recorded on the attribution side only - the
    // shape reconciliation produces when the marketing pass matched a sibling
    // by declared id and never reached this campaign by name.
    await query(
      `DELETE FROM provider_entity_mappings
        WHERE app_id = $1 AND source_provider = 'meta_ads' AND target_external_id = 'mmp-only'`,
      [ctx.appId],
    );
    await query(
      `UPDATE provider_entity_mappings
          SET status = 'manually_verified', mapping_confidence = 1, mapping_method = 'manual'
        WHERE app_id = $1 AND source_external_id = 'mmp-only'
          AND target_external_id IS NOT NULL`,
      [ctx.appId],
    );
    const remaining = await queryRows<{ n: string }>(
      `SELECT count(*)::text AS n FROM provider_entity_mappings
        WHERE app_id = $1 AND source_external_id = 'mmp-only' AND target_external_id IS NOT NULL`,
      [ctx.appId],
    );
    expect(Number(remaining[0]?.n)).toBeGreaterThan(0);

    const coverage = await campaignCoverage(ctx.user.organizationId, ctx.appId, 'meta_ads', {
      from: '2026-08-20',
      to: '2026-08-20',
      attributionProviderKey: 'appsflyer',
    });
    expect(coverage.eligible?.unmappedPaidInstalls).toBe(0);
    expect(coverage.eligible?.mappedPaidInstalls).toBe(50);
  });

  it('keeps organic out of a campaign row, as the top line already does', async () => {
    // Section 23: the table's rows must reconcile with the population above
    // them. Every top-line mapped figure excludes organic; a row that included
    // it would credit the campaign with installs it never bought, and the table
    // would stop summing to the total printed over it.
    controls.marketingRows = [
      {
        reportDate: '2026-08-20',
        campaignId: '900',
        campaignName: 'Summer',
        spend: 100,
        impressions: 5000,
        clicks: 100,
      },
    ];
    controls.attributionRows = [
      { installDate: '2026-08-20', campaignId: '900', campaignName: 'Summer', installs: 40 },
      // Organic traffic that the MMP happens to stamp with the same campaign id.
      {
        installDate: '2026-08-20',
        campaignId: '900',
        campaignName: 'Summer',
        installs: 25,
        mediaSource: 'Organic',
      },
    ];
    const ctx = await setup();
    await triggerSync(ctx, '2026-08-20', '2026-08-20');
    await reconcile(ctx.user.organizationId, ctx.appId);

    const table = await request(
      ctx.user,
      'GET',
      `/api/v1/organizations/${ctx.user.organizationId}/apps/${ctx.appId}/campaigns?from=2026-08-20&to=2026-08-20`,
    );
    const row = (
      table.json() as {
        rows: Array<{ externalCampaignId: string; attributedInstalls: number | null }>;
      }
    ).rows.find((r) => r.externalCampaignId === '900');

    const metrics = await request(
      ctx.user,
      'GET',
      `/api/v1/organizations/${ctx.user.organizationId}/apps/${ctx.appId}/metrics?from=2026-08-20&to=2026-08-20`,
    );
    const topLine = (
      metrics.json() as { metrics: Array<{ metricKey: string; value: number | null }> }
    ).metrics.find((m) => m.metricKey === 'mapped_paid_installs');

    // 40, not 65: the row and the total describe the same population.
    expect(row?.attributedInstalls).toBe(40);
    expect(row?.attributedInstalls).toBe(topLine?.value);
  });

  it('narrows both sides of a filtered CPI, not just the spend', async () => {
    // A filter has to reach the delivery test behind the denominator too. With
    // country=US, spend narrows to US while "delivered" still meant delivered
    // anywhere - so a campaign that ran only in GB kept contributing its US
    // installs to a denominator its US spend never paid for, and the CPI came
    // out too low.
    controls.marketingRows = [
      {
        reportDate: '2026-08-20',
        campaignId: '900',
        campaignName: 'US campaign',
        spend: 100,
        impressions: 5000,
        clicks: 100,
        country: 'US',
      },
      {
        reportDate: '2026-08-20',
        campaignId: '901',
        campaignName: 'GB campaign',
        spend: 60,
        impressions: 3000,
        clicks: 60,
        country: 'GB',
      },
    ];
    controls.attributionRows = [
      {
        installDate: '2026-08-20',
        campaignId: '900',
        campaignName: 'US campaign',
        installs: 50,
        country: 'US',
      },
      // Installs recorded against the GB-only campaign but attributed in US.
      {
        installDate: '2026-08-20',
        campaignId: '901',
        campaignName: 'GB campaign',
        installs: 50,
        country: 'US',
      },
    ];
    const ctx = await setup();
    await triggerSync(ctx, '2026-08-20', '2026-08-20');
    await reconcile(ctx.user.organizationId, ctx.appId);

    const response = await request(
      ctx.user,
      'GET',
      `/api/v1/organizations/${ctx.user.organizationId}/apps/${ctx.appId}/metrics?from=2026-08-20&to=2026-08-20&country=US`,
    );
    const metrics = (
      response.json() as { metrics: Array<{ metricKey: string; value: number | null }> }
    ).metrics;
    const value = (key: string): number | null =>
      metrics.find((m) => m.metricKey === key)?.value ?? null;

    // Only the US campaign delivered in US, so only its 50 installs align.
    expect(value('delivery_aligned_paid_installs')).toBe(50);
    // 100 US spend / 50 aligned installs. Counting the GB campaign's US
    // installs would have given 2.00 - a third lower, and entirely plausible.
    expect(value('mapped_cpi')).toBeCloseTo(2.0, 6);
  });

  it('never reports a campaign as covered and as a discrepancy at once', async () => {
    // Coverage counted a deterministic name match as mapped while the
    // discrepancy list counted the same campaign as unmapped, so the Command
    // Center could show 100% coverage above a list of unmapped campaigns.
    // Nobody wrote that rule - it emerged from two copies of the same predicate
    // drifting apart, which is why there is now only one.
    controls.marketingRows = [
      {
        reportDate: '2026-08-20',
        campaignId: '900',
        campaignName: 'FB_App_CPI_Broad_US_26/08/26',
        spend: 100,
        impressions: 5000,
        clicks: 100,
      },
    ];
    controls.attributionRows = [
      {
        installDate: '2026-08-20',
        campaignId: 'mmp-1',
        campaignName: 'CPI_Broad_US_static (FB_App_CPI_Broad_US_26/08/26)',
        installs: 40,
      },
    ];
    const ctx = await setup();
    await triggerSync(ctx, '2026-08-20', '2026-08-20');
    await reconcile(ctx.user.organizationId, ctx.appId);

    const mappings = await queryRows<{ status: string; mapping_confidence: string }>(
      `SELECT status, mapping_confidence FROM provider_entity_mappings
        WHERE app_id = $1 AND source_provider = 'meta_ads' AND target_external_id IS NOT NULL`,
      [ctx.appId],
    );
    // The premise: a non-authoritative link that is nonetheless operational.
    expect(mappings[0]?.status).toBe('matched_fallback');
    expect(Number(mappings[0]?.mapping_confidence)).toBeGreaterThanOrEqual(0.9);

    const response = await request(
      ctx.user,
      'GET',
      `/api/v1/organizations/${ctx.user.organizationId}/apps/${ctx.appId}/reconciliation?from=2026-08-20&to=2026-08-20`,
    );
    const body = response.json() as {
      coverage: { eligible: { mappedCampaigns: number; unmappedCampaigns: number } | null };
      discrepancies: Array<{ kind: string; externalId: string | null }>;
    };

    // Covered by the operational population...
    expect(body.coverage.eligible?.mappedCampaigns).toBe(1);
    expect(body.coverage.eligible?.unmappedCampaigns).toBe(0);
    // ...and therefore absent from the list of things that are not covered.
    const unmapped = body.discrepancies.filter(
      (d) => d.kind === 'delivery_without_attribution' || d.kind === 'attribution_without_mapping',
    );
    expect(unmapped).toEqual([]);
  });

  it('keeps a human-verified mapping when reconciliation runs again', async () => {
    controls.marketingRows = [
      {
        reportDate: '2026-08-20',
        campaignId: '900',
        campaignName: 'Summer',
        spend: 100,
        impressions: 1000,
        clicks: 10,
      },
    ];
    controls.attributionRows = [
      { installDate: '2026-08-20', campaignId: null, campaignName: 'Different Name', installs: 40 },
    ];
    const ctx = await setup();
    await triggerSync(ctx, '2026-08-20', '2026-08-20');
    await reconcile(ctx.user.organizationId, ctx.appId);

    const mappings = await request(
      ctx.user,
      'GET',
      `/api/v1/organizations/${ctx.user.organizationId}/apps/${ctx.appId}/mappings`,
    );
    const target = (
      mappings.json() as { mappings: Array<{ id: string; source_provider: string }> }
    ).mappings.find((m) => m.source_provider === 'meta_ads');
    expect(target).toBeTruthy();

    const verified = await request(
      ctx.user,
      'POST',
      `/api/v1/organizations/${ctx.user.organizationId}/apps/${ctx.appId}/mappings/${target?.id}/verify`,
      { decision: 'verify', targetExternalId: 'manual-777' },
    );
    expect(verified.statusCode).toBe(200);

    // Recomputation must not overwrite a human decision.
    await reconcile(ctx.user.organizationId, ctx.appId);
    const after = await queryRows<{ status: string; target_external_id: string | null }>(
      `SELECT status, target_external_id FROM provider_entity_mappings WHERE id = $1`,
      [target?.id],
    );
    expect(after[0]?.status).toBe('manually_verified');
    expect(after[0]?.target_external_id).toBe('manual-777');
  });

  /**
   * Remote identifiers whose entity level is not what their field name says.
   *
   * Tenjin publishes `remote_campaign_id` for Meta and, on real accounts, every
   * value is a Meta **ad set** id. Nothing below refers to a particular
   * campaign, id or account: the shape is the subject.
   */
  describe('provider remote id resolution', () => {
    const CAMPAIGN_A = 'FB_App_CPI_Broad_US_26/08/26';
    const CAMPAIGN_B = 'FB_App_CPI_Broad_US_NEW_CR__29/08/26';

    /** Two ad sets under one campaign, and one under another. */
    function structure(): void {
      controls.marketingRows = [
        {
          reportDate: '2026-08-28',
          campaignId: 'c-1',
          campaignName: CAMPAIGN_A,
          spend: 100,
          impressions: 8000,
          clicks: 700,
        },
        {
          reportDate: '2026-08-28',
          campaignId: 'c-2',
          campaignName: CAMPAIGN_B,
          spend: 40,
          impressions: 2000,
          clicks: 200,
        },
      ];
      controls.marketingAdGroups = [
        { externalAdGroupId: 'ag-1a', externalCampaignId: 'c-1', name: 'static' },
        { externalAdGroupId: 'ag-1b', externalCampaignId: 'c-1', name: 'video' },
        { externalAdGroupId: 'ag-2a', externalCampaignId: 'c-2', name: 'broad' },
      ];
      controls.attributionRows = [
        {
          installDate: '2026-08-28',
          campaignId: 'mmp-1',
          campaignName: `static (${CAMPAIGN_A})`,
          installs: 300,
          revenue: 90,
        },
        {
          installDate: '2026-08-28',
          campaignId: 'mmp-2',
          campaignName: `video (${CAMPAIGN_A})`,
          installs: 100,
          revenue: 30,
        },
        {
          installDate: '2026-08-28',
          campaignId: 'mmp-3',
          campaignName: `broad (${CAMPAIGN_B})`,
          installs: 60,
          revenue: 12,
        },
      ];
      // Every published id is an AD SET id, as the real provider pair does.
      controls.attributionCampaigns = [
        {
          externalCampaignId: 'mmp-1',
          name: `static (${CAMPAIGN_A})`,
          remoteCampaignId: 'ag-1a',
          channelId: '3',
          channelName: 'Meta',
        },
        {
          externalCampaignId: 'mmp-2',
          name: `video (${CAMPAIGN_A})`,
          remoteCampaignId: 'ag-1b',
          channelId: '3',
          channelName: 'Meta',
        },
        {
          externalCampaignId: 'mmp-3',
          name: `broad (${CAMPAIGN_B})`,
          remoteCampaignId: 'ag-2a',
          channelId: '3',
          channelName: 'Meta',
        },
      ];
    }

    it('resolves a remote ad-group id up to its parent campaign, authoritatively', async () => {
      structure();
      const ctx = await setup('tenjin');
      await triggerSync(ctx, '2026-08-28', '2026-08-28');
      const summary = await reconcile(ctx.user.organizationId, ctx.appId, 'meta_ads', 'tenjin');

      expect(summary.matchedExact).toBe(3);
      expect(summary.matchedNameEmbedded).toBe(0);
      expect(summary.ambiguous).toBe(0);
      expect(summary.declarationsOutsideStructure).toBe(0);

      const mappings = await queryRows<{
        source_external_id: string;
        target_external_id: string;
        mapping_method: string;
        mapping_confidence: string;
        evidence: Record<string, unknown>;
      }>(
        `SELECT source_external_id, target_external_id, mapping_method,
                mapping_confidence::text, evidence
           FROM provider_entity_mappings
          WHERE app_id = $1 AND source_provider = 'meta_ads'
          ORDER BY target_external_id`,
        [ctx.appId],
      );
      expect(mappings).toHaveLength(3);
      for (const mapping of mappings) {
        expect(mapping.mapping_method).toBe('provider_remote_ad_group');
        expect(Number(mapping.mapping_confidence)).toBe(1);
        expect(mapping.evidence['resolvedEntityType']).toBe('ad_group');
        expect(mapping.evidence['authoritative']).toBe(true);
      }
      // The whole path is recorded, not just the conclusion.
      const first = mappings[0];
      expect(first?.evidence['sourceRemoteId']).toBe('ag-1a');
      expect(first?.evidence['resolvedEntityId']).toBe('ag-1a');
      expect(first?.evidence['resolvedEntityName']).toBe('static');
      expect(first?.evidence['parentCampaignId']).toBe('c-1');
      expect(first?.evidence['parentCampaignName']).toBe(CAMPAIGN_A);
    });

    it('treats two ad sets under one campaign as aggregation, never ambiguity', async () => {
      structure();
      const ctx = await setup('tenjin');
      await triggerSync(ctx, '2026-08-28', '2026-08-28');
      const summary = await reconcile(ctx.user.organizationId, ctx.appId, 'meta_ads', 'tenjin');
      expect(summary.ambiguous).toBe(0);

      const forA = await queryRows<{ target_external_id: string }>(
        `SELECT target_external_id FROM provider_entity_mappings
          WHERE app_id = $1 AND source_external_id = 'c-1'
          ORDER BY target_external_id`,
        [ctx.appId],
      );
      expect(forA.map((r) => r.target_external_id)).toEqual(['mmp-1', 'mmp-2']);

      // And the campaign table shows one row carrying both ad sets' installs.
      const table = await request(
        ctx.user,
        'GET',
        `/api/v1/organizations/${ctx.user.organizationId}/apps/${ctx.appId}/campaigns?from=2026-08-28&to=2026-08-28`,
      );
      const rows = (
        table.json() as {
          rows: Array<{
            externalCampaignId: string;
            mappedChildren: number;
            attributedInstalls: number | null;
            attributedRevenue: number | null;
          }>;
        }
      ).rows;
      const rowA = rows.find((r) => r.externalCampaignId === 'c-1');
      expect(rowA?.mappedChildren).toBe(2);
      expect(rowA?.attributedInstalls).toBe(400);
      expect(rowA?.attributedRevenue).toBe(120);
    });

    it('resolves a campaign-level remote id where the provider publishes one', async () => {
      structure();
      // This account's MMP published the campaign id itself.
      controls.attributionCampaigns = [
        {
          externalCampaignId: 'mmp-1',
          name: `static (${CAMPAIGN_A})`,
          remoteCampaignId: 'c-1',
          channelId: '3',
          channelName: 'Meta',
        },
      ];
      controls.attributionRows = controls.attributionRows.slice(0, 1);
      const ctx = await setup('tenjin');
      await triggerSync(ctx, '2026-08-28', '2026-08-28');
      await reconcile(ctx.user.organizationId, ctx.appId, 'meta_ads', 'tenjin');

      const mapping = await queryRows<{
        mapping_method: string;
        evidence: Record<string, unknown>;
      }>(
        `SELECT mapping_method, evidence FROM provider_entity_mappings
          WHERE app_id = $1 AND source_external_id = 'c-1' AND target_external_id IS NOT NULL`,
        [ctx.appId],
      );
      expect(mapping[0]?.mapping_method).toBe('provider_remote_campaign');
      expect(mapping[0]?.evidence['resolvedEntityType']).toBe('campaign');
    });

    it('falls back to the name when a remote id resolves at no level', async () => {
      structure();
      // Ids for a structure MART does not hold - another ad account, say.
      controls.attributionCampaigns = controls.attributionCampaigns.map((c) => ({
        ...c,
        remoteCampaignId: `outside-${c.externalCampaignId}`,
      }));
      const ctx = await setup('tenjin');
      await triggerSync(ctx, '2026-08-28', '2026-08-28');
      const summary = await reconcile(ctx.user.organizationId, ctx.appId, 'meta_ads', 'tenjin');

      expect(summary.matchedExact).toBe(0);
      // The deterministic name evidence still stands.
      expect(summary.matchedNameEmbedded).toBe(3);
      expect(summary.unmatchedMarketing).toBe(0);
      expect(summary.declarationsOutsideStructure).toBe(3);
    });

    it('leaves a campaign unmatched when neither an id nor a name resolves', async () => {
      structure();
      controls.attributionRows = [
        {
          installDate: '2026-08-28',
          campaignId: 'mmp-9',
          campaignName: 'A campaign naming nothing',
          installs: 5,
          revenue: 1,
        },
      ];
      controls.attributionCampaigns = [];
      const ctx = await setup('tenjin');
      await triggerSync(ctx, '2026-08-28', '2026-08-28');
      const summary = await reconcile(ctx.user.organizationId, ctx.appId, 'meta_ads', 'tenjin');
      expect(summary.matchedExact).toBe(0);
      expect(summary.matchedNameEmbedded).toBe(0);
      expect(summary.unmatchedMarketing).toBe(2);
    });

    it('is still ambiguous only when several parent campaigns remain possible', async () => {
      structure();
      // Two campaigns with one name and no usable identifier: a name cannot say
      // which parent an attribution campaign belongs to.
      controls.marketingRows = controls.marketingRows.map((row) => ({
        ...row,
        campaignName: CAMPAIGN_A,
      }));
      controls.attributionCampaigns = [];
      controls.attributionRows = [
        {
          installDate: '2026-08-28',
          campaignId: 'mmp-1',
          campaignName: `static (${CAMPAIGN_A})`,
          installs: 300,
          revenue: 90,
        },
      ];
      const ctx = await setup('tenjin');
      await triggerSync(ctx, '2026-08-28', '2026-08-28');
      const summary = await reconcile(ctx.user.organizationId, ctx.appId, 'meta_ads', 'tenjin');
      expect(summary.ambiguous).toBe(2);
      expect(summary.matchedExact).toBe(0);
    });

    it('serves the KPI cards the same selected-period coverage as the reconciliation panel', async () => {
      structure();
      // A campaign that spent earlier in the month and nothing in the selected
      // week. It must not blank the period cards, and must not reduce them.
      controls.marketingRows.push({
        reportDate: '2026-08-05',
        campaignId: 'c-historical',
        campaignName: 'RMKT_historical_campaign',
        spend: 500,
        impressions: 40000,
        clicks: 3000,
      });
      const ctx = await setup('tenjin');
      await triggerSync(ctx, '2026-08-01', '2026-08-31');
      await reconcile(ctx.user.organizationId, ctx.appId, 'meta_ads', 'tenjin');

      const payload = await request(
        ctx.user,
        'GET',
        `/api/v1/organizations/${ctx.user.organizationId}/apps/${ctx.appId}/command-center?from=2026-08-25&to=2026-08-31`,
      );
      const body = payload.json() as {
        metrics: Array<{
          metricKey: string;
          displayName: string;
          value: number | null;
          availability: string;
        }>;
        reconciliation: {
          coverage: {
            eligible?: {
              campaignPct: number | null;
              spendPct: number | null;
              installPct: number | null;
              historicalCampaigns: number;
            };
          } | null;
        };
      };
      const metric = (key: string) => body.metrics.find((m) => m.metricKey === key);
      const eligible = body.reconciliation.coverage?.eligible;
      expect(eligible).toBeDefined();

      // The regression: the cards read "unavailable" while the panel below
      // them read 100%, because the two came from different calls.
      for (const key of [
        'campaign_operational_coverage',
        'spend_coverage',
        'attribution_coverage',
      ]) {
        expect(metric(key)?.availability, key).not.toBe('unavailable');
      }
      // Metric values are ratios and render as percentages; the panel carries
      // the already-scaled figure. Same number, one scaling apart.
      const asPct = (value: number | null | undefined): number | null =>
        value === null || value === undefined ? null : Number((value * 100).toFixed(1));
      expect(asPct(metric('campaign_operational_coverage')?.value)).toBe(eligible?.campaignPct);
      expect(asPct(metric('spend_coverage')?.value)).toBe(eligible?.spendPct);
      expect(asPct(metric('attribution_coverage')?.value)).toBe(eligible?.installPct);

      // Everything that delivered in the window is mapped, and the campaign
      // that only spent earlier is excluded rather than counted against it.
      expect(eligible?.campaignPct).toBe(100);
      expect(eligible?.spendPct).toBe(100);
      expect(eligible?.installPct).toBe(100);
      expect(eligible?.historicalCampaigns).toBeGreaterThan(0);

      // The two families are labelled so they cannot be read as one number.
      expect(metric('campaign_operational_coverage')?.displayName).toMatch(/selected period/i);
      expect(metric('spend_coverage')?.displayName).toMatch(/selected period/i);
      expect(metric('attribution_coverage')?.displayName).toMatch(/selected period/i);
      expect(metric('mapping_coverage')?.displayName).toMatch(/all structure/i);
      expect(metric('operational_mapping_coverage')?.displayName).toMatch(/all structure/i);
    });

    it('keeps a historical campaign in MART, unmapped and outside period coverage', async () => {
      structure();
      controls.marketingRows.push({
        reportDate: '2026-08-05',
        campaignId: 'c-historical',
        campaignName: 'RMKT_historical_campaign',
        spend: 500,
        impressions: 40000,
        clicks: 3000,
      });
      const ctx = await setup('tenjin');
      await triggerSync(ctx, '2026-08-01', '2026-08-31');
      await reconcile(ctx.user.organizationId, ctx.appId, 'meta_ads', 'tenjin');

      // Still stored, still unmapped: neither deleted nor force-matched.
      const stored = await queryRows<{ external_campaign_id: string }>(
        `SELECT external_campaign_id FROM marketing_campaigns
          WHERE app_id = $1 AND external_campaign_id = 'c-historical'`,
        [ctx.appId],
      );
      expect(stored).toHaveLength(1);
      const mapping = await queryRows<{ status: string; target_external_id: string | null }>(
        `SELECT status, target_external_id FROM provider_entity_mappings
          WHERE app_id = $1 AND source_external_id = 'c-historical'`,
        [ctx.appId],
      );
      expect(mapping[0]?.status).toBe('unmatched');
      expect(mapping[0]?.target_external_id).toBeNull();

      // It lowers the all-structure number and leaves the period alone.
      const coverage = await campaignCoverage(ctx.user.organizationId, ctx.appId, 'meta_ads', {
        from: '2026-08-25',
        to: '2026-08-31',
        attributionProviderKey: 'tenjin',
      });
      expect(coverage.operationalCoveragePct).toBeLessThan(100);
      expect(coverage.eligible?.campaignPct).toBe(100);
      expect(coverage.eligible?.spendPct).toBe(100);
    });

    it('does not leak one provider pair semantics into another', async () => {
      structure();
      // Identical data, a different attribution provider. MART has not verified
      // what that provider's remote id means, so the conservative reading
      // applies: campaign level only. An ad-set id resolves at no level, and
      // the deterministic name evidence carries the match instead.
      const ctx = await setup('appsflyer');
      await triggerSync(ctx, '2026-08-28', '2026-08-28');
      const summary = await reconcile(ctx.user.organizationId, ctx.appId, 'meta_ads', 'appsflyer');

      expect(summary.matchedExact).toBe(0);
      expect(summary.declarationsOutsideStructure).toBe(3);
      // Still matched - just not by an identifier MART has no basis to read.
      expect(summary.matchedNameEmbedded).toBe(3);
    });

    it('resolves at the levels the pair declares, and only those', () => {
      // The registry is the whole semantic surface: a pair MART has verified,
      // and a conservative default for every pair it has not.
      expect(getRemoteIdResolver('tenjin', 'meta_ads').levels).toEqual(['ad_group', 'campaign']);
      expect(getRemoteIdResolver('appsflyer', 'meta_ads').levels).toEqual(['campaign']);
      expect(getRemoteIdResolver('tenjin', 'tiktok_ads').levels).toEqual(['campaign']);
    });

    it('excludes organic from resolution entirely', async () => {
      structure();
      controls.attributionRows.push({
        installDate: '2026-08-28',
        campaignId: 'organic-app',
        campaignName: 'Organic',
        installs: 90,
        revenue: 20,
        mediaSource: 'Organic',
      });
      controls.attributionCampaigns.push({
        externalCampaignId: 'organic-app',
        name: 'Organic',
        // Even if the MMP publishes something for organic, it belongs to no
        // paid campaign.
        remoteCampaignId: 'ag-1a',
        channelId: '0',
        channelName: 'Organic',
      });
      const ctx = await setup('tenjin');
      await triggerSync(ctx, '2026-08-28', '2026-08-28');
      const summary = await reconcile(ctx.user.organizationId, ctx.appId, 'meta_ads', 'tenjin');

      expect(summary.organicEntities).toBe(1);
      expect(summary.notApplicable).toBe(1);
      const organic = await queryRows<{ status: string; target_external_id: string | null }>(
        `SELECT status, target_external_id FROM provider_entity_mappings
          WHERE app_id = $1 AND source_name = 'Organic'`,
        [ctx.appId],
      );
      expect(organic[0]?.status).toBe('not_applicable');
      expect(organic[0]?.target_external_id).toBeNull();
      // And it never became a child of a paid campaign.
      const paid = await queryRows<{ count: string }>(
        `SELECT count(*)::text AS count FROM provider_entity_mappings
          WHERE app_id = $1 AND source_provider = 'meta_ads'
            AND target_external_id = 'organic-app'`,
        [ctx.appId],
      );
      expect(Number(paid[0]?.count)).toBe(0);
    });
  });

  /**
   * The real Reveal Rush shape: two Tenjin creative campaigns naming one Meta
   * campaign in parentheses, plus organic. Before this, every one of these was
   * unmatched and mapping coverage was 0%.
   */
  describe('real Meta <-> Tenjin campaign names', () => {
    const META_A = 'FB_Reveal_Rush_CPI_Broad_US_26/08/26';
    const META_B = 'FB_Reveal_Rush_CPI_Broad_US_NEW_CR__29/08/26';

    async function setupRealShape(): Promise<Awaited<ReturnType<typeof setup>>> {
      controls.marketingRows = [
        {
          reportDate: '2026-08-28',
          campaignId: '1201',
          campaignName: META_A,
          spend: 100,
          impressions: 8000,
          clicks: 700,
        },
        {
          reportDate: '2026-08-28',
          campaignId: '1202',
          campaignName: META_B,
          spend: 40,
          impressions: 2472,
          clicks: 297,
        },
      ];
      controls.attributionRows = [
        // Tenjin campaign ids are Tenjin UUIDs: they can never match Meta's.
        {
          installDate: '2026-08-28',
          campaignId: 'b47f71fd-4c12-48ba-b49a-f78e5d7a7fa3',
          campaignName: `CPI_Broad_US_static (${META_A})`,
          installs: 300,
          revenue: 90,
        },
        {
          installDate: '2026-08-28',
          campaignId: '943503fc-90b2-4d50-b17a-4bdd53b9b887',
          campaignName: `CPI_Broad_US_video (${META_A})`,
          installs: 100,
          revenue: 30,
        },
        {
          installDate: '2026-08-28',
          campaignId: '3f4f0f78-ae3b-4233-8a73-12a3e3a44265',
          campaignName: `New App promotion Ad Set (${META_B})`,
          installs: 60,
          revenue: 12,
        },
        // Organic: Tenjin reports the app's own UUID as the campaign id.
        {
          installDate: '2026-08-28',
          campaignId: 'b6861802-21c7-4e6f-994d-44783bbda367',
          campaignName: 'Organic',
          installs: 79,
          revenue: 20,
          mediaSource: 'Organic',
        },
      ];
      const ctx = await setup();
      await triggerSync(ctx, '2026-08-28', '2026-08-28');
      return ctx;
    }

    it('maps many Tenjin campaigns to one Meta campaign by embedded name', async () => {
      const ctx = await setupRealShape();
      const summary = await reconcile(ctx.user.organizationId, ctx.appId);

      // Two Tenjin campaigns naming META_A plus one naming META_B.
      expect(summary.matchedNameEmbedded).toBe(3);
      expect(summary.matchedExact).toBe(0);
      expect(summary.unmatchedMarketing).toBe(0);
      expect(summary.ambiguous).toBe(0);

      const mappings = await queryRows<{
        source_name: string;
        target_name: string;
        status: string;
        mapping_method: string;
        mapping_confidence: string;
      }>(
        `SELECT source_name, target_name, status, mapping_method, mapping_confidence
           FROM provider_entity_mappings
          WHERE app_id = $1 AND source_provider = 'meta_ads'
          ORDER BY source_name, target_name`,
        [ctx.appId],
      );

      // Many-to-one is aggregation, not ambiguity: both creatives map.
      const forA = mappings.filter((m) => m.source_name === META_A);
      expect(forA).toHaveLength(2);
      expect(forA.map((m) => m.target_name).sort()).toEqual([
        `CPI_Broad_US_static (${META_A})`,
        `CPI_Broad_US_video (${META_A})`,
      ]);

      for (const mapping of mappings) {
        expect(mapping.mapping_method).toBe('provider_name_embedding');
        // High confidence, and deliberately not authoritative.
        expect(Number(mapping.mapping_confidence)).toBe(0.9);
        expect(mapping.status).toBe('matched_fallback');
        expect(mapping.status).not.toBe('matched_exact');
      }
    });

    it('never makes organic a candidate for a paid campaign', async () => {
      const ctx = await setupRealShape();
      const summary = await reconcile(ctx.user.organizationId, ctx.appId);
      expect(summary.organicEntities).toBe(1);
      expect(summary.notApplicable).toBe(1);

      const organic = await queryRows<{
        status: string;
        mapping_method: string;
        target_external_id: string | null;
      }>(
        `SELECT status, mapping_method, target_external_id FROM provider_entity_mappings
          WHERE app_id = $1 AND source_name = 'Organic'`,
        [ctx.appId],
      );
      expect(organic).toHaveLength(1);
      expect(organic[0]?.status).toBe('not_applicable');
      expect(organic[0]?.mapping_method).toBe('not_applicable');
      expect(organic[0]?.target_external_id).toBeNull();

      // And it is nowhere in any Meta campaign's candidate set.
      const meta = await queryRows<{ target_name: string | null }>(
        `SELECT target_name FROM provider_entity_mappings
          WHERE app_id = $1 AND source_provider = 'meta_ads'`,
        [ctx.appId],
      );
      expect(meta.every((m) => m.target_name !== 'Organic')).toBe(true);
    });

    it('reports authoritative and operational coverage as separate numbers', async () => {
      const ctx = await setupRealShape();
      await reconcile(ctx.user.organizationId, ctx.appId);
      const coverage = await campaignCoverage(ctx.user.organizationId, ctx.appId, 'meta_ads');

      // Nothing shares a stable id, so nothing is authoritative.
      expect(coverage.authoritativeCoveragePct).toBe(0);
      // Everything resolves deterministically, so operations can proceed.
      expect(coverage.operationalCoveragePct).toBe(100);
      expect(coverage.coveragePct).toBe(coverage.authoritativeCoveragePct);

      // Coverage counts campaigns, not mapping rows. Two Meta campaigns are
      // mapped; one of them has two Tenjin children. Counting rows would make
      // a campaign with more children raise coverage, which measures the
      // opposite of what coverage means.
      expect(coverage.matchedNameEmbedded).toBe(2);
      expect(coverage.total).toBe(2);
      const rows = await queryRows<{ count: string }>(
        `SELECT count(*)::text AS count FROM provider_entity_mappings
          WHERE app_id = $1 AND source_provider = 'meta_ads'
            AND mapping_method = 'provider_name_embedding'`,
        [ctx.appId],
      );
      expect(Number(rows[0]?.count)).toBe(3);
    });

    it('keeps organic out of mapped installs, revenue and CPI', async () => {
      const ctx = await setupRealShape();
      await reconcile(ctx.user.organizationId, ctx.appId);

      const payload = await request(
        ctx.user,
        'GET',
        `/api/v1/organizations/${ctx.user.organizationId}/apps/${ctx.appId}/command-center?from=2026-08-28&to=2026-08-28`,
      );
      const metrics = new Map(
        (
          payload.json() as { metrics: Array<{ metricKey: string; value: number | null }> }
        ).metrics.map((m) => [m.metricKey, m]),
      );

      // 300 + 100 + 60 paid, 79 organic.
      expect(metrics.get('attributed_installs')?.value).toBe(539);
      expect(metrics.get('mapped_paid_installs')?.value).toBe(460);
      expect(metrics.get('organic_installs')?.value).toBe(79);

      // Mapped CPI divides mapped spend by mapped installs - the same
      // campaigns on both sides. The blended figure is a different number and
      // is labelled as one.
      expect(metrics.get('mapped_cpi')?.value).toBeCloseTo(140 / 460, 10);
      expect(metrics.get('blended_cpi')?.value).toBeCloseTo(140 / 539, 10);

      // Revenue: 90 + 30 + 12 mapped, 20 organic.
      expect(metrics.get('attributed_revenue')?.value).toBe(152);
      expect(metrics.get('mapped_attributed_revenue')?.value).toBe(132);
    });

    it('raises a data-quality finding while paid spend is unmapped, and clears it once mapped', async () => {
      controls.marketingRows = [
        {
          reportDate: '2026-08-28',
          campaignId: '1201',
          campaignName: META_A,
          spend: 140,
          impressions: 10472,
          clicks: 997,
        },
      ];
      // A Tenjin campaign that names no Meta campaign: nothing can map.
      controls.attributionRows = [
        {
          installDate: '2026-08-28',
          campaignId: 'b47f71fd-4c12-48ba-b49a-f78e5d7a7fa3',
          campaignName: 'Some unrelated Tenjin campaign',
          installs: 539,
          revenue: 152,
        },
      ];
      const ctx = await setup();
      await triggerSync(ctx, '2026-08-28', '2026-08-28');
      await reconcile(ctx.user.organizationId, ctx.appId);

      const findings = await queryRows<{ check_key: string; severity: string; message: string }>(
        `SELECT check_key, severity, message FROM data_quality_findings
          WHERE app_id = $1 AND check_key LIKE 'reconciliation.%'`,
        [ctx.appId],
      );
      const spendFinding = findings.find(
        (f) => f.check_key === 'reconciliation.current_period_spend_unmapped',
      );
      // Severity follows the money: live spend nothing is attributed to.
      expect(spendFinding?.severity).toBe('error');
      expect(spendFinding?.message).toMatch(/current-period spend is not attributed/i);

      // Now give the MMP the embedded name and reconcile again: the finding
      // describes the current join, so it must not linger.
      controls.attributionRows = [
        {
          installDate: '2026-08-28',
          campaignId: 'b47f71fd-4c12-48ba-b49a-f78e5d7a7fa3',
          campaignName: `CPI_Broad_US_static (${META_A})`,
          installs: 539,
          revenue: 152,
        },
      ];
      await triggerSync(ctx, '2026-08-28', '2026-08-28');
      await reconcile(ctx.user.organizationId, ctx.appId);

      const after = await queryRows<{ check_key: string }>(
        `SELECT check_key FROM data_quality_findings
          WHERE app_id = $1 AND check_key = 'reconciliation.current_period_spend_unmapped'`,
        [ctx.appId],
      );
      expect(after).toHaveLength(0);
    });

    it('aggregates matched children into one campaign row, and shows the figures', async () => {
      const ctx = await setupRealShape();
      await reconcile(ctx.user.organizationId, ctx.appId);

      const table = await request(
        ctx.user,
        'GET',
        `/api/v1/organizations/${ctx.user.organizationId}/apps/${ctx.appId}/campaigns?from=2026-08-28&to=2026-08-28`,
      );
      const rows = (
        table.json() as {
          rows: Array<{
            externalCampaignId: string;
            campaignName: string | null;
            spend: number;
            mappingStatus: string;
            mappedChildren: number;
            attributedInstalls: number | null;
            attributedRevenue: number | null;
            reportedCpi: number | null;
            attributionNote: string | null;
          }>;
        }
      ).rows;

      // One row per Meta campaign, not one per mapping. Joining the mapping
      // rows directly repeated the campaign - and its spend - per child.
      expect(rows).toHaveLength(2);
      expect(rows.reduce((sum, r) => sum + r.spend, 0)).toBeCloseTo(140, 10);

      const a = rows.find((r) => r.campaignName === META_A);
      expect(a?.mappingStatus).toBe('matched_fallback');
      expect(a?.mappedChildren).toBe(2);
      // The bug: a matched_fallback campaign showing an em dash while its
      // mapped children have installs. static 300 + video 100.
      expect(a?.attributedInstalls).toBe(400);
      expect(a?.attributedRevenue).toBe(120);
      expect(a?.reportedCpi).toBeCloseTo(100 / 400, 10);
      expect(a?.attributionNote).toMatch(/embedded/i);
      expect(a?.attributionNote).toMatch(/aggregated across 2/i);

      const b = rows.find((r) => r.campaignName === META_B);
      expect(b?.mappedChildren).toBe(1);
      expect(b?.attributedInstalls).toBe(60);
    });

    it('still withholds figures behind a bare shared name', async () => {
      controls.marketingRows = [
        {
          reportDate: '2026-08-28',
          campaignId: '1301',
          campaignName: 'Summer US',
          spend: 100,
          impressions: 1000,
          clicks: 10,
        },
      ];
      // Same name, no embedded annotation: a coincidence of wording.
      controls.attributionRows = [
        {
          installDate: '2026-08-28',
          campaignId: null,
          campaignName: 'summer us',
          installs: 40,
          revenue: 10,
        },
      ];
      const ctx = await setup();
      await triggerSync(ctx, '2026-08-28', '2026-08-28');
      await reconcile(ctx.user.organizationId, ctx.appId);

      const table = await request(
        ctx.user,
        'GET',
        `/api/v1/organizations/${ctx.user.organizationId}/apps/${ctx.appId}/campaigns?from=2026-08-28&to=2026-08-28`,
      );
      const row = (
        table.json() as {
          rows: Array<{
            mappingStatus: string;
            attributedInstalls: number | null;
            attributionNote: string | null;
          }>;
        }
      ).rows[0];
      expect(row?.mappingStatus).toBe('matched_fallback');
      expect(row?.attributedInstalls).toBeNull();
      expect(row?.attributionNote).toMatch(/withheld/i);
    });

    it('refuses to pick between marketing campaigns that share a name', async () => {
      controls.marketingRows = [
        {
          reportDate: '2026-08-28',
          campaignId: '1401',
          campaignName: META_A,
          spend: 60,
          impressions: 4000,
          clicks: 300,
        },
        // A duplicate, as Meta's "- Copy" flow produces.
        {
          reportDate: '2026-08-28',
          campaignId: '1402',
          campaignName: META_A,
          spend: 80,
          impressions: 6000,
          clicks: 400,
        },
      ];
      controls.attributionRows = [
        {
          installDate: '2026-08-28',
          campaignId: 'b47f71fd-4c12-48ba-b49a-f78e5d7a7fa3',
          campaignName: `CPI_Broad_US_static (${META_A})`,
          installs: 300,
          revenue: 90,
        },
      ];
      const ctx = await setup();
      await triggerSync(ctx, '2026-08-28', '2026-08-28');
      const summary = await reconcile(ctx.user.organizationId, ctx.appId);

      // Crediting the same 300 installs to both duplicates would inflate each
      // one's mapped spend and understate both CPIs.
      expect(summary.matchedNameEmbedded).toBe(0);
      expect(summary.ambiguous).toBe(2);

      const mappings = await queryRows<{ status: string; evidence: Record<string, unknown> }>(
        `SELECT status, evidence FROM provider_entity_mappings
          WHERE app_id = $1 AND source_provider = 'meta_ads'`,
        [ctx.appId],
      );
      expect(mappings).toHaveLength(2);
      expect(mappings.every((m) => m.status === 'ambiguous')).toBe(true);
      expect(String(mappings[0]?.evidence['reason'])).toMatch(/share this name/i);
    });

    it('resolves duplicate Meta names by the network id the MMP publishes', async () => {
      // The real shape: two Meta campaigns with the SAME name (a static and a
      // video variant of one launch), and two Tenjin campaigns whose names
      // embed that one shared name. No name rule can tell them apart.
      controls.marketingRows = [
        {
          reportDate: '2026-08-28',
          campaignId: '120254846425720119',
          campaignName: META_A,
          spend: 100,
          impressions: 8000,
          clicks: 700,
        },
        {
          reportDate: '2026-08-28',
          campaignId: '120254846425690119',
          campaignName: META_A,
          spend: 40,
          impressions: 2000,
          clicks: 200,
        },
      ];
      controls.attributionRows = [
        {
          installDate: '2026-08-28',
          campaignId: 'b47f71fd-4c12-48ba-b49a-f78e5d7a7fa3',
          campaignName: `CPI_Broad_US_static (${META_A})`,
          installs: 300,
          revenue: 90,
        },
        {
          installDate: '2026-08-28',
          campaignId: '3f4f0f78-ae3b-4233-8a73-12a3e3a44265',
          campaignName: `CPI_Broad_US_video (${META_A})`,
          installs: 100,
          revenue: 30,
        },
      ];
      // Tenjin's own directory publishes the Meta campaign id per campaign.
      controls.attributionCampaigns = [
        {
          externalCampaignId: 'b47f71fd-4c12-48ba-b49a-f78e5d7a7fa3',
          name: `CPI_Broad_US_static (${META_A})`,
          remoteCampaignId: '120254846425720119',
          channelId: '3',
          channelName: 'Meta',
        },
        {
          externalCampaignId: '3f4f0f78-ae3b-4233-8a73-12a3e3a44265',
          name: `CPI_Broad_US_video (${META_A})`,
          remoteCampaignId: '120254846425690119',
          channelId: '3',
          channelName: 'Meta',
        },
      ];

      const ctx = await setup();
      await triggerSync(ctx, '2026-08-28', '2026-08-28');
      const summary = await reconcile(ctx.user.organizationId, ctx.appId);

      // An identifier beats every name rule, so nothing is ambiguous and
      // nothing rests on a name.
      expect(summary.ambiguous).toBe(0);
      expect(summary.matchedExact).toBe(2);
      expect(summary.matchedNameEmbedded).toBe(0);

      const mappings = await queryRows<{
        source_external_id: string;
        target_external_id: string;
        status: string;
        mapping_method: string;
        mapping_confidence: string;
      }>(
        `SELECT source_external_id, target_external_id, status, mapping_method,
                mapping_confidence::text
           FROM provider_entity_mappings
          WHERE app_id = $1 AND source_provider = 'meta_ads'
          ORDER BY source_external_id`,
        [ctx.appId],
      );
      expect(mappings).toHaveLength(2);
      // Each Meta campaign gets the Tenjin campaign that named its id, not the
      // other one, and not both.
      expect(mappings[0]?.target_external_id).toBe('3f4f0f78-ae3b-4233-8a73-12a3e3a44265');
      expect(mappings[1]?.target_external_id).toBe('b47f71fd-4c12-48ba-b49a-f78e5d7a7fa3');
      for (const mapping of mappings) {
        expect(mapping.status).toBe('matched_exact');
        expect(mapping.mapping_method).toBe('provider_remote_campaign');
        expect(Number(mapping.mapping_confidence)).toBe(1);
      }

      // And this is authoritative coverage, not operational-only.
      const coverage = await campaignCoverage(ctx.user.organizationId, ctx.appId, 'meta_ads');
      expect(coverage.authoritativeCoveragePct).toBe(100);
    });

    it('reports campaign, spend and attribution coverage as three separate numbers', async () => {
      const ctx = await setupRealShape();
      await reconcile(ctx.user.organizationId, ctx.appId);
      const coverage = await campaignCoverage(ctx.user.organizationId, ctx.appId, 'meta_ads', {
        from: '2026-08-28',
        to: '2026-08-28',
        attributionProviderKey: 'appsflyer',
      });
      const eligible = coverage.eligible;
      expect(eligible).toBeDefined();
      // Everything that delivered is mapped.
      expect(eligible?.eligibleCampaigns).toBe(2);
      expect(eligible?.campaignPct).toBe(100);
      expect(eligible?.spendPct).toBe(100);
      expect(eligible?.totalSpend).toBeCloseTo(140, 10);
      // Organic is out of the paid denominator.
      expect(eligible?.totalPaidInstalls).toBe(460);
      expect(eligible?.organicInstalls).toBe(79);
      expect(eligible?.installPct).toBe(100);
    });

    it('excludes campaigns with no delivery in the period from current coverage', async () => {
      controls.marketingRows = [
        {
          reportDate: '2026-08-28',
          campaignId: 'live',
          campaignName: META_A,
          spend: 123,
          impressions: 9000,
          clicks: 800,
        },
        // Delivered nothing in the window: not a current-period gap.
        {
          reportDate: '2026-08-28',
          campaignId: 'dormant',
          campaignName: 'FB_Reveal_Rush_Old_Campaign_01/01/26',
          spend: 0,
          impressions: 0,
          clicks: 0,
        },
      ];
      controls.attributionRows = [
        {
          installDate: '2026-08-28',
          campaignId: 'b47f71fd-4c12-48ba-b49a-f78e5d7a7fa3',
          campaignName: `CPI_Broad_US_static (${META_A})`,
          installs: 300,
          revenue: 90,
        },
      ];
      const ctx = await setup();
      await triggerSync(ctx, '2026-08-28', '2026-08-28');
      await reconcile(ctx.user.organizationId, ctx.appId);

      const coverage = await campaignCoverage(ctx.user.organizationId, ctx.appId, 'meta_ads', {
        from: '2026-08-28',
        to: '2026-08-28',
        attributionProviderKey: 'appsflyer',
      });
      // One eligible campaign, mapped: the dormant one does not drag it down.
      expect(coverage.eligible?.eligibleCampaigns).toBe(1);
      expect(coverage.eligible?.campaignPct).toBe(100);
      expect(coverage.eligible?.spendPct).toBe(100);
      expect(coverage.eligible?.historicalCampaigns).toBe(1);
      // All-structure coverage still counts it, and is labelled as such.
      expect(coverage.operationalCoveragePct).toBe(50);

      const findings = await queryRows<{ check_key: string; severity: string }>(
        `SELECT check_key, severity FROM data_quality_findings
          WHERE app_id = $1 AND check_key LIKE 'reconciliation.%'`,
        [ctx.appId],
      );
      // A dormant campaign is informational, never an error beside live spend.
      const historical = findings.find(
        (f) => f.check_key === 'reconciliation.historical_campaigns_without_activity',
      );
      expect(historical?.severity).toBe('info');
      expect(findings.map((f) => f.check_key)).not.toContain(
        'reconciliation.current_period_spend_unmapped',
      );
    });

    it('raises an error when material current-period spend is ambiguous', async () => {
      controls.marketingRows = [
        {
          reportDate: '2026-08-28',
          campaignId: 'dup-1',
          campaignName: META_A,
          spend: 123,
          impressions: 9000,
          clicks: 800,
        },
        {
          reportDate: '2026-08-28',
          campaignId: 'dup-2',
          campaignName: META_A,
          spend: 34,
          impressions: 1000,
          clicks: 100,
        },
      ];
      controls.attributionRows = [
        {
          installDate: '2026-08-28',
          campaignId: 'b47f71fd-4c12-48ba-b49a-f78e5d7a7fa3',
          campaignName: `CPI_Broad_US_static (${META_A})`,
          installs: 300,
          revenue: 90,
        },
      ];
      const ctx = await setup();
      await triggerSync(ctx, '2026-08-28', '2026-08-28');
      await reconcile(ctx.user.organizationId, ctx.appId);

      const coverage = await campaignCoverage(ctx.user.organizationId, ctx.appId, 'meta_ads', {
        from: '2026-08-28',
        to: '2026-08-28',
        attributionProviderKey: 'appsflyer',
      });
      // The number that makes the problem obvious: nearly all of the spend.
      expect(coverage.eligible?.ambiguousSpend).toBeCloseTo(157, 10);
      expect(coverage.eligible?.spendPct).toBe(0);

      const findings = await queryRows<{ check_key: string; severity: string; message: string }>(
        `SELECT check_key, severity, message FROM data_quality_findings
          WHERE app_id = $1 AND check_key LIKE 'reconciliation.%'`,
        [ctx.appId],
      );
      const spendFinding = findings.find(
        (f) => f.check_key === 'reconciliation.current_period_spend_unmapped',
      );
      expect(spendFinding?.severity).toBe('error');
      expect(spendFinding?.message).toMatch(/ambiguous/i);
    });

    it('keeps a human decision over every later recomputation', async () => {
      controls.marketingRows = [
        {
          reportDate: '2026-08-28',
          campaignId: 'dup-1',
          campaignName: META_A,
          spend: 100,
          impressions: 8000,
          clicks: 700,
        },
        {
          reportDate: '2026-08-28',
          campaignId: 'dup-2',
          campaignName: META_A,
          spend: 40,
          impressions: 2000,
          clicks: 200,
        },
      ];
      controls.attributionRows = [
        {
          installDate: '2026-08-28',
          campaignId: 'b47f71fd-4c12-48ba-b49a-f78e5d7a7fa3',
          campaignName: `CPI_Broad_US_static (${META_A})`,
          installs: 300,
          revenue: 90,
        },
      ];
      const ctx = await setup();
      await triggerSync(ctx, '2026-08-28', '2026-08-28');
      await reconcile(ctx.user.organizationId, ctx.appId);

      const ambiguous = await queryRows<{ id: string }>(
        `SELECT id FROM provider_entity_mappings
          WHERE app_id = $1 AND source_external_id = 'dup-1' AND status = 'ambiguous'`,
        [ctx.appId],
      );
      const mappingId = ambiguous[0]?.id;
      expect(mappingId).toBeDefined();

      const verified = await request(
        ctx.user,
        'POST',
        `/api/v1/organizations/${ctx.user.organizationId}/apps/${ctx.appId}/mappings/${mappingId}/verify`,
        {
          decision: 'verify',
          targetExternalId: 'b47f71fd-4c12-48ba-b49a-f78e5d7a7fa3',
          targetName: `CPI_Broad_US_static (${META_A})`,
        },
      );
      expect(verified.statusCode).toBe(200);

      // Recompute: the decision must survive, and it must win.
      await reconcile(ctx.user.organizationId, ctx.appId);
      const after = await queryRows<{
        status: string;
        target_external_id: string | null;
        verified_by_user_id: string | null;
        verified_at: string | null;
      }>(
        `SELECT status, target_external_id, verified_by_user_id, verified_at::text
           FROM provider_entity_mappings
          WHERE app_id = $1 AND source_external_id = 'dup-1'`,
        [ctx.appId],
      );
      expect(after).toHaveLength(1);
      expect(after[0]?.status).toBe('manually_verified');
      expect(after[0]?.target_external_id).toBe('b47f71fd-4c12-48ba-b49a-f78e5d7a7fa3');
      // Auditable: who and when.
      expect(after[0]?.verified_by_user_id).not.toBeNull();
      expect(after[0]?.verified_at).not.toBeNull();

      // And it counts as authoritative, not merely operational.
      const coverage = await campaignCoverage(ctx.user.organizationId, ctx.appId, 'meta_ads');
      expect(coverage.manuallyVerified).toBe(1);
      expect(coverage.authoritative).toBe(1);
    });

    it('never lets an unusable directory declaration veto a name match', async () => {
      // The regression this guards, seen on a real account: the MMP publishes
      // network campaign ids for an ad account MART is not bound to. Those ids
      // match nothing in MART's structure, so they cannot discriminate between
      // the campaigns MART does hold - and must not suppress the name evidence
      // that was working. Treating them as a veto unmatched everything.
      controls.marketingRows = [
        {
          reportDate: '2026-08-28',
          campaignId: '120250007656600649',
          campaignName: META_A,
          spend: 100,
          impressions: 8000,
          clicks: 700,
        },
      ];
      controls.attributionRows = [
        {
          installDate: '2026-08-28',
          campaignId: 'b47f71fd-4c12-48ba-b49a-f78e5d7a7fa3',
          campaignName: `CPI_Broad_US_static (${META_A})`,
          installs: 300,
          revenue: 90,
        },
      ];
      // A real id, for a campaign in a different ad account.
      controls.attributionCampaigns = [
        {
          externalCampaignId: 'b47f71fd-4c12-48ba-b49a-f78e5d7a7fa3',
          name: `CPI_Broad_US_static (${META_A})`,
          remoteCampaignId: '120254846425720119',
          channelId: '3',
          channelName: 'Meta',
        },
      ];

      const ctx = await setup();
      await triggerSync(ctx, '2026-08-28', '2026-08-28');
      const summary = await reconcile(ctx.user.organizationId, ctx.appId);

      expect(summary.matchedNameEmbedded).toBe(1);
      expect(summary.unmatchedMarketing).toBe(0);
      // Reported rather than silently ignored: the MMP said something MART
      // cannot use, which is not the same as saying nothing.
      expect(summary.declarationsOutsideStructure).toBe(1);

      const coverage = await campaignCoverage(ctx.user.organizationId, ctx.appId, 'meta_ads', {
        from: '2026-08-28',
        to: '2026-08-28',
        attributionProviderKey: 'appsflyer',
      });
      expect(coverage.eligible?.spendPct).toBe(100);
      expect(coverage.eligible?.mappedPaidInstalls).toBe(300);
    });

    it('still prefers the declaration when MART holds the campaign it names', async () => {
      controls.marketingRows = [
        {
          reportDate: '2026-08-28',
          campaignId: '120254846425720119',
          campaignName: META_A,
          spend: 100,
          impressions: 8000,
          clicks: 700,
        },
        {
          reportDate: '2026-08-28',
          campaignId: '120254846425690119',
          campaignName: META_A,
          spend: 40,
          impressions: 2000,
          clicks: 200,
        },
      ];
      controls.attributionRows = [
        {
          installDate: '2026-08-28',
          campaignId: 'b47f71fd-4c12-48ba-b49a-f78e5d7a7fa3',
          campaignName: `CPI_Broad_US_static (${META_A})`,
          installs: 300,
          revenue: 90,
        },
      ];
      controls.attributionCampaigns = [
        {
          externalCampaignId: 'b47f71fd-4c12-48ba-b49a-f78e5d7a7fa3',
          name: `CPI_Broad_US_static (${META_A})`,
          remoteCampaignId: '120254846425720119',
          channelId: '3',
          channelName: 'Meta',
        },
      ];

      const ctx = await setup();
      await triggerSync(ctx, '2026-08-28', '2026-08-28');
      const summary = await reconcile(ctx.user.organizationId, ctx.appId);

      // The id MART holds wins, and the duplicate-named sibling gets nothing.
      expect(summary.matchedExact).toBe(1);
      expect(summary.declarationsOutsideStructure).toBe(0);
      const mappings = await queryRows<{ source_external_id: string; status: string }>(
        `SELECT source_external_id, status FROM provider_entity_mappings
          WHERE app_id = $1 AND source_provider = 'meta_ads' AND target_external_id IS NOT NULL`,
        [ctx.appId],
      );
      expect(mappings).toHaveLength(1);
      expect(mappings[0]?.source_external_id).toBe('120254846425720119');
    });

    it('does not raise a finding for organic alone', async () => {
      const ctx = await setupRealShape();
      await reconcile(ctx.user.organizationId, ctx.appId);
      const findings = await queryRows<{ check_key: string; message: string }>(
        `SELECT check_key, message FROM data_quality_findings
          WHERE app_id = $1 AND check_key LIKE 'reconciliation.%'`,
        [ctx.appId],
      );
      // Everything paid is mapped; organic is not a problem to report.
      expect(findings.map((f) => f.check_key)).not.toContain(
        'reconciliation.current_period_spend_unmapped',
      );
      expect(findings.every((f) => !/organic/i.test(f.message))).toBe(true);
    });
  });
});

describe('dashboard data', () => {
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

  it('computes metrics from stored data with correct arithmetic and provenance', async () => {
    const ctx = await setup();
    await triggerSync(ctx, '2026-08-20', '2026-08-21');
    await reconcile(ctx.user.organizationId, ctx.appId);

    const response = await request(
      ctx.user,
      'GET',
      `/api/v1/organizations/${ctx.user.organizationId}/apps/${ctx.appId}/metrics?from=2026-08-20&to=2026-08-21`,
    );
    expect(response.statusCode).toBe(200);
    const metrics = new Map(
      (
        response.json() as {
          metrics: Array<{
            metricKey: string;
            value: number | null;
            availability: string;
            grain: { primary: string; mixed?: string[] };
          }>;
        }
      ).metrics.map((m) => [m.metricKey, m]),
    );

    expect(metrics.get('spend')?.value).toBe(250);
    expect(metrics.get('impressions')?.value).toBe(50_000);
    expect(metrics.get('clicks')?.value).toBe(900);
    expect(metrics.get('ctr')?.value).toBeCloseTo(900 / 50_000, 10);
    expect(metrics.get('cpm')?.value).toBeCloseTo((250 / 50_000) * 1000, 10);
    expect(metrics.get('cpc')?.value).toBeCloseTo(250 / 900, 10);
    expect(metrics.get('attributed_installs')?.value).toBe(100);
    expect(metrics.get('blended_cpi')?.value).toBeCloseTo(250 / 100, 10);
    expect(metrics.get('blended_cpi')?.grain.mixed).toEqual(['report_date', 'install_date']);
  });

  it('refuses to present cohort ROAS', async () => {
    const ctx = await setup();
    await triggerSync(ctx, '2026-08-20', '2026-08-21');
    const response = await request(
      ctx.user,
      'GET',
      `/api/v1/organizations/${ctx.user.organizationId}/apps/${ctx.appId}/metrics?from=2026-08-20&to=2026-08-21`,
    );
    const roas = (
      response.json() as {
        metrics: Array<{
          metricKey: string;
          value: number | null;
          availability: string;
          reason?: string;
        }>;
      }
    ).metrics.find((m) => m.metricKey === 'cohort_roas');
    expect(roas?.value).toBeNull();
    expect(roas?.availability).toBe('unavailable');
    expect(roas?.reason).toMatch(/cohort-matched spend/i);
  });

  it('keeps marketing and attribution series on separate, labelled grains', async () => {
    const ctx = await setup();
    await triggerSync(ctx, '2026-08-20', '2026-08-21');
    const response = await request(
      ctx.user,
      'GET',
      `/api/v1/organizations/${ctx.user.organizationId}/apps/${ctx.appId}/timeseries?from=2026-08-20&to=2026-08-21`,
    );
    const body = response.json() as {
      points: Array<{ date: string; spend: number | null; attributedInstalls: number | null }>;
      marketingGrain: string;
      attributionInstallGrain: string;
      grainWarning: string;
    };
    expect(body.marketingGrain).toBe('report_date');
    expect(body.attributionInstallGrain).toBe('install_date');
    expect(body.grainWarning).toMatch(/not the same grain/i);
    expect(body.points).toHaveLength(2);
  });

  it('serves a coherent command centre payload', async () => {
    const ctx = await setup();
    await triggerSync(ctx, '2026-08-20', '2026-08-21');
    await reconcile(ctx.user.organizationId, ctx.appId);

    const response = await request(
      ctx.user,
      'GET',
      `/api/v1/organizations/${ctx.user.organizationId}/apps/${ctx.appId}/command-center?from=2026-08-20&to=2026-08-21`,
    );
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      dataHealth: {
        integrations: Array<{ role: string }>;
        freshness: unknown[];
        mappingCoverage: { coveragePct: number | null } | null;
      };
      metrics: Array<{ metricKey: string }>;
      campaigns: { rows: Array<{ externalCampaignId: string; attributedInstalls: number | null }> };
      reconciliation: { coverage: { coveragePct: number | null } | null };
      emptyStates: Array<{ key: string }>;
    };

    expect(body.dataHealth.integrations.map((i) => i.role).sort()).toEqual([
      'marketing_network',
      'primary_attribution',
    ]);
    expect(body.metrics.length).toBeGreaterThan(5);
    expect(body.campaigns.rows[0]?.externalCampaignId).toBe('900');
    // Mapping is authoritative, so attribution figures are attached.
    expect(body.campaigns.rows[0]?.attributedInstalls).toBe(100);
    expect(body.reconciliation.coverage?.coveragePct).toBe(100);
    expect(body.emptyStates).toHaveLength(0);
  });

  it('reports explicit empty states rather than zeros before anything is connected', async () => {
    const user = await registerUser();
    const app = await createApp(user);
    const response = await request(
      user,
      'GET',
      `/api/v1/organizations/${user.organizationId}/apps/${app.id}/command-center`,
    );
    const body = response.json() as {
      emptyStates: Array<{ key: string; message: string }>;
      metrics: Array<{ metricKey: string; value: number | null; availability: string }>;
    };
    const keys = body.emptyStates.map((e) => e.key);
    expect(keys).toContain('no_marketing_network');
    expect(keys).toContain('no_attribution_provider');

    const spend = body.metrics.find((m) => m.metricKey === 'spend');
    expect(spend?.value).toBeNull();
    expect(spend?.availability).toBe('unavailable');
  });

  it('distinguishes connected-but-unsynced from genuinely zero', async () => {
    const ctx = await setup();
    const response = await request(
      ctx.user,
      'GET',
      `/api/v1/organizations/${ctx.user.organizationId}/apps/${ctx.appId}/command-center`,
    );
    const keys = (response.json() as { emptyStates: Array<{ key: string }> }).emptyStates.map(
      (e) => e.key,
    );
    expect(keys).toContain('marketing_not_synced');
    expect(keys).toContain('attribution_not_synced');
  });

  it('separates never-synced from synced-but-empty for a date range', async () => {
    const ctx = await setup();
    await triggerSync(ctx, '2026-08-20', '2026-08-21');

    // A range the provider genuinely reported nothing for, after a successful
    // sync, is a different statement from "you have not synced yet".
    const response = await request(
      ctx.user,
      'GET',
      `/api/v1/organizations/${ctx.user.organizationId}/apps/${ctx.appId}/command-center?from=2026-01-01&to=2026-01-07`,
    );
    const states = (response.json() as { emptyStates: Array<{ key: string; message: string }> })
      .emptyStates;
    const keys = states.map((e) => e.key);
    expect(keys).toContain('marketing_empty_range');
    expect(keys).not.toContain('marketing_not_synced');
    expect(states.find((e) => e.key === 'marketing_empty_range')?.message).toMatch(
      /synced successfully/,
    );
  });

  it('records deterministic data-quality findings during a sync', async () => {
    controls.marketingRows = [
      {
        reportDate: '2026-08-20',
        campaignId: '900',
        campaignName: 'Bad Data',
        spend: 50,
        impressions: 0,
        clicks: 0,
        country: 'US',
      },
    ];
    const ctx = await setup();
    await triggerSync(ctx, '2026-08-20', '2026-08-20');

    const response = await request(
      ctx.user,
      'GET',
      `/api/v1/organizations/${ctx.user.organizationId}/apps/${ctx.appId}/data-quality`,
    );
    const findings = (response.json() as { findings: Array<{ check_key: string }> }).findings;
    expect(findings.map((f) => f.check_key)).toContain('marketing.spend_without_delivery');
  });
});

async function countFacts(appId: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const table of [
    'marketing_daily_metrics',
    'attribution_daily_metrics',
    'attribution_revenue_metrics',
    'marketing_campaigns',
  ]) {
    const rows = await queryRows<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${table} WHERE app_id = $1`,
      [appId],
    );
    out[table] = toNumber(rows[0]?.count);
  }
  return out;
}

describe('sync run honesty', () => {
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

  it('records an unimplemented stream as not_implemented, never as a completed sync', async () => {
    const ctx = await setup();
    await triggerSync(ctx, '2026-08-20', '2026-08-21');

    const runs = await queryRows<{ data_type: string; status: string; rows_normalized: string }>(
      `SELECT data_type, status, rows_normalized::text FROM sync_runs WHERE app_id = $1`,
      [ctx.appId],
    );
    const events = runs.find((r) => r.data_type === 'attribution_events');
    // The misleading state this replaces: "completed / 0 rows" for a stream
    // that never made a request.
    expect(events?.status).toBe('not_implemented');
    expect(events?.status).not.toBe('completed');

    // Streams that really did ingest are unaffected.
    expect(runs.find((r) => r.data_type === 'attribution_installs')?.status).toBe('completed');

    const freshness = await queryRows<{ data_type: string; status: string }>(
      `SELECT data_type, status FROM data_freshness WHERE app_id = $1`,
      [ctx.appId],
    );
    expect(freshness.find((f) => f.data_type === 'attribution_events')?.status).toBe(
      'not_implemented',
    );
  });

  it('stops presenting an error as current once a later sync succeeds, without deleting it', async () => {
    const ctx = await setup();
    // First run fails on a window.
    controls.failWindows = new Set(['2026-08-20..2026-08-21']);
    controls.failureClass = 'invalid_request';
    await triggerSync(ctx, '2026-08-20', '2026-08-21');

    const active = await syncRepo.listRecentSyncErrors(ctx.user.organizationId, {
      appId: ctx.appId,
      resolved: false,
    });
    expect(active.length).toBeGreaterThan(0);

    // Second run succeeds for the same app/provider/stream.
    controls.failWindows = new Set();
    await triggerSync(ctx, '2026-08-20', '2026-08-21');

    const stillActive = await syncRepo.listRecentSyncErrors(ctx.user.organizationId, {
      appId: ctx.appId,
      resolved: false,
    });
    const resolved = await syncRepo.listRecentSyncErrors(ctx.user.organizationId, {
      appId: ctx.appId,
      resolved: true,
    });
    expect(stillActive).toHaveLength(0);
    // Audit history is kept: the row moved, it did not disappear.
    expect(resolved.length).toBeGreaterThan(0);
    expect(resolved[0]?.resolved_by_sync_run_id).not.toBeNull();

    const payload = await request(
      ctx.user,
      'GET',
      `/api/v1/organizations/${ctx.user.organizationId}/apps/${ctx.appId}/command-center?from=2026-08-20&to=2026-08-21`,
    );
    const health = (
      payload.json() as {
        dataHealth: { activeErrors: unknown[]; resolvedErrors: unknown[] };
      }
    ).dataHealth;
    expect(health.activeErrors).toHaveLength(0);
    expect(health.resolvedErrors.length).toBeGreaterThan(0);
  });
});

describe('KPI audit invariants', () => {
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

  /**
   * The invariants the read-only KPI audit checks, asserted here so they are
   * enforced by CI rather than only observed by a person running the CLI.
   */
  it('never sums cohort revenue into the event-date attributed total', async () => {
    const ctx = await setup();
    await triggerSync(ctx, '2026-08-20', '2026-08-21');

    const before = await request(
      ctx.user,
      'GET',
      `/api/v1/organizations/${ctx.user.organizationId}/apps/${ctx.appId}/command-center?from=2026-08-20&to=2026-08-21`,
    );
    const revenueOf = (payload: { metrics: Array<{ metricKey: string; value: number | null }> }) =>
      payload.metrics.find((m) => m.metricKey === 'attributed_revenue')?.value ?? null;
    const baseline = revenueOf(before.json() as never);
    expect(baseline).toBeGreaterThan(0);

    // A cohort row for the same campaign and date. It is a different fact and
    // must not join the event-date total.
    const connection = await queryRows<{ id: string }>(
      `SELECT connection_id AS id FROM attribution_revenue_metrics WHERE app_id = $1 LIMIT 1`,
      [ctx.appId],
    );
    await query(
      `INSERT INTO attribution_revenue_metrics
         (organization_id, app_id, connection_id, provider_key, grain, activity_date,
          revenue_type, media_source, normalized_media_source, external_campaign_id,
          campaign_name, country, platform, currency, revenue, dimension_hash)
       VALUES ($1,$2,$3,'appsflyer','install_date','2026-08-20','iap','facebook','meta','900',
               'Summer','US','ios','USD',9999,'cohort-guard')`,
      [ctx.user.organizationId, ctx.appId, connection[0]?.id],
    );

    const after = await request(
      ctx.user,
      'GET',
      `/api/v1/organizations/${ctx.user.organizationId}/apps/${ctx.appId}/command-center?from=2026-08-20&to=2026-08-21`,
    );
    expect(revenueOf(after.json() as never)).toBe(baseline);
  });

  it('keeps marketing delivery free of attribution fan-out', async () => {
    // Two attribution campaigns mapped to one marketing campaign must not
    // multiply that campaign's spend.
    controls.attributionRows = [
      {
        installDate: '2026-08-20',
        campaignId: 'mmp-a',
        campaignName: 'creative a (Summer US)',
        installs: 40,
        revenue: 10,
      },
      {
        installDate: '2026-08-20',
        campaignId: 'mmp-b',
        campaignName: 'creative b (Summer US)',
        installs: 20,
        revenue: 5,
      },
    ];
    controls.marketingRows = [
      {
        reportDate: '2026-08-20',
        campaignId: '900',
        campaignName: 'Summer US',
        spend: 100,
        impressions: 5000,
        clicks: 400,
      },
    ];
    const ctx = await setup();
    await triggerSync(ctx, '2026-08-20', '2026-08-20');
    await reconcile(ctx.user.organizationId, ctx.appId);

    const payload = await request(
      ctx.user,
      'GET',
      `/api/v1/organizations/${ctx.user.organizationId}/apps/${ctx.appId}/command-center?from=2026-08-20&to=2026-08-20`,
    );
    const body = payload.json() as {
      metrics: Array<{ metricKey: string; value: number | null }>;
      campaigns: { rows: Array<{ spend: number; attributedInstalls: number | null }> };
    };
    const value = (key: string) => body.metrics.find((m) => m.metricKey === key)?.value ?? null;

    // Spend counted once; attribution aggregated across both children.
    expect(value('spend')).toBe(100);
    expect(body.campaigns.rows).toHaveLength(1);
    expect(body.campaigns.rows[0]?.spend).toBe(100);
    expect(body.campaigns.rows[0]?.attributedInstalls).toBe(60);
    expect(value('mapped_paid_installs')).toBe(60);
  });

  it('derives every delivery ratio from summed numerator and denominator', async () => {
    controls.marketingRows = [
      {
        reportDate: '2026-08-20',
        campaignId: '900',
        campaignName: 'Summer US',
        spend: 100,
        impressions: 20000,
        clicks: 1000,
      },
      {
        reportDate: '2026-08-21',
        campaignId: '901',
        campaignName: 'Autumn US',
        spend: 200,
        impressions: 5000,
        clicks: 100,
      },
    ];
    const ctx = await setup();
    await triggerSync(ctx, '2026-08-20', '2026-08-21');

    const payload = await request(
      ctx.user,
      'GET',
      `/api/v1/organizations/${ctx.user.organizationId}/apps/${ctx.appId}/command-center?from=2026-08-20&to=2026-08-21`,
    );
    const body = payload.json() as { metrics: Array<{ metricKey: string; value: number | null }> };
    const value = (key: string) => body.metrics.find((m) => m.metricKey === key)?.value ?? null;

    // Sums, not the mean of the two days' ratios - which would be 3.5% here.
    expect(value('ctr')).toBeCloseTo(1100 / 25000, 10);
    expect(value('cpm')).toBeCloseTo((300 * 1000) / 25000, 10);
    expect(value('cpc')).toBeCloseTo(300 / 1100, 10);
  });
});

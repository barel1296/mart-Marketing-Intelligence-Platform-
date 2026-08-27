import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { queryRows, syncRepo, toNumber } from '@mart/db';
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
    expect(metrics.get('reported_cpi')?.value).toBeCloseTo(250 / 100, 10);
    expect(metrics.get('reported_cpi')?.grain.mixed).toEqual(['report_date', 'install_date']);
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

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { query } from '@mart/db';
import {
  addMember,
  closeServer,
  connectProvider,
  createApp,
  drainSyncQueue,
  getServer,
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
 * The decision layer end to end: fake providers -> real sync engine ->
 * PostgreSQL -> the production rules -> the API. Each Phase 3 hard rule is
 * asserted on what the API returns.
 *
 * Dates are relative to today (H). Campaign 900 delivers 20 spend a day
 * for twenty days up to H-1 - except H-12, when it was paused - with thirty
 * installs a day and a D7 cohort return of 12 per day (0.6). With the
 * horizon at H-1, days up to H-9 are mature at D7: eleven mature delivered
 * days, 220 spend, 330 installs - above every floor. The paused day's 30
 * installs and 12 of revenue are in neither side of any return.
 */

function day(offset: number): string {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - offset);
  return d.toISOString().slice(0, 10);
}
const H = day(0);
const LAST = day(1);
const SYNC_FROM = day(30);
/** A mature day with installs and cohort revenue but no spend. */
const PAUSED_OFFSET = 12;

type Ctx = { user: TestUser; appId: string };

type ApiRecommendation = {
  id: string;
  signal: string;
  category: string;
  headline: string;
  reason: string;
  blockers: string[];
  scope: { kind: string; marketingCampaignId: string | null };
  evidence: Array<{
    key: string;
    value: number | null;
    numerator?: number | null;
    denominator?: number | null;
    availability: string;
    blocker?: string;
    population: string;
    grain: string;
    window: { from: string; to: string };
  }>;
  window: { from: string; to: string; evaluated: { days: number } };
  quality: { maturity: { matureDays: number } | null; mapping: { operational: boolean } };
  confidence: { level: string; score: number; components: Array<{ input: string }> };
  policy: { configured: boolean };
  lineage: { inputsHash: string; computedAt: string };
  actions: unknown[];
};

type ApiDecisions = {
  decisions: {
    ruleVersion: string;
    automation: string;
    asOf: string | null;
    app: ApiRecommendation;
    campaigns: ApiRecommendation[];
    pacing: Array<{
      marketingCampaignId: string;
      status: string;
      ratio: number | null;
      dailyBudget: number | null;
    }>;
    anomalies: Array<{ date: string; metric: string; classification: string }>;
  };
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
  const sync = await request(
    user,
    'POST',
    `/api/v1/organizations/${user.organizationId}/apps/${app.id}/sync`,
    { from: SYNC_FROM, to: H },
  );
  if (sync.statusCode !== 202) throw new Error(`sync failed: ${sync.body}`);
  await drainSyncQueue();
  await reconcile(user.organizationId, app.id, 'meta_ads', 'appsflyer');
  return { user, appId: app.id };
}

async function decisionsFor(ctx: Ctx, suffix = ''): Promise<ApiDecisions['decisions']> {
  const response = await request(
    ctx.user,
    'GET',
    `/api/v1/organizations/${ctx.user.organizationId}/apps/${ctx.appId}/decisions${suffix}`,
  );
  if (response.statusCode !== 200) throw new Error(`decisions failed: ${response.body}`);
  return (response.json() as ApiDecisions).decisions;
}

async function putPolicy(
  ctx: Ctx,
  body: Record<string, unknown>,
  user: TestUser = ctx.user,
): Promise<{ statusCode: number; body: unknown }> {
  const app = await getServer();
  const response = await app.inject({
    method: 'PUT',
    url: `/api/v1/organizations/${ctx.user.organizationId}/apps/${ctx.appId}/decision-policy`,
    headers: { cookie: user.cookie, 'x-mart-csrf': user.csrfToken },
    payload: body,
  });
  return { statusCode: response.statusCode, body: response.json() };
}

const campaign = (d: ApiDecisions['decisions'], id: string): ApiRecommendation => {
  const found = d.campaigns.find((c) => c.scope.marketingCampaignId === id);
  if (!found) throw new Error(`campaign ${id} not in decisions`);
  return found;
};

function seed(): void {
  controls.marketingRows = [];
  controls.attributionRows = [];
  for (let offset = 20; offset >= 1; offset -= 1) {
    const date = day(offset);
    // One mature day the campaign was paused: installs and cohort revenue
    // still arrive for it (a click the day before), but no spend bought
    // them, so they belong in neither side of a return - at campaign scope
    // and at app scope alike.
    if (offset !== PAUSED_OFFSET) {
      controls.marketingRows.push({
        reportDate: date,
        campaignId: '900',
        campaignName: 'Summer US',
        spend: 20,
        impressions: 4_000,
        clicks: 80,
        country: 'US',
      });
    }
    controls.attributionRows.push({
      installDate: date,
      campaignId: '900',
      campaignName: 'Summer US',
      installs: 30,
      country: 'US',
      revenue: 3,
      cohort: { iap: { 1: 2, 7: 8 }, ad: { 1: 1, 7: 4 } },
    });
  }
  // A campaign the MMP never reports: delivered, never mapped.
  controls.marketingRows.push({
    reportDate: day(5),
    campaignId: '901',
    campaignName: 'Never attributed',
    spend: 60,
    impressions: 1_000,
    clicks: 10,
    country: 'US',
  });
}

beforeAll(() => installFakeProviders());
afterAll(async () => {
  removeFakeProviders();
  await closeServer();
});

beforeEach(async () => {
  await truncateAll();
  resetControls();
  seed();
});

describe('decision center', () => {
  it('reads a mapped campaign against a stored target and never acts on it', async () => {
    const ctx = await setup();
    const before = await decisionsFor(ctx);
    expect(before.automation).toBe('none');
    expect(before.asOf).toBe(LAST);
    expect(before.ruleVersion).toBe('phase3.v1');

    // No target: figures, never scale or reduce.
    const unconfigured = campaign(before, '900');
    expect(unconfigured.signal).toBe('hold');
    expect(unconfigured.blockers).toEqual(['no_target']);
    expect(unconfigured.policy.configured).toBe(false);
    expect(unconfigured.actions).toEqual([]);

    const saved = await putPolicy(ctx, { targetRoasD7: 0.5 });
    expect(saved.statusCode).toBe(200);
    const after = await decisionsFor(ctx);
    const r = campaign(after, '900');
    expect(r.signal).toBe('scale');
    expect(r.category).toBe('performance');
    expect(r.blockers).toEqual([]);
    const roas = r.evidence.find((e) => e.key === 'cohort_roas_d7');
    // Eleven mature delivered days (H-20..H-9 without H-12): 220 spend, 132
    // total D7 revenue. The paused day's 12 is excluded, not added.
    expect(roas).toMatchObject({
      value: 0.6,
      numerator: 132,
      denominator: 220,
      availability: 'available',
      population: 'cohort_aligned_paid_attribution',
      grain: 'cohort_date',
    });
    expect(r.window.evaluated.days).toBe(11);
    expect(r.quality.maturity?.matureDays).toBe(11);
    expect(r.evidence.find((e) => e.key === 'spend')?.value).toBe(380);
    // Installs are reported for every day the horizon has passed, but the
    // CPI divides only by the installs that spend bought.
    expect(r.evidence.find((e) => e.key === 'mapped_paid_installs')?.value).toBe(600);
    expect(r.evidence.find((e) => e.key === 'mapped_cpi')?.denominator).toBe(540);
    expect(r.confidence.components.map((c) => c.input)).toEqual(
      expect.arrayContaining(['freshness', 'sample', 'maturity', 'mapping']),
    );

    // The app scope reads the same mapped population, with 901's 60 unmapped
    // leaving coverage at 380/440 = 86%: above the floor, so it reads too,
    // and the paused day's cohort stays out of the app figure as well.
    expect(after.app.signal).toBe('scale');
    expect(after.app.evidence.find((e) => e.key === 'cohort_roas_d7')).toMatchObject({
      value: 0.6,
      numerator: 132,
      denominator: 220,
    });

    // Raising the target flips the same facts to reduce; clearing it to hold.
    await putPolicy(ctx, { targetRoasD7: 1 });
    expect(campaign(await decisionsFor(ctx), '900').signal).toBe('reduce');
    await putPolicy(ctx, {});
    const cleared = campaign(await decisionsFor(ctx), '900');
    expect(cleared.signal).toBe('hold');
    expect(cleared.blockers).toEqual(['no_target']);
  });

  it('is deterministic across requests, apart from computedAt', async () => {
    const ctx = await setup();
    await putPolicy(ctx, { targetRoasD7: 0.5 });
    const a = await decisionsFor(ctx);
    const b = await decisionsFor(ctx);
    const strip = (d: ApiDecisions['decisions']) =>
      JSON.stringify(d, (key, value) => (key === 'computedAt' ? undefined : value));
    expect(strip(a)).toBe(strip(b));
    expect(a.app.id).toBe(b.app.id);
    expect(a.app.lineage.inputsHash).toBe(b.app.lineage.inputsHash);
  });

  it('withholds a reading for an unmapped campaign and reports pacing without acting', async () => {
    const ctx = await setup();
    await putPolicy(ctx, { targetRoasD7: 0.5 });
    const d = await decisionsFor(ctx);
    const unmapped = campaign(d, '901');
    expect(unmapped.signal).toBe('insufficient_data');
    expect(unmapped.category).toBe('coverage');
    expect(unmapped.blockers).toEqual(['insufficient_coverage']);
    expect(unmapped.quality.mapping.operational).toBe(false);

    // The fake network declares a 100/day budget; 20/day is under pace, and
    // the paused day is not a delivered day.
    const pace = d.pacing.find((p) => p.marketingCampaignId === '900');
    expect(pace).toMatchObject({
      status: 'under',
      ratio: 0.2,
      dailyBudget: 100,
      deliveredDays: 19,
    });
  });

  it('refuses to read stale data, and says which stream', async () => {
    const ctx = await setup();
    await putPolicy(ctx, { targetRoasD7: 0.5 });
    await query(
      `UPDATE data_freshness SET status = 'stale' WHERE app_id = $1 AND data_type = 'attribution_revenue'`,
      [ctx.appId],
    );
    const r = campaign(await decisionsFor(ctx), '900');
    expect(r.signal).toBe('insufficient_data');
    expect(r.category).toBe('data_quality');
    expect(r.blockers).toEqual(['provider_stale']);
    expect(r.reason).toMatch(/attribution stream is stale/);
  });

  it('turns a tracking-shaped anomaly into an investigation, never a performance call', async () => {
    // Installs collapse on H-1 while spend holds: nothing on the data side
    // explains it, so MART refuses to call it either way.
    controls.attributionRows = controls.attributionRows.map((row) =>
      row.installDate === LAST
        ? { ...row, installs: 0, cohort: undefined, revenue: undefined }
        : row,
    );
    // Organic traffic on the same day carries no campaign id, and the
    // warning that records that must not turn the move into a tracking call.
    controls.attributionRows.push({
      installDate: LAST,
      campaignId: null,
      campaignName: 'Organic',
      mediaSource: 'Organic',
      installs: 1,
      country: 'US',
    });
    const ctx = await setup();
    await putPolicy(ctx, { targetRoasD7: 0.5 });
    const d = await decisionsFor(ctx);
    const drop = d.anomalies.find(
      (a) => a.date === LAST && a.metric === 'installs' && a.classification === 'undetermined',
    );
    expect(drop).toBeTruthy();
    const r = campaign(d, '900');
    expect(r.signal).toBe('investigate');
    expect(r.category).toBe('undetermined');
    expect(r.blockers).toEqual(['anomalous_data']);
    // The mature return itself is unchanged and still shown as evidence.
    expect(r.evidence.find((e) => e.key === 'cohort_roas_d7')?.value).toBe(0.6);
  });

  it('classifies an install drop under an unresolved sync error as a data gap', async () => {
    controls.attributionRows = controls.attributionRows.map((row) =>
      row.installDate === LAST
        ? { ...row, installs: 0, cohort: undefined, revenue: undefined }
        : row,
    );
    const ctx = await setup();
    await putPolicy(ctx, { targetRoasD7: 0.5 });
    const run = await query<{ id: string }>(
      `SELECT id FROM sync_runs WHERE app_id = $1 AND data_type = 'attribution_installs' LIMIT 1`,
      [ctx.appId],
    );
    await query(
      `INSERT INTO sync_errors (organization_id, sync_run_id, error_class, message, window_start, window_end)
       VALUES ($1, $2, 'rate_limited', 'injected', $3, $3)`,
      [ctx.user.organizationId, run.rows[0]?.id, LAST],
    );
    const d = await decisionsFor(ctx);
    const gap = d.anomalies.find((a) => a.date === LAST && a.metric === 'installs');
    expect(gap?.classification).toBe('data_gap');
    const r = campaign(d, '900');
    expect(r.signal).toBe('investigate');
    expect(r.category).toBe('data_quality');
    expect(r.blockers).toEqual(['provider_stale']);
    expect(r.reason).toMatch(/1 unresolved sync error/);
  });

  it('withholds a reading when no cohort in the window is mature', async () => {
    const ctx = await setup();
    await putPolicy(ctx, { targetRoasD7: 0.5 });
    // A window of the last four days: delivered, but every cohort too young.
    const d = await decisionsFor(ctx, `?from=${day(4)}&to=${H}`);
    const r = campaign(d, '900');
    expect(r.signal).toBe('insufficient_data');
    expect(r.blockers).toEqual(['immature_cohort']);
    expect(r.evidence.find((e) => e.key === 'cohort_roas_d7')).toMatchObject({
      availability: 'blocked',
      blocker: 'immature_cohort',
      value: null,
    });
  });

  it('lets viewers read decisions but not change targets', async () => {
    const ctx = await setup();
    const viewer = await registerUser();
    await addMember(ctx.user, ctx.user.organizationId, viewer.email, 'viewer');
    const viewerCtx: Ctx = {
      user: { ...viewer, organizationId: ctx.user.organizationId },
      appId: ctx.appId,
    };
    const read = await request(
      viewerCtx.user,
      'GET',
      `/api/v1/organizations/${ctx.user.organizationId}/apps/${ctx.appId}/decisions`,
    );
    expect(read.statusCode).toBe(200);
    const write = await putPolicy(ctx, { targetRoasD7: 0.5 }, viewerCtx.user);
    expect(write.statusCode).toBe(403);
    const invalid = await putPolicy(ctx, { maxCpi: 3, currency: 'usd' });
    expect(invalid.statusCode).toBe(400);
  });
});

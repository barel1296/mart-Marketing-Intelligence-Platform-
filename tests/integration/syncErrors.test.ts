import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { queryRows, syncRepo } from '@mart/db';
import {
  closeServer,
  connectProvider,
  createApp,
  drainSyncQueue,
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

const STREAM_ROWS = [
  {
    reportDate: '2026-08-20',
    campaignId: '900',
    campaignName: 'Summer',
    spend: 100,
    impressions: 5000,
    clicks: 100,
  },
  {
    reportDate: '2026-08-27',
    campaignId: '900',
    campaignName: 'Summer',
    spend: 80,
    impressions: 4000,
    clicks: 80,
  },
];

type ErrorRow = {
  id: string;
  data_type: string;
  error_class: string;
  retryable: boolean;
  window_start: string | null;
  window_end: string | null;
  resolved_at: string | null;
  resolved_by_sync_run_id: string | null;
  occurred_at: string;
};

async function errorRows(appId: string): Promise<ErrorRow[]> {
  return queryRows<ErrorRow>(
    `SELECT e.id, r.data_type, e.error_class, e.retryable,
            e.window_start::text AS window_start, e.window_end::text AS window_end,
            e.resolved_at::text AS resolved_at, e.resolved_by_sync_run_id,
            e.occurred_at::text AS occurred_at
       FROM sync_errors e JOIN sync_runs r ON r.id = e.sync_run_id
      WHERE r.app_id = $1
      ORDER BY e.occurred_at`,
    [appId],
  );
}

/**
 * A stale error is one a later run has already put right.
 *
 * A provider outage recorded at 09:43 and a clean re-read of the same window at
 * 10:21 are one incident that is over, but the row stays open until something
 * says so - and an open error is what the operator, the integrations card and
 * the Phase 0 audit all read as "this stream is broken right now".
 */
describe('superseded sync errors', () => {
  beforeAll(() => installFakeProviders());
  afterAll(async () => {
    removeFakeProviders();
    await closeServer();
  });
  beforeEach(async () => {
    await truncateAll();
    resetControls();
    controls.marketingRows = structuredClone(STREAM_ROWS);
  });

  it('closes a retryable provider outage once a later run re-reads the window', async () => {
    const ctx = await setup();
    controls.failureClass = 'rate_limited';
    controls.failWindows = new Set(['2026-08-20..2026-08-20']);
    await triggerSync(ctx, '2026-08-20', '2026-08-20');

    const open = (await errorRows(ctx.appId)).filter((e) => e.resolved_at === null);
    expect(open.length).toBeGreaterThan(0);
    expect(open.every((e) => e.retryable)).toBe(true);

    controls.failWindows = new Set();
    await triggerSync(ctx, '2026-08-20', '2026-08-20');

    const after = await errorRows(ctx.appId);
    expect(after.every((e) => e.resolved_at !== null)).toBe(true);
    // Superseded, not erased: the incident is still on the record.
    expect(after.length).toBe(open.length);
  });

  it('names the run that proved the recovery', async () => {
    const ctx = await setup();
    controls.failureClass = 'rate_limited';
    controls.failWindows = new Set(['2026-08-20..2026-08-20']);
    await triggerSync(ctx, '2026-08-20', '2026-08-20');
    const failingRunIds = new Set((await errorRows(ctx.appId)).map((e) => e.id));
    expect(failingRunIds.size).toBeGreaterThan(0);

    controls.failWindows = new Set();
    await triggerSync(ctx, '2026-08-20', '2026-08-20');

    const after = await errorRows(ctx.appId);
    for (const row of after) {
      expect(row.resolved_by_sync_run_id).not.toBeNull();
      const resolver = await queryRows<{ status: string; data_type: string }>(
        `SELECT status, data_type FROM sync_runs WHERE id = $1`,
        [row.resolved_by_sync_run_id],
      );
      // The run credited with the fix is a later, successful run of that stream.
      expect(resolver[0]?.status).toBe('completed');
      expect(resolver[0]?.data_type).toBe(row.data_type);
    }
  });

  it('closes several stale errors on one stream together', async () => {
    const ctx = await setup();
    controls.failureClass = 'rate_limited';
    controls.failWindows = new Set(['2026-08-20..2026-08-20']);
    await triggerSync(ctx, '2026-08-20', '2026-08-20');
    await triggerSync(ctx, '2026-08-20', '2026-08-20');

    const before = (await errorRows(ctx.appId)).filter(
      (e) => e.data_type === 'marketing_performance',
    );
    expect(before.length).toBeGreaterThanOrEqual(2);
    expect(before.every((e) => e.resolved_at === null)).toBe(true);

    controls.failWindows = new Set();
    await triggerSync(ctx, '2026-08-20', '2026-08-20');

    const after = (await errorRows(ctx.appId)).filter(
      (e) => e.data_type === 'marketing_performance',
    );
    expect(after.length).toBe(before.length);
    expect(after.every((e) => e.resolved_at !== null)).toBe(true);
  });

  it('leaves a window nothing has re-read since still open', async () => {
    // The narrow rule earns its keep here: a later run that read different
    // dates proves nothing about the dates that failed.
    const ctx = await setup();
    controls.failureClass = 'rate_limited';
    controls.failWindows = new Set(['2026-08-20..2026-08-20']);
    await triggerSync(ctx, '2026-08-20', '2026-08-20');

    controls.failWindows = new Set();
    await triggerSync(ctx, '2026-08-27', '2026-08-27');

    const stale = (await errorRows(ctx.appId)).filter((e) => e.window_start === '2026-08-20');
    expect(stale.length).toBeGreaterThan(0);
    expect(stale.every((e) => e.resolved_at === null)).toBe(true);
  });

  it('closes a failed window that a later, wider run covered', async () => {
    const ctx = await setup();
    controls.failureClass = 'rate_limited';
    controls.failWindows = new Set(['2026-08-20..2026-08-20']);
    await triggerSync(ctx, '2026-08-20', '2026-08-20');

    controls.failWindows = new Set();
    await triggerSync(ctx, '2026-08-18', '2026-08-24');

    const covered = (await errorRows(ctx.appId)).filter((e) => e.window_start === '2026-08-20');
    expect(covered.length).toBeGreaterThan(0);
    expect(covered.every((e) => e.resolved_at !== null)).toBe(true);
  });

  it('leaves another provider and another stream untouched', async () => {
    // Scope is one stream. A Meta delivery run that recovers says nothing about
    // the MMP's revenue stream, and must not quietly close its errors.
    const ctx = await setup();
    controls.failureClass = 'rate_limited';
    controls.failWindows = new Set(['2026-08-20..2026-08-20']);
    await triggerSync(ctx, '2026-08-20', '2026-08-20');

    const before = await errorRows(ctx.appId);
    expect(new Set(before.map((e) => e.data_type)).size).toBeGreaterThan(1);
    expect(before.every((e) => e.resolved_at === null)).toBe(true);

    // One stream, and only that stream, is proven recovered.
    const recovered = await syncRepo.createSyncRun({
      organizationId: ctx.user.organizationId,
      appId: ctx.appId,
      connectionId: ctx.metaConnectionId,
      providerKey: 'meta_ads',
      dataType: 'marketing_performance',
      trigger: 'manual',
      windowStart: '2026-08-20',
      windowEnd: '2026-08-20',
    });
    const resolved = await syncRepo.resolveSupersededSyncErrors({
      organizationId: ctx.user.organizationId,
      appId: ctx.appId,
      connectionId: ctx.metaConnectionId,
      dataType: 'marketing_performance',
      syncRunId: recovered.id,
      coveredWindows: [{ from: '2026-08-20', to: '2026-08-20' }],
      complete: true,
    });
    expect(resolved).toBeGreaterThan(0);

    const after = await errorRows(ctx.appId);
    for (const row of after) {
      if (row.data_type === 'marketing_performance') expect(row.resolved_at).not.toBeNull();
      else expect(row.resolved_at).toBeNull();
    }
  });

  it('does not close a non-retryable failure on a merely overlapping window', async () => {
    // A rejected request is a statement about one specific request, not about
    // the provider's mood, so a wider run that happened to include those dates
    // is not proof that the request itself would now succeed.
    const ctx = await setup();
    controls.failureClass = 'invalid_request';
    controls.failWindows = new Set(['2026-08-20..2026-08-20']);
    await triggerSync(ctx, '2026-08-20', '2026-08-20');

    const open = (await errorRows(ctx.appId)).filter((e) => e.window_start === '2026-08-20');
    expect(open.length).toBeGreaterThan(0);
    expect(open.every((e) => e.retryable)).toBe(false);

    controls.failWindows = new Set();
    await triggerSync(ctx, '2026-08-18', '2026-08-24');
    const wider = (await errorRows(ctx.appId)).filter((e) => e.window_start === '2026-08-20');
    expect(wider.every((e) => e.resolved_at === null)).toBe(true);

    // The same request, retried and succeeding, does close it.
    await triggerSync(ctx, '2026-08-20', '2026-08-20');
    const exact = (await errorRows(ctx.appId)).filter((e) => e.window_start === '2026-08-20');
    expect(exact.every((e) => e.resolved_at !== null)).toBe(true);
  });

  it('does not flip a working connection to invalid_credentials on a rejected query', async () => {
    // The production incident. Meta answered a malformed breakdown with a
    // code-100 error stamped "OAuthException", MART read the label as a
    // credential signal, and a connection whose token was perfectly valid was
    // marked invalid_credentials - prompting a reconnect that would have fixed
    // nothing. A rejected query is a statement about the query.
    const ctx = await setup();
    controls.failureClass = 'invalid_request';
    controls.failWindows = new Set(['2026-08-20..2026-08-20']);
    await triggerSync(ctx, '2026-08-20', '2026-08-20');

    const status = await queryRows<{ status: string }>(
      `SELECT status FROM integration_connections WHERE id = $1`,
      [ctx.metaConnectionId],
    );
    expect(status[0]?.status).not.toBe('invalid_credentials');
  });

  it('does flip it when the provider actually rejects the token', async () => {
    // The distinction the incident lost: this one IS about the credential.
    const ctx = await setup();
    controls.failureClass = 'authentication_error';
    controls.failWindows = new Set(['2026-08-20..2026-08-20']);
    await triggerSync(ctx, '2026-08-20', '2026-08-20');

    const status = await queryRows<{ status: string }>(
      `SELECT status FROM integration_connections WHERE id = $1`,
      [ctx.metaConnectionId],
    );
    expect(status[0]?.status).toBe('invalid_credentials');
  });

  it("records the provider's own words beside every failure", async () => {
    // Before this, a rejected query reached the database as "responded 400" and
    // nothing more, and the diagnosis had to be redone by hand against the live
    // API. The sanitized body the HTTP client already captured now travels to
    // the row.
    const ctx = await setup();
    controls.failureClass = 'invalid_request';
    controls.failWindows = new Set(['2026-08-20..2026-08-20']);
    await triggerSync(ctx, '2026-08-20', '2026-08-20');

    const rows = await queryRows<{ context: Record<string, unknown> }>(
      `SELECT e.context FROM sync_errors e JOIN sync_runs r ON r.id = e.sync_run_id
        WHERE r.app_id = $1`,
      [ctx.appId],
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.context['httpStatus']).toBe(400);
      expect(String(row.context['bodyPreview'])).toMatch(/"code":100/);
    }
  });
});

import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clearProviderOverrides } from '@mart/integrations';
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

/**
 * End-to-end flow over real HTTP.
 *
 * This is the one suite where MART's connectors do real network I/O: the real
 * ProviderHttpClient, the real Meta/AppsFlyer adapters, the real sync engine.
 * The other end of the socket is the local fixture server, not a real provider,
 * so what this proves is that MART's own request-building, pagination, CSV
 * parsing, normalization and metric arithmetic work against the documented wire
 * shapes. It proves nothing about the live Meta or AppsFlyer APIs - only a run
 * against real credentials can do that.
 */

const PORT = 4917;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_SCRIPT = path.resolve(HERE, '../../scripts/fixture-provider-server.mjs');

const META_ACCOUNT = 'act_FIXTURE0001';
const APPSFLYER_APP = 'id_FIXTURE_APP';
// Long enough to pass the adapter's token shape check, and obviously not a key.
const TOKEN = 'FIXTURE-TOKEN-000000000000000000';

let child: ChildProcess | null = null;

async function waitForServer(): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/v21.0/me/adaccounts`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      if (response.ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('fixture provider server did not start');
}

beforeAll(async () => {
  // Other suites install fake in-process providers; this one must use the real
  // adapters, so any leftover override is removed first.
  clearProviderOverrides();
  child = spawn(process.execPath, [SERVER_SCRIPT], {
    env: { ...process.env, MART_ENABLE_FIXTURES: 'true', MART_FIXTURE_PORT: String(PORT) },
    stdio: 'ignore',
  });
  await waitForServer();
}, 30_000);

afterAll(async () => {
  child?.kill('SIGTERM');
  child = null;
  await closeServer();
});

describe('fixture provider flow over real HTTP', () => {
  it('refuses to start the fixture server without the explicit opt-in flag', async () => {
    const guarded = spawn(process.execPath, [SERVER_SCRIPT], {
      env: { ...process.env, MART_ENABLE_FIXTURES: '', MART_FIXTURE_PORT: '4918' },
      stdio: 'ignore',
    });
    const code = await new Promise<number | null>((resolve) => guarded.on('exit', resolve));
    expect(code).toBe(1);
  });

  it('runs connect -> ingest -> normalize -> reconcile -> display with real adapters', async () => {
    await truncateAll();
    const user: TestUser = await registerUser();
    const app = await createApp(user, { name: 'Fixture Flow App' });

    // 1. Connect Meta. The route validates against the provider immediately.
    const meta = await connectProvider(user, 'meta_ads', { accessToken: TOKEN });

    // 2. Discover ad accounts through the real Graph pagination code.
    const discovered = await request(
      user,
      'GET',
      `/api/v1/organizations/${user.organizationId}/connections/${meta.connectionId}/accounts?refresh=true`,
    );
    expect(discovered.statusCode).toBe(200);
    const metaAccounts = (
      discovered.json() as { accounts: Array<{ id: string; external_account_id: string }> }
    ).accounts;
    const metaAccount = metaAccounts.find((a) => a.external_account_id === META_ACCOUNT);
    expect(metaAccount).toBeDefined();

    const bindMeta = await request(
      user,
      'POST',
      `/api/v1/organizations/${user.organizationId}/apps/${app.id}/bindings`,
      {
        connectionId: meta.connectionId,
        integrationAccountId: metaAccount?.id,
        role: 'marketing_network',
      },
    );
    expect(bindMeta.statusCode).toBe(201);

    // 3. Choose the MMP explicitly, then connect it.
    const chooseMmp = await request(
      user,
      'POST',
      `/api/v1/organizations/${user.organizationId}/apps/${app.id}/attribution-provider`,
      { provider: 'appsflyer', confirmSwitch: true },
    );
    expect(chooseMmp.statusCode).toBe(200);

    const appsflyer = await connectProvider(user, 'appsflyer', { apiToken: TOKEN });

    // AppsFlyer has no app-listing endpoint, so the id is entered and validated.
    const addApp = await request(
      user,
      'POST',
      `/api/v1/organizations/${user.organizationId}/connections/${appsflyer.connectionId}/accounts`,
      { externalAccountId: APPSFLYER_APP, name: 'Fixture MMP app' },
    );
    expect(addApp.statusCode).toBe(201);
    const mmpAccount = (addApp.json() as { account: { id: string } }).account;

    // Validating the app is what actually proves an AppsFlyer token, so the
    // connection must stop being 'pending' at that point rather than staying
    // ambiguous forever.
    const afterAppValidation = await request(
      user,
      'GET',
      `/api/v1/organizations/${user.organizationId}/connections`,
    );
    const mmpConnection = (
      afterAppValidation.json() as { connections: Array<{ provider_key: string; status: string }> }
    ).connections.find((c) => c.provider_key === 'appsflyer');
    expect(mmpConnection?.status).toBe('connected');

    const bindMmp = await request(
      user,
      'POST',
      `/api/v1/organizations/${user.organizationId}/apps/${app.id}/bindings`,
      {
        connectionId: appsflyer.connectionId,
        integrationAccountId: mmpAccount.id,
        role: 'primary_attribution',
      },
    );
    expect(bindMmp.statusCode).toBe(201);

    // Capabilities must be reported once per key: the account-scoped probe
    // supersedes the connection-level declaration rather than sitting beside it.
    const cards = await request(
      user,
      'GET',
      `/api/v1/organizations/${user.organizationId}/apps/${app.id}/integrations`,
    );
    expect(cards.statusCode).toBe(200);
    const integrationCards = (
      cards.json() as {
        integrations: Array<{
          providerKey: string;
          capabilities: Array<{ key: string; discoveryMethod: string }>;
        }>;
      }
    ).integrations;
    for (const card of integrationCards) {
      const keys = card.capabilities.map((capability) => capability.key);
      expect(new Set(keys).size).toBe(keys.length);
    }
    const mmpCard = integrationCards.find((card) => card.providerKey === 'appsflyer');
    expect(
      mmpCard?.capabilities.find((capability) => capability.key === 'campaign_id')?.discoveryMethod,
    ).toBe('probed');

    // 4. Sync a bounded, deterministic window.
    const from = '2026-03-01';
    const to = '2026-03-07';
    const sync = await request(
      user,
      'POST',
      `/api/v1/organizations/${user.organizationId}/apps/${app.id}/sync`,
      { from, to },
    );
    expect(sync.statusCode).toBe(202);
    const executed = await drainSyncQueue(10);
    expect(executed).toBeGreaterThan(0);

    const runs = await request(
      user,
      'GET',
      `/api/v1/organizations/${user.organizationId}/apps/${app.id}/sync/runs`,
    );
    const runRows = (runs.json() as { runs: Array<{ status: string; data_type: string }> }).runs;
    expect(runRows.length).toBeGreaterThan(0);
    expect(runRows.every((run) => run.status === 'completed')).toBe(true);

    // 5. Reconcile, then read the dashboard payload the UI reads.
    await reconcile(user.organizationId, app.id, 'meta_ads', 'appsflyer');

    const commandCenter = await request(
      user,
      'GET',
      `/api/v1/organizations/${user.organizationId}/apps/${app.id}/command-center?from=${from}&to=${to}`,
    );
    expect(commandCenter.statusCode).toBe(200);
    const payload = commandCenter.json() as {
      metrics: Array<{ metricKey: string; value: number | null; availability: string }>;
      reconciliation: {
        coverage: {
          total: number;
          matchedExact: number;
          unmatched: number;
          coveragePct: number | null;
        };
      };
      campaigns: { rows: Array<{ mappingStatus: string | null }>; total: number };
    };

    const metric = (key: string) => payload.metrics.find((m) => m.metricKey === key);

    // Spend, impressions and clicks came from Meta over the wire.
    expect(metric('spend')?.value).toBeGreaterThan(0);
    expect(metric('impressions')?.value).toBeGreaterThan(0);
    expect(metric('attributed_installs')?.value).toBeGreaterThan(0);

    // CTR must be the summed ratio, not an average of daily ratios.
    const ctr = metric('ctr');
    const clicks = metric('clicks')?.value ?? 0;
    const impressions = metric('impressions')?.value ?? 1;
    expect(ctr?.value).toBeCloseTo(clicks / impressions, 10);

    // Cohort ROAS stays unavailable: nothing in Phase 0A can compute it.
    expect(metric('cohort_roas')?.availability).toBe('unavailable');

    // The fixture deliberately includes a Meta campaign the MMP never reports,
    // so unmatched entities must be visible rather than quietly dropped.
    expect(payload.reconciliation.coverage.matchedExact).toBeGreaterThan(0);
    expect(payload.reconciliation.coverage.unmatched).toBeGreaterThan(0);
    expect(payload.reconciliation.coverage.coveragePct).toBeLessThan(100);
    expect(payload.campaigns.rows.length).toBeGreaterThan(0);
    // Every campaign row carries an explicit mapping status - never a blank.
    expect(payload.campaigns.rows.every((row) => row.mappingStatus !== undefined)).toBe(true);
  }, 120_000);

  it('classifies a rejected credential rather than reporting success', async () => {
    await truncateAll();
    const user = await registerUser();
    // The fixture server answers an empty bearer with Meta's OAuthException.
    const response = await request(
      user,
      'POST',
      `/api/v1/organizations/${user.organizationId}/connections`,
      { providerKey: 'meta_ads', credentials: { accessToken: '' } },
    );
    // A malformed credential is rejected before any request is made.
    expect(response.statusCode).toBe(400);
  });
});

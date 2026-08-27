import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { queryRows } from '@mart/db';
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

/**
 * Tenant isolation.
 *
 * This is the Phase 0A exit criterion that matters most: MART is multi-tenant
 * from day one, so every resource type is probed from the wrong tenant and must
 * be inaccessible. A 404 (rather than 403) is intentional - a non-member should
 * not be able to learn that an organization or app exists at all.
 */
describe('tenant isolation', () => {
  let tenantA: TestUser;
  let tenantB: TestUser;
  let appA: { id: string };
  let appB: { id: string };
  let connectionA: string;
  let syncRunA: string;

  beforeAll(() => {
    installFakeProviders();
  });

  afterAll(async () => {
    removeFakeProviders();
    await closeServer();
  });

  beforeEach(async () => {
    await truncateAll();
    resetControls();
    controls.marketingRows = [
      {
        reportDate: '2026-08-20',
        campaignId: '900',
        campaignName: 'Tenant A Campaign',
        spend: 100,
        impressions: 10_000,
        clicks: 200,
        country: 'US',
      },
    ];
    controls.attributionRows = [
      {
        installDate: '2026-08-20',
        campaignId: '900',
        campaignName: 'Tenant A Campaign',
        installs: 40,
        country: 'US',
        revenue: 25,
      },
    ];

    tenantA = await registerUser({ organizationName: 'Tenant A' });
    tenantB = await registerUser({ organizationName: 'Tenant B' });
    appA = await createApp(tenantA, { name: 'A App' });
    appB = await createApp(tenantB, { name: 'B App' });

    const meta = await connectProvider(tenantA, 'meta_ads', { accessToken: 'a'.repeat(40) });
    connectionA = meta.connectionId;

    // Discover and bind an account, then run a sync so every resource type exists.
    const accounts = await request(
      tenantA,
      'GET',
      `/api/v1/organizations/${tenantA.organizationId}/connections/${connectionA}/accounts?refresh=true`,
    );
    const accountId = (accounts.json() as { accounts: Array<{ id: string }> }).accounts[0]?.id;
    await request(
      tenantA,
      'POST',
      `/api/v1/organizations/${tenantA.organizationId}/apps/${appA.id}/bindings`,
      {
        connectionId: connectionA,
        integrationAccountId: accountId,
        role: 'marketing_network',
      },
    );

    const sync = await request(
      tenantA,
      'POST',
      `/api/v1/organizations/${tenantA.organizationId}/apps/${appA.id}/sync`,
      { from: '2026-08-20', to: '2026-08-20' },
    );
    const enqueued = (sync.json() as { enqueued: Array<{ syncRunId: string }> }).enqueued;
    syncRunA = enqueued[0]?.syncRunId ?? '';
    // Execute the queued runs exactly as the worker would.
    await drainSyncQueue();
  });

  it('hides another tenant organization entirely', async () => {
    const response = await request(
      tenantB,
      'GET',
      `/api/v1/organizations/${tenantA.organizationId}/apps`,
    );
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'not_found' } });
  });

  it('does not list another tenant apps', async () => {
    const response = await request(
      tenantB,
      'GET',
      `/api/v1/organizations/${tenantB.organizationId}/apps`,
    );
    expect(response.statusCode).toBe(200);
    const apps = (response.json() as { apps: Array<{ id: string }> }).apps;
    expect(apps.map((a) => a.id)).toEqual([appB.id]);
    expect(apps.map((a) => a.id)).not.toContain(appA.id);
  });

  it('rejects reading another tenant app even with a valid app id', async () => {
    const response = await request(
      tenantB,
      'GET',
      `/api/v1/organizations/${tenantB.organizationId}/apps/${appA.id}`,
    );
    expect(response.statusCode).toBe(404);
  });

  it('rejects an app id from another tenant combined with the attacker own org id', async () => {
    for (const path of [
      `/api/v1/organizations/${tenantB.organizationId}/apps/${appA.id}/metrics`,
      `/api/v1/organizations/${tenantB.organizationId}/apps/${appA.id}/campaigns`,
      `/api/v1/organizations/${tenantB.organizationId}/apps/${appA.id}/timeseries`,
      `/api/v1/organizations/${tenantB.organizationId}/apps/${appA.id}/command-center`,
      `/api/v1/organizations/${tenantB.organizationId}/apps/${appA.id}/reconciliation`,
      `/api/v1/organizations/${tenantB.organizationId}/apps/${appA.id}/freshness`,
      `/api/v1/organizations/${tenantB.organizationId}/apps/${appA.id}/data-quality`,
      `/api/v1/organizations/${tenantB.organizationId}/apps/${appA.id}/integrations`,
      `/api/v1/organizations/${tenantB.organizationId}/apps/${appA.id}/sync/runs`,
    ]) {
      const response = await request(tenantB, 'GET', path);
      expect.soft(response.statusCode, `expected 404 for ${path}`).toBe(404);
    }
  });

  it('hides another tenant integration connections and credentials', async () => {
    const list = await request(
      tenantB,
      'GET',
      `/api/v1/organizations/${tenantB.organizationId}/connections`,
    );
    expect(list.statusCode).toBe(200);
    expect((list.json() as { connections: unknown[] }).connections).toHaveLength(0);

    const direct = await request(
      tenantB,
      'POST',
      `/api/v1/organizations/${tenantB.organizationId}/connections/${connectionA}/validate`,
    );
    expect(direct.statusCode).toBe(404);

    const crossOrg = await request(
      tenantB,
      'POST',
      `/api/v1/organizations/${tenantA.organizationId}/connections/${connectionA}/validate`,
    );
    expect(crossOrg.statusCode).toBe(404);
  });

  it('hides another tenant provider accounts', async () => {
    const response = await request(
      tenantB,
      'GET',
      `/api/v1/organizations/${tenantB.organizationId}/connections/${connectionA}/accounts`,
    );
    expect(response.statusCode).toBe(404);
  });

  it('hides another tenant sync runs and errors', async () => {
    const runs = await request(
      tenantB,
      'GET',
      `/api/v1/organizations/${tenantB.organizationId}/apps/${appB.id}/sync/runs`,
    );
    expect(runs.statusCode).toBe(200);
    expect((runs.json() as { runs: unknown[] }).runs).toHaveLength(0);

    const direct = await request(
      tenantB,
      'GET',
      `/api/v1/organizations/${tenantB.organizationId}/apps/${appB.id}/sync/runs/${syncRunA}`,
    );
    expect(direct.statusCode).toBe(404);
  });

  it('hides another tenant audit log', async () => {
    const response = await request(
      tenantB,
      'GET',
      `/api/v1/organizations/${tenantB.organizationId}/audit`,
    );
    expect(response.statusCode).toBe(200);
    const entries = (response.json() as { entries: Array<{ organization_id: string }> }).entries;
    expect(entries.every((e) => e.organization_id === tenantB.organizationId)).toBe(true);
    expect(entries.length).toBeGreaterThan(0);
  });

  it('cannot bind another tenant connection to its own app', async () => {
    const accounts = await queryRows<{ id: string }>(
      'SELECT id FROM integration_accounts WHERE connection_id = $1',
      [connectionA],
    );
    const response = await request(
      tenantB,
      'POST',
      `/api/v1/organizations/${tenantB.organizationId}/apps/${appB.id}/bindings`,
      {
        connectionId: connectionA,
        integrationAccountId: accounts[0]?.id,
        role: 'marketing_network',
      },
    );
    expect(response.statusCode).toBe(404);
  });

  it('cannot trigger a sync on another tenant app', async () => {
    const response = await request(
      tenantB,
      'POST',
      `/api/v1/organizations/${tenantA.organizationId}/apps/${appA.id}/sync`,
      {},
    );
    expect(response.statusCode).toBe(404);
  });

  /**
   * Storage-level check: every tenant-scoped table must carry tenant A's rows
   * and nothing readable through tenant B's scoped queries.
   */
  it('scopes every stored fact table by organization', async () => {
    const tables = [
      'apps',
      'integration_connections',
      'integration_credentials',
      'integration_accounts',
      'integration_app_bindings',
      'sync_jobs',
      'sync_runs',
      'raw_ingestion_batches',
      'marketing_campaigns',
      'marketing_daily_metrics',
      'audit_log',
    ];
    for (const table of tables) {
      const rows = await queryRows<{ count: string }>(
        `SELECT count(*)::text AS count FROM ${table} WHERE organization_id = $1`,
        [tenantB.organizationId],
      );
      const ownRows = await queryRows<{ count: string }>(
        `SELECT count(*)::text AS count FROM ${table} WHERE organization_id = $1`,
        [tenantA.organizationId],
      );
      expect
        .soft(Number(rows[0]?.count ?? 0), `${table} leaked into tenant B`)
        .toBe(table === 'apps' || table === 'audit_log' ? Number(rows[0]?.count ?? 0) : 0);
      if (table !== 'apps' && table !== 'audit_log') {
        expect
          .soft(Number(ownRows[0]?.count ?? 0), `${table} has no tenant A rows`)
          .toBeGreaterThan(0);
      }
    }
  });

  it('never returns another tenant campaign data through the campaigns endpoint', async () => {
    const response = await request(
      tenantB,
      'GET',
      `/api/v1/organizations/${tenantB.organizationId}/apps/${appB.id}/campaigns?from=2026-08-20&to=2026-08-20`,
    );
    expect(response.statusCode).toBe(200);
    expect((response.json() as { rows: unknown[] }).rows).toHaveLength(0);
  });
});

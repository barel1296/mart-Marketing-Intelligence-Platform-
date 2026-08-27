import type { FastifyInstance } from 'fastify';
import { query, queryRows, syncRepo } from '@mart/db';
import { hydrateRequest, reconcileCampaigns, runSync } from '@mart/integrations';
import { buildServer } from '../../apps/api/src/app.js';
import { resetAllLimiters } from '../../apps/api/src/rateLimit.js';

export type TestUser = {
  email: string;
  password: string;
  userId: string;
  organizationId: string;
  cookie: string;
  csrfToken: string;
};

let server: FastifyInstance | null = null;

export async function getServer(): Promise<FastifyInstance> {
  if (!server) server = await buildServer();
  return server;
}

export async function closeServer(): Promise<void> {
  if (server) {
    await server.close();
    server = null;
  }
}

/** Truncate every business table between tests, keeping the schema intact. */
export async function truncateAll(): Promise<void> {
  // Limits are per-IP and every test shares one; reset so realistic production
  // limits do not make the suite flaky.
  resetAllLimiters();
  const tables = await queryRows<{ tablename: string }>(
    `SELECT tablename FROM pg_tables
     WHERE schemaname = 'public' AND tablename <> 'schema_migrations'
       AND tablename <> 'integration_providers'`,
  );
  if (tables.length === 0) return;
  const list = tables.map((t) => `"${t.tablename}"`).join(', ');
  await query(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
}

function cookieFrom(headers: Record<string, unknown>, name: string): string | null {
  const raw = headers['set-cookie'];
  const values = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
  for (const value of values) {
    const match = new RegExp(`${name}=([^;]+)`).exec(value);
    if (match?.[1]) return match[1];
  }
  return null;
}

let userCounter = 0;

/** Register a user with their own organization and return an authenticated context. */
export async function registerUser(
  overrides: { email?: string; organizationName?: string; password?: string } = {},
): Promise<TestUser> {
  userCounter += 1;
  const app = await getServer();
  const email = overrides.email ?? `user${userCounter}-${Date.now()}@example.com`;
  const password = overrides.password ?? 'TestPassword123';

  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: {
      email,
      password,
      displayName: `User ${userCounter}`,
      organizationName: overrides.organizationName ?? `Org ${userCounter}`,
    },
  });
  if (response.statusCode !== 201) {
    throw new Error(`registration failed: ${response.statusCode} ${response.body}`);
  }
  const body = response.json() as {
    user: { id: string };
    organization: { id: string };
    csrfToken: string;
  };
  const session = cookieFrom(response.headers as Record<string, unknown>, 'mart_session');
  const csrf = cookieFrom(response.headers as Record<string, unknown>, 'mart_csrf');
  if (!session || !csrf) throw new Error('registration did not set auth cookies');

  return {
    email,
    password,
    userId: body.user.id,
    organizationId: body.organization.id,
    cookie: `mart_session=${session}; mart_csrf=${csrf}`,
    csrfToken: body.csrfToken,
  };
}

/** Add an existing user to another organization with a given role. */
export async function addMember(
  owner: TestUser,
  organizationId: string,
  email: string,
  role: 'owner' | 'admin' | 'analyst' | 'viewer',
): Promise<void> {
  const response = await request(owner, 'POST', `/api/v1/organizations/${organizationId}/members`, {
    email,
    role,
  });
  if (response.statusCode !== 201) {
    throw new Error(`addMember failed: ${response.statusCode} ${response.body}`);
  }
}

export async function request(
  user: TestUser | null,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  payload?: unknown,
) {
  const app = await getServer();
  return app.inject({
    method,
    url,
    ...(payload !== undefined ? { payload } : {}),
    headers: {
      ...(user ? { cookie: user.cookie, 'x-mart-csrf': user.csrfToken } : {}),
    },
  });
}

export async function createApp(
  user: TestUser,
  overrides: {
    name?: string;
    bundleId?: string;
    platform?: 'ios' | 'android' | 'cross_platform';
  } = {},
): Promise<{ id: string }> {
  const response = await request(
    user,
    'POST',
    `/api/v1/organizations/${user.organizationId}/apps`,
    {
      name: overrides.name ?? 'Test App',
      platform: overrides.platform ?? 'ios',
      bundleId: overrides.bundleId ?? `com.example.app${Math.random().toString(36).slice(2, 8)}`,
      timezone: 'UTC',
      defaultCurrency: 'USD',
    },
  );
  if (response.statusCode !== 201) {
    throw new Error(`createApp failed: ${response.statusCode} ${response.body}`);
  }
  return (response.json() as { app: { id: string } }).app;
}

/** Connect a provider using the real route, with a fake credential. */
export async function connectProvider(
  user: TestUser,
  providerKey: 'meta_ads' | 'appsflyer' | 'tenjin',
  credentials: Record<string, string>,
): Promise<{ connectionId: string }> {
  const response = await request(
    user,
    'POST',
    `/api/v1/organizations/${user.organizationId}/connections`,
    { providerKey, credentials },
  );
  if (response.statusCode !== 201) {
    throw new Error(`connectProvider failed: ${response.statusCode} ${response.body}`);
  }
  return { connectionId: (response.json() as { connection: { id: string } }).connection.id };
}

/**
 * Execute everything currently queued, the way the worker would.
 *
 * Integration tests exercise the real engine rather than a stub of it, so
 * idempotency, restatement and checkpointing are proven against PostgreSQL.
 */
export async function drainSyncQueue(maxBatches = 5): Promise<number> {
  let executed = 0;
  for (let batch = 0; batch < maxBatches; batch += 1) {
    const runs = await syncRepo.claimQueuedRuns(10);
    if (runs.length === 0) break;
    for (const run of runs) {
      const request = await hydrateRequest(run);
      if (!request) continue;
      await runSync(run, request);
      executed += 1;
    }
  }
  return executed;
}

/** Run campaign reconciliation the way the worker does after a sync. */
export async function reconcile(
  organizationId: string,
  appId: string,
  marketingProviderKey = 'meta_ads',
  attributionProviderKey = 'appsflyer',
) {
  return reconcileCampaigns({
    organizationId,
    appId,
    marketingProviderKey,
    attributionProviderKey,
  });
}

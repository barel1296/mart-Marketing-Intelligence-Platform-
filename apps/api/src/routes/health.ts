import type { FastifyInstance } from 'fastify';
import { queryOne, syncRepo } from '@mart/db';
import { counters } from '@mart/observability';

/**
 * Health endpoints.
 *
 * /health is a liveness probe and must stay cheap: it never touches the
 * database or a provider. /ready checks the dependencies MART cannot serve
 * without, and still never calls an external provider - a provider outage must
 * not take MART out of rotation, because historical dashboards keep working.
 */
export async function registerHealthRoutes(server: FastifyInstance): Promise<void> {
  const startedAt = Date.now();

  server.get('/health', async () => ({
    status: 'ok',
    service: 'mart-api',
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
  }));

  server.get('/ready', async (_request, reply) => {
    const checks: Record<string, { ok: boolean; detail?: string }> = {};

    try {
      const row = await queryOne<{ ok: number }>('SELECT 1 AS ok');
      checks['database'] = { ok: row?.ok === 1 };
    } catch {
      checks['database'] = { ok: false, detail: 'Database query failed' };
    }

    try {
      const row = await queryOne<{ count: string }>(
        'SELECT count(*)::text AS count FROM schema_migrations',
      );
      checks['migrations'] = {
        ok: Number(row?.count ?? 0) > 0,
        detail: `${row?.count ?? 0} applied`,
      };
    } catch {
      checks['migrations'] = { ok: false, detail: 'schema_migrations unavailable' };
    }

    const ready = Object.values(checks).every((c) => c.ok);
    reply.status(ready ? 200 : 503);
    return { status: ready ? 'ready' : 'not_ready', checks };
  });

  /** Operational counters, for local inspection and scraping. */
  server.get('/metrics-internal', async () => {
    let queuedRuns: number;
    try {
      const row = await queryOne<{ count: string }>(
        "SELECT count(*)::text AS count FROM sync_runs WHERE status IN ('queued','running')",
      );
      queuedRuns = Number(row?.count ?? 0);
    } catch {
      queuedRuns = -1;
    }
    return { counters: counters.snapshot(), queuedRuns };
  });

  // Reference the repo so the module's dependency on the sync schema is explicit
  // to readers and to the type checker.
  void syncRepo;
}

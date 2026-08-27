import Fastify from 'fastify';
import { getConfig } from '@mart/config';
import { counters, getLogger, newRequestId, runWithContext } from '@mart/observability';
import { closePool, migrate, queryOne, syncRepo, tenancyRepo } from '@mart/db';
import {
  backoffDelayMs,
  hydrateRequest,
  planSyncs,
  reconcileCampaigns,
  runSync,
  enqueueSync,
  loadAppReconciliationTargets,
} from './services.js';

const config = getConfig();
const log = getLogger().child({ component: 'worker' });

let running = true;
let lastTickAt: Date | null = null;
let lastError: string | null = null;
let inFlight = 0;

/**
 * Claim and execute queued sync runs.
 *
 * Runs are claimed with FOR UPDATE SKIP LOCKED, so several worker replicas can
 * poll the same table without ever executing one run twice.
 */
async function processQueuedRuns(): Promise<number> {
  const capacity = Math.max(0, config.WORKER_CONCURRENCY - inFlight);
  if (capacity === 0) return 0;

  const runs = await syncRepo.claimQueuedRuns(capacity);
  if (runs.length === 0) return 0;

  await Promise.all(
    runs.map(async (run) => {
      inFlight += 1;
      const requestId = run.request_id ?? newRequestId();
      try {
        await runWithContext(
          {
            requestId,
            organizationId: run.organization_id,
            syncRunId: run.id,
            provider: run.provider_key,
          },
          async () => {
            const request = await hydrateRequest(run);
            if (!request) {
              // The binding disappeared between enqueue and execution.
              await syncRepo.completeSyncRun(run.id, {
                status: 'cancelled',
                rowsFetched: 0,
                rowsNormalized: 0,
                rowsRejected: 0,
                errorMessage:
                  'The integration binding for this run no longer exists, so it was cancelled.',
              });
              return;
            }

            const summary = await runSync(run, request);
            counters.increment('sync_runs_total', {
              provider: run.provider_key,
              status: summary.status,
            });
            log.info(
              {
                status: summary.status,
                rowsFetched: summary.rowsFetched,
                rowsNormalized: summary.rowsNormalized,
                windowsCompleted: summary.windowsCompleted,
                windowsFailed: summary.windowsFailed,
              },
              'sync run finished',
            );

            if (summary.status === 'failed' && isRetryable(summary.errorClass)) {
              // Wait before the next attempt. Retrying a rate-limited provider
              // on the next poll would spend the whole retry budget in seconds.
              const delayMs = backoffDelayMs(run.attempt + 1);
              const requeued = await syncRepo.requeueRun(run.id, config.SYNC_MAX_ATTEMPTS, delayMs);
              if (requeued) {
                log.info(
                  { attempt: run.attempt + 1, retryInMs: delayMs },
                  'sync run requeued for retry',
                );
              }
            }

            // Reconciliation depends on both sides being present, so it runs
            // after a sync rather than inside one.
            if (summary.status !== 'failed') {
              await reconcileApp(run.organization_id, run.app_id);
            }
          },
        );
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        log.error({ err: lastError, syncRunId: run.id }, 'sync run threw');
        await syncRepo
          .completeSyncRun(run.id, {
            status: 'failed',
            rowsFetched: 0,
            rowsNormalized: 0,
            rowsRejected: 0,
            errorClass: 'unknown_error',
            errorMessage: 'The sync worker failed unexpectedly while executing this run.',
          })
          .catch(() => undefined);
      } finally {
        inFlight -= 1;
      }
    }),
  );

  return runs.length;
}

/** Turn due recurring jobs into queued runs. */
async function scheduleDueJobs(): Promise<number> {
  const jobs = await syncRepo.claimDueSyncJobs(10);
  let enqueued = 0;
  for (const job of jobs) {
    try {
      const requests = await planSyncs({
        organizationId: job.organization_id,
        appId: job.app_id,
        trigger: 'scheduled',
        connectionId: job.connection_id,
        dataTypes: [job.data_type],
      });
      for (const request of requests) {
        const active = await syncRepo.hasActiveRun(
          request.connectionId,
          request.appId,
          request.dataType,
        );
        if (active) continue;
        await enqueueSync({ ...request, syncJobId: job.id });
        enqueued += 1;
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      log.error({ err: lastError, jobId: job.id }, 'failed to schedule sync job');
    }
  }
  return enqueued;
}

async function reconcileApp(organizationId: string, appId: string): Promise<void> {
  try {
    const targets = await loadAppReconciliationTargets(organizationId, appId);
    if (!targets) return;
    const summary = await reconcileCampaigns({
      organizationId,
      appId,
      marketingProviderKey: targets.marketingProviderKey,
      attributionProviderKey: targets.attributionProviderKey,
    });
    counters.increment('reconciliation_runs_total');
    log.info(
      {
        matchedExact: summary.matchedExact,
        matchedFallback: summary.matchedFallback,
        ambiguous: summary.ambiguous,
        unmatchedMarketing: summary.unmatchedMarketing,
      },
      'campaign reconciliation complete',
    );
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
    log.error({ err: lastError }, 'reconciliation failed');
  }
}

function isRetryable(errorClass: string | undefined): boolean {
  return (
    errorClass === 'rate_limited' ||
    errorClass === 'provider_unavailable' ||
    errorClass === 'timeout' ||
    errorClass === 'database_error'
  );
}

async function tick(): Promise<void> {
  lastTickAt = new Date();
  await scheduleDueJobs();
  await processQueuedRuns();
  await tenancyRepo.deleteExpiredSessions();
}

async function loop(): Promise<void> {
  while (running) {
    try {
      await tick();
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      log.error({ err: lastError }, 'worker tick failed');
    }
    await new Promise((resolve) => setTimeout(resolve, config.WORKER_POLL_INTERVAL_MS));
  }
}

/** Worker health is externally inspectable, like the API's. */
async function startHealthServer(): Promise<void> {
  const server = Fastify({ logger: false });

  server.get('/health', async () => ({
    status: 'ok',
    service: 'mart-worker',
    lastTickAt,
    inFlight,
  }));

  server.get('/ready', async (_request, reply) => {
    let databaseOk: boolean;
    try {
      const row = await queryOne<{ ok: number }>('SELECT 1 AS ok');
      databaseOk = row?.ok === 1;
    } catch {
      databaseOk = false;
    }
    // A worker that has not ticked recently is not doing its job even if the
    // process is alive.
    const tickFresh =
      lastTickAt !== null && Date.now() - lastTickAt.getTime() < config.WORKER_POLL_INTERVAL_MS * 6;
    const ready = databaseOk && tickFresh;
    reply.status(ready ? 200 : 503);
    return {
      status: ready ? 'ready' : 'not_ready',
      checks: { database: databaseOk, ticking: tickFresh },
      lastTickAt,
      lastError,
    };
  });

  server.get('/metrics-internal', async () => ({
    counters: counters.snapshot(),
    inFlight,
    lastTickAt,
  }));

  await server.listen({ port: config.WORKER_HEALTH_PORT, host: '0.0.0.0' });
  log.info({ port: config.WORKER_HEALTH_PORT }, 'worker health endpoint listening');
}

async function main(): Promise<void> {
  await migrate();
  await startHealthServer();
  log.info({ concurrency: config.WORKER_CONCURRENCY }, 'mart worker started');

  const shutdown = async (signal: string): Promise<void> => {
    log.info({ signal }, 'worker shutting down');
    running = false;
    // Let in-flight runs finish before closing the pool underneath them.
    const deadline = Date.now() + 30_000;
    while (inFlight > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    await closePool();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await loop();
}

main().catch((error: unknown) => {
  log.fatal(
    { err: error instanceof Error ? error.message : String(error) },
    'worker failed to start',
  );
  process.exit(1);
});

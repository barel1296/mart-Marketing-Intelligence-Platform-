import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError, SYNC_DATA_TYPES } from '@mart/shared';
import { auditRepo, syncRepo } from '@mart/db';
import { enqueueSync, planSyncs, ensureSyncJobs } from '@mart/integrations';
import { setNoStore, withApp } from '../context.js';
import { syncTriggerLimiter } from '../rateLimit.js';

const appParams = z.object({
  organizationId: z.string().uuid(),
  appId: z.string().uuid(),
});

const triggerSchema = z.object({
  connectionId: z.string().uuid().optional(),
  dataTypes: z.array(z.enum(SYNC_DATA_TYPES)).min(1).optional(),
  /** Pull history rather than the recent restatement window. */
  backfill: z.boolean().optional(),
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});

export async function registerSyncRoutes(server: FastifyInstance): Promise<void> {
  /**
   * Trigger a sync.
   *
   * The API only enqueues: the worker executes. That keeps a slow provider from
   * holding an HTTP connection open, and means a triggered sync survives an API
   * restart.
   */
  server.post('/organizations/:organizationId/apps/:appId/sync', async (request, reply) => {
    const params = appParams.parse(request.params);
    const { context, app } = await withApp(
      request,
      params.organizationId,
      params.appId,
      'sync:trigger',
    );
    syncTriggerLimiter.check(`sync:${context.organizationId}:${app.id}`);
    const body = triggerSchema.parse(request.body ?? {});

    const requests = await planSyncs({
      organizationId: context.organizationId,
      appId: app.id,
      trigger: 'manual',
      ...(body.connectionId ? { connectionId: body.connectionId } : {}),
      ...(body.dataTypes ? { dataTypes: body.dataTypes } : {}),
      ...(body.backfill !== undefined ? { backfill: body.backfill } : {}),
      ...(body.from ? { from: body.from } : {}),
      ...(body.to ? { to: body.to } : {}),
      requestId: request.requestId,
      triggeredByUserId: context.userId,
    });

    if (requests.length === 0) {
      throw new AppError(
        'validation_failed',
        'Nothing to sync: connect a provider and select an account for this app first.',
      );
    }

    const enqueued: Array<{ syncRunId: string; dataType: string; from: string; to: string }> = [];
    const skipped: Array<{ dataType: string; reason: string }> = [];

    for (const syncRequest of requests) {
      // One active run per (connection, app, data type): a second click must not
      // create a duplicate import.
      const active = await syncRepo.hasActiveRun(
        syncRequest.connectionId,
        syncRequest.appId,
        syncRequest.dataType,
      );
      if (active) {
        skipped.push({ dataType: syncRequest.dataType, reason: 'A sync is already in progress' });
        continue;
      }
      const run = await enqueueSync(syncRequest);
      enqueued.push({
        syncRunId: run.id,
        dataType: syncRequest.dataType,
        from: syncRequest.from,
        to: syncRequest.to,
      });
    }

    await ensureSyncJobs(context.organizationId, app.id);
    await auditRepo.writeAudit({
      organizationId: context.organizationId,
      actorUserId: context.userId,
      action: 'sync.triggered',
      resourceType: 'app',
      resourceId: app.id,
      requestId: request.requestId,
      metadata: {
        enqueued: enqueued.length,
        skipped: skipped.length,
        backfill: body.backfill ?? false,
      },
    });

    return reply.status(202).send({ enqueued, skipped });
  });

  server.get('/organizations/:organizationId/apps/:appId/sync/runs', async (request, reply) => {
    const params = appParams.parse(request.params);
    const query = z
      .object({ limit: z.coerce.number().int().min(1).max(100).optional() })
      .parse(request.query);
    const { context, app } = await withApp(
      request,
      params.organizationId,
      params.appId,
      'sync:read',
    );
    setNoStore(reply);

    const runs = await syncRepo.listSyncRuns(context.organizationId, {
      appId: app.id,
      ...(query.limit ? { limit: query.limit } : {}),
    });
    const errors = await syncRepo.listRecentSyncErrors(context.organizationId, {
      appId: app.id,
      limit: 20,
    });
    return { runs, recentErrors: errors };
  });

  server.get(
    '/organizations/:organizationId/apps/:appId/sync/runs/:runId',
    async (request, reply) => {
      const params = appParams.extend({ runId: z.string().uuid() }).parse(request.params);
      const { context } = await withApp(request, params.organizationId, params.appId, 'sync:read');
      setNoStore(reply);

      const run = await syncRepo.findSyncRun(context.organizationId, params.runId);
      if (!run || run.app_id !== params.appId)
        throw new AppError('not_found', 'Sync run not found');
      return { run };
    },
  );

  server.get('/organizations/:organizationId/apps/:appId/freshness', async (request, reply) => {
    const params = appParams.parse(request.params);
    const { context, app } = await withApp(
      request,
      params.organizationId,
      params.appId,
      'sync:read',
    );
    setNoStore(reply);
    const freshness = await syncRepo.listFreshness(context.organizationId, app.id);
    const jobs = await syncRepo.listSyncJobs(context.organizationId, app.id);
    return { freshness, jobs };
  });
}

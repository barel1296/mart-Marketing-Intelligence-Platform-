import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError, addDays, daysBetween, resolveReportingWindow, type IsoDate } from '@mart/shared';
import { auditRepo, decisionsRepo } from '@mart/db';
import {
  DECISION_THRESHOLDS,
  loadDecisions,
  policySnapshot,
  type MetricFilters,
} from '@mart/metrics';
import { setNoStore, withApp } from '../context.js';
import { buildMetricContext } from '../services/analyticsContext.js';

/**
 * The Decision Center over the wire - Phase 3.
 *
 * Two resources and nothing else: the recommendations for a window, and the
 * operator's targets they are read against. There is no endpoint that
 * changes a campaign, and the payload says so in a field of its own
 * (`automation: 'none'`) so a client cannot mistake a recommendation for a
 * queued change.
 */

const appParams = z.object({
  organizationId: z.string().uuid(),
  appId: z.string().uuid(),
});

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');

const windowQuery = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
});

/** Targets are optional individually; a currency is required with a CPI ceiling. */
const policyBody = z
  .object({
    targetRoasD7: z.number().positive().max(1000).nullable().optional(),
    targetRoasD1: z.number().positive().max(1000).nullable().optional(),
    maxCpi: z.number().positive().max(1_000_000).nullable().optional(),
    currency: z
      .string()
      .length(3)
      .regex(/^[A-Z]{3}$/, 'Expected an ISO 4217 code')
      .nullable()
      .optional(),
  })
  .strict();

/**
 * Default window: the last 28 days in the app's calendar.
 *
 * Longer than the dashboard's week on purpose. A D7 reading needs cohorts at
 * least eight days old plus three mature days, so a seven-day window can
 * never contain a mature cohort and would report `insufficient_data` for
 * every campaign, every time.
 */
export const DECISION_WINDOW_DAYS = 28;
/** Every campaign is read as a dense day array; a multi-year window is a report, not a decision. */
export const MAXIMUM_DECISION_WINDOW_DAYS = 366;

function resolveDecisionWindow(
  query: { from?: string; to?: string },
  timezone: string,
): { from: IsoDate; to: IsoDate; timezone: string } {
  const resolved = resolveReportingWindow(query, timezone);
  const to = resolved.endDate;
  const from = query.from ?? addDays(to, -(DECISION_WINDOW_DAYS - 1));
  if (from > to) throw new AppError('validation_failed', '`from` must not be after `to`');
  if (daysBetween(from, to) >= MAXIMUM_DECISION_WINDOW_DAYS) {
    throw new AppError(
      'validation_failed',
      `The decision window may not exceed ${MAXIMUM_DECISION_WINDOW_DAYS} days`,
    );
  }
  return { from, to, timezone };
}

export async function registerDecisionRoutes(server: FastifyInstance): Promise<void> {
  server.get('/organizations/:organizationId/apps/:appId/decisions', async (request, reply) => {
    const params = appParams.parse(request.params);
    const query = windowQuery.parse(request.query);
    const { context, app } = await withApp(
      request,
      params.organizationId,
      params.appId,
      'metrics:read',
    );
    setNoStore(reply);

    const window = resolveDecisionWindow(query, app.timezone);
    const { context: metricContext, state } = await buildMetricContext(
      context.organizationId,
      app,
      window,
    );
    const filters: MetricFilters = {
      organizationId: context.organizationId,
      appId: app.id,
      from: window.from,
      to: window.to,
      marketingProviderKey: state.marketingProviderKey,
      attributionProviderKey: state.attributionProviderKey,
    };
    const policy = await decisionsRepo.getDecisionPolicy(context.organizationId, app.id);
    const decisions = await loadDecisions({ filters, context: metricContext, window, policy });

    return {
      app: {
        id: app.id,
        name: app.name,
        default_currency: app.default_currency,
        timezone: app.timezone,
      },
      sources: {
        marketing: state.marketingProviderKey,
        attribution: state.attributionProviderKey,
      },
      decisions,
    };
  });

  server.get(
    '/organizations/:organizationId/apps/:appId/decision-policy',
    async (request, reply) => {
      const params = appParams.parse(request.params);
      const { context, app } = await withApp(
        request,
        params.organizationId,
        params.appId,
        'metrics:read',
      );
      setNoStore(reply);
      const row = await decisionsRepo.getDecisionPolicy(context.organizationId, app.id);
      return { policy: policySnapshot(row), thresholds: DECISION_THRESHOLDS };
    },
  );

  server.put(
    '/organizations/:organizationId/apps/:appId/decision-policy',
    async (request, reply) => {
      const params = appParams.parse(request.params);
      const body = policyBody.parse(request.body);
      const { context, app } = await withApp(
        request,
        params.organizationId,
        params.appId,
        'app:update',
      );
      setNoStore(reply);

      const targetRoasD7 = body.targetRoasD7 ?? null;
      const targetRoasD1 = body.targetRoasD1 ?? null;
      const maxCpi = body.maxCpi ?? null;
      const currency = body.currency ?? (maxCpi !== null ? app.default_currency : null);
      if (maxCpi !== null && !currency) {
        throw new AppError('validation_failed', 'A CPI ceiling needs a currency');
      }

      if (targetRoasD7 === null && targetRoasD1 === null && maxCpi === null) {
        await decisionsRepo.deleteDecisionPolicy(context.organizationId, app.id);
        await auditRepo.writeAudit({
          organizationId: context.organizationId,
          actorUserId: context.userId,
          action: 'decision_policy.cleared',
          resourceType: 'decision_policy',
          resourceId: app.id,
          requestId: request.requestId,
        });
        return { policy: policySnapshot(null), thresholds: DECISION_THRESHOLDS };
      }

      const row = await decisionsRepo.upsertDecisionPolicy({
        organizationId: context.organizationId,
        appId: app.id,
        targetRoasD7,
        targetRoasD1,
        maxCpi,
        currency,
        updatedByUserId: context.userId,
      });
      await auditRepo.writeAudit({
        organizationId: context.organizationId,
        actorUserId: context.userId,
        action: 'decision_policy.updated',
        resourceType: 'decision_policy',
        resourceId: app.id,
        requestId: request.requestId,
        metadata: { targetRoasD7, targetRoasD1, maxCpi, currency },
      });
      return { policy: policySnapshot(row), thresholds: DECISION_THRESHOLDS };
    },
  );
}

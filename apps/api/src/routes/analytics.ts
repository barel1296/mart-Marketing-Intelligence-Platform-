import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { addDays, AppError, toIsoDate, MAPPING_STATUSES } from '@mart/shared';
import { auditRepo, dataQualityRepo, integrationsRepo, mappingsRepo, syncRepo } from '@mart/db';
import { campaignCoverage, reconcileCampaigns } from '@mart/integrations';
import {
  computeMetricValues,
  listMetricDefinitions,
  loadAttributionAggregate,
  loadCampaignTable,
  loadFilterOptions,
  loadMarketingAggregate,
  loadReconciliationDiscrepancies,
  loadTimeseries,
  type MetricFilters,
} from '@mart/metrics';
import { setNoStore, withApp, withOrganization } from '../context.js';
import { buildMetricContext } from '../services/analyticsContext.js';

const appParams = z.object({
  organizationId: z.string().uuid(),
  appId: z.string().uuid(),
});

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');

const filterQuery = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  country: z.string().length(2).optional(),
  platform: z.string().max(20).optional(),
  marketingAccountExternalId: z.string().max(200).optional(),
});

/** Default window: the last 7 complete days plus today. */
function resolveRange(query: { from?: string; to?: string }): { from: string; to: string } {
  const to = query.to ?? toIsoDate(new Date());
  const from = query.from ?? addDays(to, -6);
  if (from > to) throw new AppError('validation_failed', '`from` must not be after `to`');
  return { from, to };
}

export async function registerAnalyticsRoutes(server: FastifyInstance): Promise<void> {
  /** The governed metric catalogue, so the UI can render definitions. */
  server.get('/metric-definitions', async (_request, reply) => {
    setNoStore(reply);
    return { metrics: listMetricDefinitions() };
  });

  server.get('/organizations/:organizationId/apps/:appId/metrics', async (request, reply) => {
    const params = appParams.parse(request.params);
    const query = filterQuery.extend({ metrics: z.string().optional() }).parse(request.query);
    const { context, app } = await withApp(
      request,
      params.organizationId,
      params.appId,
      'metrics:read',
    );
    setNoStore(reply);

    const range = resolveRange(query);
    const { context: metricContext, state } = await buildMetricContext(context.organizationId, app);
    const filters: MetricFilters = {
      organizationId: context.organizationId,
      appId: app.id,
      from: range.from,
      to: range.to,
      country: query.country ?? null,
      platform: query.platform ?? null,
      marketingProviderKey: state.marketingProviderKey,
      attributionProviderKey: state.attributionProviderKey,
      marketingAccountExternalId: query.marketingAccountExternalId ?? null,
    };

    const [marketing, attribution] = await Promise.all([
      loadMarketingAggregate(filters),
      loadAttributionAggregate(filters),
    ]);

    const metrics = computeMetricValues({
      ...(query.metrics ? { metricKeys: query.metrics.split(',') } : {}),
      context: metricContext,
      marketing,
      attribution,
    });

    return {
      range,
      metrics,
      // Provenance for every number on the screen.
      sources: {
        marketing: state.marketingProviderKey,
        attribution: state.attributionProviderKey,
        marketingRows: marketing.rows,
        attributionRows: attribution.rows,
        currencies: marketing.currencies,
      },
    };
  });

  server.get('/organizations/:organizationId/apps/:appId/timeseries', async (request, reply) => {
    const params = appParams.parse(request.params);
    const query = filterQuery.parse(request.query);
    const { context, app } = await withApp(
      request,
      params.organizationId,
      params.appId,
      'metrics:read',
    );
    setNoStore(reply);

    const range = resolveRange(query);
    const { state } = await buildMetricContext(context.organizationId, app);
    const series = await loadTimeseries({
      organizationId: context.organizationId,
      appId: app.id,
      from: range.from,
      to: range.to,
      country: query.country ?? null,
      platform: query.platform ?? null,
      marketingProviderKey: state.marketingProviderKey,
      attributionProviderKey: state.attributionProviderKey,
      marketingAccountExternalId: query.marketingAccountExternalId ?? null,
    });
    return { range, ...series };
  });

  server.get('/organizations/:organizationId/apps/:appId/campaigns', async (request, reply) => {
    const params = appParams.parse(request.params);
    const query = filterQuery
      .extend({
        limit: z.coerce.number().int().min(1).max(200).optional(),
        offset: z.coerce.number().int().min(0).optional(),
        sort: z.enum(['spend', 'impressions', 'clicks', 'name']).optional(),
        direction: z.enum(['asc', 'desc']).optional(),
        mappingStatus: z.enum(MAPPING_STATUSES).optional(),
      })
      .parse(request.query);
    const { context, app } = await withApp(
      request,
      params.organizationId,
      params.appId,
      'metrics:read',
    );
    setNoStore(reply);

    const range = resolveRange(query);
    const { state } = await buildMetricContext(context.organizationId, app);
    if (!state.marketingProviderKey) {
      return {
        range,
        rows: [],
        total: 0,
        notice: 'No marketing network is connected for this app.',
      };
    }

    const table = await loadCampaignTable({
      organizationId: context.organizationId,
      appId: app.id,
      from: range.from,
      to: range.to,
      country: query.country ?? null,
      platform: query.platform ?? null,
      marketingProviderKey: state.marketingProviderKey,
      attributionProviderKey: state.attributionProviderKey,
      marketingAccountExternalId: query.marketingAccountExternalId ?? null,
      ...(query.limit ? { limit: query.limit } : {}),
      ...(query.offset ? { offset: query.offset } : {}),
      ...(query.sort ? { sort: query.sort } : {}),
      ...(query.direction ? { direction: query.direction } : {}),
      ...(query.mappingStatus ? { mappingStatus: query.mappingStatus } : {}),
    });

    return { range, ...table };
  });

  server.get(
    '/organizations/:organizationId/apps/:appId/reconciliation',
    async (request, reply) => {
      const params = appParams.parse(request.params);
      const query = filterQuery.parse(request.query);
      const { context, app } = await withApp(
        request,
        params.organizationId,
        params.appId,
        'mapping:read',
      );
      setNoStore(reply);

      const range = resolveRange(query);
      const { state } = await buildMetricContext(context.organizationId, app);
      if (!state.marketingProviderKey || !state.attributionProviderKey) {
        return {
          range,
          coverage: null,
          discrepancies: [],
          mappings: [],
          notice:
            'Reconciliation needs both a marketing network and an attribution provider connected to this app.',
        };
      }

      const [coverage, discrepancies, ambiguous] = await Promise.all([
        campaignCoverage(context.organizationId, app.id, state.marketingProviderKey),
        loadReconciliationDiscrepancies({
          organizationId: context.organizationId,
          appId: app.id,
          from: range.from,
          to: range.to,
          marketingProviderKey: state.marketingProviderKey,
          attributionProviderKey: state.attributionProviderKey,
        }),
        mappingsRepo.listMappings(context.organizationId, app.id, {
          entityType: 'campaign',
          status: 'ambiguous',
          limit: 50,
        }),
      ]);

      return { range, coverage, discrepancies, ambiguousMappings: ambiguous };
    },
  );

  server.post(
    '/organizations/:organizationId/apps/:appId/reconciliation/recompute',
    async (request) => {
      const params = appParams.parse(request.params);
      const { context, app } = await withApp(
        request,
        params.organizationId,
        params.appId,
        'mapping:read',
      );
      const { state } = await buildMetricContext(context.organizationId, app);
      if (!state.marketingProviderKey || !state.attributionProviderKey) {
        throw new AppError(
          'validation_failed',
          'Both a marketing network and an attribution provider must be connected before reconciliation can run.',
        );
      }
      const summary = await reconcileCampaigns({
        organizationId: context.organizationId,
        appId: app.id,
        marketingProviderKey: state.marketingProviderKey,
        attributionProviderKey: state.attributionProviderKey,
      });
      return { summary };
    },
  );

  server.get('/organizations/:organizationId/apps/:appId/mappings', async (request, reply) => {
    const params = appParams.parse(request.params);
    const query = z
      .object({
        status: z.enum(MAPPING_STATUSES).optional(),
        limit: z.coerce.number().int().min(1).max(500).optional(),
      })
      .parse(request.query);
    const { context, app } = await withApp(
      request,
      params.organizationId,
      params.appId,
      'mapping:read',
    );
    setNoStore(reply);
    const mappings = await mappingsRepo.listMappings(context.organizationId, app.id, {
      entityType: 'campaign',
      ...(query.status ? { status: query.status } : {}),
      ...(query.limit ? { limit: query.limit } : {}),
    });
    return { mappings };
  });

  /** Human verification of a mapping. Audited, and immune to recomputation. */
  server.post(
    '/organizations/:organizationId/apps/:appId/mappings/:mappingId/verify',
    async (request) => {
      const params = appParams.extend({ mappingId: z.string().uuid() }).parse(request.params);
      const body = z
        .object({
          decision: z.enum(['verify', 'reject']),
          targetExternalId: z.string().max(200).optional(),
          targetName: z.string().max(300).optional(),
        })
        .parse(request.body);
      const { context, app } = await withApp(
        request,
        params.organizationId,
        params.appId,
        'mapping:verify',
      );

      const mapping = await mappingsRepo.setMappingVerification(
        context.organizationId,
        app.id,
        params.mappingId,
        {
          status: body.decision === 'verify' ? 'manually_verified' : 'rejected',
          ...(body.targetExternalId ? { targetExternalId: body.targetExternalId } : {}),
          ...(body.targetName ? { targetName: body.targetName } : {}),
          verifiedByUserId: context.userId,
        },
      );
      if (!mapping) throw new AppError('not_found', 'Mapping not found');

      await auditRepo.writeAudit({
        organizationId: context.organizationId,
        actorUserId: context.userId,
        action: body.decision === 'verify' ? 'mapping.manually_verified' : 'mapping.rejected',
        resourceType: 'provider_entity_mapping',
        resourceId: mapping.id,
        requestId: request.requestId,
        metadata: {
          sourceExternalId: mapping.source_external_id,
          targetExternalId: mapping.target_external_id,
        },
      });

      return { mapping };
    },
  );

  server.get('/organizations/:organizationId/apps/:appId/data-quality', async (request, reply) => {
    const params = appParams.parse(request.params);
    const query = z
      .object({
        severity: z.enum(['info', 'warning', 'error']).optional(),
        limit: z.coerce.number().int().min(1).max(200).optional(),
      })
      .parse(request.query);
    const { context, app } = await withApp(
      request,
      params.organizationId,
      params.appId,
      'metrics:read',
    );
    setNoStore(reply);
    const findings = await dataQualityRepo.listDataQualityFindings(
      context.organizationId,
      app.id,
      query,
    );
    return { findings };
  });

  server.get('/organizations/:organizationId/apps/:appId/filters', async (request, reply) => {
    const params = appParams.parse(request.params);
    const { context, app } = await withApp(
      request,
      params.organizationId,
      params.appId,
      'metrics:read',
    );
    setNoStore(reply);
    const options = await loadFilterOptions(context.organizationId, app.id);
    return options;
  });

  /**
   * Command Center payload.
   *
   * One request assembles data health, core metrics, the trend, the campaign
   * table and reconciliation, so the dashboard renders a coherent snapshot
   * rather than five independently-timed views.
   */
  server.get(
    '/organizations/:organizationId/apps/:appId/command-center',
    async (request, reply) => {
      const params = appParams.parse(request.params);
      const query = filterQuery.parse(request.query);
      const { context, app } = await withApp(
        request,
        params.organizationId,
        params.appId,
        'metrics:read',
      );
      setNoStore(reply);

      const range = resolveRange(query);
      const { context: metricContext, state } = await buildMetricContext(
        context.organizationId,
        app,
      );
      const filters: MetricFilters = {
        organizationId: context.organizationId,
        appId: app.id,
        from: range.from,
        to: range.to,
        country: query.country ?? null,
        platform: query.platform ?? null,
        marketingProviderKey: state.marketingProviderKey,
        attributionProviderKey: state.attributionProviderKey,
        marketingAccountExternalId: query.marketingAccountExternalId ?? null,
      };

      const [marketing, attribution, freshness, runs, bindings, quality] = await Promise.all([
        loadMarketingAggregate(filters),
        loadAttributionAggregate(filters),
        syncRepo.listFreshness(context.organizationId, app.id),
        syncRepo.listSyncRuns(context.organizationId, { appId: app.id, limit: 5 }),
        integrationsRepo.listAppBindings(context.organizationId, app.id),
        dataQualityRepo.listDataQualityFindings(context.organizationId, app.id, { limit: 10 }),
      ]);

      const metrics = computeMetricValues({ context: metricContext, marketing, attribution });

      const [series, campaigns, coverage, discrepancies] = await Promise.all([
        loadTimeseries(filters),
        state.marketingProviderKey
          ? loadCampaignTable({ ...filters, limit: 25 })
          : Promise.resolve({ rows: [], total: 0 }),
        state.marketingProviderKey
          ? campaignCoverage(context.organizationId, app.id, state.marketingProviderKey)
          : Promise.resolve(null),
        state.marketingProviderKey && state.attributionProviderKey
          ? loadReconciliationDiscrepancies(filters, 10)
          : Promise.resolve([]),
      ]);

      const recentErrors = await syncRepo.listRecentSyncErrors(context.organizationId, {
        appId: app.id,
        limit: 5,
      });

      return {
        app,
        range,
        dataHealth: {
          integrations: bindings.map((b) => ({
            role: b.role,
            providerKey: b.provider_key,
            connectionStatus: b.connection_status,
            account: b.external_account_id,
            accountName: b.account_name,
          })),
          freshness,
          recentRuns: runs,
          recentErrors,
          mappingCoverage: coverage,
        },
        metrics,
        timeseries: series,
        campaigns,
        reconciliation: { coverage, discrepancies },
        dataQuality: quality,
        emptyStates: buildEmptyStates(state, {
          marketingRows: marketing.rows,
          attributionRows: attribution.rows,
          // "never synced" and "synced, but this range is genuinely empty" are
          // different facts about the world and must not read the same.
          marketingSynced: freshness.some(
            (row) =>
              row.provider_key === state.marketingProviderKey && row.last_success_at !== null,
          ),
          attributionSynced: freshness.some(
            (row) =>
              row.provider_key === state.attributionProviderKey && row.last_success_at !== null,
          ),
        }),
      };
    },
  );

  server.get('/organizations/:organizationId/audit', async (request, reply) => {
    const { organizationId } = z
      .object({ organizationId: z.string().uuid() })
      .parse(request.params);
    const query = z
      .object({
        resourceType: z.string().max(60).optional(),
        resourceId: z.string().max(120).optional(),
        limit: z.coerce.number().int().min(1).max(200).optional(),
      })
      .parse(request.query);
    const context = await withOrganization(request, organizationId, 'audit:read');
    setNoStore(reply);
    const entries = await auditRepo.listAudit(context.organizationId, query);
    return { entries };
  });
}

/**
 * Explicit empty states.
 *
 * An unconnected provider, a connected-but-never-synced provider and a genuine
 * zero must not look the same on screen.
 */
function buildEmptyStates(
  state: { marketingProviderKey: string | null; attributionProviderKey: string | null },
  observed: {
    marketingRows: number;
    attributionRows: number;
    marketingSynced: boolean;
    attributionSynced: boolean;
  },
): Array<{ key: string; title: string; message: string; action?: string }> {
  const out: Array<{ key: string; title: string; message: string; action?: string }> = [];
  if (!state.marketingProviderKey) {
    out.push({
      key: 'no_marketing_network',
      title: 'No marketing network connected',
      message: 'Connect a marketing network to import campaign delivery data.',
      action: 'connect_marketing_network',
    });
  }
  if (!state.attributionProviderKey) {
    out.push({
      key: 'no_attribution_provider',
      title: 'No attribution provider',
      message: "Choose this app's primary attribution provider on the integrations page.",
      action: 'choose_mmp',
    });
  }
  if (state.marketingProviderKey && observed.marketingRows === 0) {
    out.push(
      observed.marketingSynced
        ? {
            key: 'marketing_empty_range',
            title: 'No delivery data in this date range',
            message:
              'The marketing network has synced successfully, and it reported no delivery for the selected dates. Widen the range to see earlier data.',
            action: 'widen_range',
          }
        : {
            key: 'marketing_not_synced',
            title: 'Connection successful, no delivery data yet',
            message: 'Run the first data sync to import campaign delivery.',
            action: 'run_sync',
          },
    );
  }
  if (state.attributionProviderKey && observed.attributionRows === 0) {
    out.push(
      observed.attributionSynced
        ? {
            key: 'attribution_empty_range',
            title: 'No attribution data in this date range',
            message:
              'The attribution provider has synced successfully, and it reported no installs for the selected dates.',
            action: 'widen_range',
          }
        : {
            key: 'attribution_not_synced',
            title: 'Connection successful, no attribution data yet',
            message: 'Run the first data sync to import attributed installs.',
            action: 'run_sync',
          },
    );
  }
  return out;
}

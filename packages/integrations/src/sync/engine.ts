import type {
  CanonicalAttributionBatch,
  CanonicalMarketingBatch,
  IsoDate,
  ProviderErrorClass,
  SyncDataType,
  SyncRunStatus,
  SyncTrigger,
  StreamSupport,
} from '@mart/shared';
import {
  chunkDateRange,
  isProviderError,
  payloadHash,
  ProviderError,
  RETRYABLE_ERROR_CLASSES,
} from '@mart/shared';
import { getConfig } from '@mart/config';
import { counters, getLogger } from '@mart/observability';
import {
  dataQualityRepo,
  factsRepo,
  integrationsRepo,
  syncRepo,
  type FactScope,
  type SyncRunRow,
} from '@mart/db';
import { getCredentialStore } from '../credentials.js';
import { createProvider } from '../registry.js';
import { isAttributionProvider, isMarketingNetworkProvider, type RawPage } from '../types.js';
import { checkAttributionBatch, checkMarketingBatch, type QualityContext } from '../dataQuality.js';
import { computeFreshnessStatus } from './freshness.js';

export type SyncRequest = {
  organizationId: string;
  appId: string;
  connectionId: string;
  providerKey: string;
  providerCategory: string;
  dataType: SyncDataType;
  externalAccountId: string;
  from: IsoDate;
  to: IsoDate;
  timezone: string;
  currency: string;
  trigger: SyncTrigger;
  syncJobId?: string | null;
  requestId?: string | null;
  triggeredByUserId?: string | null;
};

export type SyncSummary = {
  syncRunId: string;
  status: SyncRunStatus;
  rowsFetched: number;
  rowsNormalized: number;
  rowsRejected: number;
  windowsCompleted: number;
  windowsFailed: number;
  warnings: string[];
  errorClass?: ProviderErrorClass;
  errorMessage?: string;
  latestDataDate: IsoDate | null;
};

/**
 * Execute one synchronization.
 *
 * Design properties that matter:
 *  - The window is chunked, and each chunk is checkpointed on success, so a
 *    failure late in a backfill never discards the chunks that succeeded.
 *  - Raw pages are persisted before normalization, so a normalization fix can
 *    be replayed without re-hitting the provider.
 *  - Facts are upserted on a dimension hash, so re-running a window updates in
 *    place instead of duplicating, and restatement is recorded rather than
 *    silently overwriting history.
 *  - A retryable failure stops the run (the scheduler will retry); a
 *    non-retryable failure on one chunk is recorded and the run continues, so
 *    one bad day does not block a month.
 */
export async function enqueueSync(request: SyncRequest): Promise<SyncRunRow> {
  return syncRepo.createSyncRun({
    organizationId: request.organizationId,
    appId: request.appId,
    connectionId: request.connectionId,
    syncJobId: request.syncJobId ?? null,
    providerKey: request.providerKey,
    dataType: request.dataType,
    trigger: request.trigger,
    windowStart: request.from,
    windowEnd: request.to,
    requestId: request.requestId ?? null,
    triggeredByUserId: request.triggeredByUserId ?? null,
  });
}

/** Enqueue and run in one step (used by the worker's scheduled path and tests). */
export async function executeSync(request: SyncRequest): Promise<SyncSummary> {
  const run = await enqueueSync(request);
  return runSync(run, request);
}

export async function runSync(run: SyncRunRow, request: SyncRequest): Promise<SyncSummary> {
  const config = getConfig();
  const log = getLogger().child({ provider: request.providerKey, dataType: request.dataType });

  await syncRepo.startSyncRun(run.id);
  await syncRepo.upsertFreshness({
    organizationId: request.organizationId,
    appId: request.appId,
    connectionId: request.connectionId,
    providerKey: request.providerKey,
    dataType: request.dataType,
    lastAttemptAt: new Date(),
    status: 'unknown',
  });

  const summary: SyncSummary = {
    syncRunId: run.id,
    status: 'running',
    rowsFetched: 0,
    rowsNormalized: 0,
    rowsRejected: 0,
    windowsCompleted: 0,
    windowsFailed: 0,
    warnings: [],
    latestDataDate: null,
  };

  const coveredWindows: Array<{ from: IsoDate; to: IsoDate }> = [];

  const scope: FactScope = {
    organizationId: request.organizationId,
    appId: request.appId,
    connectionId: request.connectionId,
    providerKey: request.providerKey,
    syncRunId: run.id,
  };

  let provider;
  try {
    const credentials = await getCredentialStore().get({
      organizationId: request.organizationId,
      connectionId: request.connectionId,
    });
    if (!credentials) {
      throw new ProviderError({
        provider: request.providerKey,
        errorClass: 'authentication_error',
        message: 'No stored credential for this connection',
        userMessage: 'This integration has no stored credential. Reconnect it to resume syncing.',
      });
    }
    provider = createProvider({ providerKey: request.providerKey, credentials });
  } catch (error) {
    return finishWithFailure(request, summary, error, log);
  }

  const chunks = chunkDateRange(request.from, request.to, config.SYNC_WINDOW_CHUNK_DAYS);
  const completed = new Set(run.checkpoint?.completedWindows ?? []);
  let fatal: unknown = null;
  let support: StreamSupport | null = null;

  for (const chunk of chunks) {
    const windowKey = `${chunk.from}..${chunk.to}`;
    if (completed.has(windowKey)) {
      summary.windowsCompleted += 1;
      continue;
    }

    try {
      const qualityCtx: QualityContext = {
        organizationId: request.organizationId,
        appId: request.appId,
        connectionId: request.connectionId,
        syncRunId: run.id,
        windowStart: chunk.from,
        windowEnd: chunk.to,
      };

      const onRawPage = async (page: RawPage): Promise<void> => {
        await factsRepo.recordRawBatch({
          scope,
          providerCategory: request.providerCategory,
          dataType: request.dataType,
          windowStart: page.windowStart ?? chunk.from,
          windowEnd: page.windowEnd ?? chunk.to,
          pageNumber: page.pageNumber,
          payloadHash: payloadHash(page.payload),
          schemaVersion: page.schemaVersion,
          recordCount: page.recordCount,
          payload: page.payload,
        });
      };

      const params = {
        externalAccountId: request.externalAccountId,
        from: chunk.from,
        to: chunk.to,
        timezone: request.timezone,
        currency: request.currency,
        onRawPage,
      };

      if (isMarketingNetworkProvider(provider)) {
        const result =
          request.dataType === 'marketing_structure'
            ? await provider.syncStructure(params)
            : await provider.syncPerformance(params);
        summary.rowsFetched += result.rowsFetched;
        summary.rowsRejected += result.rowsRejected;
        summary.warnings.push(...result.warnings);
        summary.latestDataDate = maxDate(summary.latestDataDate, result.latestDataDate);
        summary.rowsNormalized += await persistMarketing(scope, result.batch);
        await dataQualityRepo.recordDataQualityFindings(
          checkMarketingBatch(qualityCtx, result.batch),
        );
      } else if (isAttributionProvider(provider)) {
        // Refresh the MMP's campaign directory alongside installs. It carries
        // the ad network's own campaign id, which turns reconciliation from a
        // name comparison into an identifier match - so it must be current
        // before reconciliation runs.
        if (provider.listCampaigns && request.dataType === 'attribution_installs') {
          try {
            const directory = await provider.listCampaigns(request.externalAccountId);
            await factsRepo.upsertAttributionCampaigns(scope, directory);
          } catch (error) {
            // A directory MART could not refresh is a degraded match, not a
            // failed sync: the rows themselves are unaffected.
            summary.warnings.push(
              `Could not refresh the ${request.providerKey} campaign directory; reconciliation will fall back to names. ${
                isProviderError(error) ? error.userMessage : String(error)
              }`,
            );
          }
        }
        const result =
          request.dataType === 'attribution_events'
            ? await provider.syncEvents(params)
            : request.dataType === 'attribution_revenue'
              ? await provider.syncRevenue(params)
              : await provider.syncInstalls(params);
        summary.rowsFetched += result.rowsFetched;
        summary.rowsRejected += result.rowsRejected;
        summary.warnings.push(...result.warnings);
        summary.latestDataDate = maxDate(summary.latestDataDate, result.latestDataDate);
        summary.rowsNormalized += await persistAttribution(scope, result.batch);
        // Carried out of the loop so the freshness row can say "never fetched"
        // instead of "fresh" for a stream the adapter does not implement.
        if (result.support && result.support !== 'supported') support = result.support;
        await dataQualityRepo.recordDataQualityFindings(
          checkAttributionBatch(qualityCtx, result.batch),
        );
      } else {
        throw new ProviderError({
          provider: request.providerKey,
          errorClass: 'invalid_request',
          message: 'Provider does not support this data type',
        });
      }

      await syncRepo.checkpointWindow(run.id, windowKey);
      // Recorded only here, after the window's rows are persisted: an attempted
      // window is not evidence that anything loaded, and this list is what
      // later closes the earlier errors this run supersedes.
      coveredWindows.push({ from: chunk.from, to: chunk.to });
      summary.windowsCompleted += 1;
      counters.increment('sync_windows_completed_total', { provider: request.providerKey });
    } catch (error) {
      summary.windowsFailed += 1;
      counters.increment('sync_windows_failed_total', { provider: request.providerKey });
      const classified = classify(error, request.providerKey);
      await syncRepo.recordSyncError({
        organizationId: request.organizationId,
        syncRunId: run.id,
        errorClass: classified.errorClass,
        message: classified.message,
        userMessage: classified.userMessage,
        retryable: classified.retryable,
        windowStart: chunk.from,
        windowEnd: chunk.to,
        context: { window: windowKey, ...classified.context },
      });
      log.warn(
        { window: windowKey, errorClass: classified.errorClass, retryable: classified.retryable },
        'sync window failed',
      );
      // A retryable failure means the provider is unhappy right now: stop and
      // let the scheduler retry rather than hammering the remaining windows.
      //
      // A rejected credential stops the run for the opposite reason: nothing
      // is going to change between windows, every further request would fail
      // the same way and leave another error row, and the failure belongs on
      // the integration card - which reads the run's terminal failure, so a
      // credential rejection that only ever failed one window never got there.
      const credentialRejected =
        classified.errorClass === 'authentication_error' ||
        classified.errorClass === 'expired_credential';
      if (classified.retryable || credentialRejected) {
        fatal = error;
        break;
      }
    }
  }

  const status: SyncRunStatus =
    summary.windowsFailed > 0
      ? summary.windowsCompleted > 0
        ? 'partially_completed'
        : 'failed'
      : // A stream the adapter does not implement, or the provider does not
        // offer, made no request and moved no rows. Recording it as
        // 'completed' with zero rows reads as a successful sync of an empty
        // day, which is not what happened. Freshness keeps the two apart;
        // for the run, neither is an ingestion.
        support
        ? 'not_implemented'
        : 'completed';
  summary.status = status;

  const failure = fatal ? classify(fatal, request.providerKey) : null;
  if (failure) {
    summary.errorClass = failure.errorClass;
    summary.errorMessage = failure.userMessage;
  }

  await syncRepo.completeSyncRun(run.id, {
    status,
    rowsFetched: summary.rowsFetched,
    rowsNormalized: summary.rowsNormalized,
    rowsRejected: summary.rowsRejected,
    errorClass: failure?.errorClass ?? null,
    errorMessage: failure?.userMessage ?? null,
  });

  const succeeded = status !== 'failed';

  // An earlier failure this run has superseded should stop being presented as a
  // live problem. Only a run that actually read something can prove that, so a
  // stream the adapter does not implement - which made no request at all - is
  // excluded along with a run that failed outright.
  if (succeeded && !support && summary.windowsCompleted > 0) {
    const resolved = await syncRepo.resolveSupersededSyncErrors({
      organizationId: request.organizationId,
      appId: request.appId,
      connectionId: request.connectionId,
      dataType: request.dataType,
      syncRunId: run.id,
      coveredWindows,
      complete: summary.windowsFailed === 0,
    });
    if (resolved > 0) {
      log.info({ resolved, syncRunId: run.id }, 'resolved superseded sync errors');
    }
  }

  // Advance the incremental cursor only on success, and only as far as data we
  // actually stored: a failed window must not be skipped next time.
  if (succeeded && summary.latestDataDate) {
    await syncRepo.setCursor({
      organizationId: request.organizationId,
      appId: request.appId,
      connectionId: request.connectionId,
      dataType: request.dataType,
      cursorKey: 'last_synced_date',
      cursorValue: { date: summary.latestDataDate },
    });
  }

  await syncRepo.upsertFreshness({
    organizationId: request.organizationId,
    appId: request.appId,
    connectionId: request.connectionId,
    providerKey: request.providerKey,
    dataType: request.dataType,
    lastAttemptAt: new Date(),
    lastSuccessAt: succeeded ? new Date() : null,
    latestProviderDataDate: summary.latestDataDate,
    status: computeFreshnessStatus({
      lastSuccessAt: succeeded ? new Date() : null,
      latestProviderDataDate: summary.latestDataDate,
      expectedFreshnessMinutes: expectedFreshnessMinutes(request.dataType),
      hasError: !succeeded,
      ...(support ? { support } : {}),
    }),
    lastErrorClass: failure?.errorClass ?? null,
  });

  if (request.syncJobId) await syncRepo.setSyncJobStatus(request.syncJobId, status);

  // Connection health follows the run: an authentication failure should surface
  // on the integration card, not only in a sync log.
  if (
    failure &&
    (failure.errorClass === 'authentication_error' || failure.errorClass === 'expired_credential')
  ) {
    await integrationsRepo.updateConnectionStatus(request.connectionId, {
      status: 'invalid_credentials',
      lastValidationOk: false,
      lastValidationErrorClass: failure.errorClass,
      lastValidationMessage: failure.userMessage,
    });
  } else if (succeeded) {
    await integrationsRepo.updateConnectionStatus(request.connectionId, {
      status: 'connected',
      lastValidationOk: true,
      lastValidationErrorClass: null,
      lastValidationMessage: null,
    });
  }

  return summary;
}

async function persistMarketing(scope: FactScope, batch: CanonicalMarketingBatch): Promise<number> {
  if (batch.accounts.length) await factsRepo.upsertMarketingAccounts(scope, batch.accounts);
  if (batch.campaigns.length) await factsRepo.upsertCampaigns(scope, batch.campaigns);
  if (batch.adGroups.length) await factsRepo.upsertAdGroups(scope, batch.adGroups);
  if (batch.creatives.length) await factsRepo.upsertCreatives(scope, batch.creatives);
  if (batch.ads.length) await factsRepo.upsertAds(scope, batch.ads);
  if (batch.dailyMetrics.length) {
    const outcome = await factsRepo.upsertMarketingDailyMetrics(scope, batch.dailyMetrics);
    return outcome.inserted + outcome.restated + outcome.unchanged;
  }
  return batch.campaigns.length + batch.adGroups.length + batch.ads.length + batch.creatives.length;
}

async function persistAttribution(
  scope: FactScope,
  batch: CanonicalAttributionBatch,
): Promise<number> {
  let count = 0;
  const sources = batch.installs
    .map((i) => i.mediaSource)
    .filter((s): s is string => typeof s === 'string');
  if (sources.length) await factsRepo.upsertAttributionSources(scope, sources);
  if (batch.installs.length) {
    const outcome = await factsRepo.upsertAttributionInstalls(scope, batch.installs);
    count += outcome.inserted + outcome.restated + outcome.unchanged;
  }
  if (batch.events.length) {
    const outcome = await factsRepo.upsertAttributionEvents(scope, batch.events);
    count += outcome.inserted + outcome.restated + outcome.unchanged;
  }
  if (batch.revenue.length) {
    const outcome = await factsRepo.upsertAttributionRevenue(scope, batch.revenue);
    count += outcome.inserted + outcome.restated + outcome.unchanged;
  }
  return count;
}

type ClassifiedError = {
  errorClass: ProviderErrorClass;
  message: string;
  userMessage: string;
  retryable: boolean;
  /**
   * What the provider actually said, already sanitized and truncated by the
   * HTTP client. Without this a rejected query reached the database as
   * "meta_ads responded 400" and nothing more, and the diagnosis had to be
   * redone by hand against the live API.
   */
  context: Record<string, unknown>;
};

export function classify(error: unknown, providerKey: string): ClassifiedError {
  if (isProviderError(error)) {
    return {
      errorClass: error.errorClass,
      message: error.message,
      userMessage: error.userMessage,
      retryable: error.retryable || RETRYABLE_ERROR_CLASSES.includes(error.errorClass),
      context: {
        ...(error.httpStatus !== undefined ? { httpStatus: error.httpStatus } : {}),
        ...(error.context ?? {}),
      },
    };
  }
  const message = error instanceof Error ? error.message : 'Unknown failure';
  // A database failure during persistence is ours, not the provider's.
  const isDatabase = /database|relation|column|constraint|deadlock/i.test(message);
  return {
    errorClass: isDatabase ? 'database_error' : 'unknown_error',
    message,
    userMessage: isDatabase
      ? 'MART could not store the data it fetched. The run was stopped so nothing partial is trusted.'
      : `The ${providerKey} sync failed unexpectedly.`,
    retryable: isDatabase,
    context: {},
  };
}

async function finishWithFailure(
  request: SyncRequest,
  summary: SyncSummary,
  error: unknown,
  log: ReturnType<typeof getLogger>,
): Promise<SyncSummary> {
  const classified = classify(error, request.providerKey);
  await syncRepo.recordSyncError({
    organizationId: request.organizationId,
    syncRunId: summary.syncRunId,
    errorClass: classified.errorClass,
    message: classified.message,
    userMessage: classified.userMessage,
    retryable: classified.retryable,
    windowStart: request.from,
    windowEnd: request.to,
    context: classified.context,
  });
  await syncRepo.completeSyncRun(summary.syncRunId, {
    status: 'failed',
    rowsFetched: 0,
    rowsNormalized: 0,
    rowsRejected: 0,
    errorClass: classified.errorClass,
    errorMessage: classified.userMessage,
  });
  await syncRepo.upsertFreshness({
    organizationId: request.organizationId,
    appId: request.appId,
    connectionId: request.connectionId,
    providerKey: request.providerKey,
    dataType: request.dataType,
    lastAttemptAt: new Date(),
    status: 'error',
    lastErrorClass: classified.errorClass,
  });
  log.error({ errorClass: classified.errorClass }, 'sync failed before any window ran');
  return {
    ...summary,
    status: 'failed',
    errorClass: classified.errorClass,
    errorMessage: classified.userMessage,
  };
}

function maxDate(a: IsoDate | null, b: IsoDate | null): IsoDate | null {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

/** Providers differ in how quickly data becomes available. */
export function expectedFreshnessMinutes(dataType: SyncDataType): number {
  switch (dataType) {
    case 'marketing_performance':
      return 180;
    case 'marketing_structure':
      return 720;
    case 'attribution_installs':
      return 240;
    case 'attribution_events':
    case 'attribution_revenue':
      return 480;
    default:
      return 360;
  }
}

import type { IsoDate, SyncDataType, SyncTrigger } from '@mart/shared';
import { addDays, AppError, toIsoDate } from '@mart/shared';
import { getConfig } from '@mart/config';
import { integrationsRepo, syncRepo, tenancyRepo, type BindingWithConnection } from '@mart/db';
import type { SyncRequest } from './engine.js';

export type PlanOptions = {
  organizationId: string;
  appId: string;
  trigger: SyncTrigger;
  /** Explicit window; otherwise derived from lookback or backfill defaults. */
  from?: IsoDate;
  to?: IsoDate;
  /** Restrict to one connection (e.g. "Sync now" on a single integration card). */
  connectionId?: string;
  dataTypes?: SyncDataType[];
  requestId?: string | null;
  triggeredByUserId?: string | null;
  /** First sync for a connection pulls history rather than the recent window. */
  backfill?: boolean;
  now?: Date;
};

const MARKETING_DATA_TYPES: SyncDataType[] = ['marketing_structure', 'marketing_performance'];
const ATTRIBUTION_DATA_TYPES: SyncDataType[] = [
  'attribution_installs',
  'attribution_events',
  'attribution_revenue',
];

/**
 * Turn an app's active integration bindings into concrete sync requests.
 *
 * The planner is where "what should we sync" lives, so the engine only has to
 * answer "how". It is also where the restatement lookback is applied: MART
 * always re-reads recent days because providers revise them.
 */
export async function planSyncs(options: PlanOptions): Promise<SyncRequest[]> {
  const config = getConfig();
  const now = options.now ?? new Date();

  const app = await tenancyRepo.findApp(options.organizationId, options.appId);
  if (!app) throw new AppError('not_found', 'App not found');

  const bindings = await integrationsRepo.listAppBindings(options.organizationId, options.appId);
  const selected = options.connectionId
    ? bindings.filter((b) => b.connection_id === options.connectionId)
    : bindings;

  const requests: SyncRequest[] = [];
  for (const binding of selected) {
    if (binding.connection_status === 'disconnected') continue;
    if (!binding.external_account_id) continue;

    const dataTypes = resolveDataTypes(binding, options.dataTypes);
    for (const dataType of dataTypes) {
      const window = await resolveWindow({
        dataType,
        binding,
        appId: options.appId,
        explicitFrom: options.from,
        explicitTo: options.to,
        backfill: options.backfill ?? false,
        lookbackDays: config.SYNC_RESTATEMENT_LOOKBACK_DAYS,
        backfillDays: config.SYNC_DEFAULT_BACKFILL_DAYS,
        now,
      });

      requests.push({
        organizationId: options.organizationId,
        appId: options.appId,
        connectionId: binding.connection_id,
        providerKey: binding.provider_key,
        providerCategory: binding.category,
        dataType,
        externalAccountId: binding.external_account_id,
        from: window.from,
        to: window.to,
        timezone: app.timezone,
        currency: binding.account_currency ?? app.default_currency,
        trigger: options.trigger,
        requestId: options.requestId ?? null,
        triggeredByUserId: options.triggeredByUserId ?? null,
      });
    }
  }

  return requests;
}

function resolveDataTypes(
  binding: BindingWithConnection,
  requested: SyncDataType[] | undefined,
): SyncDataType[] {
  const supported =
    binding.role === 'marketing_network' ? MARKETING_DATA_TYPES : ATTRIBUTION_DATA_TYPES;
  if (!requested) return supported;
  return supported.filter((t) => requested.includes(t));
}

async function resolveWindow(input: {
  dataType: SyncDataType;
  binding: BindingWithConnection;
  appId: string;
  explicitFrom?: IsoDate;
  explicitTo?: IsoDate;
  backfill: boolean;
  lookbackDays: number;
  backfillDays: number;
  now: Date;
}): Promise<{ from: IsoDate; to: IsoDate }> {
  const to = input.explicitTo ?? toIsoDate(input.now);
  if (input.explicitFrom) return { from: input.explicitFrom, to };
  if (input.backfill) return { from: addDays(to, -(input.backfillDays - 1)), to };

  // Structure has no date dimension; a single recent window is enough.
  if (input.dataType === 'marketing_structure') return { from: to, to };

  const cursor = await syncRepo.getCursor(
    input.binding.connection_id,
    input.appId,
    input.dataType,
    'last_synced_date',
  );
  const lastSynced = typeof cursor?.['date'] === 'string' ? (cursor['date'] as IsoDate) : null;
  if (!lastSynced) return { from: addDays(to, -(input.backfillDays - 1)), to };

  // Always re-read the restatement window, never just "since last time".
  const from = addDays(lastSynced, -input.lookbackDays);
  return { from: from < to ? from : to, to };
}

/** Record how far a stream has advanced, for the next incremental window. */
export async function advanceCursor(
  request: SyncRequest,
  latestDate: IsoDate | null,
): Promise<void> {
  if (!latestDate) return;
  await syncRepo.setCursor({
    organizationId: request.organizationId,
    appId: request.appId,
    connectionId: request.connectionId,
    dataType: request.dataType,
    cursorKey: 'last_synced_date',
    cursorValue: { date: latestDate },
  });
}

/** Ensure recurring jobs exist for an app's active bindings. */
export async function ensureSyncJobs(organizationId: string, appId: string): Promise<void> {
  const bindings = await integrationsRepo.listAppBindings(organizationId, appId);
  for (const binding of bindings) {
    if (!binding.external_account_id) continue;
    const dataTypes = resolveDataTypes(binding, undefined);
    for (const dataType of dataTypes) {
      await syncRepo.upsertSyncJob({
        organizationId,
        appId,
        connectionId: binding.connection_id,
        dataType,
        scheduleIntervalMinutes: dataType === 'marketing_structure' ? 720 : 360,
        lookbackDays: getConfig().SYNC_RESTATEMENT_LOOKBACK_DAYS,
      });
    }
  }
}

/**
 * Rebuild the full sync request for a queued run.
 *
 * A run row records what to sync; the account, timezone and currency come from
 * the binding and the app, so a queued run always executes against the current
 * configuration rather than a stale snapshot.
 */
export async function hydrateRequest(run: {
  id: string;
  organization_id: string;
  app_id: string;
  connection_id: string;
  provider_key: string;
  data_type: SyncDataType;
  trigger: SyncTrigger;
  window_start: string;
  window_end: string;
  sync_job_id: string | null;
  request_id: string | null;
}): Promise<SyncRequest | null> {
  const app = await tenancyRepo.findApp(run.organization_id, run.app_id);
  if (!app) return null;
  const bindings = await integrationsRepo.listAppBindings(run.organization_id, run.app_id);
  const binding = bindings.find((b) => b.connection_id === run.connection_id);
  if (!binding?.external_account_id) return null;

  return {
    organizationId: run.organization_id,
    appId: run.app_id,
    connectionId: run.connection_id,
    providerKey: run.provider_key,
    providerCategory: binding.category,
    dataType: run.data_type,
    externalAccountId: binding.external_account_id,
    from: run.window_start as IsoDate,
    to: run.window_end as IsoDate,
    timezone: app.timezone,
    currency: binding.account_currency ?? app.default_currency,
    trigger: run.trigger,
    syncJobId: run.sync_job_id,
    requestId: run.request_id,
  };
}

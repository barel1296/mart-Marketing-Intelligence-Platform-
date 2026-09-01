import type {
  FreshnessStatus,
  IsoDate,
  ProviderErrorClass,
  SyncDataType,
  SyncRunStatus,
  SyncTrigger,
} from '@mart/shared';
import { AppError } from '@mart/shared';
import { query, queryOne, queryRows, toNumber, type Queryable } from '../pool.js';

// ------------------------------------------------------------- sync jobs ----
export type SyncJobRow = {
  id: string;
  organization_id: string;
  app_id: string;
  connection_id: string;
  data_type: SyncDataType;
  enabled: boolean;
  schedule_interval_minutes: number;
  lookback_days: number;
  next_run_at: Date;
  last_run_at: Date | null;
  last_status: string | null;
};

const JOB_COLUMNS = `id, organization_id, app_id, connection_id, data_type, enabled,
  schedule_interval_minutes, lookback_days, next_run_at, last_run_at, last_status`;

export async function upsertSyncJob(
  input: {
    organizationId: string;
    appId: string;
    connectionId: string;
    dataType: SyncDataType;
    scheduleIntervalMinutes?: number;
    lookbackDays?: number;
    enabled?: boolean;
  },
  client?: Queryable,
): Promise<SyncJobRow> {
  const row = await queryOne<SyncJobRow>(
    `INSERT INTO sync_jobs
       (organization_id, app_id, connection_id, data_type, schedule_interval_minutes, lookback_days, enabled)
     VALUES ($1, $2, $3, $4, COALESCE($5, 360), COALESCE($6, 7), COALESCE($7, true))
     ON CONFLICT (connection_id, app_id, data_type) DO UPDATE SET
       schedule_interval_minutes = COALESCE($5, sync_jobs.schedule_interval_minutes),
       lookback_days = COALESCE($6, sync_jobs.lookback_days),
       enabled = COALESCE($7, sync_jobs.enabled)
     RETURNING ${JOB_COLUMNS}`,
    [
      input.organizationId,
      input.appId,
      input.connectionId,
      input.dataType,
      input.scheduleIntervalMinutes ?? null,
      input.lookbackDays ?? null,
      input.enabled ?? null,
    ],
    client,
  );
  if (!row) throw new AppError('internal_error', 'Failed to upsert sync job');
  return row;
}

export async function listSyncJobs(
  organizationId: string,
  appId: string,
  client?: Queryable,
): Promise<SyncJobRow[]> {
  return queryRows<SyncJobRow>(
    `SELECT ${JOB_COLUMNS} FROM sync_jobs
     WHERE organization_id = $1 AND app_id = $2 ORDER BY data_type`,
    [organizationId, appId],
    client,
  );
}

/**
 * Claim due jobs for execution.
 *
 * FOR UPDATE SKIP LOCKED plus an immediate next_run_at advance means multiple
 * worker replicas can poll the same table without ever running one job twice.
 */
export async function claimDueSyncJobs(limit: number, client?: Queryable): Promise<SyncJobRow[]> {
  return queryRows<SyncJobRow>(
    `WITH due AS (
       SELECT id FROM sync_jobs
       WHERE enabled AND next_run_at <= now()
       ORDER BY next_run_at
       FOR UPDATE SKIP LOCKED
       LIMIT $1
     )
     UPDATE sync_jobs j
     SET next_run_at = now() + make_interval(mins => j.schedule_interval_minutes),
         last_run_at = now()
     FROM due
     WHERE j.id = due.id
     RETURNING ${JOB_COLUMNS.split(', ')
       .map((c) => `j.${c.trim()}`)
       .join(', ')}`,
    [limit],
    client,
  );
}

export async function setSyncJobStatus(
  jobId: string,
  status: SyncRunStatus,
  client?: Queryable,
): Promise<void> {
  await query('UPDATE sync_jobs SET last_status = $2 WHERE id = $1', [jobId, status], client);
}

// ------------------------------------------------------------- sync runs ----
export type SyncRunRow = {
  id: string;
  organization_id: string;
  app_id: string;
  connection_id: string;
  sync_job_id: string | null;
  provider_key: string;
  data_type: SyncDataType;
  trigger: SyncTrigger;
  status: SyncRunStatus;
  window_start: string;
  window_end: string;
  attempt: number;
  started_at: Date | null;
  finished_at: Date | null;
  rows_fetched: string | number;
  rows_normalized: string | number;
  rows_rejected: string | number;
  request_id: string | null;
  error_class: string | null;
  error_message: string | null;
  checkpoint: { completedWindows?: string[] };
  /** Earliest time this run may be claimed; moved forward by retry backoff. */
  not_before: Date;
  created_at: Date;
};

const RUN_COLUMNS = `id, organization_id, app_id, connection_id, sync_job_id, provider_key,
  data_type, trigger, status, window_start, window_end, attempt, started_at, finished_at,
  rows_fetched, rows_normalized, rows_rejected, request_id, error_class, error_message,
  checkpoint, not_before, created_at`;

export async function createSyncRun(
  input: {
    organizationId: string;
    appId: string;
    connectionId: string;
    syncJobId?: string | null;
    providerKey: string;
    dataType: SyncDataType;
    trigger: SyncTrigger;
    windowStart: IsoDate;
    windowEnd: IsoDate;
    requestId?: string | null;
    triggeredByUserId?: string | null;
    attempt?: number;
  },
  client?: Queryable,
): Promise<SyncRunRow> {
  const row = await queryOne<SyncRunRow>(
    `INSERT INTO sync_runs
       (organization_id, app_id, connection_id, sync_job_id, provider_key, data_type, trigger,
        window_start, window_end, request_id, triggered_by_user_id, attempt, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, COALESCE($12,1), 'queued')
     RETURNING ${RUN_COLUMNS}`,
    [
      input.organizationId,
      input.appId,
      input.connectionId,
      input.syncJobId ?? null,
      input.providerKey,
      input.dataType,
      input.trigger,
      input.windowStart,
      input.windowEnd,
      input.requestId ?? null,
      input.triggeredByUserId ?? null,
      input.attempt ?? null,
    ],
    client,
  );
  if (!row) throw new AppError('internal_error', 'Failed to create sync run');
  return row;
}

export async function startSyncRun(runId: string, client?: Queryable): Promise<void> {
  await query(
    "UPDATE sync_runs SET status = 'running', started_at = now() WHERE id = $1",
    [runId],
    client,
  );
}

export async function completeSyncRun(
  runId: string,
  result: {
    status: SyncRunStatus;
    rowsFetched: number;
    rowsNormalized: number;
    rowsRejected: number;
    errorClass?: ProviderErrorClass | null;
    errorMessage?: string | null;
    checkpoint?: Record<string, unknown>;
  },
  client?: Queryable,
): Promise<void> {
  await query(
    `UPDATE sync_runs
     SET status = $2, finished_at = now(), rows_fetched = $3, rows_normalized = $4,
         rows_rejected = $5, error_class = $6, error_message = $7,
         checkpoint = COALESCE($8, checkpoint)
     WHERE id = $1`,
    [
      runId,
      result.status,
      result.rowsFetched,
      result.rowsNormalized,
      result.rowsRejected,
      result.errorClass ?? null,
      result.errorMessage ?? null,
      result.checkpoint ? JSON.stringify(result.checkpoint) : null,
    ],
    client,
  );
}

/** Record a completed window so a retry resumes instead of restarting. */
export async function checkpointWindow(
  runId: string,
  windowKey: string,
  client?: Queryable,
): Promise<void> {
  await query(
    `UPDATE sync_runs
     SET checkpoint = jsonb_set(
           COALESCE(checkpoint, '{}'::jsonb),
           '{completedWindows}',
           COALESCE(checkpoint->'completedWindows', '[]'::jsonb) || to_jsonb($2::text),
           true)
     WHERE id = $1`,
    [runId, windowKey],
    client,
  );
}

export async function findSyncRun(
  organizationId: string,
  runId: string,
  client?: Queryable,
): Promise<SyncRunRow | null> {
  return queryOne<SyncRunRow>(
    `SELECT ${RUN_COLUMNS} FROM sync_runs WHERE organization_id = $1 AND id = $2`,
    [organizationId, runId],
    client,
  );
}

export async function listSyncRuns(
  organizationId: string,
  filter: { appId?: string; connectionId?: string; limit?: number },
  client?: Queryable,
): Promise<SyncRunRow[]> {
  const params: unknown[] = [organizationId];
  let sql = `SELECT ${RUN_COLUMNS} FROM sync_runs WHERE organization_id = $1`;
  if (filter.appId) {
    params.push(filter.appId);
    sql += ` AND app_id = $${params.length}`;
  }
  if (filter.connectionId) {
    params.push(filter.connectionId);
    sql += ` AND connection_id = $${params.length}`;
  }
  params.push(Math.min(filter.limit ?? 25, 200));
  sql += ` ORDER BY created_at DESC LIMIT $${params.length}`;
  return queryRows<SyncRunRow>(sql, params, client);
}

/** True when a run for this exact scope is already queued or running. */
export async function hasActiveRun(
  connectionId: string,
  appId: string,
  dataType: SyncDataType,
  client?: Queryable,
): Promise<boolean> {
  const row = await queryOne<{ count: string }>(
    `SELECT count(*)::text AS count FROM sync_runs
     WHERE connection_id = $1 AND app_id = $2 AND data_type = $3
       AND status IN ('queued', 'running')`,
    [connectionId, appId, dataType],
    client,
  );
  return toNumber(row?.count) > 0;
}

// ----------------------------------------------------------- sync errors ----
export async function recordSyncError(
  input: {
    organizationId: string;
    syncRunId: string;
    errorClass: ProviderErrorClass;
    message: string;
    userMessage?: string | null;
    retryable: boolean;
    windowStart?: IsoDate | null;
    windowEnd?: IsoDate | null;
    context?: Record<string, unknown>;
  },
  client?: Queryable,
): Promise<void> {
  await query(
    `INSERT INTO sync_errors
       (organization_id, sync_run_id, error_class, message, user_message, retryable, window_start, window_end, context)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      input.organizationId,
      input.syncRunId,
      input.errorClass,
      input.message.slice(0, 2000),
      input.userMessage ?? null,
      input.retryable,
      input.windowStart ?? null,
      input.windowEnd ?? null,
      JSON.stringify(input.context ?? {}),
    ],
    client,
  );
}

export type SyncErrorRow = {
  id: string;
  sync_run_id: string;
  occurred_at: Date;
  error_class: ProviderErrorClass;
  message: string;
  user_message: string | null;
  retryable: boolean;
  window_start: string | null;
  window_end: string | null;
  resolved_at: string | null;
  resolved_by_sync_run_id: string | null;
};

export async function listRecentSyncErrors(
  organizationId: string,
  filter: { appId?: string; limit?: number; resolved?: boolean },
  client?: Queryable,
): Promise<SyncErrorRow[]> {
  const params: unknown[] = [organizationId];
  let sql = `SELECT e.id, e.sync_run_id, e.occurred_at, e.error_class, e.message, e.user_message,
                    e.retryable, e.window_start, e.window_end,
                    e.resolved_at, e.resolved_by_sync_run_id
             FROM sync_errors e`;
  if (filter.appId) {
    sql += ' JOIN sync_runs r ON r.id = e.sync_run_id';
  }
  sql += ' WHERE e.organization_id = $1';
  if (filter.appId) {
    params.push(filter.appId);
    sql += ` AND r.app_id = $${params.length}`;
  }
  // An error that a later successful run superseded is history, not a current
  // problem. It is kept, and told apart.
  if (filter.resolved === true) sql += ' AND e.resolved_at IS NOT NULL';
  if (filter.resolved === false) sql += ' AND e.resolved_at IS NULL';
  params.push(Math.min(filter.limit ?? 20, 100));
  sql += ` ORDER BY e.occurred_at DESC LIMIT $${params.length}`;
  return queryRows<SyncErrorRow>(sql, params, client);
}

/**
 * Close the earlier errors a successful run has actually superseded.
 *
 * Called when a run finishes having read something. A failure recorded at
 * 09:43 and a clean re-read of the same window at 10:21 describe one incident
 * that is over, but the row stays open until something says so - and an open
 * error is what the operator, the integrations card and the Phase 0 audit all
 * read as "this stream is broken right now".
 *
 * Resolution is proof-based, never a blanket clear. The scope is one stream -
 * organization, app, connection and data type - and within it an error is
 * closed only where this run demonstrably covered the ground the error was
 * recorded on:
 *
 *  - A **windowed error** needs a window this run actually completed. For a
 *    retryable failure - a timeout, a throttle, a provider outage - any
 *    completed window containing it is proof: the same dates were re-read and
 *    they loaded. For a non-retryable one - a rejected request, a credential or
 *    configuration problem - only the same window exactly counts, because that
 *    class of error is a statement about a specific request rather than about
 *    the provider's mood, and the narrower rule is the honest one.
 *  - A **stream-level error carrying no window** cannot be matched to any
 *    range, so it is closed only by a run that completed every window it
 *    planned. A partial run proves the stream is reachable, not that whatever
 *    failed has stopped failing.
 *
 * Everything else stays open, including errors on another provider, another
 * stream, or a window nothing has re-read since. History is never deleted: the
 * row stays exactly as recorded, with the run that superseded it named, so a
 * fixed problem stops being presented as a current one without the evidence
 * disappearing.
 */
export async function resolveSupersededSyncErrors(
  input: {
    organizationId: string;
    appId: string;
    connectionId: string;
    dataType: SyncDataType;
    /** The run offering the proof. Its own errors are never self-resolved. */
    syncRunId: string;
    /** Windows this run actually completed. An attempted window is not proof. */
    coveredWindows: ReadonlyArray<{ from: IsoDate; to: IsoDate }>;
    /**
     * Whether the run completed every window it planned. Only a run with
     * nothing left failing can close an error that names no window.
     */
    complete: boolean;
  },
  client?: Queryable,
): Promise<number> {
  if (input.coveredWindows.length === 0 && !input.complete) return 0;
  const froms = input.coveredWindows.map((w) => w.from);
  const tos = input.coveredWindows.map((w) => w.to);

  const rows = await queryRows<{ id: string }>(
    `UPDATE sync_errors e
        SET resolved_at = now(), resolved_by_sync_run_id = $5
       FROM sync_runs r
      WHERE e.sync_run_id = r.id
        AND e.organization_id = $1
        AND r.app_id = $2
        AND r.connection_id = $3
        AND r.data_type = $4
        AND e.resolved_at IS NULL
        AND e.sync_run_id <> $5
        AND (
          (e.window_start IS NOT NULL AND e.window_end IS NOT NULL
           AND EXISTS (
             SELECT 1 FROM unnest($6::date[], $7::date[]) AS w(covered_from, covered_to)
              WHERE CASE WHEN e.retryable
                         THEN w.covered_from <= e.window_start
                          AND w.covered_to >= e.window_end
                         ELSE w.covered_from = e.window_start
                          AND w.covered_to = e.window_end
                    END
           ))
          OR (e.window_start IS NULL AND e.window_end IS NULL AND $8::boolean)
        )
      RETURNING e.id`,
    [
      input.organizationId,
      input.appId,
      input.connectionId,
      input.dataType,
      input.syncRunId,
      froms,
      tos,
      input.complete,
    ],
    client,
  );
  return rows.length;
}

// ---------------------------------------------------------- sync cursors ----
export async function setCursor(
  input: {
    organizationId: string;
    appId: string;
    connectionId: string;
    dataType: SyncDataType;
    cursorKey: string;
    cursorValue: Record<string, unknown>;
  },
  client?: Queryable,
): Promise<void> {
  await query(
    `INSERT INTO sync_cursors (organization_id, app_id, connection_id, data_type, cursor_key, cursor_value)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (connection_id, app_id, data_type, cursor_key)
     DO UPDATE SET cursor_value = EXCLUDED.cursor_value`,
    [
      input.organizationId,
      input.appId,
      input.connectionId,
      input.dataType,
      input.cursorKey,
      JSON.stringify(input.cursorValue),
    ],
    client,
  );
}

export async function getCursor(
  connectionId: string,
  appId: string,
  dataType: SyncDataType,
  cursorKey: string,
  client?: Queryable,
): Promise<Record<string, unknown> | null> {
  const row = await queryOne<{ cursor_value: Record<string, unknown> }>(
    `SELECT cursor_value FROM sync_cursors
     WHERE connection_id = $1 AND app_id = $2 AND data_type = $3 AND cursor_key = $4`,
    [connectionId, appId, dataType, cursorKey],
    client,
  );
  return row?.cursor_value ?? null;
}

// -------------------------------------------------------- data freshness ----
export type FreshnessRow = {
  id: string;
  app_id: string;
  connection_id: string;
  provider_key: string;
  data_type: SyncDataType;
  last_attempt_at: Date | null;
  last_success_at: Date | null;
  latest_provider_data_date: string | null;
  expected_freshness_minutes: number;
  status: FreshnessStatus;
  last_error_class: string | null;
  updated_at: Date;
};

const FRESHNESS_COLUMNS = `id, app_id, connection_id, provider_key, data_type, last_attempt_at,
  last_success_at, latest_provider_data_date, expected_freshness_minutes, status, last_error_class, updated_at`;

export async function upsertFreshness(
  input: {
    organizationId: string;
    appId: string;
    connectionId: string;
    providerKey: string;
    dataType: SyncDataType;
    lastAttemptAt?: Date | null;
    lastSuccessAt?: Date | null;
    latestProviderDataDate?: IsoDate | null;
    expectedFreshnessMinutes?: number;
    status: FreshnessStatus;
    lastErrorClass?: string | null;
  },
  client?: Queryable,
): Promise<void> {
  await query(
    `INSERT INTO data_freshness
       (organization_id, app_id, connection_id, provider_key, data_type, last_attempt_at,
        last_success_at, latest_provider_data_date, latest_provider_data_at,
        expected_freshness_minutes, status, last_error_class)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8, CASE WHEN $8::date IS NULL THEN NULL ELSE now() END,
             COALESCE($9, 360), $10, $11)
     ON CONFLICT (connection_id, app_id, data_type) DO UPDATE SET
       last_attempt_at = COALESCE(EXCLUDED.last_attempt_at, data_freshness.last_attempt_at),
       last_success_at = COALESCE(EXCLUDED.last_success_at, data_freshness.last_success_at),
       latest_provider_data_date = GREATEST(
         COALESCE(EXCLUDED.latest_provider_data_date, data_freshness.latest_provider_data_date),
         COALESCE(data_freshness.latest_provider_data_date, EXCLUDED.latest_provider_data_date)),
       latest_provider_data_at = COALESCE(EXCLUDED.latest_provider_data_at, data_freshness.latest_provider_data_at),
       expected_freshness_minutes = EXCLUDED.expected_freshness_minutes,
       status = EXCLUDED.status,
       last_error_class = EXCLUDED.last_error_class`,
    [
      input.organizationId,
      input.appId,
      input.connectionId,
      input.providerKey,
      input.dataType,
      input.lastAttemptAt ?? null,
      input.lastSuccessAt ?? null,
      input.latestProviderDataDate ?? null,
      input.expectedFreshnessMinutes ?? null,
      input.status,
      input.lastErrorClass ?? null,
    ],
    client,
  );
}

export async function listFreshness(
  organizationId: string,
  appId: string,
  client?: Queryable,
): Promise<FreshnessRow[]> {
  return queryRows<FreshnessRow>(
    `SELECT ${FRESHNESS_COLUMNS} FROM data_freshness
     WHERE organization_id = $1 AND app_id = $2
     ORDER BY provider_key, data_type`,
    [organizationId, appId],
    client,
  );
}

/**
 * Claim queued runs for execution.
 *
 * Manual triggers enqueue a run from the API; the worker claims it here. SKIP
 * LOCKED means several worker replicas can poll the same table safely.
 */
export async function claimQueuedRuns(limit: number, client?: Queryable): Promise<SyncRunRow[]> {
  return queryRows<SyncRunRow>(
    `WITH claimed AS (
       SELECT id FROM sync_runs
       WHERE status = 'queued' AND not_before <= now()
       ORDER BY not_before, created_at
       FOR UPDATE SKIP LOCKED
       LIMIT $1
     )
     UPDATE sync_runs r
     SET status = 'running', started_at = now()
     FROM claimed
     WHERE r.id = claimed.id
     RETURNING r.id, r.organization_id, r.app_id, r.connection_id, r.sync_job_id, r.provider_key,
               r.data_type, r.trigger, r.status, r.window_start, r.window_end, r.attempt,
               r.started_at, r.finished_at, r.rows_fetched, r.rows_normalized, r.rows_rejected,
               r.request_id, r.error_class, r.error_message, r.checkpoint, r.not_before,
               r.created_at`,
    [limit],
    client,
  );
}

/** Requeue a failed run for another attempt, bounded by maxAttempts. */
export async function requeueRun(
  runId: string,
  maxAttempts: number,
  delayMs = 0,
  client?: Queryable,
): Promise<boolean> {
  // The wait is stored on the row rather than held in the worker process, so a
  // restart cannot turn a backoff into an immediate retry.
  const row = await queryOne<{ id: string }>(
    `UPDATE sync_runs
     SET status = 'queued', attempt = attempt + 1, started_at = NULL, finished_at = NULL,
         not_before = now() + make_interval(secs => $3::double precision / 1000)
     WHERE id = $1 AND attempt < $2
     RETURNING id`,
    [runId, maxAttempts, Math.max(0, Math.round(delayMs))],
    client,
  );
  return row !== null;
}

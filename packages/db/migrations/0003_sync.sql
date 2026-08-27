-- MART 0003: sync engine state.
--
-- sync_jobs  : the recurring definition (what to sync, how often, how far back)
-- sync_runs  : one execution attempt, with its window and outcome
-- sync_cursors: resumable pagination/window state per (connection, app, type)
-- sync_errors: every failure, classified, with the window it applies to
-- data_freshness: derived per-stream freshness surfaced on the dashboard

CREATE TABLE sync_jobs (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id           uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  app_id                    uuid NOT NULL REFERENCES apps (id) ON DELETE CASCADE,
  connection_id             uuid NOT NULL REFERENCES integration_connections (id) ON DELETE CASCADE,
  data_type                 text NOT NULL CHECK (data_type IN (
                              'marketing_structure', 'marketing_performance',
                              'attribution_installs', 'attribution_events', 'attribution_revenue')),
  enabled                   boolean NOT NULL DEFAULT true,
  schedule_interval_minutes integer NOT NULL DEFAULT 360 CHECK (schedule_interval_minutes >= 5),
  -- Recent days are always re-synchronized: provider numbers are restated.
  lookback_days             integer NOT NULL DEFAULT 7 CHECK (lookback_days >= 0),
  next_run_at               timestamptz NOT NULL DEFAULT now(),
  last_run_at               timestamptz,
  last_status               text,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX sync_jobs_scope_key ON sync_jobs (connection_id, app_id, data_type);
CREATE INDEX sync_jobs_due_idx ON sync_jobs (next_run_at) WHERE enabled;
CREATE TRIGGER sync_jobs_set_updated_at BEFORE UPDATE ON sync_jobs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE sync_runs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  app_id            uuid NOT NULL REFERENCES apps (id) ON DELETE CASCADE,
  connection_id     uuid NOT NULL REFERENCES integration_connections (id) ON DELETE CASCADE,
  sync_job_id       uuid REFERENCES sync_jobs (id) ON DELETE SET NULL,
  provider_key      text NOT NULL,
  data_type         text NOT NULL,
  trigger           text NOT NULL CHECK (trigger IN ('manual', 'scheduled', 'backfill', 'retry')),
  status            text NOT NULL DEFAULT 'queued' CHECK (status IN (
                      'queued', 'running', 'partially_completed', 'completed', 'failed', 'cancelled')),
  window_start      date NOT NULL,
  window_end        date NOT NULL,
  attempt           integer NOT NULL DEFAULT 1,
  started_at        timestamptz,
  finished_at       timestamptz,
  rows_fetched      bigint NOT NULL DEFAULT 0,
  rows_normalized   bigint NOT NULL DEFAULT 0,
  rows_rejected     bigint NOT NULL DEFAULT 0,
  request_id        text,
  error_class       text,
  error_message     text,
  -- Windows already completed inside this run; a retry resumes from here.
  checkpoint        jsonb NOT NULL DEFAULT '{}'::jsonb,
  triggered_by_user_id uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sync_runs_window_order CHECK (window_end >= window_start)
);
CREATE INDEX sync_runs_scope_idx ON sync_runs (organization_id, app_id, data_type, created_at DESC);
CREATE INDEX sync_runs_connection_idx ON sync_runs (connection_id, created_at DESC);
CREATE INDEX sync_runs_status_idx ON sync_runs (status) WHERE status IN ('queued', 'running');
CREATE TRIGGER sync_runs_set_updated_at BEFORE UPDATE ON sync_runs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE sync_cursors (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  app_id           uuid NOT NULL REFERENCES apps (id) ON DELETE CASCADE,
  connection_id    uuid NOT NULL REFERENCES integration_connections (id) ON DELETE CASCADE,
  data_type        text NOT NULL,
  cursor_key       text NOT NULL,
  cursor_value     jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX sync_cursors_scope_key
  ON sync_cursors (connection_id, app_id, data_type, cursor_key);
CREATE TRIGGER sync_cursors_set_updated_at BEFORE UPDATE ON sync_cursors
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE sync_errors (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  sync_run_id      uuid NOT NULL REFERENCES sync_runs (id) ON DELETE CASCADE,
  occurred_at      timestamptz NOT NULL DEFAULT now(),
  error_class      text NOT NULL,
  message          text NOT NULL,
  user_message     text,
  retryable        boolean NOT NULL DEFAULT false,
  window_start     date,
  window_end       date,
  context          jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX sync_errors_run_idx ON sync_errors (sync_run_id, occurred_at DESC);
CREATE INDEX sync_errors_org_idx ON sync_errors (organization_id, occurred_at DESC);

CREATE TABLE data_freshness (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id             uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  app_id                      uuid NOT NULL REFERENCES apps (id) ON DELETE CASCADE,
  connection_id               uuid NOT NULL REFERENCES integration_connections (id) ON DELETE CASCADE,
  provider_key                text NOT NULL,
  data_type                   text NOT NULL,
  last_attempt_at             timestamptz,
  last_success_at             timestamptz,
  -- Most recent provider-reported date actually present in MART storage.
  latest_provider_data_date   date,
  latest_provider_data_at     timestamptz,
  expected_freshness_minutes  integer NOT NULL DEFAULT 360,
  status                      text NOT NULL DEFAULT 'unknown' CHECK (status IN (
                                'fresh', 'delayed', 'stale', 'unknown', 'error')),
  last_error_class            text,
  updated_at                  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX data_freshness_scope_key ON data_freshness (connection_id, app_id, data_type);
CREATE INDEX data_freshness_app_idx ON data_freshness (app_id);
CREATE TRIGGER data_freshness_set_updated_at BEFORE UPDATE ON data_freshness
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- MART 0004: raw ingestion.
--
-- Every provider response is persisted before normalization so a normalization
-- bug can be fixed and replayed without re-hitting the provider, and so any
-- number on the dashboard can be traced back to the bytes it came from.
--
-- Credentials are never written here: adapters return payload bodies only, and
-- the ingestion writer re-redacts defensively.

CREATE TABLE raw_ingestion_batches (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  app_id                uuid NOT NULL REFERENCES apps (id) ON DELETE CASCADE,
  connection_id         uuid NOT NULL REFERENCES integration_connections (id) ON DELETE CASCADE,
  sync_run_id           uuid REFERENCES sync_runs (id) ON DELETE SET NULL,
  provider_key          text NOT NULL,
  provider_category     text NOT NULL,
  data_type             text NOT NULL,
  request_window_start  date,
  request_window_end    date,
  page_number           integer NOT NULL DEFAULT 1,
  fetched_at            timestamptz NOT NULL DEFAULT now(),
  payload_hash          text NOT NULL,
  schema_version        text NOT NULL DEFAULT 'v1',
  record_count          integer NOT NULL DEFAULT 0,
  -- Inline payload for Phase 0A volumes; payload_reference is the extension
  -- point for object storage once payloads outgrow PostgreSQL.
  payload               jsonb,
  payload_reference     text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT raw_ingestion_payload_present CHECK (payload IS NOT NULL OR payload_reference IS NOT NULL)
);

-- Re-fetching an identical page inside the same run is a no-op rather than a
-- duplicate row.
CREATE UNIQUE INDEX raw_ingestion_batches_dedupe_key
  ON raw_ingestion_batches (connection_id, app_id, data_type, payload_hash, COALESCE(request_window_start, DATE '1970-01-01'), page_number);
CREATE INDEX raw_ingestion_batches_run_idx ON raw_ingestion_batches (sync_run_id);
CREATE INDEX raw_ingestion_batches_scope_idx
  ON raw_ingestion_batches (organization_id, app_id, data_type, fetched_at DESC);

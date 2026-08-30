-- Reconciliation vocabulary for provider-name-embedded matching.
--
-- Tenjin campaign names carry the ad network's campaign name inside
-- parentheses:
--
--   Meta:   FB_Reveal_Rush_CPI_Broad_US_26/08/26
--   Tenjin: CPI_Broad_US_static (FB_Reveal_Rush_CPI_Broad_US_26/08/26)
--
-- That is a deterministic relationship, not a fuzzy resemblance - but it is
-- still a name, so it must never be recorded as a stable-id match. It gets its
-- own method and stays outside authoritative coverage.
--
-- 'not_applicable' exists for organic attribution: rows that must stay visible
-- and must never become a candidate for any paid campaign.
ALTER TABLE provider_entity_mappings DROP CONSTRAINT IF EXISTS provider_entity_mappings_mapping_method_check;
ALTER TABLE provider_entity_mappings ADD CONSTRAINT provider_entity_mappings_mapping_method_check
  CHECK (mapping_method IN (
    'stable_external_id', 'tracking_parameter', 'explicit_provider_mapping',
    'provider_name_embedding', 'name_fallback', 'manual', 'not_applicable'));

ALTER TABLE provider_entity_mappings DROP CONSTRAINT IF EXISTS provider_entity_mappings_status_check;
ALTER TABLE provider_entity_mappings ADD CONSTRAINT provider_entity_mappings_status_check
  CHECK (status IN (
    'matched_exact', 'matched_confident', 'matched_fallback',
    'ambiguous', 'unmatched', 'manually_verified', 'rejected', 'not_applicable'));

-- A stream MART does not implement must not be recorded as a completed
-- ingestion. It made no request and moved no rows; "completed" alongside a
-- row count of zero reads as a successful sync of an empty day.
ALTER TABLE sync_runs DROP CONSTRAINT IF EXISTS sync_runs_status_check;
ALTER TABLE sync_runs ADD CONSTRAINT sync_runs_status_check
  CHECK (status IN (
    'queued', 'running', 'partially_completed', 'completed', 'failed',
    'cancelled', 'not_implemented'));

-- Sync errors are audit history and are never deleted. This marks the moment a
-- later successful run for the same app/provider/stream superseded one, so the
-- dashboard can show current problems without pretending resolved ones are
-- still happening.
ALTER TABLE sync_errors ADD COLUMN IF NOT EXISTS resolved_at timestamptz;
ALTER TABLE sync_errors ADD COLUMN IF NOT EXISTS resolved_by_sync_run_id uuid
  REFERENCES sync_runs (id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS sync_errors_unresolved_idx
  ON sync_errors (organization_id, resolved_at) WHERE resolved_at IS NULL;

-- One MMP campaign per network campaign was the wrong shape. A network campaign
-- legitimately has several MMP campaigns under it - a static and a video
-- creative of the same Meta campaign - and that is aggregation, not ambiguity.
-- The old key allowed one target per source, so the second creative overwrote
-- the first and its installs vanished from every mapped figure.
--
-- NULLS NOT DISTINCT keeps unmatched rows (target_external_id IS NULL) unique
-- per source, which the default NULL handling would not.
DROP INDEX IF EXISTS provider_entity_mappings_key;
CREATE UNIQUE INDEX provider_entity_mappings_key
  ON provider_entity_mappings (
    app_id, entity_type, source_provider, source_external_id, target_provider, target_external_id)
  NULLS NOT DISTINCT;

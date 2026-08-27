-- MART 0007: entity reconciliation and deterministic data-quality findings.
--
-- Reconciliation records how MART believes a marketing-network entity relates to
-- an MMP entity, how it decided, and how confident it is. A name match is stored
-- as a clearly-labelled fallback candidate and never becomes authoritative on
-- its own.

CREATE TABLE provider_entity_mappings (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  app_id                uuid NOT NULL REFERENCES apps (id) ON DELETE CASCADE,
  entity_type           text NOT NULL CHECK (entity_type IN ('campaign', 'ad_group', 'ad', 'creative')),
  source_provider       text NOT NULL,
  source_external_id    text NOT NULL,
  source_name           text,
  target_provider       text NOT NULL,
  target_external_id    text,
  target_name           text,
  mapping_method        text NOT NULL CHECK (mapping_method IN (
                          'stable_external_id', 'tracking_parameter',
                          'explicit_provider_mapping', 'name_fallback', 'manual')),
  mapping_confidence    numeric(4, 3) NOT NULL DEFAULT 0 CHECK (mapping_confidence BETWEEN 0 AND 1),
  status                text NOT NULL CHECK (status IN (
                          'matched_exact', 'matched_confident', 'matched_fallback',
                          'ambiguous', 'unmatched', 'manually_verified', 'rejected')),
  -- Every alternative considered, so an ambiguous mapping can be inspected.
  candidates            jsonb NOT NULL DEFAULT '[]'::jsonb,
  candidate_count       integer NOT NULL DEFAULT 0,
  evidence              jsonb NOT NULL DEFAULT '{}'::jsonb,
  computed_at           timestamptz NOT NULL DEFAULT now(),
  verified_at           timestamptz,
  verified_by_user_id   uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX provider_entity_mappings_key
  ON provider_entity_mappings (app_id, entity_type, source_provider, source_external_id, target_provider);
CREATE INDEX provider_entity_mappings_status_idx
  ON provider_entity_mappings (organization_id, app_id, entity_type, status);
CREATE INDEX provider_entity_mappings_target_idx
  ON provider_entity_mappings (app_id, target_provider, target_external_id);
CREATE TRIGGER provider_entity_mappings_set_updated_at BEFORE UPDATE ON provider_entity_mappings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Deterministic data-quality checks (not a modelling layer).
CREATE TABLE data_quality_findings (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  app_id            uuid NOT NULL REFERENCES apps (id) ON DELETE CASCADE,
  connection_id     uuid REFERENCES integration_connections (id) ON DELETE CASCADE,
  sync_run_id       uuid REFERENCES sync_runs (id) ON DELETE SET NULL,
  check_key         text NOT NULL,
  severity          text NOT NULL CHECK (severity IN ('info', 'warning', 'error')),
  entity_type       text,
  entity_ref        text,
  observed_date     date,
  message           text NOT NULL,
  detail            jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX data_quality_findings_scope_idx
  ON data_quality_findings (organization_id, app_id, created_at DESC);
CREATE INDEX data_quality_findings_check_idx
  ON data_quality_findings (app_id, check_key, severity);

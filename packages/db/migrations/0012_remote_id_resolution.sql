-- Mapping methods for provider-published identifiers, by the level they were
-- resolved at.
--
-- An MMP publishes an identifier for the network entity it attributed to, and
-- the entity level of that identifier is a property of the provider pair, not
-- of the field's name: Tenjin's `remote_campaign_id` holds Meta **ad set** ids
-- on real accounts. Recording the level the match was made at is what lets a
-- mapping explain itself instead of asserting itself.
--
-- Both are authoritative: the identifier came from the provider and the parent
-- link came from the network's own structure. Neither involves a name.
ALTER TABLE provider_entity_mappings DROP CONSTRAINT IF EXISTS provider_entity_mappings_mapping_method_check;
ALTER TABLE provider_entity_mappings ADD CONSTRAINT provider_entity_mappings_mapping_method_check
  CHECK (mapping_method IN (
    'stable_external_id', 'tracking_parameter', 'explicit_provider_mapping',
    'provider_remote_ad_group', 'provider_remote_campaign',
    'provider_name_embedding', 'name_fallback', 'manual', 'not_applicable'));

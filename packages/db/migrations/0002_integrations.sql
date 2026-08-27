-- MART 0002: the generic integration framework.
--
-- One framework serves every provider family. A new provider is a row in
-- integration_providers plus an adapter in packages/integrations; it must not
-- require new tables.

CREATE TABLE integration_providers (
  provider_key   text PRIMARY KEY,
  category       text NOT NULL CHECK (category IN (
                   'marketing_network', 'attribution_mmp', 'product_analytics',
                   'monetization', 'store', 'backend', 'crm')),
  display_name   text NOT NULL,
  -- 'available' means an adapter exists and the provider can be connected.
  -- 'planned' providers are shown in the UI as explicitly not implemented.
  status         text NOT NULL DEFAULT 'planned' CHECK (status IN ('available', 'planned')),
  auth_kind      text NOT NULL DEFAULT 'api_key' CHECK (auth_kind IN ('api_key', 'oauth2', 'basic', 'none')),
  docs_url       text,
  sort_order     integer NOT NULL DEFAULT 100,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE integration_connections (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id          uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  provider_key             text NOT NULL REFERENCES integration_providers (provider_key),
  category                 text NOT NULL,
  display_name             text NOT NULL,
  status                   text NOT NULL DEFAULT 'pending' CHECK (status IN (
                             'pending', 'connected', 'degraded', 'invalid_credentials', 'disconnected')),
  created_by_user_id       uuid REFERENCES users (id) ON DELETE SET NULL,
  last_validated_at        timestamptz,
  last_validation_ok       boolean,
  last_validation_error_class text,
  last_validation_message  text,
  disconnected_at          timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX integration_connections_org_idx ON integration_connections (organization_id, provider_key);
CREATE TRIGGER integration_connections_set_updated_at BEFORE UPDATE ON integration_connections
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Credentials are stored encrypted (AES-256-GCM) and are never selected by the
-- generic connection queries. Only the credential store reads this table.
CREATE TABLE integration_credentials (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  connection_id     uuid NOT NULL REFERENCES integration_connections (id) ON DELETE CASCADE,
  algorithm         text NOT NULL DEFAULT 'aes-256-gcm',
  key_version       text NOT NULL DEFAULT 'local-v1',
  ciphertext        bytea NOT NULL,
  iv                bytea NOT NULL,
  auth_tag          bytea NOT NULL,
  -- Non-reversible fingerprint so MART can tell whether a credential changed
  -- without ever comparing plaintext.
  fingerprint       text NOT NULL,
  expires_at        timestamptz,
  rotated_at        timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX integration_credentials_connection_key ON integration_credentials (connection_id);
CREATE TRIGGER integration_credentials_set_updated_at BEFORE UPDATE ON integration_credentials
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- A provider account (Meta ad account, MMP app) discovered through the API.
CREATE TABLE integration_accounts (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  connection_id        uuid NOT NULL REFERENCES integration_connections (id) ON DELETE CASCADE,
  external_account_id  text NOT NULL,
  name                 text NOT NULL,
  account_type         text NOT NULL CHECK (account_type IN ('ad_account', 'mmp_app')),
  currency             char(3),
  timezone             text,
  status               text,
  metadata             jsonb NOT NULL DEFAULT '{}'::jsonb,
  discovered_at        timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX integration_accounts_connection_external_key
  ON integration_accounts (connection_id, external_account_id);
CREATE TRIGGER integration_accounts_set_updated_at BEFORE UPDATE ON integration_accounts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Binds a MART app to a provider account in a specific role.
-- The partial unique index enforces the Phase 0A rule: exactly one active
-- primary attribution provider per app.
CREATE TABLE integration_app_bindings (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id         uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  app_id                  uuid NOT NULL REFERENCES apps (id) ON DELETE CASCADE,
  connection_id           uuid NOT NULL REFERENCES integration_connections (id) ON DELETE CASCADE,
  integration_account_id  uuid REFERENCES integration_accounts (id) ON DELETE SET NULL,
  role                    text NOT NULL CHECK (role IN ('marketing_network', 'primary_attribution')),
  status                  text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_by_user_id      uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX integration_app_bindings_primary_attribution_key
  ON integration_app_bindings (app_id) WHERE role = 'primary_attribution' AND status = 'active';
CREATE UNIQUE INDEX integration_app_bindings_marketing_key
  ON integration_app_bindings (app_id, connection_id, integration_account_id)
  WHERE role = 'marketing_network' AND status = 'active';
CREATE INDEX integration_app_bindings_app_idx ON integration_app_bindings (app_id, status);
CREATE TRIGGER integration_app_bindings_set_updated_at BEFORE UPDATE ON integration_app_bindings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- What a connection can actually do, discovered by probing rather than assumed.
-- The dashboard reads this to decide whether a field may be displayed at all.
CREATE TABLE provider_capabilities (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id         uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  connection_id           uuid NOT NULL REFERENCES integration_connections (id) ON DELETE CASCADE,
  integration_account_id  uuid REFERENCES integration_accounts (id) ON DELETE CASCADE,
  capability_key          text NOT NULL,
  supported               boolean NOT NULL,
  discovery_method        text NOT NULL CHECK (discovery_method IN ('declared', 'probed', 'inferred', 'manual')),
  detail                  jsonb NOT NULL DEFAULT '{}'::jsonb,
  discovered_at           timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX provider_capabilities_key
  ON provider_capabilities (connection_id, COALESCE(integration_account_id, '00000000-0000-0000-0000-000000000000'::uuid), capability_key);

-- Phase 0A provider catalogue. Providers marked 'planned' render as
-- explicitly-not-implemented cards; they cannot be connected.
INSERT INTO integration_providers (provider_key, category, display_name, status, auth_kind, sort_order) VALUES
  ('meta_ads',      'marketing_network', 'Meta Ads',        'available', 'api_key', 10),
  ('tiktok_ads',    'marketing_network', 'TikTok Ads',      'planned',   'oauth2',  20),
  ('google_ads',    'marketing_network', 'Google Ads',      'planned',   'oauth2',  30),
  ('unity_ads',     'marketing_network', 'Unity Ads',       'planned',   'api_key', 40),
  ('applovin',      'marketing_network', 'AppLovin',        'planned',   'api_key', 50),
  ('mintegral',     'marketing_network', 'Mintegral',       'planned',   'api_key', 60),
  ('pangle',        'marketing_network', 'Pangle',          'planned',   'api_key', 70),
  ('appsflyer',     'attribution_mmp',   'AppsFlyer',       'available', 'api_key', 10),
  ('tenjin',        'attribution_mmp',   'Tenjin',          'available', 'api_key', 20),
  ('adjust',        'attribution_mmp',   'Adjust',          'planned',   'api_key', 30),
  ('singular',      'attribution_mmp',   'Singular',        'planned',   'api_key', 40),
  ('kochava',       'attribution_mmp',   'Kochava',         'planned',   'api_key', 50),
  ('firebase',      'product_analytics', 'Firebase',        'planned',   'oauth2',  10),
  ('mixpanel',      'product_analytics', 'Mixpanel',        'planned',   'api_key', 20),
  ('amplitude',     'product_analytics', 'Amplitude',       'planned',   'api_key', 30),
  ('cas_ai',        'monetization',      'CAS.AI',          'planned',   'api_key', 10),
  ('applovin_max',  'monetization',      'AppLovin MAX',    'planned',   'api_key', 20),
  ('levelplay',     'monetization',      'LevelPlay',       'planned',   'api_key', 30),
  ('admob',         'monetization',      'AdMob',           'planned',   'oauth2',  40),
  ('revenuecat',    'monetization',      'RevenueCat',      'planned',   'api_key', 50);

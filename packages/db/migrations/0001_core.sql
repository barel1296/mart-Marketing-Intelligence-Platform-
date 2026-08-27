-- MART 0001: identity, tenancy and audit.
--
-- Tenancy rule: every business table carries organization_id and every query
-- path filters on it. Foreign keys are declared so a cross-tenant row cannot be
-- created even if application code is wrong.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------- users -----
CREATE TABLE users (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email           text NOT NULL,
  password_hash   text NOT NULL,
  password_algo   text NOT NULL DEFAULT 'scrypt',
  display_name    text NOT NULL,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  last_login_at   timestamptz,
  CONSTRAINT users_email_lowercase CHECK (email = lower(email))
);
CREATE UNIQUE INDEX users_email_key ON users (email);

-- ------------------------------------------------------------- sessions -----
-- Only a hash of the session token is stored: a database leak must not yield
-- usable sessions.
CREATE TABLE sessions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash        text NOT NULL,
  csrf_token_hash   text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  last_seen_at      timestamptz NOT NULL DEFAULT now(),
  expires_at        timestamptz NOT NULL,
  revoked_at        timestamptz,
  ip_address        inet,
  user_agent        text
);
CREATE UNIQUE INDEX sessions_token_hash_key ON sessions (token_hash);
CREATE INDEX sessions_user_id_idx ON sessions (user_id);
CREATE INDEX sessions_expires_at_idx ON sessions (expires_at) WHERE revoked_at IS NULL;

-- -------------------------------------------------------- organizations -----
CREATE TABLE organizations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL CHECK (length(btrim(name)) > 0),
  slug        text NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  created_by  uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX organizations_slug_key ON organizations (slug);

CREATE TABLE organization_memberships (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  user_id          uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role             text NOT NULL CHECK (role IN ('owner', 'admin', 'analyst', 'viewer')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX organization_memberships_org_user_key
  ON organization_memberships (organization_id, user_id);
CREATE INDEX organization_memberships_user_idx ON organization_memberships (user_id);

-- ----------------------------------------------------------------- apps -----
CREATE TABLE apps (
  id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id               uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  name                          text NOT NULL CHECK (length(btrim(name)) > 0),
  platform                      text NOT NULL CHECK (platform IN ('ios', 'android', 'cross_platform')),
  bundle_id                     text NOT NULL CHECK (length(btrim(bundle_id)) > 0),
  timezone                      text NOT NULL DEFAULT 'UTC',
  default_currency              char(3) NOT NULL DEFAULT 'USD',
  -- Nullable until the user explicitly chooses. Provider credentials never
  -- live on this row: connections are separate integration entities.
  primary_attribution_provider  text CHECK (primary_attribution_provider IN ('appsflyer', 'tenjin')),
  status                        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at                    timestamptz NOT NULL DEFAULT now(),
  updated_at                    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX apps_org_bundle_platform_key ON apps (organization_id, bundle_id, platform);
CREATE INDEX apps_organization_idx ON apps (organization_id) WHERE status = 'active';

-- ------------------------------------------------------------ audit log -----
CREATE TABLE audit_log (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid REFERENCES organizations (id) ON DELETE SET NULL,
  actor_user_id    uuid REFERENCES users (id) ON DELETE SET NULL,
  actor_type       text NOT NULL DEFAULT 'user' CHECK (actor_type IN ('user', 'system', 'worker')),
  action           text NOT NULL,
  resource_type    text NOT NULL,
  resource_id      text,
  request_id       text,
  metadata         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_org_created_idx ON audit_log (organization_id, created_at DESC);
CREATE INDEX audit_log_resource_idx ON audit_log (organization_id, resource_type, resource_id);

-- The audit log is append-only at the database level, not merely by convention.
CREATE OR REPLACE FUNCTION audit_log_is_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only (attempted %)', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_log_no_update
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_is_append_only();

-- Shared updated_at trigger.
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER users_set_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER organizations_set_updated_at BEFORE UPDATE ON organizations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER organization_memberships_set_updated_at BEFORE UPDATE ON organization_memberships
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER apps_set_updated_at BEFORE UPDATE ON apps
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

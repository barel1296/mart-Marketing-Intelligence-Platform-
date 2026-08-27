-- MART 0005: canonical marketing (delivery) model.
--
-- Provider-independent by construction: the provider is a column, never part of
-- a column name, and entity identity is always the provider's stable external
-- id. Names are attributes, never keys.

CREATE TABLE marketing_accounts (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  app_id               uuid NOT NULL REFERENCES apps (id) ON DELETE CASCADE,
  connection_id        uuid NOT NULL REFERENCES integration_connections (id) ON DELETE CASCADE,
  provider_key         text NOT NULL,
  external_account_id  text NOT NULL,
  name                 text,
  currency             char(3),
  timezone             text,
  status               text,
  first_observed_at    timestamptz NOT NULL DEFAULT now(),
  observed_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX marketing_accounts_key
  ON marketing_accounts (connection_id, app_id, external_account_id);

CREATE TABLE marketing_campaigns (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id         uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  app_id                  uuid NOT NULL REFERENCES apps (id) ON DELETE CASCADE,
  connection_id           uuid NOT NULL REFERENCES integration_connections (id) ON DELETE CASCADE,
  marketing_account_id    uuid REFERENCES marketing_accounts (id) ON DELETE SET NULL,
  provider_key            text NOT NULL,
  external_campaign_id    text NOT NULL,
  name                    text,
  status                  text,
  effective_status        text,
  objective               text,
  daily_budget            numeric(20, 6),
  lifetime_budget         numeric(20, 6),
  currency                char(3),
  provider_created_at     timestamptz,
  first_observed_at       timestamptz NOT NULL DEFAULT now(),
  observed_at             timestamptz NOT NULL DEFAULT now(),
  sync_run_id             uuid REFERENCES sync_runs (id) ON DELETE SET NULL,
  restatement_generation  integer NOT NULL DEFAULT 0,
  -- Set only when a re-sync actually changed a measure.
  last_restated_at        timestamptz
);
CREATE UNIQUE INDEX marketing_campaigns_key
  ON marketing_campaigns (connection_id, app_id, external_campaign_id);
CREATE INDEX marketing_campaigns_app_idx ON marketing_campaigns (organization_id, app_id);

CREATE TABLE marketing_ad_groups (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id         uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  app_id                  uuid NOT NULL REFERENCES apps (id) ON DELETE CASCADE,
  connection_id           uuid NOT NULL REFERENCES integration_connections (id) ON DELETE CASCADE,
  campaign_id             uuid REFERENCES marketing_campaigns (id) ON DELETE CASCADE,
  provider_key            text NOT NULL,
  external_ad_group_id    text NOT NULL,
  external_campaign_id    text,
  name                    text,
  status                  text,
  effective_status        text,
  daily_budget            numeric(20, 6),
  bid_strategy            text,
  first_observed_at       timestamptz NOT NULL DEFAULT now(),
  observed_at             timestamptz NOT NULL DEFAULT now(),
  sync_run_id             uuid REFERENCES sync_runs (id) ON DELETE SET NULL,
  restatement_generation  integer NOT NULL DEFAULT 0,
  -- Set only when a re-sync actually changed a measure.
  last_restated_at        timestamptz
);
CREATE UNIQUE INDEX marketing_ad_groups_key
  ON marketing_ad_groups (connection_id, app_id, external_ad_group_id);

CREATE TABLE marketing_creatives (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id         uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  app_id                  uuid NOT NULL REFERENCES apps (id) ON DELETE CASCADE,
  connection_id           uuid NOT NULL REFERENCES integration_connections (id) ON DELETE CASCADE,
  provider_key            text NOT NULL,
  external_creative_id    text NOT NULL,
  name                    text,
  object_type             text,
  thumbnail_url           text,
  first_observed_at       timestamptz NOT NULL DEFAULT now(),
  observed_at             timestamptz NOT NULL DEFAULT now(),
  sync_run_id             uuid REFERENCES sync_runs (id) ON DELETE SET NULL,
  restatement_generation  integer NOT NULL DEFAULT 0,
  -- Set only when a re-sync actually changed a measure.
  last_restated_at        timestamptz
);
CREATE UNIQUE INDEX marketing_creatives_key
  ON marketing_creatives (connection_id, app_id, external_creative_id);

CREATE TABLE marketing_ads (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id         uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  app_id                  uuid NOT NULL REFERENCES apps (id) ON DELETE CASCADE,
  connection_id           uuid NOT NULL REFERENCES integration_connections (id) ON DELETE CASCADE,
  campaign_id             uuid REFERENCES marketing_campaigns (id) ON DELETE CASCADE,
  ad_group_id             uuid REFERENCES marketing_ad_groups (id) ON DELETE CASCADE,
  creative_id             uuid REFERENCES marketing_creatives (id) ON DELETE SET NULL,
  provider_key            text NOT NULL,
  external_ad_id          text NOT NULL,
  external_ad_group_id    text,
  external_campaign_id    text,
  external_creative_id    text,
  name                    text,
  status                  text,
  effective_status        text,
  first_observed_at       timestamptz NOT NULL DEFAULT now(),
  observed_at             timestamptz NOT NULL DEFAULT now(),
  sync_run_id             uuid REFERENCES sync_runs (id) ON DELETE SET NULL,
  restatement_generation  integer NOT NULL DEFAULT 0,
  -- Set only when a re-sync actually changed a measure.
  last_restated_at        timestamptz
);
CREATE UNIQUE INDEX marketing_ads_key ON marketing_ads (connection_id, app_id, external_ad_id);

-- Delivery facts. Grain is fixed to report_date and enforced by a CHECK: a
-- cohort-grained number can never be written into this table by mistake.
CREATE TABLE marketing_daily_metrics (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id         uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  app_id                  uuid NOT NULL REFERENCES apps (id) ON DELETE CASCADE,
  connection_id           uuid NOT NULL REFERENCES integration_connections (id) ON DELETE CASCADE,
  provider_key            text NOT NULL,
  grain                   text NOT NULL DEFAULT 'report_date' CHECK (grain = 'report_date'),
  report_date             date NOT NULL,
  marketing_account_id    uuid REFERENCES marketing_accounts (id) ON DELETE SET NULL,
  campaign_id             uuid REFERENCES marketing_campaigns (id) ON DELETE SET NULL,
  ad_group_id             uuid REFERENCES marketing_ad_groups (id) ON DELETE SET NULL,
  ad_id                   uuid REFERENCES marketing_ads (id) ON DELETE SET NULL,
  creative_id             uuid REFERENCES marketing_creatives (id) ON DELETE SET NULL,
  external_account_id     text,
  external_campaign_id    text,
  external_ad_group_id    text,
  external_ad_id          text,
  external_creative_id    text,
  country                 char(2),
  platform                text,
  currency                char(3) NOT NULL,
  spend                   numeric(20, 6) NOT NULL DEFAULT 0 CHECK (spend >= 0),
  impressions             bigint NOT NULL DEFAULT 0 CHECK (impressions >= 0),
  clicks                  bigint NOT NULL DEFAULT 0 CHECK (clicks >= 0),
  link_clicks             bigint CHECK (link_clicks IS NULL OR link_clicks >= 0),
  outbound_clicks         bigint CHECK (outbound_clicks IS NULL OR outbound_clicks >= 0),
  reach                   bigint CHECK (reach IS NULL OR reach >= 0),
  frequency               numeric(12, 6) CHECK (frequency IS NULL OR frequency >= 0),
  -- Idempotency key: hash of the full dimension tuple including report_date.
  dimension_hash          text NOT NULL,
  sync_run_id             uuid REFERENCES sync_runs (id) ON DELETE SET NULL,
  first_observed_at       timestamptz NOT NULL DEFAULT now(),
  observed_at             timestamptz NOT NULL DEFAULT now(),
  -- Incremented only when a re-sync actually changes a measure, so restatement
  -- is distinguishable from a no-op refresh.
  restatement_generation  integer NOT NULL DEFAULT 0,
  -- Set only when a re-sync actually changed a measure.
  last_restated_at        timestamptz
);
CREATE UNIQUE INDEX marketing_daily_metrics_key
  ON marketing_daily_metrics (connection_id, app_id, dimension_hash);
CREATE INDEX marketing_daily_metrics_query_idx
  ON marketing_daily_metrics (organization_id, app_id, report_date);
CREATE INDEX marketing_daily_metrics_campaign_idx
  ON marketing_daily_metrics (app_id, external_campaign_id, report_date);

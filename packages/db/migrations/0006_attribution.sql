-- MART 0006: canonical attribution model.
--
-- Independent of AppsFlyer and Tenjin. Every fact records which provider it came
-- from (provenance survives an MMP switch) and which grain it is expressed in.
--
-- Grain discipline:
--   attribution_daily_metrics  -> install_date  (cohort anchor)
--   attribution_event_metrics  -> event_date
--   attribution_revenue_metrics-> event_date or install_date, declared per row

CREATE TABLE attribution_sources (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id          uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  app_id                   uuid NOT NULL REFERENCES apps (id) ON DELETE CASCADE,
  connection_id            uuid NOT NULL REFERENCES integration_connections (id) ON DELETE CASCADE,
  provider_key             text NOT NULL,
  media_source             text NOT NULL,
  -- Canonical form used for cross-provider comparison, e.g. both
  -- 'facebook ads' and 'Facebook Ads' normalize to 'facebook'.
  normalized_media_source  text NOT NULL,
  is_organic               boolean NOT NULL DEFAULT false,
  first_observed_at        timestamptz NOT NULL DEFAULT now(),
  observed_at              timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX attribution_sources_key
  ON attribution_sources (connection_id, app_id, media_source);

CREATE TABLE attribution_daily_metrics (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id         uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  app_id                  uuid NOT NULL REFERENCES apps (id) ON DELETE CASCADE,
  connection_id           uuid NOT NULL REFERENCES integration_connections (id) ON DELETE CASCADE,
  provider_key            text NOT NULL,
  grain                   text NOT NULL DEFAULT 'install_date' CHECK (grain = 'install_date'),
  install_date            date NOT NULL,
  media_source            text,
  normalized_media_source text,
  external_campaign_id    text,
  campaign_name           text,
  external_ad_group_id    text,
  ad_group_name           text,
  external_ad_id          text,
  ad_name                 text,
  external_creative_id    text,
  creative_name           text,
  country                 char(2),
  platform                text,
  -- 'deterministic' | 'modeled' | 'unknown'. Modeled (SKAN/AAK) rows must never
  -- be silently blended with deterministic ones in a decision.
  attribution_certainty   text NOT NULL DEFAULT 'unknown'
                          CHECK (attribution_certainty IN ('deterministic', 'modeled', 'unknown')),
  attributed_installs     bigint NOT NULL DEFAULT 0 CHECK (attributed_installs >= 0),
  attributed_clicks       bigint CHECK (attributed_clicks IS NULL OR attributed_clicks >= 0),
  attributed_impressions  bigint CHECK (attributed_impressions IS NULL OR attributed_impressions >= 0),
  dimension_hash          text NOT NULL,
  sync_run_id             uuid REFERENCES sync_runs (id) ON DELETE SET NULL,
  first_observed_at       timestamptz NOT NULL DEFAULT now(),
  observed_at             timestamptz NOT NULL DEFAULT now(),
  restatement_generation  integer NOT NULL DEFAULT 0,
  -- Set only when a re-sync actually changed a measure.
  last_restated_at        timestamptz
);
CREATE UNIQUE INDEX attribution_daily_metrics_key
  ON attribution_daily_metrics (connection_id, app_id, dimension_hash);
CREATE INDEX attribution_daily_metrics_query_idx
  ON attribution_daily_metrics (organization_id, app_id, install_date);
CREATE INDEX attribution_daily_metrics_campaign_idx
  ON attribution_daily_metrics (app_id, external_campaign_id, install_date);

CREATE TABLE attribution_event_metrics (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id         uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  app_id                  uuid NOT NULL REFERENCES apps (id) ON DELETE CASCADE,
  connection_id           uuid NOT NULL REFERENCES integration_connections (id) ON DELETE CASCADE,
  provider_key            text NOT NULL,
  grain                   text NOT NULL DEFAULT 'event_date' CHECK (grain = 'event_date'),
  event_date              date NOT NULL,
  event_name              text NOT NULL,
  media_source            text,
  normalized_media_source text,
  external_campaign_id    text,
  campaign_name           text,
  country                 char(2),
  platform                text,
  event_count             bigint NOT NULL DEFAULT 0 CHECK (event_count >= 0),
  unique_users            bigint CHECK (unique_users IS NULL OR unique_users >= 0),
  dimension_hash          text NOT NULL,
  sync_run_id             uuid REFERENCES sync_runs (id) ON DELETE SET NULL,
  first_observed_at       timestamptz NOT NULL DEFAULT now(),
  observed_at             timestamptz NOT NULL DEFAULT now(),
  restatement_generation  integer NOT NULL DEFAULT 0,
  -- Set only when a re-sync actually changed a measure.
  last_restated_at        timestamptz
);
CREATE UNIQUE INDEX attribution_event_metrics_key
  ON attribution_event_metrics (connection_id, app_id, dimension_hash);
CREATE INDEX attribution_event_metrics_query_idx
  ON attribution_event_metrics (organization_id, app_id, event_date);

CREATE TABLE attribution_revenue_metrics (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id         uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  app_id                  uuid NOT NULL REFERENCES apps (id) ON DELETE CASCADE,
  connection_id           uuid NOT NULL REFERENCES integration_connections (id) ON DELETE CASCADE,
  provider_key            text NOT NULL,
  -- Declared per row because providers differ: revenue recognized on the day it
  -- happened (event_date) is not the same fact as cohort LTV (install_date).
  grain                   text NOT NULL CHECK (grain IN ('event_date', 'install_date')),
  activity_date           date NOT NULL,
  revenue_type            text NOT NULL CHECK (revenue_type IN ('iap', 'ad', 'total', 'subscription')),
  media_source            text,
  normalized_media_source text,
  external_campaign_id    text,
  campaign_name           text,
  country                 char(2),
  platform                text,
  currency                char(3) NOT NULL,
  revenue                 numeric(20, 6) NOT NULL DEFAULT 0,
  dimension_hash          text NOT NULL,
  sync_run_id             uuid REFERENCES sync_runs (id) ON DELETE SET NULL,
  first_observed_at       timestamptz NOT NULL DEFAULT now(),
  observed_at             timestamptz NOT NULL DEFAULT now(),
  restatement_generation  integer NOT NULL DEFAULT 0,
  -- Set only when a re-sync actually changed a measure.
  last_restated_at        timestamptz
);
CREATE UNIQUE INDEX attribution_revenue_metrics_key
  ON attribution_revenue_metrics (connection_id, app_id, dimension_hash);
CREATE INDEX attribution_revenue_metrics_query_idx
  ON attribution_revenue_metrics (organization_id, app_id, activity_date, grain);

-- The MMP's own campaign directory.
--
-- Tenjin's reporting rows carry only its own campaign UUID, which can never
-- equal a Meta campaign id - which is why reconciliation had to fall back to
-- names. Its /campaigns endpoint, however, carries `remote_campaign_id`: the
-- ad network's real campaign id, declared by the MMP itself.
--
-- That is a stable cross-provider identifier, not a name, so a match through it
-- is authoritative. It also resolves the case names cannot: two Meta campaigns
-- with identical names (a static and a video variant of one launch) are
-- indistinguishable by name and completely distinct by id.
CREATE TABLE attribution_campaigns (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  app_id                uuid NOT NULL REFERENCES apps (id) ON DELETE CASCADE,
  connection_id         uuid NOT NULL REFERENCES integration_connections (id) ON DELETE CASCADE,
  provider_key          text NOT NULL,
  -- The MMP's own campaign id.
  external_campaign_id  text NOT NULL,
  name                  text,
  -- The ad network's campaign id as the MMP reports it. Null when the MMP has
  -- none: a self-attributing network, or a link the MMP never resolved.
  remote_campaign_id    text,
  -- The MMP's ad-network id, so a campaign is never matched across networks.
  channel_id            text,
  channel_name          text,
  first_observed_at     timestamptz NOT NULL DEFAULT now(),
  observed_at           timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX attribution_campaigns_key
  ON attribution_campaigns (connection_id, app_id, external_campaign_id);
CREATE INDEX attribution_campaigns_remote_idx
  ON attribution_campaigns (organization_id, app_id, remote_campaign_id)
  WHERE remote_campaign_id IS NOT NULL;

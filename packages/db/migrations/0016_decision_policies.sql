-- MART 0016: the operator's decision targets - Phase 3.
--
-- A decision signal ("scale", "reduce") is a comparison of a trusted figure
-- against a target, and the target is a business input MART cannot derive: a
-- break-even cohort ROAS depends on margins, payback horizon and appetite that
-- live outside the data. So the target is stored, per app, exactly as the
-- operator stated it, and a signal that compares against it names it.
--
-- Without a row here MART still evaluates every campaign - it reports trends,
-- pacing, anomalies and data quality - but it never says scale or reduce,
-- because it has nothing defensible to say them against.
--
-- Targets only. The floors and bands a signal needs (minimum installs, spend,
-- mature days, tolerance) are constants in the metric layer, reviewed in one
-- place, and are not per-app knobs.

CREATE TABLE decision_policies (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  app_id              uuid NOT NULL REFERENCES apps (id) ON DELETE CASCADE,
  -- Cohort ROAS targets as ratios (0.6 = 60% of spend returned by day N).
  target_roas_d7      numeric(12, 6) CHECK (target_roas_d7 IS NULL OR target_roas_d7 > 0),
  target_roas_d1      numeric(12, 6) CHECK (target_roas_d1 IS NULL OR target_roas_d1 > 0),
  -- Ceiling on mapped CPI, in `currency`.
  max_cpi             numeric(20, 6) CHECK (max_cpi IS NULL OR max_cpi > 0),
  currency            char(3),
  updated_by_user_id  uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT decision_policies_app_unique UNIQUE (app_id),
  CONSTRAINT decision_policies_cpi_currency CHECK (max_cpi IS NULL OR currency IS NOT NULL)
);

COMMENT ON TABLE decision_policies IS
  'Operator-stated decision targets per app. Read by the Phase 3 decision layer; never derived from data, never acted on automatically.';

-- MART 0014: make cohort age representable, before anything is built on it.
--
-- `cohort_date` existed as vocabulary but the physical model could not hold it.
-- Revenue identity was (grain, activity_date, revenue_type, media_source,
-- campaign, country, platform, currency) with no notion of cohort age, so D1
-- and D7 revenue for the same cohort, campaign and date collided on one
-- dimension_hash: the second write would overwrite the first, and the loss
-- would look exactly like a restatement.
--
-- Phase 1 only needs the model to REPRESENT cohort age safely. Nothing computes
-- cohort ROAS yet, and nothing should until cohort-compatible spend exists.
--
-- Additive: cohort_age_days is NULL for every row stored so far, and the
-- dimension hash omits the field entirely when it is NULL, so existing
-- identities are byte-for-byte unchanged.

ALTER TABLE attribution_revenue_metrics
  ADD COLUMN IF NOT EXISTS cohort_age_days integer;

-- 'cohort_date' becomes a legal grain: an install cohort observed at an age.
ALTER TABLE attribution_revenue_metrics
  DROP CONSTRAINT IF EXISTS attribution_revenue_metrics_grain_check;
ALTER TABLE attribution_revenue_metrics
  ADD CONSTRAINT attribution_revenue_metrics_grain_check
  CHECK (grain IN ('event_date', 'install_date', 'cohort_date'));

-- The pairing is the safety property: a cohort row without an age cannot say
-- which cohort day it describes, and an age on a non-cohort row would be
-- meaningless. Enforced in the schema so no adapter can write a half-formed
-- cohort fact.
ALTER TABLE attribution_revenue_metrics
  DROP CONSTRAINT IF EXISTS attribution_revenue_metrics_cohort_age_check;
ALTER TABLE attribution_revenue_metrics
  ADD CONSTRAINT attribution_revenue_metrics_cohort_age_check
  CHECK (
    (grain = 'cohort_date' AND cohort_age_days IS NOT NULL AND cohort_age_days >= 0)
    OR (grain <> 'cohort_date' AND cohort_age_days IS NULL)
  );

COMMENT ON COLUMN attribution_revenue_metrics.cohort_age_days IS
  'Days since the install cohort anchor: 0 for D0, 7 for D7. Set only when grain = cohort_date.';

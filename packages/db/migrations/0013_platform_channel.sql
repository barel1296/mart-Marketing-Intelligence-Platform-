-- MART 0013: canonical platform, with the provider's own spelling kept beside it.
--
-- `platform` was free text: whatever each adapter happened to produce. Two
-- adapters had already diverged on what to do with an unrecognised value, so
-- the same device could be stored two ways depending on which stream carried
-- it, and a platform filter could not be relied on.
--
-- Additive and forward-safe. Existing rows are normalized in place first, so
-- the CHECK that follows can never reject data already stored.

ALTER TABLE marketing_daily_metrics
  ADD COLUMN IF NOT EXISTS native_platform text;
ALTER TABLE attribution_daily_metrics
  ADD COLUMN IF NOT EXISTS native_platform text;
ALTER TABLE attribution_revenue_metrics
  ADD COLUMN IF NOT EXISTS native_platform text;

-- Preserve what the provider said before collapsing the column to the
-- canonical vocabulary: the original spelling is what a support question is
-- asked about, and normalization is lossy.
UPDATE marketing_daily_metrics
   SET native_platform = platform
 WHERE native_platform IS NULL AND platform IS NOT NULL;
UPDATE attribution_daily_metrics
   SET native_platform = platform
 WHERE native_platform IS NULL AND platform IS NOT NULL;
UPDATE attribution_revenue_metrics
   SET native_platform = platform
 WHERE native_platform IS NULL AND platform IS NOT NULL;

-- Collapse to the canonical vocabulary. NULL becomes 'unknown': the row exists
-- and MART does not know its device, which is a different claim from no row.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['marketing_daily_metrics','attribution_daily_metrics','attribution_revenue_metrics']
  LOOP
    EXECUTE format($f$
      UPDATE %I SET platform = CASE
        WHEN platform IS NULL THEN 'unknown'
        WHEN lower(platform) ~ '(^|[^a-z])i(os|phone|pad|pod)' THEN 'ios'
        WHEN lower(platform) LIKE 'ios%%' THEN 'ios'
        WHEN lower(platform) LIKE '%%android%%' THEN 'android'
        WHEN lower(platform) LIKE '%%web%%'
          OR lower(platform) LIKE '%%desktop%%'
          OR lower(platform) LIKE '%%browser%%' THEN 'web'
        ELSE 'unknown'
      END
      WHERE platform IS NULL OR platform NOT IN ('ios','android','web','unknown')
    $f$, t);
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I CHECK (platform IN (''ios'',''android'',''web'',''unknown''))',
      t, t || '_platform_check');
  END LOOP;
END $$;

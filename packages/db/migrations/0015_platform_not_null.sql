-- MART 0015: platform is always a canonical value, never NULL.
--
-- 0013 gave platform a vocabulary but left NULL legal, and a CHECK does not
-- reject NULL - so a row could still arrive with no platform at all. That is
-- the state that made the dashboard's platform filter untrustworthy: filtering
-- to ios silently excluded every row whose platform nobody had set, and the
-- resulting zero looked like an answer.
--
-- Every adapter now normalizes through one function that returns 'unknown'
-- rather than NULL, so the column can say so. 'unknown' is a real value: the
-- row exists and MART does not know its device, which is a different claim from
-- "nobody looked".

UPDATE marketing_daily_metrics SET platform = 'unknown' WHERE platform IS NULL;
UPDATE attribution_daily_metrics SET platform = 'unknown' WHERE platform IS NULL;
UPDATE attribution_revenue_metrics SET platform = 'unknown' WHERE platform IS NULL;

ALTER TABLE marketing_daily_metrics ALTER COLUMN platform SET DEFAULT 'unknown';
ALTER TABLE attribution_daily_metrics ALTER COLUMN platform SET DEFAULT 'unknown';
ALTER TABLE attribution_revenue_metrics ALTER COLUMN platform SET DEFAULT 'unknown';

ALTER TABLE marketing_daily_metrics ALTER COLUMN platform SET NOT NULL;
ALTER TABLE attribution_daily_metrics ALTER COLUMN platform SET NOT NULL;
ALTER TABLE attribution_revenue_metrics ALTER COLUMN platform SET NOT NULL;

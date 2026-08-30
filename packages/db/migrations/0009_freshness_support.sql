-- Freshness needs a way to say "this stream was never fetched, and that is
-- expected". Before this, a stream MART does not implement was written as
-- 'fresh' the moment its no-op returned successfully, which is the most
-- misleading state possible: the dashboard claimed live data for a stream that
-- had never made a request.
--
-- 'unsupported'     the provider does not offer this data at all
-- 'not_implemented' MART has not built this stream for this provider
--
-- Neither is an error and neither is fresh. Both are excluded from the
-- worst-case rollup, so an unimplemented stream cannot make a healthy app look
-- broken - nor a broken one look healthy.
ALTER TABLE data_freshness DROP CONSTRAINT IF EXISTS data_freshness_status_check;
ALTER TABLE data_freshness ADD CONSTRAINT data_freshness_status_check CHECK (status IN (
  'fresh', 'delayed', 'stale', 'unknown', 'error', 'unsupported', 'not_implemented'));

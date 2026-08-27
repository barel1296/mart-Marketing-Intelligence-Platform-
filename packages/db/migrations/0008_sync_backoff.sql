-- Backoff between sync attempts.
--
-- A retryable failure (rate limit, provider outage, timeout) used to be requeued
-- with no earliest-start time, so the worker picked it up again on its very next
-- poll. Against a rate-limited provider that spends every remaining attempt in a
-- few seconds and then gives up permanently, which is the opposite of what a
-- retry budget is for. `not_before` gives a requeued run a wait, and the claim
-- query honours it.

ALTER TABLE sync_runs
  ADD COLUMN not_before timestamptz NOT NULL DEFAULT now();

COMMENT ON COLUMN sync_runs.not_before IS
  'Earliest time this run may be claimed. Set into the future when a retryable failure is requeued.';

-- The claim query orders by (not_before, created_at) over queued rows only.
CREATE INDEX sync_runs_claim_idx
  ON sync_runs (not_before, created_at)
  WHERE status = 'queued';

# Data model

PostgreSQL 16. Schema is applied by hand-written, ordered, checksum-verified
migrations in `packages/db/migrations`. Every migration runs inside a
transaction holding `pg_advisory_xact_lock`, so two processes starting at once
cannot apply the same migration twice.

## Grain: the rule everything else follows

Three different date meanings appear in marketing data, and conflating them
produces numbers that look plausible and are wrong.

| Grain          | Meaning                                             | Source                     |
| -------------- | --------------------------------------------------- | -------------------------- |
| `report_date`  | The day the ad network reported delivery and cost   | Marketing network          |
| `install_date` | The day a user installed, per the MMP's attribution | MMP                        |
| `event_date`   | The day an in-app event or purchase occurred        | MMP                        |
| `cohort_date`  | The install day a later event is credited back to   | _not produced in Phase 0A_ |

MART keeps them in **separate tables**, each pinned by a `CHECK` constraint:

```sql
marketing_daily_metrics    grain CHECK (grain = 'report_date')
attribution_daily_metrics  grain CHECK (grain = 'install_date')
attribution_event_metrics  event_date  -- event grain by construction
attribution_revenue_metrics grain CHECK (grain IN ('event_date','install_date'))
```

This is structural, not conventional: a bug cannot write install-date rows into
the delivery table, because the database rejects it.

## Tables

### Tenancy and identity (`0001_core.sql`)

| Table                      | Notes                                                                                               |
| -------------------------- | --------------------------------------------------------------------------------------------------- |
| `users`                    | email (citext-normalized), scrypt password hash, display name                                       |
| `sessions`                 | **hash of** the session token, expiry, CSRF token hash, user agent                                  |
| `organizations`            | name, slug, creator                                                                                 |
| `organization_memberships` | `(organization_id, user_id)` unique, role: owner/admin/analyst/viewer                               |
| `apps`                     | name, platform, bundle id, **reporting timezone**, default currency, `primary_attribution_provider` |
| `audit_log`                | append-only: a trigger raises on UPDATE and DELETE                                                  |

Every tenant-scoped table carries `organization_id` and is always queried with
it in the `WHERE` clause — never resolved from a client-supplied value alone.

### Integrations (`0002_integrations.sql`)

| Table                      | Notes                                                                                                                                          |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `integration_providers`    | Catalogue of 20 providers with `status` (`available` / `planned`). Three are available in Phase 0A                                             |
| `integration_connections`  | One stored credential's worth of connection: provider, display name, status, last validation result                                            |
| `integration_credentials`  | `bytea` ciphertext, iv, auth tag, key version, fingerprint. **No plaintext column exists**                                                     |
| `integration_accounts`     | A provider-side ad account or MMP app, discovered or entered                                                                                   |
| `integration_app_bindings` | Which connection+account serves which role for which app. A partial unique index enforces **exactly one active `primary_attribution` per app** |
| `provider_capabilities`    | Per connection and optionally per account: capability key, supported, `declared`/`probed`, evidence                                            |

### Sync (`0003_sync.sql`)

| Table            | Notes                                                                                                                 |
| ---------------- | --------------------------------------------------------------------------------------------------------------------- |
| `sync_jobs`      | Schedule per (app, connection, data type): interval, lookback, `next_run_at`                                          |
| `sync_runs`      | One execution: window, attempt, status, rows fetched/normalized/rejected, error class and message, `checkpoint` jsonb |
| `sync_cursors`   | High-water mark per stream, so scheduled syncs know where to resume                                                   |
| `sync_errors`    | Every failure, classified and retained for the errors panel                                                           |
| `data_freshness` | Per (app, connection, data type): last attempt, last success, latest provider data date, expected freshness, status   |

### Raw ingestion (`0004_raw_ingestion.sql`)

`raw_ingestion_batches` stores each provider page as received, with a payload
hash. A unique index on `(connection_id, app_id, data_type, payload_hash,
window_start, window_end, page_number)` makes re-ingestion a no-op. This is what
makes a normalization fix replayable without re-hitting the provider.

### Canonical marketing model (`0005_marketing.sql`)

`marketing_accounts` → `marketing_campaigns` → `marketing_ad_groups` →
`marketing_ads`, plus `marketing_creatives`. Each row keeps
`external_*_id` (the provider's id) alongside MART's own uuid, so lineage back to
the source is never lost.

`marketing_daily_metrics` is the delivery fact table:

```
organization_id, app_id, connection_id, provider_key,
report_date, grain('report_date'),
external_campaign_id, external_ad_group_id, external_ad_id, external_creative_id,
country, platform, currency,
spend, impressions, clicks, link_clicks, reach, frequency,
dimension_hash,                     -- sorted dimension tuple, SHA-256
restatement_generation, last_restated_at, observed_at, sync_run_id
UNIQUE (connection_id, app_id, dimension_hash)
```

### Canonical attribution model (`0006_attribution.sql`)

`attribution_sources` normalizes media-source spellings ("facebook ads",
"Facebook Ads", "facebook_ads") to one canonical key, without ever merging two
genuinely different sources.

- `attribution_daily_metrics` — installs at **install-date** grain, with
  `attribution_certainty` (`deterministic` / `probabilistic` / `modeled`) so a
  SKAN-style estimate is never silently mixed with a deterministic match.
- `attribution_event_metrics` — event counts at event date.
- `attribution_revenue_metrics` — revenue with an explicit `grain` column and
  `revenue_type`, plus its currency.

All three carry the same `dimension_hash` + restatement columns as the marketing
fact table, and the same uniqueness rule.

### Mapping and quality (`0007_mapping_quality.sql`)

`provider_entity_mappings` links a marketing entity to an attribution entity:

```
entity_type, source_provider, source_external_id, target_provider, target_external_id,
method (stable_external_id | tracking_parameter | name_fallback | manual),
confidence, status (see below), candidates jsonb, evidence jsonb,
verified_by_user_id, verified_at
```

Statuses: `matched_exact`, `matched_confident`, `matched_fallback`, `ambiguous`,
`unmatched`, `manually_verified`, `rejected`. Only the first two plus
`manually_verified` are treated as authoritative.

`data_quality_findings` records deterministic checks run during every sync
(missing campaign id, spend without delivery, zero-impression spend, currency
mismatch, gap in a date range), each with a severity and enough detail to act on.

## Restatement detection

The fact upsert returns whether the row was inserted and whether an existing row
actually changed:

```sql
ON CONFLICT (connection_id, app_id, dimension_hash) DO UPDATE SET
  ...,
  restatement_generation = <table>.restatement_generation + (CASE WHEN <changed> THEN 1 ELSE 0 END),
  last_restated_at       = CASE WHEN <changed> THEN now() ELSE <table>.last_restated_at END
RETURNING (xmax = 0) AS inserted,
          (xmax <> 0 AND last_restated_at = now()) AS restated
```

A re-sync that finds identical numbers touches `observed_at` and nothing else. A
re-sync that finds a revision is counted as a restatement and is visible in the
UI.

## Indexes

Every fact table is indexed on `(organization_id, app_id, <date>)` for the
dashboard's range queries, on `(connection_id, app_id, dimension_hash)` for the
upsert, and on `(organization_id, app_id, external_campaign_id)` for the campaign
table and reconciliation joins. Sync tables are indexed on their claim
predicates so `SKIP LOCKED` polling stays cheap.

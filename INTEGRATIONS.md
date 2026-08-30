# Integrations

## Verification status — read this first

Phase 0A was implemented without access to any live provider account, and the
build environment has no outbound access to the provider APIs. Meta and
AppsFlyer are therefore documentation-verified only. Tenjin is the exception:
its wire format was corrected against **real responses from a live Tenjin
account**, so the shapes below are observed rather than assumed — but MART's own
HTTP client still has not completed a request to `api.tenjin.com` from this
environment, so the end-to-end run belongs to the operator (see the diagnostic
in [DEVELOPMENT.md](DEVELOPMENT.md)).

| Provider                       | Contract source                           | Verified against docs                                                                    | Verified against a live account |
| ------------------------------ | ----------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------- |
| Meta Ads (Marketing API v21.0) | Published Graph API reference             | Yes — endpoints, fields, breakdowns, paging, error envelope                              | **No**                          |
| AppsFlyer (Pull API v5)        | AppsFlyer developer hub                   | Yes — raw/agg export paths, parameters, CSV columns, plan-gated 200-with-prose behaviour | **No**                          |
| Tenjin (v2)                    | Real responses from a live Tenjin account | Yes — endpoint, parameters, `group_by` enum, JSON:API envelope, pagination               | **Partly — see below**          |

What that means in practice is set out under each provider. Nothing in this
repository should be read as a claim that a connector has been proven end to end
against the real service. The one thing that _has_ been proven is MART's own
behaviour — request construction, pagination, CSV parsing, normalization,
idempotency, metric arithmetic — against a local fixture server that speaks those
documented shapes (see [DEVELOPMENT.md](DEVELOPMENT.md)).

## The abstraction

Two interfaces, defined in `packages/integrations/src/types.ts`:

- `MarketingNetworkProvider` — `listAccounts`, `syncStructure`, `syncPerformance`
- `AttributionProvider` — `listApps`, `syncInstalls`, `syncEvents`, `syncRevenue`

Both extend `ProviderBase` (`validateConnection`, `getCapabilities`, optional
`validateAccount`). The registry in `registry.ts` maps a provider key to a
descriptor:

```ts
{
  providerKey, category, displayName, credentialKind,
  credentialFields: [{ name, label, help, secret }],   // drives the connect form
  supportsAccountDiscovery: boolean,                    // drives the account UI
  create({ credentials, http }): AnyProvider
}
```

Because the connect form, the account picker and the sync planner all read the
descriptor, no UI or core code contains a provider name. Adding TikTok Ads or
Adjust means writing an adapter and adding one registry entry.

### Capabilities

```ts
type CapabilityDeclaration = {
  key: string;
  supported: boolean;
  discoveryMethod: 'declared' | 'probed';
  detail?: Record<string, unknown>; // evidence, or the reason it is absent
};
```

`declared` is a documented property of the API. `probed` was measured against the
customer's account, because it depends on their plan. Account-scoped rows
supersede connection-scoped ones. The Command Center and the integrations page
both show the discovery method, so an operator can tell a claim from a
measurement.

## Meta Ads

- **Base**: `https://graph.facebook.com`, API version pinned in config
  (`v21.0` by default).
- **Auth**: `Authorization: Bearer <token>`. The token is never placed in a URL,
  so it cannot leak through a log line, a proxy, or a provider error echo.
- **Read-only by construction**: the adapter contains no POST/DELETE path. There
  is no code in MART that can mutate a Meta object.
- **Endpoints used**: `me/adaccounts`, `act_.../campaigns`, `act_.../adsets`,
  `act_.../ads`, `act_.../insights` at `level=campaign` with `time_increment=1`.
- **Pagination**: Graph cursor paging, following `paging.next` verbatim (it
  already carries every parameter), bounded at 200 pages so a broken cursor
  cannot loop forever.
- **Budgets**: `daily_budget` / `lifetime_budget` arrive in minor units and are
  converted on the way in, so a $2,500 budget is never displayed as $250,000.
- **Country breakdown is probed, not assumed.** Availability varies by account
  and campaign type. If Meta rejects the breakdown with `invalid_request`, the
  capability is recorded as unsupported with the reason and the window is re-read
  without it, carrying a warning on the run — rather than failing the sync or
  silently dropping a dimension.
- **Restatement**: Meta revises recent days; the scheduled sync always re-reads
  the lookback window and upserts.
- **Rejected rows**: an insight row with no date or no `campaign_id` is counted
  as rejected rather than normalized into a row with invented dimensions.

## AppsFlyer

- **Base**: `https://hq1.appsflyer.com`.
- **Auth**: `Authorization: Bearer <V2 API token>`.
- **Paths** (Pull API v5):
  - raw: `/api/raw-data/export/app/{app-id}/{report}/v5`
  - aggregate: `/api/agg-data/export/app/{app-id}/{report}/v5`
  - reports used: `installs_report`, `in_app_events_report`,
    `partners_by_date_report`.
- **Responses are CSV**, parsed with an RFC 4180 parser and header
  normalization, so column-order or letter-case changes do not break ingestion.
- **No app-listing endpoint exists.** The Pull API is scoped to one app and
  offers no way to enumerate the apps a token can read. `listApps()` therefore
  returns `[]` and `supportsAccountDiscovery` is `false`: MART asks for the app
  id, then validates it with a one-day aggregate probe before storing it. It does
  not pretend to enumerate.
- **Plan-gated reports return HTTP 200 with a prose body.** The adapter detects
  that text and classifies it as `authorization_error` rather than parsing the
  sentence as a CSV header row.
- **Raw-data access is probed.** If raw export is unavailable, installs come from
  `partners_by_date_report` instead, and the `campaign_id` capability becomes
  genuinely `false` — that report has no campaign, ad set or ad ids. The
  consequence is visible everywhere downstream: reconciliation can only offer
  name-fallback candidates, the campaign table withholds attribution figures, and
  a data-quality finding explains why.
- **Revenue** is emitted at `event_date` grain from `event_revenue_usd` /
  `event_revenue`, with the currency carried through. It is not cohort revenue.

## Tenjin

- **Base**: `https://api.tenjin.com/v2` (configurable). The version lives in the
  base URL, so adapter paths are version-free and cannot concatenate into
  `.../v2/api/v2/apps`.
- **Auth**: API key as `Authorization: Bearer <key>`. Never a query parameter — a
  token in a URL leaks through logs, proxies and the provider's own error echoes.
- **Apps**: `GET /apps` returns resource identifiers only — `{"id": "...", "type":
"app"}` with no attributes — so each id is enriched with `GET /apps/{id}`, which
  carries `name`, `bundle_id`, `platform` and `store_id`. Key-shaped attributes on
  that response (`public_key`, `ios_shared_secret`,
  `facebook_referrer_decryption_key`) are dropped before anything is stored or
  displayed. When an app still has no name, MART shows the raw id **as** an id
  rather than inventing one.
- **Reporting**: `GET /reports/user_acquisition`, with `start_date`, `end_date`,
  `granularity=daily`, `app_ids` (plural, comma-separated UUIDs — the bundle id is
  not accepted), `metrics` and `format=json`.
- **`group_by` is a closed enum**, not a free dimension list: `app`, `channel`,
  `country`, `site`, `campaign`, `campaign,country`, `channel,app`,
  `channel,app,country`, `creative`. MART sends `campaign,country`, the richest
  grouping it can use; date, platform and ad network are not groupable and arrive
  on the row regardless. Daily bucketing comes from `granularity`, not grouping.
- **Envelope**: rows are JSON:API resources — `{"data": [{"type": "report",
"attributes": {…}}], "has_more": false}` — so metrics live under `attributes`,
  not at the top of the row. Pagination is `has_more` plus an opaque cursor;
  `has_more` with no cursor stops the loop with a warning rather than truncating
  the window silently.
- **Metrics**: the adapter uses **`tracked_installs`, not `installs`** — the two
  are different measures in Tenjin (Tenjin-attributed versus network-reported),
  and using the wrong one produces a wrong CPI.
- **Campaign identity**: `campaign_id` is a _Tenjin_ campaign UUID, not the ad
  network's campaign id, and `name` is Tenjin's campaign name. Stable-id matching
  to Meta therefore cannot work, and reconciliation correctly falls back to
  name candidates labelled non-authoritative.
- **Revenue** comes from the same report — `revenues` (in-app) and `pub_rev` (ad)
  — at `event_date` grain, consistent with AppsFlyer, so the two MMPs remain
  interchangeable behind the interface. `total_rev` is their sum and is not
  emitted, because doing so would double-count.
- **Events**: the user-acquisition report has no in-app event breakdown, so
  `syncEvents` returns an empty batch with a warning. The capability is reported
  absent rather than approximated — an empty stream that never called the API is
  not a healthy one.
- **Not imported**: `*_Nd` cohort metrics (`revenues_Nd`, `roas_Nd`,
  `retention_Nd`). Tenjin declares `cohort_reporting: true` as a capability, but
  Phase 0A does not import cohort data — declaring a capability is not the same as
  using it, and cohort ROAS remains unavailable (see [METRICS.md](METRICS.md)).
- **Still unproven**: MART's own client has not completed a live request from the
  build environment. `node packages/integrations/dist/cli/diagnose.js tenjin
attribution_installs` (and `attribution_revenue`) runs the real code path
  against the real API and prints the request, the status, the row counts and the
  first normalized row, without ever printing the key.

## Error classification

Every provider failure is mapped to one class. This is what makes an error
message actionable instead of a stack trace.

| Class                   | Retried | Typical cause and what MART does                                                                 |
| ----------------------- | ------- | ------------------------------------------------------------------------------------------------ |
| `authentication_error`  | no      | Bad or revoked token. Connection marked, user asked to reconnect                                 |
| `authorization_error`   | no      | Token valid, resource or report not permitted for this plan                                      |
| `expired_credential`    | no      | Token expired; reconnect prompt                                                                  |
| `rate_limited`          | **yes** | Backoff with jitter, honouring the provider's signal                                             |
| `provider_unavailable`  | **yes** | 5xx; retried up to `SYNC_MAX_ATTEMPTS`                                                           |
| `timeout`               | **yes** | Network stall                                                                                    |
| `invalid_request`       | no      | MART asked for something the account cannot serve — often the trigger for a capability downgrade |
| `schema_change`         | no      | The response no longer matches the contract. Fails loudly and visibly                            |
| `pagination_failure`    | no      | Cursor loop or page ceiling                                                                      |
| `data_validation_error` | no      | Rows arrived but failed canonical validation                                                     |
| `normalization_error`   | no      | A bug in mapping, surfaced rather than swallowed                                                 |
| `database_error`        | no      | Storage failure during a run                                                                     |
| `unknown_error`         | no      | Anything unclassified — never silently ignored                                                   |

Each class carries a user-facing message written for an operator, separate from
the technical message kept for the log.

## Adding a provider

1. Implement `MarketingNetworkProvider` or `AttributionProvider` in
   `packages/integrations/src/providers/`.
2. Declare capabilities honestly. Probe anything that depends on the customer's
   plan; never declare a capability you have not checked.
3. Add one `ProviderDescriptor` to the registry, including the credential fields
   the connect form should collect.
4. Set the catalogue row's `status` to `available` in a migration.
5. Add adapter tests, including at least one that proves a missing capability
   changes real behaviour rather than only a label.

No change to routes, queries, metrics or the dashboard is required.

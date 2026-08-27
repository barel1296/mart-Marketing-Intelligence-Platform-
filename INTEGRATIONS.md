# Integrations

## Verification status — read this first

Phase 0A was implemented without access to any live provider account. No Meta
Ads token, no AppsFlyer token and no Tenjin API key were available in the build
environment, so **no MART connector has been run against a real provider API.**

| Provider                       | Contract source                                                | Verified against docs                                                                    | Verified against a live account |
| ------------------------------ | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------- |
| Meta Ads (Marketing API v21.0) | Published Graph API reference                                  | Yes — endpoints, fields, breakdowns, paging, error envelope                              | **No**                          |
| AppsFlyer (Pull API v5)        | AppsFlyer developer hub                                        | Yes — raw/agg export paths, parameters, CSV columns, plan-gated 200-with-prose behaviour | **No**                          |
| Tenjin                         | Metric catalogue verified; **REST wire format not verifiable** | Partial — see below                                                                      | **No**                          |

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

- **Base**: `https://reporting.tenjin.com` (configurable).
- **Auth**: API key.
- **Verified**: the metric vocabulary. Tenjin's user-acquisition report uses
  `tracked_installs`, `tracked_clicks`, `tracked_impressions` and
  `revenues`/`pub_rev`/`total_rev`. In particular the adapter uses
  **`tracked_installs`, not `installs`** — the two are different measures in
  Tenjin, and using the wrong one produces a wrong CPI.
- **Not verified**: the REST wire format. The exact endpoint paths, parameter
  names and response envelope could not be confirmed against live documentation
  or a live account in this environment. Three things follow:
  1. Endpoint paths are **configurable** (`TenjinEndpoints`), defaulting to
     `/api/v2/user_acquisition` and `/api/v2/apps`, so a corrected contract is a
     configuration change rather than a code change.
  2. The response reader accepts several plausible envelopes (a bare array, or
     `data` / `results` / `rows` / `report`) and **fails loudly** with a
     `schema_change` error on anything else, rather than guessing.
  3. Tenjin declares `cohort_reporting: true` as a capability, but Phase 0A does
     **not** import cohort data — declaring a capability is not the same as using
     it, and cohort ROAS remains unavailable (see [METRICS.md](METRICS.md)).
- **Revenue** is emitted at `event_date` grain, consistent with AppsFlyer, so the
  two MMPs remain interchangeable behind the interface.

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

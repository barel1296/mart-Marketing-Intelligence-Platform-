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
| Tenjin (v2)                    | Real responses from a live Tenjin account | Yes — saved-report architecture, metric catalogue, JSON:API envelope, pagination         | **Partly — see below**          |

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

### Reporting is addressed by saved report, not by report family

This is the part that is easy to get wrong, and MART got it wrong first:

```
GET /v2/reports/user_acquisition   ->  400 {"error":"Saved report not found"}
```

`GET /v2/reports/{id}` takes a **saved report UUID**. A report family name in
that position is read as an id, and no such report exists. The definitions live
in a separate family:

| Purpose          | Endpoint                     |
| ---------------- | ---------------------------- |
| List definitions | `GET /v2/saved_reports`      |
| One definition   | `GET /v2/saved_reports/{id}` |
| Pull report data | `GET /v2/reports/{id}`       |

So every Tenjin sync is two calls: discover, then pull.

### MART reads saved reports and never writes them

Discovery is `GET /v2/saved_reports?report_type=user_acquisition&per_page=1000`.
Each definition is parsed down to the fields compatibility turns on: `id`,
`name`, `report_type`, `app_ids`, `metrics`, `granularity`, `group_by`,
`past_number_days`, `channel_ids`.

A saved report is usable for a stream only if **all** of these hold:

| Rule                                | Why                                                                                                                                  |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `report_type` is `user_acquisition` | Other families report different facts                                                                                                |
| covers the bound app                | `app_ids` contains it, or is empty (account-wide). A report wider than the bound app imports only rows that carry an `app_id` for it |
| has the metrics                     | installs need `tracked_installs`; revenue needs any one usable revenue metric (below)                                                |
| `granularity` is `daily`            | Weekly, monthly and totals buckets cannot be split back into days without inventing data                                             |
| `group_by` is one MART stores       | Every dimension the report splits on must be one MART keeps                                                                          |

#### A wider report imports only rows that name their app

`app_ids` empty means "every app in the account", and a report may also list
several. MART admits both, because the operator's report is not MART's to
change — but the admission rests entirely on filtering the rows by `app_id`,
and a row can only be filtered if it carries one. The grouping MART itself
ranks highest, `campaign,country`, carries no app dimension at all.

So a row without an `app_id` from a report wider than the bound app is
**dropped and counted**, never assumed to belong to the bound app: writing it
would sum another app's installs and revenue into this app's KPIs, silently and
with no warning, since a filter that never matched reports nothing skipped. The
run says how many rows could not be attributed and what to change (add `app` to
the report's `group_by`, or save a report for this app alone). A report Tenjin
has already scoped to exactly the bound app needs none of this, and is
preferred when several reports are compatible.

#### `group_by` is normalized, never string-compared

Tenjin spells the same choice two ways depending on which end of the API you
are on. The ad-hoc report parameter takes `campaign,country`; a saved report
definition comes back as `campaign_country`. Comparing either spelling against
a fixed string rejects a perfectly valid report — which is exactly what
happened to a real account's `MART - Reveal Rush UA`.

`normalizeGroupBy()` parses either separator into MART's dimension vocabulary:

| Tenjin `group_by`                       | MART dimensions         |
| --------------------------------------- | ----------------------- |
| `campaign_country` / `campaign,country` | campaign + country      |
| `channel_app_country`                   | channel + app + country |
| `campaign`, `country`, `channel`, `app` | that single dimension   |
| `site`, `creative`                      | refused — see below     |

A token that maps to no known dimension is reported as unrecognized and blocks
the report, rather than being quietly dropped.

`site` and `creative` groupings are **refused**: MART stores neither dimension,
so many rows would share one storage key and overwrite each other — installs
would silently disappear. A campaign-less grouping (`app`, `channel`, …) is
accepted with a note that nothing can be reconciled to Meta from it.

When several reports qualify, the richest grouping wins, then the report that
splits revenue into components, then the most metrics, then the longest
`past_number_days`.

**When none qualifies, MART does not create one.** The sync fails with
`configuration_required` carrying the machine-readable code
`tenjin_saved_report_required`, the exact definition to create, and the reason
each existing report was refused. A read-only integration must not reshape
someone's Tenjin account to make its own life easier.

### Date range

MART asks for its own window with `start_date` and `end_date`, then checks what
came back rather than assuming it was honoured — a saved report carries its own
rolling `past_number_days`, and that period is the operator's setting, not
MART's. Rows outside the requested window are not imported, and a window the
report could not cover is reported as a warning naming the range that actually
arrived. A partial window is never presented as a whole one.

This behaviour is a runtime check precisely because the interaction between
`past_number_days` and an explicit range could not be confirmed against the
official API reference from the build environment (`api-docs.tenjin.com` is
unreachable there). Whatever the API does, MART reports what it received.

### Rows

- **Envelope**: JSON:API resources — `{"data": [{"type": "report", "attributes":
{…}}]}` — so metrics live under `attributes`, not at the top of the row.
  Pagination follows `links.next` when present (same-origin only) and otherwise
  `has_more` plus an opaque cursor.
- **Metrics**: the adapter uses **`tracked_installs`, not `installs`** — the two
  are different measures in Tenjin (Tenjin-attributed versus network-reported),
  and using the wrong one produces a wrong CPI.
- **Campaign identity**: `campaign_id` is a _Tenjin_ campaign UUID, not the ad
  network's campaign id, and `name` is Tenjin's campaign name. Stable-id matching
  to Meta therefore cannot work, and reconciliation correctly falls back to name
  candidates labelled non-authoritative.
- **Revenue** needs a vocabulary layer, because Tenjin has two ad-revenue
  metrics that mean different things and two matching totals:

  | Tenjin metric                | Meaning                            | MART `revenue_type`  |
  | ---------------------------- | ---------------------------------- | -------------------- |
  | `revenues`                   | In-app purchase revenue            | `iap`                |
  | `ad_mediation_revenue`       | Ad revenue via the mediation layer | `ad`                 |
  | `pub_rev`                    | Ad revenue reported by networks    | `ad`                 |
  | `total_ad_mediation_revenue` | `revenues + ad_mediation_revenue`  | `total`, last resort |
  | `total_rev`                  | `revenues + pub_rev`               | `total`, last resort |

  A real account settles why this matters: its report carries
  `ad_mediation_revenue: 5.89` while `total_rev` is `0.0`, because that total
  does not include mediation revenue. Requiring `pub_rev` rejects the report;
  reading `total_rev` as "all revenue" understates the account.

  Both ad variants normalize to MART's single `ad` type. When a row carries
  both they are **not** summed — they are different measures, and adding them
  could double-count the same impressions — so MART imports
  `ad_mediation_revenue` and warns, naming what it left out. A combined figure
  is imported only when the row carries no component at all, and then as
  `revenue_type=total`, never relabelled as IAP or ad: storage sums every
  revenue row for a date, so a total beside its own parts would double-count.

- **Not imported**: `*_Nd` cohort metrics (`revenues_Nd`, `roas_Nd`,
  `retention_Nd`). Tenjin declares `cohort_reporting: true` as a capability, but
  Phase 0A does not import cohort data — declaring a capability is not the same as
  using it, and cohort ROAS remains unavailable (see [METRICS.md](METRICS.md)).

### The campaign directory settles what names cannot — at whichever level it means

`GET /v2/campaigns?app_id={uuid}` returns each Tenjin campaign with a
`remote_campaign_id`. Reporting rows do not carry it, which is why matching
began with names.

**The field name does not tell you its entity level.** On real accounts every
one of those values is a Meta **ad set** id, not a campaign id:

```
120254846425720119 -> marketing_ad_groups.external_ad_group_id -> campaign 120254846425650119
120254846425690119 -> marketing_ad_groups.external_ad_group_id -> campaign 120254846425650119
120254889912050119 -> marketing_ad_groups.external_ad_group_id -> campaign 120254889912060119
```

Reading it as a campaign id resolves nothing, and looks identical to a provider
that published nothing at all.

So the level is a property of the **provider pair**, and it lives in
`remoteIds.ts` next to that pair rather than in the reconciliation core. The
core asks "what marketing entity is this, and which campaign does it belong
to"; it never assumes an answer.

| Pair              | Levels tried, in order  |
| ----------------- | ----------------------- |
| Tenjin → Meta Ads | ad group, then campaign |
| anything else     | campaign                |

The default is deliberately conservative: a pair MART has not verified gets
campaign-only, so one pair's semantics can never leak into another's.

Resolution order for a marketing campaign:

1. an attribution campaign whose remote id resolves to an **ad group** under it
   → `provider_remote_ad_group`, confidence 1, `matched_exact`, authoritative
2. …or resolves directly to the **campaign** → `provider_remote_campaign`, same
3. otherwise the deterministic name-embedding fallback (non-authoritative)
4. otherwise unmatched, or ambiguous where several parents remain possible

**Several attribution campaigns resolving to one marketing campaign is
aggregation, not ambiguity** — a static and a video ad set under one campaign is
the normal shape. Their metrics are summed onto the parent. Ambiguity is
reserved for the case where a _name_ leaves more than one parent possible.

Every mapping records its whole path — source attribution campaign, source
remote id, resolved entity type and id, parent campaign, method, confidence,
authoritative — so it explains itself rather than asserting itself.

**A remote id that resolves at no level never vetoes a name match.** It cannot
discriminate between campaigns MART holds, so the name evidence stands; it is
counted as `declarationsOutsideStructure` and surfaced by the audit CLI, which
prints the full resolution path per directory row plus counts by resolution
type.

### Events are `not_implemented`, not fresh

The user-acquisition report has no in-app event breakdown, and MART has not built
another Tenjin event source. `syncEvents` returns an empty batch marked
`not_implemented`, and the freshness row records that instead of `fresh` — a
stream that never made a request must not be presented as live data. Streams in
that state are excluded from an app's worst-case data-health rollup, so an
unimplemented stream neither hides a real problem nor invents one.

### Still unproven

MART's own client has not completed a live request from the build environment;
`api.tenjin.com` is unreachable there. The diagnostic is what closes that gap on
a machine that can reach it:

```
node packages/integrations/dist/cli/diagnose.js tenjin attribution_installs
node packages/integrations/dist/cli/diagnose.js tenjin attribution_revenue
```

It prints the saved reports discovered, MART's verdict on each, the report it
chose, the request, the status, the row counts and the freshness the run would
record — and never the key.

## Error classification

Every provider failure is mapped to one class. This is what makes an error
message actionable instead of a stack trace.

| Class                    | Retried | Typical cause and what MART does                                                                                                                            |
| ------------------------ | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `authentication_error`   | no      | Bad or revoked token. Connection marked, user asked to reconnect                                                                                            |
| `authorization_error`    | no      | Token valid, resource or report not permitted for this plan                                                                                                 |
| `expired_credential`     | no      | Token expired; reconnect prompt                                                                                                                             |
| `rate_limited`           | **yes** | Backoff with jitter, honouring the provider's signal                                                                                                        |
| `provider_unavailable`   | **yes** | 5xx; retried up to `SYNC_MAX_ATTEMPTS`                                                                                                                      |
| `timeout`                | **yes** | Network stall                                                                                                                                               |
| `invalid_request`        | no      | MART asked for something the account cannot serve — often the trigger for a capability downgrade                                                            |
| `schema_change`          | no      | The response no longer matches the contract. Fails loudly and visibly                                                                                       |
| `pagination_failure`     | no      | Cursor loop or page ceiling                                                                                                                                 |
| `data_validation_error`  | no      | Rows arrived but failed canonical validation                                                                                                                |
| `normalization_error`    | no      | A bug in mapping, surfaced rather than swallowed                                                                                                            |
| `database_error`         | no      | Storage failure during a run                                                                                                                                |
| `configuration_required` | no      | Credential fine, request fine, but the provider account is missing something the sync needs (a saved report). MART names what to create and changes nothing |
| `unknown_error`          | no      | Anything unclassified — never silently ignored                                                                                                              |

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

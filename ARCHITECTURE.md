# Architecture

## Processes

```
Browser
   │  same-origin HTTPS, HttpOnly session cookie + double-submit CSRF token
   ▼
Next.js Web App (apps/web)          ── server components render from the API;
   │  /api/* rewritten to the API      client islands only for mutations
   ▼
Fastify API / BFF (apps/api)        ── authn, authz, validation, orchestration
   │
   ▼
PostgreSQL                          ── the only datastore. No queue, no cache,
   ▲                                   no warehouse, no object store.
   │
Background Sync Worker (apps/worker)── claims runs, calls providers, writes facts
   │
   ▼
Provider APIs (Meta, AppsFlyer, Tenjin) — read-only, outbound only
```

Four properties follow from this shape and are enforced in code:

- **The browser never calls a provider.** It has no provider credentials and no
  provider hostnames. Everything it sees came from MART's own storage.
- **The API never performs a sync inline.** It enqueues; the worker executes. A
  slow provider cannot hold an HTTP connection open, and a triggered sync
  survives an API restart.
- **The worker never serves user traffic.** It exposes only `/health` and
  `/ready` on its own port.
- **PostgreSQL is the single source of truth,** including the job queue
  (`FOR UPDATE SKIP LOCKED`), so there is nothing to keep in sync with it.

## Request flow

A dashboard page load:

1. The browser requests `/apps/:id` from Next.js.
2. The server component calls the API over the internal URL, forwarding the
   user's cookies. Authorization is therefore evaluated server-side, per request,
   against the real session — never against a client-supplied identity.
3. `withOrganization` / `withApp` resolve the session, verify membership, verify
   the app belongs to that organization, and check the required permission. A
   caller who is not a member of an organization gets **404, not 403**, so the
   API does not confirm that an id exists.
4. Route handlers read through repositories and the metric service. No route
   builds SQL by string concatenation; every query is parameterized.
5. The response is `Cache-Control: no-store` for anything tenant-scoped.

A mutation from the browser goes through `apiMutate`, which sends the CSRF token
from the readable `mart_csrf` cookie in the `x-mart-csrf` header. The API
compares it to the value bound to the session cookie (double submit). Login and
registration are exempt because no session exists yet.

## Packages

| Package               | Responsibility                                                                                     | Depends on                              |
| --------------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------- |
| `@mart/shared`        | Canonical types, enums, error taxonomy, date maths, dimension hashing, redaction patterns          | —                                       |
| `@mart/config`        | zod-validated environment. Refuses to boot on a bad value                                          | shared                                  |
| `@mart/observability` | pino logger with dual redaction, `AsyncLocalStorage` request context, in-process counters          | shared, config                          |
| `@mart/db`            | Pool, migrations, repositories. The only place SQL is written                                      | shared, config, observability           |
| `@mart/auth`          | scrypt password hashing, session issue/resolve, RBAC matrix                                        | shared, db                              |
| `@mart/integrations`  | Provider adapters, capability model, HTTP client, sync engine, reconciliation, data-quality checks | shared, config, db, observability       |
| `@mart/metrics`       | Governed metric registry, aggregate loaders, dashboard queries                                     | shared, db                              |
| `apps/api`            | HTTP surface                                                                                       | all of the above                        |
| `apps/worker`         | Sync execution loop                                                                                | integrations, db, config, observability |
| `apps/web`            | Dashboard                                                                                          | — (talks to the API over HTTP only)     |

The dependency direction is strict: nothing in `db`, `metrics` or `apps/web`
knows a provider's name. Provider-specific behaviour exists only inside
`packages/integrations/src/providers/*`.

## Provider abstraction

```ts
interface ProviderBase {
  providerKey;
  category;
  validateConnection(): Promise<ConnectionHealth>;
  getCapabilities(externalAccountId?): Promise<CapabilityDeclaration[]>;
  validateAccount?(externalAccountId): Promise<ConnectionHealth>;
}

interface MarketingNetworkProvider extends ProviderBase {
  listAccounts();
  syncStructure(params);
  syncPerformance(params);
}

interface AttributionProvider extends ProviderBase {
  listApps();
  syncInstalls(params);
  syncEvents(params);
  syncRevenue(params);
}
```

`AppsFlyer` and `Tenjin` implement `AttributionProvider` identically from the
outside. Everything that differs — endpoints, auth, CSV vs JSON, field names,
report semantics — is confined to the adapter. The registry maps a provider key
to a descriptor (category, credential fields the connect form must collect,
whether account discovery is possible, and a factory). Adding a provider means
adding an adapter and one registry entry; no route, query, metric or component
changes.

Optional interface members carry real meaning rather than convenience:
`validateAccount` exists because AppsFlyer's Pull API can only be proven against
a specific app, and the API calls it when it is present rather than branching on
a provider name.

### Capability model

A capability is either **declared** (a documented property of the provider's API)
or **probed** (confirmed against the customer's actual account, because it
depends on their plan or account configuration). Capabilities are stored per
connection and, once an account is selected, per account — and the account-scoped
row wins, because it was measured rather than assumed.

Capabilities drive behaviour, not just display. An AppsFlyer account without
raw-data access genuinely has no campaign ids, so `campaign_id` is probed to
`false`, installs are imported from the aggregate report, and reconciliation can
only produce labelled name-fallback candidates. The dashboard then withholds
attribution figures from the campaign table, because there is no authoritative
link to attach them to.

## Sync engine

```
planSyncs ──► enqueueSync ──► [sync_runs: queued]
                                   │  worker claims with SKIP LOCKED
                                   ▼
                           executeSync(run)
                                   │
      ┌────────────────────────────┼───────────────────────────┐
      ▼                            ▼                           ▼
 chunk window            fetch page → persist raw       normalize → upsert
 (SYNC_WINDOW_CHUNK_DAYS)  (raw_ingestion_batches)      (facts, dimension_hash)
      │                                                        │
      └──────── checkpoint completed windows ◄─────────────────┘
                                   │
                     advance cursor, write freshness,
                     classify errors, retry or fail
```

Properties that matter:

- **Restatement-aware.** Ad networks revise recent days. Every scheduled sync
  re-reads the last `SYNC_RESTATEMENT_LOOKBACK_DAYS` days and upserts. A changed
  value increments `restatement_generation` and stamps `last_restated_at`, so a
  revision is visible rather than silent.
- **Idempotent.** Facts are keyed on `(connection_id, app_id, dimension_hash)`
  where the hash is built from the sorted dimension tuple. Re-running a window
  updates rows; it never duplicates them.
- **Checkpointed.** Each date chunk that completes is recorded on the run. A
  retry resumes rather than restarting, so a failure at day 27 of 30 does not
  discard 26 days of work.
- **Classified errors.** Every provider failure is mapped to one of thirteen
  error classes (`authentication_error`, `rate_limited`, `schema_change`, …).
  Only `rate_limited`, `provider_unavailable` and `timeout` are retried, with
  exponential backoff and jitter, up to `SYNC_MAX_ATTEMPTS`. An authentication
  failure marks the connection instead of retrying into a lockout.
- **Raw before normalized.** Every provider page is persisted before it is
  interpreted, deduplicated by payload hash, so a normalization bug can be fixed
  and replayed without re-hitting the provider.

## Reconciliation

After a sync, campaigns from the marketing network are matched to campaigns seen
by the MMP, in strict precedence:

1. `matched_exact` — identical stable external id.
2. `matched_confident` — a tracking parameter carries the network's id.
3. `matched_fallback` — normalized names agree, exactly one candidate on each
   side. **Never authoritative.**
4. `ambiguous` — more than one plausible candidate. Surfaced for a human.
5. `unmatched` — no candidate. Surfaced on both sides.

`manually_verified` outranks everything and survives recomputation: a human
decision is not overwritten by the next sync. Mapping coverage counts only
authoritative statuses, so it cannot be inflated by name guessing.

## Observability

- Structured JSON logs (pino) with an `AsyncLocalStorage` request context, so
  every line carries `requestId`, `organizationId` and `userId` where known.
- Two layers of redaction: pino's own path-based redaction, plus a recursive
  key-pattern scrubber applied to anything logged as an object. A unit test
  asserts that a token placed at any depth never reaches the output.
- `/health` (liveness), `/ready` (database + migration state) and
  `/metrics-internal` (counters, queue depth) on the API; `/health` and `/ready`
  on the worker, where readiness also requires a recent worker tick.

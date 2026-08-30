# Development

## Docker (nothing to install but Docker)

Start:

```bash
docker compose up --build
```

Open:

```
http://localhost:3000
```

Stop:

```bash
docker compose down
```

Reset local database:

```bash
docker compose down -v
```

This brings up PostgreSQL, the migration runner, the fixture provider, the API,
the worker and the web app. Migrations run automatically before the API and
worker start, the database persists in a named volume, and the provider base
URLs point at the fixture service, so the dashboard shows synthetic data and
says so.

The credential key that encrypts stored provider credentials is generated once
into a named volume rather than committed, so it survives restarts. `down -v`
discards it along with the database, which is what makes that a clean reset.

PostgreSQL is not published to the host, so it cannot collide with one you
already run; use `docker compose exec postgres psql -U mart -d mart` to reach
it. If port 3000 is taken (Grafana likes it), override the host port without
editing anything:

```bash
MART_WEB_PORT=3100 docker compose up --build
```

`MART_API_PORT` and `MART_WORKER_PORT` work the same way.

### Real providers instead of fixtures

Compose defaults every provider to the fixture server. Switch one to the real
API by exporting its base URL before starting, per provider:

```bash
export MART_META_BASE_URL=https://graph.facebook.com
export MART_TENJIN_BASE_URL=https://api.tenjin.com/v2
export MART_APPSFLYER_BASE_URL=https://hq1.appsflyer.com
docker compose up --build
```

Each integration card then shows **REAL PROVIDER** or **FIXTURE PROVIDER**, so a
real credential can never quietly route to the fixtures. To see exactly what a
stored credential does against the real API, without printing it:

```bash
docker compose exec api node packages/integrations/dist/cli/diagnose.js meta_ads
docker compose exec api node packages/integrations/dist/cli/diagnose.js tenjin
```

That prints the mode, the endpoint, whether an Authorization header was
attached, the HTTP status, the classified error and the accounts discovered. It
never prints the credential - only its fingerprint and length.

## Running natively

## Prerequisites

- Node 22+
- pnpm 10+
- PostgreSQL 16+

## Setup

```bash
pnpm install
cp .env.example .env
```

Generate a credential key and put it in `.env` as `MART_CREDENTIAL_KEY`:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Create the databases and apply migrations:

```bash
createdb mart
createdb mart_test
pnpm db:migrate
```

`pnpm db:reset` drops and recreates the schema — development only.

## Running

```bash
pnpm dev:api       # Fastify on :4000
pnpm dev:worker    # sync worker, health on :4001
pnpm dev:web       # Next.js on :3000
```

The web app proxies `/api` to the API, so the browser stays same-origin and the
session cookie is first-party. Set `MART_API_INTERNAL_URL` if the API is not on
`http://localhost:4000`.

## Running without provider credentials

You do not need a Meta, AppsFlyer or Tenjin account to exercise the full path.

```bash
pnpm dev:fixtures        # local fixture provider server on :4900
```

Then point the provider base URLs at it in `.env`:

```
META_GRAPH_BASE_URL=http://localhost:4900
APPSFLYER_BASE_URL=http://localhost:4900
TENJIN_BASE_URL=http://localhost:4900
```

Restart the API and worker, then connect with any token of 20+ characters and
use:

| Field            | Value                                                                  |
| ---------------- | ---------------------------------------------------------------------- |
| Meta ad account  | `act_FIXTURE0001` (discoverable)                                       |
| AppsFlyer app id | `id_FIXTURE_APP` (entered by hand — AppsFlyer has no listing endpoint) |
| Tenjin app id    | `FIXTURE_TENJIN_APP`                                                   |

**What the fixture server is and is not.** It is a test double that speaks the
request shapes MART's connectors send, so the real adapters, the real HTTP
client, the real sync engine and the real metric arithmetic all run. It is _not_
evidence that a connector works against the live provider, and it is not a
specification of provider behaviour. Its data is synthetic and every id starts
with `FIXTURE`, so a fixture row is recognisable anywhere it appears. The Tenjin
routes in particular follow MART's _assumed_ envelope, which is unverified — see
[INTEGRATIONS.md](INTEGRATIONS.md#verification-status--read-this-first).

The server refuses to start without `MART_ENABLE_FIXTURES=true` and refuses to
start at all when `NODE_ENV=production`. Nothing in the production code path
reads it; it is reached only because an operator repointed a base URL. Production
code never falls back to fixtures when provider data is missing — it shows an
empty state.

The fixture data is shaped to exercise the interesting cases rather than a happy
path: three Meta campaigns of which one is never reported by the MMP (unmatched),
plus MMP installs carrying no campaign id at all (a name-fallback candidate that
can never become authoritative), and an MMP install count deliberately lower than
the network's — which is what the reconciliation screen exists to show.

## Tests

```bash
pnpm test              # everything
pnpm test:unit         # pure logic, no database
pnpm test:integration  # real PostgreSQL
```

Integration tests reset the schema and run every migration on each run, so the
migrations themselves are under test. They use `TEST_DATABASE_URL` (default
`postgres://mart:mart_local_dev@localhost:5432/mart_test`).

Three kinds of integration test:

- **Tenant isolation** — every cross-tenant path, at both the API and the storage
  level.
- **Auth and RBAC** — the role ladder, and each permission boundary.
- **Sync pipeline** — idempotency, restatement, reconciliation, metric
  correctness, data-quality findings; and one suite that runs the real adapters
  over real HTTP against the fixture server.

## Checks

```bash
pnpm typecheck      # tsc -b, strict, noUncheckedIndexedAccess
pnpm lint           # eslint, no warnings allowed
pnpm format:check   # prettier
pnpm build          # every package, plus the Next production build
```

## Conventions

- **Strict TypeScript**, `NodeNext` modules, `noUncheckedIndexedAccess`. Index
  access returns `T | undefined` and must be narrowed.
- **No `any`**, no non-null assertions — both are lint errors.
- **No `console` in server code.** Use the logger from `@mart/observability`;
  `console` bypasses redaction, so it is a lint error outside CLIs and tests.
- **SQL lives in `packages/db`.** Routes and services call repositories.
- **Migrations are append-only.** Never edit an applied migration: the checksum
  check will reject it. Add a new one.
- **Comments explain why.** The reader can see what the code does; the comment
  should say what would otherwise have to be rediscovered.

## Adding a provider

See [INTEGRATIONS.md](INTEGRATIONS.md#adding-a-provider). In short: one adapter,
one registry entry, one catalogue migration, and tests that prove a missing
capability changes behaviour rather than only a label.

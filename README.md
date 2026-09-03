# MART — Phase 0A

MART is a marketing intelligence platform for mobile apps and games. **Phase 0A**
is the foundation: one honest, trustworthy data path from provider APIs to a
single dashboard.

```
CONNECT → INGEST → NORMALIZE → RECONCILE → DISPLAY
```

Concretely, at the end of Phase 0A an operator can:

1. sign in, create an organization and an app;
2. connect **Meta Ads** (read-only) and choose **AppsFlyer or Tenjin** as that
   app's single primary attribution provider;
3. select the ad account / MMP app, have the credential validated against the
   provider, and run an initial historical sync;
4. watch sync progress and failures, with errors classified and explained;
5. open one **MART Command Center** that compares Meta delivery against MMP
   attribution, shows mapping and reconciliation coverage, and states exactly
   which numbers are missing, stale, ambiguous or unmatched;
6. re-sync safely (idempotent, restatement-aware) and let a scheduled sync keep
   the data current.

Phase 0A deliberately contains **no agents, no AI, no forecasting, no pLTV, no
anomaly detection, no MMM and no write-back to any ad platform.** Every provider
call is a read. See [PHASES.md](PHASES.md) for what comes next and why.

## The rules this codebase is built on

- **Never invent data.** If a provider does not supply a number, MART shows an
  empty state or an explicit "unavailable, because…", never a zero and never a
  demo value. There is no fixture fallback in the production path.
- **Never present a mathematically invalid metric.** Ratios are computed from
  summed numerators and denominators, never averaged. Numbers at different date
  grains are never divided into each other without saying so — and cohort ROAS,
  which Phase 0A genuinely cannot compute, is reported as unavailable with a
  reason rather than approximated.
- **Never guess an entity link.** A campaign in Meta is joined to a campaign in
  the MMP by stable id. A name match is a _candidate_, labelled as such, and is
  never treated as authoritative.
- **Never store or log a credential in the clear.** Provider secrets are
  encrypted with AES-256-GCM before they touch the database, are never returned
  to the browser, and are redacted from every log line.
- **Never trust an id from the browser.** Every organization, app and connection
  id is re-checked against the caller's membership on every request.

## Documentation

| File                               | What it covers                                                |
| ---------------------------------- | ------------------------------------------------------------- |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Processes, request flow, package layout, sync engine          |
| [DATA_MODEL.md](DATA_MODEL.md)     | Every table, the canonical model, grain rules                 |
| [INTEGRATIONS.md](INTEGRATIONS.md) | Provider contracts, capability model, **verification status** |
| [METRICS.md](METRICS.md)           | The governed metric registry and its arithmetic               |
| [DECISIONS.md](DECISIONS.md)       | Phase 3 decision signals: gates, evidence, anomalies, pacing  |
| [SECURITY.md](SECURITY.md)         | Auth, tenancy, credential handling, logging                   |
| [DEVELOPMENT.md](DEVELOPMENT.md)   | Running it locally, tests, fixtures                           |
| [PHASES.md](PHASES.md)             | What Phase 0A is, and what Phase 0B should be                 |

## Quick start

Requires Node 22+, pnpm 10+, PostgreSQL 16+.

```bash
pnpm install
cp .env.example .env                 # then fill in MART_CREDENTIAL_KEY
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
createdb mart
pnpm db:migrate

pnpm dev:api        # http://localhost:4000
pnpm dev:worker     # sync worker + health on :4001
pnpm dev:web        # http://localhost:3000
```

To exercise the whole flow with no provider account, see the fixture provider
server in [DEVELOPMENT.md](DEVELOPMENT.md#running-without-provider-credentials).

## Layout

```
apps/
  api/          Fastify API and BFF — the only thing the browser talks to
  worker/       Background sync worker
  web/          Next.js dashboard (server components + small client islands)
packages/
  shared/       Canonical types, error taxonomy, date and hash helpers
  config/       Validated environment configuration
  observability/Structured logging with redaction, request context, counters
  db/           PostgreSQL pool, migrations, repositories
  auth/         Password hashing, sessions, RBAC
  integrations/ Provider adapters, capability model, sync engine, reconciliation
  metrics/      Governed metric registry and query layer
tests/
  unit/         Pure logic
  integration/  Real PostgreSQL, real HTTP against a local fixture server
```

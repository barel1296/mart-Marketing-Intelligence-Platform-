# Phases

`smart-marketing-intelligence-platform.json` in this repository is the full MART
architecture specification: 18 modules, 21 agents, an orchestrator, an event bus,
a decision engine and a governance model. It is the destination, not the plan for
any single phase.

This document records what Phase 0A actually built, and what Phase 0B should be.

## Phase 0A — foundation (this phase)

**Goal:** one honest data path, end to end, that a growth team could trust with a
real budget decision.

**In scope, and delivered:**

- Email/password authentication, sessions, CSRF, RBAC across four roles.
- Organizations, memberships, apps — with tenant isolation proven by tests at
  both the API and the storage level.
- Integration domain model: providers, connections, encrypted credentials,
  accounts, per-app bindings, capabilities.
- Meta Ads read-only connector (structure + daily delivery, cursor paging,
  probed country breakdown, restatement lookback).
- A provider-independent MMP abstraction with two implementations, AppsFlyer and
  Tenjin, and a capability model that changes real behaviour.
- MMP selection UX requiring explicit confirmation, written to the audit log,
  with historical data from a previous MMP retained rather than deleted.
- Raw ingestion, deduplicated and replayable.
- A canonical marketing model and a canonical attribution model, with grain
  pinned per table by database constraints.
- Entity mapping and a reconciliation UI that distinguishes stable-id matches,
  name-fallback candidates, ambiguity and unmatched entities on both sides.
- A governed metric registry with grain-aware, availability-aware tiles.
- A sync engine: scheduling, chunked windows, checkpointing, idempotent upserts,
  restatement detection, thirteen-way error classification, retry with backoff.
- Freshness tracking and deterministic data-quality checks.
- A single MART Command Center with six sections, plus a polished integrations
  management page.
- Audit logging, structured logging with redaction, health and readiness
  endpoints.

**Deliberately out of scope:** agents, orchestration, any AI or ML, pLTV,
forecasting, anomaly detection, MMM, creative intelligence, an action gateway or
any write-back to an ad platform, Kafka, ClickHouse, Snowflake, a feature store,
a model registry, a lakehouse, and the remaining 15 modules of the specification.

**Known gaps:** no connector has been run against a live provider account (see
[INTEGRATIONS.md](INTEGRATIONS.md#verification-status--read-this-first)), Tenjin's
wire format is unverified, and cohort-level metrics — cohort CPI, cohort ROAS,
retention — are not computable from the data Phase 0A imports.

## Phase 0B — recommended next

The single most valuable thing to add next is **cohort truth**, because it is
what unblocks every metric a UA manager actually decides on, and because Phase 0A
deliberately left an explicit hole where it belongs.

Suggested scope, in dependency order:

1. **Live provider verification.** Run each connector against a real account:
   confirm Meta's paging and breakdown behaviour at volume, confirm AppsFlyer's
   report availability on the customer's actual plan, and — most importantly —
   confirm or correct Tenjin's wire format. This is a prerequisite for trusting
   anything built on top.
2. **Cohort-level cost and revenue.** Import cost data joined to attribution at
   the cohort level (AppsFlyer cost ETL / Tenjin cohort reports), add a
   `cohort_date` fact table, and turn on the metrics Phase 0A left unavailable:
   cohort CPI, D0/D7/D30 cohort ROAS, retention curves. The registry entry for
   `cohort_roas` already exists with its reason; this phase replaces the reason
   with a value.
3. **A second marketing network.** TikTok Ads or Google Ads, added purely through
   the existing abstraction. If it requires changes outside
   `packages/integrations/src/providers/`, the abstraction is wrong and should be
   fixed then, while there are only two networks to reconcile.
4. **Multi-account and multi-app scale.** Per-app dashboards exist; portfolio
   rollups, cross-app comparison and per-account filtering do not.
5. **Alerting on the data MART already has.** Freshness breaches, sync failures
   and coverage regressions are all recorded today and nobody is told about them.
   This is a notification layer, not anomaly detection — no modelling required.

Phase 0B should still contain no agents and no AI. The specification's autonomous
layer is only worth building on top of data an operator already trusts, and the
fastest way to lose that trust is to automate a decision on a metric whose grain
nobody checked.

## Phase 2 — cohort intelligence (built)

Phase 2 adds the cohort foundation Phase 0A left an explicit hole for, and
nothing beyond it.

**Ground truth established first, on a real Tenjin account (read-only):**
`revenues_Nd`, `ad_mediation_revenue_Nd` and `pubrev_Nd` are cumulative cohort
revenue keyed on the install day; a young cohort reports its cumulative-so-far
value rather than null; the plain metric on the same row is event-date revenue
and differs from `_0d`; `roas_Nd` is IAP LTV over the same campaign's spend on
the same install day and is null for organic rows; `pltv_Nd` and `proas_Nd` are
predictions.

**Built:**

- `cohort_date` grain rows in `attribution_revenue_metrics`, one per cohort,
  component and age (D1, D7), from whichever `_Nd` metrics the saved report
  carries. Event-date rows and every existing reader are untouched.
- Cohort revenue, RPI and ROAS at D1 and D7 for IAP, ad and total - eighteen
  registry metrics generated from one vocabulary, served in their own `cohort`
  group of the unified performance object.
- Maturity decided per row from the provider's data horizon and the row's own
  last-read time; immature cohorts counted and excluded, never zero
  (`immature_cohort` blocker).
- Cohort ROAS anchored on the install day: numerator and denominator are the
  same (campaign, install day) pairs, organic and unmapped cohorts in neither
  side, currency checked across both sides.
- Per-component cohort capabilities probed from the saved report definition,
  refreshed after every revenue sync, so a missing provider field is reported
  with the exact metric to add.
- An in-sync data-quality check that cohort revenue is cumulative, and a
  Phase 2 audit (`pnpm phase2-audit <org> <from> <to> [app]`) that recomputes
  maturity, alignment, exclusions and the provider's own ROAS definition with
  independent SQL, and proves the cohort currency gate inside a rollback.

**Deliberately out of scope, still:** predicted LTV/ROAS, retention curves, ages
beyond D7, forecasting, agents, and any write-back to a provider.

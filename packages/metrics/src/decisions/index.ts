import type { DecisionPolicyRow, Queryable } from '@mart/db';
import { DECISION_RULE_VERSION, type IsoDate } from '@mart/shared';
import type { MetricContext, MetricFilters } from '../service.js';
import { loadDecisionFacts, type CampaignFacts } from './load.js';
import {
  classifyAnomalies,
  computePacing,
  detectAnomalies,
  evaluateScope,
  type AnomalyCandidate,
} from './rules.js';
import type { Anomaly, DecisionSet, Pacing, Recommendation, RecommendationScope } from './types.js';

export * from './types.js';
export * from './rules.js';
export {
  loadDecisionFacts,
  policySnapshot,
  type CampaignFacts,
  type DecisionFacts,
} from './load.js';

/**
 * The Decision Center's one entry point - Phase 3.
 *
 * Loads the facts once, then reads every delivered campaign and the app
 * through the same rules. The result carries no action and no way to
 * express one: `automation` is the literal `'none'` and every
 * recommendation's `actions` is typed empty. MART says what the trusted
 * figures support; a person decides what to do with the money.
 *
 * `now` is injectable so two runs can be compared exactly (the audit does),
 * and `client` runs the whole path inside a caller's transaction.
 */
export async function loadDecisions(input: {
  filters: MetricFilters;
  context: MetricContext;
  window: { from: IsoDate; to: IsoDate; timezone: string };
  policy: DecisionPolicyRow | null;
  now?: Date;
  client?: Queryable;
}): Promise<DecisionSet> {
  const facts = await loadDecisionFacts({
    filters: input.filters,
    window: input.window,
    policy: input.policy,
    ...(input.client ? { client: input.client } : {}),
  });
  const computedAt = (input.now ?? new Date()).toISOString();
  const marketingProvider = input.filters.marketingProviderKey ?? null;
  const attributionProvider = input.filters.attributionProviderKey ?? null;
  const missingProvider: 'marketing' | 'attribution' | null = !input.context.hasMarketingConnection
    ? 'marketing'
    : !input.context.hasAttributionConnection
      ? 'attribution'
      : null;

  const anomaliesFor = (scope: Anomaly['scope'], series: CampaignFacts['series']): Anomaly[] => {
    const candidates: AnomalyCandidate[] = [];
    for (const metric of ['spend', 'installs', 'revenue'] as const) {
      candidates.push(
        ...detectAnomalies({
          series: series[metric],
          metric,
          window: input.window,
          scope,
          thresholds: facts.policy.thresholds,
        }),
      );
    }
    candidates.sort((a, b) =>
      a.date < b.date ? -1 : a.date > b.date ? 1 : a.metric.localeCompare(b.metric),
    );
    return classifyAnomalies({
      candidates,
      daySignals: facts.daySignals,
      attributionFreshness: facts.freshness.attribution,
    });
  };

  const campaigns: Recommendation[] = [];
  const pacing: Pacing[] = [];
  const anomalies: Anomaly[] = [];
  const delivered = facts.campaigns
    .filter((c) => c.deliveredInWindow)
    .map((c) => ({
      facts: c,
      spend: c.days
        .filter((d) => d.date >= input.window.from && d.date <= input.window.to)
        .reduce((acc, d) => acc + d.spend, 0),
    }))
    .sort((a, b) =>
      b.spend !== a.spend
        ? b.spend - a.spend
        : a.facts.externalCampaignId < b.facts.externalCampaignId
          ? -1
          : 1,
    );
  for (const { facts: campaign } of delivered) {
    const scope: RecommendationScope = {
      kind: 'campaign',
      appId: input.filters.appId,
      marketingCampaignId: campaign.externalCampaignId,
      campaignName: campaign.name,
      marketingProvider,
      attributionProvider,
    };
    const scopeAnomalies = anomaliesFor(
      {
        kind: 'campaign',
        marketingCampaignId: campaign.externalCampaignId,
        campaignName: campaign.name,
      },
      campaign.series,
    );
    anomalies.push(...scopeAnomalies);
    pacing.push(
      computePacing({
        scope,
        window: input.window,
        days: campaign.days,
        budget: campaign.budget,
        thresholds: facts.policy.thresholds,
      }),
    );
    campaigns.push(
      evaluateScope(
        {
          scope,
          window: input.window,
          asOf: facts.asOf,
          days: campaign.days,
          mapping: campaign.mapping,
          freshness: facts.freshness,
          activeSyncErrors: facts.activeSyncErrors,
          findings: facts.findings,
          budget: campaign.budget,
          capabilities: input.context.supportedCapabilities,
          capabilityNotes: input.context.capabilityNotes,
          anomalies: scopeAnomalies,
          missingProvider,
        },
        facts.policy,
        computedAt,
      ),
    );
  }

  const appScope: RecommendationScope = {
    kind: 'app',
    appId: input.filters.appId,
    marketingCampaignId: null,
    campaignName: null,
    marketingProvider,
    attributionProvider,
  };
  const appAnomalies = anomaliesFor(
    { kind: 'app', marketingCampaignId: null, campaignName: null },
    facts.app.series,
  );
  anomalies.push(...appAnomalies);
  const app = evaluateScope(
    {
      scope: appScope,
      window: input.window,
      asOf: facts.asOf,
      days: facts.app.days,
      mapping: {
        status: null,
        method: null,
        confidence: null,
        operational: true,
        ambiguous: false,
        attributionCampaignIds: [],
      },
      freshness: facts.freshness,
      activeSyncErrors: facts.activeSyncErrors,
      findings: facts.findings,
      budget: null,
      capabilities: input.context.supportedCapabilities,
      capabilityNotes: input.context.capabilityNotes,
      anomalies: appAnomalies,
      spendCoveragePct: facts.app.spendCoveragePct,
      ambiguousSpendPct: facts.app.ambiguousSpendPct,
      missingProvider,
    },
    facts.policy,
    computedAt,
  );

  return {
    ruleVersion: DECISION_RULE_VERSION,
    window: input.window,
    asOf: facts.asOf,
    policy: facts.policy,
    app,
    campaigns,
    anomalies,
    pacing,
    automation: 'none',
  };
}

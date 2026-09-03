import { describe, expect, it } from 'vitest';
import type { DecisionPolicyRow } from '@mart/db';
import {
  COHORT_AGES,
  COHORT_REVENUE_TYPES,
  DECISION_BLOCKERS,
  DECISION_RULE_VERSION,
  METRIC_BLOCKERS,
  cohortCapabilityKey,
} from '@mart/shared';
import {
  DECISION_THRESHOLDS,
  chooseReturnMeasure,
  classifyAnomalies,
  computePacing,
  computeTrend,
  detectAnomalies,
  evaluateScope,
  median,
  medianAbsoluteDeviation,
  policySnapshot,
  type Anomaly,
  type AnomalyCandidate,
  type CampaignDayFact,
  type DaySignals,
  type Recommendation,
  type ScopeDecisionInput,
  type SeriesPoint,
} from '@mart/metrics';

/**
 * The Phase 3 hard rules, each asserted against the production rules with
 * hand-built facts:
 *
 *   - no LLM arithmetic: every figure is a deterministic function of facts
 *   - no autonomous action: a recommendation has no action and no automation
 *   - a tracking or data-quality problem never surfaces as performance
 *   - scale/reduce never come from stale, ambiguous, immature, unsupported,
 *     mixed-currency or population-misaligned data
 *   - every recommendation exposes evidence, window, population, quality,
 *     confidence and reason
 *   - confidence qualifies, never validates
 *   - the same facts produce the same recommendation, byte for byte apart
 *     from computedAt
 */

const FROM = '2026-08-01';
const TO = '2026-08-31';
const AS_OF = '2026-09-01';
const T = DECISION_THRESHOLDS;

const ALL_COHORT_CAPABILITIES = COHORT_REVENUE_TYPES.flatMap((t) =>
  COHORT_AGES.map((a) => cohortCapabilityKey(t, a)),
);

function dateAt(offset: number, from = FROM): string {
  const d = new Date(`${from}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}

type DaySpec = {
  spend?: number;
  installs?: number;
  iap?: number;
  ad?: number;
  currency?: string;
  revenueCurrency?: string;
  oldEnough?: boolean;
  covered?: boolean;
  earlyReadRows?: number;
};

function day(date: string, spec: DaySpec = {}): CampaignDayFact {
  const spend = spec.spend ?? 0;
  const iap = spec.iap ?? 0;
  const ad = spec.ad ?? 0;
  const cohort = () => ({
    revenue: { iap, ad, total: iap + ad },
    oldEnough: spec.oldEnough ?? true,
    covered: spec.covered ?? true,
    earlyReadRows: spec.earlyReadRows ?? 0,
    currencies: iap + ad > 0 ? [spec.revenueCurrency ?? spec.currency ?? 'USD'] : [],
  });
  return {
    date,
    spend,
    impressions: spend > 0 ? 1000 : 0,
    clicks: spend > 0 ? 20 : 0,
    spendCurrencies: spend > 0 ? [spec.currency ?? 'USD'] : [],
    installs: spec.installs ?? 0,
    cohort: { 1: cohort(), 7: cohort() },
  };
}

/** `count` consecutive days from `from`, all alike. */
function days(count: number, spec: DaySpec, from = FROM): CampaignDayFact[] {
  return Array.from({ length: count }, (_, i) => day(dateAt(i, from), spec));
}

function policyRow(overrides: Partial<DecisionPolicyRow> = {}): DecisionPolicyRow {
  return {
    id: 'policy',
    organization_id: 'org',
    app_id: 'app',
    target_roas_d7: null,
    target_roas_d1: null,
    max_cpi: null,
    currency: null,
    updated_by_user_id: null,
    created_at: new Date('2026-08-01T00:00:00Z'),
    updated_at: new Date('2026-08-01T00:00:00Z'),
    ...overrides,
  };
}

const D7_POLICY = policySnapshot(policyRow({ target_roas_d7: '0.5' }));
const NO_POLICY = policySnapshot(null);

function input(overrides: Partial<ScopeDecisionInput> = {}): ScopeDecisionInput {
  return {
    scope: {
      kind: 'campaign',
      appId: 'app',
      marketingCampaignId: 'C1',
      campaignName: 'Summer US',
      marketingProvider: 'meta_ads',
      attributionProvider: 'tenjin',
    },
    window: { from: FROM, to: TO, timezone: 'UTC' },
    asOf: AS_OF,
    // Ten mature delivered days: 200 spend, 50 installs, 120 total revenue.
    days: days(10, { spend: 20, installs: 5, iap: 8, ad: 4 }),
    mapping: {
      status: 'matched_exact',
      method: 'stable_external_id',
      confidence: 1,
      operational: true,
      ambiguous: false,
      attributionCampaignIds: ['T1'],
    },
    freshness: {
      marketing: 'fresh',
      attribution: 'fresh',
      marketingLatestDate: AS_OF,
      attributionLatestDate: AS_OF,
    },
    activeSyncErrors: 0,
    findings: [],
    budget: null,
    capabilities: new Set(ALL_COHORT_CAPABILITIES),
    anomalies: [],
    ...overrides,
  };
}

function evaluate(
  overrides: Partial<ScopeDecisionInput> = {},
  policy = D7_POLICY,
  computedAt = '2026-09-01T12:00:00.000Z',
): Recommendation {
  return evaluateScope(input(overrides), policy, computedAt);
}

function anomaly(overrides: Partial<Anomaly>): Anomaly {
  return {
    date: '2026-08-20',
    metric: 'installs',
    scope: { kind: 'campaign', marketingCampaignId: 'C1', campaignName: 'Summer US' },
    value: 2,
    baselineMedian: 40,
    baselineMad: 3,
    baselinePoints: 14,
    robustZ: 8.5,
    deviationPct: -95,
    direction: 'down',
    classification: 'undetermined',
    explanation: 'test',
    dataSignals: [],
    ...overrides,
  };
}

const roasEvidence = (r: Recommendation) => r.evidence.find((e) => e.key.startsWith('cohort_'));

// ---------------------------------------------------------------------------

describe('decision vocabulary', () => {
  it('extends the metric blockers rather than replacing them', () => {
    for (const blocker of METRIC_BLOCKERS) expect(DECISION_BLOCKERS).toContain(blocker);
    expect(DECISION_BLOCKERS).toContain('no_target');
    expect(DECISION_BLOCKERS).toContain('anomalous_data');
  });

  it('reads a policy row into a snapshot with the thresholds beside it', () => {
    const snapshot = policySnapshot(
      policyRow({ target_roas_d7: '0.5', max_cpi: '3.25', currency: 'USD' }),
    );
    expect(snapshot.configured).toBe(true);
    expect(snapshot.targetRoasD7).toBe(0.5);
    expect(snapshot.maxCpi).toBe(3.25);
    expect(snapshot.thresholds).toEqual(T);
    expect(NO_POLICY.configured).toBe(false);
  });
});

describe('robust statistics', () => {
  it('computes the median and the median absolute deviation', () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(medianAbsoluteDeviation([1, 2, 3, 4, 100], 3)).toBe(1);
    expect(() => median([])).toThrow();
  });
});

describe('anomaly detection', () => {
  const flat = (value: number, count: number, from: string): SeriesPoint[] =>
    Array.from({ length: count }, (_, i) => ({ date: dateAt(i, from), value }));
  const scope = { kind: 'campaign' as const, marketingCampaignId: 'C1', campaignName: 'C' };

  it('flags a day far outside a stable baseline, in either direction', () => {
    const series = [...flat(100, 14, '2026-07-18'), { date: FROM, value: 20 }];
    const found = detectAnomalies({
      series,
      metric: 'spend',
      window: { from: FROM, to: TO },
      scope,
    });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      date: FROM,
      direction: 'down',
      baselinePoints: 14,
      baselineMedian: 100,
      deviationPct: -80,
      robustZ: null,
    });
    const up = detectAnomalies({
      series: [...flat(100, 14, '2026-07-18'), { date: FROM, value: 400 }],
      metric: 'spend',
      window: { from: FROM, to: TO },
      scope,
    });
    expect(up[0]?.direction).toBe('up');
  });

  it('uses a MAD-scaled z-score when the baseline varies', () => {
    const noisy: SeriesPoint[] = Array.from({ length: 14 }, (_, i) => ({
      date: dateAt(i, '2026-07-18'),
      value: 100 + (i % 2 === 0 ? 10 : -10),
    }));
    // MAD = 10, sigma = 14.826: 130 is z=2.0 (not anomalous), 160 is z=4.0.
    const calm = detectAnomalies({
      series: [...noisy, { date: FROM, value: 130 }],
      metric: 'installs',
      window: { from: FROM, to: TO },
      scope,
    });
    expect(calm).toHaveLength(0);
    const loud = detectAnomalies({
      series: [...noisy, { date: FROM, value: 160 }],
      metric: 'installs',
      window: { from: FROM, to: TO },
      scope,
    });
    expect(loud).toHaveLength(1);
    expect(loud[0]?.robustZ).toBeCloseTo(60 / (1.4826 * 10), 2);
  });

  it('makes no call without enough history, and ignores small moves', () => {
    const short = detectAnomalies({
      series: [...flat(100, 5, '2026-07-27'), { date: FROM, value: 0 }],
      metric: 'spend',
      window: { from: FROM, to: TO },
      scope,
    });
    expect(short).toHaveLength(0);
    // 12 against a median of 10: a 20% move but below the absolute floor.
    const tiny = detectAnomalies({
      series: [...flat(10, 14, '2026-07-18'), { date: FROM, value: 15 }],
      metric: 'spend',
      window: { from: FROM, to: TO },
      scope,
    });
    expect(tiny).toHaveLength(0);
    // Below the relative floor even though the absolute move is large.
    const relative = detectAnomalies({
      series: [...flat(1000, 14, '2026-07-18'), { date: FROM, value: 1200 }],
      metric: 'spend',
      window: { from: FROM, to: TO },
      scope,
    });
    expect(relative).toHaveLength(0);
  });

  it('reports a move off a zero baseline without a percentage', () => {
    const found = detectAnomalies({
      series: [...flat(0, 14, '2026-07-18'), { date: FROM, value: 100 }],
      metric: 'installs',
      window: { from: FROM, to: TO },
      scope,
    });
    expect(found).toHaveLength(1);
    expect(found[0]?.deviationPct).toBeNull();
    expect(found[0]?.direction).toBe('up');
  });

  it('only judges days inside the window; earlier points are history', () => {
    const found = detectAnomalies({
      series: [
        ...flat(100, 14, '2026-07-10'),
        { date: '2026-07-24', value: 0 },
        ...flat(100, 8, '2026-07-25'),
      ],
      metric: 'spend',
      window: { from: FROM, to: TO },
      scope,
    });
    expect(found).toHaveLength(0);
  });
});

describe('anomaly classification', () => {
  const quiet: DaySignals = { syncError: false, uncovered: false, finding: false };
  const candidate = (overrides: Partial<AnomalyCandidate>): AnomalyCandidate => {
    const { classification: _c, explanation: _e, dataSignals: _d, ...rest } = anomaly({});
    return { ...rest, ...overrides };
  };
  const classify = (
    candidates: AnomalyCandidate[],
    signals: Partial<DaySignals> = {},
    freshness = 'fresh',
  ) =>
    classifyAnomalies({
      candidates,
      daySignals: () => ({ ...quiet, ...signals }),
      attributionFreshness: freshness,
    });

  it('calls a spend move a delivery change', () => {
    const [a] = classify([candidate({ metric: 'spend' })]);
    expect(a?.classification).toBe('delivery');
  });

  it('calls an install move under a sync error or an unread day a data gap', () => {
    expect(classify([candidate({})], { syncError: true })[0]?.classification).toBe('data_gap');
    expect(classify([candidate({})], { uncovered: true })[0]?.classification).toBe('data_gap');
    expect(classify([candidate({})], { uncovered: true })[0]?.dataSignals).toContain(
      'day_not_covered_by_attribution_sync',
    );
  });

  it('calls installs that moved with spend a delivery change', () => {
    const result = classify([candidate({ metric: 'spend' }), candidate({ metric: 'installs' })]);
    expect(result.map((a) => a.classification)).toEqual(['delivery', 'delivery']);
  });

  it('calls installs that moved without spend, with a finding or a stale feed, a tracking change', () => {
    expect(classify([candidate({})], { finding: true })[0]?.classification).toBe('attribution');
    expect(classify([candidate({})], {}, 'stale')[0]?.classification).toBe('attribution');
    expect(classify([candidate({})], {}, 'stale')[0]?.dataSignals).toContain(
      'attribution_stream_stale',
    );
  });

  it('refuses to guess when installs moved and nothing on the data side explains it', () => {
    const [a] = classify([candidate({})]);
    expect(a?.classification).toBe('undetermined');
    expect(a?.explanation).toMatch(/cannot tell a tracking change from a performance change/);
  });

  it('classifies revenue by what installs did on the day, else as monetization', () => {
    const withInstalls = classify(
      [candidate({ metric: 'installs' }), candidate({ metric: 'revenue' })],
      { finding: true },
    );
    expect(withInstalls.map((a) => a.classification)).toEqual(['attribution', 'attribution']);
    const alone = classify([candidate({ metric: 'revenue' })]);
    expect(alone[0]?.classification).toBe('monetization');
  });
});

describe('pacing', () => {
  const scope = {
    kind: 'campaign' as const,
    appId: 'app',
    marketingCampaignId: 'C1',
    campaignName: 'C',
    marketingProvider: 'meta_ads',
    attributionProvider: 'tenjin',
  };
  const window = { from: FROM, to: TO };

  it('compares average delivered-day spend with the daily budget', () => {
    const pacing = computePacing({
      scope,
      window,
      days: days(10, { spend: 20 }),
      budget: { daily: 25, source: 'campaign', currency: 'USD', lifetime: null, spentToDate: null },
    });
    expect(pacing).toMatchObject({
      status: 'on',
      ratio: 0.8,
      deliveredDays: 10,
      calendarDays: 10,
      averageDailySpend: 20,
      spend: 200,
    });
    expect(
      computePacing({
        scope,
        window,
        days: days(10, { spend: 10 }),
        budget: {
          daily: 25,
          source: 'campaign',
          currency: 'USD',
          lifetime: null,
          spentToDate: null,
        },
      }).status,
    ).toBe('under');
    expect(
      computePacing({
        scope,
        window,
        days: days(10, { spend: 40 }),
        budget: {
          daily: 25,
          source: 'ad_sets',
          currency: 'USD',
          lifetime: null,
          spentToDate: null,
        },
      }).status,
    ).toBe('over');
  });

  it('is unknown without a budget or without delivery, and blocked across currencies', () => {
    expect(
      computePacing({ scope, window, days: days(10, { spend: 20 }), budget: null }).status,
    ).toBe('unknown');
    expect(
      computePacing({
        scope,
        window,
        days: days(10, { spend: 0 }),
        budget: {
          daily: 25,
          source: 'campaign',
          currency: 'USD',
          lifetime: null,
          spentToDate: null,
        },
      }).status,
    ).toBe('unknown');
    const mixed = computePacing({
      scope,
      window,
      days: days(10, { spend: 20, currency: 'EUR' }),
      budget: { daily: 25, source: 'campaign', currency: 'USD', lifetime: null, spentToDate: null },
    });
    expect(mixed.status).toBe('unknown');
    expect(mixed.blocker).toBe('mixed_currency');
  });

  it('reports lifetime share when a lifetime budget is known', () => {
    const pacing = computePacing({
      scope,
      window,
      days: days(10, { spend: 20 }),
      budget: { daily: 25, source: 'campaign', currency: 'USD', lifetime: 1000, spentToDate: 250 },
    });
    expect(pacing.lifetime).toEqual({ budget: 1000, spentToDate: 250, sharePct: 25 });
  });
});

describe('trends', () => {
  const trendDays = (values: number[]) =>
    values.map((numerator, i) => ({
      date: dateAt(i),
      numerator,
      denominator: 20,
      installs: 5,
      eligible: true,
    }));
  const floors = {
    days: T.minimumMatureDays,
    denominator: T.minimumSpend,
    installs: T.minimumInstalls,
  };

  it('compares the newest seven eligible days with the seven before', () => {
    const trend = computeTrend({
      measure: 'roas',
      higherIsBetter: true,
      days: trendDays([...Array(7).fill(20), ...Array(7).fill(10)]),
      floors,
    });
    expect(trend.direction).toBe('deteriorating');
    expect(trend.changePct).toBe(-50);
    expect(trend.current?.value).toBe(0.5);
    expect(trend.prior?.value).toBe(1);
    expect(
      computeTrend({
        measure: 'cpi',
        higherIsBetter: false,
        days: trendDays([...Array(7).fill(20), ...Array(7).fill(10)]),
        floors,
      }).direction,
    ).toBe('improving');
  });

  it('is stable under the material-change threshold and unknown without two halves', () => {
    const stable = computeTrend({
      measure: 'roas',
      higherIsBetter: true,
      days: trendDays([...Array(7).fill(10), ...Array(7).fill(11)]),
      floors,
    });
    expect(stable.direction).toBe('stable');
    const short = computeTrend({
      measure: 'roas',
      higherIsBetter: true,
      days: trendDays(Array(9).fill(10)),
      floors,
    });
    expect(short.direction).toBe('unknown');
    expect(short.prior?.value).toBeNull();
  });
});

describe('return measure selection', () => {
  it('prefers the full D7 return, then a component, then D1', () => {
    expect(chooseReturnMeasure(D7_POLICY, new Set(ALL_COHORT_CAPABILITIES))).toEqual({
      ageDays: 7,
      revenueType: 'total',
      partial: false,
      target: 0.5,
    });
    expect(chooseReturnMeasure(D7_POLICY, new Set([cohortCapabilityKey('ad', 7)]))).toMatchObject({
      revenueType: 'ad',
      partial: true,
    });
    const both = policySnapshot(policyRow({ target_roas_d7: '0.5', target_roas_d1: '0.2' }));
    expect(chooseReturnMeasure(both, new Set([cohortCapabilityKey('total', 1)]))).toMatchObject({
      ageDays: 1,
      target: 0.2,
    });
    expect(chooseReturnMeasure(D7_POLICY, new Set())).toBeNull();
    expect(chooseReturnMeasure(NO_POLICY, new Set(ALL_COHORT_CAPABILITIES))).toBeNull();
  });
});

describe('evaluateScope: the reading against a target', () => {
  it('scales above the band, reduces below it, holds inside it', () => {
    // 120 revenue on 200 spend = 0.6 against 0.5: above the 15% band.
    const scale = evaluate();
    expect(scale.signal).toBe('scale');
    expect(scale.category).toBe('performance');
    expect(scale.blockers).toEqual([]);
    expect(roasEvidence(scale)).toMatchObject({
      key: 'cohort_roas_d7',
      value: 0.6,
      numerator: 120,
      denominator: 200,
      availability: 'available',
      grain: 'cohort_date',
      population: 'cohort_aligned_paid_attribution',
    });
    expect(scale.window.evaluated).toEqual({ from: FROM, to: dateAt(9), days: 10 });

    const reduce = evaluate({ days: days(10, { spend: 20, installs: 5, iap: 5, ad: 3 }) });
    expect(reduce.signal).toBe('reduce');
    expect(roasEvidence(reduce)?.value).toBe(0.4);

    const hold = evaluate({ days: days(10, { spend: 20, installs: 5, iap: 6, ad: 4 }) });
    expect(hold.signal).toBe('hold');
    expect(hold.headline).toMatch(/At the D7 target/);
  });

  it('never says scale or reduce without a configured target', () => {
    const r = evaluate({}, NO_POLICY);
    expect(r.signal).toBe('hold');
    expect(r.blockers).toEqual(['no_target']);
    expect(r.policy.configured).toBe(false);
    // The figures are still there for a person to read.
    expect(roasEvidence(r)).toBeUndefined();
    expect(r.evidence.find((e) => e.key === 'spend')?.value).toBe(200);
  });

  it('is deterministic: the same facts give the same recommendation and id', () => {
    const a = evaluate({}, D7_POLICY, '2026-09-01T00:00:00.000Z');
    const b = evaluate({}, D7_POLICY, '2026-09-02T00:00:00.000Z');
    const strip = (r: Recommendation) => ({ ...r, lineage: { ...r.lineage, computedAt: null } });
    expect(strip(a)).toEqual(strip(b));
    expect(a.id).toBe(b.id);
    expect(a.lineage.inputsHash).toBe(b.lineage.inputsHash);
    expect(a.ruleVersion).toBe(DECISION_RULE_VERSION);
    // Nothing to execute, by construction.
    expect(a.actions).toEqual([]);
  });

  it('carries evidence, window, population, quality, confidence and reason on every recommendation', () => {
    for (const r of [evaluate(), evaluate({}, NO_POLICY), evaluate({ asOf: null })]) {
      expect(r.evidence.length).toBeGreaterThan(0);
      for (const item of r.evidence) {
        expect(item.window.from).toBeTruthy();
        expect(item.population).toBeTruthy();
        expect(item.grain).toBeTruthy();
        if (item.availability !== 'available' && item.availability !== 'partial') {
          expect(item.blocker).toBeTruthy();
        }
      }
      expect(r.window.timezone).toBe('UTC');
      expect(r.population.numerator).toBe('cohort_aligned_paid_attribution');
      expect(r.quality.freshness).toBeTruthy();
      expect(r.confidence.components.map((c) => c.input)).toEqual(
        expect.arrayContaining(['freshness', 'sample', 'maturity', 'mapping']),
      );
      expect(r.reason.length).toBeGreaterThan(20);
      expect(r.lineage.inputsHash).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});

describe('evaluateScope: the gates, in order', () => {
  it('reports a missing provider before anything else', () => {
    const r = evaluate({ missingProvider: 'attribution' });
    expect(r.signal).toBe('insufficient_data');
    expect(r.blockers).toEqual(['missing_provider']);
  });

  it('refuses to read an unmapped or ambiguous campaign', () => {
    const unmapped = evaluate({
      mapping: { ...input().mapping, status: 'unmatched', operational: false },
    });
    expect(unmapped.signal).toBe('insufficient_data');
    expect(unmapped.category).toBe('coverage');
    expect(unmapped.blockers).toEqual(['insufficient_coverage']);

    const ambiguous = evaluate({
      mapping: { ...input().mapping, status: 'ambiguous', operational: false, ambiguous: true },
    });
    expect(ambiguous.signal).toBe('investigate');
    expect(ambiguous.blockers).toEqual(['ambiguous_mapping']);
  });

  it('refuses to read stale or failing streams, and names the stream', () => {
    const stale = evaluate({ freshness: { ...input().freshness, attribution: 'stale' } });
    expect(stale.signal).toBe('insufficient_data');
    expect(stale.category).toBe('data_quality');
    expect(stale.blockers).toEqual(['provider_stale']);
    expect(stale.reason).toMatch(/attribution stream is stale/);

    const failing = evaluate({ freshness: { ...input().freshness, marketing: 'error' } });
    expect(failing.signal).toBe('investigate');
    expect(failing.category).toBe('data_quality');

    const errors = evaluate({ activeSyncErrors: 2 });
    expect(errors.signal).toBe('investigate');
    expect(errors.reason).toMatch(/2 unresolved sync error/);

    const delayed = evaluate({ freshness: { ...input().freshness, marketing: 'delayed' } });
    expect(delayed.signal).toBe('scale');
    expect(delayed.confidence.score).toBeLessThan(evaluate().confidence.score);
  });

  it('refuses to divide across currencies', () => {
    const mixedSpend = evaluate({
      days: [
        ...days(5, { spend: 20, installs: 5, iap: 8, ad: 4 }),
        ...days(5, { spend: 20, installs: 5, iap: 8, ad: 4, currency: 'EUR' }, dateAt(5)),
      ],
    });
    expect(mixedSpend.signal).toBe('investigate');
    expect(mixedSpend.blockers).toEqual(['mixed_currency']);
    expect(mixedSpend.evidence.find((e) => e.key === 'spend')?.availability).toBe('blocked');

    const crossed = evaluate({
      days: days(10, { spend: 20, installs: 5, iap: 8, ad: 4, revenueCurrency: 'EUR' }),
    });
    expect(crossed.signal).toBe('investigate');
    expect(crossed.blockers).toEqual(['mixed_currency']);
  });

  it('turns an error-severity finding into an investigation, not a performance call', () => {
    const r = evaluate({
      findings: [{ checkKey: 'cohort_non_cumulative', severity: 'error', count: 3 }],
    });
    expect(r.signal).toBe('investigate');
    expect(r.category).toBe('data_quality');
    expect(r.blockers).toEqual(['data_quality_finding']);
    expect(r.reason).toMatch(/cohort_non_cumulative \(3\)/);
    // A warning qualifies nothing on its own.
    expect(evaluate({ findings: [{ checkKey: 'x', severity: 'warning', count: 1 }] }).signal).toBe(
      'scale',
    );
    // An account-level reconciliation finding is about the neighbours a
    // campaign has, not about its own rows: the app scope hears it, the
    // campaign scope does not.
    const reconciliation = [
      { checkKey: 'reconciliation.current_period_spend_unmapped', severity: 'error', count: 1 },
    ];
    expect(evaluate({ findings: reconciliation }).signal).toBe('scale');
    const app = evaluate({
      scope: { ...input().scope, kind: 'app', marketingCampaignId: null, campaignName: null },
      spendCoveragePct: 100,
      ambiguousSpendPct: 0,
      findings: reconciliation,
    });
    expect(app.signal).toBe('investigate');
    expect(app.blockers).toEqual(['data_quality_finding']);
  });

  it('never lets a data-side anomaly read as performance', () => {
    const gap = evaluate({ anomalies: [anomaly({ classification: 'data_gap' })] });
    expect(gap.signal).toBe('investigate');
    expect(gap.category).toBe('data_quality');
    expect(gap.blockers).toEqual(['anomalous_data']);
    expect(gap.headline).toMatch(/Data gap anomaly/);

    const tracking = evaluate({ anomalies: [anomaly({ classification: 'attribution' })] });
    expect(tracking.category).toBe('data_quality');
    expect(tracking.headline).toMatch(/Tracking anomaly/);

    const unexplained = evaluate({ anomalies: [anomaly({ classification: 'undetermined' })] });
    expect(unexplained.signal).toBe('investigate');
    expect(unexplained.category).toBe('undetermined');

    // A delivery anomaly is a fact about delivery, not a reason to withhold.
    const delivery = evaluate({
      anomalies: [anomaly({ metric: 'spend', classification: 'delivery' })],
    });
    expect(delivery.signal).toBe('scale');
    expect(delivery.quality.anomalies).toHaveLength(1);
  });

  it('withholds a return no cohort is old enough to have', () => {
    const immature = evaluate({ days: days(10, { spend: 20, installs: 5, oldEnough: false }) });
    expect(immature.signal).toBe('insufficient_data');
    expect(immature.blockers).toEqual(['immature_cohort']);
    expect(roasEvidence(immature)).toMatchObject({
      availability: 'blocked',
      blocker: 'immature_cohort',
    });
    expect(immature.quality.maturity).toMatchObject({ matureDays: 0, immatureDays: 10 });
  });

  it('tells a cohort nobody re-read apart from one that earned nothing', () => {
    const unread = evaluate({ days: days(10, { spend: 20, installs: 5, covered: false }) });
    expect(unread.signal).toBe('insufficient_data');
    expect(unread.category).toBe('data_quality');
    expect(unread.blockers).toEqual(['provider_stale']);
    expect(unread.reason).toMatch(/not a cohort that earned nothing/);
    // Young days beside unread ones do not hide them: the unread ones need a
    // sync, the young ones only need time.
    const mixed = evaluate({
      days: [
        ...days(5, { spend: 20, installs: 5, covered: false }),
        ...days(5, { spend: 20, installs: 5, oldEnough: false }, dateAt(5)),
      ],
    });
    expect(mixed.blockers).toEqual(['provider_stale']);
    expect(mixed.reason).toMatch(/5 more are too young/);
  });

  it('withholds a reading below the volume floors, whatever the ratio says', () => {
    // 2 mature days: 40 spend, 10 installs, ROAS would be 3.0.
    const thin = evaluate({ days: days(2, { spend: 20, installs: 5, iap: 60 }) });
    expect(thin.signal).toBe('insufficient_data');
    expect(thin.blockers).toEqual(['immature_cohort']);
    expect(roasEvidence(thin)?.value).toBeNull();
    // 10 days but 10 installs in total.
    const fewInstalls = evaluate({ days: days(10, { spend: 20, installs: 1, iap: 60 }) });
    expect(fewInstalls.signal).toBe('insufficient_data');
    expect(fewInstalls.blockers).toEqual(['missing_denominator']);
  });

  it('confidence qualifies the reading and never makes an invalid one valid', () => {
    const thin = evaluate({ days: days(2, { spend: 20, installs: 5, iap: 60 }) });
    expect(thin.confidence.level).toBe('low');
    expect(thin.signal).toBe('insufficient_data');
    const strong = evaluate();
    expect(strong.confidence.level).toBe('high');
    // Same arithmetic either way: the value is a function of the facts alone.
    expect(roasEvidence(strong)?.value).toBe(0.6);
  });
});

describe('evaluateScope: partial returns, trends and fallbacks', () => {
  it('scales on a component return above target, but never reduces on one', () => {
    const adOnly = new Set([cohortCapabilityKey('ad', 7)]);
    const above = evaluate({
      capabilities: adOnly,
      days: days(10, { spend: 20, installs: 5, ad: 12, iap: 100 }),
    });
    expect(above.signal).toBe('scale');
    expect(roasEvidence(above)).toMatchObject({
      key: 'cohort_ad_roas_d7',
      value: 0.6,
      availability: 'partial',
      blocker: 'partial_return',
    });
    const below = evaluate({
      capabilities: adOnly,
      days: days(10, { spend: 20, installs: 5, ad: 6, iap: 100 }),
    });
    expect(below.signal).toBe('hold');
    expect(below.blockers).toEqual(['partial_return']);
  });

  it('holds when the newest mature days contradict the window average', () => {
    const r = evaluate({
      days: [
        ...days(7, { spend: 20, installs: 5, iap: 20 }),
        ...days(7, { spend: 20, installs: 5, iap: 10 }, dateAt(7)),
      ],
    });
    // Average 0.75 is above the band; the last seven days are 0.5, 50% below.
    expect(roasEvidence(r)?.value).toBe(0.75);
    expect(r.signal).toBe('hold');
    expect(r.blockers).toEqual(['trend_contradicts']);
    expect(r.window.baseline).toEqual({ from: FROM, to: dateAt(6) });
    expect(roasEvidence(r)?.comparison).toMatchObject({
      direction: 'deteriorating',
      changePct: -50,
    });
  });

  it('falls back to D1 when only a D1 target can be read', () => {
    const d1 = policySnapshot(policyRow({ target_roas_d1: '0.2' }));
    const r = evaluate({ days: days(10, { spend: 20, installs: 5, iap: 6 }) }, d1);
    expect(r.signal).toBe('scale');
    expect(roasEvidence(r)?.key).toBe('cohort_roas_d1');
  });

  it('holds with the provider change named when the targeted age is not reported', () => {
    const r = evaluate({
      capabilities: new Set(),
      capabilityNotes: {
        [cohortCapabilityKey('total', 7)]: 'Add revenues_7d to the saved report.',
      },
    });
    expect(r.signal).toBe('hold');
    expect(r.blockers).toEqual(['unsupported_metric']);
    expect(r.reason).toMatch(/Add revenues_7d to the saved report/);
  });

  it('reads a CPI ceiling when no return is configured or reported', () => {
    const cpi = policySnapshot(policyRow({ max_cpi: '4', currency: 'USD' }));
    expect(evaluate({}, cpi).signal).toBe('hold');
    expect(evaluate({ days: days(10, { spend: 20, installs: 10 }) }, cpi).signal).toBe('scale');
    expect(evaluate({ days: days(10, { spend: 40, installs: 5 }) }, cpi).signal).toBe('reduce');
    const foreign = policySnapshot(policyRow({ max_cpi: '4', currency: 'EUR' }));
    const r = evaluate({}, foreign);
    expect(r.signal).toBe('hold');
    expect(r.blockers).toEqual(['mixed_currency']);
    // Only days the attribution horizon has passed count for a CPI.
    const unsettled = evaluate({ asOf: dateAt(5) }, cpi);
    expect(unsettled.evidence.find((e) => e.key === 'mapped_cpi')?.denominator).toBe(25);
  });
});

describe('evaluateScope: the app scope', () => {
  const app = (overrides: Partial<ScopeDecisionInput> = {}) =>
    evaluate({
      scope: {
        kind: 'app',
        appId: 'app',
        marketingCampaignId: null,
        campaignName: null,
        marketingProvider: 'meta_ads',
        attributionProvider: 'tenjin',
      },
      spendCoveragePct: 100,
      ambiguousSpendPct: 0,
      ...overrides,
    });

  it('reads the mapped population when coverage is sufficient', () => {
    const r = app();
    expect(r.signal).toBe('scale');
    expect(r.confidence.components.map((c) => c.input)).toEqual(
      expect.arrayContaining(['coverage', 'mapping', 'maturity']),
    );
  });

  it('withholds an app-level reading over thin or ambiguous coverage', () => {
    const thin = app({ spendCoveragePct: 60 });
    expect(thin.signal).toBe('insufficient_data');
    expect(thin.blockers).toEqual(['insufficient_coverage']);
    const ambiguous = app({ ambiguousSpendPct: 25 });
    expect(ambiguous.signal).toBe('investigate');
    expect(ambiguous.blockers).toEqual(['ambiguous_mapping']);
  });
});

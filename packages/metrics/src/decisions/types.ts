import type {
  AnomalyClassification,
  CohortAge,
  CohortRevenueType,
  DecisionBlocker,
  DecisionCategory,
  DecisionSignal,
  IsoDate,
  MetricAvailability,
  MetricBlocker,
  MetricGrain,
  MetricPopulation,
} from '@mart/shared';
import type { MetricConfidence } from '../confidence.js';
import type { DECISION_THRESHOLDS } from '../thresholds.js';

/**
 * The decision layer's vocabulary - Phase 3.
 *
 * A recommendation is a deterministic reading of trusted figures against the
 * operator's policy. It carries everything a person needs to check it: the
 * window it was drawn from, the population, every figure it rests on with
 * that figure's own availability and blocker, the quality state of the data
 * behind it, a decomposed confidence, and the rule version. It never carries
 * an action: `actions` is typed empty so nothing downstream can grow one.
 */

export type RecommendationScope = {
  kind: 'campaign' | 'app';
  appId: string;
  /** The marketing network's campaign id; null for the app scope. */
  marketingCampaignId: string | null;
  campaignName: string | null;
  marketingProvider: string | null;
  attributionProvider: string | null;
};

export type EvidenceComparison = {
  baselineWindow: { from: IsoDate; to: IsoDate } | null;
  baseline: number | null;
  /** (current - baseline) / baseline, as a percentage; null when undefined. */
  changePct: number | null;
  direction: 'improving' | 'deteriorating' | 'stable' | 'unknown';
};

export type EvidenceItem = {
  /** A registry metric key where one applies, else a decision measure key. */
  key: string;
  label: string;
  value: number | null;
  format: 'currency' | 'ratio' | 'percent' | 'integer' | 'decimal';
  availability: MetricAvailability;
  blocker?: DecisionBlocker;
  reason?: string;
  numerator?: number | null;
  denominator?: number | null;
  window: { from: IsoDate; to: IsoDate };
  population: MetricPopulation | string;
  grain: MetricGrain | 'mixed';
  comparison?: EvidenceComparison;
};

export type MappingState = {
  status: string | null;
  method: string | null;
  confidence: number | null;
  /** Mapped strongly enough to compute on (Phase 1's operational rule). */
  operational: boolean;
  ambiguous: boolean;
  attributionCampaignIds: string[];
};

export type FreshnessState = {
  marketing: string | null;
  attribution: string | null;
  marketingLatestDate: IsoDate | null;
  attributionLatestDate: IsoDate | null;
};

export type MaturityState = {
  ageDays: CohortAge;
  matureDays: number;
  immatureDays: number;
  uncoveredDays: number;
  earlyReadRows: number;
};

export type QualityState = {
  freshness: FreshnessState;
  activeSyncErrors: number;
  findings: Array<{ checkKey: string; severity: string; count: number }>;
  maturity: MaturityState | null;
  mapping: MappingState;
  currencies: { spend: string[]; revenue: string[] };
  /** Anomalies inside the window that bear on this scope, by classification. */
  anomalies: Array<{ date: IsoDate; metric: string; classification: AnomalyClassification }>;
};

export type DecisionPolicySnapshot = {
  /** Whether the operator has stored any target at all. */
  configured: boolean;
  targetRoasD7: number | null;
  targetRoasD1: number | null;
  maxCpi: number | null;
  currency: string | null;
  thresholds: typeof DECISION_THRESHOLDS;
  updatedAt: string | null;
};

export type Recommendation = {
  /** Deterministic: the same scope, window and rule version always get the same id. */
  id: string;
  ruleVersion: string;
  scope: RecommendationScope;
  signal: DecisionSignal;
  category: DecisionCategory;
  headline: string;
  reason: string;
  window: {
    from: IsoDate;
    to: IsoDate;
    timezone: string;
    /** The mature days the reading was actually drawn from. */
    evaluated: { from: IsoDate | null; to: IsoDate | null; days: number };
    baseline: { from: IsoDate; to: IsoDate } | null;
  };
  population: { numerator: MetricPopulation; denominator?: MetricPopulation; note: string };
  evidence: EvidenceItem[];
  quality: QualityState;
  confidence: MetricConfidence;
  /** Why scale or reduce could not be issued, when they could not. */
  blockers: DecisionBlocker[];
  policy: DecisionPolicySnapshot;
  lineage: {
    metricKeys: string[];
    factFamilies: string[];
    providers: string[];
    /** Hash of the evidence and signal, so two runs can be compared exactly. */
    inputsHash: string;
    computedAt: string;
  };
  /** Empty by type. MART recommends; a person acts. */
  actions: never[];
};

/** One day of one marketing campaign, in the form the rules read. */
export type CohortDayFact = {
  /** Aligned cohort revenue at this age, by component, from mature rows only. */
  revenue: Record<CohortRevenueType, number>;
  /** Install day + age is before the attribution data horizon. */
  oldEnough: boolean;
  /** The revenue sync read this day after the cohort reached the age. */
  covered: boolean;
  earlyReadRows: number;
  /**
   * Currencies of the mature rows, per component. A reading on one component
   * is judged on that component's currencies alone, as Phase 2 judges each
   * cohort metric on its own slice.
   */
  currencies: Record<CohortRevenueType, string[]>;
};

export type CampaignDayFact = {
  date: IsoDate;
  spend: number;
  impressions: number;
  clicks: number;
  spendCurrencies: string[];
  /** Paid installs attributed to this campaign's mapped attribution campaigns. */
  installs: number;
  /**
   * The installs that this day's spend bought: `installs` when the campaign
   * spent on the day, else 0. At app scope, the sum over campaigns that spent
   * on the day - the population a per-install figure divides by.
   */
  alignedInstalls: number;
  cohort: Record<CohortAge, CohortDayFact>;
};

export type BudgetState = {
  daily: number | null;
  source: 'campaign' | 'ad_sets' | null;
  currency: string | null;
  lifetime: number | null;
  spentToDate: number | null;
};

export type Anomaly = {
  date: IsoDate;
  metric: 'spend' | 'installs' | 'revenue';
  scope: {
    kind: 'campaign' | 'app';
    marketingCampaignId: string | null;
    campaignName: string | null;
  };
  value: number;
  baselineMedian: number;
  baselineMad: number;
  baselinePoints: number;
  robustZ: number | null;
  /** (value - median) / median, as a percentage; null when the median is zero. */
  deviationPct: number | null;
  direction: 'up' | 'down';
  classification: AnomalyClassification;
  explanation: string;
  /** The data-side facts the classification rests on, named. */
  dataSignals: string[];
};

export type PacingStatus = 'under' | 'on' | 'over' | 'unknown';

export type Pacing = {
  marketingCampaignId: string;
  campaignName: string | null;
  window: { from: IsoDate; to: IsoDate };
  dailyBudget: number | null;
  budgetSource: 'campaign' | 'ad_sets' | null;
  budgetCurrency: string | null;
  spendCurrencies: string[];
  spend: number;
  deliveredDays: number;
  calendarDays: number;
  averageDailySpend: number | null;
  /** averageDailySpend / dailyBudget. */
  ratio: number | null;
  status: PacingStatus;
  lifetime: { budget: number; spentToDate: number; sharePct: number } | null;
  blocker?: MetricBlocker;
  reason: string;
};

export type Trend = {
  measure: string;
  higherIsBetter: boolean;
  current: {
    from: IsoDate;
    to: IsoDate;
    value: number | null;
    numerator: number;
    denominator: number;
    days: number;
  } | null;
  prior: {
    from: IsoDate;
    to: IsoDate;
    value: number | null;
    numerator: number;
    denominator: number;
    days: number;
  } | null;
  changePct: number | null;
  direction: 'improving' | 'deteriorating' | 'stable' | 'unknown';
  reason: string;
};

export type DaySignals = {
  /** An unresolved sync error whose window covers the day. */
  syncError: boolean;
  /** No attribution sync has read the day. */
  uncovered: boolean;
  /** A data-quality finding observed on the day. */
  finding: boolean;
};

export type ScopeDecisionInput = {
  scope: RecommendationScope;
  window: { from: IsoDate; to: IsoDate; timezone: string };
  asOf: IsoDate | null;
  days: CampaignDayFact[];
  mapping: MappingState;
  freshness: FreshnessState;
  activeSyncErrors: number;
  findings: Array<{ checkKey: string; severity: string; count: number }>;
  budget: BudgetState | null;
  capabilities: ReadonlySet<string>;
  /** For an unsupported capability, the external change that would supply it. */
  capabilityNotes?: Record<string, string> | undefined;
  anomalies: Anomaly[];
  /** The app has no binding for this role; nothing can be read at all. */
  missingProvider?: 'marketing' | 'attribution' | null;
  /** App scope only: the share of window spend on mapped campaigns. */
  spendCoveragePct?: number | null;
  ambiguousSpendPct?: number | null;
};

export type DecisionSet = {
  ruleVersion: string;
  window: { from: IsoDate; to: IsoDate; timezone: string };
  asOf: IsoDate | null;
  policy: DecisionPolicySnapshot;
  app: Recommendation;
  campaigns: Recommendation[];
  anomalies: Anomaly[];
  pacing: Pacing[];
  /** What MART would never do here, stated in the payload itself. */
  automation: 'none';
};

import { createHash } from 'node:crypto';
import {
  COHORT_REVENUE_TYPES,
  DECISION_RULE_VERSION,
  addDays,
  cohortCapabilityKey,
  type AnomalyClassification,
  type CohortAge,
  type CohortRevenueType,
  type DecisionBlocker,
  type DecisionCategory,
  type DecisionSignal,
  type IsoDate,
  type MetricAvailability,
} from '@mart/shared';
import { scoreConfidence, type ConfidenceComponent } from '../confidence.js';
import { cohortMetricKey } from '../registry.js';
import {
  DECISION_THRESHOLDS,
  MINIMUM_SPEND_COVERAGE_PCT,
  MAXIMUM_AMBIGUOUS_SPEND_PCT,
} from '../thresholds.js';
import type {
  Anomaly,
  BudgetState,
  CampaignDayFact,
  DaySignals,
  DecisionPolicySnapshot,
  EvidenceItem,
  MaturityState,
  Pacing,
  Recommendation,
  RecommendationScope,
  ScopeDecisionInput,
  Trend,
} from './types.js';

/**
 * The decision rules - Phase 3.
 *
 * Everything in this file is a pure function of facts the loaders hand it: no
 * query, no clock, no randomness. The same facts always produce the same
 * recommendation, byte for byte apart from `computedAt`, which is why the
 * Phase 3 audit can recompute a signal from stored rows and expect equality.
 *
 * The order of the gates is the order of the hard rules. A figure is read
 * against a target only after the layer has established that the campaign is
 * mapped, the streams are current, the currency is single, no data-quality
 * finding or unexplained movement sits inside the window, and enough mature
 * volume exists. A gate that fails names itself in the signal, the category
 * and the blocker, so a tracking problem can never surface wearing the
 * clothes of a performance problem.
 */

export type DecisionThresholds = typeof DECISION_THRESHOLDS;

export type SeriesPoint = { date: IsoDate; value: number };

export type AnomalyCandidate = Omit<Anomaly, 'classification' | 'explanation' | 'dataSignals'>;

// ------------------------------------------------------------ statistics ---

/** The median of a non-empty list. Throws on an empty one rather than inventing 0. */
export function median(values: readonly number[]): number {
  if (values.length === 0) throw new Error('median of an empty list');
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const upper = sorted[mid] as number;
  if (sorted.length % 2 === 1) return upper;
  const lower = sorted[mid - 1] as number;
  return (lower + upper) / 2;
}

/** Median absolute deviation around `center`. */
export function medianAbsoluteDeviation(values: readonly number[], center: number): number {
  return median(values.map((v) => Math.abs(v - center)));
}

/** Scales a MAD to the standard deviation of a normal distribution. */
export const MAD_TO_SIGMA = 1.4826;

function round(value: number, places = 6): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/** A change from `prior` to `current`, as a percentage; null when undefined. */
export function changePercent(current: number, prior: number): number | null {
  if (!(prior > 0)) return null;
  return round(((current - prior) / prior) * 100, 4);
}

// ------------------------------------------------------------- anomalies ---

/**
 * Find the days in the window that sit far outside their own recent history.
 *
 * Each day is judged against the `anomalyBaselineDays` days before it that
 * the series contains: the median of those days and their median absolute
 * deviation. A day is anomalous only when three things hold at once - it is
 * `anomalyRobustZ` MAD-scaled deviations from the median (or, when every
 * baseline day is identical and the MAD is zero, when it simply differs), it
 * differs by at least `anomalyMinimumRelativeDeviation` of the median, and it
 * differs by at least the metric's absolute floor. The last two stop a $3
 * swing on a $10 day from being an alarm.
 *
 * Fewer than `anomalyMinimumBaselinePoints` baseline days and no call is
 * made: a campaign three days old has no history to be unusual against.
 *
 * The series must be dense over the days the scope was live (a day the
 * scope had no row for is a zero only if the provider had reported the
 * scope by then - the loader decides that, not this function) and sorted
 * ascending. Points before `window.from` serve as history only.
 */
export function detectAnomalies(input: {
  series: readonly SeriesPoint[];
  metric: Anomaly['metric'];
  window: { from: IsoDate; to: IsoDate };
  scope: Anomaly['scope'];
  thresholds?: DecisionThresholds;
}): AnomalyCandidate[] {
  const T = input.thresholds ?? DECISION_THRESHOLDS;
  const series = [...input.series].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const out: AnomalyCandidate[] = [];
  const absoluteFloor = T.anomalyMinimumAbsolute[input.metric];

  for (let i = 0; i < series.length; i += 1) {
    const point = series[i] as SeriesPoint;
    if (point.date < input.window.from || point.date > input.window.to) continue;
    const earliest = addDays(point.date, -T.anomalyBaselineDays);
    const baseline: number[] = [];
    for (let j = i - 1; j >= 0; j -= 1) {
      const prior = series[j] as SeriesPoint;
      if (prior.date < earliest) break;
      if (prior.date >= point.date) continue;
      baseline.push(prior.value);
    }
    if (baseline.length < T.anomalyMinimumBaselinePoints) continue;

    const center = median(baseline);
    const mad = medianAbsoluteDeviation(baseline, center);
    const deviation = point.value - center;
    const absolute = Math.abs(deviation);
    if (absolute < absoluteFloor) continue;
    const relative = center > 0 ? absolute / center : absolute > 0 ? Number.POSITIVE_INFINITY : 0;
    if (relative < T.anomalyMinimumRelativeDeviation) continue;
    const robustZ = mad > 0 ? absolute / (MAD_TO_SIGMA * mad) : null;
    if (robustZ !== null && robustZ < T.anomalyRobustZ) continue;

    out.push({
      date: point.date,
      metric: input.metric,
      scope: input.scope,
      value: round(point.value),
      baselineMedian: round(center),
      baselineMad: round(mad),
      baselinePoints: baseline.length,
      robustZ: robustZ === null ? null : round(robustZ, 3),
      deviationPct: center > 0 ? round((deviation / center) * 100, 4) : null,
      direction: deviation > 0 ? 'up' : 'down',
    });
  }
  return out;
}

function describeMove(candidate: AnomalyCandidate): string {
  const pct =
    candidate.deviationPct === null
      ? 'from a zero baseline'
      : `${candidate.deviationPct > 0 ? '+' : ''}${candidate.deviationPct.toFixed(1)}%`;
  return `${candidate.metric} on ${candidate.date} was ${candidate.value} against a ${candidate.baselinePoints}-day median of ${candidate.baselineMedian} (${pct})`;
}

/**
 * Say what each anomaly is, from the data around it, never from its size.
 *
 * The classification answers one question first: did MART read that day
 * properly? An unresolved sync error over the day, or a day no completed
 * attribution run has covered, makes the movement a data gap whatever else
 * is true. Only when the pipeline is clean does the layer look at delivery:
 * installs that moved with spend moved because delivery moved. Installs that
 * moved while spend held, with a data-quality finding on the day or an
 * attribution stream that is not current, point at tracking. Installs that
 * moved while spend held and nothing on the data side explains it are
 * `undetermined` - MART does not know whether a creative fatigued or an SDK
 * broke, and says so rather than picking the flattering one.
 */
export function classifyAnomalies(input: {
  candidates: readonly AnomalyCandidate[];
  daySignals: (date: IsoDate) => DaySignals;
  attributionFreshness: string | null;
}): Anomaly[] {
  const byDate = new Map<string, AnomalyCandidate[]>();
  for (const candidate of input.candidates) {
    const list = byDate.get(candidate.date) ?? [];
    list.push(candidate);
    byDate.set(candidate.date, list);
  }
  const sameDay = (
    candidate: AnomalyCandidate,
    metric: Anomaly['metric'],
  ): AnomalyCandidate | undefined =>
    byDate
      .get(candidate.date)
      ?.find((c) => c.metric === metric && c.direction === candidate.direction);

  const classified = new Map<AnomalyCandidate, Anomaly>();
  const classify = (candidate: AnomalyCandidate): Anomaly => {
    const existing = classified.get(candidate);
    if (existing) return existing;
    const signals = input.daySignals(candidate.date);
    const move = describeMove(candidate);
    let classification: AnomalyClassification;
    let explanation: string;
    const dataSignals: string[] = [];

    if (candidate.metric === 'spend') {
      classification = 'delivery';
      explanation = `${move}. Spend is the network's own delivery fact; a change in it is a delivery change, not a tracking one.`;
    } else if (signals.syncError) {
      classification = 'data_gap';
      dataSignals.push('unresolved_sync_error');
      explanation = `${move}. An unresolved sync error covers this day, so MART may not have read it fully; the movement is a data gap until the error is resolved.`;
    } else if (signals.uncovered) {
      classification = 'data_gap';
      dataSignals.push('day_not_covered_by_attribution_sync');
      explanation = `${move}. No completed attribution sync has read this day, so the figure is what MART happens to hold, not what the provider reports.`;
    } else if (candidate.metric === 'installs') {
      const spend = sameDay(candidate, 'spend');
      if (spend) {
        classification = 'delivery';
        explanation = `${move}. Spend on the same day moved the same way (${spend.deviationPct === null ? 'from a zero baseline' : `${spend.deviationPct > 0 ? '+' : ''}${spend.deviationPct.toFixed(1)}%`}), so installs followed delivery.`;
      } else if (signals.finding) {
        classification = 'attribution';
        dataSignals.push('data_quality_finding_on_day');
        explanation = `${move} while spend stayed inside its baseline, and a data-quality finding was recorded for the day. That points at tracking, not at performance.`;
      } else if (
        input.attributionFreshness !== null &&
        input.attributionFreshness !== 'fresh' &&
        input.attributionFreshness !== 'delayed'
      ) {
        classification = 'attribution';
        dataSignals.push(`attribution_stream_${input.attributionFreshness}`);
        explanation = `${move} while spend stayed inside its baseline, and the attribution stream is ${input.attributionFreshness}. That points at the attribution feed, not at performance.`;
      } else {
        classification = 'undetermined';
        explanation = `${move} while spend stayed inside its baseline and nothing on the data side explains it. MART cannot tell a tracking change from a performance change here.`;
      }
    } else {
      const installs = sameDay(candidate, 'installs');
      if (installs) {
        const parent = classify(installs);
        classification = parent.classification;
        dataSignals.push(...parent.dataSignals);
        explanation = `${move}. Installs on the same day moved the same way, and that movement is classified as ${parent.classification}.`;
      } else if (signals.finding) {
        classification = 'attribution';
        dataSignals.push('data_quality_finding_on_day');
        explanation = `${move} while installs stayed inside their baseline, and a data-quality finding was recorded for the day.`;
      } else {
        classification = 'monetization';
        explanation = `${move} while installs and spend stayed inside their baselines: the cohorts of this day monetized differently, or the revenue feed did.`;
      }
    }
    const anomaly: Anomaly = { ...candidate, classification, explanation, dataSignals };
    classified.set(candidate, anomaly);
    return anomaly;
  };

  return input.candidates.map(classify);
}

// ---------------------------------------------------------------- pacing ---

/**
 * How a campaign's delivery in the window compares with its daily budget.
 *
 * Average spend over the days it delivered, against the daily budget MART
 * last observed on the campaign (or the sum of its ad sets' budgets when the
 * budget sits there). Delivered days rather than calendar days, because a
 * daily budget governs the days a campaign runs; a campaign paused for three
 * weeks is not under-pacing, it is paused, and the delivered-day count says
 * so beside the ratio.
 *
 * Nothing here is a recommendation. Pacing is reported, and a person decides
 * whether under-delivery is a bid problem or a deliberate cap.
 */
export function computePacing(input: {
  scope: RecommendationScope;
  window: { from: IsoDate; to: IsoDate };
  days: readonly CampaignDayFact[];
  budget: BudgetState | null;
  thresholds?: DecisionThresholds;
}): Pacing {
  const T = input.thresholds ?? DECISION_THRESHOLDS;
  const inWindow = input.days.filter(
    (d) => d.date >= input.window.from && d.date <= input.window.to,
  );
  const delivered = inWindow.filter((d) => d.spend > 0);
  const spend = round(delivered.reduce((acc, d) => acc + d.spend, 0));
  const spendCurrencies = [...new Set(delivered.flatMap((d) => d.spendCurrencies))].sort();
  const calendarDays = inWindow.length;
  const averageDailySpend = delivered.length > 0 ? round(spend / delivered.length) : null;
  const budget = input.budget;
  const lifetime =
    budget?.lifetime && budget.lifetime > 0 && budget.spentToDate !== null
      ? {
          budget: budget.lifetime,
          spentToDate: round(budget.spentToDate),
          sharePct: round((budget.spentToDate / budget.lifetime) * 100, 2),
        }
      : null;

  const base = {
    marketingCampaignId: input.scope.marketingCampaignId ?? '',
    campaignName: input.scope.campaignName,
    window: input.window,
    dailyBudget: budget?.daily ?? null,
    budgetSource: budget?.source ?? null,
    budgetCurrency: budget?.currency ?? null,
    spendCurrencies,
    spend,
    deliveredDays: delivered.length,
    calendarDays,
    averageDailySpend,
    lifetime,
  };

  if (delivered.length === 0) {
    return {
      ...base,
      ratio: null,
      status: 'unknown',
      reason: 'The campaign delivered nothing in this window, so there is no pace to compare.',
    };
  }
  if (!budget || budget.daily === null || !(budget.daily > 0)) {
    return {
      ...base,
      ratio: null,
      status: 'unknown',
      reason:
        'No daily budget is known for this campaign or its ad sets, so spend cannot be compared with a pace.',
    };
  }
  if (spendCurrencies.length > 1) {
    return {
      ...base,
      ratio: null,
      status: 'unknown',
      blocker: 'mixed_currency',
      reason: `Spend in this window is reported in ${spendCurrencies.join(', ')}; a pace over two currencies would be a number in neither.`,
    };
  }
  if (budget.currency && spendCurrencies[0] && budget.currency !== spendCurrencies[0]) {
    return {
      ...base,
      ratio: null,
      status: 'unknown',
      blocker: 'mixed_currency',
      reason: `The budget is in ${budget.currency} and the spend in ${spendCurrencies[0]}.`,
    };
  }

  const ratio = round((averageDailySpend as number) / budget.daily, 4);
  const status = ratio < T.pacingUnderRatio ? 'under' : ratio > T.pacingOverRatio ? 'over' : 'on';
  const source =
    budget.source === 'ad_sets' ? 'the sum of its ad sets’ daily budgets' : 'its daily budget';
  return {
    ...base,
    ratio,
    status,
    reason: `Average spend over the ${delivered.length} day(s) it delivered was ${round(averageDailySpend as number, 2)} against ${source} of ${budget.daily}: ${Math.round(ratio * 100)}% of pace, ${status === 'on' ? 'inside' : 'outside'} the ${Math.round(T.pacingUnderRatio * 100)}–${Math.round(T.pacingOverRatio * 100)}% band.`,
  };
}

// ---------------------------------------------------------------- trends ---

export type TrendDay = {
  date: IsoDate;
  numerator: number;
  denominator: number;
  installs: number;
  /** Mature (or settled) and delivered: the only days a trend may be drawn from. */
  eligible: boolean;
};

/**
 * The newest eligible days against the ones before them.
 *
 * Two equal-length halves of `trendWindowDays` eligible days each, both
 * required to clear the same floors the signal itself needs. A half that
 * cannot is reported as such and the trend is `unknown`: half a comparison
 * is not a comparison.
 */
export function computeTrend(input: {
  measure: string;
  higherIsBetter: boolean;
  days: readonly TrendDay[];
  floors: { days: number; denominator: number; installs: number };
  thresholds?: DecisionThresholds;
}): Trend {
  const T = input.thresholds ?? DECISION_THRESHOLDS;
  const eligible = [...input.days]
    .filter((d) => d.eligible)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const size = T.trendWindowDays;
  const current = eligible.slice(-size);
  const prior = eligible.slice(-2 * size, -size);

  const summarize = (days: TrendDay[]): Trend['current'] => {
    if (days.length === 0) return null;
    const numerator = round(days.reduce((acc, d) => acc + d.numerator, 0));
    const denominator = round(days.reduce((acc, d) => acc + d.denominator, 0));
    const installs = days.reduce((acc, d) => acc + d.installs, 0);
    const clears =
      days.length >= input.floors.days &&
      denominator >= input.floors.denominator &&
      installs >= input.floors.installs;
    return {
      from: (days[0] as TrendDay).date,
      to: (days[days.length - 1] as TrendDay).date,
      value: clears && denominator > 0 ? round(numerator / denominator) : null,
      numerator,
      denominator,
      days: days.length,
    };
  };
  const currentSummary = summarize(current);
  const priorSummary = summarize(prior);
  const base = { measure: input.measure, higherIsBetter: input.higherIsBetter };

  if (!currentSummary || currentSummary.value === null) {
    return {
      ...base,
      current: currentSummary,
      prior: priorSummary,
      changePct: null,
      direction: 'unknown',
      reason: currentSummary
        ? `The newest ${currentSummary.days} eligible day(s) do not clear the floors (${input.floors.days} days, ${input.floors.denominator} denominator, ${input.floors.installs} installs).`
        : 'No eligible day exists to draw a trend from.',
    };
  }
  if (!priorSummary || priorSummary.value === null) {
    return {
      ...base,
      current: currentSummary,
      prior: priorSummary,
      changePct: null,
      direction: 'unknown',
      reason: priorSummary
        ? `The ${priorSummary.days} eligible day(s) before the newest ${currentSummary.days} do not clear the floors, so there is nothing to compare against.`
        : `Only ${currentSummary.days} eligible day(s) exist; a trend needs ${2 * size}.`,
    };
  }
  const changePct = changePercent(currentSummary.value, priorSummary.value);
  if (changePct === null) {
    return {
      ...base,
      current: currentSummary,
      prior: priorSummary,
      changePct: null,
      direction: 'unknown',
      reason: 'The prior period is zero, so a relative change is undefined.',
    };
  }
  const material = Math.abs(changePct) >= T.trendMaterialChangePct;
  const better = input.higherIsBetter ? changePct > 0 : changePct < 0;
  const direction: Trend['direction'] = !material
    ? 'stable'
    : better
      ? 'improving'
      : 'deteriorating';
  return {
    ...base,
    current: currentSummary,
    prior: priorSummary,
    changePct,
    direction,
    reason: `${input.measure} over ${currentSummary.from}..${currentSummary.to} (${currentSummary.days} days) is ${currentSummary.value} against ${priorSummary.value} over ${priorSummary.from}..${priorSummary.to}: ${changePct > 0 ? '+' : ''}${changePct.toFixed(1)}%, ${direction} (${T.trendMaterialChangePct}% is material).`,
  };
}

// --------------------------------------------------------------- helpers ---

const FRESHNESS_ORDER = ['error', 'stale', 'unknown', 'delayed', 'fresh'] as const;
const FRESHNESS_NOT_APPLICABLE = ['unsupported', 'not_implemented'];

/** The worst applicable status among the streams a reading depends on. */
export function worstStreamStatus(statuses: ReadonlyArray<string | null>): string | null {
  const applicable = statuses.filter(
    (s): s is string => s !== null && !FRESHNESS_NOT_APPLICABLE.includes(s),
  );
  if (applicable.length === 0) return null;
  for (const candidate of FRESHNESS_ORDER) {
    if (applicable.includes(candidate)) return candidate;
  }
  return 'unknown';
}

export function stableId(parts: ReadonlyArray<string | null>): string {
  return createHash('sha256')
    .update(parts.map((p) => p ?? '').join('|'))
    .digest('hex')
    .slice(0, 32);
}

/** A hash over what the reading rests on, so two runs can be compared exactly. */
export function inputsHash(recommendation: {
  signal: DecisionSignal;
  category: DecisionCategory;
  blockers: readonly DecisionBlocker[];
  evidence: readonly EvidenceItem[];
  window: Recommendation['window'];
}): string {
  const canonical = {
    signal: recommendation.signal,
    category: recommendation.category,
    blockers: [...recommendation.blockers].sort(),
    evaluated: recommendation.window.evaluated,
    evidence: recommendation.evidence.map((e) => ({
      key: e.key,
      value: e.value,
      numerator: e.numerator ?? null,
      denominator: e.denominator ?? null,
      availability: e.availability,
      blocker: e.blocker ?? null,
    })),
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/**
 * Which return figure the policy can be read against, given what the
 * provider reports.
 *
 * D7 first, then D1, each only where a target exists AND the account's
 * report carries the revenue at that age. The full return (`total`) is
 * preferred; where only one component exists the reading is `partial`, and
 * the caller treats it asymmetrically: a partial return above target proves
 * the full return is above target, a partial return below target proves
 * nothing.
 */
export function chooseReturnMeasure(
  policy: DecisionPolicySnapshot,
  capabilities: ReadonlySet<string>,
): { ageDays: CohortAge; revenueType: CohortRevenueType; partial: boolean; target: number } | null {
  const ages: Array<{ ageDays: CohortAge; target: number | null }> = [
    { ageDays: 7, target: policy.targetRoasD7 },
    { ageDays: 1, target: policy.targetRoasD1 },
  ];
  for (const { ageDays, target } of ages) {
    if (target === null || !(target > 0)) continue;
    if (capabilities.has(cohortCapabilityKey('total', ageDays))) {
      return { ageDays, revenueType: 'total', partial: false, target };
    }
    for (const revenueType of COHORT_REVENUE_TYPES) {
      if (revenueType === 'total') continue;
      if (capabilities.has(cohortCapabilityKey(revenueType, ageDays))) {
        return { ageDays, revenueType, partial: true, target };
      }
    }
  }
  return null;
}

function maturityFor(days: readonly CampaignDayFact[], ageDays: CohortAge): MaturityState {
  let matureDays = 0;
  let immatureDays = 0;
  let uncoveredDays = 0;
  let earlyReadRows = 0;
  for (const day of days) {
    if (!(day.spend > 0)) continue;
    const cohort = day.cohort[ageDays];
    if (!cohort.oldEnough) immatureDays += 1;
    else if (!cohort.covered) uncoveredDays += 1;
    else matureDays += 1;
    earlyReadRows += cohort.earlyReadRows;
  }
  return { ageDays, matureDays, immatureDays, uncoveredDays, earlyReadRows };
}

function isMature(day: CampaignDayFact, ageDays: CohortAge): boolean {
  return day.spend > 0 && day.cohort[ageDays].oldEnough && day.cohort[ageDays].covered;
}

type Verdict = {
  signal: DecisionSignal;
  category: DecisionCategory;
  headline: string;
  reason: string;
  blockers: DecisionBlocker[];
};

// ------------------------------------------------------------ evaluation ---

/**
 * Read one scope - a campaign or the app - against the policy.
 *
 * The gates run in order and the first that fails decides the signal. The
 * evidence is assembled regardless, so a recommendation that says
 * `insufficient_data` still shows the spend, installs and return it saw and
 * why each was or was not usable.
 */
export function evaluateScope(
  input: ScopeDecisionInput,
  policy: DecisionPolicySnapshot,
  computedAt: string,
): Recommendation {
  const T = policy.thresholds;
  const days = [...input.days]
    .filter((d) => d.date >= input.window.from && d.date <= input.window.to)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const window = { from: input.window.from, to: input.window.to };
  const isApp = input.scope.kind === 'app';
  const evidence: EvidenceItem[] = [];

  // ------------------------------------------------------------ figures ---
  const delivered = days.filter((d) => d.spend > 0);
  const spend = round(delivered.reduce((acc, d) => acc + d.spend, 0));
  const spendCurrencies = [...new Set(delivered.flatMap((d) => d.spendCurrencies))].sort();
  const settled = delivered.filter((d) => input.asOf !== null && d.date < input.asOf);
  const settledSpend = round(settled.reduce((acc, d) => acc + d.spend, 0));
  const settledInstalls = settled.reduce((acc, d) => acc + d.installs, 0);
  const installsInWindow = days
    .filter((d) => input.asOf !== null && d.date <= input.asOf)
    .reduce((acc, d) => acc + d.installs, 0);

  evidence.push({
    key: 'spend',
    label: 'Spend',
    value: spend,
    format: 'currency',
    availability: spendCurrencies.length > 1 ? 'blocked' : 'available',
    ...(spendCurrencies.length > 1 ? { blocker: 'mixed_currency' as const } : {}),
    window,
    population: 'current_period_marketing',
    grain: 'report_date',
    reason:
      spendCurrencies.length > 1
        ? `Reported in ${spendCurrencies.join(', ')}.`
        : `${delivered.length} delivered day(s) of ${days.length} in the window.`,
  });
  evidence.push({
    key: 'mapped_paid_installs',
    label: 'Mapped paid installs',
    value: installsInWindow,
    format: 'integer',
    availability: input.asOf === null ? 'unavailable' : 'available',
    ...(input.asOf === null ? { blocker: 'provider_stale' as const } : {}),
    window,
    population: 'mapped_paid_attribution',
    grain: 'install_date',
    reason:
      input.asOf === null
        ? 'The attribution streams have no data horizon yet.'
        : `Install days up to the attribution horizon ${input.asOf}.`,
  });

  const cpiEligible = settledInstalls >= T.minimumInstalls && settledSpend >= T.minimumSpend;
  const cpi = cpiEligible && settledInstalls > 0 ? round(settledSpend / settledInstalls) : null;
  evidence.push({
    key: 'mapped_cpi',
    label: 'Mapped CPI',
    value: cpi,
    format: 'currency',
    availability: cpi === null ? 'blocked' : 'available',
    ...(cpi === null ? { blocker: 'missing_denominator' as const } : {}),
    numerator: settledSpend,
    denominator: settledInstalls,
    window: {
      from: settled[0]?.date ?? window.from,
      to: settled[settled.length - 1]?.date ?? window.to,
    },
    population: 'mapped_paid_attribution',
    grain: 'mixed',
    reason:
      cpi === null
        ? `Spend ${settledSpend} over ${settledInstalls} install(s) on ${settled.length} settled delivered day(s); the floors are ${T.minimumSpend} spend and ${T.minimumInstalls} installs.`
        : `Spend over installs on ${settled.length} delivered day(s) the attribution horizon has passed.`,
  });

  // The return the policy is read against, where the provider reports one.
  const measure = chooseReturnMeasure(policy, input.capabilities);
  const readingAge: CohortAge = measure?.ageDays ?? 7;
  const maturity = maturityFor(days, readingAge);
  const mature = days.filter((d) => isMature(d, readingAge));
  const matureSpend = round(mature.reduce((acc, d) => acc + d.spend, 0));
  const matureInstalls = mature.reduce((acc, d) => acc + d.installs, 0);
  const revenueCurrencies = [
    ...new Set(mature.flatMap((d) => d.cohort[readingAge].currencies)),
  ].sort();
  const evaluatedWindow = {
    from: mature[0]?.date ?? null,
    to: mature[mature.length - 1]?.date ?? null,
    days: mature.length,
  };

  let roas: number | null = null;
  let matureRevenue = 0;
  let trend: Trend | null = null;
  if (measure) {
    matureRevenue = round(
      mature.reduce((acc, d) => acc + d.cohort[readingAge].revenue[measure.revenueType], 0),
    );
    const floorsClear =
      mature.length >= T.minimumMatureDays &&
      matureSpend >= T.minimumSpend &&
      matureInstalls >= T.minimumInstalls;
    roas = floorsClear && matureSpend > 0 ? round(matureRevenue / matureSpend) : null;
    trend = computeTrend({
      measure: cohortMetricKey({
        ageDays: measure.ageDays,
        revenueType: measure.revenueType,
        measure: 'roas',
      }),
      higherIsBetter: true,
      days: days.map((d) => ({
        date: d.date,
        numerator: d.cohort[readingAge].revenue[measure.revenueType],
        denominator: d.spend,
        installs: d.installs,
        eligible: isMature(d, readingAge),
      })),
      floors: {
        days: T.minimumMatureDays,
        denominator: T.minimumSpend,
        installs: T.minimumInstalls,
      },
      thresholds: T,
    });
    const key = cohortMetricKey({
      ageDays: measure.ageDays,
      revenueType: measure.revenueType,
      measure: 'roas',
    });
    const availability: MetricAvailability =
      mature.length === 0
        ? 'blocked'
        : roas === null
          ? 'blocked'
          : revenueCurrencies.length > 1
            ? 'blocked'
            : measure.partial
              ? 'partial'
              : 'available';
    const blocker: DecisionBlocker | undefined =
      mature.length === 0
        ? maturity.uncoveredDays > 0
          ? 'provider_stale'
          : 'immature_cohort'
        : roas === null
          ? 'missing_denominator'
          : revenueCurrencies.length > 1
            ? 'mixed_currency'
            : measure.partial
              ? 'partial_return'
              : undefined;
    evidence.push({
      key,
      label: `D${measure.ageDays} ${measure.revenueType === 'total' ? '' : `${measure.revenueType} `}cohort ROAS`,
      value: roas,
      format: 'ratio',
      availability,
      ...(blocker ? { blocker } : {}),
      numerator: matureRevenue,
      denominator: matureSpend,
      window: {
        from: evaluatedWindow.from ?? window.from,
        to: evaluatedWindow.to ?? window.to,
      },
      population: 'cohort_aligned_paid_attribution',
      grain: 'cohort_date',
      reason:
        mature.length === 0
          ? `No delivered day in the window is mature at D${measure.ageDays}: ${maturity.immatureDays} too young, ${maturity.uncoveredDays} not read by the revenue sync since maturing.`
          : roas === null
            ? `${mature.length} mature day(s), ${matureSpend} spend, ${matureInstalls} installs; the floors are ${T.minimumMatureDays} days, ${T.minimumSpend} spend and ${T.minimumInstalls} installs.`
            : `Cohort revenue at D${measure.ageDays} over the spend that bought those cohorts, on ${mature.length} mature delivered day(s).` +
              (measure.partial
                ? ` Only ${measure.revenueType} revenue is reported at this age, so this is a floor on the full return.`
                : ''),
      ...(trend
        ? {
            comparison: {
              baselineWindow: trend.prior ? { from: trend.prior.from, to: trend.prior.to } : null,
              baseline: trend.prior?.value ?? null,
              changePct: trend.changePct,
              direction: trend.direction,
            },
          }
        : {}),
    });
  }

  const dataAnomalies = input.anomalies.filter(
    (a) => a.classification === 'data_gap' || a.classification === 'attribution',
  );
  const unexplainedAnomalies = input.anomalies.filter(
    (a) => a.classification === 'undetermined' || a.classification === 'monetization',
  );
  evidence.push({
    key: 'decision.anomalies',
    label: 'Anomalous days in window',
    value: input.anomalies.length,
    format: 'integer',
    availability: 'available',
    window,
    population: 'not_applicable',
    grain: 'mixed',
    reason:
      input.anomalies.length === 0
        ? 'No day in the window sits outside its own recent history.'
        : `${dataAnomalies.length} data-side, ${unexplainedAnomalies.length} unexplained, ${input.anomalies.length - dataAnomalies.length - unexplainedAnomalies.length} delivery.`,
  });

  // Error findings about the rows or the pipeline block a reading. The
  // reconciliation findings describe the ACCOUNT - how much spend or how many
  // installs sit on campaigns nobody mapped - and a mapped campaign's own
  // spend and installs are not misaligned by its neighbours' gaps. The app
  // scope hears them through its coverage gates, and again here.
  const errorFindings = input.findings.filter(
    (f) => f.severity === 'error' && (isApp || !f.checkKey.startsWith('reconciliation.')),
  );

  // -------------------------------------------------------------- gates ---
  const gate = (): Verdict => {
    if (input.missingProvider) {
      return {
        signal: 'insufficient_data',
        category: 'coverage',
        headline:
          input.missingProvider === 'marketing'
            ? 'No marketing network is connected'
            : 'No attribution provider is connected',
        reason:
          input.missingProvider === 'marketing'
            ? 'Without a marketing network there is no spend, no budget and no campaign to read.'
            : 'Without an attribution provider there are no installs and no cohort revenue to read spend against.',
        blockers: ['missing_provider'],
      };
    }
    if (!isApp && !input.mapping.operational) {
      if (input.mapping.ambiguous) {
        return {
          signal: 'investigate',
          category: 'coverage',
          headline: 'Mapping is ambiguous',
          reason:
            'MART found several equally good attribution candidates for this campaign and refused to guess. Until a person confirms the link, no install or revenue can be attached to its spend.',
          blockers: ['ambiguous_mapping'],
        };
      }
      return {
        signal: 'insufficient_data',
        category: 'coverage',
        headline: 'Not mapped to attribution',
        reason: `This campaign is ${input.mapping.status ?? 'not mapped'} on the attribution side, so its spend has no installs or revenue to be read against.`,
        blockers: ['insufficient_coverage'],
      };
    }
    if (isApp) {
      if (input.spendCoveragePct !== null && input.spendCoveragePct !== undefined) {
        if (input.spendCoveragePct < MINIMUM_SPEND_COVERAGE_PCT) {
          return {
            signal: 'insufficient_data',
            category: 'coverage',
            headline: 'Too little spend is mapped',
            reason: `${input.spendCoveragePct.toFixed(1)}% of window spend sits on mapped campaigns; below ${MINIMUM_SPEND_COVERAGE_PCT}% an app-level return describes what MART reconciled rather than what the app returned.`,
            blockers: ['insufficient_coverage'],
          };
        }
      }
      if (
        input.ambiguousSpendPct !== null &&
        input.ambiguousSpendPct !== undefined &&
        input.ambiguousSpendPct > MAXIMUM_AMBIGUOUS_SPEND_PCT
      ) {
        return {
          signal: 'investigate',
          category: 'coverage',
          headline: 'Ambiguous mappings carry material spend',
          reason: `${input.ambiguousSpendPct.toFixed(1)}% of mapped spend is on campaigns with several equally good candidates; resolve them before reading the app-level return.`,
          blockers: ['ambiguous_mapping'],
        };
      }
    }

    const worst = worstStreamStatus([input.freshness.marketing, input.freshness.attribution]);
    if (worst === 'error' || input.activeSyncErrors > 0) {
      return {
        signal: 'investigate',
        category: 'data_quality',
        headline: 'A sync is failing',
        reason:
          input.activeSyncErrors > 0
            ? `${input.activeSyncErrors} unresolved sync error(s) sit on this app. The figures below describe what MART last received, and a reading on top of a failing feed would blame performance for a pipeline.`
            : 'A stream this reading depends on is in error. Fix the feed before reading the figures.',
        blockers: ['provider_stale'],
      };
    }
    if (worst === null || worst === 'stale' || worst === 'unknown') {
      return {
        signal: 'insufficient_data',
        category: 'data_quality',
        headline: worst === null ? 'No stream has synced' : `Data is ${worst}`,
        reason:
          worst === null
            ? 'Neither the marketing nor the attribution stream has reported a status yet.'
            : `The ${input.freshness.marketing === worst ? 'marketing' : 'attribution'} stream is ${worst} (marketing ${input.freshness.marketing ?? 'none'}, attribution ${input.freshness.attribution ?? 'none'}). A signal from data this old would describe the past as the present.`,
        blockers: ['provider_stale'],
      };
    }
    if (input.asOf === null) {
      return {
        signal: 'insufficient_data',
        category: 'data_quality',
        headline: 'No attribution horizon',
        reason:
          'The install and revenue streams have not both reported a latest data date, so no cohort can be called mature.',
        blockers: ['provider_stale'],
      };
    }

    const currencyProblem =
      spendCurrencies.length > 1 ||
      revenueCurrencies.length > 1 ||
      (spendCurrencies.length === 1 &&
        revenueCurrencies.length === 1 &&
        spendCurrencies[0] !== revenueCurrencies[0]);
    if (currencyProblem) {
      return {
        signal: 'investigate',
        category: 'data_quality',
        headline: 'Mixed currencies',
        reason: `Spend is in ${spendCurrencies.join(', ') || 'no currency'} and cohort revenue in ${revenueCurrencies.join(', ') || 'no currency'}. MART never converts, so nothing here can be divided by anything.`,
        blockers: ['mixed_currency'],
      };
    }

    if (errorFindings.length > 0) {
      return {
        signal: 'investigate',
        category: 'data_quality',
        headline: 'Data-quality findings block a reading',
        reason: `${errorFindings.map((f) => `${f.checkKey} (${f.count})`).join(', ')}: error-severity findings inside the window. Until they are resolved a figure drawn from these rows may describe the finding, not the campaign.`,
        blockers: ['data_quality_finding'],
      };
    }

    if (dataAnomalies.length > 0) {
      const first = dataAnomalies[0] as Anomaly;
      return {
        signal: 'investigate',
        category: 'data_quality',
        headline: `${first.classification === 'data_gap' ? 'Data gap' : 'Tracking'} anomaly on ${first.date}`,
        reason: `${dataAnomalies.length} day(s) in the window moved for a data-side reason (${[...new Set(dataAnomalies.map((a) => a.classification))].join(', ')}). ${first.explanation}`,
        blockers: ['anomalous_data'],
      };
    }
    if (unexplainedAnomalies.length > 0) {
      const first = unexplainedAnomalies[0] as Anomaly;
      return {
        signal: 'investigate',
        category: 'undetermined',
        headline: `Unexplained movement on ${first.date}`,
        reason: `${unexplainedAnomalies.length} day(s) in the window moved without a delivery change to explain them. ${first.explanation}`,
        blockers: ['anomalous_data'],
      };
    }

    if (!measure) {
      if (policy.maxCpi !== null && policy.maxCpi > 0) {
        return cpiVerdict();
      }
      const wanted = policy.targetRoasD7 !== null ? 7 : policy.targetRoasD1 !== null ? 1 : null;
      if (wanted !== null) {
        const keys = COHORT_REVENUE_TYPES.map((t) => cohortCapabilityKey(t, wanted));
        const notes = [
          ...new Set(keys.map((k) => input.capabilityNotes?.[k]).filter(Boolean)),
        ].join(' ');
        return {
          signal: 'hold',
          category: 'undetermined',
          headline: `D${wanted} cohort revenue is not reported`,
          reason: `A D${wanted} ROAS target is configured but the connected provider does not expose cohort revenue at D${wanted}, so the target cannot be read.${notes ? ` ${notes}` : ''}`,
          blockers: ['unsupported_metric'],
        };
      }
      return {
        signal: 'hold',
        category: 'undetermined',
        headline: 'No target configured',
        reason:
          'No cohort ROAS or CPI target is stored for this app. MART reports the figures, trends, pacing and anomalies, but it will not say scale or reduce against a target nobody has set.',
        blockers: ['no_target'],
      };
    }

    if (mature.length === 0) {
      // Unread days decide the blocker even beside young ones: the young ones
      // will mature on their own, the unread ones need a revenue sync.
      const stale = maturity.uncoveredDays > 0;
      return {
        signal: 'insufficient_data',
        category: stale ? 'data_quality' : 'coverage',
        headline: stale
          ? `D${measure.ageDays} cohorts have not been re-read`
          : `No cohort is mature at D${measure.ageDays}`,
        reason: stale
          ? `${maturity.uncoveredDays} delivered day(s) are old enough for a D${measure.ageDays} value but no revenue sync has read them since they matured${maturity.immatureDays > 0 ? `, and ${maturity.immatureDays} more are too young as of ${input.asOf}` : ''}. A cohort nobody re-read is not a cohort that earned nothing.`
          : `${maturity.immatureDays} delivered day(s) are too young for a D${measure.ageDays} value as of ${input.asOf}${maturity.uncoveredDays > 0 ? ` and ${maturity.uncoveredDays} more have not been re-read since maturing` : ''}. The return of these cohorts is not yet known.`,
        blockers: [stale ? 'provider_stale' : 'immature_cohort'],
      };
    }
    if (roas === null) {
      return {
        signal: 'insufficient_data',
        category: 'coverage',
        headline: 'Below the volume floors',
        reason: `${mature.length} mature day(s), ${matureSpend} spend and ${matureInstalls} installs at D${measure.ageDays}; a reading needs ${T.minimumMatureDays} days, ${T.minimumSpend} spend and ${T.minimumInstalls} installs. One more install would move this figure, so it is not a figure to act on.`,
        blockers: [mature.length < T.minimumMatureDays ? 'immature_cohort' : 'missing_denominator'],
      };
    }

    const upper = round(measure.target * (1 + T.tolerancePct / 100));
    const lower = round(measure.target * (1 - T.tolerancePct / 100));
    const label = `D${measure.ageDays} ${measure.revenueType === 'total' ? '' : `${measure.revenueType} `}cohort ROAS`;
    const basis = `${label} is ${roas} over ${mature.length} mature day(s) (${evaluatedWindow.from}..${evaluatedWindow.to}; ${matureRevenue} revenue on ${matureSpend} spend, ${matureInstalls} installs) against a target of ${measure.target} (band ${lower}–${upper}).`;

    if (roas >= upper) {
      if (trend?.direction === 'deteriorating') {
        return {
          signal: 'hold',
          category: 'performance',
          headline: 'Above target, but the newest cohorts are worse',
          reason: `${basis} The newest mature days sit ${trend.changePct?.toFixed(1)}% below the days before them, so the window's average overstates where the campaign is now.`,
          blockers: ['trend_contradicts'],
        };
      }
      return {
        signal: 'scale',
        category: 'performance',
        headline: `Above the D${measure.ageDays} target`,
        reason: `${basis}${measure.partial ? ` Only ${measure.revenueType} revenue is reported, so the full return is at least this.` : ''}`,
        blockers: [],
      };
    }
    if (roas <= lower) {
      if (measure.partial) {
        return {
          signal: 'hold',
          category: 'performance',
          headline: `Below target on ${measure.revenueType} revenue alone`,
          reason: `${basis} Only ${measure.revenueType} revenue is reported at D${measure.ageDays}; the full return may be higher, so this is not evidence to reduce on.`,
          blockers: ['partial_return'],
        };
      }
      if (trend?.direction === 'improving') {
        return {
          signal: 'hold',
          category: 'performance',
          headline: 'Below target, but the newest cohorts are better',
          reason: `${basis} The newest mature days sit ${trend.changePct?.toFixed(1)}% above the days before them, so the window's average understates where the campaign is now.`,
          blockers: ['trend_contradicts'],
        };
      }
      return {
        signal: 'reduce',
        category: 'performance',
        headline: `Below the D${measure.ageDays} target`,
        reason: basis,
        blockers: [],
      };
    }
    return {
      signal: 'hold',
      category: 'performance',
      headline: `At the D${measure.ageDays} target`,
      reason: `${basis} Inside the ${T.tolerancePct}% band there is nothing to act on.`,
      blockers: [],
    };
  };

  const cpiVerdict = (): Verdict => {
    const maxCpi = policy.maxCpi as number;
    if (policy.currency && spendCurrencies[0] && policy.currency !== spendCurrencies[0]) {
      return {
        signal: 'hold',
        category: 'data_quality',
        headline: 'CPI target is in another currency',
        reason: `The CPI ceiling is stated in ${policy.currency} and the spend is in ${spendCurrencies[0]}. MART never converts.`,
        blockers: ['mixed_currency'],
      };
    }
    if (cpi === null) {
      return {
        signal: 'insufficient_data',
        category: 'coverage',
        headline: 'Below the volume floors',
        reason: `${settledSpend} spend and ${settledInstalls} installs on ${settled.length} settled delivered day(s); a CPI reading needs ${T.minimumSpend} spend and ${T.minimumInstalls} installs.`,
        blockers: ['missing_denominator'],
      };
    }
    const upper = round(maxCpi * (1 + T.tolerancePct / 100));
    const lower = round(maxCpi * (1 - T.tolerancePct / 100));
    const basis = `Mapped CPI is ${cpi} (${settledSpend} spend over ${settledInstalls} installs on ${settled.length} settled delivered day(s)) against a ceiling of ${maxCpi} (band ${lower}–${upper}).`;
    if (cpi <= lower) {
      return {
        signal: 'scale',
        category: 'performance',
        headline: 'Below the CPI ceiling',
        reason: `${basis} No cohort return is configured or reported, so this reading is on cost alone.`,
        blockers: [],
      };
    }
    if (cpi >= upper) {
      return {
        signal: 'reduce',
        category: 'performance',
        headline: 'Above the CPI ceiling',
        reason: `${basis} No cohort return is configured or reported, so this reading is on cost alone.`,
        blockers: [],
      };
    }
    return {
      signal: 'hold',
      category: 'performance',
      headline: 'At the CPI ceiling',
      reason: `${basis} Inside the ${T.tolerancePct}% band there is nothing to act on.`,
      blockers: [],
    };
  };

  const verdict = gate();

  // ---------------------------------------------------------- confidence ---
  const deliveredDays = maturity.matureDays + maturity.immatureDays + maturity.uncoveredDays;
  const additional: ConfidenceComponent[] = [
    {
      input: 'maturity',
      score: deliveredDays > 0 ? maturity.matureDays / deliveredDays : 0,
      detail: `${maturity.matureDays} of ${deliveredDays} delivered day(s) are mature at D${readingAge}.`,
    },
  ];
  if (!isApp) {
    const strength = !input.mapping.operational
      ? 0
      : input.mapping.status === 'matched_fallback'
        ? (input.mapping.confidence ?? 0)
        : 1;
    additional.push({
      input: 'mapping',
      score: strength,
      detail: `Mapping is ${input.mapping.status ?? 'absent'} via ${input.mapping.method ?? 'no method'}${input.mapping.confidence !== null ? ` at ${input.mapping.confidence}` : ''}.`,
    });
  }
  const confidence = scoreConfidence({
    freshness:
      worstStreamStatus([input.freshness.marketing, input.freshness.attribution]) ?? 'unknown',
    sampleSize: matureInstalls,
    minimumSample: T.minimumInstalls,
    ...(isApp ? { spendCoveragePct: input.spendCoveragePct ?? null } : {}),
    ...(isApp ? { ambiguousSpendPct: input.ambiguousSpendPct ?? null } : {}),
    additional,
  });

  const providers = [input.scope.marketingProvider, input.scope.attributionProvider].filter(
    (p): p is string => Boolean(p),
  );
  const recommendationWindow: Recommendation['window'] = {
    from: window.from,
    to: window.to,
    timezone: input.window.timezone,
    evaluated: evaluatedWindow,
    baseline: trend?.prior ? { from: trend.prior.from, to: trend.prior.to } : null,
  };
  const partial: Omit<Recommendation, 'lineage' | 'id'> = {
    ruleVersion: DECISION_RULE_VERSION,
    scope: input.scope,
    signal: verdict.signal,
    category: verdict.category,
    headline: verdict.headline,
    reason: verdict.reason,
    window: recommendationWindow,
    population: {
      numerator: 'cohort_aligned_paid_attribution',
      denominator: 'cohort_aligned_marketing',
      note: isApp
        ? 'Paid cohorts on operationally mapped campaigns, over the spend that bought them on their install day, summed across the app’s mapped campaigns.'
        : 'Paid cohorts attributed to this campaign’s mapped attribution campaigns, over its spend on their install day.',
    },
    evidence,
    quality: {
      freshness: input.freshness,
      activeSyncErrors: input.activeSyncErrors,
      findings: input.findings,
      maturity,
      mapping: input.mapping,
      currencies: { spend: spendCurrencies, revenue: revenueCurrencies },
      anomalies: input.anomalies.map((a) => ({
        date: a.date,
        metric: a.metric,
        classification: a.classification,
      })),
    },
    confidence,
    blockers: verdict.blockers,
    policy,
    actions: [],
  };
  return {
    id: stableId([
      DECISION_RULE_VERSION,
      input.scope.appId,
      input.scope.kind,
      input.scope.marketingCampaignId,
      window.from,
      window.to,
    ]),
    ...partial,
    lineage: {
      metricKeys: evidence.map((e) => e.key).filter((k) => !k.startsWith('decision.')),
      factFamilies: ['marketing_delivery', 'attribution_installs', 'attribution_cohort_revenue'],
      providers,
      inputsHash: inputsHash({
        signal: verdict.signal,
        category: verdict.category,
        blockers: verdict.blockers,
        evidence,
        window: recommendationWindow,
      }),
      computedAt,
    },
  };
}

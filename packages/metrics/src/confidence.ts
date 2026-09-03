import type { MetricBlocker } from '@mart/shared';
import { CONFIDENCE_THRESHOLDS } from './thresholds.js';

/**
 * How much weight a figure will bear, computed from things MART can measure.
 *
 * Deterministic by construction: the same inputs always produce the same score,
 * and every component is reported beside it so a reader can see which one cost
 * the points. A score nobody can decompose is a number people either trust
 * blindly or ignore entirely, and both are worse than no score.
 *
 * Confidence annotates a conclusion. It never touches the arithmetic - a
 * low-confidence CPI is the same CPI, held more loosely.
 */
export type ConfidenceLevel = 'high' | 'medium' | 'low';

export type ConfidenceComponent = {
  /** What was assessed: 'freshness', 'coverage', 'mapping', 'sample'. */
  input: string;
  /** 0..1. Lower drags the score down. */
  score: number;
  /** Why it scored what it did, in the reader's terms. */
  detail: string;
};

export type MetricConfidence = {
  level: ConfidenceLevel;
  /** 0..1, the product of the components. Ordering only, never arithmetic. */
  score: number;
  components: ConfidenceComponent[];
};

export type ConfidenceInputs = {
  /** Freshness status of the streams behind the metric. */
  freshness?: string | undefined;
  /** Share of window spend on mapped campaigns, 0..100. */
  spendCoveragePct?: number | null;
  /** Share of mapped spend that is ambiguous, 0..100. */
  ambiguousSpendPct?: number | null;
  /** Rows behind the figure. */
  sampleSize?: number | null;
  /** The denominator this metric's definition considers meaningful. */
  minimumSample?: number;
  /**
   * Components assessed by the caller, multiplied in like the others. The
   * decision layer adds maturity (mature days over all cohort days) and
   * mapping strength here, so a recommendation's confidence decomposes the
   * same way a metric's does.
   */
  additional?: ConfidenceComponent[];
};

/**
 * Score one metric.
 *
 * Components multiply rather than average: a figure that is fresh, well covered
 * and unambiguous but computed from four installs is not two-thirds
 * trustworthy, it is untrustworthy. Averaging lets three good inputs hide one
 * disqualifying one, which is exactly the case a confidence score exists to
 * surface.
 */
export function scoreConfidence(inputs: ConfidenceInputs): MetricConfidence {
  const components: ConfidenceComponent[] = [];

  if (inputs.freshness !== undefined) {
    const fresh = inputs.freshness;
    const score =
      fresh === 'fresh' ? 1 : fresh === 'delayed' ? 0.7 : fresh === 'unknown' ? 0.6 : 0.4;
    components.push({
      input: 'freshness',
      score,
      detail:
        fresh === 'fresh'
          ? 'Underlying data is current.'
          : `Underlying data is ${fresh}; the figure describes what MART last received, not necessarily what happened.`,
    });
  }

  if (inputs.spendCoveragePct !== null && inputs.spendCoveragePct !== undefined) {
    const pct = inputs.spendCoveragePct;
    // Linear from 0 at no coverage to 1 at full: a figure drawn from half the
    // spend is half a description of the account.
    const score = Math.max(0, Math.min(1, pct / 100));
    components.push({
      input: 'coverage',
      score,
      detail: `${pct.toFixed(1)}% of spend in this period sits on mapped campaigns.`,
    });
  }

  if (inputs.ambiguousSpendPct !== null && inputs.ambiguousSpendPct !== undefined) {
    const pct = inputs.ambiguousSpendPct;
    const score = Math.max(0, Math.min(1, 1 - pct / 100));
    components.push({
      input: 'mapping',
      score,
      detail:
        pct === 0
          ? 'No campaign in this period has competing mapping candidates.'
          : `${pct.toFixed(1)}% of mapped spend is on campaigns with several equally good candidates.`,
    });
  }

  if (inputs.sampleSize !== null && inputs.sampleSize !== undefined) {
    const minimum = inputs.minimumSample ?? 0;
    const score =
      minimum <= 0 ? 1 : Math.max(0, Math.min(1, inputs.sampleSize / Math.max(minimum, 1)));
    components.push({
      input: 'sample',
      score,
      detail:
        minimum <= 0
          ? `${inputs.sampleSize} row(s) behind this figure.`
          : `${inputs.sampleSize} of the ${minimum} the definition considers meaningful.`,
    });
  }

  for (const component of inputs.additional ?? []) {
    components.push({
      input: component.input,
      score: Math.max(0, Math.min(1, component.score)),
      detail: component.detail,
    });
  }

  const score = components.reduce((acc, c) => acc * c.score, 1);
  const level: ConfidenceLevel =
    score >= CONFIDENCE_THRESHOLDS.high
      ? 'high'
      : score >= CONFIDENCE_THRESHOLDS.medium
        ? 'medium'
        : 'low';
  return { level, score: Number(score.toFixed(4)), components };
}

/**
 * Where a number came from, in enough detail to check it.
 *
 * Not a lineage platform - structured metadata attached to the value, answering
 * the questions someone asks when a figure looks wrong: which provider, which
 * facts, over what window, across which population, and what it was divided by.
 */
export type MetricLineage = {
  metricKey: string;
  /** Providers that contributed rows. */
  providers: string[];
  /** The stored fact families read: 'marketing_delivery', 'attribution_installs'... */
  factFamilies: string[];
  window: { from: string; to: string; timezone?: string };
  population: { numerator: string; denominator?: string };
  dateSemantics: { primary: string; mixed?: string[] };
  numerator: number | null;
  denominator: number | null;
  /** Data-quality checks whose findings bear on this figure. */
  qualityDependencies: string[];
  /** Conditions that stopped or qualified it, if any. */
  blocker?: MetricBlocker;
};

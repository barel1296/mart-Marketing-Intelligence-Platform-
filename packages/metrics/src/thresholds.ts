/**
 * Every threshold MART judges a metric by, in one place.
 *
 * A threshold scattered through the code is a threshold nobody can review. Each
 * one here says what it is protecting against and why the number is where it
 * is, because the alternative - a bare constant at the point of use - is
 * indistinguishable from an arbitrary choice, and gets treated as one.
 */

/**
 * Below this share of window spend sitting on mapped campaigns, per-install
 * figures stop describing the account.
 *
 * At 80% the fifth of spend that is unmapped can move a CPI by a quarter; below
 * it the figure says more about what MART failed to reconcile than about what
 * the campaigns cost. The same number gates the data-quality finding, so the
 * panel and the metric cannot disagree about when coverage is too thin.
 */
export const MINIMUM_SPEND_COVERAGE_PCT = 80;

/**
 * Ambiguity above this share of mapped spend qualifies the figures drawn from
 * it.
 *
 * Ambiguous means MART found several equally good candidates and refused to
 * guess. A little is normal in any account; a lot means the numbers rest on
 * links nobody has confirmed.
 */
export const MAXIMUM_AMBIGUOUS_SPEND_PCT = 10;

/**
 * Sample sizes below which a ratio is noise rather than signal.
 *
 * Not a statistical claim - just the point at which one more install moves the
 * number enough that acting on it would be acting on the last install.
 */
export const MINIMUM_RATIO_DENOMINATORS = {
  /** Impressions behind a CTR or CPM. */
  impressions: 1000,
  /** Installs behind a CPI. */
  installs: 25,
  /** Clicks behind a CPC. */
  clicks: 50,
} as const;

/**
 * How confident MART is in a figure, as a coarse label.
 *
 * Three levels, because a finer scale would imply a precision the inputs do not
 * have. The numeric score is kept beside it for ordering, never for arithmetic
 * on the metric itself.
 */
export const CONFIDENCE_THRESHOLDS = {
  /** At or above this, nothing material is qualifying the number. */
  high: 0.8,
  /** At or above this, the figure is usable with its caveats in view. */
  medium: 0.5,
} as const;

/**
 * Where the decision layer draws its lines - Phase 3.
 *
 * Every number here is a floor or a band, never a target: targets are the
 * operator's business inputs and live in the app's decision policy. These say
 * how much data a signal needs before it may exist at all, and how far a
 * figure has to move before MART calls the movement real.
 */
export const DECISION_THRESHOLDS = {
  /** Spend (in the app's currency) over the mature days a signal is drawn from. */
  minimumSpend: 50,
  /** Mature, mapped, paid installs behind a scale/reduce/hold reading. */
  minimumInstalls: MINIMUM_RATIO_DENOMINATORS.installs,
  /** Mature days with delivery behind a reading; one big day is an anecdote. */
  minimumMatureDays: 3,
  /**
   * Band around a target inside which a figure is "at target". A cohort ROAS
   * of 0.52 against a target of 0.5 is not a reason to do anything.
   */
  tolerancePct: 15,
  /** Mature days in each half of a trend comparison. */
  trendWindowDays: 7,
  /** Below this relative change a trend is reported as stable. */
  trendMaterialChangePct: 20,
  /** Days of history a day is judged against. */
  anomalyBaselineDays: 14,
  /** Fewer baseline points than this and no anomaly can be called. */
  anomalyMinimumBaselinePoints: 7,
  /** Robust z-score (MAD-scaled) at which a day is anomalous. */
  anomalyRobustZ: 3.5,
  /** ...and it must also differ from the baseline median by at least this share. */
  anomalyMinimumRelativeDeviation: 0.3,
  /** ...and by at least this much in absolute terms, so noise on a tiny day is not an alarm. */
  anomalyMinimumAbsolute: { spend: 20, installs: 20, revenue: 20 },
  /** Average daily spend below this share of the daily budget is under-pacing. */
  pacingUnderRatio: 0.5,
  /** Above this share is over-pacing; networks may exceed a daily budget by a margin. */
  pacingOverRatio: 1.25,
} as const;

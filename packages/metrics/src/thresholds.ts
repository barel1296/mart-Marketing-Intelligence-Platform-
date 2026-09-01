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

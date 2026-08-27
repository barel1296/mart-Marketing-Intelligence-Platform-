import type { MetricAvailability, MetricGrain } from '@mart/shared';

/**
 * Governed metric registry.
 *
 * Dashboard components never compute a business definition. They ask for a
 * metric key and render what comes back, including its availability state and
 * the grain it is expressed in. That is what makes it impossible for two
 * screens to disagree about what CTR means.
 */

export type MetricSource = 'marketing' | 'attribution' | 'mapping';

export type MetricGrainSpec = {
  /** The grain the metric is expressed in. */
  primary: MetricGrain;
  /**
   * Populated only for metrics whose numerator and denominator come from
   * different grains. MART refuses to present such a metric without saying so.
   */
  mixed?: MetricGrain[];
  note: string;
};

export type MetricFormat = 'integer' | 'decimal' | 'currency' | 'percent' | 'ratio';

export type MetricDefinition = {
  metricKey: string;
  displayName: string;
  description: string;
  /** Human-readable formula, shown in the UI next to the number. */
  formula: string;
  grain: MetricGrainSpec;
  sources: MetricSource[];
  /** Capability keys that must be supported for this metric to be computable. */
  requiredCapabilities: string[];
  /** Below this denominator the metric is noise and is reported as unavailable. */
  minimumDenominator: number;
  format: MetricFormat;
  /** Freshness beyond this is reported as stale rather than silently shown. */
  maxAcceptableStalenessMinutes: number;
  /**
   * Set when a metric is deliberately not computable yet. MART shows the reason
   * instead of a wrong number.
   */
  unavailableReason?: string;
};

export const METRIC_DEFINITIONS: readonly MetricDefinition[] = [
  {
    metricKey: 'spend',
    displayName: 'Spend',
    description: 'Cost reported by the marketing network for the selected report dates.',
    formula: 'SUM(spend)',
    grain: { primary: 'report_date', note: 'Report-date grain, as reported by the ad network.' },
    sources: ['marketing'],
    requiredCapabilities: ['cost_data'],
    minimumDenominator: 0,
    format: 'currency',
    maxAcceptableStalenessMinutes: 24 * 60,
  },
  {
    metricKey: 'impressions',
    displayName: 'Impressions',
    description: 'Impressions reported by the marketing network.',
    formula: 'SUM(impressions)',
    grain: { primary: 'report_date', note: 'Report-date grain.' },
    sources: ['marketing'],
    requiredCapabilities: ['delivery_metrics'],
    minimumDenominator: 0,
    format: 'integer',
    maxAcceptableStalenessMinutes: 24 * 60,
  },
  {
    metricKey: 'clicks',
    displayName: 'Clicks',
    description: 'Clicks reported by the marketing network.',
    formula: 'SUM(clicks)',
    grain: { primary: 'report_date', note: 'Report-date grain.' },
    sources: ['marketing'],
    requiredCapabilities: ['delivery_metrics'],
    minimumDenominator: 0,
    format: 'integer',
    maxAcceptableStalenessMinutes: 24 * 60,
  },
  {
    metricKey: 'link_clicks',
    displayName: 'Link clicks',
    description: 'Link clicks, where the marketing network reports them.',
    formula: 'SUM(link_clicks)',
    grain: { primary: 'report_date', note: 'Report-date grain.' },
    sources: ['marketing'],
    requiredCapabilities: ['link_clicks'],
    minimumDenominator: 0,
    format: 'integer',
    maxAcceptableStalenessMinutes: 24 * 60,
  },
  {
    metricKey: 'ctr',
    displayName: 'CTR',
    description: 'Click-through rate, computed from summed clicks and impressions.',
    formula: 'SUM(clicks) / SUM(impressions)',
    grain: { primary: 'report_date', note: 'Report-date grain.' },
    sources: ['marketing'],
    requiredCapabilities: ['delivery_metrics'],
    // Below this, a rate is noise rather than a signal.
    minimumDenominator: 1000,
    format: 'percent',
    maxAcceptableStalenessMinutes: 24 * 60,
  },
  {
    metricKey: 'cpm',
    displayName: 'CPM',
    description: 'Cost per thousand impressions, computed from summed spend and impressions.',
    formula: 'SUM(spend) / SUM(impressions) * 1000',
    grain: { primary: 'report_date', note: 'Report-date grain.' },
    sources: ['marketing'],
    requiredCapabilities: ['cost_data', 'delivery_metrics'],
    minimumDenominator: 1000,
    format: 'currency',
    maxAcceptableStalenessMinutes: 24 * 60,
  },
  {
    metricKey: 'cpc',
    displayName: 'CPC',
    description: 'Cost per click, computed from summed spend and clicks.',
    formula: 'SUM(spend) / SUM(clicks)',
    grain: { primary: 'report_date', note: 'Report-date grain.' },
    sources: ['marketing'],
    requiredCapabilities: ['cost_data', 'delivery_metrics'],
    minimumDenominator: 50,
    format: 'currency',
    maxAcceptableStalenessMinutes: 24 * 60,
  },
  {
    metricKey: 'attributed_installs',
    displayName: 'Attributed installs',
    description: 'Installs attributed by the app primary attribution provider.',
    formula: 'SUM(attributed_installs)',
    grain: {
      primary: 'install_date',
      note: 'Install-date (cohort anchor) grain, as attributed by the MMP.',
    },
    sources: ['attribution'],
    requiredCapabilities: ['attributed_installs'],
    minimumDenominator: 0,
    format: 'integer',
    maxAcceptableStalenessMinutes: 24 * 60,
  },
  {
    metricKey: 'attributed_revenue',
    displayName: 'Attributed revenue',
    description:
      'Revenue attributed by the MMP, recognized on the date it occurred. This is not cohort LTV.',
    formula: 'SUM(revenue) WHERE grain = event_date',
    grain: {
      primary: 'event_date',
      note: 'Event-date grain: revenue recorded on the day it happened, not cohort revenue.',
    },
    sources: ['attribution'],
    requiredCapabilities: ['attributed_revenue'],
    minimumDenominator: 0,
    format: 'currency',
    maxAcceptableStalenessMinutes: 48 * 60,
  },
  {
    metricKey: 'reported_cpi',
    displayName: 'Reported CPI',
    description:
      'Network spend divided by MMP-attributed installs over the same calendar dates. The numerator is report-date grain and the denominator is install-date grain, so this is a reported figure, not cohort CPI.',
    formula:
      'SUM(marketing.spend) [report_date] / SUM(attribution.attributed_installs) [install_date]',
    grain: {
      primary: 'report_date',
      mixed: ['report_date', 'install_date'],
      note: 'Mixed grain. Numerator is report-date spend; denominator is install-date attributed installs. Valid as a reported operational figure only - not cohort CPI.',
    },
    sources: ['marketing', 'attribution'],
    requiredCapabilities: ['cost_data', 'attributed_installs'],
    minimumDenominator: 25,
    format: 'currency',
    maxAcceptableStalenessMinutes: 24 * 60,
  },
  {
    metricKey: 'mapping_coverage',
    displayName: 'Mapping coverage',
    description:
      'Share of marketing-network campaigns linked to an attribution campaign by stable id or human verification. Name-based fallbacks are excluded.',
    formula: '(matched_exact + matched_confident + manually_verified) / total_campaign_mappings',
    grain: {
      primary: 'report_date',
      note: 'Not a time-series metric; computed over current entities.',
    },
    sources: ['mapping'],
    requiredCapabilities: [],
    minimumDenominator: 1,
    format: 'percent',
    maxAcceptableStalenessMinutes: 24 * 60,
  },
  {
    metricKey: 'cohort_roas',
    displayName: 'Cohort ROAS',
    description:
      'Cumulative cohort revenue divided by the spend that acquired that cohort. Requires cohort-matched spend, which MART does not compute in Phase 0A.',
    formula: 'cumulative_cohort_revenue / cohort_allocated_spend',
    grain: {
      primary: 'cohort_date',
      note: 'Cohort grain. Both numerator and denominator must be anchored to the same install cohort.',
    },
    sources: ['marketing', 'attribution'],
    requiredCapabilities: ['cohort_reporting'],
    minimumDenominator: 1,
    format: 'ratio',
    maxAcceptableStalenessMinutes: 24 * 60,
    // Deliberate: showing report-date spend over event-date revenue would be a
    // plausible-looking, mathematically invalid number.
    unavailableReason:
      'Cohort-matched spend is not available yet. MART will not divide report-date spend by event-date revenue and call the result ROAS.',
  },
] as const;

const BY_KEY = new Map(METRIC_DEFINITIONS.map((m) => [m.metricKey, m]));

export function getMetricDefinition(metricKey: string): MetricDefinition | undefined {
  return BY_KEY.get(metricKey);
}

export function listMetricDefinitions(): readonly MetricDefinition[] {
  return METRIC_DEFINITIONS;
}

export type MetricValue = {
  metricKey: string;
  displayName: string;
  value: number | null;
  /** Numerator/denominator retained so a ratio can be audited. */
  numerator: number | null;
  denominator: number | null;
  availability: MetricAvailability;
  /** Always populated when availability is not 'available'. */
  reason?: string;
  grain: MetricGrainSpec;
  sources: MetricSource[];
  format: MetricFormat;
  formula: string;
  /** Provenance: which providers contributed to this number. */
  providers: string[];
  freshnessStatus?: string;
  latestDataDate?: string | null;
};

/**
 * Compute a ratio from summed numerator and denominator.
 *
 * Never average pre-computed per-row ratios: the mean of per-campaign CTRs is
 * not the portfolio CTR, and the difference is large enough to change decisions.
 */
export function safeRatio(
  numerator: number,
  denominator: number,
  minimumDenominator: number,
): { value: number | null; reason?: string } {
  if (denominator <= 0) {
    return { value: null, reason: 'Denominator is zero for the selected filters.' };
  }
  if (denominator < minimumDenominator) {
    return {
      value: null,
      reason: `Denominator (${denominator}) is below the minimum of ${minimumDenominator} required for a meaningful ratio.`,
    };
  }
  return { value: numerator / denominator };
}

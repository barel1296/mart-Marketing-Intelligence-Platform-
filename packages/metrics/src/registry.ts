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
    displayName: 'Total attributed installs',
    description:
      'Every install the attribution provider attributed, organic included. This is the whole denominator, not the paid one.',
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
    displayName: 'Total attributed revenue',
    description:
      'All revenue attributed by the MMP, organic included, recognized on the date it occurred. This is not cohort LTV, and it must not be read as revenue from the marketing network.',
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
    metricKey: 'mapped_paid_installs',
    displayName: 'Mapped paid installs (all mapped campaigns)',
    description:
      "Installs on attribution campaigns that resolve to a campaign in the marketing network, by stable id, human verification, or a deterministic high-confidence name match. Organic is excluded. This is the MAPPING population: it includes installs on campaigns that did not deliver in the selected period, so it is a coverage figure and not a denominator for the period's spend.",
    formula: 'SUM(attributed_installs) WHERE campaign is mapped AND media_source <> organic',
    grain: {
      primary: 'install_date',
      note: 'Install-date grain, restricted to campaigns with a usable mapping.',
    },
    sources: ['attribution', 'mapping'],
    requiredCapabilities: ['attributed_installs'],
    minimumDenominator: 0,
    format: 'integer',
    maxAcceptableStalenessMinutes: 24 * 60,
  },
  {
    metricKey: 'organic_installs',
    displayName: 'Organic installs',
    description:
      'Installs the attribution provider reported as organic. Unpaid traffic: never part of a paid campaign CPI or ROAS, and never a mapping gap.',
    formula: 'SUM(attributed_installs) WHERE media_source = organic',
    grain: { primary: 'install_date', note: 'Install-date grain.' },
    sources: ['attribution'],
    requiredCapabilities: ['attributed_installs'],
    minimumDenominator: 0,
    format: 'integer',
    maxAcceptableStalenessMinutes: 24 * 60,
  },
  {
    metricKey: 'delivery_aligned_paid_installs',
    displayName: 'Delivery-aligned paid installs',
    description:
      "The subset of mapped paid installs whose marketing campaign also delivered in the selected period. This is the only install population the period's spend may be divided by; installs mapped to a campaign that spent nothing in the period are real, and the period's spend did not buy them.",
    formula:
      'SUM(attributed_installs) WHERE campaign is mapped AND that campaign delivered in the window AND not organic',
    grain: {
      primary: 'install_date',
      note: 'Install-date grain, restricted to campaigns that delivered in the selected window.',
    },
    sources: ['marketing', 'attribution', 'mapping'],
    requiredCapabilities: ['attributed_installs'],
    minimumDenominator: 0,
    format: 'integer',
    maxAcceptableStalenessMinutes: 24 * 60,
  },
  {
    metricKey: 'delivery_aligned_revenue',
    displayName: 'Delivery-aligned attributed revenue',
    description:
      "Revenue on mapped campaigns that also delivered in the selected period. The revenue counterpart of delivery-aligned installs, and the only revenue population comparable against the period's spend.",
    formula:
      'SUM(revenue) WHERE grain = event_date AND campaign is mapped AND that campaign delivered in the window AND not organic',
    grain: {
      primary: 'event_date',
      note: 'Event-date grain, restricted to campaigns that delivered in the selected window.',
    },
    sources: ['marketing', 'attribution', 'mapping'],
    requiredCapabilities: ['attributed_revenue'],
    minimumDenominator: 0,
    format: 'currency',
    maxAcceptableStalenessMinutes: 48 * 60,
  },
  {
    metricKey: 'mapped_cpi',
    displayName: 'Mapped CPI (selected period)',
    description:
      'Spend in the selected period on mapped marketing campaigns, divided by the installs attributed to those same campaigns in the same period. NUMERATOR POPULATION: campaigns mapped to attribution that delivered in the window. DENOMINATOR POPULATION: the same campaigns. Stating both is the point - a ratio whose sides describe different populations is not a CPI, and the difference against the wider mapped population is reported beside it.',
    formula:
      'SUM(marketing.spend WHERE campaign mapped) [report_date] / SUM(attribution.attributed_installs WHERE campaign mapped AND delivered in window) [install_date]',
    grain: {
      primary: 'report_date',
      mixed: ['report_date', 'install_date'],
      note: 'Mixed grain. Numerator is report-date spend; denominator is install-date attributed installs. An operational figure, not cohort CPI.',
    },
    sources: ['marketing', 'attribution', 'mapping'],
    requiredCapabilities: ['cost_data', 'attributed_installs'],
    minimumDenominator: 25,
    format: 'currency',
    maxAcceptableStalenessMinutes: 24 * 60,
  },
  {
    metricKey: 'blended_cpi',
    displayName: 'Blended CPI (incl. organic/unmapped)',
    description:
      'All network spend divided by ALL attributed installs, including organic and installs on campaigns MART cannot map. Useful as a blended figure and not comparable to a campaign CPI: the denominator contains installs the numerator did not buy.',
    formula:
      'SUM(marketing.spend) [report_date] / SUM(attribution.attributed_installs, organic included) [install_date]',
    grain: {
      primary: 'report_date',
      mixed: ['report_date', 'install_date'],
      note: 'Mixed grain, and a mixed population: the denominator includes organic and unmapped installs. This is not cohort CPI, and it is not campaign CPI either - never present it as CPI.',
    },
    sources: ['marketing', 'attribution'],
    requiredCapabilities: ['cost_data', 'attributed_installs'],
    minimumDenominator: 25,
    format: 'currency',
    maxAcceptableStalenessMinutes: 24 * 60,
  },
  {
    metricKey: 'mapped_attributed_revenue',
    displayName: 'Mapped attributed revenue',
    description:
      'Revenue on attribution campaigns that resolve to a marketing campaign. Organic and unmapped revenue are excluded, so this is the only revenue figure that may be compared against network spend.',
    formula: 'SUM(revenue) WHERE grain = event_date AND campaign is mapped AND not organic',
    grain: {
      primary: 'event_date',
      note: 'Event-date grain: revenue recorded on the day it happened, restricted to mapped campaigns.',
    },
    sources: ['attribution', 'mapping'],
    requiredCapabilities: ['attributed_revenue'],
    minimumDenominator: 0,
    format: 'currency',
    maxAcceptableStalenessMinutes: 48 * 60,
  },
  {
    metricKey: 'mapping_coverage',
    displayName: 'Authoritative mapping coverage (all structure)',
    description:
      'Share of marketing-network campaigns linked to an attribution campaign by stable id or human verification. Every name-based match is excluded, however deterministic.',
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
    metricKey: 'operational_mapping_coverage',
    displayName: 'Operational mapping coverage (all structure)',
    description:
      'Authoritative mappings plus deterministic high-confidence name matches, across every campaign MART knows about - including ones that stopped running long ago. Use the current-period campaign coverage for how today looks; this one is the all-structure view.',
    formula: '(authoritative + high_confidence_name_matches) / total_campaign_mappings',
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
    metricKey: 'spend_coverage',
    displayName: 'Spend coverage (selected period)',
    description:
      "Share of the selected period's network spend on campaigns that resolve to attribution. The number that shows whether the money is accounted for: dormant campaigns cannot drag it down, and one large unmapped campaign will.",
    formula: 'SUM(spend on mapped campaigns) / SUM(spend) over the selected window',
    grain: {
      primary: 'report_date',
      note: 'Report-date grain, over the selected reporting window.',
    },
    sources: ['marketing', 'mapping'],
    requiredCapabilities: ['cost_data'],
    minimumDenominator: 0,
    format: 'percent',
    maxAcceptableStalenessMinutes: 24 * 60,
  },
  {
    metricKey: 'attribution_coverage',
    displayName: 'Attribution coverage (selected period)',
    description:
      'Share of paid attributed installs on campaigns that resolve to a marketing campaign. Organic is excluded: it belongs to no campaign and is not a mapping gap.',
    formula: 'SUM(mapped paid installs) / SUM(paid attributed installs) over the selected window',
    grain: { primary: 'install_date', note: 'Install-date grain, paid traffic only.' },
    sources: ['attribution', 'mapping'],
    requiredCapabilities: ['attributed_installs'],
    minimumDenominator: 0,
    format: 'percent',
    maxAcceptableStalenessMinutes: 24 * 60,
  },
  {
    metricKey: 'campaign_operational_coverage',
    displayName: 'Campaign coverage (selected period)',
    description:
      'Share of the campaigns that actually delivered in the selected period that resolve to attribution. Campaigns with no delivery in the period are excluded - a campaign that stopped running last quarter is not a current-period gap.',
    formula: 'mapped campaigns with delivery / campaigns with delivery, over the selected window',
    grain: { primary: 'report_date', note: 'Campaigns with delivery in the selected window.' },
    sources: ['marketing', 'mapping'],
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

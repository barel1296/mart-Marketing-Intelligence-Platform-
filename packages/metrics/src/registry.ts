import type {
  MetricAggregation,
  MetricAvailability,
  MetricBlocker,
  MetricClass,
  MetricFamily,
  MetricGrain,
  MetricPopulation,
  MetricUnit,
} from '@mart/shared';

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

/**
 * What a metric is computed over.
 *
 * Stated per metric rather than left implicit in the SQL, because the way a
 * ratio goes wrong is never dramatic: a numerator and a denominator that are
 * each individually correct get divided, and the answer looks plausible. A
 * metric that names both populations can be checked; one that does not has to
 * be trusted.
 */
export type MetricPopulationSpec = {
  /** The population the value describes, or that the numerator is drawn from. */
  numerator: MetricPopulation;
  /** Present only for ratios. Equal to `numerator` is a legitimate answer. */
  denominator?: MetricPopulation;
  /** Prose for the reader: which rows are in, which are out, and why. */
  note: string;
};

export type MetricDefinition = {
  metricKey: string;
  displayName: string;
  description: string;
  /** Human-readable formula, shown in the UI next to the number. */
  formula: string;
  /** Groups the metric in the Command Center, so the UI carries no such list. */
  family: MetricFamily;
  /** What the value *is*, independent of how it is rendered. */
  unit: MetricUnit;
  /** How the value combines across rows: a ratio is never a SUM of ratios. */
  aggregation: MetricAggregation;
  /** How the number may be read - an operational figure is not a cohort one. */
  semanticClass: MetricClass;
  /** The population(s) the value is drawn from. */
  population: MetricPopulationSpec;
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
    family: 'delivery',
    unit: 'currency',
    aggregation: 'sum',
    semanticClass: 'operational',
    population: {
      numerator: 'current_period_marketing',
      note: 'Every delivery row in the window. Campaigns that did not deliver contribute nothing rather than a zero.',
    },
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
    family: 'delivery',
    unit: 'count',
    aggregation: 'sum',
    semanticClass: 'operational',
    population: {
      numerator: 'current_period_marketing',
      note: 'Every delivery row in the window.',
    },
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
    family: 'delivery',
    unit: 'count',
    aggregation: 'sum',
    semanticClass: 'operational',
    population: {
      numerator: 'current_period_marketing',
      note: 'Every delivery row in the window.',
    },
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
    family: 'delivery',
    unit: 'count',
    aggregation: 'sum',
    semanticClass: 'operational',
    population: {
      numerator: 'current_period_marketing',
      note: 'Every delivery row in the window that reports link clicks; providers that do not report them are absent, not zero.',
    },
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
    family: 'delivery',
    unit: 'ratio',
    aggregation: 'ratio_of_sums',
    semanticClass: 'operational',
    population: {
      numerator: 'current_period_marketing',
      denominator: 'current_period_marketing',
      note: 'One population on both sides: clicks and impressions from the same delivery rows. Summed first, divided once - never an average of per-row ratios.',
    },
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
    family: 'delivery',
    unit: 'currency',
    aggregation: 'ratio_of_sums',
    semanticClass: 'operational',
    population: {
      numerator: 'current_period_marketing',
      denominator: 'current_period_marketing',
      note: 'One population on both sides: spend and impressions from the same delivery rows.',
    },
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
    family: 'delivery',
    unit: 'currency',
    aggregation: 'ratio_of_sums',
    semanticClass: 'operational',
    population: {
      numerator: 'current_period_marketing',
      denominator: 'current_period_marketing',
      note: 'One population on both sides: spend and clicks from the same delivery rows.',
    },
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
    family: 'attribution',
    unit: 'count',
    aggregation: 'sum',
    semanticClass: 'operational',
    population: {
      numerator: 'all_attribution',
      note: 'Every attributed install in the window, paid and organic alike. Not a marketing figure: it counts installs the network was never asked to buy.',
    },
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
    family: 'revenue',
    unit: 'currency',
    aggregation: 'sum',
    semanticClass: 'operational',
    population: {
      numerator: 'all_attribution',
      note: 'All attributed revenue, organic included, recognized on the date it occurred.',
    },
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
    metricKey: 'paid_attributed_installs',
    displayName: 'Paid installs',
    description:
      'Attributed installs excluding organic, whether or not the campaign behind them is mapped. The honest denominator for "how much did paid acquisition deliver".',
    formula: 'attributed_installs - organic_installs',
    family: 'attribution',
    unit: 'count',
    aggregation: 'sum',
    semanticClass: 'operational',
    population: {
      numerator: 'paid_attribution',
      note: 'Every non-organic install in the window, mapped or not. Wider than the mapped population and narrower than the attributed total.',
    },
    grain: { primary: 'install_date', note: 'Install-date (cohort anchor) grain.' },
    sources: ['attribution'],
    requiredCapabilities: [],
    minimumDenominator: 0,
    format: 'integer',
    maxAcceptableStalenessMinutes: 24 * 60,
  },
  {
    metricKey: 'iap_revenue',
    displayName: 'IAP revenue',
    description:
      'Revenue from in-app purchases, recognized on the date it occurred. Never added to ad revenue by the provider adapter - MART stores the two as separate facts.',
    formula: "SUM(revenue) WHERE revenue_type = 'iap'",
    family: 'revenue',
    unit: 'currency',
    aggregation: 'sum',
    semanticClass: 'operational',
    population: {
      numerator: 'all_attribution',
      note: 'All attributed IAP revenue in the window, organic included.',
    },
    grain: { primary: 'event_date', note: 'Event-date grain: recognized when it happened.' },
    sources: ['attribution'],
    requiredCapabilities: [],
    minimumDenominator: 0,
    format: 'currency',
    maxAcceptableStalenessMinutes: 24 * 60,
  },
  {
    metricKey: 'ad_revenue',
    displayName: 'Ad revenue',
    description:
      'Revenue from ad monetization, recognized on the date it occurred. Providers spell this several ways and sometimes also offer a combined total; MART stores the component and never sums two spellings of it.',
    formula: "SUM(revenue) WHERE revenue_type = 'ad'",
    family: 'revenue',
    unit: 'currency',
    aggregation: 'sum',
    semanticClass: 'operational',
    population: {
      numerator: 'all_attribution',
      note: 'All attributed ad revenue in the window, organic included.',
    },
    grain: { primary: 'event_date', note: 'Event-date grain: recognized when it happened.' },
    sources: ['attribution'],
    requiredCapabilities: [],
    minimumDenominator: 0,
    format: 'currency',
    maxAcceptableStalenessMinutes: 24 * 60,
  },
  {
    metricKey: 'mapped_paid_installs',
    displayName: 'Mapped paid installs (all mapped campaigns)',
    description:
      "Installs on attribution campaigns that resolve to a campaign in the marketing network, by stable id, human verification, or a deterministic high-confidence name match. Organic is excluded. This is the MAPPING population: it includes installs on campaigns that did not deliver in the selected period, so it is a coverage figure and not a denominator for the period's spend.",
    formula: 'SUM(attributed_installs) WHERE campaign is mapped AND media_source <> organic',
    family: 'attribution',
    unit: 'count',
    aggregation: 'sum',
    semanticClass: 'mapping',
    population: {
      numerator: 'mapped_paid_attribution',
      note: 'Paid installs on an attribution campaign linked to a marketing campaign, whenever that campaign delivered. A coverage figure - it answers how much of the account is mapped, not what ran in this window.',
    },
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
    family: 'attribution',
    unit: 'count',
    aggregation: 'sum',
    semanticClass: 'operational',
    population: {
      numerator: 'organic_attribution',
      note: 'Unpaid installs only. Held apart from every paid figure so no campaign is credited with traffic it did not buy.',
    },
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
    family: 'attribution',
    unit: 'count',
    aggregation: 'sum',
    semanticClass: 'operational',
    population: {
      numerator: 'delivery_aligned_paid_attribution',
      note: 'Mapped paid installs whose marketing campaign also delivered inside this window. The population that corresponds to windowed spend.',
    },
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
    family: 'revenue',
    unit: 'currency',
    aggregation: 'sum',
    semanticClass: 'operational',
    population: {
      numerator: 'delivery_aligned_paid_attribution',
      note: 'Revenue from the same delivery-aligned population, so it can be compared with windowed spend.',
    },
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
    family: 'efficiency',
    unit: 'currency',
    aggregation: 'ratio_of_sums',
    semanticClass: 'operational',
    population: {
      numerator: 'current_period_marketing',
      denominator: 'delivery_aligned_paid_attribution',
      note: 'Spend from campaigns that delivered in this window, over installs on those same campaigns. The wider mapping population is deliberately NOT the denominator: pairing it with windowed spend would divide by installs no spend here bought.',
    },
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
    family: 'efficiency',
    unit: 'currency',
    aggregation: 'ratio_of_sums',
    semanticClass: 'operational',
    population: {
      numerator: 'current_period_marketing',
      denominator: 'all_attribution',
      note: 'All spend over all installs, organic and unmapped included. A budget figure, never a campaign one - the denominator contains installs no campaign paid for.',
    },
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
    family: 'revenue',
    unit: 'currency',
    aggregation: 'sum',
    semanticClass: 'mapping',
    population: {
      numerator: 'mapped_paid_attribution',
      note: 'Revenue on mapped campaigns, whenever they delivered. Compare it with delivery-aligned revenue, not with windowed spend.',
    },
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
    family: 'coverage',
    unit: 'percentage',
    aggregation: 'ratio_of_sums',
    semanticClass: 'mapping',
    population: {
      numerator: 'all_structure',
      denominator: 'all_structure',
      note: 'Every marketing campaign MART knows, whenever it last delivered. Authoritative links only, so a name match never counts here.',
    },
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
    family: 'coverage',
    unit: 'percentage',
    aggregation: 'ratio_of_sums',
    semanticClass: 'mapping',
    population: {
      numerator: 'all_structure',
      denominator: 'all_structure',
      note: 'The same all-structure denominator, counting deterministic high-confidence matches as well as authoritative ones.',
    },
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
    family: 'coverage',
    unit: 'percentage',
    aggregation: 'ratio_of_sums',
    semanticClass: 'mapping',
    population: {
      numerator: 'current_period_marketing',
      denominator: 'current_period_marketing',
      note: 'Share of the window own spend sitting on mapped campaigns. Both sides are the selected period, never all structure.',
    },
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
    family: 'coverage',
    unit: 'percentage',
    aggregation: 'ratio_of_sums',
    semanticClass: 'mapping',
    population: {
      numerator: 'mapped_paid_attribution',
      denominator: 'paid_attribution',
      note: 'Share of paid installs in the window that resolve to a marketing campaign. Organic is excluded from both sides: it is correctly unmapped, not a gap.',
    },
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
    family: 'coverage',
    unit: 'percentage',
    aggregation: 'ratio_of_sums',
    semanticClass: 'mapping',
    population: {
      numerator: 'current_period_marketing',
      denominator: 'current_period_marketing',
      note: 'Share of the campaigns that delivered in this window which are mapped. Counted per campaign, not per mapping row, so a campaign with several children cannot raise its own coverage.',
    },
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
    family: 'cohort',
    unit: 'ratio',
    aggregation: 'ratio_of_sums',
    semanticClass: 'cohort',
    population: {
      numerator: 'delivery_aligned_paid_attribution',
      denominator: 'current_period_marketing',
      note: 'Cohort revenue over the spend that acquired the cohort. Both sides must be anchored on the same install cohort, which is why this stays uncomputed while only report-date spend exists.',
    },
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
  /**
   * Present exactly when availability is 'blocked': the machine-readable
   * condition that stopped the metric, so a consumer can act on it without
   * parsing the prose.
   */
  blocker?: MetricBlocker;
  grain: MetricGrainSpec;
  sources: MetricSource[];
  format: MetricFormat;
  formula: string;
  /**
   * The semantic contract, carried with the value rather than left in the
   * registry for consumers to look up. A number that travels without saying
   * what it measures and over which population can only be trusted, and the
   * consumers that most need to check it - the audit CLIs, and later anything
   * reasoning over these figures - are exactly the ones that cannot ask.
   */
  family: MetricFamily;
  unit: MetricUnit;
  aggregation: MetricAggregation;
  semanticClass: MetricClass;
  population: MetricPopulationSpec;
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

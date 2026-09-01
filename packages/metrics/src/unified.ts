import type { MetricBlocker, ReportingWindow } from '@mart/shared';
import {
  loadAttributionAggregate,
  loadMarketingAggregate,
  computeMetricValues,
  type MetricContext,
  type MetricFilters,
} from './service.js';
import type { MetricValue } from './registry.js';
import { scoreConfidence, type MetricConfidence, type MetricLineage } from './confidence.js';
import { MINIMUM_RATIO_DENOMINATORS } from './thresholds.js';

/**
 * One provider-neutral answer to "how did this app perform".
 *
 * The point is what a caller does NOT need to know: not which network is bound,
 * not that Tenjin calls an install a tracked_install, not that a Meta remote id
 * points at an ad set rather than a campaign. Business code asks this object
 * and gets figures that mean the same thing whichever providers produced them.
 *
 * It is assembled from the existing metric layer rather than replacing it -
 * every number here is a governed MetricValue, carrying its own population,
 * grain, availability and reason. The object groups them and adds what only
 * makes sense across the whole result: the coverage the figures rest on, the
 * quality conditions in play, and a confidence score that says how much weight
 * the set will bear.
 */
export type UnifiedPerformance = {
  scope: { organizationId: string; appId: string };
  window: ReportingWindow;
  /** The dimensions this result is narrowed to. */
  dimensions: {
    country: string | null;
    platform: string | null;
    channel: string | null;
    marketingAccountExternalId: string | null;
  };
  /** Who reported the rows. Metadata, not a thing callers must branch on. */
  providers: { marketing: string | null; attribution: string | null };

  marketing: MetricGroup;
  attribution: MetricGroup;
  revenue: MetricGroup;
  efficiency: MetricGroup;
  coverage: MetricGroup;

  /** Conditions qualifying anything in the result, deduplicated. */
  quality: {
    blockers: MetricBlocker[];
    /** Metric keys that are not fully available, with their reasons. */
    qualified: Array<{ metricKey: string; availability: string; reason: string }>;
  };
  freshness: {
    marketing: { status: string; latestDataDate: string | null } | null;
    attribution: { status: string; latestDataDate: string | null } | null;
  };
  /** Deterministic, decomposable, and never applied to the arithmetic. */
  confidence: MetricConfidence;
  /** Where each figure came from, for the ones worth tracing. */
  lineage: MetricLineage[];
};

/** Metric values keyed by metric key, so callers read `marketing.spend.value`. */
export type MetricGroup = Record<string, MetricValue>;

const FACT_FAMILIES: Readonly<Record<string, string>> = {
  marketing: 'marketing_daily_metrics',
  attribution: 'attribution_daily_metrics',
  mapping: 'provider_entity_mappings',
};

function group(metrics: MetricValue[], family: string): MetricGroup {
  const out: MetricGroup = {};
  for (const metric of metrics) {
    if (metric.family === family) out[metric.metricKey] = metric;
  }
  return out;
}

/**
 * Read one app's performance over one window.
 *
 * Every figure is drawn from the same filters, so the object is internally
 * consistent by construction: there is no way for the coverage in it to
 * describe a different slice from the CPI beside it.
 */
export async function loadUnifiedPerformance(input: {
  filters: MetricFilters;
  context: MetricContext;
  window: ReportingWindow;
}): Promise<UnifiedPerformance> {
  const { filters, context, window } = input;
  const [marketing, attribution] = await Promise.all([
    loadMarketingAggregate(filters),
    loadAttributionAggregate(filters),
  ]);
  const metrics = computeMetricValues({ context, marketing, attribution });

  const qualified = metrics
    .filter((m) => m.availability !== 'available')
    .map((m) => ({
      metricKey: m.metricKey,
      availability: m.availability,
      // Every qualified metric explains itself; the fallback exists so this
      // array can never carry a silent one.
      reason: m.reason ?? 'No reason recorded.',
    }));
  const blockers = [
    ...new Set(metrics.map((m) => m.blocker).filter((b): b is MetricBlocker => Boolean(b))),
  ];

  const eligible = context.mappingCoverage?.eligible;
  const confidence = scoreConfidence({
    freshness: context.marketingFreshness?.status ?? context.attributionFreshness?.status,
    spendCoveragePct:
      eligible && eligible.totalSpend > 0
        ? (eligible.mappedSpend / eligible.totalSpend) * 100
        : null,
    ambiguousSpendPct:
      eligible && eligible.totalSpend > 0
        ? (eligible.ambiguousSpend / eligible.totalSpend) * 100
        : null,
    sampleSize: attribution.deliveryAlignedPaidInstalls,
    minimumSample: MINIMUM_RATIO_DENOMINATORS.installs,
  });

  const lineage: MetricLineage[] = metrics.map((metric) => ({
    metricKey: metric.metricKey,
    providers: metric.providers,
    factFamilies: metric.sources.map((source) => FACT_FAMILIES[source] ?? source),
    window: { from: window.startDate, to: window.endDate, timezone: window.timezone },
    population: {
      numerator: metric.population.numerator,
      ...(metric.population.denominator ? { denominator: metric.population.denominator } : {}),
    },
    dateSemantics: {
      primary: metric.grain.primary,
      ...(metric.grain.mixed ? { mixed: metric.grain.mixed } : {}),
    },
    numerator: metric.numerator,
    denominator: metric.denominator,
    // The checks whose findings bear on this figure, named so a reader can go
    // look at them rather than guess which panel explains the caveat.
    qualityDependencies: metric.sources.includes('mapping')
      ? ['reconciliation.current_period_spend_unmapped', 'reconciliation.ambiguous_mappings']
      : [],
    ...(metric.blocker ? { blocker: metric.blocker } : {}),
  }));

  return {
    scope: { organizationId: filters.organizationId, appId: filters.appId },
    window,
    dimensions: {
      country: filters.country ?? null,
      platform: filters.platform ?? null,
      channel: filters.channel ?? null,
      marketingAccountExternalId: filters.marketingAccountExternalId ?? null,
    },
    providers: {
      marketing: filters.marketingProviderKey ?? null,
      attribution: filters.attributionProviderKey ?? null,
    },
    marketing: group(metrics, 'delivery'),
    attribution: group(metrics, 'attribution'),
    revenue: group(metrics, 'revenue'),
    efficiency: group(metrics, 'efficiency'),
    coverage: group(metrics, 'coverage'),
    quality: { blockers, qualified },
    freshness: {
      marketing: context.marketingFreshness
        ? {
            status: context.marketingFreshness.status,
            latestDataDate: context.marketingFreshness.latestDataDate,
          }
        : null,
      attribution: context.attributionFreshness
        ? {
            status: context.attributionFreshness.status,
            latestDataDate: context.attributionFreshness.latestDataDate,
          }
        : null,
    },
    confidence,
    lineage,
  };
}

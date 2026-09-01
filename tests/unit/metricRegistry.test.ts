import { describe, expect, it } from 'vitest';
import {
  METRIC_AGGREGATIONS,
  METRIC_CLASSES,
  METRIC_FAMILIES,
  METRIC_POPULATIONS,
  METRIC_UNITS,
} from '@mart/shared';
import { METRIC_DEFINITIONS, listMetricDefinitions } from '@mart/metrics';

/**
 * The registry is MART's semantic contract.
 *
 * Everything downstream - the API, the dashboard, the audit CLIs and, later,
 * anything reasoning over these numbers - reads meaning from here rather than
 * rediscovering it. A metric that does not say what it measures, over which
 * population, at which grain, is a number nobody can check.
 */
describe('metric registry contract', () => {
  it('gives every metric a unique key', () => {
    const keys = METRIC_DEFINITIONS.map((d) => d.metricKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('declares family, unit, aggregation, class and population for every metric', () => {
    for (const metric of METRIC_DEFINITIONS) {
      expect(METRIC_FAMILIES, metric.metricKey).toContain(metric.family);
      expect(METRIC_UNITS, metric.metricKey).toContain(metric.unit);
      expect(METRIC_AGGREGATIONS, metric.metricKey).toContain(metric.aggregation);
      expect(METRIC_CLASSES, metric.metricKey).toContain(metric.semanticClass);
      expect(METRIC_POPULATIONS, metric.metricKey).toContain(metric.population.numerator);
      // The note is what a reader checks the number against, so it has to say
      // something: which rows are in, which are out.
      expect(metric.population.note.length, metric.metricKey).toBeGreaterThan(20);
    }
  });

  it('makes every ratio name its denominator population', () => {
    // A ratio without a stated denominator population is exactly the defect the
    // population model exists to prevent: two individually correct numbers
    // divided into a plausible, meaningless answer.
    for (const metric of METRIC_DEFINITIONS) {
      if (metric.aggregation === 'ratio_of_sums') {
        expect(metric.population.denominator, metric.metricKey).toBeDefined();
        expect(METRIC_POPULATIONS, metric.metricKey).toContain(metric.population.denominator);
      } else {
        // A raw measure is not a share of anything, so claiming a denominator
        // would misdescribe it.
        expect(metric.population.denominator, metric.metricKey).toBeUndefined();
      }
    }
  });

  it('keeps mapped CPI on the delivery-aligned denominator, not the mapping population', () => {
    // The distinction this pins down cost a real correctness bug: windowed
    // spend divided by every install on a mapped campaign, whenever it ran.
    const cpi = METRIC_DEFINITIONS.find((d) => d.metricKey === 'mapped_cpi');
    expect(cpi?.population.numerator).toBe('current_period_marketing');
    expect(cpi?.population.denominator).toBe('delivery_aligned_paid_attribution');

    const mapped = METRIC_DEFINITIONS.find((d) => d.metricKey === 'mapped_paid_installs');
    expect(mapped?.population.numerator).toBe('mapped_paid_attribution');
    // Coverage figure, not a CPI denominator: the two populations stay apart.
    expect(mapped?.population.numerator).not.toBe(cpi?.population.denominator);
  });

  it('never lets a cohort metric pass as an operational one', () => {
    for (const metric of METRIC_DEFINITIONS.filter((d) => d.semanticClass === 'cohort')) {
      expect(['install_date', 'cohort_date'], metric.metricKey).toContain(metric.grain.primary);
    }
    // And the reverse: an operational metric must not claim cohort grain.
    for (const metric of METRIC_DEFINITIONS.filter((d) => d.semanticClass === 'operational')) {
      expect(metric.grain.primary, metric.metricKey).not.toBe('cohort_date');
    }
  });

  it('declares mixed grain wherever a ratio crosses date semantics', () => {
    const crossing = ['mapped_cpi', 'blended_cpi'];
    for (const key of crossing) {
      const metric = METRIC_DEFINITIONS.find((d) => d.metricKey === key);
      expect(metric?.grain.mixed, key).toBeDefined();
      expect(metric?.grain.mixed?.length, key).toBeGreaterThan(1);
    }
  });

  it('carries every metric Phase 1 names', () => {
    const required = [
      'spend',
      'impressions',
      'clicks',
      'ctr',
      'cpm',
      'cpc',
      'attributed_installs',
      'paid_attributed_installs',
      'organic_installs',
      'mapped_paid_installs',
      'delivery_aligned_paid_installs',
      'mapped_cpi',
      'blended_cpi',
      'iap_revenue',
      'ad_revenue',
      'attributed_revenue',
      'mapped_attributed_revenue',
      'delivery_aligned_revenue',
      'campaign_operational_coverage',
      'spend_coverage',
      'attribution_coverage',
      'mapping_coverage',
      'operational_mapping_coverage',
    ];
    const keys = new Set(listMetricDefinitions().map((d) => d.metricKey));
    for (const key of required) expect(keys.has(key), key).toBe(true);
  });

  it('groups every metric under a family, so no consumer needs its own list', () => {
    // The dashboard used to carry a hand-ordered array of metric keys. Family
    // is what replaces it: add a metric here and it appears in its section.
    const byFamily = new Map<string, number>();
    for (const metric of METRIC_DEFINITIONS) {
      byFamily.set(metric.family, (byFamily.get(metric.family) ?? 0) + 1);
    }
    for (const family of ['delivery', 'attribution', 'revenue', 'efficiency', 'coverage']) {
      expect(byFamily.get(family) ?? 0, family).toBeGreaterThan(0);
    }
  });
});

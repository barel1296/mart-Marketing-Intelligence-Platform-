import { describe, expect, it } from 'vitest';
import {
  computeMetricValues,
  determineAvailability,
  getMetricDefinition,
  listMetricDefinitions,
  safeRatio,
  type MetricContext,
} from '@mart/metrics';

function context(overrides: Partial<MetricContext> = {}): MetricContext {
  return {
    hasMarketingConnection: true,
    hasAttributionConnection: true,
    marketingProviders: ['meta_ads'],
    attributionProviders: ['appsflyer'],
    supportedCapabilities: new Set([
      'cost_data',
      'delivery_metrics',
      'attributed_installs',
      'attributed_revenue',
      'link_clicks',
    ]),
    marketingFreshness: { status: 'fresh', latestDataDate: '2026-08-26' },
    attributionFreshness: { status: 'fresh', latestDataDate: '2026-08-26' },
    ...overrides,
  };
}

const marketing = {
  spend: 1000,
  impressions: 500_000,
  clicks: 10_000,
  linkClicks: 8_000,
  rows: 42,
  currencies: ['USD'],
  latestDate: '2026-08-26',
};

const attribution = {
  attributedInstalls: 400,
  attributedRevenue: 250,
  rows: 20,
  latestInstallDate: '2026-08-26',
  latestRevenueDate: '2026-08-26',
};

function metric(key: string, ctx = context(), m = marketing, a = attribution) {
  const [value] = computeMetricValues({
    metricKeys: [key],
    context: ctx,
    marketing: m,
    attribution: a,
  });
  if (!value) throw new Error(`metric ${key} not produced`);
  return value;
}

describe('metric arithmetic', () => {
  it('computes CTR from summed clicks and impressions', () => {
    const ctr = metric('ctr');
    expect(ctr.value).toBeCloseTo(10_000 / 500_000, 10);
    expect(ctr.numerator).toBe(10_000);
    expect(ctr.denominator).toBe(500_000);
    expect(ctr.availability).toBe('available');
  });

  it('computes CPM as spend / impressions * 1000', () => {
    expect(metric('cpm').value).toBeCloseTo((1000 / 500_000) * 1000, 10);
  });

  it('computes CPC as spend / clicks', () => {
    expect(metric('cpc').value).toBeCloseTo(1000 / 10_000, 10);
  });

  it('computes reported CPI as spend / attributed installs', () => {
    expect(metric('reported_cpi').value).toBeCloseTo(1000 / 400, 10);
  });

  /**
   * The regression this guards: averaging per-campaign ratios instead of
   * dividing summed numerators by summed denominators. The two differ, and the
   * difference is large enough to change a scaling decision.
   */
  it('aggregates ratios from sums, not by averaging per-entity ratios', () => {
    const campaigns = [
      { clicks: 100, impressions: 1_000 }, // 10%
      { clicks: 10, impressions: 100_000 }, // 0.01%
    ];
    const meanOfRatios =
      campaigns.reduce((acc, c) => acc + c.clicks / c.impressions, 0) / campaigns.length;
    const totals = campaigns.reduce(
      (acc, c) => ({ clicks: acc.clicks + c.clicks, impressions: acc.impressions + c.impressions }),
      { clicks: 0, impressions: 0 },
    );

    const correct = metric('ctr', context(), { ...marketing, ...totals });
    expect(correct.value).toBeCloseTo(110 / 101_000, 10);
    expect(correct.value).not.toBeCloseTo(meanOfRatios, 4);
  });

  it('refuses a ratio when the denominator is below the metric minimum', () => {
    const ctr = metric('ctr', context(), { ...marketing, impressions: 10, clicks: 1 });
    expect(ctr.value).toBeNull();
    expect(ctr.availability).toBe('unavailable');
    expect(ctr.reason).toMatch(/below the minimum/);
  });

  it('refuses a ratio when the denominator is zero rather than returning zero', () => {
    const cpc = metric('cpc', context(), { ...marketing, clicks: 0 });
    expect(cpc.value).toBeNull();
    expect(cpc.reason).toMatch(/zero/i);
  });

  it('reports reported CPI as unavailable below the install minimum', () => {
    const cpi = metric('reported_cpi', context(), marketing, {
      ...attribution,
      attributedInstalls: 5,
    });
    expect(cpi.value).toBeNull();
    expect(cpi.availability).toBe('unavailable');
  });
});

describe('grain safety', () => {
  it('labels reported CPI as a mixed-grain figure and not cohort CPI', () => {
    const definition = getMetricDefinition('reported_cpi');
    expect(definition?.grain.mixed).toEqual(['report_date', 'install_date']);
    expect(definition?.grain.note).toMatch(/not cohort CPI/i);
    expect(definition?.displayName).not.toMatch(/cohort/i);
  });

  it('never returns a cohort ROAS value in this phase', () => {
    const roas = metric('cohort_roas');
    expect(roas.value).toBeNull();
    expect(roas.availability).toBe('unavailable');
    expect(roas.reason).toMatch(/cohort-matched spend/i);
  });

  it('declares a single grain for every non-mixed metric', () => {
    for (const definition of listMetricDefinitions()) {
      expect(definition.grain.primary).toBeTruthy();
      expect(definition.grain.note.length).toBeGreaterThan(0);
      if (definition.grain.mixed) {
        expect(definition.grain.mixed.length).toBeGreaterThan(1);
      }
    }
  });

  it('keeps attributed installs on install-date grain and revenue on event-date', () => {
    expect(getMetricDefinition('attributed_installs')?.grain.primary).toBe('install_date');
    expect(getMetricDefinition('attributed_revenue')?.grain.primary).toBe('event_date');
    expect(getMetricDefinition('spend')?.grain.primary).toBe('report_date');
  });
});

describe('availability gating', () => {
  it('is unavailable, not zero, when no marketing network is connected', () => {
    const spend = metric('spend', context({ hasMarketingConnection: false }));
    expect(spend.value).toBeNull();
    expect(spend.availability).toBe('unavailable');
    expect(spend.reason).toMatch(/No marketing network/i);
  });

  it('is unavailable when no attribution provider is configured', () => {
    const installs = metric('attributed_installs', context({ hasAttributionConnection: false }));
    expect(installs.availability).toBe('unavailable');
    expect(installs.reason).toMatch(/attribution provider/i);
  });

  it('is unavailable when the provider lacks the required capability', () => {
    const installs = metric(
      'attributed_installs',
      context({ supportedCapabilities: new Set(['cost_data']) }),
    );
    expect(installs.availability).toBe('unavailable');
    expect(installs.reason).toMatch(/does not expose/i);
  });

  it('marks metrics stale when the underlying data is stale', () => {
    const spend = metric(
      'spend',
      context({ marketingFreshness: { status: 'stale', latestDataDate: '2026-08-01' } }),
    );
    expect(spend.availability).toBe('stale');
    expect(spend.value).toBe(1000);
  });

  it('reports link clicks as unavailable when the network did not supply them', () => {
    const value = metric('link_clicks', context(), { ...marketing, linkClicks: null });
    expect(value.availability).toBe('unavailable');
    expect(value.reason).toMatch(/did not report/i);
  });

  it('carries provider provenance on every value', () => {
    expect(metric('spend').providers).toEqual(['meta_ads']);
    expect(metric('attributed_installs').providers).toEqual(['appsflyer']);
    expect(metric('reported_cpi').providers).toEqual(['meta_ads', 'appsflyer']);
  });
});

describe('determineAvailability', () => {
  it('prefers the explicit unavailable reason over any data state', () => {
    const definition = getMetricDefinition('cohort_roas');
    if (!definition) throw new Error('missing definition');
    const result = determineAvailability(definition, context());
    expect(result.availability).toBe('unavailable');
  });
});

describe('safeRatio', () => {
  it('returns null with a reason instead of Infinity or NaN', () => {
    expect(safeRatio(5, 0, 0).value).toBeNull();
    expect(safeRatio(0, 0, 0).value).toBeNull();
    expect(safeRatio(5, 10, 0).value).toBe(0.5);
  });
});

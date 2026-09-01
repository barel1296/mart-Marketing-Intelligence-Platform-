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
  mappedSpend: 800,
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
  mappedPaidInstalls: 300,
  mappedAttributedRevenue: 180,
  deliveryAlignedPaidInstalls: 300,
  deliveryAlignedRevenue: 180,
  organicInstalls: 100,
  organicRevenue: 70,
  iapRevenue: 180,
  adRevenue: 70,
  currencies: ['USD'],
  unmappedPaidInstalls: 0,
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

  it('computes blended CPI as all spend / all attributed installs', () => {
    expect(metric('blended_cpi').value).toBeCloseTo(1000 / 400, 10);
  });

  /**
   * The regression this guards: dividing network spend by every attributed
   * install - organic included - and calling the result CPI. Both sides of a
   * mapped CPI must describe the same campaigns.
   */
  it('computes mapped CPI from mapped spend over mapped paid installs only', () => {
    expect(metric('mapped_cpi').value).toBeCloseTo(800 / 300, 10);
    expect(metric('mapped_cpi').value).not.toBeCloseTo(1000 / 400, 10);
  });

  /**
   * Population alignment. Spend is summed over the selected window, so a
   * campaign that spent nothing in it contributes zero to the numerator - while
   * its installs, mapped perfectly well, would still land in the denominator.
   * Dividing one population by the other understates cost per install.
   */
  it('divides window spend only by installs whose campaign delivered in the window', () => {
    const cpi = metric('mapped_cpi', context(), marketing, {
      ...attribution,
      mappedPaidInstalls: 300,
      // 100 of those are on a campaign that did not deliver in this window.
      deliveryAlignedPaidInstalls: 200,
    });
    expect(cpi.value).toBeCloseTo(800 / 200, 10);
    expect(cpi.value).not.toBeCloseTo(800 / 300, 10);
    expect(cpi.availability).toBe('partial');
    expect(cpi.reason).toMatch(/did not deliver in this period/i);
  });

  it('keeps the mapping population and the delivery-aligned population apart', () => {
    const values = (a: typeof attribution) => ({
      mapped: metric('mapped_paid_installs', context(), marketing, a).value,
      aligned: metric('delivery_aligned_paid_installs', context(), marketing, a).value,
      mappedRevenue: metric('mapped_attributed_revenue', context(), marketing, a).value,
      alignedRevenue: metric('delivery_aligned_revenue', context(), marketing, a).value,
    });
    expect(
      values({
        ...attribution,
        mappedPaidInstalls: 300,
        deliveryAlignedPaidInstalls: 200,
        mappedAttributedRevenue: 180,
        deliveryAlignedRevenue: 120,
      }),
    ).toEqual({ mapped: 300, aligned: 200, mappedRevenue: 180, alignedRevenue: 120 });
    // Two labels, two numbers: neither is silently the other.
    expect(metric('mapped_paid_installs').displayName).toMatch(/all mapped campaigns/i);
    expect(metric('delivery_aligned_paid_installs').displayName).toMatch(/delivery-aligned/i);
    expect(metric('mapped_cpi').displayName).toMatch(/selected period/i);
  });

  it('states both populations in the mapped CPI definition', () => {
    const definition = getMetricDefinition('mapped_cpi');
    expect(definition?.description).toMatch(/NUMERATOR POPULATION/);
    expect(definition?.description).toMatch(/DENOMINATOR POPULATION/);
  });

  it('never lets organic installs into a mapped figure', () => {
    const mapped = metric('mapped_paid_installs');
    expect(mapped.value).toBe(300);
    expect(metric('organic_installs').value).toBe(100);
    expect(metric('attributed_installs').value).toBe(400);
  });

  it('labels blended CPI as blended, and says what is in the denominator', () => {
    const blended = metric('blended_cpi', context(), marketing, {
      ...attribution,
      unmappedPaidInstalls: 20,
    });
    expect(blended.displayName).toMatch(/blended/i);
    expect(blended.availability).toBe('partial');
    expect(blended.reason).toMatch(/organic/i);
    expect(blended.reason).toMatch(/unmapped/i);
  });

  it('refuses a mapped CPI when nothing is mapped, and says why', () => {
    const cpi = metric('mapped_cpi', context(), marketing, {
      ...attribution,
      mappedPaidInstalls: 0,
      deliveryAlignedPaidInstalls: 0,
      unmappedPaidInstalls: 300,
    });
    expect(cpi.value).toBeNull();
    expect(cpi.availability).toBe('unavailable');
    expect(cpi.reason).toMatch(/no attribution campaign is mapped/i);
  });

  it('refuses a mapped CPI when the mapped campaigns did not deliver here', () => {
    const cpi = metric('mapped_cpi', context(), marketing, {
      ...attribution,
      mappedPaidInstalls: 300,
      deliveryAlignedPaidInstalls: 0,
    });
    expect(cpi.value).toBeNull();
    expect(cpi.availability).toBe('unavailable');
    expect(cpi.reason).toMatch(/did not deliver in this period/i);
  });

  it('marks a mapped CPI partial while paid installs remain unmapped', () => {
    const cpi = metric('mapped_cpi', context(), marketing, {
      ...attribution,
      unmappedPaidInstalls: 40,
    });
    expect(cpi.value).toBeCloseTo(800 / 300, 10);
    expect(cpi.availability).toBe('partial');
    expect(cpi.reason).toMatch(/40 paid install/i);
  });

  it('keeps total and mapped revenue apart', () => {
    expect(metric('attributed_revenue').value).toBe(250);
    expect(metric('mapped_attributed_revenue').value).toBe(180);
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

  it('reports blended CPI as unavailable below the install minimum', () => {
    const cpi = metric('blended_cpi', context(), marketing, {
      ...attribution,
      attributedInstalls: 5,
    });
    expect(cpi.value).toBeNull();
    expect(cpi.availability).toBe('unavailable');
  });
});

describe('grain safety', () => {
  it('labels both CPI figures as mixed-grain and not cohort CPI', () => {
    for (const key of ['mapped_cpi', 'blended_cpi']) {
      const definition = getMetricDefinition(key);
      expect(definition?.grain.mixed, key).toEqual(['report_date', 'install_date']);
      expect(definition?.grain.note, key).toMatch(/not cohort CPI/i);
      expect(definition?.displayName, key).not.toMatch(/cohort/i);
    }
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
    expect(metric('blended_cpi').providers).toEqual(['meta_ads', 'appsflyer']);
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

describe('quality gates', () => {
  const coverage = (mappedSpend: number, totalSpend: number, ambiguousSpend = 0) => ({
    total: 10,
    authoritative: 8,
    operational: 9,
    eligible: {
      eligibleCampaigns: 5,
      mappedCampaigns: 4,
      ambiguousCampaigns: 0,
      unmappedCampaigns: 1,
      historicalCampaigns: 0,
      totalSpend,
      mappedSpend,
      ambiguousSpend,
      unmappedSpend: totalSpend - mappedSpend - ambiguousSpend,
      totalPaidInstalls: 400,
      mappedPaidInstalls: 300,
      ambiguousPaidInstalls: 0,
      unmappedPaidInstalls: 100,
    },
  });

  it('qualifies a figure drawn from thin coverage rather than withholding it', () => {
    // The arithmetic is sound and an operator may legitimately want the number;
    // what they must not do is read it as a description of the whole account.
    // Blocking it outright would remove a usable figure to make a point the
    // caveat already makes.
    const ctx = { ...context(), mappingCoverage: coverage(20, 100) };
    const value = metric('mapped_cpi', ctx);
    expect(value?.availability).toBe('partial');
    expect(value?.blocker).toBe('insufficient_coverage');
    expect(value?.value).not.toBeNull();
    expect(value?.reason).toMatch(/20.0% of spend/);
  });

  it('says nothing about coverage when there is enough of it', () => {
    const ctx = { ...context(), mappingCoverage: coverage(95, 100) };
    const value = metric('mapped_cpi', ctx);
    expect(value?.availability).toBe('available');
    expect(value?.blocker).toBeUndefined();
  });

  it('flags ambiguity that a human has not resolved', () => {
    const ctx = { ...context(), mappingCoverage: coverage(85, 100, 15) };
    const value = metric('mapped_cpi', ctx);
    expect(value?.availability).toBe('partial');
    expect(value?.blocker).toBe('ambiguous_mapping');
    expect(value?.reason).toMatch(/equally good/);
  });

  it('names the condition behind a missing provider, not just the prose', () => {
    const value = metric('spend', { ...context(), hasMarketingConnection: false });
    expect(value?.availability).toBe('unavailable');
    expect(value?.blocker).toBe('missing_provider');
  });

  it('enforces the per-metric staleness tolerance the registry declares', () => {
    // The field was declared on every metric and read by nothing.
    const ctx = {
      ...context(),
      marketingFreshness: {
        status: 'fresh',
        latestDataDate: '2026-08-26',
        minutesSinceSuccess: 60 * 30,
      },
    };
    const value = metric('spend', ctx);
    expect(value?.availability).toBe('stale');
    expect(value?.blocker).toBe('provider_stale');
    expect(value?.reason).toMatch(/30h ago/);
  });

  it('leaves a metric alone while it is inside its tolerance', () => {
    const ctx = {
      ...context(),
      marketingFreshness: {
        status: 'fresh',
        latestDataDate: '2026-08-26',
        minutesSinceSuccess: 60 * 3,
      },
    };
    expect(metric('spend', ctx)?.availability).toBe('available');
  });
});

describe('currency isolation', () => {
  it('refuses a money metric drawn from more than one currency', () => {
    // 100 USD + 100 EUR is not 200 of anything. The sum would look entirely
    // ordinary, which is exactly why this has to be refused rather than shown.
    const mixed = { ...marketing, currencies: ['USD', 'EUR'] };
    const value = metric('spend', context(), mixed);
    expect(value?.availability).toBe('blocked');
    expect(value?.blocker).toBe('mixed_currency');
    expect(value?.value).toBeNull();
    expect(value?.reason).toMatch(/EUR/);
    expect(value?.reason).toMatch(/does not convert/i);
  });

  it('blocks a derived money metric too, not only the raw sum', () => {
    const mixed = { ...marketing, currencies: ['USD', 'GBP'] };
    for (const key of ['cpm', 'cpc', 'mapped_cpi', 'blended_cpi']) {
      const value = metric(key, context(), mixed);
      expect(value?.availability, key).toBe('blocked');
      expect(value?.blocker, key).toBe('mixed_currency');
    }
  });

  it('leaves counts and ratios alone - they are not denominated in anything', () => {
    const mixed = { ...marketing, currencies: ['USD', 'EUR'] };
    for (const key of ['impressions', 'clicks', 'ctr']) {
      const value = metric(key, context(), mixed);
      expect(value?.availability, key).not.toBe('blocked');
    }
  });

  it('does not block a CPI on currencies that are not in its arithmetic', () => {
    // Cost per install is spend over installs. The revenue table's currency is
    // not part of that calculation, so refusing a well-defined USD CPI because
    // some revenue row arrived in JPY would be a false refusal - and a refusal
    // nobody can act on is no better than a wrong number.
    const mixedRevenue = { ...attribution, currencies: ['USD', 'JPY'] };
    for (const key of ['mapped_cpi', 'blended_cpi']) {
      const value = metric(key, context(), marketing, mixedRevenue);
      expect(value?.availability, key).not.toBe('blocked');
      expect(value?.value, key).not.toBeNull();
    }
  });

  it('blocks a revenue metric on mixed attribution currencies', () => {
    const mixed = { ...attribution, currencies: ['USD', 'JPY'] };
    const value = metric('attributed_revenue', context(), marketing, mixed);
    expect(value?.availability).toBe('blocked');
    expect(value?.blocker).toBe('mixed_currency');
  });

  it('says nothing about currency when there is only one', () => {
    const value = metric('spend');
    expect(value?.availability).not.toBe('blocked');
    expect(value?.blocker).toBeUndefined();
  });
});

import { describe, expect, it } from 'vitest';
import { COHORT_AGES, COHORT_REVENUE_TYPES, cohortCapabilityKey } from '@mart/shared';
import {
  METRIC_DEFINITIONS,
  cohortMetricKey,
  computeMetricValues,
  emptyCohortAggregate,
  getMetricDefinition,
  type CohortAggregate,
  type MetricContext,
} from '@mart/metrics';

/**
 * The Phase 2 hard rules, each asserted against the production metric
 * computation with a hand-built cohort aggregate:
 *
 *   - never fake cohort ROAS: no cohort aggregate, no value
 *   - numerator and denominator are the same acquisition population
 *   - D1 and D7 are distinct facts
 *   - immature cohorts are not zero
 *   - organic cohorts cannot have paid ROAS
 *   - unmapped cohorts cannot borrow spend
 *   - mixed currency stays blocked
 */

const ALL_COHORT_CAPABILITIES = [
  'cohort_reporting',
  'cost_data',
  'attributed_installs',
  ...COHORT_REVENUE_TYPES.flatMap((t) => COHORT_AGES.map((a) => cohortCapabilityKey(t, a))),
];

function context(overrides: Partial<MetricContext> = {}): MetricContext {
  return {
    hasMarketingConnection: true,
    hasAttributionConnection: true,
    marketingProviders: ['meta_ads'],
    attributionProviders: ['tenjin'],
    supportedCapabilities: new Set(ALL_COHORT_CAPABILITIES),
    marketingFreshness: { status: 'fresh', latestDataDate: '2026-08-30' },
    attributionFreshness: { status: 'fresh', latestDataDate: '2026-08-30' },
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
  latestDate: '2026-08-30',
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
  latestInstallDate: '2026-08-30',
  latestRevenueDate: '2026-08-30',
};

/** A window whose D1 cohorts are all mature and whose D7 cohorts are partly immature. */
function cohortFixture(): CohortAggregate {
  const cohort = emptyCohortAggregate('2026-08-30');
  const d1 = cohort.byAge[1];
  d1.matureCohortDays = 5;
  d1.immatureCohortDays = 0;
  d1.installs = 500;
  d1.paidInstalls = 400;
  d1.organicInstalls = 100;
  d1.alignedSpend = 200;
  d1.alignedSpendCurrencies = ['USD'];
  d1.alignedCampaignDays = 5;
  d1.revenue.ad = {
    revenue: 60,
    organicRevenue: 10,
    mappedPaidRevenue: 45,
    unmappedPaidRevenue: 5,
    alignedRevenue: 40,
    immatureRevenue: 0,
    earlyReadRevenue: 0,
    earlyReadRows: 0,
    currencies: ['USD'],
    alignedCurrencies: ['USD'],
    rows: 12,
  };
  d1.revenue.iap = {
    revenue: 20,
    organicRevenue: 4,
    mappedPaidRevenue: 16,
    unmappedPaidRevenue: 0,
    alignedRevenue: 16,
    immatureRevenue: 0,
    earlyReadRevenue: 0,
    earlyReadRows: 0,
    currencies: ['USD'],
    alignedCurrencies: ['USD'],
    rows: 8,
  };
  d1.revenue.total = {
    revenue: 80,
    organicRevenue: 14,
    mappedPaidRevenue: 61,
    unmappedPaidRevenue: 5,
    alignedRevenue: 56,
    immatureRevenue: 0,
    earlyReadRevenue: 0,
    earlyReadRows: 0,
    currencies: ['USD'],
    alignedCurrencies: ['USD'],
    rows: 20,
  };

  const d7 = cohort.byAge[7];
  d7.matureCohortDays = 2;
  d7.immatureCohortDays = 3;
  d7.installs = 200;
  d7.paidInstalls = 160;
  d7.organicInstalls = 40;
  d7.alignedSpend = 80;
  d7.alignedSpendCurrencies = ['USD'];
  d7.alignedCampaignDays = 2;
  d7.revenue.ad = {
    revenue: 90,
    organicRevenue: 15,
    mappedPaidRevenue: 75,
    unmappedPaidRevenue: 0,
    alignedRevenue: 75,
    immatureRevenue: 33,
    earlyReadRevenue: 0,
    earlyReadRows: 0,
    currencies: ['USD'],
    alignedCurrencies: ['USD'],
    rows: 5,
  };
  d7.revenue.iap = {
    ...d7.revenue.ad,
    revenue: 0,
    organicRevenue: 0,
    mappedPaidRevenue: 0,
    alignedRevenue: 0,
    immatureRevenue: 0,
    rows: 0,
  };
  d7.revenue.total = { ...d7.revenue.ad };
  return cohort;
}

function metric(key: string, cohort: CohortAggregate | undefined, ctx = context()) {
  const [value] = computeMetricValues({
    metricKeys: [key],
    context: ctx,
    marketing,
    attribution,
    ...(cohort ? { cohort } : {}),
  });
  if (!value) throw new Error(`metric ${key} not produced`);
  return value;
}

describe('cohort metric registry contract', () => {
  it('defines revenue, RPI and ROAS for every component at every age', () => {
    for (const ageDays of COHORT_AGES) {
      for (const revenueType of COHORT_REVENUE_TYPES) {
        for (const measure of ['revenue', 'rpi', 'roas'] as const) {
          const key = cohortMetricKey({ ageDays, revenueType, measure });
          const definition = getMetricDefinition(key);
          expect(definition, key).toBeDefined();
          expect(definition?.family, key).toBe('cohort');
          expect(definition?.semanticClass, key).toBe('cohort');
          expect(definition?.grain.primary, key).toBe('cohort_date');
          expect(definition?.cohort, key).toEqual({ ageDays, revenueType, measure });
          // Every cohort figure requires proof the account's report carries
          // the component at that age - not just "cohort reporting exists".
          expect(definition?.requiredCapabilities, key).toContain(
            cohortCapabilityKey(revenueType, ageDays),
          );
        }
      }
    }
  });

  it('anchors cohort ROAS on the same (campaign, install day) pairs on both sides', () => {
    for (const definition of METRIC_DEFINITIONS.filter((d) => d.cohort?.measure === 'roas')) {
      expect(definition.population.numerator).toBe('cohort_aligned_paid_attribution');
      expect(definition.population.denominator).toBe('cohort_aligned_marketing');
      expect(definition.grain.mixed).toEqual(['cohort_date', 'report_date']);
      expect(definition.grain.note).toMatch(/install day/i);
      expect(definition.sources).toContain('mapping');
    }
  });

  it('keeps every cohort figure out of the operational class and vice versa', () => {
    for (const definition of METRIC_DEFINITIONS) {
      if (definition.cohort) {
        expect(definition.semanticClass, definition.metricKey).toBe('cohort');
      } else {
        expect(definition.grain.primary, definition.metricKey).not.toBe('cohort_date');
        expect(definition.family, definition.metricKey).not.toBe('cohort');
      }
    }
  });

  it('never defines a predicted or forecast metric', () => {
    for (const definition of METRIC_DEFINITIONS) {
      expect(definition.metricKey, definition.metricKey).not.toMatch(
        /pltv|proas|predict|forecast/i,
      );
      expect(definition.displayName, definition.metricKey).not.toMatch(/predict|forecast/i);
    }
  });
});

describe('cohort metric computation', () => {
  it('computes D1 and D7 as distinct facts from distinct cohort rows', () => {
    const cohort = cohortFixture();
    const d1 = metric('cohort_ad_revenue_d1', cohort);
    const d7 = metric('cohort_ad_revenue_d7', cohort);
    expect(d1.value).toBe(60);
    expect(d7.value).toBe(90);
    expect(d1.grain.primary).toBe('cohort_date');
    expect(d1.value).not.toBe(d7.value);
  });

  it('excludes immature cohorts and says so, rather than counting them as zero', () => {
    const cohort = cohortFixture();
    const d7 = metric('cohort_ad_revenue_d7', cohort);
    // 90 is the mature cohorts' revenue; the 33 accrued so far by the
    // immature ones is neither added nor presented as their D7.
    expect(d7.value).toBe(90);
    expect(d7.availability).toBe('partial');
    expect(d7.reason).toMatch(/3 of 5 install day\(s\) have not reached D7/);
    expect(d7.reason).toMatch(/not counted as zero/);

    const d1 = metric('cohort_ad_revenue_d1', cohort);
    expect(d1.availability).toBe('available');
  });

  it('blocks a D7 figure when no cohort in the window is 7 days old yet', () => {
    const cohort = cohortFixture();
    cohort.byAge[7].matureCohortDays = 0;
    cohort.byAge[7].immatureCohortDays = 5;
    for (const key of ['cohort_ad_revenue_d7', 'cohort_ad_rpi_d7', 'cohort_ad_roas_d7']) {
      const value = metric(key, cohort);
      expect(value.value, key).toBeNull();
      expect(value.availability, key).toBe('blocked');
      expect(value.blocker, key).toBe('immature_cohort');
      expect(value.reason, key).toMatch(/does not exist for them yet; it is not zero/);
    }
  });

  it('divides cohort ROAS by the spend on the install days of the same mapped cohorts', () => {
    const cohort = cohortFixture();
    const roas = metric('cohort_ad_roas_d1', cohort);
    // Aligned revenue over aligned spend - not all revenue, not mapped
    // revenue, not window spend.
    expect(roas.numerator).toBe(40);
    expect(roas.denominator).toBe(200);
    expect(roas.value).toBeCloseTo(40 / 200, 10);
    expect(roas.population.numerator).toBe('cohort_aligned_paid_attribution');
    expect(roas.population.denominator).toBe('cohort_aligned_marketing');
  });

  it('keeps unmapped and non-aligned cohort revenue out of both sides and names the exclusion', () => {
    const cohort = cohortFixture();
    const roas = metric('cohort_ad_roas_d1', cohort);
    expect(roas.availability).toBe('partial');
    // 5 unmapped, and 45 mapped - 40 aligned = 5 mapped-but-no-spend-that-day.
    expect(roas.reason).toMatch(/5\.00 of paid D1 ad revenue is on campaigns MART cannot map/);
    expect(roas.reason).toMatch(/did not spend on their install day/);
    expect(roas.numerator).toBe(40);
  });

  it('refuses a ROAS for organic cohorts instead of returning zero or infinity', () => {
    const cohort = cohortFixture();
    const d1 = cohort.byAge[1];
    d1.alignedSpend = 0;
    d1.alignedSpendCurrencies = [];
    d1.alignedCampaignDays = 0;
    d1.paidInstalls = 0;
    d1.revenue.ad.alignedRevenue = 0;
    const roas = metric('cohort_ad_roas_d1', cohort);
    expect(roas.value).toBeNull();
    expect(roas.availability).toBe('unavailable');
    expect(roas.blocker).toBe('missing_denominator');
    expect(roas.reason).toMatch(/organic cohorts/i);
    expect(roas.reason).toMatch(/does not exist/);
    // Organic cohort REVENUE is still a fact and still shown.
    expect(metric('cohort_ad_revenue_d1', cohort).value).toBe(60);
  });

  it('refuses a ROAS when the mapped campaigns did not spend on the install days', () => {
    const cohort = cohortFixture();
    const d1 = cohort.byAge[1];
    d1.alignedSpend = 0;
    d1.alignedSpendCurrencies = [];
    d1.alignedCampaignDays = 0;
    d1.revenue.ad.alignedRevenue = 0;
    const roas = metric('cohort_ad_roas_d1', cohort);
    expect(roas.availability).toBe('unavailable');
    expect(roas.blocker).toBe('missing_denominator');
    expect(roas.reason).toMatch(
      /no marketing campaign that maps to these cohorts spent on their install days/i,
    );
    expect(roas.reason).toMatch(/not divided into cohort revenue/i);
  });

  it('blocks a cohort figure whose own rows are in two currencies', () => {
    const cohort = cohortFixture();
    cohort.byAge[1].revenue.ad.currencies = ['EUR', 'USD'];
    const revenue = metric('cohort_ad_revenue_d1', cohort);
    expect(revenue.value).toBeNull();
    expect(revenue.availability).toBe('blocked');
    expect(revenue.blocker).toBe('mixed_currency');
    expect(revenue.reason).toContain('EUR');
    // The IAP figure reads different rows and is unaffected.
    expect(metric('cohort_iap_revenue_d1', cohort).availability).toBe('available');
  });

  it('blocks a cohort ROAS when spend and revenue disagree on currency', () => {
    const cohort = cohortFixture();
    cohort.byAge[1].alignedSpendCurrencies = ['JPY'];
    const roas = metric('cohort_ad_roas_d1', cohort);
    expect(roas.availability).toBe('blocked');
    expect(roas.blocker).toBe('mixed_currency');
    expect(roas.reason).toContain('JPY');
    expect(roas.reason).toContain('USD');
    // Cohort revenue never reads spend, so a foreign spend row cannot block it.
    expect(metric('cohort_ad_revenue_d1', cohort).availability).toBe('available');
  });

  it('computes RPI over the installs of the same mature cohorts', () => {
    const cohort = cohortFixture();
    const rpi = metric('cohort_rpi_d1', cohort);
    expect(rpi.numerator).toBe(80);
    expect(rpi.denominator).toBe(500);
    expect(rpi.value).toBeCloseTo(80 / 500, 10);

    cohort.byAge[1].installs = 10;
    const thin = metric('cohort_rpi_d1', cohort);
    expect(thin.value).toBeNull();
    expect(thin.reason).toMatch(/below the minimum/);
  });

  it('reports a missing provider component as unavailable with the field named, never as zero', () => {
    const cohort = cohortFixture();
    const ctx = context({
      supportedCapabilities: new Set(
        ALL_COHORT_CAPABILITIES.filter(
          (k) => k !== 'cohort_iap_revenue_d7' && k !== 'cohort_total_revenue_d7',
        ),
      ),
      capabilityNotes: {
        cohort_iap_revenue_d7: 'Add revenues_7d to the Tenjin saved report "UA" (abc).',
      },
    });
    const iap = metric('cohort_iap_revenue_d7', cohort, ctx);
    expect(iap.value).toBeNull();
    expect(iap.availability).toBe('unavailable');
    expect(iap.blocker).toBe('unsupported_metric');
    expect(iap.reason).toContain('cohort_iap_revenue_d7');
    expect(iap.reason).toContain('Add revenues_7d');
    // The total needs both parts; the ad-only figure is still served as ad.
    expect(metric('cohort_roas_d7', cohort, ctx).availability).toBe('unavailable');
    expect(metric('cohort_ad_roas_d7', cohort, ctx).value).toBeCloseTo(75 / 80, 10);
  });

  it('excludes rows read before the cohort reached the age and names the lookback', () => {
    const cohort = cohortFixture();
    cohort.byAge[7].revenue.ad.earlyReadRows = 2;
    cohort.byAge[7].revenue.ad.earlyReadRevenue = 12;
    const d7 = metric('cohort_ad_revenue_d7', cohort);
    expect(d7.value).toBe(90);
    expect(d7.availability).toBe('partial');
    expect(d7.reason).toMatch(
      /2 cohort row\(s\) were last read from the provider before reaching D7/,
    );
    expect(d7.reason).toMatch(/SYNC_RESTATEMENT_LOOKBACK_DAYS at 7 or more/);
  });

  it('has no value before any attribution sync has established a data horizon', () => {
    const cohort = emptyCohortAggregate(null);
    const value = metric('cohort_ad_revenue_d1', cohort);
    expect(value.value).toBeNull();
    expect(value.availability).toBe('unavailable');
    expect(value.reason).toMatch(/no attribution sync has completed/i);
  });
});

describe('cohort coverage', () => {
  it('blocks a figure whose mature days were never read by the revenue sync, as unknown rather than zero', () => {
    const cohort = cohortFixture();
    const d7 = cohort.byAge[7];
    // Old enough, but the revenue stream has not read them since: unknown.
    d7.matureCohortDays = 0;
    d7.immatureCohortDays = 0;
    d7.uncoveredCohortDays = 5;
    for (const key of ['cohort_ad_revenue_d7', 'cohort_ad_rpi_d7', 'cohort_ad_roas_d7']) {
      const value = metric(key, cohort);
      expect(value.value, key).toBeNull();
      expect(value.availability, key).toBe('blocked');
      expect(value.blocker, key).toBe('provider_stale');
      expect(value.reason, key).toMatch(/has not read them since they reached D7/);
      expect(value.reason, key).toMatch(/unknown, not zero/);
    }
  });

  it('names uncovered days beside immature ones when some cohorts are mature', () => {
    const cohort = cohortFixture();
    cohort.byAge[7].uncoveredCohortDays = 2;
    const d7 = metric('cohort_ad_revenue_d7', cohort);
    expect(d7.value).toBe(90);
    expect(d7.availability).toBe('partial');
    expect(d7.reason).toMatch(/3 of 7 install day\(s\) have not reached D7/);
    expect(d7.reason).toMatch(
      /2 of 7 install day\(s\) are old enough for D7 but the attribution revenue sync has not read them/,
    );
    expect(d7.reason).toMatch(/excluded from both sides/);
  });
});

import { describe, expect, it } from 'vitest';
import { COHORT_AGES, COHORT_REVENUE_TYPES, cohortCapabilityKey } from '@mart/shared';
import {
  CAPABILITY_KEYS,
  COHORT_CAPABILITY_KEYS,
  ProviderHttpClient,
  TENJIN_PREDICTED_METRIC_PATTERN,
  TenjinAttributionProvider,
  checkAttributionBatch,
  tenjinCohortAction,
  tenjinCohortCoverage,
} from '@mart/integrations';

/**
 * Cohort ingestion from Tenjin, pinned to the shapes observed on a real
 * account: the saved report definition carries `_Nd` metric ids, rows carry
 * the install day as `date`, the cumulative value at each age, and the plain
 * event-date metric beside them with a DIFFERENT value.
 */

const APP = 'b6861802-21c7-4e6f-994d-44783bbda367';
const REPORT_ID = 'e2d46476-7ce3-4264-975e-1e1f3ef68339';

type Reply = { status?: number; body: unknown };

function providerFor(handler: (url: URL) => Reply): {
  provider: TenjinAttributionProvider;
  urls: URL[];
} {
  const urls: URL[] = [];
  const provider = new TenjinAttributionProvider({
    credentials: { kind: 'tenjin', apiKey: 'tenjin-secret-token-value' },
    baseUrl: 'https://api.tenjin.com/v2',
    http: new ProviderHttpClient({
      provider: 'tenjin',
      minIntervalMs: 0,
      maxAttempts: 1,
      fetchImpl: async (url: string) => {
        const parsed = new URL(String(url));
        urls.push(parsed);
        const { status = 200, body } = handler(parsed);
        return new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        });
      },
    }),
  });
  return { provider, urls };
}

const params = {
  externalAccountId: APP,
  from: '2026-08-25',
  to: '2026-09-02',
  timezone: 'UTC',
  currency: 'USD',
};

/** The real report's metric set, optionally extended. */
function savedReport(metrics: string[]): unknown {
  return {
    id: REPORT_ID,
    type: 'saved_report',
    attributes: {
      name: 'MART - Reveal Rush UA',
      report_type: 'user_acquisition',
      app_ids: [APP],
      metrics,
      granularity: 'daily',
      group_by: 'campaign_country',
      past_number_days: 30,
      channel_ids: [],
    },
  };
}

const REAL_METRICS = [
  'tracked_installs',
  'revenues',
  'ad_mediation_revenue',
  'total_rev',
  'spend',
  'cpm',
  'cpi',
  'ctr',
  'cvr',
  'ad_mediation_revenue_7d',
  'roas_7d',
];

/**
 * A row as the live API returned it on 2026-09-02 for a cohort installed on
 * 2026-08-30: the plain ad_mediation_revenue (121.66) differs from
 * ad_mediation_revenue_0d (119.99), and the ages are monotone.
 */
const ROW = {
  ad_mediation_revenue: 121.66,
  ad_mediation_revenue_0d: 119.99,
  ad_mediation_revenue_1d: 129.92,
  ad_mediation_revenue_7d: 135.36,
  ad_network_id: 3,
  ad_network_name: 'Meta',
  app_id: APP,
  campaign_id: '566098bd-eca0-47b5-a70f-d733def2575d',
  country: 'US',
  date: '2026-08-30',
  name: 'New App promotion Ad Set (FB_Reveal_Rush_CPI_Broad_US_NEW_CR__29/08/26)',
  platform: 'android',
  revenues: 0.0,
  revenues_7d: 4.99,
  roas_7d: 3.0597,
  spend: 163.09,
  total_rev: 0.0,
  tracked_installs: 377,
};

function twoStep(rows: unknown[], metrics: string[] = REAL_METRICS) {
  return (url: URL): Reply =>
    url.pathname.endsWith('/saved_reports')
      ? { body: { data: [savedReport(metrics)] } }
      : { body: { data: rows.map((attributes) => ({ type: 'report', attributes })) } };
}

describe('tenjin cohort vocabulary', () => {
  it('generates one capability key per component and age, and the closed key list matches', () => {
    expect(COHORT_CAPABILITY_KEYS).toHaveLength(COHORT_AGES.length * COHORT_REVENUE_TYPES.length);
    for (const key of COHORT_CAPABILITY_KEYS) expect(CAPABILITY_KEYS).toContain(key);
    expect(cohortCapabilityKey('ad', 7)).toBe('cohort_ad_revenue_d7');
  });

  it('reads the real report as ad-only at D7 and names exactly what is missing', () => {
    const coverage = tenjinCohortCoverage(REAL_METRICS);
    expect(coverage.present.ad[7]).toBe('ad_mediation_revenue_7d');
    expect(coverage.present.iap[7]).toBeUndefined();
    expect(coverage.present.total[7]).toBeUndefined();
    expect(coverage.present.ad[1]).toBeUndefined();
    const missing = coverage.missing.map((m) => `${m.revenueType}:${m.ageDays}:${m.metric}`);
    expect(missing).toContain('iap:7:revenues_7d');
    expect(missing).toContain('iap:1:revenues_1d');
    expect(missing).toContain('ad:1:ad_mediation_revenue_1d');
    // The total at D7 needs the IAP side the report lacks.
    expect(missing).toContain('total:7:revenues_7d');
  });

  it('accepts the pubrev spelling and a provider total when no component exists', () => {
    const coverage = tenjinCohortCoverage(['pubrev_1d', 'total_rev_7d']);
    expect(coverage.present.ad[1]).toBe('pubrev_1d');
    expect(coverage.present.total[7]).toBe('total_rev_7d');
    expect(coverage.present.total[1]).toBeUndefined();
  });

  it('phrases the external action for the Tenjin UI without pretending MART will edit the report', () => {
    const action = tenjinCohortAction({ id: REPORT_ID, name: 'MART - Reveal Rush UA' }, [
      'revenues_7d',
    ]);
    expect(action).toContain('revenues_7d');
    expect(action).toContain('MART - Reveal Rush UA');
    expect(action).toContain(REPORT_ID);
    expect(action).toMatch(/never edits them/);
  });

  it('refuses predicted metrics by pattern', () => {
    expect(TENJIN_PREDICTED_METRIC_PATTERN.test('pltv_7d')).toBe(true);
    expect(TENJIN_PREDICTED_METRIC_PATTERN.test('proas_30d')).toBe(true);
    expect(TENJIN_PREDICTED_METRIC_PATTERN.test('revenues_7d')).toBe(false);
    expect(TENJIN_PREDICTED_METRIC_PATTERN.test('roas_7d')).toBe(false);
  });
});

describe('tenjin cohort ingestion', () => {
  it('emits the D7 ad cohort row beside the event-date rows, from the real row shape', async () => {
    const { provider } = providerFor(twoStep([ROW]));
    const result = await provider.syncRevenue(params);

    const event = result.batch.revenue.filter((r) => r.grain === 'event_date');
    const cohort = result.batch.revenue.filter((r) => r.grain === 'cohort_date');
    // Event-date: the plain metric, on the report date, with no age.
    expect(event.map((r) => `${r.revenueType}:${r.revenue}`)).toEqual(['ad:121.66']);
    expect(event[0]?.cohortAgeDays ?? null).toBeNull();
    // Cohort: the _7d column, on the INSTALL day, with its age - and only the
    // components the report definition carries (no revenues_7d here).
    expect(cohort).toHaveLength(1);
    expect(cohort[0]).toMatchObject({
      grain: 'cohort_date',
      cohortAgeDays: 7,
      revenueType: 'ad',
      revenue: 135.36,
      activityDate: '2026-08-30',
      externalCampaignId: ROW.campaign_id,
      country: 'US',
      platform: 'android',
      currency: 'USD',
    });
    expect(result.warnings.join(' ')).toMatch(
      /Cohort revenue imported at cohort_date grain \(cumulative, rows per component\/age: ad_d7=1\)/,
    );
    expect(result.warnings.join(' ')).toMatch(
      /not available for revenues_1d, ad_mediation_revenue_1d, revenues_7d/,
    );
    expect(result.warnings.join(' ')).toContain(
      'Add revenues_1d, ad_mediation_revenue_1d, revenues_7d to the Tenjin saved report',
    );
  });

  it('does not read a cohort column the report definition does not declare', async () => {
    // The row carries revenues_7d, but the definition says the report has no
    // such metric. A value MART cannot explain from the definition is not
    // stored: capability and ingestion must describe the same report.
    const { provider } = providerFor(twoStep([{ ...ROW, revenues_7d: 4.99 }]));
    const result = await provider.syncRevenue(params);
    const iap = result.batch.revenue.filter(
      (r) => r.grain === 'cohort_date' && r.revenueType === 'iap',
    );
    expect(iap).toHaveLength(0);
  });

  it('emits every component and age the report declares, and never a total beside its parts', async () => {
    const metrics = [
      ...REAL_METRICS,
      'revenues_1d',
      'revenues_7d',
      'ad_mediation_revenue_1d',
      'total_rev_7d',
    ];
    const { provider } = providerFor(twoStep([ROW], metrics));
    const result = await provider.syncRevenue(params);
    const cohort = result.batch.revenue
      .filter((r) => r.grain === 'cohort_date')
      .map((r) => `${r.revenueType}:d${r.cohortAgeDays}:${r.revenue}`)
      .sort();
    expect(cohort).toEqual(['ad:d1:129.92', 'ad:d7:135.36', 'iap:d7:4.99']);
    // revenues_1d is declared but the row has no value for it: absent, not 0.
    expect(cohort.some((c) => c.startsWith('iap:d1'))).toBe(false);
  });

  it('skips cohort values on rows with no tracked installs and says so', async () => {
    const { provider } = providerFor(twoStep([{ ...ROW, tracked_installs: 0 }]));
    const result = await provider.syncRevenue(params);
    expect(result.batch.revenue.filter((r) => r.grain === 'cohort_date')).toHaveLength(0);
    expect(result.warnings.join(' ')).toMatch(/no tracked installs and were not stored/);
  });

  it('never stores a null cohort value as zero', async () => {
    const { provider } = providerFor(twoStep([{ ...ROW, ad_mediation_revenue_7d: null }]));
    const result = await provider.syncRevenue(params);
    expect(result.batch.revenue.filter((r) => r.grain === 'cohort_date')).toHaveLength(0);
  });

  it('probes cohort capabilities per component and age from the saved report, read-only', async () => {
    const { provider, urls } = providerFor(twoStep([ROW]));
    const capabilities = await provider.getCapabilities(APP);
    const byKey = new Map(capabilities.map((c) => [c.key, c]));

    expect(byKey.get('cohort_reporting')?.supported).toBe(true);
    expect(byKey.get('cohort_ad_revenue_d7')).toMatchObject({
      supported: true,
      discoveryMethod: 'probed',
      detail: {
        savedReportId: REPORT_ID,
        metric: 'ad_mediation_revenue_7d',
        cohortType: 'cumulative',
      },
    });
    const iap7 = byKey.get('cohort_iap_revenue_d7');
    expect(iap7?.supported).toBe(false);
    expect(iap7?.discoveryMethod).toBe('probed');
    expect(iap7?.detail?.['missingMetric']).toBe('revenues_7d');
    expect(String(iap7?.detail?.['action'])).toContain('Add revenues_7d');
    expect(byKey.get('cohort_total_revenue_d7')?.supported).toBe(false);
    expect(byKey.get('cohort_ad_revenue_d1')?.supported).toBe(false);

    // Only GET /saved_reports was needed; nothing was created or edited.
    expect(urls.map((u) => u.pathname)).toEqual(['/v2/saved_reports']);
  });

  it('leaves cohort capabilities unrecorded when discovery fails, rather than recording false', async () => {
    const { provider } = providerFor(() => ({ status: 500, body: { error: 'down' } }));
    const capabilities = await provider.getCapabilities(APP);
    expect(
      capabilities.some((c) => c.key.startsWith('cohort_') && c.key !== 'cohort_reporting'),
    ).toBe(false);
    expect(capabilities.find((c) => c.key === 'cohort_reporting')?.supported).toBe(true);
  });
});

describe('cohort data quality', () => {
  const ctx = {
    organizationId: 'org',
    appId: 'app',
    connectionId: 'conn',
    syncRunId: 'run',
    windowStart: '2026-08-01',
    windowEnd: '2026-08-31',
  };
  const row = (age: number, revenue: number) => ({
    activityDate: '2026-08-20',
    grain: 'cohort_date' as const,
    cohortAgeDays: age,
    revenueType: 'ad' as const,
    mediaSource: 'Meta',
    externalCampaignId: 'c1',
    campaignName: 'C1',
    country: 'US',
    platform: 'android',
    currency: 'USD',
    revenue,
  });

  it('flags a cohort whose later age is below an earlier one', () => {
    const findings = checkAttributionBatch(ctx, {
      installs: [],
      events: [],
      revenue: [row(1, 10), row(7, 8)],
    });
    expect(findings.map((f) => f.checkKey)).toContain('attribution.cohort_not_cumulative');
    expect(findings[0]?.severity).toBe('error');
    expect(findings[0]?.message).toMatch(/D7 \(8\) is below D1 \(10\)/);
  });

  it('accepts a monotone cohort and never compares across cohorts', () => {
    const findings = checkAttributionBatch(ctx, {
      installs: [],
      events: [],
      revenue: [
        row(1, 10),
        row(7, 25),
        // A different campaign's D7 may be lower than this campaign's D1.
        { ...row(7, 3), externalCampaignId: 'c2' },
      ],
    });
    expect(findings.filter((f) => f.checkKey === 'attribution.cohort_not_cumulative')).toHaveLength(
      0,
    );
  });
});

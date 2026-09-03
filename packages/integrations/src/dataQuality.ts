import type { CanonicalAttributionBatch, CanonicalMarketingBatch, IsoDate } from '@mart/shared';
import type { DataQualityFinding } from '@mart/db';

/**
 * Deterministic data-quality checks.
 *
 * These are assertions about data MART just fetched, not a modelling layer.
 * They run inside the sync so a problem is attached to the run that produced it.
 */
export type QualityContext = {
  organizationId: string;
  appId: string;
  connectionId: string;
  syncRunId: string | null;
  windowStart: IsoDate;
  windowEnd: IsoDate;
};

/** Clicks may legitimately exceed impressions slightly; 2x is not plausible. */
const CLICKS_TO_IMPRESSIONS_LIMIT = 2;

export function checkMarketingBatch(
  ctx: QualityContext,
  batch: CanonicalMarketingBatch,
): DataQualityFinding[] {
  const findings: DataQualityFinding[] = [];
  const seen = new Set<string>();

  for (const metric of batch.dailyMetrics) {
    const base = {
      organizationId: ctx.organizationId,
      appId: ctx.appId,
      connectionId: ctx.connectionId,
      syncRunId: ctx.syncRunId,
      entityType: 'campaign',
      entityRef: metric.externalCampaignId,
      observedDate: metric.reportDate,
    } as const;

    if (metric.reportDate < ctx.windowStart || metric.reportDate > ctx.windowEnd) {
      findings.push({
        ...base,
        checkKey: 'marketing.date_outside_window',
        severity: 'warning',
        message: `Provider returned ${metric.reportDate} outside the requested window ${ctx.windowStart}..${ctx.windowEnd}`,
        detail: { windowStart: ctx.windowStart, windowEnd: ctx.windowEnd },
      });
    }
    if (metric.spend < 0 || metric.impressions < 0 || metric.clicks < 0) {
      findings.push({
        ...base,
        checkKey: 'marketing.negative_measure',
        severity: 'error',
        message: 'Negative spend, impressions or clicks reported',
        detail: { spend: metric.spend, impressions: metric.impressions, clicks: metric.clicks },
      });
    }
    if (
      metric.impressions > 0 &&
      metric.clicks > metric.impressions * CLICKS_TO_IMPRESSIONS_LIMIT
    ) {
      findings.push({
        ...base,
        checkKey: 'marketing.clicks_exceed_impressions',
        severity: 'warning',
        message: 'Clicks implausibly exceed impressions',
        detail: { clicks: metric.clicks, impressions: metric.impressions },
      });
    }
    if (metric.spend > 0 && metric.impressions === 0 && metric.clicks === 0) {
      findings.push({
        ...base,
        checkKey: 'marketing.spend_without_delivery',
        severity: 'warning',
        message: 'Spend reported with no impressions or clicks',
        detail: { spend: metric.spend },
      });
    }
    if (!metric.externalCampaignId) {
      findings.push({
        ...base,
        checkKey: 'marketing.missing_campaign_id',
        severity: 'error',
        message: 'Delivery row has no campaign id; it cannot be reconciled to attribution data',
        detail: {},
      });
    }
    if (!/^[A-Z]{3}$/.test(metric.currency ?? '')) {
      findings.push({
        ...base,
        checkKey: 'marketing.invalid_currency',
        severity: 'warning',
        message: `Unexpected currency code '${metric.currency}'`,
        detail: { currency: metric.currency },
      });
    }

    const key = [
      metric.reportDate,
      metric.externalCampaignId,
      metric.externalAdGroupId,
      metric.externalAdId,
      metric.country,
      metric.platform,
    ].join('|');
    if (seen.has(key)) {
      findings.push({
        ...base,
        checkKey: 'marketing.duplicate_dimension_tuple',
        severity: 'warning',
        message: 'Provider returned the same dimension tuple more than once in one window',
        detail: { key },
      });
    }
    seen.add(key);
  }

  return findings;
}

export function checkAttributionBatch(
  ctx: QualityContext,
  batch: CanonicalAttributionBatch,
): DataQualityFinding[] {
  const findings: DataQualityFinding[] = [];

  for (const install of batch.installs) {
    const base = {
      organizationId: ctx.organizationId,
      appId: ctx.appId,
      connectionId: ctx.connectionId,
      syncRunId: ctx.syncRunId,
      entityType: 'campaign',
      entityRef: install.externalCampaignId ?? install.campaignName,
      observedDate: install.installDate,
    } as const;

    if (install.installDate < ctx.windowStart || install.installDate > ctx.windowEnd) {
      findings.push({
        ...base,
        checkKey: 'attribution.date_outside_window',
        severity: 'warning',
        message: `Install date ${install.installDate} is outside the requested window`,
        detail: { windowStart: ctx.windowStart, windowEnd: ctx.windowEnd },
      });
    }
    if (install.attributedInstalls < 0) {
      findings.push({
        ...base,
        checkKey: 'attribution.negative_installs',
        severity: 'error',
        message: 'Negative attributed installs reported',
        detail: { attributedInstalls: install.attributedInstalls },
      });
    }
    if (!install.externalCampaignId && install.attributedInstalls > 0) {
      findings.push({
        ...base,
        checkKey: 'attribution.missing_campaign_id',
        severity: 'warning',
        message:
          'Attribution row has no campaign id; reconciliation to the marketing network can only fall back to names',
        detail: { campaignName: install.campaignName },
      });
    }
  }

  for (const revenue of batch.revenue) {
    if (revenue.revenue < 0) {
      findings.push({
        organizationId: ctx.organizationId,
        appId: ctx.appId,
        connectionId: ctx.connectionId,
        syncRunId: ctx.syncRunId,
        checkKey: 'attribution.negative_revenue',
        severity: 'warning',
        entityType: 'campaign',
        entityRef: revenue.externalCampaignId,
        observedDate: revenue.activityDate,
        message: 'Negative attributed revenue reported (refund or restatement)',
        detail: { revenue: revenue.revenue, revenueType: revenue.revenueType },
      });
    }
  }

  // Cohort revenue is cumulative: a cohort's D7 figure contains its D1 figure.
  // A batch in which a later age is smaller than an earlier one for the same
  // cohort means the provider changed what the column means, and every cohort
  // metric built on it would be quietly wrong. Checked per cohort identity so
  // one restated row cannot hide behind another cohort's growth.
  const byCohort = new Map<string, Array<{ age: number; revenue: number }>>();
  for (const revenue of batch.revenue) {
    if (revenue.grain !== 'cohort_date' || typeof revenue.cohortAgeDays !== 'number') continue;
    const key = [
      revenue.activityDate,
      revenue.revenueType,
      revenue.mediaSource ?? '',
      revenue.externalCampaignId ?? '',
      revenue.country ?? '',
      revenue.platform ?? '',
      revenue.currency,
    ].join('|');
    const list = byCohort.get(key) ?? [];
    list.push({ age: revenue.cohortAgeDays, revenue: revenue.revenue });
    byCohort.set(key, list);
  }
  for (const [key, ages] of byCohort) {
    const sorted = [...ages].sort((a, b) => a.age - b.age);
    for (let i = 1; i < sorted.length; i += 1) {
      const earlier = sorted[i - 1];
      const later = sorted[i];
      if (!earlier || !later || later.revenue >= earlier.revenue) continue;
      const [activityDate, revenueType, , externalCampaignId] = key.split('|');
      findings.push({
        organizationId: ctx.organizationId,
        appId: ctx.appId,
        connectionId: ctx.connectionId,
        syncRunId: ctx.syncRunId,
        checkKey: 'attribution.cohort_not_cumulative',
        severity: 'error',
        entityType: 'campaign',
        entityRef: externalCampaignId || null,
        observedDate: activityDate as IsoDate,
        message: `Cohort ${revenueType} revenue at D${later.age} (${later.revenue}) is below D${earlier.age} (${earlier.revenue}); cohort revenue must be cumulative`,
        detail: {
          revenueType,
          earlierAge: earlier.age,
          earlierRevenue: earlier.revenue,
          laterAge: later.age,
          laterRevenue: later.revenue,
        },
      });
    }
  }

  return findings;
}

/**
 * Row-count anomaly: an order-of-magnitude change against the trailing average
 * usually means a provider-side problem rather than a real business change.
 */
export function checkRowCountAnomaly(
  ctx: QualityContext,
  currentRows: number,
  trailingAverage: number | null,
): DataQualityFinding[] {
  if (trailingAverage === null || trailingAverage < 10) return [];
  const ratio = currentRows / trailingAverage;
  if (ratio > 0.25 && ratio < 4) return [];
  return [
    {
      organizationId: ctx.organizationId,
      appId: ctx.appId,
      connectionId: ctx.connectionId,
      syncRunId: ctx.syncRunId,
      checkKey: 'sync.row_count_anomaly',
      severity: 'warning',
      observedDate: ctx.windowEnd,
      message: `Row count ${currentRows} differs sharply from the trailing average ${Math.round(trailingAverage)}`,
      detail: { currentRows, trailingAverage, ratio: Number(ratio.toFixed(2)) },
    },
  ];
}

/**
 * Reconciliation gaps that make dashboard numbers misleading.
 *
 * These are not row-level assertions about a fetched payload; they are about
 * the join between two providers, which is where a plausible-looking wrong
 * number comes from. Spend that no attribution can be tied to, and attributed
 * paid installs that belong to no known campaign, both mean the same thing:
 * a CPI or ROAS computed across them would divide one population by another.
 *
 * Organic is never a finding. Unpaid traffic belongs to no campaign by
 * definition, and flagging it would train people to ignore the panel.
 */
export type ReconciliationHealthInput = {
  organizationId: string;
  appId: string;
  /** Null: this describes the join between two connections, not one of them. */
  connectionId: string | null;
  syncRunId: string | null;
  observedDate: IsoDate;
  /** Spend on campaigns that delivered in the reviewed window. */
  spend: number;
  mappedSpend: number;
  ambiguousSpend: number;
  unmappedSpend: number;
  /** Campaigns that delivered in the window. */
  eligibleCampaigns: number;
  ambiguousCampaigns: number;
  /** Known to the structure sync but with no delivery in the window. */
  historicalCampaigns: number;
  /** Paid attributed installs in the window, organic excluded. */
  paidInstalls: number;
  mappedPaidInstalls: number;
};

/**
 * Share of current-period spend that must resolve to attribution before
 * spend-derived metrics describe the account rather than a slice of it.
 */
export const MINIMUM_SPEND_COVERAGE_PCT = 80;

/**
 * Reconciliation gaps that make dashboard numbers misleading.
 *
 * These are not row-level assertions about a fetched payload; they are about
 * the join between two providers, which is where a plausible-looking wrong
 * number comes from.
 *
 * Severity follows the money, not the campaign count. Nine campaigns that
 * stopped running last quarter are an informational note; one live campaign
 * carrying most of the period's spend with nothing attributed to it is an
 * error. Ranking them the same way trains people to ignore the panel.
 *
 * Organic is never a finding. Unpaid traffic belongs to no campaign by
 * definition.
 */
export function checkReconciliationHealth(input: ReconciliationHealthInput): DataQualityFinding[] {
  const findings: DataQualityFinding[] = [];
  const base = {
    organizationId: input.organizationId,
    appId: input.appId,
    connectionId: input.connectionId,
    syncRunId: input.syncRunId,
    entityType: 'campaign',
    entityRef: null,
    observedDate: input.observedDate,
  } as const;

  const spendCoveragePct = input.spend > 0 ? (input.mappedSpend / input.spend) * 100 : null;
  const unresolvedSpend = input.ambiguousSpend + input.unmappedSpend;

  if (input.spend > 0 && (spendCoveragePct ?? 0) < MINIMUM_SPEND_COVERAGE_PCT) {
    findings.push({
      ...base,
      checkKey: 'reconciliation.current_period_spend_unmapped',
      // The highest severity available: every spend-derived metric on the
      // dashboard is affected while this holds.
      severity: 'error',
      message:
        `${unresolvedSpend.toFixed(2)} of ${input.spend.toFixed(2)} in current-period spend is not attributed to a mapped campaign` +
        (input.ambiguousSpend > 0
          ? ` (${input.ambiguousSpend.toFixed(2)} of it ambiguous - MART found more than one candidate and will not pick one)`
          : '') +
        `. Spend coverage is ${spendCoveragePct === null ? 'unknown' : `${spendCoveragePct.toFixed(1)}%`}, below the ${MINIMUM_SPEND_COVERAGE_PCT}% needed for per-install figures to describe the account.`,
      detail: {
        spend: input.spend,
        mappedSpend: input.mappedSpend,
        ambiguousSpend: input.ambiguousSpend,
        unmappedSpend: input.unmappedSpend,
        spendCoveragePct,
        threshold: MINIMUM_SPEND_COVERAGE_PCT,
      },
    });
  }

  const unmappedInstalls = input.paidInstalls - input.mappedPaidInstalls;
  if (unmappedInstalls > 0) {
    findings.push({
      ...base,
      checkKey: 'reconciliation.paid_installs_unmapped',
      severity: 'warning',
      message: `${unmappedInstalls} paid attributed install(s) are on campaigns MART cannot map, so they are outside every mapped figure.`,
      detail: {
        paidInstalls: input.paidInstalls,
        mappedPaidInstalls: input.mappedPaidInstalls,
        unmappedInstalls,
      },
    });
  }

  if (input.ambiguousCampaigns > 0) {
    findings.push({
      ...base,
      checkKey: 'reconciliation.ambiguous_campaigns',
      severity: 'warning',
      message: `${input.ambiguousCampaigns} campaign(s) matched more than one candidate and were left unmapped rather than joined arbitrarily. They can be resolved by hand on the reconciliation screen.`,
      detail: {
        ambiguousCampaigns: input.ambiguousCampaigns,
        ambiguousSpend: input.ambiguousSpend,
      },
    });
  }

  if (input.historicalCampaigns > 0) {
    findings.push({
      ...base,
      checkKey: 'reconciliation.historical_campaigns_without_activity',
      // Informational on purpose: a campaign that stopped running is not a
      // reconciliation problem, and ranking it beside live unmapped spend
      // would bury the finding that matters.
      severity: 'info',
      message: `${input.historicalCampaigns} marketing campaign(s) have no delivery in the selected period. They are excluded from current-period coverage.`,
      detail: { historicalCampaigns: input.historicalCampaigns },
    });
  }

  return findings;
}

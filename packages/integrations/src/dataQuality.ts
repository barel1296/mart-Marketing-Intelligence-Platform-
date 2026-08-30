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
  /** Marketing spend in the window under review. */
  spend: number;
  /** Paid marketing campaigns MART knows about. */
  marketingCampaigns: number;
  /** Coverage counts from campaignCoverage(). */
  operationalCoveragePct: number | null;
  authoritativeCoveragePct: number | null;
  /** Paid attribution campaigns with no mapping to a marketing campaign. */
  unmappedPaidCampaigns: number;
  ambiguousCampaigns: number;
};

/**
 * Below this share of mapped campaigns, spend-derived per-install figures stop
 * describing the account and start describing whichever slice happened to map.
 */
export const MINIMUM_OPERATIONAL_COVERAGE_PCT = 80;

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

  const coverage = input.operationalCoveragePct;

  if (
    input.spend > 0 &&
    input.marketingCampaigns > 0 &&
    (coverage ?? 0) < MINIMUM_OPERATIONAL_COVERAGE_PCT
  ) {
    findings.push({
      ...base,
      checkKey: 'reconciliation.paid_spend_without_mapping',
      // The highest severity available, because every spend-derived metric on
      // the dashboard is affected while this holds.
      severity: 'error',
      message:
        coverage === null || coverage === 0
          ? `Spend of ${input.spend.toFixed(2)} is recorded but no campaign maps to attribution. Per-install and per-revenue figures cannot describe these campaigns.`
          : `Operational mapping coverage is ${coverage}%, below the ${MINIMUM_OPERATIONAL_COVERAGE_PCT}% needed for spend-derived metrics to describe the whole account.`,
      detail: {
        spend: input.spend,
        marketingCampaigns: input.marketingCampaigns,
        operationalCoveragePct: coverage,
        authoritativeCoveragePct: input.authoritativeCoveragePct,
        threshold: MINIMUM_OPERATIONAL_COVERAGE_PCT,
      },
    });
  }

  if (input.unmappedPaidCampaigns > 0) {
    findings.push({
      ...base,
      checkKey: 'reconciliation.attributed_campaigns_unmapped',
      severity: 'warning',
      message: `${input.unmappedPaidCampaigns} paid attribution campaign(s) have no marketing campaign mapping, so their installs and revenue are outside every mapped figure.`,
      detail: { unmappedPaidCampaigns: input.unmappedPaidCampaigns },
    });
  }

  if (input.ambiguousCampaigns > 0) {
    findings.push({
      ...base,
      checkKey: 'reconciliation.ambiguous_campaigns',
      severity: 'warning',
      message: `${input.ambiguousCampaigns} campaign(s) matched more than one candidate by name and were left unmapped rather than joined arbitrarily.`,
      detail: { ambiguousCampaigns: input.ambiguousCampaigns },
    });
  }

  return findings;
}

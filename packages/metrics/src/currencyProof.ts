import { randomUUID } from 'node:crypto';
import { getPool, queryRows, type Queryable } from '@mart/db';
import { COHORT_AGES } from '@mart/shared';
import {
  computeMetricValues,
  loadAttributionAggregate,
  loadCohortAggregate,
  loadMarketingAggregate,
  type MetricContext,
  type MetricFilters,
} from './service.js';
import { cohortMetricKey, type MetricValue } from './registry.js';

/**
 * A transaction-scoped proof that MART refuses to add two currencies.
 *
 * The gate only fires when a window contains rows in more than one currency,
 * and a healthy single-currency account never produces that condition - so an
 * audit reading natural data can only ever say UNPROVEN. This creates the
 * condition on purpose, inside a transaction it always rolls back: one
 * synthetic delivery row and one synthetic revenue row in a currency the window
 * does not have, tagged with identifiers no real entity can carry.
 *
 * It then asks the PRODUCTION path - the same aggregate loaders and the same
 * metric computation the dashboard uses - what it sees. Not a copy of the gate;
 * the gate. An audit that re-implements the logic it is checking proves only
 * that two people can write the same bug.
 *
 * Nothing survives. The transaction is rolled back in a finally block whether
 * the proof passed, failed, or threw, and a snapshot of every table the proof
 * could conceivably touch is taken before and after and compared, so the
 * caller can see - not trust - that the database is unchanged.
 */

/** Marks every synthetic identifier so it can never collide with a real one. */
const PROOF_TAG = 'mart-currency-proof';

export type CurrencyProofSnapshot = Record<string, string>;

export type CurrencyProofResult = {
  /** The window's currencies before anything was injected. */
  natural: {
    marketingCurrencies: string[];
    revenueCurrencies: string[];
    /** Whether single-currency spend computes to a number, as it should. */
    spendAvailability: string;
    spendValue: number | null;
  };
  injected: {
    currency: string;
    marketingCampaignId: string;
    revenueCampaignId: string | null;
  };
  /** What the production path reported once the second currency was present. */
  gate: {
    marketingCurrencies: string[];
    revenueCurrencies: string[];
    spend: Pick<MetricValue, 'availability' | 'blocker' | 'value' | 'numerator' | 'reason'>;
    revenue: Pick<
      MetricValue,
      'availability' | 'blocker' | 'value' | 'numerator' | 'reason'
    > | null;
  };
  /** Every gate condition, evaluated. */
  verdict: {
    detected: boolean;
    notSummed: boolean;
    blocked: boolean;
    reasonNamesCurrency: boolean;
    passed: boolean;
  };
  rollback: {
    verified: boolean;
    before: CurrencyProofSnapshot;
    after: CurrencyProofSnapshot;
  };
};

export type CurrencyProofInput = {
  filters: MetricFilters;
  context: MetricContext;
  /**
   * Test seam. Runs after the synthetic rows exist and before the gate is
   * read; throwing here simulates a proof that dies mid-way, so the rollback
   * guarantee can be tested rather than asserted.
   */
  afterInject?: () => Promise<void>;
};

const SNAPSHOT_TABLES: ReadonlyArray<{ key: string; sql: string }> = [
  {
    key: 'marketing_daily_metrics',
    sql: `SELECT count(*)::text AS n, COALESCE(md5(string_agg(id::text || observed_at::text, ',' ORDER BY id)), '') AS sum
            FROM marketing_daily_metrics WHERE app_id = $1`,
  },
  {
    key: 'attribution_daily_metrics',
    sql: `SELECT count(*)::text AS n, COALESCE(md5(string_agg(id::text || observed_at::text, ',' ORDER BY id)), '') AS sum
            FROM attribution_daily_metrics WHERE app_id = $1`,
  },
  {
    key: 'attribution_revenue_metrics',
    sql: `SELECT count(*)::text AS n, COALESCE(md5(string_agg(id::text || observed_at::text, ',' ORDER BY id)), '') AS sum
            FROM attribution_revenue_metrics WHERE app_id = $1`,
  },
  {
    key: 'provider_entity_mappings',
    sql: `SELECT count(*)::text AS n, COALESCE(md5(string_agg(id::text || status || COALESCE(target_external_id, ''), ',' ORDER BY id)), '') AS sum
            FROM provider_entity_mappings WHERE app_id = $1`,
  },
  {
    key: 'data_freshness',
    sql: `SELECT count(*)::text AS n, COALESCE(md5(string_agg(data_type || status || COALESCE(last_success_at::text, ''), ',' ORDER BY data_type)), '') AS sum
            FROM data_freshness WHERE app_id = $1`,
  },
  {
    key: 'sync_runs',
    sql: `SELECT count(*)::text AS n, COALESCE(md5(string_agg(id::text || status, ',' ORDER BY id)), '') AS sum
            FROM sync_runs WHERE app_id = $1`,
  },
  {
    key: 'sync_errors',
    sql: `SELECT count(*)::text AS n, COALESCE(md5(string_agg(e.id::text || COALESCE(e.resolved_at::text, ''), ',' ORDER BY e.id)), '') AS sum
            FROM sync_errors e JOIN sync_runs r ON r.id = e.sync_run_id WHERE r.app_id = $1`,
  },
  {
    key: 'integration_connections',
    sql: `SELECT count(*)::text AS n, COALESCE(md5(string_agg(c.id::text || c.status || COALESCE(c.last_validation_error_class, ''), ',' ORDER BY c.id)), '') AS sum
            FROM integration_connections c
            JOIN integration_app_bindings b ON b.connection_id = c.id
           WHERE b.app_id = $1`,
  },
  {
    key: 'data_quality_findings',
    sql: `SELECT count(*)::text AS n, COALESCE(md5(string_agg(id::text, ',' ORDER BY id)), '') AS sum
            FROM data_quality_findings WHERE app_id = $1`,
  },
];

/**
 * Counts and checksums for every table the proof could conceivably touch,
 * read through the pool - outside any transaction - so a row that leaked
 * through a missed rollback would show.
 */
export async function snapshotForProof(appId: string): Promise<CurrencyProofSnapshot> {
  const out: CurrencyProofSnapshot = {};
  for (const table of SNAPSHOT_TABLES) {
    const rows = await queryRows<{ n: string; sum: string }>(table.sql, [appId]);
    out[table.key] = `${rows[0]?.n ?? '0'}:${rows[0]?.sum ?? ''}`;
  }
  return out;
}

function pickInjectedCurrency(present: ReadonlySet<string>): string {
  for (const candidate of ['EUR', 'JPY', 'GBP', 'CHF']) {
    if (!present.has(candidate)) return candidate;
  }
  return 'XTS'; // ISO 4217 code reserved for testing; can never be real money.
}

function summarize(
  metric: MetricValue | undefined,
): Pick<MetricValue, 'availability' | 'blocker' | 'value' | 'numerator' | 'reason'> {
  return {
    availability: metric?.availability ?? 'unavailable',
    value: metric?.value ?? null,
    numerator: metric?.numerator ?? null,
    ...(metric?.blocker ? { blocker: metric.blocker } : {}),
    ...(metric?.reason ? { reason: metric.reason } : {}),
  };
}

export async function proveMixedCurrencyGate(
  input: CurrencyProofInput,
): Promise<CurrencyProofResult> {
  const { filters, context } = input;
  const appId = filters.appId;
  const before = await snapshotForProof(appId);

  const client = await getPool().connect();
  let outcome: Omit<CurrencyProofResult, 'rollback'> | undefined;
  try {
    await client.query('BEGIN');
    outcome = await runInsideTransaction(client, filters, context, input.afterInject);
  } finally {
    // Unconditional. A proof that passed, a proof that failed its own
    // assertions, and a proof that threw half-way all end the same way.
    try {
      await client.query('ROLLBACK');
    } catch {
      // A broken connection cannot be rolled back explicitly; releasing it
      // discards the transaction anyway. The snapshot comparison below is the
      // check that matters.
    }
    client.release();
  }

  const after = await snapshotForProof(appId);
  const verified = Object.keys(before).every((k) => before[k] === after[k]);
  if (!outcome) throw new Error('currency proof produced no outcome');
  return { ...outcome, rollback: { verified, before, after } };
}

async function runInsideTransaction(
  client: Queryable,
  filters: MetricFilters,
  context: MetricContext,
  afterInject: (() => Promise<void>) | undefined,
): Promise<Omit<CurrencyProofResult, 'rollback'>> {
  // 1. What the window looks like naturally, through the production loaders.
  const naturalMarketing = await loadMarketingAggregate(filters, client);
  const naturalAttribution = await loadAttributionAggregate(filters, client);
  const naturalMetrics = computeMetricValues({
    context,
    marketing: naturalMarketing,
    attribution: naturalAttribution,
  });
  const naturalSpend = naturalMetrics.find((m) => m.metricKey === 'spend');

  // 2. The minimum synthetic condition: one row per fact family, in a currency
  //    the window does not have, on a campaign id nothing real can carry.
  const present = new Set([...naturalMarketing.currencies, ...naturalAttribution.currencies]);
  const currency = pickInjectedCurrency(present);
  const nonce = randomUUID();
  const marketingCampaignId = `${PROOF_TAG}:${nonce}`;

  const marketingConnection = await queryRows<{ connection_id: string; provider_key: string }>(
    `SELECT b.connection_id, c.provider_key
       FROM integration_app_bindings b
       JOIN integration_connections c ON c.id = b.connection_id
      WHERE b.app_id = $1 AND b.role = 'marketing_network'
      LIMIT 1`,
    [appId(filters)],
    client,
  );
  const marketing = marketingConnection[0];
  if (!marketing) {
    throw new Error('currency proof needs a marketing network bound to the app');
  }
  await queryRows(
    `INSERT INTO marketing_daily_metrics
       (organization_id, app_id, connection_id, provider_key, report_date,
        external_account_id, external_campaign_id, country, platform, currency,
        spend, impressions, clicks, dimension_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, 'unknown', $8, 1, 1, 1, $9)`,
    [
      filters.organizationId,
      filters.appId,
      marketing.connection_id,
      marketing.provider_key,
      filters.from,
      PROOF_TAG,
      marketingCampaignId,
      currency,
      `${PROOF_TAG}:marketing:${nonce}`,
    ],
    client,
  );

  let revenueCampaignId: string | null = null;
  const attributionConnection = await queryRows<{ connection_id: string; provider_key: string }>(
    `SELECT b.connection_id, c.provider_key
       FROM integration_app_bindings b
       JOIN integration_connections c ON c.id = b.connection_id
      WHERE b.app_id = $1 AND b.role = 'primary_attribution'
      LIMIT 1`,
    [appId(filters)],
    client,
  );
  const attribution = attributionConnection[0];
  if (attribution) {
    revenueCampaignId = `${PROOF_TAG}:revenue:${nonce}`;
    await queryRows(
      `INSERT INTO attribution_revenue_metrics
         (organization_id, app_id, connection_id, provider_key, grain, activity_date,
          revenue_type, media_source, normalized_media_source, external_campaign_id,
          country, platform, currency, revenue, dimension_hash)
       VALUES ($1, $2, $3, $4, 'event_date', $5, 'iap', $6, $6, $7, NULL, 'unknown', $8, 1, $9)`,
      [
        filters.organizationId,
        filters.appId,
        attribution.connection_id,
        attribution.provider_key,
        filters.from,
        PROOF_TAG,
        revenueCampaignId,
        currency,
        `${PROOF_TAG}:revenue:${nonce}`,
      ],
      client,
    );
  }

  if (afterInject) await afterInject();

  // 3. Ask the production path what it sees now.
  const mixedMarketing = await loadMarketingAggregate(filters, client);
  const mixedAttribution = await loadAttributionAggregate(filters, client);
  const mixedMetrics = computeMetricValues({
    context,
    marketing: mixedMarketing,
    attribution: mixedAttribution,
  });
  const spend = summarize(mixedMetrics.find((m) => m.metricKey === 'spend'));
  const revenue = attribution
    ? summarize(mixedMetrics.find((m) => m.metricKey === 'attributed_revenue'))
    : null;

  // 4. The conditions, each stated separately so a failure names itself.
  const detected =
    mixedMarketing.currencies.length >= 2 &&
    (!attribution || mixedAttribution.currencies.length >= 2);
  const notSummed =
    spend.value === null && spend.numerator === null && (!revenue || revenue.value === null);
  const blocked =
    spend.availability === 'blocked' &&
    spend.blocker === 'mixed_currency' &&
    (!revenue || (revenue.availability === 'blocked' && revenue.blocker === 'mixed_currency'));
  const reasonNamesCurrency =
    (spend.reason ?? '').includes(currency) &&
    (!revenue || (revenue.reason ?? '').includes(currency));

  return {
    natural: {
      marketingCurrencies: naturalMarketing.currencies,
      revenueCurrencies: naturalAttribution.currencies,
      spendAvailability: naturalSpend?.availability ?? 'unavailable',
      spendValue: naturalSpend?.value ?? null,
    },
    injected: { currency, marketingCampaignId, revenueCampaignId },
    gate: {
      marketingCurrencies: mixedMarketing.currencies,
      revenueCurrencies: mixedAttribution.currencies,
      spend,
      revenue,
    },
    verdict: {
      detected,
      notSummed,
      blocked,
      reasonNamesCurrency,
      passed: detected && notSummed && blocked && reasonNamesCurrency,
    },
  };
}

function appId(filters: MetricFilters): string {
  return filters.appId;
}

/**
 * The same proof for the cohort figures.
 *
 * A cohort ROAS reads two tables - aligned cohort revenue and aligned spend -
 * and a cohort revenue figure reads one. Each must refuse the moment its own
 * inputs carry two currencies, and a second currency on the SPEND side alone
 * must block the ROAS while leaving cohort revenue (which never reads spend)
 * computable. That asymmetry is the point of checking per metric: a gate that
 * blocked everything on any foreign row would be a false refusal, and one that
 * only looked at revenue would let a mixed-currency ROAS through.
 *
 * Two synthetic rows, inside a transaction that is always rolled back: one
 * cohort_date revenue row at the youngest age MART serves, dated early enough
 * to be mature, on a campaign nothing real can carry, and one marketing row
 * on the same day. Then the production loader and the production metric
 * computation are asked what they see.
 */
export type CohortCurrencyProofResult = {
  injected: { currency: string; cohortDate: string; ageDays: number };
  natural: { revenueCurrencies: string[]; spendCurrencies: string[] };
  gate: {
    revenueCurrencies: string[];
    spendCurrencies: string[];
    cohortRevenue: Pick<MetricValue, 'availability' | 'blocker' | 'value' | 'numerator' | 'reason'>;
    cohortRoas: Pick<MetricValue, 'availability' | 'blocker' | 'value' | 'numerator' | 'reason'>;
  };
  verdict: {
    detected: boolean;
    notSummed: boolean;
    blocked: boolean;
    reasonNamesCurrency: boolean;
    passed: boolean;
  };
  rollback: { verified: boolean; before: CurrencyProofSnapshot; after: CurrencyProofSnapshot };
};

export async function proveCohortCurrencyGate(input: {
  filters: MetricFilters;
  context: MetricContext;
}): Promise<CohortCurrencyProofResult> {
  const { filters, context } = input;
  const before = await snapshotForProof(filters.appId);
  const client = await getPool().connect();
  let outcome: Omit<CohortCurrencyProofResult, 'rollback'> | undefined;
  try {
    await client.query('BEGIN');
    outcome = await runCohortProof(client, filters, context);
  } finally {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Released below; the snapshot comparison is the check that matters.
    }
    client.release();
  }
  const after = await snapshotForProof(filters.appId);
  const verified = Object.keys(before).every((k) => before[k] === after[k]);
  if (!outcome) throw new Error('cohort currency proof produced no outcome');
  return { ...outcome, rollback: { verified, before, after } };
}

async function runCohortProof(
  client: Queryable,
  filters: MetricFilters,
  context: MetricContext,
): Promise<Omit<CohortCurrencyProofResult, 'rollback'>> {
  const ageDays = COHORT_AGES[0];
  const revenueKey = cohortMetricKey({ ageDays, revenueType: 'total', measure: 'revenue' });
  const roasKey = cohortMetricKey({ ageDays, revenueType: 'total', measure: 'roas' });
  const summarizeKeys = (metrics: MetricValue[]) => ({
    cohortRevenue: summarize(metrics.find((m) => m.metricKey === revenueKey)),
    cohortRoas: summarize(metrics.find((m) => m.metricKey === roasKey)),
  });

  const naturalCohort = await loadCohortAggregate(filters, client);
  const naturalAge = naturalCohort.byAge[ageDays];
  const present = new Set([
    ...naturalAge.revenue.total.currencies,
    ...naturalAge.alignedSpendCurrencies,
  ]);
  const currency = pickInjectedCurrency(present);
  const nonce = randomUUID();

  const connections = await queryRows<{
    role: string;
    connection_id: string;
    provider_key: string;
  }>(
    `SELECT b.role, b.connection_id, c.provider_key
       FROM integration_app_bindings b
       JOIN integration_connections c ON c.id = b.connection_id
      WHERE b.app_id = $1 AND b.status = 'active'`,
    [filters.appId],
    client,
  );
  const marketing = connections.find((c) => c.role === 'marketing_network');
  const attribution = connections.find((c) => c.role === 'primary_attribution');
  if (!marketing || !attribution) {
    throw new Error(
      'cohort currency proof needs a marketing network and an attribution provider bound',
    );
  }

  // The injected cohort must be MATURE, or the maturity gate - correctly -
  // hides it before the currency gate ever sees it. Dated at the window start
  // and observed far enough after; the horizon is whatever the app has.
  const cohortDate = filters.from;
  const attributionCampaignId = `${PROOF_TAG}:cohort:${nonce}`;
  const marketingCampaignId = `${PROOF_TAG}:spend:${nonce}`;
  await queryRows(
    `INSERT INTO attribution_revenue_metrics
       (organization_id, app_id, connection_id, provider_key, grain, activity_date, cohort_age_days,
        revenue_type, media_source, normalized_media_source, external_campaign_id,
        country, platform, currency, revenue, dimension_hash, observed_at)
     VALUES ($1, $2, $3, $4, 'cohort_date', $5, $6, 'iap', $7, 'meta', $8, NULL, 'unknown', $9, 1, $10,
             ($5::date + $6::int + 2)::timestamptz + interval '1 year')`,
    [
      filters.organizationId,
      filters.appId,
      attribution.connection_id,
      attribution.provider_key,
      cohortDate,
      ageDays,
      PROOF_TAG,
      attributionCampaignId,
      currency,
      `${PROOF_TAG}:cohort:${nonce}`,
    ],
    client,
  );
  // An operational mapping and same-day spend, so the row lands in the
  // ALIGNED population the ROAS actually reads.
  await queryRows(
    `INSERT INTO provider_entity_mappings
       (organization_id, app_id, entity_type, source_provider, source_external_id, source_name,
        target_provider, target_external_id, target_name, mapping_method, mapping_confidence, status)
     VALUES ($1, $2, 'campaign', $3, $4, $5, $6, $7, $5, 'manual', 1, 'manually_verified')`,
    [
      filters.organizationId,
      filters.appId,
      marketing.provider_key,
      marketingCampaignId,
      PROOF_TAG,
      attribution.provider_key,
      attributionCampaignId,
    ],
    client,
  );
  await queryRows(
    `INSERT INTO marketing_daily_metrics
       (organization_id, app_id, connection_id, provider_key, report_date,
        external_account_id, external_campaign_id, country, platform, currency,
        spend, impressions, clicks, dimension_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, 'unknown', $8, 1, 1, 1, $9)`,
    [
      filters.organizationId,
      filters.appId,
      marketing.connection_id,
      marketing.provider_key,
      cohortDate,
      PROOF_TAG,
      marketingCampaignId,
      currency,
      `${PROOF_TAG}:spend:${nonce}`,
    ],
    client,
  );

  const mixedCohort = await loadCohortAggregate(filters, client);
  const mixedAge = mixedCohort.byAge[ageDays];
  const [marketingAgg, attributionAgg] = await Promise.all([
    loadMarketingAggregate(filters, client),
    loadAttributionAggregate(filters, client),
  ]);
  const gate = summarizeKeys(
    computeMetricValues({
      context,
      marketing: marketingAgg,
      attribution: attributionAgg,
      cohort: mixedCohort,
    }),
  );

  const revenueCurrencies = mixedAge.revenue.total.currencies;
  const spendCurrencies = mixedAge.alignedSpendCurrencies;
  const detected = revenueCurrencies.includes(currency) && spendCurrencies.includes(currency);
  const notSummed = gate.cohortRevenue.value === null && gate.cohortRoas.value === null;
  const blocked =
    gate.cohortRevenue.availability === 'blocked' &&
    gate.cohortRevenue.blocker === 'mixed_currency' &&
    gate.cohortRoas.availability === 'blocked' &&
    gate.cohortRoas.blocker === 'mixed_currency';
  const reasonNamesCurrency =
    (gate.cohortRevenue.reason ?? '').includes(currency) &&
    (gate.cohortRoas.reason ?? '').includes(currency);

  return {
    injected: { currency, cohortDate, ageDays },
    natural: {
      revenueCurrencies: naturalAge.revenue.total.currencies,
      spendCurrencies: naturalAge.alignedSpendCurrencies,
    },
    gate: { revenueCurrencies, spendCurrencies, ...gate },
    verdict: {
      detected,
      notSummed,
      blocked,
      reasonNamesCurrency,
      passed: detected && notSummed && blocked && reasonNamesCurrency,
    },
  };
}

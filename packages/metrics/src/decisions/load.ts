import { queryRows, toNumber, type DecisionPolicyRow, type Queryable } from '@mart/db';
import {
  COHORT_AGES,
  COHORT_REVENUE_TYPES,
  addDays,
  eachDate,
  type CohortAge,
  type CohortRevenueType,
  type IsoDate,
} from '@mart/shared';
import { notOrganic, operationalMapping } from '../populations.js';
import { revenueCovered, type MetricFilters } from '../service.js';
import { DECISION_THRESHOLDS } from '../thresholds.js';
import { worstStreamStatus, type SeriesPoint } from './rules.js';
import type {
  BudgetState,
  CampaignDayFact,
  CohortDayFact,
  DaySignals,
  DecisionPolicySnapshot,
  FreshnessState,
  MappingState,
} from './types.js';

/**
 * The facts the decision rules read, loaded from stored rows - Phase 3.
 *
 * Everything is keyed by the MARKETING campaign, because that is the thing a
 * person can act on: an attribution campaign is a label the MMP gave the
 * traffic. Installs and cohort revenue reach a marketing campaign only
 * through an operational mapping, and every predicate here is the Phase 1
 * and Phase 2 one - the same maturity, coverage, organic and mapping rules,
 * built from the same population module - so a recommendation can never
 * rest on a figure the metric layer would have refused to show.
 *
 * `client` lets the Phase 3 audit run this exact path inside a transaction
 * it will roll back, on rows it has altered to force a rule.
 */

export type ScopeSeries = {
  spend: SeriesPoint[];
  installs: SeriesPoint[];
  revenue: SeriesPoint[];
};

export type CampaignFacts = {
  externalCampaignId: string;
  name: string | null;
  status: string | null;
  mapping: MappingState;
  budget: BudgetState | null;
  /** Dense over the loaded range (the window plus its anomaly baseline). */
  days: CampaignDayFact[];
  /** Dense from the campaign's first observed day to each stream's horizon. */
  series: ScopeSeries;
  /** Delivered inside the window: the campaigns the Decision Center lists. */
  deliveredInWindow: boolean;
};

export type DecisionFacts = {
  asOf: IsoDate | null;
  /** The latest day each stream has reported: how far a dense series may run. */
  horizon: { marketing: IsoDate | null; installs: IsoDate | null; revenue: IsoDate | null };
  freshness: FreshnessState;
  activeSyncErrors: number;
  findings: Array<{ checkKey: string; severity: string; count: number }>;
  daySignals: (date: IsoDate) => DaySignals;
  campaigns: CampaignFacts[];
  app: {
    /** The mapped population, summed across campaigns: what an app-level return is drawn from. */
    days: CampaignDayFact[];
    /** The mapped population's daily series: what an app-level anomaly is drawn from. */
    series: ScopeSeries;
    spendCoveragePct: number | null;
    ambiguousSpendPct: number | null;
  };
  policy: DecisionPolicySnapshot;
  /** The range the facts were loaded over: the window plus its baseline. */
  loaded: { from: IsoDate; to: IsoDate };
};

export function policySnapshot(row: DecisionPolicyRow | null): DecisionPolicySnapshot {
  const num = (value: string | null): number | null =>
    value === null ? null : Number.isFinite(Number(value)) ? Number(value) : null;
  const targetRoasD7 = num(row?.target_roas_d7 ?? null);
  const targetRoasD1 = num(row?.target_roas_d1 ?? null);
  const maxCpi = num(row?.max_cpi ?? null);
  return {
    configured: targetRoasD7 !== null || targetRoasD1 !== null || maxCpi !== null,
    targetRoasD7,
    targetRoasD1,
    maxCpi,
    currency: row?.currency ?? null,
    thresholds: DECISION_THRESHOLDS,
    updatedAt: row ? new Date(row.updated_at).toISOString() : null,
  };
}

function emptyCohortDay(): CohortDayFact {
  return {
    revenue: { iap: 0, ad: 0, total: 0 },
    oldEnough: false,
    covered: false,
    earlyReadRows: 0,
    currencies: { iap: [], ad: [], total: [] },
  };
}

function emptyDay(date: IsoDate): CampaignDayFact {
  return {
    date,
    spend: 0,
    impressions: 0,
    clicks: 0,
    spendCurrencies: [],
    installs: 0,
    alignedInstalls: 0,
    cohort: { 1: emptyCohortDay(), 7: emptyCohortDay() },
  };
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

type Window = { from: IsoDate; to: IsoDate };

/**
 * Checks about row labelling, not about a day's integrity. Reconciliation
 * findings (`reconciliation.*`) are excluded by prefix: they describe the
 * account's coverage on the day they were computed, not that day's rows.
 */
const DAY_SIGNAL_EXCLUDED_CHECKS: ReadonlySet<string> = new Set([
  'attribution.missing_campaign_id',
  'marketing.missing_campaign_id',
]);

function covers(window: { from: string | null; to: string | null }, date: IsoDate): boolean {
  return (window.from === null || window.from <= date) && (window.to === null || date <= window.to);
}

/**
 * Load every fact the rules need for one app and window.
 *
 * Reads the window plus `anomalyBaselineDays` before it, because a day is
 * judged against the days before it and the first day of the window has
 * its history outside the window.
 */
export async function loadDecisionFacts(input: {
  filters: MetricFilters;
  window: Window;
  policy: DecisionPolicyRow | null;
  client?: Queryable;
}): Promise<DecisionFacts> {
  const { filters, client } = input;
  const T = DECISION_THRESHOLDS;
  const loadedFrom = addDays(input.window.from, -T.anomalyBaselineDays);
  const loadedTo = input.window.to;
  const allDates = eachDate(loadedFrom, loadedTo);
  const marketingProvider = filters.marketingProviderKey ?? null;
  const attributionProvider = filters.attributionProviderKey ?? null;
  const policy = policySnapshot(input.policy);

  // ------------------------------------------------ freshness and horizon ---
  const freshnessRows = await queryRows<{
    provider_key: string;
    data_type: string;
    status: string;
    latest: string | null;
  }>(
    `SELECT provider_key, data_type, status, latest_provider_data_date::text AS latest
       FROM data_freshness WHERE organization_id = $1 AND app_id = $2`,
    [filters.organizationId, filters.appId],
    client,
  );
  const marketingRows = freshnessRows.filter(
    (r) =>
      r.data_type.startsWith('marketing') &&
      (marketingProvider === null || r.provider_key === marketingProvider),
  );
  const attributionRows = freshnessRows.filter(
    (r) =>
      (r.data_type === 'attribution_installs' || r.data_type === 'attribution_revenue') &&
      (attributionProvider === null || r.provider_key === attributionProvider),
  );
  const latestOf = (rows: typeof freshnessRows, dataType?: string): IsoDate | null =>
    rows
      .filter((r) => dataType === undefined || r.data_type === dataType)
      .map((r) => r.latest)
      .filter((d): d is string => Boolean(d))
      .sort()
      .at(-1) ?? null;
  // The cohort horizon, exactly as Phase 2 defines it: the earlier of the two
  // attribution streams' latest dates, both required.
  const installsLatest = latestOf(attributionRows, 'attribution_installs');
  const revenueLatest = latestOf(attributionRows, 'attribution_revenue');
  const asOf =
    installsLatest && revenueLatest
      ? installsLatest < revenueLatest
        ? installsLatest
        : revenueLatest
      : null;
  const freshness: FreshnessState = {
    marketing: worstStreamStatus(marketingRows.map((r) => r.status)),
    attribution: worstStreamStatus(attributionRows.map((r) => r.status)),
    marketingLatestDate: latestOf(marketingRows),
    attributionLatestDate: latestOf(attributionRows),
  };
  // Each series runs to its own stream's horizon, not to the cohort horizon:
  // an install stream that reached yesterday while the revenue stream lags a
  // day still knows what yesterday's installs were.
  const horizon = {
    marketing: latestOf(marketingRows, 'marketing_performance'),
    installs: installsLatest,
    revenue: revenueLatest,
  };

  // ----------------------------------------------------------- day signals ---
  // Unresolved errors on the streams a reading is drawn from, for the bound
  // providers. An old structure-sync rate limit is a real error, but not one
  // that makes a spend or cohort figure untrustworthy.
  const boundProviders = [marketingProvider, attributionProvider].filter(
    (p): p is string => p !== null,
  );
  const errorRows = await queryRows<{ window_start: string | null; window_end: string | null }>(
    `SELECT e.window_start::text AS window_start, e.window_end::text AS window_end
       FROM sync_errors e JOIN sync_runs r ON r.id = e.sync_run_id
      WHERE e.organization_id = $1 AND r.app_id = $2 AND e.resolved_at IS NULL
        AND r.data_type IN ('marketing_performance', 'attribution_installs', 'attribution_revenue')
        AND r.provider_key = ANY($3::text[])`,
    [filters.organizationId, filters.appId, boundProviders],
    client,
  );
  const installRuns = await queryRows<{
    status: string;
    window_start: string;
    window_end: string;
    completed: string[] | null;
  }>(
    `SELECT r.status, r.window_start::text AS window_start, r.window_end::text AS window_end,
            ARRAY(SELECT jsonb_array_elements_text(COALESCE(r.checkpoint->'completedWindows', '[]'::jsonb)))
              AS completed
       FROM sync_runs r
      WHERE r.organization_id = $1 AND r.app_id = $2 AND r.data_type = 'attribution_installs'
        AND r.status IN ('completed', 'partially_completed')
        AND ($3::text IS NULL OR r.provider_key = $3)`,
    [filters.organizationId, filters.appId, attributionProvider],
    client,
  );
  const installWindows: Array<{ from: string; to: string }> = [];
  for (const run of installRuns) {
    for (const key of run.completed ?? []) {
      const [from, to] = key.split('..');
      if (from && to) installWindows.push({ from, to });
    }
    if (run.status === 'completed') {
      installWindows.push({ from: run.window_start, to: run.window_end });
    }
  }
  const revenueWindows = await queryRows<{ from: string; to: string; finished: string | null }>(
    `SELECT w->>'from' AS "from", w->>'to' AS "to",
            (r.finished_at AT TIME ZONE a.timezone)::date::text AS finished
       FROM sync_runs r
       JOIN apps a ON a.id = r.app_id,
            jsonb_array_elements(COALESCE(r.checkpoint->'dataWindows', '[]'::jsonb)) w
      WHERE r.organization_id = $1 AND r.app_id = $2 AND r.data_type = 'attribution_revenue'
        AND r.status IN ('completed', 'partially_completed')
        AND ($3::text IS NULL OR r.provider_key = $3)`,
    [filters.organizationId, filters.appId, attributionProvider],
    client,
  );
  // Sync-time findings are an append-only record of what each run saw. A
  // finding is current until a later completed run of the same stream reads
  // the day again: the latest read of a day decides what is true of it, and
  // a corrective re-sync that no longer flags the day resolves the finding.
  // Reconciliation findings are rewritten on every recompute and carry no
  // run, so they are always current.
  const allFindingRows = await queryRows<{
    check_key: string;
    severity: string;
    observed_date: string | null;
    current: boolean;
  }>(
    `SELECT f.check_key, f.severity, f.observed_date::text AS observed_date,
            NOT EXISTS (
              SELECT 1 FROM sync_runs later
               WHERE later.app_id = f.app_id AND later.connection_id = r.connection_id
                 AND later.data_type = r.data_type
                 AND later.status IN ('completed', 'partially_completed')
                 AND later.finished_at > f.created_at
                 AND (f.observed_date IS NULL
                      OR (later.status = 'completed'
                          AND later.window_start <= f.observed_date
                          AND later.window_end >= f.observed_date)
                      OR EXISTS (
                        SELECT 1 FROM jsonb_array_elements_text(
                          COALESCE(later.checkpoint->'completedWindows', '[]'::jsonb)) k
                         WHERE split_part(k, '..', 1)::date <= f.observed_date
                           AND split_part(k, '..', 2)::date >= f.observed_date))
            ) AS current
       FROM data_quality_findings f
       LEFT JOIN sync_runs r ON r.id = f.sync_run_id
      WHERE f.organization_id = $1 AND f.app_id = $2`,
    [filters.organizationId, filters.appId],
    client,
  );
  const findingRows = allFindingRows.filter((f) => f.current);
  // A finding on a day is a data-side signal for that day's anomalies -
  // except the two that describe how rows are labelled rather than whether
  // the day is intact. Organic traffic has no campaign id every day; treating
  // that as evidence of a tracking fault would classify every install move
  // on an app with organic installs as an attribution problem.
  const findingDates = new Set(
    findingRows
      .filter(
        (f) =>
          f.severity !== 'info' &&
          f.observed_date &&
          !DAY_SIGNAL_EXCLUDED_CHECKS.has(f.check_key) &&
          !f.check_key.startsWith('reconciliation.'),
      )
      .map((f) => f.observed_date as string),
  );
  const daySignals = (date: IsoDate): DaySignals => ({
    syncError: errorRows.some((e) => covers({ from: e.window_start, to: e.window_end }, date)),
    uncovered: !installWindows.some((w) => covers(w, date)),
    finding: findingDates.has(date),
  });
  /** The same test {@link revenueCovered} applies in SQL, for days that have no revenue row. */
  const revenueCoveredAt = (date: IsoDate, age: CohortAge): boolean =>
    revenueWindows.some(
      (w) => covers(w, date) && w.finished !== null && w.finished > addDays(date, age),
    );
  // Labelling checks are excluded from the readings' findings for the reason
  // given above: they describe rows, not whether a day is intact.
  const findingCounts = new Map<string, { checkKey: string; severity: string; count: number }>();
  for (const finding of findingRows) {
    if (DAY_SIGNAL_EXCLUDED_CHECKS.has(finding.check_key)) continue;
    const inWindow =
      finding.observed_date === null ||
      (finding.observed_date >= input.window.from && finding.observed_date <= input.window.to);
    if (!inWindow) continue;
    const key = `${finding.check_key}|${finding.severity}`;
    const entry = findingCounts.get(key) ?? {
      checkKey: finding.check_key,
      severity: finding.severity,
      count: 0,
    };
    entry.count += 1;
    findingCounts.set(key, entry);
  }
  const findings = [...findingCounts.values()].sort((a, b) =>
    a.checkKey < b.checkKey
      ? -1
      : a.checkKey > b.checkKey
        ? 1
        : a.severity.localeCompare(b.severity),
  );

  // ------------------------------------------------------------ campaigns ---
  const campaigns = new Map<string, CampaignFacts>();
  const ensure = (externalCampaignId: string): CampaignFacts => {
    let facts = campaigns.get(externalCampaignId);
    if (!facts) {
      facts = {
        externalCampaignId,
        name: null,
        status: null,
        mapping: {
          status: null,
          method: null,
          confidence: null,
          operational: false,
          ambiguous: false,
          attributionCampaignIds: [],
        },
        budget: null,
        days: allDates.map(emptyDay),
        series: { spend: [], installs: [], revenue: [] },
        deliveredInWindow: false,
      };
      campaigns.set(externalCampaignId, facts);
    }
    return facts;
  };
  const dayIndex = new Map(allDates.map((d, i) => [d, i] as const));
  const eventRevenueByCampaign = new Map<string, Map<string, number>>();
  const dayOf = (facts: CampaignFacts, date: string): CampaignDayFact | undefined => {
    const index = dayIndex.get(date);
    return index === undefined ? undefined : facts.days[index];
  };

  if (marketingProvider) {
    const structure = await queryRows<{
      external_campaign_id: string;
      name: string | null;
      status: string | null;
      daily_budget: string | null;
      lifetime_budget: string | null;
      currency: string | null;
      ad_set_daily_budget: string | null;
    }>(
      `SELECT c.external_campaign_id,
              MAX(c.name) AS name,
              MAX(c.effective_status) AS status,
              MAX(c.daily_budget)::text AS daily_budget,
              MAX(c.lifetime_budget)::text AS lifetime_budget,
              MAX(c.currency) AS currency,
              (SELECT SUM(g.daily_budget)::text FROM marketing_ad_groups g
                WHERE g.organization_id = c.organization_id AND g.app_id = c.app_id
                  AND g.provider_key = c.provider_key
                  AND g.external_campaign_id = c.external_campaign_id) AS ad_set_daily_budget
         FROM marketing_campaigns c
        WHERE c.organization_id = $1 AND c.app_id = $2 AND c.provider_key = $3
        GROUP BY c.organization_id, c.app_id, c.provider_key, c.external_campaign_id`,
      [filters.organizationId, filters.appId, marketingProvider],
      client,
    );
    const lifetimeIds: string[] = [];
    for (const row of structure) {
      const facts = ensure(row.external_campaign_id);
      facts.name = row.name;
      facts.status = row.status;
      const daily = row.daily_budget !== null ? toNumber(row.daily_budget) : null;
      const adSets = row.ad_set_daily_budget !== null ? toNumber(row.ad_set_daily_budget) : null;
      const lifetime = row.lifetime_budget !== null ? toNumber(row.lifetime_budget) : null;
      const source: BudgetState['source'] =
        daily !== null && daily > 0 ? 'campaign' : adSets !== null && adSets > 0 ? 'ad_sets' : null;
      facts.budget = {
        daily: source === 'campaign' ? daily : source === 'ad_sets' ? adSets : null,
        source,
        currency: row.currency,
        lifetime: lifetime !== null && lifetime > 0 ? lifetime : null,
        spentToDate: null,
      };
      if (facts.budget.lifetime !== null) lifetimeIds.push(row.external_campaign_id);
    }
    if (lifetimeIds.length > 0) {
      const spent = await queryRows<{ external_campaign_id: string; spend: string }>(
        `SELECT external_campaign_id, SUM(spend)::text AS spend
           FROM marketing_daily_metrics
          WHERE organization_id = $1 AND app_id = $2 AND provider_key = $3
            AND external_campaign_id = ANY($4::text[])
          GROUP BY external_campaign_id`,
        [filters.organizationId, filters.appId, marketingProvider, lifetimeIds],
        client,
      );
      for (const row of spent) {
        const facts = campaigns.get(row.external_campaign_id);
        if (facts?.budget) facts.budget.spentToDate = toNumber(row.spend);
      }
    }

    const delivery = await queryRows<{
      cid: string;
      date: string;
      spend: string;
      impressions: string;
      clicks: string;
      currencies: string[];
    }>(
      `SELECT md.external_campaign_id AS cid, md.report_date::text AS date,
              SUM(md.spend)::text AS spend, SUM(md.impressions)::text AS impressions,
              SUM(md.clicks)::text AS clicks,
              COALESCE(array_agg(DISTINCT md.currency) FILTER (WHERE md.spend > 0), '{}') AS currencies
         FROM marketing_daily_metrics md
        WHERE md.organization_id = $1 AND md.app_id = $2 AND md.provider_key = $3
          AND md.report_date BETWEEN $4 AND $5 AND md.external_campaign_id IS NOT NULL
        GROUP BY md.external_campaign_id, md.report_date`,
      [filters.organizationId, filters.appId, marketingProvider, loadedFrom, loadedTo],
      client,
    );
    for (const row of delivery) {
      const facts = ensure(row.cid);
      const day = dayOf(facts, row.date);
      if (!day) continue;
      day.spend = toNumber(row.spend);
      day.impressions = toNumber(row.impressions);
      day.clicks = toNumber(row.clicks);
      day.spendCurrencies = sortedUnique(row.currencies ?? []);
      if (
        row.date >= input.window.from &&
        row.date <= input.window.to &&
        (day.spend > 0 || day.impressions > 0 || day.clicks > 0)
      ) {
        facts.deliveredInWindow = true;
      }
    }

    if (attributionProvider) {
      const mappingRows = await queryRows<{
        source_external_id: string;
        status: string;
        mapping_method: string;
        mapping_confidence: string;
        target_external_id: string | null;
        operational: boolean;
      }>(
        `SELECT m.source_external_id, m.status, m.mapping_method, m.mapping_confidence::text,
                m.target_external_id,
                (m.target_external_id IS NOT NULL AND ${operationalMapping('m')}) AS operational
           FROM provider_entity_mappings m
          WHERE m.organization_id = $1 AND m.app_id = $2 AND m.entity_type = 'campaign'
            AND m.source_provider = $3 AND m.target_provider = $4
          ORDER BY m.source_external_id, operational DESC, m.mapping_confidence DESC, m.status`,
        [filters.organizationId, filters.appId, marketingProvider, attributionProvider],
        client,
      );
      for (const row of mappingRows) {
        const facts = ensure(row.source_external_id);
        const mapping = facts.mapping;
        if (row.operational && row.target_external_id) {
          mapping.attributionCampaignIds.push(row.target_external_id);
        }
        // The first row per campaign is its strongest: operational first, then
        // by confidence. Its status and method describe the campaign.
        if (mapping.status === null) {
          mapping.status = row.status;
          mapping.method = row.mapping_method;
          mapping.confidence = Number(row.mapping_confidence);
        }
        if (row.operational) mapping.operational = true;
        if (row.status === 'ambiguous') mapping.ambiguous = true;
      }
      for (const facts of campaigns.values()) {
        facts.mapping.ambiguous = facts.mapping.ambiguous && !facts.mapping.operational;
        facts.mapping.attributionCampaignIds.sort();
      }

      // Each attribution campaign is credited to exactly one marketing
      // campaign - its strongest operational link - so summing campaign
      // facts into the app never counts a cohort twice.
      const LINKS = `links AS (
        SELECT DISTINCT ON (m.target_external_id)
               m.target_external_id AS attribution_id, m.source_external_id AS marketing_id
          FROM provider_entity_mappings m
         WHERE m.organization_id = $1 AND m.app_id = $2 AND m.entity_type = 'campaign'
           AND m.source_provider = $3 AND m.target_provider = $4
           AND m.target_external_id IS NOT NULL AND ${operationalMapping('m')}
         ORDER BY m.target_external_id, m.mapping_confidence DESC, m.source_external_id
      )`;
      const installs = await queryRows<{ cid: string; date: string; installs: string }>(
        `WITH ${LINKS}
         SELECT l.marketing_id AS cid, t.install_date::text AS date,
                SUM(t.attributed_installs)::text AS installs
           FROM attribution_daily_metrics t
           JOIN links l ON l.attribution_id = t.external_campaign_id
          WHERE t.organization_id = $1 AND t.app_id = $2 AND t.provider_key = $4
            AND t.install_date BETWEEN $5 AND $6 AND ${notOrganic('t')}
          GROUP BY l.marketing_id, t.install_date`,
        [
          filters.organizationId,
          filters.appId,
          marketingProvider,
          attributionProvider,
          loadedFrom,
          loadedTo,
        ],
        client,
      );
      for (const row of installs) {
        const day = dayOf(ensure(row.cid), row.date);
        if (day) day.installs = toNumber(row.installs);
      }

      const eventRevenue = await queryRows<{ cid: string; date: string; revenue: string }>(
        `WITH ${LINKS}
         SELECT l.marketing_id AS cid, t.activity_date::text AS date, SUM(t.revenue)::text AS revenue
           FROM attribution_revenue_metrics t
           JOIN links l ON l.attribution_id = t.external_campaign_id
          WHERE t.organization_id = $1 AND t.app_id = $2 AND t.provider_key = $4
            AND t.grain = 'event_date' AND t.activity_date BETWEEN $5 AND $6 AND ${notOrganic('t')}
            -- A provider total counts only where no component row exists for
            -- the same day and identity: a report that gained the split
            -- later leaves its old totals behind.
            AND (t.revenue_type <> 'total' OR NOT EXISTS (
                  SELECT 1 FROM attribution_revenue_metrics c
                   WHERE c.connection_id = t.connection_id AND c.app_id = t.app_id
                     AND c.grain = 'event_date' AND c.activity_date = t.activity_date
                     AND c.revenue_type IN ('iap', 'ad')
                     AND c.media_source IS NOT DISTINCT FROM t.media_source
                     AND c.external_campaign_id IS NOT DISTINCT FROM t.external_campaign_id
                     AND c.country IS NOT DISTINCT FROM t.country
                     AND c.platform = t.platform AND c.currency = t.currency))
          GROUP BY l.marketing_id, t.activity_date`,
        [
          filters.organizationId,
          filters.appId,
          marketingProvider,
          attributionProvider,
          loadedFrom,
          loadedTo,
        ],
        client,
      );
      for (const row of eventRevenue) {
        const byDate = eventRevenueByCampaign.get(row.cid) ?? new Map<string, number>();
        byDate.set(row.date, toNumber(row.revenue));
        eventRevenueByCampaign.set(row.cid, byDate);
      }

      if (asOf) {
        const cohorts = await queryRows<{
          cid: string;
          date: string;
          age: number;
          revenue_type: string;
          revenue: string;
          early_read_rows: string;
          currencies: string[];
        }>(
          `WITH ${LINKS},
           cohort AS (
             SELECT l.marketing_id AS cid, t.activity_date, t.cohort_age_days AS age,
                    t.revenue_type, t.revenue, t.currency,
                    (t.activity_date + t.cohort_age_days) < $7::date AS old_enough,
                    (t.observed_at AT TIME ZONE a.timezone)::date > (t.activity_date + t.cohort_age_days)
                      AS read_after,
                    ${revenueCovered({
                      alias: 't',
                      dayExpr: 't.activity_date',
                      ageParam: 't.cohort_age_days',
                      timezoneExpr: 'a.timezone',
                      providerParam: '$4',
                    })} AS covered
               FROM attribution_revenue_metrics t
               JOIN apps a ON a.id = t.app_id
               JOIN links l ON l.attribution_id = t.external_campaign_id
              WHERE t.organization_id = $1 AND t.app_id = $2 AND t.provider_key = $4
                AND t.grain = 'cohort_date' AND t.cohort_age_days = ANY($8::int[])
                AND t.activity_date BETWEEN $5 AND $6 AND ${notOrganic('t')}
                -- A provider total counts only where no component row exists
                -- for the same cohort, exactly as the metric layer reads it.
                AND (t.revenue_type <> 'total' OR NOT EXISTS (
                      SELECT 1 FROM attribution_revenue_metrics c
                       WHERE c.connection_id = t.connection_id AND c.app_id = t.app_id
                         AND c.grain = 'cohort_date' AND c.cohort_age_days = t.cohort_age_days
                         AND c.activity_date = t.activity_date AND c.revenue_type IN ('iap', 'ad')
                         AND c.media_source IS NOT DISTINCT FROM t.media_source
                         AND c.external_campaign_id IS NOT DISTINCT FROM t.external_campaign_id
                         AND c.country IS NOT DISTINCT FROM t.country
                         AND c.platform = t.platform AND c.currency = t.currency))
           )
           SELECT cid, activity_date::text AS date, age, revenue_type,
                  COALESCE(SUM(revenue) FILTER (WHERE old_enough AND read_after AND covered), 0)::text
                    AS revenue,
                  count(*) FILTER (WHERE old_enough AND NOT read_after)::text AS early_read_rows,
                  COALESCE(array_agg(DISTINCT currency)
                    FILTER (WHERE old_enough AND read_after AND covered), '{}') AS currencies
             FROM cohort
            GROUP BY cid, activity_date, age, revenue_type`,
          [
            filters.organizationId,
            filters.appId,
            marketingProvider,
            attributionProvider,
            loadedFrom,
            loadedTo,
            asOf,
            [...COHORT_AGES],
          ],
          client,
        );
        for (const row of cohorts) {
          const day = dayOf(ensure(row.cid), row.date);
          const age = toNumber(row.age) as CohortAge;
          if (!day || !COHORT_AGES.includes(age)) continue;
          const cohort = day.cohort[age];
          const revenue = toNumber(row.revenue);
          const currencies = row.currencies ?? [];
          if (row.revenue_type === 'iap' || row.revenue_type === 'ad') {
            cohort.revenue[row.revenue_type] += revenue;
            cohort.currencies[row.revenue_type] = sortedUnique([
              ...cohort.currencies[row.revenue_type],
              ...currencies,
            ]);
          }
          cohort.revenue.total += revenue;
          cohort.earlyReadRows += toNumber(row.early_read_rows);
          cohort.currencies.total = sortedUnique([...cohort.currencies.total, ...currencies]);
        }
      }

      // Maturity and coverage are properties of the DAY, not of the rows on
      // it: a delivered day with no cohort row at all is still mature or not.
      for (const facts of campaigns.values()) {
        for (const day of facts.days) {
          day.alignedInstalls = day.spend > 0 ? day.installs : 0;
          for (const age of COHORT_AGES) {
            const cohort = day.cohort[age];
            cohort.oldEnough = asOf !== null && addDays(day.date, age) < asOf;
            cohort.covered = revenueCoveredAt(day.date, age);
          }
        }
      }

      // Dense series from the first day the campaign was observed to each
      // stream's horizon: a day inside that range with no row is a zero the
      // provider reported by omission, a day outside it is unknown.
      for (const facts of campaigns.values()) {
        const revenueByDate = eventRevenueByCampaign.get(facts.externalCampaignId);
        const first = facts.days.find(
          (d) => d.spend > 0 || d.impressions > 0 || d.clicks > 0 || d.installs > 0,
        )?.date;
        if (!first) continue;
        facts.series = {
          spend: seriesFrom(facts.days, first, horizon.marketing, (d) => d.spend),
          installs: seriesFrom(facts.days, first, horizon.installs, (d) => d.installs),
          revenue: seriesFrom(
            facts.days,
            first,
            horizon.revenue,
            (d) => revenueByDate?.get(d.date) ?? 0,
          ),
        };
      }
    }
  }

  // ------------------------------------------------------------------ app ---
  const appDays = allDates.map(emptyDay);
  let totalSpend = 0;
  let mappedSpend = 0;
  let ambiguousSpend = 0;
  for (const facts of campaigns.values()) {
    for (const [index, day] of facts.days.entries()) {
      const inWindow = day.date >= input.window.from && day.date <= input.window.to;
      if (inWindow) {
        totalSpend += day.spend;
        if (facts.mapping.operational) mappedSpend += day.spend;
        else if (facts.mapping.ambiguous) ambiguousSpend += day.spend;
      }
      if (!facts.mapping.operational) continue;
      const target = appDays[index] as CampaignDayFact;
      target.spend += day.spend;
      target.impressions += day.impressions;
      target.clicks += day.clicks;
      target.spendCurrencies = sortedUnique([...target.spendCurrencies, ...day.spendCurrencies]);
      target.installs += day.installs;
      // Cohort-aligned, exactly as Phase 2 aligns a cohort ROAS: a cohort's
      // return and installs join the app figure only on a day its own
      // campaign spent. Another campaign's spend on the day buys nothing for
      // a campaign that was paused.
      if (!(day.spend > 0)) continue;
      target.alignedInstalls += day.installs;
      for (const age of COHORT_AGES) {
        const from = day.cohort[age];
        const into = target.cohort[age];
        for (const type of COHORT_REVENUE_TYPES) {
          into.revenue[type] += from.revenue[type];
          into.currencies[type] = sortedUnique([
            ...into.currencies[type],
            ...from.currencies[type],
          ]);
        }
        into.earlyReadRows += from.earlyReadRows;
      }
    }
  }
  for (const day of appDays) {
    for (const age of COHORT_AGES) {
      day.cohort[age].oldEnough = asOf !== null && addDays(day.date, age) < asOf;
      day.cohort[age].covered = revenueCoveredAt(day.date, age);
    }
  }
  // App-level anomalies are drawn from the same population the app reading
  // is: the mapped campaigns. A featuring spike in organic installs is real,
  // but it is not a reason to withhold a reading on paid campaigns it never
  // touched; a tracking fault that stops paid installs still shows here.
  const operational = [...campaigns.values()].filter((c) => c.mapping.operational);
  const firstMappedActivity =
    operational
      .map(
        (c) =>
          c.days.find((d) => d.spend > 0 || d.impressions > 0 || d.clicks > 0 || d.installs > 0)
            ?.date,
      )
      .filter((d): d is string => Boolean(d))
      .sort()[0] ?? null;
  const appEventRevenue = new Map<string, number>();
  for (const c of operational) {
    for (const [date, value] of eventRevenueByCampaign.get(c.externalCampaignId) ?? []) {
      appEventRevenue.set(date, (appEventRevenue.get(date) ?? 0) + value);
    }
  }
  const appSeries: ScopeSeries = firstMappedActivity
    ? {
        spend: seriesFrom(appDays, firstMappedActivity, horizon.marketing, (d) => d.spend),
        installs: seriesFrom(appDays, firstMappedActivity, horizon.installs, (d) => d.installs),
        revenue: seriesFrom(
          appDays,
          firstMappedActivity,
          horizon.revenue,
          (d) => appEventRevenue.get(d.date) ?? 0,
        ),
      }
    : { spend: [], installs: [], revenue: [] };

  // Unrounded: the gate compares against a floor, and 79.996 is below 80.
  const pct = (value: number, denominator: number): number | null =>
    denominator > 0 ? (value / denominator) * 100 : null;

  return {
    asOf,
    horizon,
    freshness,
    activeSyncErrors: errorRows.length,
    findings,
    daySignals,
    campaigns: [...campaigns.values()].sort((a, b) =>
      a.externalCampaignId < b.externalCampaignId ? -1 : 1,
    ),
    app: {
      days: appDays,
      series: appSeries,
      spendCoveragePct: pct(mappedSpend, totalSpend),
      ambiguousSpendPct: pct(ambiguousSpend, totalSpend),
    },
    policy,
    loaded: { from: loadedFrom, to: loadedTo },
  };
}

function seriesFrom(
  days: readonly CampaignDayFact[],
  first: IsoDate,
  horizon: IsoDate | null,
  pick: (day: CampaignDayFact) => number,
): SeriesPoint[] {
  if (horizon === null) return [];
  return days
    .filter((d) => d.date >= first && d.date <= horizon)
    .map((d) => ({ date: d.date, value: pick(d) }));
}

export type { CohortRevenueType };

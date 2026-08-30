/**
 * Reconciliation audit.
 *
 *   node packages/integrations/dist/cli/reconcile-audit.js <organization_id> [app_id]
 *
 * Explains every unmatched campaign, in both directions, from MART's own
 * storage. Reconciliation says how many are unmatched; this says why each one
 * is, which is the only useful form of that answer.
 *
 * It is read-only and creates no mappings. The near-name comparison below is
 * for diagnosis only and never produces a match: a near miss is reported so a
 * human can decide, because two campaign names that differ by a date are two
 * campaigns.
 */
import { closePool, queryRows } from '@mart/db';
import { attributionNameKeys, embeddedNames, nameKey } from '../reconciliation.js';

type MarketingRow = {
  external_campaign_id: string;
  name: string | null;
  effective_status: string | null;
  spend: string | null;
  first_date: string | null;
  last_date: string | null;
};

type AttributionRow = {
  external_campaign_id: string | null;
  campaign_name: string | null;
  media_source: string | null;
  installs: string;
  revenue: string;
  first_date: string | null;
  last_date: string | null;
};

type MappingRow = {
  source_provider: string;
  source_external_id: string;
  source_name: string | null;
  target_external_id: string | null;
  status: string;
  mapping_method: string;
  mapping_confidence: string;
};

function line(label: string, value: unknown): void {
  process.stdout.write(`${label.padEnd(34)} ${String(value)}\n`);
}

function heading(text: string): void {
  process.stdout.write(`\n=== ${text} ===\n`);
}

/**
 * A conservative near-name notion, for the report only.
 *
 * Two names are "near" when one is a prefix of the other, or they differ only
 * after their last separator - which is exactly the date-suffix case that
 * makes two real campaigns look alike. Deliberately not a similarity score:
 * this exists to tell a human where to look, never to justify a join.
 */
function nearNames(target: string, candidates: readonly string[]): string[] {
  const key = nameKey(target);
  if (!key) return [];
  const stem = key.slice(0, Math.max(8, Math.floor(key.length * 0.75)));
  return candidates.filter((candidate) => {
    const other = nameKey(candidate);
    if (!other || other === key) return false;
    return other.startsWith(stem) || key.startsWith(other.slice(0, stem.length));
  });
}

async function main(): Promise<void> {
  const organizationId = process.argv[2];
  const appFilter = process.argv[3];
  if (!organizationId) {
    process.stderr.write('usage: reconcile-audit <organization_id> [app_id]\n');
    process.exitCode = 2;
    return;
  }

  const apps = await queryRows<{ id: string; name: string }>(
    `SELECT id, name FROM apps WHERE organization_id = $1 ${appFilter ? 'AND id = $2' : ''}
      AND status = 'active' ORDER BY name`,
    appFilter ? [organizationId, appFilter] : [organizationId],
  );

  for (const app of apps) {
    await auditApp(organizationId, app.id, app.name);
  }
}

async function auditApp(organizationId: string, appId: string, appName: string): Promise<void> {
  heading(`APP: ${appName}`);

  const [marketing, attribution, mappings] = await Promise.all([
    queryRows<MarketingRow>(
      `SELECT m.external_campaign_id,
              MAX(c.name) AS name,
              MAX(c.effective_status) AS effective_status,
              SUM(m.spend)::text AS spend,
              MIN(m.report_date)::text AS first_date,
              MAX(m.report_date)::text AS last_date
         FROM marketing_daily_metrics m
         LEFT JOIN marketing_campaigns c
                ON c.app_id = m.app_id AND c.external_campaign_id = m.external_campaign_id
        WHERE m.organization_id = $1 AND m.app_id = $2 AND m.external_campaign_id IS NOT NULL
        GROUP BY m.external_campaign_id`,
      [organizationId, appId],
    ),
    queryRows<AttributionRow>(
      `SELECT a.external_campaign_id,
              MAX(a.campaign_name) AS campaign_name,
              MAX(a.media_source) AS media_source,
              SUM(a.attributed_installs)::text AS installs,
              COALESCE((SELECT SUM(r.revenue) FROM attribution_revenue_metrics r
                         WHERE r.app_id = a.app_id
                           AND r.external_campaign_id = a.external_campaign_id
                           AND r.grain = 'event_date'), 0)::text AS revenue,
              MIN(a.install_date)::text AS first_date,
              MAX(a.install_date)::text AS last_date
         FROM attribution_daily_metrics a
        WHERE a.organization_id = $1 AND a.app_id = $2
        GROUP BY a.app_id, a.external_campaign_id`,
      [organizationId, appId],
    ),
    queryRows<MappingRow>(
      `SELECT source_provider, source_external_id, source_name, target_external_id,
              status, mapping_method, mapping_confidence::text
         FROM provider_entity_mappings
        WHERE organization_id = $1 AND app_id = $2 AND entity_type = 'campaign'`,
      [organizationId, appId],
    ),
  ]);

  const marketingNames = marketing.map((row) => row.name ?? row.external_campaign_id);
  const marketingByKey = new Map<string, MarketingRow[]>();
  for (const row of marketing) {
    const key = nameKey(row.name);
    if (!key) continue;
    marketingByKey.set(key, [...(marketingByKey.get(key) ?? []), row]);
  }

  const mappedAttributionIds = new Set(
    mappings.filter((m) => m.target_external_id).map((m) => m.target_external_id as string),
  );
  // Only the marketing side: the reverse-direction rows carry attribution
  // campaigns as their source and would otherwise be counted as marketing.
  const marketingIds = new Set(marketing.map((row) => row.external_campaign_id));
  const mappedMarketingIds = new Set(
    mappings
      .filter(
        (m) =>
          m.target_external_id !== null &&
          m.status !== 'not_applicable' &&
          marketingIds.has(m.source_external_id),
      )
      .map((m) => m.source_external_id),
  );

  const marketingWindow = {
    from:
      marketing
        .map((r) => r.first_date)
        .filter(Boolean)
        .sort()[0] ?? null,
    to:
      marketing
        .map((r) => r.last_date)
        .filter(Boolean)
        .sort()
        .at(-1) ?? null,
  };

  heading('TOTALS');
  line('Meta campaigns (with spend)', marketing.length);
  line('Attribution campaigns', `${attribution.length} (organic included)`);
  line('Meta data window', `${marketingWindow.from ?? '?'} .. ${marketingWindow.to ?? '?'}`);
  line('Mapping rows', mappings.length);
  line('Mapped Meta campaigns', mappedMarketingIds.size);

  // ---------------------------------------------- unmatched attribution ---
  const organic = attribution.filter((row) => (row.media_source ?? '').toLowerCase() === 'organic');
  const paid = attribution.filter((row) => !organic.includes(row));
  const unmatchedPaid = paid.filter(
    (row) => !row.external_campaign_id || !mappedAttributionIds.has(row.external_campaign_id),
  );

  heading(`UNMATCHED ATTRIBUTION CAMPAIGNS (${unmatchedPaid.length})`);
  let index = 0;
  let missingStructure = 0;
  for (const row of unmatchedPaid) {
    index += 1;
    const embedded = embeddedNames(row.campaign_name);
    const candidate = embedded[0] ?? null;
    const normalized = candidate ? nameKey(candidate) : nameKey(row.campaign_name);
    const exact = normalized ? (marketingByKey.get(normalized) ?? []) : [];
    const near = candidate
      ? nearNames(
          candidate,
          marketingNames.filter((n): n is string => !!n),
        )
      : [];

    process.stdout.write(`\n--- ${index} ---\n`);
    line('TENJIN CAMPAIGN ID:', row.external_campaign_id ?? '(none reported)');
    line('TENJIN CAMPAIGN NAME:', row.campaign_name ?? '(none)');
    line('INSTALLS:', row.installs);
    line('REVENUE:', row.revenue);
    line('PARENTHESIZED META CANDIDATE:', candidate ?? '(none - name carries no parentheses)');
    line('NORMALIZED CANDIDATE:', normalized ?? '(none)');
    line('EXACT META CAMPAIGN EXISTS:', exact.length > 0 ? 'YES' : 'NO');

    if (exact.length > 0) {
      for (const match of exact) {
        line('  meta campaign id', match.external_campaign_id);
        line('  meta status', match.effective_status ?? '(not stored)');
      }
      line(
        'MATCHER REJECTION REASON:',
        exact.length > 1
          ? `${exact.length} Meta campaigns share this name - ambiguous by design`
          : 'none: this should be matched. Re-run reconciliation.',
      );
      continue;
    }

    line('  near-name Meta campaign?', near.length > 0 ? near.join(' | ') : 'NO');
    const outsideWindow =
      marketingWindow.from !== null &&
      row.last_date !== null &&
      row.last_date < marketingWindow.from;
    line('  outside Meta structure set?', outsideWindow ? 'YES' : 'NO');
    if (outsideWindow) missingStructure += 1;
    const nearStatuses = near
      .flatMap((n) => marketingByKey.get(nameKey(n) ?? '') ?? [])
      .map((m) => m.effective_status ?? 'unknown');
    line(
      '  paused/deleted/archived?',
      nearStatuses.length > 0 ? nearStatuses.join(', ') : 'n/a - no candidate stored',
    );
    line(
      '  Meta structure missing history?',
      marketingWindow.from && row.first_date && row.first_date < marketingWindow.from
        ? `YES - attribution starts ${row.first_date}, Meta data starts ${marketingWindow.from}`
        : 'NO',
    );
    line(
      '  naming-format mismatch?',
      candidate === null
        ? 'YES - no parenthesized network name to match on'
        : near.length > 0
          ? 'possible - a near name exists but differs in an identity token'
          : 'NO',
    );
    line(
      'MATCHER REJECTION REASON:',
      candidate === null
        ? 'No embedded network campaign name, and no whole-name equality'
        : near.length > 0
          ? 'Embedded name is close to a Meta campaign but not equal; matching it would join two different campaigns'
          : 'No Meta campaign in MART storage carries this name',
    );
  }

  // ------------------------------------------------------- ambiguous ---
  // The cases MART refused to guess. Every field a person needs to decide is
  // printed, including which discriminator was available and which was not.
  const ambiguous = mappings.filter((m) => m.status === 'ambiguous');
  heading(`AMBIGUOUS (${ambiguous.length})`);
  for (const mapping of ambiguous) {
    const source = marketing.find((m) => m.external_campaign_id === mapping.source_external_id);
    const candidates = await queryRows<{
      external_campaign_id: string;
      name: string | null;
      effective_status: string | null;
      status: string | null;
      provider_created_at: string | null;
      spend: string | null;
      installs: string | null;
      revenue: string | null;
      remote_campaign_id: string | null;
    }>(
      `SELECT c.external_campaign_id, c.name, c.effective_status, c.status,
              c.provider_created_at::text AS provider_created_at,
              (SELECT SUM(m.spend)::text FROM marketing_daily_metrics m
                WHERE m.app_id = c.app_id AND m.external_campaign_id = c.external_campaign_id)
                AS spend,
              NULL AS installs, NULL AS revenue,
              NULL AS remote_campaign_id
         FROM marketing_campaigns c
        WHERE c.organization_id = $1 AND c.app_id = $2
          AND c.name = (SELECT name FROM marketing_campaigns
                         WHERE app_id = $2 AND external_campaign_id = $3 LIMIT 1)
        ORDER BY c.external_campaign_id`,
      [organizationId, appId, mapping.source_external_id],
    );

    process.stdout.write('\n');
    line('AMBIGUOUS MAPPING ID:', mapping.source_external_id);
    line('MARKETING CAMPAIGN NAME:', mapping.source_name ?? source?.name ?? '(not stored)');
    line('CANDIDATES CONSIDERED:', candidates.length);
    let candidateIndex = 0;
    for (const candidate of candidates) {
      candidateIndex += 1;
      process.stdout.write(`  META CANDIDATE ${candidateIndex}:\n`);
      process.stdout.write(`    campaign id      ${candidate.external_campaign_id}\n`);
      process.stdout.write(`    exact name       ${candidate.name ?? '(not stored)'}\n`);
      process.stdout.write(`    status           ${candidate.status ?? '(not stored)'}\n`);
      process.stdout.write(
        `    effective_status ${candidate.effective_status ?? '(not stored)'}\n`,
      );
      process.stdout.write(
        `    created_time     ${candidate.provider_created_at ?? '(not stored)'}\n`,
      );
      process.stdout.write(`    spend (all time) ${candidate.spend ?? '0'}\n`);
    }

    // The discriminator that settles it, when the MMP published one.
    const declared = await queryRows<{
      external_campaign_id: string;
      name: string | null;
      remote_campaign_id: string;
    }>(
      `SELECT external_campaign_id, name, remote_campaign_id
         FROM attribution_campaigns
        WHERE organization_id = $1 AND app_id = $2 AND remote_campaign_id = ANY($3)`,
      [organizationId, appId, candidates.map((c) => c.external_campaign_id)],
    );
    line(
      'DETERMINISTIC DISCRIMINATOR:',
      declared.length > 0
        ? `remote_campaign_id published by the MMP for ${declared.length} of them`
        : 'none available - the MMP published no network campaign id',
    );
    for (const row of declared) {
      process.stdout.write(
        `    ${row.remote_campaign_id} <- ${row.name ?? row.external_campaign_id}\n`,
      );
    }
    line(
      'WHY AMBIGUOUS:',
      String(mapping.source_name ?? '') && candidates.length > 1
        ? `${candidates.length} marketing campaigns carry this exact name, so a name cannot say which one an attribution campaign belongs to`
        : 'more than one candidate matched and none could be preferred deterministically',
    );
    line(
      'RESOLUTION:',
      declared.length > 0
        ? 'Re-run reconciliation: the published network campaign id settles it without a human.'
        : 'Resolve by hand on the reconciliation screen. MART will not pick on spend, recency, or any other proxy.',
    );
  }

  // ------------------------------------------------ unmatched marketing ---
  const unmatchedMarketing = marketing.filter(
    (row) => !mappedMarketingIds.has(row.external_campaign_id),
  );
  heading(`UNMATCHED MARKETING CAMPAIGNS (${unmatchedMarketing.length})`);
  for (const row of unmatchedMarketing) {
    const key = nameKey(row.name);
    const named = attribution.filter((a) =>
      key ? attributionNameKeys(a.campaign_name).includes(key) : false,
    );
    process.stdout.write('\n');
    line('META CAMPAIGN ID:', row.external_campaign_id);
    line('META CAMPAIGN NAME:', row.name ?? '(not stored)');
    line('META STATUS:', row.effective_status ?? '(not stored)');
    line('SPEND:', row.spend ?? '0');
    line('DATA WINDOW:', `${row.first_date ?? '?'} .. ${row.last_date ?? '?'}`);
    line(
      'ATTRIBUTION NAMING IT:',
      named.length > 0 ? named.map((a) => a.campaign_name).join(' | ') : 'none',
    );
    line(
      'REASON:',
      named.length > 0
        ? 'named by attribution but left unmapped - re-run reconciliation'
        : Number(row.spend ?? 0) === 0
          ? 'no spend and no attribution names it: nothing to reconcile'
          : 'spend exists but no attribution campaign names this campaign - the MMP attributed no installs to it, or it belongs to another app',
    );
  }

  heading('SUMMARY');
  line('Organic (not applicable)', organic.length);
  line('Unmatched attribution campaigns', unmatchedPaid.length);
  line('Unmatched marketing campaigns', unmatchedMarketing.length);
  line('Missing Meta structure', missingStructure);
  line(
    'Safe new matches available',
    // A safe new match is one whose embedded name equals exactly one stored
    // Meta campaign: matching it needs no new heuristic, only a re-run.
    unmatchedPaid.filter((row) => {
      const candidate = embeddedNames(row.campaign_name)[0];
      const key = candidate ? nameKey(candidate) : null;
      return key ? (marketingByKey.get(key) ?? []).length === 1 : false;
    }).length,
  );
}

main()
  .catch((error: unknown) => {
    process.stderr.write(
      `reconcile-audit failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  })
  .finally(() => closePool());

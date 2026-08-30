/**
 * Provider connection diagnostic.
 *
 *   node packages/integrations/dist/cli/diagnose.js <provider_key> [organization_id]
 *
 * Decrypts the credential MART already stored, makes the real validation and
 * discovery calls, and prints what happened: the endpoint, whether the request
 * was authenticated, the HTTP status, the classified error, and the accounts
 * that came back.
 *
 * It never prints the credential. The only thing shown about it is its
 * fingerprint, its length, and whether an Authorization header was attached -
 * enough to tell "no credential" from "credential rejected" without revealing
 * one.
 */
import { getConfig } from '@mart/config';
import { closePool, queryRows } from '@mart/db';
import { isProviderError, type CanonicalAttributionBatch, type IsoDate } from '@mart/shared';
import { getCredentialStore } from '../credentials.js';
import { computeFreshnessStatus } from '../sync/freshness.js';
import {
  normalizeGroupBy,
  selectSavedReport,
  TenjinAttributionProvider,
  TENJIN_INSTALL_METRIC,
  TENJIN_REVENUE_METRICS_ACCEPTED,
  type TenjinSavedReport,
} from '../providers/tenjin.js';
import {
  isAttributionProvider,
  isMarketingNetworkProvider,
  type AnyProvider,
  type ProviderAccount,
  type SyncResult,
} from '../types.js';
import { createProvider, getProviderDescriptor, providerEndpointInfo } from '../registry.js';

/** First report row of a raw JSON:API page, or null if the shape is different. */
function firstReportRow(payload: unknown): Record<string, unknown> | null {
  if (!payload || typeof payload !== 'object') return null;
  const data = (payload as Record<string, unknown>)['data'];
  const first = Array.isArray(data) ? data[0] : null;
  if (!first || typeof first !== 'object') return null;
  const attributes = (first as Record<string, unknown>)['attributes'];
  if (attributes && typeof attributes === 'object') return attributes as Record<string, unknown>;
  return first as Record<string, unknown>;
}

/**
 * Field names are always safe to print; values are not. Anything key-shaped is
 * dropped rather than truncated, so a sample row can never carry a secret.
 */
function sanitizeRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (/(key|secret|token|password|credential|signature|salt|hash)/i.test(key)) {
      out[key] = '[omitted]';
    } else if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
      out[key] = value;
    } else {
      out[key] = `[${typeof value}]`;
    }
  }
  return out;
}

/** Narrow to the Tenjin adapter, which alone has saved reports. */
function isTenjinProvider(provider: AnyProvider): provider is TenjinAttributionProvider {
  return provider instanceof TenjinAttributionProvider;
}

function line(label: string, value: unknown): void {
  process.stdout.write(`${label.padEnd(22)} ${String(value)}\n`);
}

function heading(text: string): void {
  process.stdout.write(`\n=== ${text} ===\n`);
}

async function main(): Promise<void> {
  const providerKey = process.argv[2];
  // Optional second argument: a sync stream to exercise instead of discovery.
  const streamArg = process.argv[3];
  const stream = STREAMS.includes(streamArg as Stream) ? (streamArg as Stream) : null;
  const organizationId = stream ? process.argv[4] : process.argv[3];
  if (!providerKey) {
    process.stderr.write(
      'usage: diagnose <provider_key> [stream] [organization_id]\n' +
        '  e.g. diagnose meta_ads\n' +
        '       diagnose tenjin attribution_installs\n' +
        '       diagnose tenjin attribution_revenue\n',
    );
    process.exitCode = 2;
    return;
  }

  const descriptor = getProviderDescriptor(providerKey);
  const endpoint = providerEndpointInfo(providerKey);

  heading('MODE');
  line('provider', descriptor.providerKey);
  line('configured base URL', endpoint?.configuredBaseUrl ?? '(unknown)');
  line('real provider URL', endpoint?.productionBaseUrl ?? '(unknown)');
  line('mode', endpoint?.isProduction ? 'REAL PROVIDER' : 'FIXTURE PROVIDER');
  if (providerKey === 'meta_ads') line('api version', getConfig().META_GRAPH_API_VERSION);
  if (endpoint && !endpoint.isProduction) {
    process.stdout.write(
      '\nThis provider is NOT pointed at the real API, so nothing below says\n' +
        'anything about your real credential. Set the base URL and restart first.\n',
    );
  }

  // Find the stored connection for this provider.
  const rows = await queryRows<{ id: string; organization_id: string; status: string }>(
    `SELECT id, organization_id, status FROM integration_connections
     WHERE provider_key = $1 ${organizationId ? 'AND organization_id = $2' : ''}
       AND status <> 'disconnected'
     ORDER BY created_at DESC LIMIT 1`,
    organizationId ? [providerKey, organizationId] : [providerKey],
  );
  const connection = rows[0];

  heading('STORED CREDENTIAL');
  if (!connection) {
    line('connection', 'none found - connect the provider in the UI first');
    return;
  }
  line('connection id', connection.id);
  line('stored status', connection.status);

  const store = getCredentialStore();
  const metadata = await store.metadata(connection.id);
  line('credential', metadata ? `present, fingerprint ${metadata.fingerprint}` : 'MISSING');
  if (!metadata) return;

  const credentials = await store.get({
    organizationId: connection.organization_id,
    connectionId: connection.id,
  });
  if (!credentials) {
    line('decrypt', 'FAILED - the credential key does not match the stored ciphertext');
    return;
  }
  // Length only. Never the value.
  const secret = Object.values(credentials).find(
    (v): v is string => typeof v === 'string' && v.length > 8,
  );
  line('decrypt', `ok (secret length ${secret ? secret.length : 0} characters)`);

  const provider = createProvider({ providerKey, credentials });

  heading('VALIDATE CONNECTION');
  const health = await provider.validateConnection();
  line('ok', health.ok);
  line('status', health.status);
  line('errorClass', health.errorClass ?? '(none)');
  line('message', health.message);
  if (health.details) line('details', JSON.stringify(health.details));

  if (stream) {
    await diagnoseStream(provider, stream, connection.organization_id);
    return;
  }

  heading('ACCOUNT / APP DISCOVERY');
  try {
    // Narrowed with statements rather than a ternary: a conditional expression
    // does not narrow the union in both branches.
    let accounts: ProviderAccount[] = [];
    if (isMarketingNetworkProvider(provider)) {
      accounts = await provider.listAccounts();
    } else if (isAttributionProvider(provider)) {
      accounts = await provider.listApps();
    }
    line('accounts returned', accounts.length);
    for (const account of accounts) {
      const meta = account.metadata ?? {};
      const metaStr = (key: string): string => {
        const value = meta[key];
        return typeof value === 'string' && value.length > 0 ? value : '(not returned)';
      };
      const hasName = account.name !== account.externalAccountId;
      process.stdout.write('\n');
      process.stdout.write(
        `  ${providerKey === 'tenjin' ? 'TENJIN ID' : 'PROVIDER ID'}:              ${account.externalAccountId}\n`,
      );
      process.stdout.write(`  DETAIL REQUEST STATUS: ${metaStr('detailStatus')}\n`);
      process.stdout.write(
        `  NAME:                  ${hasName ? account.name : '(not returned)'}\n`,
      );
      process.stdout.write(`  PLATFORM:              ${metaStr('platform')}\n`);
      process.stdout.write(`  BUNDLE ID:             ${metaStr('bundleId')}\n`);
      process.stdout.write(`  STORE ID:              ${metaStr('storeId')}\n`);
      // Which response field each value came from, so the real contract can be
      // read off one run instead of guessed.
      const sources = meta['fieldSources'];
      if (sources && typeof sources === 'object') {
        process.stdout.write(`  from fields: ${JSON.stringify(sources)}\n`);
      }
      // Every other non-secret field the provider sent. This is how a missing
      // name is traced to the key it actually lives under.
      const raw = meta['raw'];
      if (raw && typeof raw === 'object') {
        const keys = Object.keys(raw as Record<string, unknown>);
        process.stdout.write(`  all fields returned: ${keys.join(', ') || '(none)'}\n`);
        process.stdout.write(`  values: ${JSON.stringify(raw)}\n`);
      }
    }
    if (accounts.length === 0) {
      process.stdout.write(
        '  (empty: either the token can see no accounts, or this provider has\n' +
          '   no listing endpoint - AppsFlyer does not have one.)\n',
      );
    }
    const fixtures = accounts.filter((a: ProviderAccount) => /FIXTURE/i.test(a.externalAccountId));
    if (fixtures.length > 0) {
      process.stdout.write(
        `\n  WARNING: ${fixtures.length} account id(s) contain "FIXTURE".\n` +
          '  This is synthetic data from the fixture server, not the real provider.\n',
      );
    }
  } catch (error) {
    if (isProviderError(error)) {
      line('errorClass', error.errorClass);
      line('http status', error.httpStatus ?? '(none)');
      line('message', error.userMessage);
      // context is already sanitized by the HTTP client.
      line('context', JSON.stringify(error.context ?? {}));
    } else {
      line('error', error instanceof Error ? error.message : String(error));
    }
  }
}

const STREAMS = ['attribution_installs', 'attribution_revenue', 'attribution_events'] as const;
type Stream = (typeof STREAMS)[number];

/**
 * Run one reporting stream against the real provider and show what happened.
 *
 * Tenjin reporting is addressed by saved report UUID, so the interesting part
 * is usually the choice of report rather than the request: which saved reports
 * the account has, which one MART picked, and - when it picked none - the exact
 * reason each was refused. All of that is printed, and none of it includes the
 * credential.
 */
async function diagnoseStream(
  provider: AnyProvider,
  stream: Stream,
  organizationId: string,
): Promise<void> {
  heading(`STREAM: ${stream}`);
  if (!isAttributionProvider(provider)) {
    line('error', 'this provider is not an attribution provider');
    return;
  }

  // The app this organization actually bound, so the diagnostic uses the same
  // identifier the sync does.
  const bindings = await queryRows<{
    external_account_id: string;
    timezone: string;
    default_currency: string;
  }>(
    `SELECT a.external_account_id, ap.timezone, ap.default_currency
       FROM integration_app_bindings b
       JOIN integration_accounts a ON a.id = b.integration_account_id
       JOIN apps ap ON ap.id = b.app_id
      WHERE b.organization_id = $1 AND b.status = 'active' AND b.role = 'primary_attribution'
      ORDER BY b.created_at DESC LIMIT 1`,
    [organizationId],
  );
  const binding = bindings[0];
  if (!binding) {
    line('error', 'no active primary attribution binding for this organization');
    return;
  }

  const to = new Date();
  const from = new Date(to.getTime() - 29 * 86400000);
  const window = { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };

  line('app identifier', binding.external_account_id);
  line('date range', `${window.from} -> ${window.to}`);
  line('timezone', binding.timezone);
  line('currency', binding.default_currency);

  // Captured from the raw page so a normalization failure can be traced to the
  // field names the provider actually sent, rather than the ones MART expected.
  let firstRowFields: string[] | null = null;
  let firstRowSample: Record<string, unknown> | null = null;

  const params = {
    externalAccountId: binding.external_account_id,
    from: window.from as IsoDate,
    to: window.to as IsoDate,
    timezone: binding.timezone,
    currency: binding.default_currency,
    onRawPage: async (page: { payload: unknown }): Promise<void> => {
      if (firstRowFields) return;
      const row = firstReportRow(page.payload);
      if (!row) return;
      firstRowFields = Object.keys(row);
      firstRowSample = sanitizeRow(row);
    },
  };

  // Saved report discovery, printed whatever the outcome. This is the part the
  // operator can act on: MART reads their reports and never creates one.
  if (isTenjinProvider(provider) && stream !== 'attribution_events') {
    await reportSavedReports(provider, binding.external_account_id, stream);
  }

  try {
    let result: SyncResult<CanonicalAttributionBatch>;
    if (stream === 'attribution_installs') result = await provider.syncInstalls(params);
    else if (stream === 'attribution_revenue') result = await provider.syncRevenue(params);
    else result = await provider.syncEvents(params);

    process.stdout.write('\n');
    line('REPORT REQUEST', `${stream} over ${window.from}..${window.to}`);
    line(
      'HTTP STATUS',
      result.support && result.support !== 'supported' ? 'no request made' : '200',
    );
    line('ROWS FETCHED', result.rowsFetched);
    line(
      'ROWS NORMALIZED',
      result.batch.installs.length + result.batch.revenue.length + result.batch.events.length,
    );
    line('ROWS REJECTED', result.rowsRejected);
    line('PAGES FETCHED', result.pagesFetched);
    line('LATEST DATA DATE', result.latestDataDate ?? '(none)');
    line('STREAM SUPPORT', result.support ?? 'supported');
    // A stream MART never fetched must not be recorded as fresh.
    line(
      'FRESHNESS WOULD BE',
      computeFreshnessStatus({
        lastSuccessAt: new Date(),
        latestProviderDataDate: result.latestDataDate,
        expectedFreshnessMinutes: 360,
        ...(result.support ? { support: result.support } : {}),
      }),
    );
    line('ERROR', '(none)');
    if (firstRowFields) line('FIRST ROW FIELD NAMES', (firstRowFields as string[]).join(', '));
    for (const warning of result.warnings) line('warning', warning);

    const normalized =
      result.batch.installs.length + result.batch.revenue.length + result.batch.events.length;
    if (result.rowsFetched > 0 && normalized === 0) {
      line(
        'NORMALIZATION ERROR',
        'rows arrived but none normalized - the field names above do not match what the parser reads',
      );
      if (firstRowSample) line('first row (sanitized)', JSON.stringify(firstRowSample));
    } else if (result.rowsRejected > 0) {
      line(
        'NORMALIZATION ERROR',
        `${result.rowsRejected} row(s) not imported - see warnings above`,
      );
    }

    const sample = result.batch.installs[0] ?? result.batch.revenue[0] ?? result.batch.events[0];
    if (sample) {
      process.stdout.write(`\n  sample normalized row: ${JSON.stringify(sample)}\n`);
    } else if (result.rowsFetched > 0) {
      process.stdout.write(
        '\n  rows arrived but none normalized - the response shape does not match the parser.\n',
      );
    }
  } catch (error) {
    process.stdout.write('\n');
    if (isProviderError(error)) {
      line('HTTP STATUS', error.httpStatus ?? '(no response)');
      line('ROWS FETCHED', 0);
      line('ROWS NORMALIZED', 0);
      if (firstRowFields) line('FIRST ROW FIELD NAMES', (firstRowFields as string[]).join(', '));
      line('ERROR', `${error.errorClass}: ${error.userMessage}`);
      // Already sanitized by the HTTP client: URL without secrets, truncated body.
      line('sanitized response', JSON.stringify(error.context ?? {}));
      if (error.errorClass === 'configuration_required') {
        process.stdout.write(
          '\n  MART did not create anything in Tenjin. Create the saved report described\n' +
            "  above in Tenjin's Data Exporter, then re-run this command.\n",
        );
      }
    } else {
      line('ERROR', error instanceof Error ? error.message : String(error));
    }
  }
}

/** Print every saved report and MART's verdict on each, without guessing. */
async function reportSavedReports(
  provider: TenjinAttributionProvider,
  appId: string,
  stream: Stream,
): Promise<void> {
  heading('SAVED REPORTS');
  let reports: TenjinSavedReport[];
  try {
    reports = await provider.listSavedReports();
  } catch (error) {
    line(
      'discovery failed',
      isProviderError(error) ? `${error.errorClass}: ${error.userMessage}` : String(error),
    );
    return;
  }

  line('SAVED REPORTS DISCOVERED', reports.length);
  const requirement =
    stream === 'attribution_revenue'
      ? { appId, requiredMetrics: [], anyOfMetrics: TENJIN_REVENUE_METRICS_ACCEPTED }
      : { appId, requiredMetrics: [TENJIN_INSTALL_METRIC] };

  const { chosen, evaluated } = selectSavedReport(reports, requirement);

  for (const candidate of evaluated) {
    const report = candidate.report;
    process.stdout.write('\n');
    process.stdout.write(`  SAVED REPORT ID:  ${report.id}\n`);
    process.stdout.write(`  REPORT NAME:      ${report.name ?? '(not returned)'}\n`);
    process.stdout.write(`  REPORT TYPE:      ${report.reportType ?? '(not returned)'}\n`);
    process.stdout.write(
      `  APP IDS:          ${report.appIds.length ? report.appIds.join(', ') : '(all apps)'}\n`,
    );
    process.stdout.write(
      `  METRICS:          ${report.metrics.length ? report.metrics.join(', ') : '(none)'}\n`,
    );
    process.stdout.write(`  GRANULARITY:      ${report.granularity ?? '(not returned)'}\n`);
    process.stdout.write(`  GROUP BY:         ${report.groupBy ?? '(not returned)'}\n`);
    process.stdout.write(
      `  GROUP BY MEANS:   ${candidate.groupBy ? candidate.groupBy.dimensions.join(' + ') || '(nothing)' : '(not returned)'}\n`,
    );
    process.stdout.write(`  PAST NUMBER DAYS: ${report.pastNumberDays ?? '(not returned)'}\n`);
    process.stdout.write(
      `  CHANNEL IDS:      ${report.channelIds.length ? report.channelIds.join(', ') : '(all)'}\n`,
    );
    process.stdout.write(`  USABLE:           ${candidate.usable ? 'yes' : 'no'}\n`);
    if (!candidate.usable) {
      process.stdout.write(`  WHY NOT:          ${candidate.blockers.join('; ')}\n`);
    }
    // Notes qualify a report MART would use; on a refused one the blockers
    // above are the whole story.
    if (candidate.usable) {
      for (const note of candidate.notes) process.stdout.write(`  note:             ${note}\n`);
    }
  }

  process.stdout.write('\n');
  heading('CANDIDATE REPORT');
  if (!chosen) {
    line('chosen', 'none - MART will ask for one rather than create it');
    return;
  }
  line('SAVED REPORT ID', chosen.id);
  line('REPORT NAME', chosen.name ?? '(not returned)');
  line('REPORT TYPE', chosen.reportType ?? '(not returned)');
  line('APP IDS', chosen.appIds.length ? chosen.appIds.join(', ') : '(all apps)');
  line('METRICS', chosen.metrics.join(', '));
  line('GRANULARITY', chosen.granularity ?? '(not returned)');
  line('GROUP BY', chosen.groupBy ?? '(not returned)');
  // The provider's spelling and what MART made of it, side by side: this is
  // where a grouping mismatch shows itself.
  line('GROUP BY MEANS', normalizeGroupBy(chosen.groupBy)?.dimensions.join(' + ') ?? '(none)');
  line('USABLE', 'yes');
}

main()
  .catch((error: unknown) => {
    process.stderr.write(
      `diagnose failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  })
  .finally(() => closePool());

/**
 * Meta insights query-shape probe.
 *
 *   node packages/integrations/dist/cli/meta-insights-probe.js <connection_id> <external_account_id>
 *
 * Asks the REAL account, with the credential MART already stores, which
 * breakdown sets its insights endpoint will serve - country with device, device
 * alone, country alone, none - and prints for each: the HTTP status, Meta's own
 * error code, subcode, type and message, and the class MART assigns.
 *
 * It exists because a rejected query was being reported as a rejected
 * credential. Reading MART's classification beside Meta's actual words is how
 * that is proven right or wrong, and this prints both. The token is decrypted
 * to make the requests and never printed; nothing here writes anything.
 */
import { closePool, queryRows } from '@mart/db';
import { getCredentialStore } from '../credentials.js';
import { createProvider } from '../registry.js';
import { MetaAdsProvider } from '../providers/meta.js';

const VARIANTS: ReadonlyArray<{ label: string; breakdowns: readonly string[] }> = [
  { label: 'country + impression_device', breakdowns: ['country', 'impression_device'] },
  { label: 'impression_device only', breakdowns: ['impression_device'] },
  { label: 'country only', breakdowns: ['country'] },
  { label: 'no breakdown', breakdowns: [] },
];

function line(label: string, value: unknown): void {
  process.stdout.write(`  ${label.padEnd(18)} ${String(value)}\n`);
}

async function main(): Promise<void> {
  const [connectionId, externalAccountId] = process.argv.slice(2);
  if (!connectionId || !externalAccountId) {
    process.stderr.write(
      'usage: meta-insights-probe <connection_id> <external_account_id>\n' +
        '  e.g. meta-insights-probe 0d3f... act_1234567890\n',
    );
    process.exitCode = 2;
    return;
  }

  const connection = await queryRows<{ organization_id: string; provider_key: string }>(
    `SELECT organization_id, provider_key FROM integration_connections WHERE id = $1`,
    [connectionId],
  );
  const row = connection[0];
  if (!row) {
    process.stderr.write('No such connection.\n');
    process.exitCode = 2;
    return;
  }
  if (row.provider_key !== 'meta_ads') {
    process.stderr.write(`Connection is ${row.provider_key}, not meta_ads.\n`);
    process.exitCode = 2;
    return;
  }

  const credentials = await getCredentialStore().get({
    organizationId: row.organization_id,
    connectionId,
  });
  if (!credentials) {
    process.stderr.write('No credential is stored for this connection.\n');
    process.exitCode = 2;
    return;
  }
  const provider = createProvider({ providerKey: 'meta_ads', credentials });
  if (!(provider instanceof MetaAdsProvider)) {
    process.stderr.write('Provider factory did not return the Meta adapter.\n');
    process.exitCode = 2;
    return;
  }

  process.stdout.write(`\nMeta insights probe  account=${externalAccountId}\n`);
  process.stdout.write(
    'Token decrypted from MART storage and attached as a Bearer header; not printed.\n',
  );

  let anyAuthFailure = false;
  for (const variant of VARIANTS) {
    process.stdout.write(`\n=== ${variant.label} ===\n`);
    const result = await provider.probeInsightsBreakdowns(externalAccountId, variant.breakdowns);
    if (result.ok) {
      line('result', `OK - ${result.rows} row(s) for today`);
      continue;
    }
    line('result', 'REFUSED');
    line('http status', result.httpStatus ?? '(none)');
    line('meta code', result.graph?.code ?? '(unparsed)');
    line('meta subcode', result.graph?.subcode ?? '-');
    line('meta type', result.graph?.type ?? '-');
    line('meta message', result.graph?.message ?? '-');
    line('MART class', result.errorClass);
    if (
      result.errorClass === 'authentication_error' ||
      result.errorClass === 'expired_credential'
    ) {
      anyAuthFailure = true;
    }
  }

  process.stdout.write('\n=== VERDICT ===\n');
  if (anyAuthFailure) {
    line('credential', 'Meta rejected the token on at least one request (code 190/102).');
  } else {
    line(
      'credential',
      'No request was rejected for the token. Any refusal above is a query-shape verdict, not a credential one.',
    );
  }
}

main()
  .catch((error: unknown) => {
    const parts: string[] = [];
    let current: unknown = error;
    for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
      parts.push(current.message);
      current = current.cause;
    }
    process.stderr.write(`meta-insights-probe failed: ${parts.join(' <- ') || String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(() => closePool());

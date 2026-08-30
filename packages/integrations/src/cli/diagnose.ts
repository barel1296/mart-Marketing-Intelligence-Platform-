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
import { isProviderError } from '@mart/shared';
import { getCredentialStore } from '../credentials.js';
import {
  isAttributionProvider,
  isMarketingNetworkProvider,
  type ProviderAccount,
} from '../types.js';
import { createProvider, getProviderDescriptor, providerEndpointInfo } from '../registry.js';

function line(label: string, value: unknown): void {
  process.stdout.write(`${label.padEnd(22)} ${String(value)}\n`);
}

function heading(text: string): void {
  process.stdout.write(`\n=== ${text} ===\n`);
}

async function main(): Promise<void> {
  const providerKey = process.argv[2];
  const organizationId = process.argv[3];
  if (!providerKey) {
    process.stderr.write(
      'usage: diagnose <provider_key> [organization_id]\n  e.g. diagnose meta_ads\n',
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
      process.stdout.write(
        `  - ${account.externalAccountId}  ${account.name}` +
          `${account.currency ? `  ${account.currency}` : ''}\n`,
      );
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

main()
  .catch((error: unknown) => {
    process.stderr.write(
      `diagnose failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  })
  .finally(() => closePool());

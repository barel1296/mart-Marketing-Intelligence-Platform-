import type { ConnectionStatus, ProviderCategory, ProviderKey } from '@mart/shared';
import { AppError } from '@mart/shared';
import { query, queryOne, queryRows, type Queryable } from '../pool.js';

export type ProviderRow = {
  provider_key: ProviderKey;
  category: ProviderCategory;
  display_name: string;
  status: 'available' | 'planned';
  auth_kind: string;
  sort_order: number;
};

export async function listProviders(client?: Queryable): Promise<ProviderRow[]> {
  return queryRows<ProviderRow>(
    `SELECT provider_key, category, display_name, status, auth_kind, sort_order
     FROM integration_providers
     ORDER BY category, sort_order, display_name`,
    [],
    client,
  );
}

export async function findProvider(
  providerKey: string,
  client?: Queryable,
): Promise<ProviderRow | null> {
  return queryOne<ProviderRow>(
    `SELECT provider_key, category, display_name, status, auth_kind, sort_order
     FROM integration_providers WHERE provider_key = $1`,
    [providerKey],
    client,
  );
}

// ------------------------------------------------------------ connections ---
export type ConnectionRow = {
  id: string;
  organization_id: string;
  provider_key: ProviderKey;
  category: ProviderCategory;
  display_name: string;
  status: ConnectionStatus;
  last_validated_at: Date | null;
  last_validation_ok: boolean | null;
  last_validation_error_class: string | null;
  last_validation_message: string | null;
  disconnected_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

/**
 * Note the columns this never selects: credentials live in a separate table
 * that only the credential store reads, so no generic connection query can
 * accidentally serialize a secret into an API response.
 */
const CONNECTION_COLUMNS = `id, organization_id, provider_key, category, display_name, status,
  last_validated_at, last_validation_ok, last_validation_error_class, last_validation_message,
  disconnected_at, created_at, updated_at`;

export async function createConnection(
  input: {
    organizationId: string;
    providerKey: string;
    category: ProviderCategory;
    displayName: string;
    createdByUserId: string;
  },
  client?: Queryable,
): Promise<ConnectionRow> {
  const row = await queryOne<ConnectionRow>(
    `INSERT INTO integration_connections
       (organization_id, provider_key, category, display_name, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING ${CONNECTION_COLUMNS}`,
    [
      input.organizationId,
      input.providerKey,
      input.category,
      input.displayName,
      input.createdByUserId,
    ],
    client,
  );
  if (!row) throw new AppError('internal_error', 'Failed to create connection');
  return row;
}

export async function findConnection(
  organizationId: string,
  connectionId: string,
  client?: Queryable,
): Promise<ConnectionRow | null> {
  return queryOne<ConnectionRow>(
    `SELECT ${CONNECTION_COLUMNS} FROM integration_connections
     WHERE organization_id = $1 AND id = $2`,
    [organizationId, connectionId],
    client,
  );
}

export async function listConnections(
  organizationId: string,
  filter: { category?: ProviderCategory; includeDisconnected?: boolean } = {},
  client?: Queryable,
): Promise<ConnectionRow[]> {
  const params: unknown[] = [organizationId];
  let sql = `SELECT ${CONNECTION_COLUMNS} FROM integration_connections WHERE organization_id = $1`;
  if (filter.category) {
    params.push(filter.category);
    sql += ` AND category = $${params.length}`;
  }
  if (!filter.includeDisconnected) sql += " AND status <> 'disconnected'";
  sql += ' ORDER BY created_at ASC';
  return queryRows<ConnectionRow>(sql, params, client);
}

export async function updateConnectionStatus(
  connectionId: string,
  patch: {
    status?: ConnectionStatus;
    lastValidatedAt?: Date | null;
    lastValidationOk?: boolean | null;
    lastValidationErrorClass?: string | null;
    lastValidationMessage?: string | null;
    disconnectedAt?: Date | null;
  },
  client?: Queryable,
): Promise<void> {
  const sets: string[] = [];
  const params: unknown[] = [connectionId];
  const push = (column: string, value: unknown): void => {
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  };
  if (patch.status !== undefined) push('status', patch.status);
  if (patch.lastValidatedAt !== undefined) push('last_validated_at', patch.lastValidatedAt);
  if (patch.lastValidationOk !== undefined) push('last_validation_ok', patch.lastValidationOk);
  if (patch.lastValidationErrorClass !== undefined) {
    push('last_validation_error_class', patch.lastValidationErrorClass);
  }
  if (patch.lastValidationMessage !== undefined) {
    push('last_validation_message', patch.lastValidationMessage);
  }
  if (patch.disconnectedAt !== undefined) push('disconnected_at', patch.disconnectedAt);
  if (sets.length === 0) return;
  await query(
    `UPDATE integration_connections SET ${sets.join(', ')} WHERE id = $1`,
    params,
    client,
  );
}

// --------------------------------------------------------------- accounts ---
export type IntegrationAccountRow = {
  id: string;
  organization_id: string;
  connection_id: string;
  external_account_id: string;
  name: string;
  account_type: 'ad_account' | 'mmp_app';
  currency: string | null;
  timezone: string | null;
  status: string | null;
  metadata: Record<string, unknown>;
  discovered_at: Date;
};

const ACCOUNT_COLUMNS = `id, organization_id, connection_id, external_account_id, name,
  account_type, currency, timezone, status, metadata, discovered_at`;

export async function upsertAccounts(
  organizationId: string,
  connectionId: string,
  accounts: ReadonlyArray<{
    externalAccountId: string;
    name: string;
    accountType: 'ad_account' | 'mmp_app';
    currency?: string | null;
    timezone?: string | null;
    status?: string | null;
    metadata?: Record<string, unknown>;
  }>,
  client?: Queryable,
): Promise<IntegrationAccountRow[]> {
  const out: IntegrationAccountRow[] = [];
  for (const account of accounts) {
    const row = await queryOne<IntegrationAccountRow>(
      `INSERT INTO integration_accounts
         (organization_id, connection_id, external_account_id, name, account_type, currency, timezone, status, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (connection_id, external_account_id) DO UPDATE SET
         name = EXCLUDED.name,
         account_type = EXCLUDED.account_type,
         currency = EXCLUDED.currency,
         timezone = EXCLUDED.timezone,
         status = EXCLUDED.status,
         metadata = EXCLUDED.metadata
       RETURNING ${ACCOUNT_COLUMNS}`,
      [
        organizationId,
        connectionId,
        account.externalAccountId,
        account.name,
        account.accountType,
        account.currency ?? null,
        account.timezone ?? null,
        account.status ?? null,
        JSON.stringify(account.metadata ?? {}),
      ],
      client,
    );
    if (row) out.push(row);
  }
  return out;
}

export async function listAccounts(
  organizationId: string,
  connectionId: string,
  client?: Queryable,
): Promise<IntegrationAccountRow[]> {
  return queryRows<IntegrationAccountRow>(
    `SELECT ${ACCOUNT_COLUMNS} FROM integration_accounts
     WHERE organization_id = $1 AND connection_id = $2
     ORDER BY name ASC`,
    [organizationId, connectionId],
    client,
  );
}

export async function findAccount(
  organizationId: string,
  accountId: string,
  client?: Queryable,
): Promise<IntegrationAccountRow | null> {
  return queryOne<IntegrationAccountRow>(
    `SELECT ${ACCOUNT_COLUMNS} FROM integration_accounts WHERE organization_id = $1 AND id = $2`,
    [organizationId, accountId],
    client,
  );
}

// --------------------------------------------------------------- bindings ---
export type BindingRow = {
  id: string;
  organization_id: string;
  app_id: string;
  connection_id: string;
  integration_account_id: string | null;
  role: 'marketing_network' | 'primary_attribution';
  status: 'active' | 'inactive';
  created_at: Date;
};

const BINDING_COLUMNS = `id, organization_id, app_id, connection_id, integration_account_id, role, status, created_at`;

export async function deactivateBindings(
  appId: string,
  role: 'marketing_network' | 'primary_attribution',
  client?: Queryable,
): Promise<void> {
  await query(
    `UPDATE integration_app_bindings SET status = 'inactive'
     WHERE app_id = $1 AND role = $2 AND status = 'active'`,
    [appId, role],
    client,
  );
}

export async function createBinding(
  input: {
    organizationId: string;
    appId: string;
    connectionId: string;
    integrationAccountId: string | null;
    role: 'marketing_network' | 'primary_attribution';
    createdByUserId: string;
  },
  client?: Queryable,
): Promise<BindingRow> {
  const row = await queryOne<BindingRow>(
    `INSERT INTO integration_app_bindings
       (organization_id, app_id, connection_id, integration_account_id, role, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING ${BINDING_COLUMNS}`,
    [
      input.organizationId,
      input.appId,
      input.connectionId,
      input.integrationAccountId,
      input.role,
      input.createdByUserId,
    ],
    client,
  );
  if (!row) throw new AppError('internal_error', 'Failed to create binding');
  return row;
}

export type BindingWithConnection = BindingRow & {
  provider_key: ProviderKey;
  category: ProviderCategory;
  connection_status: ConnectionStatus;
  connection_display_name: string;
  external_account_id: string | null;
  account_name: string | null;
  account_currency: string | null;
};

export async function listAppBindings(
  organizationId: string,
  appId: string,
  options: { activeOnly?: boolean } = { activeOnly: true },
  client?: Queryable,
): Promise<BindingWithConnection[]> {
  const params: unknown[] = [organizationId, appId];
  let sql = `SELECT b.id, b.organization_id, b.app_id, b.connection_id, b.integration_account_id,
                    b.role, b.status, b.created_at,
                    c.provider_key, c.category, c.status AS connection_status,
                    c.display_name AS connection_display_name,
                    a.external_account_id, a.name AS account_name, a.currency AS account_currency
             FROM integration_app_bindings b
             JOIN integration_connections c ON c.id = b.connection_id
             LEFT JOIN integration_accounts a ON a.id = b.integration_account_id
             WHERE b.organization_id = $1 AND b.app_id = $2`;
  if (options.activeOnly !== false) sql += " AND b.status = 'active'";
  sql += ' ORDER BY b.role, b.created_at';
  return queryRows<BindingWithConnection>(sql, params, client);
}

// ----------------------------------------------------------- capabilities ---
export type CapabilityRow = {
  capability_key: string;
  supported: boolean;
  discovery_method: string;
  detail: Record<string, unknown>;
  discovered_at: Date;
};

export async function replaceCapabilities(
  input: {
    organizationId: string;
    connectionId: string;
    integrationAccountId: string | null;
    capabilities: ReadonlyArray<{
      key: string;
      supported: boolean;
      discoveryMethod: 'declared' | 'probed' | 'inferred' | 'manual';
      detail?: Record<string, unknown>;
    }>;
  },
  client?: Queryable,
): Promise<void> {
  for (const capability of input.capabilities) {
    await query(
      `INSERT INTO provider_capabilities
         (organization_id, connection_id, integration_account_id, capability_key, supported, discovery_method, detail, discovered_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now())
       ON CONFLICT (connection_id, COALESCE(integration_account_id, '00000000-0000-0000-0000-000000000000'::uuid), capability_key)
       DO UPDATE SET supported = EXCLUDED.supported,
                     discovery_method = EXCLUDED.discovery_method,
                     detail = EXCLUDED.detail,
                     discovered_at = now()`,
      [
        input.organizationId,
        input.connectionId,
        input.integrationAccountId,
        capability.key,
        capability.supported,
        capability.discoveryMethod,
        JSON.stringify(capability.detail ?? {}),
      ],
      client,
    );
  }
}

export async function listCapabilities(
  connectionId: string,
  integrationAccountId: string | null,
  client?: Queryable,
): Promise<CapabilityRow[]> {
  // One row per capability. An account-scoped row was probed against the actual
  // account and outranks the connection-level declaration, which is only a claim
  // about the provider in general.
  return queryRows<CapabilityRow>(
    `SELECT DISTINCT ON (capability_key)
       capability_key, supported, discovery_method, detail, discovered_at
     FROM provider_capabilities
     WHERE connection_id = $1
       AND (integration_account_id IS NOT DISTINCT FROM $2 OR integration_account_id IS NULL)
     ORDER BY capability_key, (integration_account_id IS NOT NULL) DESC, discovered_at DESC`,
    [connectionId, integrationAccountId],
    client,
  );
}

import type { AppPlatform, AttributionProviderKey, OrganizationRole } from '@mart/shared';
import { AppError } from '@mart/shared';
import { query, queryOne, queryRows, type Queryable } from '../pool.js';

// ------------------------------------------------------------------ users ---
export type UserRow = {
  id: string;
  email: string;
  display_name: string;
  status: string;
  created_at: Date;
  last_login_at: Date | null;
};

export type UserWithSecretRow = UserRow & { password_hash: string; password_algo: string };

const USER_PUBLIC_COLUMNS = 'id, email, display_name, status, created_at, last_login_at';

export async function createUser(
  input: { email: string; passwordHash: string; displayName: string },
  client?: Queryable,
): Promise<UserRow> {
  const row = await queryOne<UserRow>(
    `INSERT INTO users (email, password_hash, display_name)
     VALUES (lower($1), $2, $3)
     RETURNING ${USER_PUBLIC_COLUMNS}`,
    [input.email.trim(), input.passwordHash, input.displayName.trim()],
    client,
  );
  if (!row) throw new AppError('internal_error', 'Failed to create user');
  return row;
}

/** Only the authentication path may read the password hash. */
export async function findUserForAuthentication(
  email: string,
  client?: Queryable,
): Promise<UserWithSecretRow | null> {
  return queryOne<UserWithSecretRow>(
    `SELECT ${USER_PUBLIC_COLUMNS}, password_hash, password_algo
     FROM users WHERE email = lower($1) AND status = 'active'`,
    [email.trim()],
    client,
  );
}

export async function findUserById(id: string, client?: Queryable): Promise<UserRow | null> {
  return queryOne<UserRow>(`SELECT ${USER_PUBLIC_COLUMNS} FROM users WHERE id = $1`, [id], client);
}

export async function markUserLogin(id: string, client?: Queryable): Promise<void> {
  await query('UPDATE users SET last_login_at = now() WHERE id = $1', [id], client);
}

// --------------------------------------------------------------- sessions ---
export type SessionRow = {
  id: string;
  user_id: string;
  expires_at: Date;
  revoked_at: Date | null;
  csrf_token_hash: string;
};

export async function createSession(
  input: {
    userId: string;
    tokenHash: string;
    csrfTokenHash: string;
    expiresAt: Date;
    ipAddress?: string | null;
    userAgent?: string | null;
  },
  client?: Queryable,
): Promise<SessionRow> {
  const row = await queryOne<SessionRow>(
    `INSERT INTO sessions (user_id, token_hash, csrf_token_hash, expires_at, ip_address, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, user_id, expires_at, revoked_at, csrf_token_hash`,
    [
      input.userId,
      input.tokenHash,
      input.csrfTokenHash,
      input.expiresAt,
      input.ipAddress ?? null,
      input.userAgent ?? null,
    ],
    client,
  );
  if (!row) throw new AppError('internal_error', 'Failed to create session');
  return row;
}

export type SessionWithUser = SessionRow & {
  email: string;
  display_name: string;
  user_status: string;
};

export async function findSessionByTokenHash(
  tokenHash: string,
  client?: Queryable,
): Promise<SessionWithUser | null> {
  return queryOne<SessionWithUser>(
    `SELECT s.id, s.user_id, s.expires_at, s.revoked_at, s.csrf_token_hash,
            u.email, u.display_name, u.status AS user_status
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1`,
    [tokenHash],
    client,
  );
}

export async function touchSession(id: string, client?: Queryable): Promise<void> {
  await query('UPDATE sessions SET last_seen_at = now() WHERE id = $1', [id], client);
}

export async function revokeSession(tokenHash: string, client?: Queryable): Promise<void> {
  await query(
    'UPDATE sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL',
    [tokenHash],
    client,
  );
}

export async function deleteExpiredSessions(client?: Queryable): Promise<number> {
  const result = await query(
    "DELETE FROM sessions WHERE expires_at < now() - interval '7 days'",
    [],
    client,
  );
  return result.rowCount ?? 0;
}

// ---------------------------------------------------------- organizations ---
export type OrganizationRow = {
  id: string;
  name: string;
  slug: string;
  created_at: Date;
};

export type MembershipRow = {
  organization_id: string;
  user_id: string;
  role: OrganizationRole;
};

export async function createOrganization(
  input: { name: string; slug: string; createdBy: string },
  client?: Queryable,
): Promise<OrganizationRow> {
  const row = await queryOne<OrganizationRow>(
    `INSERT INTO organizations (name, slug, created_by)
     VALUES ($1, $2, $3)
     RETURNING id, name, slug, created_at`,
    [input.name.trim(), input.slug, input.createdBy],
    client,
  );
  if (!row) throw new AppError('internal_error', 'Failed to create organization');
  return row;
}

export async function addMembership(
  input: { organizationId: string; userId: string; role: OrganizationRole },
  client?: Queryable,
): Promise<MembershipRow> {
  const row = await queryOne<MembershipRow>(
    `INSERT INTO organization_memberships (organization_id, user_id, role)
     VALUES ($1, $2, $3)
     ON CONFLICT (organization_id, user_id) DO UPDATE SET role = EXCLUDED.role
     RETURNING organization_id, user_id, role`,
    [input.organizationId, input.userId, input.role],
    client,
  );
  if (!row) throw new AppError('internal_error', 'Failed to add membership');
  return row;
}

/**
 * The single source of truth for "may this user act in this organization".
 * Every tenant-scoped request resolves membership here; the browser-supplied
 * organization id is never trusted on its own.
 */
export async function findMembership(
  organizationId: string,
  userId: string,
  client?: Queryable,
): Promise<MembershipRow | null> {
  return queryOne<MembershipRow>(
    `SELECT organization_id, user_id, role
     FROM organization_memberships
     WHERE organization_id = $1 AND user_id = $2`,
    [organizationId, userId],
    client,
  );
}

export async function listOrganizationsForUser(
  userId: string,
  client?: Queryable,
): Promise<Array<OrganizationRow & { role: OrganizationRole }>> {
  return queryRows<OrganizationRow & { role: OrganizationRole }>(
    `SELECT o.id, o.name, o.slug, o.created_at, m.role
     FROM organizations o
     JOIN organization_memberships m ON m.organization_id = o.id
     WHERE m.user_id = $1
     ORDER BY o.created_at ASC`,
    [userId],
    client,
  );
}

export async function listMembers(
  organizationId: string,
  client?: Queryable,
): Promise<
  Array<{ user_id: string; email: string; display_name: string; role: OrganizationRole }>
> {
  return queryRows(
    `SELECT u.id AS user_id, u.email, u.display_name, m.role
     FROM organization_memberships m
     JOIN users u ON u.id = m.user_id
     WHERE m.organization_id = $1
     ORDER BY u.email ASC`,
    [organizationId],
    client,
  );
}

// ------------------------------------------------------------------- apps ---
export type AppRow = {
  id: string;
  organization_id: string;
  name: string;
  platform: AppPlatform;
  bundle_id: string;
  timezone: string;
  default_currency: string;
  primary_attribution_provider: AttributionProviderKey | null;
  status: string;
  created_at: Date;
  updated_at: Date;
};

const APP_COLUMNS =
  'id, organization_id, name, platform, bundle_id, timezone, default_currency, primary_attribution_provider, status, created_at, updated_at';

export async function createApp(
  input: {
    organizationId: string;
    name: string;
    platform: AppPlatform;
    bundleId: string;
    timezone?: string;
    defaultCurrency?: string;
  },
  client?: Queryable,
): Promise<AppRow> {
  const row = await queryOne<AppRow>(
    `INSERT INTO apps (organization_id, name, platform, bundle_id, timezone, default_currency)
     VALUES ($1, $2, $3, $4, COALESCE($5, 'UTC'), COALESCE($6, 'USD'))
     RETURNING ${APP_COLUMNS}`,
    [
      input.organizationId,
      input.name,
      input.platform,
      input.bundleId,
      input.timezone ?? null,
      input.defaultCurrency ?? null,
    ],
    client,
  );
  if (!row) throw new AppError('internal_error', 'Failed to create app');
  return row;
}

/** Always filtered by organization: an app id alone never grants access. */
export async function findApp(
  organizationId: string,
  appId: string,
  client?: Queryable,
): Promise<AppRow | null> {
  return queryOne<AppRow>(
    `SELECT ${APP_COLUMNS} FROM apps WHERE organization_id = $1 AND id = $2`,
    [organizationId, appId],
    client,
  );
}

export async function listApps(organizationId: string, client?: Queryable): Promise<AppRow[]> {
  return queryRows<AppRow>(
    `SELECT ${APP_COLUMNS} FROM apps WHERE organization_id = $1 ORDER BY created_at ASC`,
    [organizationId],
    client,
  );
}

export async function updateApp(
  organizationId: string,
  appId: string,
  patch: Partial<{
    name: string;
    timezone: string;
    defaultCurrency: string;
    primaryAttributionProvider: AttributionProviderKey | null;
    status: string;
  }>,
  client?: Queryable,
): Promise<AppRow | null> {
  const sets: string[] = [];
  const params: unknown[] = [organizationId, appId];
  const push = (column: string, value: unknown): void => {
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  };
  if (patch.name !== undefined) push('name', patch.name);
  if (patch.timezone !== undefined) push('timezone', patch.timezone);
  if (patch.defaultCurrency !== undefined) push('default_currency', patch.defaultCurrency);
  if (patch.primaryAttributionProvider !== undefined) {
    push('primary_attribution_provider', patch.primaryAttributionProvider);
  }
  if (patch.status !== undefined) push('status', patch.status);
  if (sets.length === 0) return findApp(organizationId, appId, client);

  return queryOne<AppRow>(
    `UPDATE apps SET ${sets.join(', ')}
     WHERE organization_id = $1 AND id = $2
     RETURNING ${APP_COLUMNS}`,
    params,
    client,
  );
}

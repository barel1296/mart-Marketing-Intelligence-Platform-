import { createHash, timingSafeEqual } from 'node:crypto';
import { AppError, newToken } from '@mart/shared';
import { getConfig } from '@mart/config';
import { tenancyRepo, type Queryable } from '@mart/db';

export type IssuedSession = {
  sessionId: string;
  /** Raw token: returned once, set as an HttpOnly cookie, never persisted. */
  token: string;
  /** Double-submit CSRF token: readable by the browser, echoed in a header. */
  csrfToken: string;
  expiresAt: Date;
};

export type AuthenticatedSession = {
  sessionId: string;
  userId: string;
  email: string;
  displayName: string;
  csrfTokenHash: string;
};

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function issueSession(
  input: { userId: string; ipAddress?: string | null; userAgent?: string | null },
  client?: Queryable,
): Promise<IssuedSession> {
  const config = getConfig();
  const token = newToken(32);
  const csrfToken = newToken(24);
  const expiresAt = new Date(Date.now() + config.SESSION_TTL_HOURS * 3600 * 1000);

  const session = await tenancyRepo.createSession(
    {
      userId: input.userId,
      tokenHash: hashToken(token),
      csrfTokenHash: hashToken(csrfToken),
      expiresAt,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
    },
    client,
  );

  return { sessionId: session.id, token, csrfToken, expiresAt };
}

/** Resolve a raw session token to an authenticated identity, or null. */
export async function resolveSession(
  token: string | undefined | null,
  client?: Queryable,
): Promise<AuthenticatedSession | null> {
  if (!token) return null;
  const row = await tenancyRepo.findSessionByTokenHash(hashToken(token), client);
  if (!row) return null;
  if (row.revoked_at) return null;
  if (row.expires_at.getTime() <= Date.now()) return null;
  if (row.user_status !== 'active') return null;
  return {
    sessionId: row.id,
    userId: row.user_id,
    email: row.email,
    displayName: row.display_name,
    csrfTokenHash: row.csrf_token_hash,
  };
}

export async function revokeSession(token: string, client?: Queryable): Promise<void> {
  await tenancyRepo.revokeSession(hashToken(token), client);
}

/**
 * Double-submit CSRF check.
 *
 * The cookie is SameSite=Lax and HttpOnly; state-changing requests must also
 * echo the CSRF token in a header, which a cross-site page cannot read.
 */
export function assertCsrf(session: AuthenticatedSession, headerToken: string | undefined): void {
  if (!headerToken) {
    throw new AppError('forbidden', 'Missing CSRF token');
  }
  const provided = Buffer.from(hashToken(headerToken));
  const expected = Buffer.from(session.csrfTokenHash);
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    throw new AppError('forbidden', 'Invalid CSRF token');
  }
}

export { hashToken as hashSessionToken };

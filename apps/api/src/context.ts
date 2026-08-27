import type { FastifyReply, FastifyRequest } from 'fastify';
import { AppError, type OrganizationRole } from '@mart/shared';
import { authorizeOrganization, authorizeApp, assertCsrf, type Permission } from '@mart/auth';
import type { AppRow } from '@mart/db';

declare module 'fastify' {
  interface FastifyRequest {
    session?: {
      sessionId: string;
      userId: string;
      email: string;
      displayName: string;
      csrfTokenHash: string;
    };
    requestId: string;
  }
}

export function requireSession(request: FastifyRequest): NonNullable<FastifyRequest['session']> {
  if (!request.session) {
    throw new AppError('unauthenticated', 'Sign in to continue');
  }
  return request.session;
}

/**
 * CSRF for cookie-authenticated mutations.
 *
 * The session cookie is HttpOnly and SameSite=Lax; a state-changing request
 * must additionally echo the CSRF token in a header, which cross-site script
 * cannot read.
 */
export function verifyCsrf(request: FastifyRequest): void {
  const method = request.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return;
  const session = requireSession(request);
  const header = request.headers['x-mart-csrf'];
  assertCsrf(session, typeof header === 'string' ? header : undefined);
}

export type RequestContext = {
  userId: string;
  organizationId: string;
  role: OrganizationRole;
  requestId: string;
};

/**
 * Resolve the tenant for a request.
 *
 * The organization id in the path is a claim, not a fact: membership is looked
 * up server-side and the required permission is asserted before anything else
 * runs.
 */
export async function withOrganization(
  request: FastifyRequest,
  organizationId: string,
  permission: Permission,
): Promise<RequestContext> {
  const session = requireSession(request);
  const context = await authorizeOrganization({
    userId: session.userId,
    organizationId,
    permission,
  });
  return { ...context, requestId: request.requestId };
}

export async function withApp(
  request: FastifyRequest,
  organizationId: string,
  appId: string,
  permission: Permission,
): Promise<{ context: RequestContext; app: AppRow }> {
  const context = await withOrganization(request, organizationId, permission);
  const app = await authorizeApp(context, appId);
  return { context, app };
}

export function setNoStore(reply: FastifyReply): void {
  reply.header('cache-control', 'no-store');
}

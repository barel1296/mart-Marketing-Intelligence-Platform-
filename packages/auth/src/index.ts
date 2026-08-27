export * from './password.js';
export * from './rbac.js';
export * from './sessions.js';

import { AppError, type OrganizationRole } from '@mart/shared';
import { tenancyRepo, type Queryable, type AppRow } from '@mart/db';
import { assertPermission, type Permission } from './rbac.js';

export type TenantContext = {
  userId: string;
  organizationId: string;
  role: OrganizationRole;
};

/**
 * Resolve and authorize a tenant context.
 *
 * This is the only sanctioned way to turn a browser-supplied organization id
 * into something the rest of the API may trust: membership is looked up server
 * side, and the required permission is asserted against the stored role.
 */
export async function authorizeOrganization(
  input: { userId: string; organizationId: string; permission: Permission },
  client?: Queryable,
): Promise<TenantContext> {
  const membership = await tenancyRepo.findMembership(input.organizationId, input.userId, client);
  // A non-member must not be able to distinguish "no access" from "no such
  // organization", so both produce the same 404.
  if (!membership) {
    throw new AppError('not_found', 'Organization not found');
  }
  assertPermission(membership.role, input.permission);
  return {
    userId: input.userId,
    organizationId: input.organizationId,
    role: membership.role,
  };
}

/** Authorize an app inside an already-authorized organization. */
export async function authorizeApp(
  context: TenantContext,
  appId: string,
  client?: Queryable,
): Promise<AppRow> {
  const app = await tenancyRepo.findApp(context.organizationId, appId, client);
  if (!app) throw new AppError('not_found', 'App not found');
  return app;
}

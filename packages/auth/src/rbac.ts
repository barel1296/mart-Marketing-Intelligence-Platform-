import type { OrganizationRole } from '@mart/shared';
import { AppError } from '@mart/shared';

/**
 * Permission catalogue.
 *
 * Authorization is always evaluated on the backend against the caller's
 * membership row. The browser may state which organization it wants to act in;
 * it can never state what role it has.
 */
export const PERMISSIONS = [
  'org:read',
  'org:manage_members',
  'org:manage_settings',
  'app:read',
  'app:create',
  'app:update',
  'integration:read',
  'integration:connect',
  'integration:disconnect',
  'integration:manage_credentials',
  'sync:read',
  'sync:trigger',
  'metrics:read',
  'mapping:read',
  'mapping:verify',
  'audit:read',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const VIEWER: Permission[] = [
  'org:read',
  'app:read',
  'integration:read',
  'sync:read',
  'metrics:read',
  'mapping:read',
];

// Analysts get read-everything plus the ability to ask for fresh data; they
// cannot change how MART is connected to anything.
const ANALYST: Permission[] = [...VIEWER, 'sync:trigger', 'audit:read'];

const ADMIN: Permission[] = [
  ...ANALYST,
  'app:create',
  'app:update',
  'integration:connect',
  'integration:disconnect',
  'integration:manage_credentials',
  'org:manage_members',
  'mapping:verify',
];

const OWNER: Permission[] = [...ADMIN, 'org:manage_settings'];

export const ROLE_PERMISSIONS: Record<OrganizationRole, readonly Permission[]> = {
  viewer: VIEWER,
  analyst: ANALYST,
  admin: ADMIN,
  owner: OWNER,
};

export function roleHasPermission(role: OrganizationRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

export function assertPermission(role: OrganizationRole, permission: Permission): void {
  if (!roleHasPermission(role, permission)) {
    throw new AppError('forbidden', `Role '${role}' may not perform '${permission}'`, {
      details: { requiredPermission: permission, role },
    });
  }
}

/** Roles ordered from least to most privileged, for comparisons in the UI. */
export const ROLE_RANK: Record<OrganizationRole, number> = {
  viewer: 0,
  analyst: 1,
  admin: 2,
  owner: 3,
};

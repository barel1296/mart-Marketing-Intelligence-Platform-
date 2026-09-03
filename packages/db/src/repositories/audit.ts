import { redact } from '@mart/shared';
import { query, queryRows, type Queryable } from '../pool.js';

export type AuditAction =
  | 'organization.created'
  | 'organization.member_added'
  | 'organization.member_role_changed'
  | 'app.created'
  | 'app.updated'
  | 'app.primary_attribution_provider_changed'
  | 'integration.connected'
  | 'integration.credential_replaced'
  | 'integration.validated'
  | 'integration.account_selection_changed'
  | 'integration.disconnected'
  | 'sync.triggered'
  | 'mapping.manually_verified'
  | 'mapping.rejected'
  | 'decision_policy.updated'
  | 'decision_policy.cleared'
  | 'auth.signed_in'
  | 'auth.signed_out'
  | 'security.configuration_changed';

export type AuditEntry = {
  organizationId: string | null;
  actorUserId: string | null;
  actorType?: 'user' | 'system' | 'worker';
  action: AuditAction;
  resourceType: string;
  resourceId?: string | null;
  requestId?: string | null;
  metadata?: Record<string, unknown>;
};

/**
 * Append an audit record.
 *
 * Metadata is redacted before it is written, so even a caller that mistakenly
 * passes a credential cannot persist it. The table itself rejects UPDATE and
 * DELETE via trigger.
 */
export async function writeAudit(entry: AuditEntry, client?: Queryable): Promise<void> {
  await query(
    `INSERT INTO audit_log
       (organization_id, actor_user_id, actor_type, action, resource_type, resource_id, request_id, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      entry.organizationId,
      entry.actorUserId,
      entry.actorType ?? 'user',
      entry.action,
      entry.resourceType,
      entry.resourceId ?? null,
      entry.requestId ?? null,
      JSON.stringify(redact(entry.metadata ?? {})),
    ],
    client,
  );
}

export type AuditRow = {
  id: string;
  organization_id: string | null;
  actor_user_id: string | null;
  actor_email: string | null;
  actor_type: string;
  action: string;
  resource_type: string;
  resource_id: string | null;
  request_id: string | null;
  metadata: Record<string, unknown>;
  created_at: Date;
};

export async function listAudit(
  organizationId: string,
  filter: { resourceType?: string; resourceId?: string; limit?: number } = {},
  client?: Queryable,
): Promise<AuditRow[]> {
  const params: unknown[] = [organizationId];
  let sql = `SELECT a.id, a.organization_id, a.actor_user_id, u.email AS actor_email, a.actor_type,
                    a.action, a.resource_type, a.resource_id, a.request_id, a.metadata, a.created_at
             FROM audit_log a
             LEFT JOIN users u ON u.id = a.actor_user_id
             WHERE a.organization_id = $1`;
  if (filter.resourceType) {
    params.push(filter.resourceType);
    sql += ` AND a.resource_type = $${params.length}`;
  }
  if (filter.resourceId) {
    params.push(filter.resourceId);
    sql += ` AND a.resource_id = $${params.length}`;
  }
  params.push(Math.min(filter.limit ?? 50, 500));
  sql += ` ORDER BY a.created_at DESC LIMIT $${params.length}`;
  return queryRows<AuditRow>(sql, params, client);
}

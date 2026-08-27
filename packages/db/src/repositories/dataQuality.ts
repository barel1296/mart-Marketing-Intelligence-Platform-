import type { IsoDate } from '@mart/shared';
import { query, queryRows, type Queryable } from '../pool.js';

export type DataQualityFinding = {
  organizationId: string;
  appId: string;
  connectionId: string | null;
  syncRunId: string | null;
  checkKey: string;
  severity: 'info' | 'warning' | 'error';
  entityType?: string | null;
  entityRef?: string | null;
  observedDate?: IsoDate | null;
  message: string;
  detail?: Record<string, unknown>;
};

export async function recordDataQualityFindings(
  findings: readonly DataQualityFinding[],
  client?: Queryable,
): Promise<void> {
  for (const finding of findings) {
    await query(
      `INSERT INTO data_quality_findings
         (organization_id, app_id, connection_id, sync_run_id, check_key, severity,
          entity_type, entity_ref, observed_date, message, detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        finding.organizationId,
        finding.appId,
        finding.connectionId,
        finding.syncRunId,
        finding.checkKey,
        finding.severity,
        finding.entityType ?? null,
        finding.entityRef ?? null,
        finding.observedDate ?? null,
        finding.message.slice(0, 1000),
        JSON.stringify(finding.detail ?? {}),
      ],
      client,
    );
  }
}

export type DataQualityRow = {
  id: string;
  check_key: string;
  severity: 'info' | 'warning' | 'error';
  entity_type: string | null;
  entity_ref: string | null;
  observed_date: string | null;
  message: string;
  detail: Record<string, unknown>;
  created_at: Date;
};

export async function listDataQualityFindings(
  organizationId: string,
  appId: string,
  filter: { limit?: number; severity?: 'info' | 'warning' | 'error' } = {},
  client?: Queryable,
): Promise<DataQualityRow[]> {
  const params: unknown[] = [organizationId, appId];
  let sql = `SELECT id, check_key, severity, entity_type, entity_ref, observed_date, message, detail, created_at
             FROM data_quality_findings
             WHERE organization_id = $1 AND app_id = $2`;
  if (filter.severity) {
    params.push(filter.severity);
    sql += ` AND severity = $${params.length}`;
  }
  params.push(Math.min(filter.limit ?? 50, 200));
  sql += ` ORDER BY created_at DESC LIMIT $${params.length}`;
  return queryRows<DataQualityRow>(sql, params, client);
}

import { query, queryOne, type Queryable } from '../pool.js';

/**
 * The operator's decision targets for one app - Phase 3.
 *
 * Targets only. A signal compares a trusted figure against these; the floors
 * and bands the comparison needs are constants in the metric layer.
 */
export type DecisionPolicyRow = {
  id: string;
  organization_id: string;
  app_id: string;
  target_roas_d7: string | null;
  target_roas_d1: string | null;
  max_cpi: string | null;
  currency: string | null;
  updated_by_user_id: string | null;
  created_at: Date;
  updated_at: Date;
};

const POLICY_COLUMNS = `id, organization_id, app_id, target_roas_d7, target_roas_d1, max_cpi, currency,
  updated_by_user_id, created_at, updated_at`;

export async function getDecisionPolicy(
  organizationId: string,
  appId: string,
  client?: Queryable,
): Promise<DecisionPolicyRow | null> {
  return queryOne<DecisionPolicyRow>(
    `SELECT ${POLICY_COLUMNS} FROM decision_policies WHERE organization_id = $1 AND app_id = $2`,
    [organizationId, appId],
    client,
  );
}

export type DecisionPolicyUpsert = {
  organizationId: string;
  appId: string;
  targetRoasD7: number | null;
  targetRoasD1: number | null;
  maxCpi: number | null;
  currency: string | null;
  updatedByUserId: string | null;
};

export async function upsertDecisionPolicy(
  input: DecisionPolicyUpsert,
  client?: Queryable,
): Promise<DecisionPolicyRow> {
  const rows = await query<DecisionPolicyRow>(
    `INSERT INTO decision_policies
       (organization_id, app_id, target_roas_d7, target_roas_d1, max_cpi, currency, updated_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (app_id) DO UPDATE SET
       target_roas_d7 = EXCLUDED.target_roas_d7,
       target_roas_d1 = EXCLUDED.target_roas_d1,
       max_cpi = EXCLUDED.max_cpi,
       currency = EXCLUDED.currency,
       updated_by_user_id = EXCLUDED.updated_by_user_id,
       updated_at = now()
     RETURNING ${POLICY_COLUMNS}`,
    [
      input.organizationId,
      input.appId,
      input.targetRoasD7,
      input.targetRoasD1,
      input.maxCpi,
      input.currency,
      input.updatedByUserId,
    ],
    client,
  );
  const row = rows.rows[0];
  if (!row) throw new Error('decision policy upsert returned no row');
  return row;
}

export async function deleteDecisionPolicy(
  organizationId: string,
  appId: string,
  client?: Queryable,
): Promise<void> {
  await query(
    `DELETE FROM decision_policies WHERE organization_id = $1 AND app_id = $2`,
    [organizationId, appId],
    client,
  );
}

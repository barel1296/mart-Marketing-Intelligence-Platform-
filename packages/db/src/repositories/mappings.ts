import type { MappingEntityType, MappingMethod, MappingStatus } from '@mart/shared';
import { query, queryOne, queryRows, toNumber, type Queryable } from '../pool.js';

export type EntityMappingRow = {
  id: string;
  organization_id: string;
  app_id: string;
  entity_type: MappingEntityType;
  source_provider: string;
  source_external_id: string;
  source_name: string | null;
  target_provider: string;
  target_external_id: string | null;
  target_name: string | null;
  mapping_method: MappingMethod;
  mapping_confidence: string;
  status: MappingStatus;
  candidates: Array<Record<string, unknown>>;
  candidate_count: number;
  evidence: Record<string, unknown>;
  computed_at: Date;
  verified_at: Date | null;
  verified_by_user_id: string | null;
};

const MAPPING_COLUMNS = `id, organization_id, app_id, entity_type, source_provider, source_external_id,
  source_name, target_provider, target_external_id, target_name, mapping_method, mapping_confidence,
  status, candidates, candidate_count, evidence, computed_at, verified_at, verified_by_user_id`;

export type MappingUpsert = {
  entityType: MappingEntityType;
  sourceProvider: string;
  sourceExternalId: string;
  sourceName: string | null;
  targetProvider: string;
  targetExternalId: string | null;
  targetName: string | null;
  mappingMethod: MappingMethod;
  mappingConfidence: number;
  status: MappingStatus;
  candidates: Array<Record<string, unknown>>;
  evidence: Record<string, unknown>;
};

/**
 * Persist a computed mapping.
 *
 * A manually verified mapping is never overwritten by the automatic
 * reconciliation pass: human judgement outranks the matcher.
 */
export async function upsertMappings(
  organizationId: string,
  appId: string,
  mappings: readonly MappingUpsert[],
  client?: Queryable,
): Promise<void> {
  for (const mapping of mappings) {
    await query(
      `INSERT INTO provider_entity_mappings
         (organization_id, app_id, entity_type, source_provider, source_external_id, source_name,
          target_provider, target_external_id, target_name, mapping_method, mapping_confidence,
          status, candidates, candidate_count, evidence, computed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15, now())
       ON CONFLICT (app_id, entity_type, source_provider, source_external_id, target_provider)
       DO UPDATE SET
         source_name = EXCLUDED.source_name,
         target_external_id = CASE WHEN provider_entity_mappings.status IN ('manually_verified','rejected')
                                   THEN provider_entity_mappings.target_external_id
                                   ELSE EXCLUDED.target_external_id END,
         target_name = CASE WHEN provider_entity_mappings.status IN ('manually_verified','rejected')
                            THEN provider_entity_mappings.target_name
                            ELSE EXCLUDED.target_name END,
         mapping_method = CASE WHEN provider_entity_mappings.status IN ('manually_verified','rejected')
                               THEN provider_entity_mappings.mapping_method
                               ELSE EXCLUDED.mapping_method END,
         mapping_confidence = CASE WHEN provider_entity_mappings.status IN ('manually_verified','rejected')
                                   THEN provider_entity_mappings.mapping_confidence
                                   ELSE EXCLUDED.mapping_confidence END,
         status = CASE WHEN provider_entity_mappings.status IN ('manually_verified','rejected')
                       THEN provider_entity_mappings.status
                       ELSE EXCLUDED.status END,
         candidates = EXCLUDED.candidates,
         candidate_count = EXCLUDED.candidate_count,
         evidence = EXCLUDED.evidence,
         computed_at = now()`,
      [
        organizationId,
        appId,
        mapping.entityType,
        mapping.sourceProvider,
        mapping.sourceExternalId,
        mapping.sourceName,
        mapping.targetProvider,
        mapping.targetExternalId,
        mapping.targetName,
        mapping.mappingMethod,
        mapping.mappingConfidence,
        mapping.status,
        JSON.stringify(mapping.candidates),
        mapping.candidates.length,
        JSON.stringify(mapping.evidence),
      ],
      client,
    );
  }
}

export async function listMappings(
  organizationId: string,
  appId: string,
  filter: { entityType?: MappingEntityType; status?: MappingStatus; limit?: number } = {},
  client?: Queryable,
): Promise<EntityMappingRow[]> {
  const params: unknown[] = [organizationId, appId];
  let sql = `SELECT ${MAPPING_COLUMNS} FROM provider_entity_mappings
             WHERE organization_id = $1 AND app_id = $2`;
  if (filter.entityType) {
    params.push(filter.entityType);
    sql += ` AND entity_type = $${params.length}`;
  }
  if (filter.status) {
    params.push(filter.status);
    sql += ` AND status = $${params.length}`;
  }
  params.push(Math.min(filter.limit ?? 200, 1000));
  sql += ` ORDER BY status, source_name NULLS LAST LIMIT $${params.length}`;
  return queryRows<EntityMappingRow>(sql, params, client);
}

export type MappingCoverage = {
  entity_type: MappingEntityType;
  status: MappingStatus;
  count: number;
};

export async function mappingCoverage(
  organizationId: string,
  appId: string,
  entityType: MappingEntityType,
  client?: Queryable,
): Promise<MappingCoverage[]> {
  const rows = await queryRows<{
    entity_type: MappingEntityType;
    status: MappingStatus;
    count: string;
  }>(
    `SELECT entity_type, status, count(*)::text AS count
     FROM provider_entity_mappings
     WHERE organization_id = $1 AND app_id = $2 AND entity_type = $3
     GROUP BY entity_type, status`,
    [organizationId, appId, entityType],
    client,
  );
  return rows.map((r) => ({
    entity_type: r.entity_type,
    status: r.status,
    count: toNumber(r.count),
  }));
}

export async function setMappingVerification(
  organizationId: string,
  appId: string,
  mappingId: string,
  input: {
    status: Extract<MappingStatus, 'manually_verified' | 'rejected'>;
    targetExternalId?: string | null;
    targetName?: string | null;
    verifiedByUserId: string;
  },
  client?: Queryable,
): Promise<EntityMappingRow | null> {
  return queryOne<EntityMappingRow>(
    `UPDATE provider_entity_mappings
     SET status = $4,
         target_external_id = COALESCE($5, target_external_id),
         target_name = COALESCE($6, target_name),
         mapping_method = 'manual',
         mapping_confidence = CASE WHEN $4 = 'manually_verified' THEN 1.0 ELSE 0.0 END,
         verified_at = now(),
         verified_by_user_id = $7
     WHERE organization_id = $1 AND app_id = $2 AND id = $3
     RETURNING ${MAPPING_COLUMNS}`,
    [
      organizationId,
      appId,
      mappingId,
      input.status,
      input.targetExternalId ?? null,
      input.targetName ?? null,
      input.verifiedByUserId,
    ],
    client,
  );
}

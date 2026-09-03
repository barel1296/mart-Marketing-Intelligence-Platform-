export * from './pool.js';
export * from './sql.js';
export * from './migrate.js';

export * as tenancyRepo from './repositories/tenancy.js';
export * as integrationsRepo from './repositories/integrations.js';
export * as credentialsRepo from './repositories/credentials.js';
export * as syncRepo from './repositories/sync.js';
export * as factsRepo from './repositories/facts.js';
export * as mappingsRepo from './repositories/mappings.js';
export * as auditRepo from './repositories/audit.js';
export * as dataQualityRepo from './repositories/dataQuality.js';
export * as decisionsRepo from './repositories/decisions.js';
export type { DecisionPolicyRow, DecisionPolicyUpsert } from './repositories/decisions.js';

// Pure helpers that are part of the canonical model rather than persistence.
export {
  normalizeMediaSource,
  isOrganicSource,
  marketingDimensionHash,
  attributionInstallDimensionHash,
} from './repositories/facts.js';

export type {
  UserRow,
  UserWithSecretRow,
  SessionRow,
  SessionWithUser,
  OrganizationRow,
  MembershipRow,
  AppRow,
} from './repositories/tenancy.js';
export type {
  ProviderRow,
  ConnectionRow,
  IntegrationAccountRow,
  BindingRow,
  BindingWithConnection,
  CapabilityRow,
} from './repositories/integrations.js';
export type { EncryptedCredentialRow } from './repositories/credentials.js';
export type { SyncJobRow, SyncRunRow, SyncErrorRow, FreshnessRow } from './repositories/sync.js';
export type { FactScope, UpsertOutcome } from './repositories/facts.js';
export type { EntityMappingRow, MappingUpsert, MappingCoverage } from './repositories/mappings.js';
export type { AuditAction, AuditEntry, AuditRow } from './repositories/audit.js';
export type { DataQualityFinding, DataQualityRow } from './repositories/dataQuality.js';

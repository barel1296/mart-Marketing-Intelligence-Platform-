import type {
  CanonicalAttributionBatch,
  CanonicalMarketingBatch,
  ConnectionStatus,
  IsoDate,
  ProviderCategory,
  ProviderErrorClass,
  ProviderKey,
} from '@mart/shared';
import type { CapabilityDeclaration } from './capabilities.js';

export type ConnectionHealth = {
  ok: boolean;
  status: ConnectionStatus;
  /** Actionable, non-sensitive. Shown directly in the integrations UI. */
  message: string;
  errorClass?: ProviderErrorClass;
  checkedAt: string;
  /** Non-sensitive facts discovered during validation (never credentials). */
  details?: Record<string, unknown>;
};

/** A provider-side account: a Meta ad account, or an MMP app. */
export type ProviderAccount = {
  externalAccountId: string;
  name: string;
  accountType: 'ad_account' | 'mmp_app';
  currency?: string | null;
  timezone?: string | null;
  status?: string | null;
  metadata?: Record<string, unknown>;
};

/** One page of untransformed provider output, persisted for replayability. */
export type RawPage = {
  pageNumber: number;
  payload: unknown;
  recordCount: number;
  schemaVersion: string;
  windowStart: IsoDate | null;
  windowEnd: IsoDate | null;
};

export type SyncParams = {
  /** Provider-side account/app the sync targets. */
  externalAccountId: string;
  from: IsoDate;
  to: IsoDate;
  timezone: string;
  currency: string;
  /**
   * Called for every page as it arrives, before normalization, so a failure
   * later in the window does not discard what was already fetched.
   */
  onRawPage?: (page: RawPage) => Promise<void>;
};

export type SyncResult<TBatch> = {
  batch: TBatch;
  pagesFetched: number;
  rowsFetched: number;
  rowsRejected: number;
  /** Non-fatal issues (unparseable rows, unknown columns) surfaced to the run. */
  warnings: string[];
  /** Latest provider-reported date actually present in the response. */
  latestDataDate: IsoDate | null;
};

export type ProviderBase = {
  readonly providerKey: ProviderKey;
  readonly category: ProviderCategory;
  validateConnection(): Promise<ConnectionHealth>;
  /**
   * Capabilities for this connection/account. Adapters must probe anything that
   * depends on the customer's plan rather than declaring it optimistically.
   */
  getCapabilities(externalAccountId?: string): Promise<CapabilityDeclaration[]>;
  /**
   * Validate one provider-side account or app.
   *
   * Optional, because some providers can only be validated per account (a Pull
   * API keyed to a single app) and others only at connection level. Where it
   * exists, MART calls it before storing an account so an unusable id is
   * rejected at entry rather than discovered during the first sync - and the
   * connection's status follows the result, since for a per-app provider this
   * is the first moment the credential is genuinely proven.
   */
  validateAccount?(externalAccountId: string): Promise<ConnectionHealth>;
};

export interface MarketingNetworkProvider extends ProviderBase {
  readonly category: 'marketing_network';
  listAccounts(): Promise<ProviderAccount[]>;
  /** Campaign/ad set/ad/creative hierarchy. */
  syncStructure(params: SyncParams): Promise<SyncResult<CanonicalMarketingBatch>>;
  /** Daily delivery metrics at report-date grain. */
  syncPerformance(params: SyncParams): Promise<SyncResult<CanonicalMarketingBatch>>;
}

/**
 * The MMP contract.
 *
 * AppsFlyer and Tenjin implement this identically from the outside. Everything
 * that differs between them - endpoints, auth, report shapes, field names, CSV
 * vs JSON - is confined to the adapter.
 */
export interface AttributionProvider extends ProviderBase {
  readonly category: 'attribution_mmp';
  listApps(): Promise<ProviderAccount[]>;
  syncInstalls(params: SyncParams): Promise<SyncResult<CanonicalAttributionBatch>>;
  syncEvents(params: SyncParams): Promise<SyncResult<CanonicalAttributionBatch>>;
  syncRevenue(params: SyncParams): Promise<SyncResult<CanonicalAttributionBatch>>;
}

export type AnyProvider = MarketingNetworkProvider | AttributionProvider;

export function isAttributionProvider(provider: AnyProvider): provider is AttributionProvider {
  return provider.category === 'attribution_mmp';
}

export function isMarketingNetworkProvider(
  provider: AnyProvider,
): provider is MarketingNetworkProvider {
  return provider.category === 'marketing_network';
}

export function emptyMarketingBatch(): CanonicalMarketingBatch {
  return { accounts: [], campaigns: [], adGroups: [], ads: [], creatives: [], dailyMetrics: [] };
}

export function emptyAttributionBatch(): CanonicalAttributionBatch {
  return { installs: [], events: [], revenue: [] };
}

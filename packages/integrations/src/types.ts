import type {
  CanonicalAttributionBatch,
  CanonicalMarketingBatch,
  ConnectionStatus,
  IsoDate,
  ProviderCategory,
  ProviderErrorClass,
  ProviderKey,
  StreamSupport,
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
  /**
   * The dates this call actually answered for, when the adapter can tell:
   * the requested window less whatever the provider's report could not reach.
   * Null means "nothing was answered"; undefined means the adapter does not
   * know, and the engine falls back to the dates its rows carried. Cohort
   * maturity reads this to keep "the provider said nothing happened" apart
   * from "MART never asked".
   */
  coveredWindow?: { from: IsoDate; to: IsoDate } | null;
  /**
   * Whether this stream can be fetched at all. Omitted means `supported`.
   *
   * An adapter that returns an empty batch without making a request must say
   * so here, so the run is not recorded as fresh data. Silence would make a
   * stream that never called the provider indistinguishable from one that did
   * and found nothing.
   */
  support?: StreamSupport;
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
/**
 * One campaign as the MMP's own directory describes it.
 *
 * `remoteCampaignId` is the ad network's campaign id, declared by the MMP. It
 * is a stable cross-provider identifier - the only thing that can tell two
 * network campaigns with identical names apart.
 */
export type AttributionCampaignRef = {
  externalCampaignId: string;
  name: string | null;
  remoteCampaignId: string | null;
  channelId: string | null;
  channelName: string | null;
};

export interface AttributionProvider extends ProviderBase {
  readonly category: 'attribution_mmp';
  listApps(): Promise<ProviderAccount[]>;
  syncInstalls(params: SyncParams): Promise<SyncResult<CanonicalAttributionBatch>>;
  syncEvents(params: SyncParams): Promise<SyncResult<CanonicalAttributionBatch>>;
  syncRevenue(params: SyncParams): Promise<SyncResult<CanonicalAttributionBatch>>;
  /**
   * The provider's campaign directory, when it publishes one.
   *
   * Optional because not every MMP exposes the network's campaign id. Where it
   * does, reconciliation gets a stable identifier instead of a name.
   */
  listCampaigns?(externalAccountId: string): Promise<AttributionCampaignRef[]>;
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

import type { ProviderKey } from '@mart/shared';

/**
 * Resolving an MMP's "remote id" to a marketing entity.
 *
 * An attribution provider publishes an identifier for the ad network campaign
 * it attributed a install to. The field name says `campaign` - and for at least
 * one real provider pair it is not a campaign id at all.
 *
 * Tenjin publishes `remote_campaign_id` for Meta, and on real accounts those
 * values are Meta **ad set** ids: every one of them matched
 * `marketing_ad_groups.external_ad_group_id`, and their parent campaigns were
 * different ids again. Reading such a field as a campaign id resolves nothing,
 * and - worse - looks the same as a provider that published nothing.
 *
 * So the entity level of a remote id is not knowable from its field name. It is
 * a property of the *pair* of providers, and it lives here, next to the pair,
 * rather than in the reconciliation core. The core asks "what marketing entity
 * is this, and which campaign does it belong to"; it never assumes an answer.
 */

/** The levels a marketing structure is expressed in. */
export const REMOTE_ENTITY_TYPES = ['campaign', 'ad_group', 'ad'] as const;
export type RemoteEntityType = (typeof REMOTE_ENTITY_TYPES)[number];

/** The marketing structure a resolver reads, in MART's own vocabulary. */
export type MarketingStructure = {
  /** external_campaign_id -> campaign name. */
  campaigns: ReadonlyMap<string, string | null>;
  /** external_ad_group_id -> the ad group and the campaign above it. */
  adGroups: ReadonlyMap<string, { name: string | null; externalCampaignId: string | null }>;
};

/**
 * One resolved remote identifier, carrying the whole path it was resolved
 * through so a mapping can explain itself rather than assert itself.
 */
export type ResolvedRemoteEntity = {
  remoteId: string;
  entityType: RemoteEntityType;
  entityId: string;
  entityName: string | null;
  parentCampaignId: string;
  parentCampaignName: string | null;
  method: 'provider_remote_ad_group' | 'provider_remote_campaign';
  confidence: number;
  authoritative: boolean;
};

export type RemoteIdResolver = {
  /**
   * The levels this provider pair may publish, in the order they are tried.
   * Order matters: an id that is an ad set id on one pair may be a campaign id
   * on another, and only the pair knows which to believe first.
   */
  readonly levels: readonly RemoteEntityType[];
  resolve(remoteId: string, structure: MarketingStructure): ResolvedRemoteEntity | null;
};

/**
 * Resolve a remote id at the levels a provider pair actually publishes.
 *
 * A resolution through the structure - at any level - is authoritative:
 * the identifier came from the provider, and the parent link came from the
 * marketing network's own structure. Nothing here is inferred from a name.
 */
function resolverForLevels(levels: readonly RemoteEntityType[]): RemoteIdResolver {
  return {
    levels,
    resolve(remoteId, structure) {
      for (const level of levels) {
        if (level === 'ad_group') {
          const adGroup = structure.adGroups.get(remoteId);
          // An ad group MART holds but whose parent it does not know cannot be
          // rolled up to a campaign, so it is not a resolution.
          if (adGroup?.externalCampaignId) {
            return {
              remoteId,
              entityType: 'ad_group',
              entityId: remoteId,
              entityName: adGroup.name,
              parentCampaignId: adGroup.externalCampaignId,
              parentCampaignName: structure.campaigns.get(adGroup.externalCampaignId) ?? null,
              method: 'provider_remote_ad_group',
              confidence: 1,
              authoritative: true,
            };
          }
        }
        if (level === 'campaign' && structure.campaigns.has(remoteId)) {
          return {
            remoteId,
            entityType: 'campaign',
            entityId: remoteId,
            entityName: structure.campaigns.get(remoteId) ?? null,
            parentCampaignId: remoteId,
            parentCampaignName: structure.campaigns.get(remoteId) ?? null,
            method: 'provider_remote_campaign',
            confidence: 1,
            authoritative: true,
          };
        }
      }
      return null;
    },
  };
}

/**
 * What each provider pair publishes.
 *
 * Keyed by both providers because the semantics belong to the pair: the same
 * MMP field can mean different levels against different networks, and the same
 * network is read differently by different MMPs.
 *
 * The default is campaign-only. A pair MART has not verified gets the
 * conservative reading, so one pair's semantics can never leak into another's.
 */
const RESOLVERS = new Map<string, RemoteIdResolver>([
  [
    // Verified against live accounts: every Tenjin remote_campaign_id matched a
    // Meta ad set, never a Meta campaign. Campaign is still tried afterwards,
    // because the field is named for it and an account may yet publish one.
    'tenjin::meta_ads',
    resolverForLevels(['ad_group', 'campaign']),
  ],
]);

const DEFAULT_RESOLVER = resolverForLevels(['campaign']);

export function getRemoteIdResolver(
  attributionProviderKey: ProviderKey | string,
  marketingProviderKey: ProviderKey | string,
): RemoteIdResolver {
  return RESOLVERS.get(`${attributionProviderKey}::${marketingProviderKey}`) ?? DEFAULT_RESOLVER;
}

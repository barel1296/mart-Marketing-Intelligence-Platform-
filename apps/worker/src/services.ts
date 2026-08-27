import { integrationsRepo } from '@mart/db';

export {
  backoffDelayMs,
  enqueueSync,
  hydrateRequest,
  planSyncs,
  reconcileCampaigns,
  runSync,
} from '@mart/integrations';

/**
 * Which providers to reconcile for an app.
 *
 * Returns null when either side is missing: reconciliation between a marketing
 * network and an MMP is meaningless with only one of them connected, and MART
 * would rather do nothing than invent a mapping.
 */
export async function loadAppReconciliationTargets(
  organizationId: string,
  appId: string,
): Promise<{ marketingProviderKey: string; attributionProviderKey: string } | null> {
  const bindings = await integrationsRepo.listAppBindings(organizationId, appId);
  const marketing = bindings.find((b) => b.role === 'marketing_network');
  const attribution = bindings.find((b) => b.role === 'primary_attribution');
  if (!marketing || !attribution) return null;
  return {
    marketingProviderKey: marketing.provider_key,
    attributionProviderKey: attribution.provider_key,
  };
}

import type { AppRow } from '@mart/db';
import { integrationsRepo, syncRepo } from '@mart/db';
import { campaignCoverage, worstFreshness } from '@mart/integrations';
import type { MetricContext } from '@mart/metrics';

export type AppIntegrationState = {
  marketingProviderKey: string | null;
  marketingAccountExternalId: string | null;
  attributionProviderKey: string | null;
  attributionAccountExternalId: string | null;
  marketingConnectionId: string | null;
  attributionConnectionId: string | null;
};

/**
 * Resolve which providers this app is actually wired to.
 *
 * Everything downstream - metric availability, the campaign table, the
 * reconciliation view - keys off this rather than assuming Meta and an MMP are
 * present.
 */
export async function loadIntegrationState(
  organizationId: string,
  appId: string,
): Promise<AppIntegrationState> {
  const bindings = await integrationsRepo.listAppBindings(organizationId, appId);
  const marketing = bindings.find((b) => b.role === 'marketing_network');
  const attribution = bindings.find((b) => b.role === 'primary_attribution');
  return {
    marketingProviderKey: marketing?.provider_key ?? null,
    marketingAccountExternalId: marketing?.external_account_id ?? null,
    marketingConnectionId: marketing?.connection_id ?? null,
    attributionProviderKey: attribution?.provider_key ?? null,
    attributionAccountExternalId: attribution?.external_account_id ?? null,
    attributionConnectionId: attribution?.connection_id ?? null,
  };
}

/**
 * Build the metric context.
 *
 * Capability sets are unioned across the app's bound connections, so a metric
 * that needs a dimension neither provider exposes is reported unavailable
 * rather than silently returning zero.
 */
export async function buildMetricContext(
  organizationId: string,
  app: AppRow,
): Promise<{ context: MetricContext; state: AppIntegrationState }> {
  const state = await loadIntegrationState(organizationId, app.id);
  const bindings = await integrationsRepo.listAppBindings(organizationId, app.id);

  const supported = new Set<string>();
  for (const binding of bindings) {
    const capabilities = await integrationsRepo.listCapabilities(
      binding.connection_id,
      binding.integration_account_id,
    );
    for (const capability of capabilities) {
      if (capability.supported) supported.add(capability.capability_key);
    }
  }

  const freshnessRows = await syncRepo.listFreshness(organizationId, app.id);
  const marketingRows = freshnessRows.filter((r) => r.data_type.startsWith('marketing'));
  const attributionRows = freshnessRows.filter((r) => r.data_type.startsWith('attribution'));

  const coverage = state.marketingProviderKey
    ? await campaignCoverage(organizationId, app.id, state.marketingProviderKey)
    : null;

  const context: MetricContext = {
    hasMarketingConnection: Boolean(state.marketingProviderKey),
    hasAttributionConnection: Boolean(state.attributionProviderKey),
    marketingProviders: state.marketingProviderKey ? [state.marketingProviderKey] : [],
    attributionProviders: state.attributionProviderKey ? [state.attributionProviderKey] : [],
    supportedCapabilities: supported,
    marketingFreshness: marketingRows.length
      ? {
          status: worstFreshness(marketingRows.map((r) => r.status)),
          latestDataDate:
            marketingRows
              .map((r) => r.latest_provider_data_date)
              .filter((d): d is string => Boolean(d))
              .sort()
              .at(-1) ?? null,
        }
      : undefined,
    attributionFreshness: attributionRows.length
      ? {
          status: worstFreshness(attributionRows.map((r) => r.status)),
          latestDataDate:
            attributionRows
              .map((r) => r.latest_provider_data_date)
              .filter((d): d is string => Boolean(d))
              .sort()
              .at(-1) ?? null,
        }
      : undefined,
    mappingCoverage: coverage
      ? {
          total: coverage.total,
          authoritative: coverage.authoritative,
          operational: coverage.operational,
          ...(coverage.eligible ? { eligible: coverage.eligible } : {}),
        }
      : undefined,
  };

  return { context, state };
}

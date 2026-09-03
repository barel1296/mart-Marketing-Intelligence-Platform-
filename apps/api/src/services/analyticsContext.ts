import type { AppRow } from '@mart/db';
import { integrationsRepo, syncRepo } from '@mart/db';
import type { IsoDate } from '@mart/shared';
import { campaignCoverage, worstFreshness, type CoverageSummary } from '@mart/integrations';
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
/**
 * Minutes since the stream last synced successfully.
 *
 * The registry declares a per-metric staleness tolerance; without this it had
 * nothing to compare against and was read by nothing. The oldest successful
 * sync across the streams wins - a metric is only as current as its stalest
 * input.
 */
function minutesSinceSuccess(
  rows: Array<{ last_success_at: Date | string | null }>,
): number | null {
  const times = rows
    .map((r) => (r.last_success_at ? new Date(r.last_success_at).getTime() : null))
    .filter((t): t is number => t !== null && Number.isFinite(t));
  if (times.length === 0) return null;
  return Math.floor((Date.now() - Math.min(...times)) / 60_000);
}

export async function buildMetricContext(
  organizationId: string,
  app: AppRow,
  /**
   * The reporting period on screen. Passing it is what makes the selected-period
   * coverage metrics computable; without it only the all-structure numbers
   * exist, and the period ones correctly report that they have no period.
   */
  window?: { from: IsoDate; to: IsoDate; country?: string | null; platform?: string | null },
): Promise<{
  context: MetricContext;
  state: AppIntegrationState;
  /**
   * Returned so callers render the same numbers the metrics were computed
   * from. Computing coverage twice for one response is how a KPI card and the
   * panel below it came to disagree.
   */
  coverage: CoverageSummary | null;
}> {
  const state = await loadIntegrationState(organizationId, app.id);
  const bindings = await integrationsRepo.listAppBindings(organizationId, app.id);

  const supported = new Set<string>();
  // For a capability the probe found missing, the probe may have recorded the
  // exact external change that would supply it. Carried into the context so
  // an unavailable metric can say what to do, not only that it cannot.
  const capabilityNotes: Record<string, string> = {};
  for (const binding of bindings) {
    const capabilities = await integrationsRepo.listCapabilities(
      binding.connection_id,
      binding.integration_account_id,
    );
    for (const capability of capabilities) {
      if (capability.supported) supported.add(capability.capability_key);
      else if (typeof capability.detail?.['action'] === 'string') {
        capabilityNotes[capability.capability_key] = capability.detail['action'];
      }
    }
  }

  const freshnessRows = await syncRepo.listFreshness(organizationId, app.id);
  const marketingRows = freshnessRows.filter((r) => r.data_type.startsWith('marketing'));
  const attributionRows = freshnessRows.filter((r) => r.data_type.startsWith('attribution'));

  const coverage = state.marketingProviderKey
    ? await campaignCoverage(
        organizationId,
        app.id,
        state.marketingProviderKey,
        window
          ? {
              from: window.from,
              to: window.to,
              attributionProviderKey: state.attributionProviderKey,
              // The coverage cards sit beside the KPIs and must describe the
              // same slice: account-wide coverage over a country-filtered
              // dashboard answers a question nobody asked.
              country: window.country ?? null,
              platform: window.platform ?? null,
            }
          : undefined,
      )
    : null;

  const context: MetricContext = {
    hasMarketingConnection: Boolean(state.marketingProviderKey),
    hasAttributionConnection: Boolean(state.attributionProviderKey),
    marketingProviders: state.marketingProviderKey ? [state.marketingProviderKey] : [],
    attributionProviders: state.attributionProviderKey ? [state.attributionProviderKey] : [],
    supportedCapabilities: supported,
    capabilityNotes,
    marketingFreshness: marketingRows.length
      ? {
          status: worstFreshness(marketingRows.map((r) => r.status)),
          minutesSinceSuccess: minutesSinceSuccess(marketingRows),
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
          minutesSinceSuccess: minutesSinceSuccess(attributionRows),
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

  return { context, state, coverage };
}

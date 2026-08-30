import Link from 'next/link';
import { apiGet } from '../../../../../lib/api';
import {
  Card,
  DataSourceBanner,
  EmptyState,
  StatusChip,
  type DataSource,
} from '../../../../../components/primitives';
import { SyncButton } from '../../../../../components/actions';
import {
  AttributionProviderChooser,
  ConnectProviderCard,
  ConnectionPanel,
  type ConnectionRow,
  type ProviderCatalogueEntry,
} from '../../../../../components/integrations';
import { accountLabel, formatDateTime, relativeTime, statusLabel } from '../../../../../lib/format';

type Me = { organizations: Array<{ id: string; name: string; role: string }> };

type AppRow = {
  id: string;
  name: string;
  bundle_id: string;
  platform: string;
  timezone: string;
  default_currency: string;
  primary_attribution_provider: string | null;
};

type Capability = {
  key: string;
  supported: boolean;
  discoveryMethod: string;
  /** Free-form provider evidence: a probe result, a reason, an API note. */
  detail: Record<string, unknown> | string | null;
};

/** Render capability evidence as a sentence rather than as an object dump. */
function describeDetail(detail: Capability['detail']): string | null {
  if (!detail) return null;
  if (typeof detail === 'string') return detail;
  const preferred = ['reason', 'note', 'message', 'detail'];
  for (const key of preferred) {
    const value = detail[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  const parts = Object.entries(detail)
    .filter(([, value]) => value !== null && typeof value !== 'object')
    .map(([key, value]) => `${key}: ${String(value)}`);
  return parts.length > 0 ? parts.join(' · ') : null;
}

type IntegrationCard = {
  bindingId: string;
  role: 'marketing_network' | 'primary_attribution';
  providerKey: string;
  category: string;
  connectionId: string;
  connectionStatus: string;
  displayName: string;
  account: {
    id: string;
    externalAccountId: string;
    name: string;
    currency: string | null;
    metadata?: Record<string, unknown> | null;
  } | null;
  capabilities: Capability[];
  credentialConfigured: boolean;
  configuredBaseUrl: string | null;
  productionBaseUrl: string | null;
  origin: DataSource['origin'];
};

type FreshnessRow = {
  connection_id: string;
  provider_key: string;
  data_type: string;
  last_attempt_at: string | null;
  last_success_at: string | null;
  latest_provider_data_date: string | null;
  status: string;
  last_error_class: string | null;
};

type SyncRun = {
  id: string;
  connection_id: string;
  data_type: string;
  status: string;
  window_start: string;
  window_end: string;
  attempt: number;
  finished_at: string | null;
  created_at: string;
  error_class: string | null;
  error_message: string | null;
};

const CATEGORY_SECTIONS: Array<{ key: string; title: string; blurb: string }> = [
  {
    key: 'marketing_network',
    title: 'Marketing networks',
    blurb:
      'Where spend and delivery come from. Reported at report date, in the account currency, restated by the network for several days after the fact.',
  },
  {
    key: 'attribution_mmp',
    title: 'Attribution (MMP)',
    blurb:
      'Where installs and attributed revenue come from. Exactly one MMP is primary per app; its numbers are keyed to install date, not report date.',
  },
  {
    key: 'product_analytics',
    title: 'Product analytics',
    blurb: 'In-app behaviour and retention. Not part of Phase 0A.',
  },
  {
    key: 'monetization',
    title: 'Monetization and ad revenue',
    blurb: 'Ad revenue and IAP. Not part of Phase 0A.',
  },
];

const CAPABILITY_LABEL: Record<string, string> = {
  spend: 'Spend',
  impressions: 'Impressions',
  clicks: 'Clicks',
  installs: 'Installs',
  revenue: 'Revenue',
  campaign_id: 'Campaign IDs',
  adset_id: 'Ad set IDs',
  creative_id: 'Creative IDs',
  country_breakdown: 'Country breakdown',
  platform_breakdown: 'Platform breakdown',
  cohort_reporting: 'Cohort reporting',
  raw_event_export: 'Raw event export',
  historical_backfill: 'Historical backfill',
  restatement: 'Restatement window',
};

export default async function IntegrationsPage({ params }: { params: Promise<{ appId: string }> }) {
  const { appId } = await params;
  const me = await apiGet<Me>('/api/v1/auth/me');
  const organization = me.organizations[0];

  if (!organization) {
    return (
      <EmptyState
        title="No organization"
        message="Your user is not a member of any organization yet."
      />
    );
  }

  const orgId = organization.id;
  const [{ app }, { providers }, { connections }, { integrations }, freshnessPayload, runsPayload] =
    await Promise.all([
      apiGet<{ app: AppRow }>(`/api/v1/organizations/${orgId}/apps/${appId}`),
      apiGet<{ providers: ProviderCatalogueEntry[] }>(`/api/v1/organizations/${orgId}/providers`),
      apiGet<{ connections: ConnectionRow[] }>(`/api/v1/organizations/${orgId}/connections`),
      apiGet<{ integrations: IntegrationCard[] }>(
        `/api/v1/organizations/${orgId}/apps/${appId}/integrations`,
      ),
      apiGet<{ freshness: FreshnessRow[] }>(
        `/api/v1/organizations/${orgId}/apps/${appId}/freshness`,
      ),
      apiGet<{ runs: SyncRun[] }>(
        `/api/v1/organizations/${orgId}/apps/${appId}/sync/runs?limit=25`,
      ),
    ]);

  const providerByKey = new Map(providers.map((p) => [p.providerKey, p]));
  const connectionById = new Map(connections.map((c) => [c.id, c]));
  const boundByConnection = new Map(integrations.map((card) => [card.connectionId, card]));

  const marketingCard = integrations.find((card) => card.role === 'marketing_network');
  const attributionCard = integrations.find((card) => card.role === 'primary_attribution');

  const mmpOptions = providers
    .filter((p) => p.category === 'attribution_mmp' && p.status === 'available')
    .map((p) => ({
      providerKey: p.providerKey,
      displayName: p.displayName,
      implemented: p.implemented,
    }));

  // Setup progress, so the operator can see what is still missing.
  const steps = [
    { label: 'Connect a marketing network', done: Boolean(marketingCard) },
    {
      label: 'Choose the primary attribution provider',
      done: Boolean(app.primary_attribution_provider),
    },
    { label: 'Connect that MMP and select its app', done: Boolean(attributionCard) },
    {
      label: 'Run the initial historical sync',
      done: freshnessPayload.freshness.some((row) => row.last_success_at !== null),
    },
  ];
  const setupComplete = steps.every((step) => step.done);

  return (
    <>
      <header className="page-header">
        <div>
          <h1>{app.name} — integrations</h1>
          <p>
            Connect the sources this app reports on. MART reads from providers and stores the result
            internally; the dashboard never calls a provider directly.
          </p>
          <div className="inline-meta">
            <span className="mono">{app.bundle_id}</span>
            <span>{app.platform}</span>
            <span>reporting timezone {app.timezone}</span>
            <span>{app.default_currency}</span>
          </div>
        </div>
        <div className="button-row">
          <Link className="nav-item" href={`/apps/${appId}`}>
            Command Center
          </Link>
        </div>
      </header>

      <DataSourceBanner
        sources={integrations.map((card) => ({
          role: card.role,
          providerKey: card.providerKey,
          account: card.account?.externalAccountId ?? null,
          accountName: card.account?.name ?? null,
          configuredBaseUrl: card.configuredBaseUrl,
          productionBaseUrl: card.productionBaseUrl,
          origin: card.origin,
        }))}
      />

      <Card title="Setup" hint="Each step is required before the Command Center can show a number.">
        <ol className="step-list">
          {steps.map((step) => (
            <li key={step.label}>
              <StatusChip
                status={step.done ? 'connected' : 'pending'}
                label={step.done ? 'done' : 'todo'}
              />{' '}
              {step.label}
            </li>
          ))}
        </ol>
        {setupComplete ? null : (
          <p className="hint" style={{ marginTop: 8 }}>
            Until every step is done, metrics that depend on the missing source are reported as
            unavailable rather than as zero.
          </p>
        )}
      </Card>

      {/* ------------------------------------------- primary attribution --- */}
      <Card
        title="Primary attribution provider"
        hint="One MMP per app defines what an attributed install is. Changing it is explicit and audited."
      >
        <dl className="detail-grid" style={{ marginBottom: 10 }}>
          <dt>Current</dt>
          <dd>
            {app.primary_attribution_provider ? (
              <StatusChip status="connected" label={app.primary_attribution_provider} />
            ) : (
              <StatusChip status="pending" label="not chosen" />
            )}
          </dd>
        </dl>
        <AttributionProviderChooser
          organizationId={orgId}
          appId={appId}
          current={app.primary_attribution_provider}
          options={mmpOptions}
        />
      </Card>

      {/* --------------------------------------------- active integrations --- */}
      <Card
        title="Active integrations for this app"
        hint="Credentials are never displayed. Only their fingerprint and rotation time are shown."
        actions={
          integrations.length > 0 ? (
            <div className="button-row">
              <SyncButton organizationId={orgId} appId={appId} />
              <SyncButton
                organizationId={orgId}
                appId={appId}
                backfill
                label="Initial historical sync"
              />
            </div>
          ) : undefined
        }
      >
        {integrations.length === 0 ? (
          <EmptyState
            title="No source is bound to this app yet"
            message="Connect a provider below, select the account or app it should read, and bind it here. Nothing is synced until a binding exists."
          />
        ) : (
          <div className="integration-grid">
            {integrations.map((card) => {
              const freshness = freshnessPayload.freshness.filter(
                (row) => row.connection_id === card.connectionId,
              );
              const lastSuccess = freshness
                .map((row) => row.last_success_at)
                .filter((value): value is string => value !== null)
                .sort()
                .at(-1);
              const latestAttempt = runsPayload.runs.find(
                (run) => run.connection_id === card.connectionId,
              );
              const connection = connectionById.get(card.connectionId);

              return (
                <article className="integration-card" key={card.bindingId}>
                  <div className="row-between">
                    <div>
                      <h3>{card.displayName}</h3>
                      <div className="provider-key mono">
                        {card.providerKey} ·{' '}
                        {card.role === 'primary_attribution'
                          ? 'primary attribution'
                          : 'marketing network'}
                      </div>
                    </div>
                    <StatusChip status={card.connectionStatus} />
                  </div>

                  <dl className="detail-grid">
                    <dt>Account</dt>
                    <dd>
                      {card.account ? (
                        <>
                          {accountLabel({
                            external_account_id: card.account.externalAccountId,
                            name: card.account.name,
                            metadata: card.account.metadata ?? null,
                          })}
                          {card.account.currency ? ` · ${card.account.currency}` : ''}
                          <span className="cell-note mono">
                            {card.providerKey === 'tenjin' ? 'Tenjin app id' : 'provider id'}:{' '}
                            {card.account.externalAccountId}
                          </span>
                        </>
                      ) : (
                        'not selected'
                      )}
                    </dd>
                    <dt>Last successful sync</dt>
                    <dd>
                      {lastSuccess
                        ? `${formatDateTime(lastSuccess)} (${relativeTime(lastSuccess)})`
                        : 'never'}
                    </dd>
                    <dt>Latest attempt</dt>
                    <dd>
                      {latestAttempt ? (
                        <>
                          <StatusChip status={latestAttempt.status} /> {latestAttempt.data_type}{' '}
                          {latestAttempt.window_start} → {latestAttempt.window_end}
                          {latestAttempt.error_class ? ` · ${latestAttempt.error_class}` : ''}
                        </>
                      ) : (
                        'no run yet'
                      )}
                    </dd>
                    <dt>Freshness</dt>
                    <dd>
                      {freshness.length === 0 ? (
                        'no data yet'
                      ) : (
                        <span className="capability-list">
                          {freshness.map((row) => (
                            <span key={row.data_type}>
                              <StatusChip
                                status={row.status}
                                label={`${row.data_type}: ${statusLabel(row.status)}`}
                              />
                            </span>
                          ))}
                        </span>
                      )}
                    </dd>
                    <dt>Provider data to</dt>
                    <dd>
                      {freshness
                        .map((row) => row.latest_provider_data_date)
                        .filter((value): value is string => value !== null)
                        .sort()
                        .at(-1) ?? '—'}
                    </dd>
                    <dt>Credential</dt>
                    <dd>
                      {card.credentialConfigured
                        ? 'stored (encrypted)'
                        : 'missing — reconnect required'}
                    </dd>
                    <dt>Mode</dt>
                    <dd>
                      {card.origin === 'live_provider' ? (
                        <StatusChip status="connected" label="REAL PROVIDER" />
                      ) : (
                        <StatusChip status="serious" label="FIXTURE PROVIDER" />
                      )}
                    </dd>
                    <dt>Reads from</dt>
                    <dd>
                      <span className="mono">{card.configuredBaseUrl ?? 'unknown'}</span>
                      {card.origin === 'live_provider' ? null : (
                        <span className="cell-note">
                          Real provider is{' '}
                          <span className="mono">{card.productionBaseUrl ?? 'unknown'}</span>. Any
                          credential stored here is being sent to the fixture server, not to the
                          provider.
                        </span>
                      )}
                    </dd>
                  </dl>

                  <div>
                    <div className="hint" style={{ marginBottom: 4 }}>
                      Capabilities — what this account can actually deliver. &ldquo;declared&rdquo;
                      is what the connector claims; &ldquo;probed&rdquo; was confirmed against the
                      live API.
                    </div>
                    {card.capabilities.length === 0 ? (
                      <span className="hint">Not determined yet.</span>
                    ) : (
                      <ul className="capability-list">
                        {[...card.capabilities]
                          // Supported first: what the account can do is the
                          // headline, what it cannot do is the caveat.
                          .sort((a, b) => Number(b.supported) - Number(a.supported))
                          .map((capability) => (
                            <li key={capability.key}>
                              <StatusChip
                                // A missing capability is a fact about the
                                // provider, not a failure, so it reads neutral.
                                status={capability.supported ? 'available' : 'neutral'}
                                label={`${CAPABILITY_LABEL[capability.key] ?? capability.key} · ${capability.discoveryMethod}`}
                              />
                            </li>
                          ))}
                      </ul>
                    )}
                    {/* One line per distinct explanation, not per capability:
                        a provider-wide note repeated fifteen times is noise. */}
                    {[
                      ...new Map(
                        card.capabilities
                          .filter((capability) => !capability.supported)
                          .map((capability) => describeDetail(capability.detail))
                          .filter((text): text is string => text !== null)
                          .map((text) => [text, text]),
                      ).keys(),
                    ].map((text) => (
                      <p className="hint" key={text} style={{ marginTop: 4 }}>
                        {text}
                      </p>
                    ))}
                  </div>

                  {connection ? (
                    <ConnectionPanel
                      organizationId={orgId}
                      appId={appId}
                      connection={connection}
                      provider={providerByKey.get(card.providerKey)}
                      boundAccountId={card.account?.id ?? null}
                      role={card.role}
                    />
                  ) : null}
                </article>
              );
            })}
          </div>
        )}
      </Card>

      {/* ------------------------------------- connected but unbound ------- */}
      {connections.filter((c) => !boundByConnection.has(c.id) && c.status !== 'disconnected')
        .length > 0 ? (
        <Card
          title="Connected, not yet used by this app"
          hint="These credentials exist in the organization. Select an account and bind it to start syncing for this app."
        >
          <div className="integration-grid">
            {connections
              .filter((c) => !boundByConnection.has(c.id) && c.status !== 'disconnected')
              .map((connection) => (
                <article className="integration-card" key={connection.id}>
                  <div className="row-between">
                    <div>
                      <h3>{connection.display_name}</h3>
                      <div className="provider-key mono">{connection.provider_key}</div>
                    </div>
                    <StatusChip status={connection.status} />
                  </div>
                  <ConnectionPanel
                    organizationId={orgId}
                    appId={appId}
                    connection={connection}
                    provider={providerByKey.get(connection.provider_key)}
                    boundAccountId={null}
                    role={
                      connection.category === 'attribution_mmp'
                        ? 'primary_attribution'
                        : 'marketing_network'
                    }
                  />
                </article>
              ))}
          </div>
        </Card>
      ) : null}

      {/* ----------------------------------------------- provider catalogue --- */}
      {CATEGORY_SECTIONS.map((section) => {
        const entries = providers.filter((p) => p.category === section.key);
        if (entries.length === 0) return null;
        const connectable = entries.filter(
          (entry) =>
            entry.implemented &&
            !connections.some(
              (c) => c.provider_key === entry.providerKey && c.status !== 'disconnected',
            ),
        );
        const planned = entries.filter((entry) => !entry.implemented);

        return (
          <Card key={section.key} title={section.title} hint={section.blurb}>
            <div className="integration-grid">
              {connectable.map((entry) => (
                <ConnectProviderCard
                  key={entry.providerKey}
                  organizationId={orgId}
                  provider={entry}
                />
              ))}
              {planned.map((entry) => (
                <ConnectProviderCard
                  key={entry.providerKey}
                  organizationId={orgId}
                  provider={entry}
                />
              ))}
            </div>
            {connectable.length === 0 && planned.length === 0 ? (
              <p className="hint">
                Every available provider in this category is already connected.
              </p>
            ) : null}
          </Card>
        );
      })}

      {/* ------------------------------------------------ disconnected ----- */}
      {connections.some((c) => c.status === 'disconnected') ? (
        <Card
          title="Disconnected"
          hint="The credential was deleted. Data imported before disconnection is retained with its provenance."
        >
          <ul className="list-reset stack">
            {connections
              .filter((c) => c.status === 'disconnected')
              .map((connection) => (
                <li key={connection.id} className="row-between">
                  <span>
                    {connection.display_name}{' '}
                    <span className="mono">({connection.provider_key})</span>
                  </span>
                  <StatusChip status="disconnected" />
                </li>
              ))}
          </ul>
        </Card>
      ) : null}
    </>
  );
}

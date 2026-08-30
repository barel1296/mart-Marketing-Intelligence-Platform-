import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError, ATTRIBUTION_PROVIDER_KEYS } from '@mart/shared';
import { auditRepo, integrationsRepo, tenancyRepo } from '@mart/db';
import {
  buildCredentials,
  createProvider,
  ensureSyncJobs,
  getCredentialStore,
  getProviderDescriptor,
  isAttributionProvider,
  isImplemented,
  isMarketingNetworkProvider,
  listImplementedProviders,
  providerEndpointInfo,
} from '@mart/integrations';
import { setNoStore, withApp, withOrganization } from '../context.js';
import { mutationLimiter } from '../rateLimit.js';

const orgParams = z.object({ organizationId: z.string().uuid() });
const connectionParams = orgParams.extend({ connectionId: z.string().uuid() });
const appParams = orgParams.extend({ appId: z.string().uuid() });

const createConnectionSchema = z.object({
  providerKey: z.string().min(1).max(60),
  displayName: z.string().min(1).max(120).optional(),
  /** Provider-specific secret fields; never echoed back. */
  credentials: z.record(z.string()),
});

const credentialsSchema = z.object({ credentials: z.record(z.string()) });

const addAccountSchema = z.object({
  externalAccountId: z.string().min(1).max(200),
  name: z.string().min(1).max(200).optional(),
});

const bindingSchema = z.object({
  connectionId: z.string().uuid(),
  integrationAccountId: z.string().uuid(),
  role: z.enum(['marketing_network', 'primary_attribution']),
});

export async function registerIntegrationRoutes(server: FastifyInstance): Promise<void> {
  const credentialStore = getCredentialStore();

  /** Provider catalogue: implemented providers plus explicitly-planned ones. */
  server.get('/organizations/:organizationId/providers', async (request, reply) => {
    const { organizationId } = orgParams.parse(request.params);
    await withOrganization(request, organizationId, 'integration:read');
    setNoStore(reply);

    const catalogue = await integrationsRepo.listProviders();
    const implemented = new Map(listImplementedProviders().map((d) => [d.providerKey, d]));
    return {
      providers: catalogue.map((provider) => {
        const descriptor = implemented.get(provider.provider_key);
        const endpoint = providerEndpointInfo(provider.provider_key);
        return {
          configuredBaseUrl: endpoint?.configuredBaseUrl ?? null,
          productionBaseUrl: endpoint?.productionBaseUrl ?? null,
          origin:
            endpoint === null
              ? 'unknown'
              : endpoint.isProduction
                ? 'live_provider'
                : 'non_production_endpoint',
          providerKey: provider.provider_key,
          category: provider.category,
          displayName: provider.display_name,
          status: provider.status,
          authKind: provider.auth_kind,
          implemented: Boolean(descriptor),
          supportsAccountDiscovery: descriptor?.supportsAccountDiscovery ?? false,
          credentialFields:
            descriptor?.credentialFields.map((f) => ({
              name: f.name,
              label: f.label,
              help: f.help,
              secret: f.secret,
            })) ?? [],
        };
      }),
    };
  });

  server.get('/organizations/:organizationId/connections', async (request, reply) => {
    const { organizationId } = orgParams.parse(request.params);
    const context = await withOrganization(request, organizationId, 'integration:read');
    setNoStore(reply);

    const connections = await integrationsRepo.listConnections(context.organizationId, {
      includeDisconnected: true,
    });
    const enriched = await Promise.all(
      connections.map(async (connection) => {
        const accounts = await integrationsRepo.listAccounts(context.organizationId, connection.id);
        const credential = await credentialStore.metadata(connection.id);
        return {
          ...connection,
          accounts,
          // Metadata only: a fingerprint proves a credential exists and whether
          // it changed, without exposing any part of the secret.
          credential: credential
            ? {
                fingerprint: credential.fingerprint,
                expiresAt: credential.expiresAt,
                rotatedAt: credential.rotatedAt,
              }
            : null,
        };
      }),
    );
    return { connections: enriched };
  });

  /**
   * Connect a provider.
   *
   * Credentials are accepted server-side only, encrypted before persistence,
   * and validated immediately so the user finds out now rather than at the
   * first sync.
   */
  server.post('/organizations/:organizationId/connections', async (request, reply) => {
    const { organizationId } = orgParams.parse(request.params);
    const context = await withOrganization(request, organizationId, 'integration:connect');
    mutationLimiter.check(`connect:${context.userId}`);
    const body = createConnectionSchema.parse(request.body);

    if (!isImplemented(body.providerKey)) {
      throw new AppError(
        'validation_failed',
        `Provider '${body.providerKey}' is not implemented yet`,
      );
    }
    const descriptor = getProviderDescriptor(body.providerKey);
    const credentials = buildCredentials(body.providerKey, body.credentials);

    const connection = await integrationsRepo.createConnection({
      organizationId: context.organizationId,
      providerKey: descriptor.providerKey,
      category: descriptor.category,
      displayName: body.displayName ?? descriptor.displayName,
      createdByUserId: context.userId,
    });

    await credentialStore.put({
      organizationId: context.organizationId,
      connectionId: connection.id,
      credentials,
    });

    const endpoint = providerEndpointInfo(descriptor.providerKey);
    if (endpoint && !endpoint.isProduction) {
      // Not blocked - fixture mode is a supported way to develop - but never
      // silent: a credential just went to something that is not the provider.
      request.log.warn(
        {
          providerKey: descriptor.providerKey,
          configuredBaseUrl: endpoint.configuredBaseUrl,
          productionBaseUrl: endpoint.productionBaseUrl,
        },
        'credential stored for a provider pointed at a non-production endpoint',
      );
    }

    const provider = createProvider({ providerKey: descriptor.providerKey, credentials });
    const health = await provider.validateConnection();
    await integrationsRepo.updateConnectionStatus(connection.id, {
      status: health.status,
      lastValidatedAt: new Date(),
      lastValidationOk: health.ok,
      lastValidationErrorClass: health.errorClass ?? null,
      lastValidationMessage: health.message,
    });

    // Capabilities are recorded at connection level now, and refined per account
    // once an account is selected.
    const capabilities = await provider.getCapabilities();
    await integrationsRepo.replaceCapabilities({
      organizationId: context.organizationId,
      connectionId: connection.id,
      integrationAccountId: null,
      capabilities: capabilities.map((c) => ({
        key: c.key,
        supported: c.supported,
        discoveryMethod: c.discoveryMethod,
        ...(c.detail ? { detail: c.detail } : {}),
      })),
    });

    await auditRepo.writeAudit({
      organizationId: context.organizationId,
      actorUserId: context.userId,
      action: 'integration.connected',
      resourceType: 'integration_connection',
      resourceId: connection.id,
      requestId: request.requestId,
      // Note what was connected, never what it was connected with.
      metadata: { providerKey: descriptor.providerKey, validationOk: health.ok },
    });

    return reply.status(201).send({
      connection: { ...connection, status: health.status },
      health,
      supportsAccountDiscovery: descriptor.supportsAccountDiscovery,
    });
  });

  server.post(
    '/organizations/:organizationId/connections/:connectionId/validate',
    async (request) => {
      const params = connectionParams.parse(request.params);
      const context = await withOrganization(request, params.organizationId, 'integration:read');
      const connection = await requireConnection(context.organizationId, params.connectionId);

      const credentials = await credentialStore.get({
        organizationId: context.organizationId,
        connectionId: connection.id,
      });
      if (!credentials) throw new AppError('not_found', 'This connection has no stored credential');

      const provider = createProvider({ providerKey: connection.provider_key, credentials });
      const health = await provider.validateConnection();
      await integrationsRepo.updateConnectionStatus(connection.id, {
        status: health.status,
        lastValidatedAt: new Date(),
        lastValidationOk: health.ok,
        lastValidationErrorClass: health.errorClass ?? null,
        lastValidationMessage: health.message,
      });
      await auditRepo.writeAudit({
        organizationId: context.organizationId,
        actorUserId: context.userId,
        action: 'integration.validated',
        resourceType: 'integration_connection',
        resourceId: connection.id,
        requestId: request.requestId,
        metadata: { ok: health.ok, errorClass: health.errorClass ?? null },
      });
      return { health };
    },
  );

  server.post(
    '/organizations/:organizationId/connections/:connectionId/credentials',
    async (request) => {
      const params = connectionParams.parse(request.params);
      const context = await withOrganization(
        request,
        params.organizationId,
        'integration:manage_credentials',
      );
      const connection = await requireConnection(context.organizationId, params.connectionId);
      const body = credentialsSchema.parse(request.body);
      const credentials = buildCredentials(connection.provider_key, body.credentials);

      const metadata = await credentialStore.put({
        organizationId: context.organizationId,
        connectionId: connection.id,
        credentials,
      });

      const provider = createProvider({ providerKey: connection.provider_key, credentials });
      const health = await provider.validateConnection();
      await integrationsRepo.updateConnectionStatus(connection.id, {
        status: health.status,
        lastValidatedAt: new Date(),
        lastValidationOk: health.ok,
        lastValidationErrorClass: health.errorClass ?? null,
        lastValidationMessage: health.message,
      });

      await auditRepo.writeAudit({
        organizationId: context.organizationId,
        actorUserId: context.userId,
        action: 'integration.credential_replaced',
        resourceType: 'integration_connection',
        resourceId: connection.id,
        requestId: request.requestId,
        metadata: { fingerprint: metadata.fingerprint, validationOk: health.ok },
      });

      return { health, credential: { fingerprint: metadata.fingerprint } };
    },
  );

  /** Discover provider accounts/apps, where the provider supports it. */
  server.get(
    '/organizations/:organizationId/connections/:connectionId/accounts',
    async (request, reply) => {
      const params = connectionParams.parse(request.params);
      const query = z.object({ refresh: z.coerce.boolean().optional() }).parse(request.query);
      const context = await withOrganization(request, params.organizationId, 'integration:read');
      const connection = await requireConnection(context.organizationId, params.connectionId);
      setNoStore(reply);

      const descriptor = getProviderDescriptor(connection.provider_key);
      if (!query.refresh || !descriptor.supportsAccountDiscovery) {
        const stored = await integrationsRepo.listAccounts(context.organizationId, connection.id);
        return {
          accounts: stored,
          discoverySupported: descriptor.supportsAccountDiscovery,
          // AppsFlyer's Pull API is per-app with no listing endpoint; MART asks
          // for the id instead of pretending to enumerate.
          manualEntry: !descriptor.supportsAccountDiscovery,
        };
      }

      const credentials = await credentialStore.get({
        organizationId: context.organizationId,
        connectionId: connection.id,
      });
      if (!credentials) throw new AppError('not_found', 'This connection has no stored credential');

      const provider = createProvider({ providerKey: connection.provider_key, credentials });
      const discovered = isMarketingNetworkProvider(provider)
        ? await provider.listAccounts()
        : isAttributionProvider(provider)
          ? await provider.listApps()
          : [];

      const accounts = await integrationsRepo.upsertAccounts(
        context.organizationId,
        connection.id,
        discovered.map((account) => ({
          externalAccountId: account.externalAccountId,
          name: account.name,
          accountType: account.accountType,
          currency: account.currency ?? null,
          timezone: account.timezone ?? null,
          status: account.status ?? null,
          metadata: account.metadata ?? {},
        })),
      );
      return { accounts, discoverySupported: true, manualEntry: false };
    },
  );

  /**
   * Register an account/app id by hand and validate it.
   * Used for providers with no discovery endpoint (AppsFlyer).
   */
  server.post(
    '/organizations/:organizationId/connections/:connectionId/accounts',
    async (request, reply) => {
      const params = connectionParams.parse(request.params);
      const context = await withOrganization(request, params.organizationId, 'integration:connect');
      const connection = await requireConnection(context.organizationId, params.connectionId);
      const body = addAccountSchema.parse(request.body);

      const credentials = await credentialStore.get({
        organizationId: context.organizationId,
        connectionId: connection.id,
      });
      if (!credentials) throw new AppError('not_found', 'This connection has no stored credential');

      const provider = createProvider({ providerKey: connection.provider_key, credentials });

      // Validate against the provider before storing, so an unusable id is
      // rejected at entry rather than discovered during the first sync. This is
      // driven by the capability, not by the provider's name: any adapter that
      // can check an account gets checked here, and one that cannot simply
      // registers the id.
      let validation = { ok: true, message: 'Account registered.' };
      if (provider.validateAccount) {
        const health = await provider.validateAccount(body.externalAccountId);
        validation = { ok: health.ok, message: health.message };
        if (!health.ok) {
          throw new AppError('validation_failed', health.message, {
            details: { errorClass: health.errorClass },
          });
        }
        // For a per-app provider this is the first moment the credential is
        // genuinely proven, so the connection stops being 'pending' here.
        await integrationsRepo.updateConnectionStatus(connection.id, {
          status: health.status,
          lastValidatedAt: new Date(),
          lastValidationOk: health.ok,
          lastValidationErrorClass: health.errorClass ?? null,
          lastValidationMessage: health.message,
        });
      }

      const [account] = await integrationsRepo.upsertAccounts(
        context.organizationId,
        connection.id,
        [
          {
            externalAccountId: body.externalAccountId,
            name: body.name ?? body.externalAccountId,
            accountType: connection.category === 'marketing_network' ? 'ad_account' : 'mmp_app',
            metadata: { source: 'manual_entry' },
          },
        ],
      );
      if (!account) throw new AppError('internal_error', 'Failed to store account');

      // Now that an account exists, probe account-scoped capabilities.
      const capabilities = await provider.getCapabilities(body.externalAccountId);
      await integrationsRepo.replaceCapabilities({
        organizationId: context.organizationId,
        connectionId: connection.id,
        integrationAccountId: account.id,
        capabilities: capabilities.map((c) => ({
          key: c.key,
          supported: c.supported,
          discoveryMethod: c.discoveryMethod,
          ...(c.detail ? { detail: c.detail } : {}),
        })),
      });

      await auditRepo.writeAudit({
        organizationId: context.organizationId,
        actorUserId: context.userId,
        action: 'integration.account_selection_changed',
        resourceType: 'integration_account',
        resourceId: account.id,
        requestId: request.requestId,
        metadata: { externalAccountId: body.externalAccountId },
      });

      return reply.status(201).send({ account, validation });
    },
  );

  server.post(
    '/organizations/:organizationId/connections/:connectionId/disconnect',
    async (request) => {
      const params = connectionParams.parse(request.params);
      const context = await withOrganization(
        request,
        params.organizationId,
        'integration:disconnect',
      );
      const connection = await requireConnection(context.organizationId, params.connectionId);

      await integrationsRepo.updateConnectionStatus(connection.id, {
        status: 'disconnected',
        disconnectedAt: new Date(),
      });
      // The credential is destroyed; historical data stays, with its provenance.
      await credentialStore.delete(connection.id);
      await auditRepo.writeAudit({
        organizationId: context.organizationId,
        actorUserId: context.userId,
        action: 'integration.disconnected',
        resourceType: 'integration_connection',
        resourceId: connection.id,
        requestId: request.requestId,
        metadata: { providerKey: connection.provider_key },
      });
      return {
        ok: true,
        notice:
          'Connection disconnected and its stored credential deleted. Previously imported data is retained.',
      };
    },
  );

  // ------------------------------------------------------------- bindings ---
  server.get('/organizations/:organizationId/apps/:appId/integrations', async (request, reply) => {
    const params = appParams.parse(request.params);
    const { context, app } = await withApp(
      request,
      params.organizationId,
      params.appId,
      'integration:read',
    );
    setNoStore(reply);

    const bindings = await integrationsRepo.listAppBindings(context.organizationId, app.id, {
      activeOnly: false,
    });
    const cards = await Promise.all(
      bindings
        .filter((b) => b.status === 'active')
        .map(async (binding) => {
          const capabilities = await integrationsRepo.listCapabilities(
            binding.connection_id,
            binding.integration_account_id,
          );
          const credential = await credentialStore.metadata(binding.connection_id);
          const endpoint = providerEndpointInfo(binding.provider_key);
          return {
            bindingId: binding.id,
            role: binding.role,
            providerKey: binding.provider_key,
            category: binding.category,
            connectionId: binding.connection_id,
            connectionStatus: binding.connection_status,
            displayName: binding.connection_display_name,
            account: binding.integration_account_id
              ? {
                  id: binding.integration_account_id,
                  externalAccountId: binding.external_account_id,
                  name: binding.account_name,
                  currency: binding.account_currency,
                }
              : null,
            capabilities: capabilities.map((c) => ({
              key: c.capability_key,
              supported: c.supported,
              discoveryMethod: c.discovery_method,
              detail: c.detail,
            })),
            credentialConfigured: Boolean(credential),
            // Where this connection's requests actually go. A repointed base URL
            // means everything it imported is development data, and the UI has to
            // be able to say so.
            configuredBaseUrl: endpoint?.configuredBaseUrl ?? null,
            productionBaseUrl: endpoint?.productionBaseUrl ?? null,
            origin:
              endpoint === null
                ? 'unknown'
                : endpoint.isProduction
                  ? 'live_provider'
                  : 'non_production_endpoint',
          };
        }),
    );

    return { app, integrations: cards };
  });

  server.post('/organizations/:organizationId/apps/:appId/bindings', async (request, reply) => {
    const params = appParams.parse(request.params);
    const { context, app } = await withApp(
      request,
      params.organizationId,
      params.appId,
      'integration:connect',
    );
    const body = bindingSchema.parse(request.body);

    const connection = await requireConnection(context.organizationId, body.connectionId);
    const account = await integrationsRepo.findAccount(
      context.organizationId,
      body.integrationAccountId,
    );
    if (!account || account.connection_id !== connection.id) {
      throw new AppError('validation_failed', 'Account does not belong to this connection');
    }

    // Category and role must agree: an MMP cannot be bound as a marketing
    // network, and vice versa.
    const expectedCategory =
      body.role === 'primary_attribution' ? 'attribution_mmp' : 'marketing_network';
    if (connection.category !== expectedCategory) {
      throw new AppError(
        'validation_failed',
        `A ${connection.category} connection cannot be bound as ${body.role}`,
      );
    }

    if (body.role === 'primary_attribution') {
      // Checked rather than cast: the app's attribution provider column is a
      // closed set, and a new attribution adapter that forgets to join it should
      // fail here rather than write an unreadable value.
      const attributionKey = ATTRIBUTION_PROVIDER_KEYS.find(
        (key) => key === connection.provider_key,
      );
      if (!attributionKey) {
        throw new AppError(
          'validation_failed',
          `Provider '${connection.provider_key}' is not a recognised attribution provider`,
        );
      }
      // Exactly one active primary attribution provider per app.
      await integrationsRepo.deactivateBindings(app.id, 'primary_attribution');
      await tenancyRepo.updateApp(context.organizationId, app.id, {
        primaryAttributionProvider: attributionKey,
      });
    }

    const binding = await integrationsRepo.createBinding({
      organizationId: context.organizationId,
      appId: app.id,
      connectionId: connection.id,
      integrationAccountId: account.id,
      role: body.role,
      createdByUserId: context.userId,
    });

    await ensureSyncJobs(context.organizationId, app.id);

    await auditRepo.writeAudit({
      organizationId: context.organizationId,
      actorUserId: context.userId,
      action: 'integration.account_selection_changed',
      resourceType: 'integration_app_binding',
      resourceId: binding.id,
      requestId: request.requestId,
      metadata: {
        appId: app.id,
        role: body.role,
        providerKey: connection.provider_key,
        externalAccountId: account.external_account_id,
      },
    });

    return reply.status(201).send({ binding });
  });
}

async function requireConnection(organizationId: string, connectionId: string) {
  const connection = await integrationsRepo.findConnection(organizationId, connectionId);
  if (!connection) throw new AppError('not_found', 'Connection not found');
  return connection;
}

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  AppError,
  APP_PLATFORMS,
  ATTRIBUTION_PROVIDER_KEYS,
  ORGANIZATION_ROLES,
} from '@mart/shared';
import { auditRepo, tenancyRepo, withTransaction } from '@mart/db';
import { ROLE_PERMISSIONS } from '@mart/auth';
import { requireSession, setNoStore, withApp, withOrganization } from '../context.js';
import { mutationLimiter } from '../rateLimit.js';

const createOrganizationSchema = z.object({ name: z.string().min(1).max(120) });

const createAppSchema = z.object({
  name: z.string().min(1).max(120),
  platform: z.enum(APP_PLATFORMS),
  bundleId: z.string().min(1).max(200),
  timezone: z.string().min(1).max(64).optional(),
  defaultCurrency: z
    .string()
    .regex(/^[A-Z]{3}$/, 'Currency must be a 3-letter ISO code')
    .optional(),
});

const updateAppSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  timezone: z.string().min(1).max(64).optional(),
  defaultCurrency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .optional(),
});

const attributionProviderSchema = z.object({
  provider: z.enum(ATTRIBUTION_PROVIDER_KEYS),
  /**
   * Switching MMP changes what "attributed" means for this app going forward.
   * The client must acknowledge that explicitly; the API will not do it silently.
   */
  confirmSwitch: z.literal(true),
});

const addMemberSchema = z.object({
  email: z.string().email(),
  role: z.enum(ORGANIZATION_ROLES),
});

export async function registerOrganizationRoutes(server: FastifyInstance): Promise<void> {
  server.get('/organizations', async (request, reply) => {
    const session = requireSession(request);
    setNoStore(reply);
    const organizations = await tenancyRepo.listOrganizationsForUser(session.userId);
    return { organizations };
  });

  server.post('/organizations', async (request, reply) => {
    const session = requireSession(request);
    mutationLimiter.check(`org:${session.userId}`);
    const body = createOrganizationSchema.parse(request.body);

    const organization = await withTransaction(async (client) => {
      const created = await tenancyRepo.createOrganization(
        {
          name: body.name,
          slug: `${
            body.name
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, '-')
              .replace(/^-+|-+$/g, '')
              .slice(0, 40) || 'org'
          }-${Math.random().toString(36).slice(2, 8)}`,
          createdBy: session.userId,
        },
        client,
      );
      await tenancyRepo.addMembership(
        { organizationId: created.id, userId: session.userId, role: 'owner' },
        client,
      );
      await auditRepo.writeAudit(
        {
          organizationId: created.id,
          actorUserId: session.userId,
          action: 'organization.created',
          resourceType: 'organization',
          resourceId: created.id,
          requestId: request.requestId,
          metadata: { name: created.name },
        },
        client,
      );
      return created;
    });

    return reply.status(201).send({ organization });
  });

  server.get('/organizations/:organizationId/members', async (request, reply) => {
    const { organizationId } = z
      .object({ organizationId: z.string().uuid() })
      .parse(request.params);
    const context = await withOrganization(request, organizationId, 'org:read');
    setNoStore(reply);
    const members = await tenancyRepo.listMembers(context.organizationId);
    return { members, permissions: ROLE_PERMISSIONS[context.role] };
  });

  server.post('/organizations/:organizationId/members', async (request, reply) => {
    const { organizationId } = z
      .object({ organizationId: z.string().uuid() })
      .parse(request.params);
    const context = await withOrganization(request, organizationId, 'org:manage_members');
    const body = addMemberSchema.parse(request.body);

    const user = await tenancyRepo.findUserForAuthentication(body.email);
    if (!user) {
      throw new AppError('not_found', 'No MART user exists with that email address');
    }
    const membership = await tenancyRepo.addMembership({
      organizationId: context.organizationId,
      userId: user.id,
      role: body.role,
    });
    await auditRepo.writeAudit({
      organizationId: context.organizationId,
      actorUserId: context.userId,
      action: 'organization.member_added',
      resourceType: 'membership',
      resourceId: user.id,
      requestId: request.requestId,
      metadata: { role: body.role },
    });
    return reply.status(201).send({ membership });
  });

  // ------------------------------------------------------------------ apps ---
  server.get('/organizations/:organizationId/apps', async (request, reply) => {
    const { organizationId } = z
      .object({ organizationId: z.string().uuid() })
      .parse(request.params);
    const context = await withOrganization(request, organizationId, 'app:read');
    setNoStore(reply);
    const apps = await tenancyRepo.listApps(context.organizationId);
    return { apps };
  });

  server.post('/organizations/:organizationId/apps', async (request, reply) => {
    const { organizationId } = z
      .object({ organizationId: z.string().uuid() })
      .parse(request.params);
    const context = await withOrganization(request, organizationId, 'app:create');
    const body = createAppSchema.parse(request.body);

    const app = await tenancyRepo.createApp({
      organizationId: context.organizationId,
      name: body.name,
      platform: body.platform,
      bundleId: body.bundleId,
      ...(body.timezone ? { timezone: body.timezone } : {}),
      ...(body.defaultCurrency ? { defaultCurrency: body.defaultCurrency } : {}),
    });

    await auditRepo.writeAudit({
      organizationId: context.organizationId,
      actorUserId: context.userId,
      action: 'app.created',
      resourceType: 'app',
      resourceId: app.id,
      requestId: request.requestId,
      metadata: { name: app.name, platform: app.platform, bundleId: app.bundle_id },
    });

    return reply.status(201).send({ app });
  });

  server.get('/organizations/:organizationId/apps/:appId', async (request, reply) => {
    const params = z
      .object({ organizationId: z.string().uuid(), appId: z.string().uuid() })
      .parse(request.params);
    const { app } = await withApp(request, params.organizationId, params.appId, 'app:read');
    setNoStore(reply);
    return { app };
  });

  server.patch('/organizations/:organizationId/apps/:appId', async (request) => {
    const params = z
      .object({ organizationId: z.string().uuid(), appId: z.string().uuid() })
      .parse(request.params);
    const { context } = await withApp(request, params.organizationId, params.appId, 'app:update');
    const body = updateAppSchema.parse(request.body);

    const app = await tenancyRepo.updateApp(context.organizationId, params.appId, body);
    await auditRepo.writeAudit({
      organizationId: context.organizationId,
      actorUserId: context.userId,
      action: 'app.updated',
      resourceType: 'app',
      resourceId: params.appId,
      requestId: request.requestId,
      metadata: body,
    });
    return { app };
  });

  /**
   * Set or change the app's primary attribution provider.
   *
   * This is a deliberate, audited, confirmed action. Historical attribution
   * data from the previous MMP is never deleted: every attribution fact keeps
   * its provider provenance, so the old data stays interpretable.
   */
  server.post(
    '/organizations/:organizationId/apps/:appId/attribution-provider',
    async (request) => {
      const params = z
        .object({ organizationId: z.string().uuid(), appId: z.string().uuid() })
        .parse(request.params);
      const { context, app } = await withApp(
        request,
        params.organizationId,
        params.appId,
        'app:update',
      );
      const body = attributionProviderSchema.parse(request.body);

      const previous = app.primary_attribution_provider;
      if (previous === body.provider) {
        return { app, changed: false };
      }

      const updated = await tenancyRepo.updateApp(context.organizationId, params.appId, {
        primaryAttributionProvider: body.provider,
      });

      await auditRepo.writeAudit({
        organizationId: context.organizationId,
        actorUserId: context.userId,
        action: 'app.primary_attribution_provider_changed',
        resourceType: 'app',
        resourceId: params.appId,
        requestId: request.requestId,
        metadata: { from: previous, to: body.provider },
      });

      return {
        app: updated,
        changed: true,
        notice:
          previous === null
            ? 'Attribution provider set. Connect the provider and run the first sync.'
            : `Primary attribution provider changed from ${previous} to ${body.provider}. Historical ${previous} data is retained with its original provenance and is not merged with ${body.provider} data.`,
      };
    },
  );
}

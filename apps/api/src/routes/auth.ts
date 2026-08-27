import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { AppError } from '@mart/shared';
import { getConfig } from '@mart/config';
import { auditRepo, tenancyRepo, withTransaction } from '@mart/db';
import {
  checkPasswordPolicy,
  hashPassword,
  issueSession,
  revokeSession,
  verifyPassword,
} from '@mart/auth';
import { authLimiter } from '../rateLimit.js';
import { requireSession, setNoStore } from '../context.js';

export const CSRF_COOKIE_NAME = 'mart_csrf';

const credentialsSchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(1).max(256),
});

const registerSchema = credentialsSchema.extend({
  displayName: z.string().min(1).max(120),
  organizationName: z.string().min(1).max(120),
});

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${base || 'org'}-${suffix}`;
}

export async function registerAuthRoutes(server: FastifyInstance): Promise<void> {
  const config = getConfig();

  /**
   * Classic double-submit cookies.
   *
   * The session cookie is HttpOnly so script can never read it. The CSRF cookie
   * is deliberately readable, because the browser must echo it in a header -
   * something a cross-site page cannot do, since it cannot read this origin's
   * cookies. Storing only the hash of each server-side keeps a database leak
   * from yielding usable tokens.
   */
  const setAuthCookies = (
    reply: FastifyReply,
    tokens: { token: string; csrfToken: string; expiresAt: Date },
  ): void => {
    reply.setCookie(config.SESSION_COOKIE_NAME, tokens.token, {
      httpOnly: true,
      secure: config.COOKIE_SECURE,
      sameSite: 'lax',
      path: '/',
      expires: tokens.expiresAt,
    });
    reply.setCookie(CSRF_COOKIE_NAME, tokens.csrfToken, {
      httpOnly: false,
      secure: config.COOKIE_SECURE,
      sameSite: 'lax',
      path: '/',
      expires: tokens.expiresAt,
    });
  };

  server.post('/register', async (request, reply) => {
    authLimiter.check(`register:${request.ip}`);
    const body = registerSchema.parse(request.body);

    const policy = checkPasswordPolicy(body.password);
    if (!policy.ok) throw new AppError('validation_failed', policy.reason);

    const existing = await tenancyRepo.findUserForAuthentication(body.email);
    if (existing) {
      // Do not reveal whether an address is registered.
      throw new AppError('conflict', 'That email address cannot be registered');
    }

    const passwordHash = await hashPassword(body.password);
    const result = await withTransaction(async (client) => {
      const user = await tenancyRepo.createUser(
        { email: body.email, passwordHash, displayName: body.displayName },
        client,
      );
      const organization = await tenancyRepo.createOrganization(
        { name: body.organizationName, slug: slugify(body.organizationName), createdBy: user.id },
        client,
      );
      await tenancyRepo.addMembership(
        { organizationId: organization.id, userId: user.id, role: 'owner' },
        client,
      );
      await auditRepo.writeAudit(
        {
          organizationId: organization.id,
          actorUserId: user.id,
          action: 'organization.created',
          resourceType: 'organization',
          resourceId: organization.id,
          requestId: request.requestId,
          metadata: { name: organization.name },
        },
        client,
      );
      return { user, organization };
    });

    const session = await issueSession({
      userId: result.user.id,
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
    });
    setAuthCookies(reply, session);
    setNoStore(reply);

    return reply.status(201).send({
      user: { id: result.user.id, email: result.user.email, displayName: result.user.display_name },
      organization: result.organization,
      csrfToken: session.csrfToken,
    });
  });

  server.post('/login', async (request, reply) => {
    const body = credentialsSchema.parse(request.body);
    const limiterKey = `login:${request.ip}:${body.email.toLowerCase()}`;
    authLimiter.check(limiterKey);

    const user = await tenancyRepo.findUserForAuthentication(body.email);
    // Always run the hash comparison so a missing account and a wrong password
    // take indistinguishable time.
    const valid = user
      ? await verifyPassword(body.password, user.password_hash)
      : await verifyPassword(body.password, 'scrypt$32768$8$1$AAAA$AAAA');
    if (!user || !valid) {
      throw new AppError('unauthenticated', 'Invalid email or password');
    }

    authLimiter.reset(limiterKey);
    await tenancyRepo.markUserLogin(user.id);
    const session = await issueSession({
      userId: user.id,
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
    });
    setAuthCookies(reply, session);
    setNoStore(reply);

    const organizations = await tenancyRepo.listOrganizationsForUser(user.id);
    await auditRepo.writeAudit({
      organizationId: organizations[0]?.id ?? null,
      actorUserId: user.id,
      action: 'auth.signed_in',
      resourceType: 'user',
      resourceId: user.id,
      requestId: request.requestId,
    });

    return {
      user: { id: user.id, email: user.email, displayName: user.display_name },
      organizations,
      csrfToken: session.csrfToken,
    };
  });

  server.post('/logout', async (request, reply) => {
    const token = request.cookies[config.SESSION_COOKIE_NAME];
    if (token) await revokeSession(token);
    if (request.session) {
      await auditRepo.writeAudit({
        organizationId: null,
        actorUserId: request.session.userId,
        action: 'auth.signed_out',
        resourceType: 'user',
        resourceId: request.session.userId,
        requestId: request.requestId,
      });
    }
    reply.clearCookie(config.SESSION_COOKIE_NAME, { path: '/' });
    reply.clearCookie(CSRF_COOKIE_NAME, { path: '/' });
    setNoStore(reply);
    return { ok: true };
  });

  server.get('/me', async (request, reply) => {
    const session = requireSession(request);
    setNoStore(reply);
    const organizations = await tenancyRepo.listOrganizationsForUser(session.userId);
    return {
      user: {
        id: session.userId,
        email: session.email,
        displayName: session.displayName,
      },
      organizations,
    };
  });
}

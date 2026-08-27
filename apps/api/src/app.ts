import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { ZodError } from 'zod';
import { AppError, isProviderError, redact } from '@mart/shared';
import { getConfig } from '@mart/config';
import { getLogger, newRequestId, runWithContext, counters } from '@mart/observability';
import { resolveSession } from '@mart/auth';
import { registerAuthRoutes } from './routes/auth.js';
import { registerOrganizationRoutes } from './routes/organizations.js';
import { registerIntegrationRoutes } from './routes/integrations.js';
import { registerSyncRoutes } from './routes/sync.js';
import { registerAnalyticsRoutes } from './routes/analytics.js';
import { registerHealthRoutes } from './routes/health.js';
import { verifyCsrf } from './context.js';

export async function buildServer(): Promise<FastifyInstance> {
  const config = getConfig();
  const log = getLogger();

  const server = Fastify({
    logger: false,
    trustProxy: true,
    bodyLimit: 1024 * 256,
    // MART generates its own ids so one id follows a request into sync runs,
    // audit records and provider calls.
    genReqId: () => newRequestId(),
  });

  await server.register(cookie, {});

  // ---- security headers ----------------------------------------------------
  server.addHook('onSend', async (_request, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('cross-origin-opener-policy', 'same-origin');
    reply.header('permissions-policy', 'geolocation=(), microphone=(), camera=()');
    if (config.NODE_ENV === 'production') {
      reply.header('strict-transport-security', 'max-age=31536000; includeSubDomains');
    }
    return payload;
  });

  // ---- request context + session resolution --------------------------------
  server.addHook('onRequest', async (request, reply) => {
    request.requestId = String(request.id);
    reply.header('x-request-id', request.requestId);
  });

  server.addHook('preHandler', async (request) => {
    const token = request.cookies[config.SESSION_COOKIE_NAME];
    const session = await resolveSession(token);
    if (session) request.session = session;
  });

  // Everything runs inside a logging context so any log line emitted deep in a
  // provider adapter still carries the request and tenant it belongs to.
  server.addHook('preHandler', async (request, reply) => {
    return new Promise<void>((resolve) => {
      runWithContext(
        {
          requestId: request.requestId,
          ...(request.session ? { userId: request.session.userId } : {}),
        },
        () => {
          void reply; // context established for the remainder of the request
          resolve();
        },
      );
    });
  });

  // ---- error handling ------------------------------------------------------
  server.setErrorHandler((error, request, reply) => {
    const requestId = request.requestId;

    if (error instanceof ZodError) {
      counters.increment('api_errors_total', { code: 'validation_failed' });
      return reply.status(400).send({
        error: {
          code: 'validation_failed',
          message: 'Request validation failed',
          requestId,
          details: {
            issues: error.issues.map((i) => ({
              path: i.path.join('.'),
              message: i.message,
            })),
          },
        },
      });
    }

    if (error instanceof AppError) {
      counters.increment('api_errors_total', { code: error.code });
      if (error.status >= 500) {
        log.error({ err: error.message, code: error.code, requestId }, 'request failed');
      }
      return reply.status(error.status).send({
        error: {
          code: error.code,
          // 5xx detail is never echoed: it can carry internal identifiers.
          message: error.expose ? error.message : 'Something went wrong on our side',
          requestId,
          ...(error.details ? { details: redact(error.details) } : {}),
        },
      });
    }

    if (isProviderError(error)) {
      counters.increment('api_errors_total', { code: 'provider_error' });
      return reply.status(502).send({
        error: {
          code: 'provider_error',
          message: error.userMessage,
          requestId,
          details: { errorClass: error.errorClass, provider: error.provider },
        },
      });
    }

    const fastifyError = error as { statusCode?: number; message?: string };
    const statusCode = typeof fastifyError.statusCode === 'number' ? fastifyError.statusCode : 500;
    if (statusCode >= 500) {
      log.error({ err: fastifyError.message ?? 'unknown', requestId }, 'unhandled error');
    }
    counters.increment('api_errors_total', { code: 'internal_error' });
    return reply.status(statusCode).send({
      error: {
        code: statusCode >= 500 ? 'internal_error' : 'bad_request',
        message:
          statusCode >= 500
            ? 'Something went wrong on our side'
            : (fastifyError.message ?? 'Bad request'),
        requestId,
      },
    });
  });

  server.setNotFoundHandler((request, reply) => {
    reply.status(404).send({
      error: { code: 'not_found', message: 'Route not found', requestId: request.requestId },
    });
  });

  // ---- routes --------------------------------------------------------------
  await server.register(registerHealthRoutes);
  await server.register(
    async (instance) => {
      // CSRF applies to every mutation under /api, including auth.
      instance.addHook('preHandler', async (request) => {
        const method = request.method.toUpperCase();
        if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return;
        // Sign-in and registration establish a session; they are protected by
        // SameSite plus the rate limiter rather than a token that cannot exist yet.
        const path = request.url.split('?')[0] ?? '';
        if (path === '/api/v1/auth/login' || path === '/api/v1/auth/register') return;
        verifyCsrf(request);
      });

      await instance.register(registerAuthRoutes, { prefix: '/v1/auth' });
      await instance.register(registerOrganizationRoutes, { prefix: '/v1' });
      await instance.register(registerIntegrationRoutes, { prefix: '/v1' });
      await instance.register(registerSyncRoutes, { prefix: '/v1' });
      await instance.register(registerAnalyticsRoutes, { prefix: '/v1' });
    },
    { prefix: '/api' },
  );

  return server;
}

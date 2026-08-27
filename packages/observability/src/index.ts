import { AsyncLocalStorage } from 'node:async_hooks';
import pino, { type Logger as PinoLogger } from 'pino';
import { redact, SENSITIVE_KEY_PATTERN, newToken } from '@mart/shared';

export type LogContext = {
  requestId?: string;
  correlationId?: string;
  organizationId?: string;
  userId?: string;
  syncRunId?: string;
  provider?: string;
};

const storage = new AsyncLocalStorage<LogContext>();

export function runWithContext<T>(ctx: LogContext, fn: () => T): T {
  const parent = storage.getStore() ?? {};
  return storage.run({ ...parent, ...ctx }, fn);
}

export function currentContext(): LogContext {
  return storage.getStore() ?? {};
}

export function newRequestId(): string {
  return newToken(12);
}

export type Logger = {
  fatal(obj: Record<string, unknown> | string, msg?: string): void;
  error(obj: Record<string, unknown> | string, msg?: string): void;
  warn(obj: Record<string, unknown> | string, msg?: string): void;
  info(obj: Record<string, unknown> | string, msg?: string): void;
  debug(obj: Record<string, unknown> | string, msg?: string): void;
  child(bindings: Record<string, unknown>): Logger;
};

/**
 * Structured logger.
 *
 * Two independent defences keep secrets out of logs:
 *  1. pino's own `redact` paths for well-known header/body locations, and
 *  2. a recursive redaction of every object we log, keyed off field name.
 */
function createPino(options: { level?: string; pretty?: boolean } = {}): PinoLogger {
  const base = {
    level: options.level ?? process.env.LOG_LEVEL ?? 'info',
    base: { service: 'mart' },
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'headers.authorization',
        'headers.cookie',
        'password',
        'token',
        'apiKey',
        'accessToken',
        'refreshToken',
        'credentials',
        '*.password',
        '*.token',
        '*.apiKey',
        '*.accessToken',
      ],
      censor: '[redacted]',
    },
  };
  if (!options.pretty) return pino(base);
  try {
    // pino-pretty is a development convenience and is not a production
    // dependency; fall back to JSON rather than failing to boot without it.
    return pino({ ...base, transport: { target: 'pino-pretty' } });
  } catch {
    return pino(base);
  }
}

function wrap(instance: PinoLogger): Logger {
  const emit =
    (level: 'fatal' | 'error' | 'warn' | 'info' | 'debug') =>
    (obj: Record<string, unknown> | string, msg?: string): void => {
      const ctx = currentContext();
      if (typeof obj === 'string') {
        instance[level]({ ...ctx }, obj);
      } else {
        instance[level]({ ...ctx, ...redact(obj) }, msg);
      }
    };
  return {
    fatal: emit('fatal'),
    error: emit('error'),
    warn: emit('warn'),
    info: emit('info'),
    debug: emit('debug'),
    child: (bindings) => wrap(instance.child(redact(bindings))),
  };
}

let rootLogger: Logger | null = null;

export function getLogger(): Logger {
  if (!rootLogger) {
    rootLogger = wrap(
      createPino({
        level: process.env.LOG_LEVEL,
        pretty: process.env.LOG_PRETTY === 'true',
      }),
    );
  }
  return rootLogger;
}

export function setLogger(logger: Logger): void {
  rootLogger = logger;
}

/**
 * In-process counters. Deliberately minimal: enough to answer "are syncs
 * failing and how often" without introducing a metrics backend in Phase 0A.
 * Exposed through the API/worker health endpoints.
 */
class Counters {
  private readonly values = new Map<string, number>();

  increment(name: string, labels: Record<string, string> = {}, by = 1): void {
    const key = this.key(name, labels);
    this.values.set(key, (this.values.get(key) ?? 0) + by);
  }

  snapshot(): Record<string, number> {
    return Object.fromEntries(this.values.entries());
  }

  reset(): void {
    this.values.clear();
  }

  private key(name: string, labels: Record<string, string>): string {
    const parts = Object.keys(labels)
      .sort()
      .map((k) => `${k}=${labels[k]}`);
    return parts.length ? `${name}{${parts.join(',')}}` : name;
  }
}

export const counters = new Counters();

/** Guard used in tests and by the audit writer to assert a payload is clean. */
export function containsSensitiveKey(obj: unknown): boolean {
  if (obj === null || typeof obj !== 'object') return false;
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) return true;
    if (containsSensitiveKey(value)) return true;
  }
  return false;
}

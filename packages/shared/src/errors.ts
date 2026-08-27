import type { ProviderErrorClass } from './types.js';

export type AppErrorCode =
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'validation_failed'
  | 'conflict'
  | 'rate_limited'
  | 'provider_error'
  | 'internal_error';

const STATUS_BY_CODE: Record<AppErrorCode, number> = {
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  validation_failed: 400,
  conflict: 409,
  rate_limited: 429,
  provider_error: 502,
  internal_error: 500,
};

/** Application error carrying an HTTP-safe code and non-sensitive details. */
export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly status: number;
  readonly details?: Record<string, unknown>;
  readonly expose: boolean;

  constructor(
    code: AppErrorCode,
    message: string,
    options: { details?: Record<string, unknown>; cause?: unknown; expose?: boolean } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'AppError';
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.details = options.details;
    // 5xx messages are never echoed to clients unless explicitly marked safe.
    this.expose = options.expose ?? this.status < 500;
  }
}

/**
 * A failure raised by an external provider adapter.
 *
 * `userMessage` is deliberately actionable but free of API internals
 * ("Meta access token expired" rather than a raw Graph API error payload).
 */
export class ProviderError extends Error {
  readonly errorClass: ProviderErrorClass;
  readonly provider: string;
  readonly retryable: boolean;
  readonly httpStatus?: number;
  readonly retryAfterMs?: number;
  readonly userMessage: string;
  readonly context?: Record<string, unknown>;

  constructor(args: {
    provider: string;
    errorClass: ProviderErrorClass;
    message: string;
    userMessage?: string;
    retryable?: boolean;
    httpStatus?: number;
    retryAfterMs?: number;
    context?: Record<string, unknown>;
    cause?: unknown;
  }) {
    super(args.message, args.cause !== undefined ? { cause: args.cause } : undefined);
    this.name = 'ProviderError';
    this.provider = args.provider;
    this.errorClass = args.errorClass;
    this.httpStatus = args.httpStatus;
    this.retryAfterMs = args.retryAfterMs;
    this.context = args.context;
    this.retryable = args.retryable ?? false;
    this.userMessage = args.userMessage ?? args.message;
  }
}

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}

export function isProviderError(e: unknown): e is ProviderError {
  return e instanceof ProviderError;
}

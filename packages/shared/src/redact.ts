/** Field names whose values must never reach logs, audit metadata or API responses. */
export const SENSITIVE_KEY_PATTERN =
  /(pass(word)?|secret|token|api[-_]?key|apikey|authorization|auth|credential|private[-_]?key|client[-_]?secret|access[-_]?key|session[-_]?id|cookie|bearer|signature)/i;

export const REDACTED = '[redacted]';

/**
 * Recursively redact sensitive values from an arbitrary object.
 *
 * Used by the logger, the audit writer and the API error serializer, so a
 * credential accidentally attached to a context object still cannot escape.
 */
export function redact<T>(value: T, depth = 0): T {
  if (depth > 8) return REDACTED as unknown as T;
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return value as T;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1)) as unknown as T;
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEY_PATTERN.test(key) ? REDACTED : redact(val, depth + 1);
    }
    return out as unknown as T;
  }
  return value;
}

/** Mask a secret for display. Never returns the full value. */
export function maskSecret(secret: string | null | undefined): string {
  if (!secret) return '';
  return `${secret.slice(0, 4)}...`;
}

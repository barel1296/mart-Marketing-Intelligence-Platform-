import { createHash } from 'node:crypto';

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Stable hash of a fact's dimension tuple.
 *
 * This is the idempotency key for normalized facts: re-running a sync updates
 * the existing row instead of inserting a duplicate. Keys are sorted so field
 * ordering can never change the hash, and null/undefined collapse to '' so a
 * missing dimension is represented in exactly one way.
 */
export function dimensionHash(
  dimensions: Record<string, string | number | null | undefined>,
): string {
  const parts = Object.keys(dimensions)
    .sort()
    .map((key) => {
      const raw = dimensions[key];
      const value = raw === null || raw === undefined ? '' : String(raw);
      return `${key}=${value}`;
    });
  return sha256Hex(parts.join('|'));
}

/** Hash of a raw provider payload, used for ingestion de-duplication. */
export function payloadHash(payload: unknown): string {
  return sha256Hex(typeof payload === 'string' ? payload : JSON.stringify(payload ?? null));
}

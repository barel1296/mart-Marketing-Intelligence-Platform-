import { randomUUID, randomBytes } from 'node:crypto';

export function newId(): string {
  return randomUUID();
}

/** URL-safe opaque token (session ids, CSRF tokens, idempotency keys). */
export function newToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

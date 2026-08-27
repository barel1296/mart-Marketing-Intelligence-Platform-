import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

// OWASP-aligned scrypt parameters (N=2^15, r=8, p=1).
const PARAMS = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

/**
 * Hash a password with scrypt.
 *
 * Format: scrypt$N$r$p$salt_b64$hash_b64 - self-describing so parameters can be
 * raised later without invalidating existing hashes.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const derived = await scrypt(password.normalize('NFKC'), salt, KEY_LENGTH, PARAMS);
  return [
    'scrypt',
    PARAMS.N,
    PARAMS.r,
    PARAMS.p,
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const salt = Buffer.from(parts[4] ?? '', 'base64');
  const expected = Buffer.from(parts[5] ?? '', 'base64');
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p) || expected.length === 0) {
    return false;
  }
  const derived = await scrypt(password.normalize('NFKC'), salt, expected.length, {
    N,
    r,
    p,
    maxmem: PARAMS.maxmem,
  });
  // Constant-time comparison: never leak how much of the hash matched.
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

export type PasswordPolicyResult = { ok: true } | { ok: false; reason: string };

export function checkPasswordPolicy(password: string): PasswordPolicyResult {
  if (password.length < 12) return { ok: false, reason: 'Password must be at least 12 characters' };
  if (password.length > 256)
    return { ok: false, reason: 'Password must be at most 256 characters' };
  if (!/[a-z]/.test(password) || !/[A-Z]/.test(password)) {
    return { ok: false, reason: 'Password must contain upper and lower case letters' };
  }
  if (!/[0-9]/.test(password)) return { ok: false, reason: 'Password must contain a digit' };
  return { ok: true };
}

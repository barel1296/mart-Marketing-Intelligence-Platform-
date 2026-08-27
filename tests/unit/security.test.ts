import { describe, expect, it } from 'vitest';
import { containsSensitiveKey } from '@mart/observability';
import { maskSecret, redact, SENSITIVE_KEY_PATTERN } from '@mart/shared';
import {
  assertPermission,
  checkPasswordPolicy,
  hashPassword,
  ROLE_PERMISSIONS,
  roleHasPermission,
  verifyPassword,
} from '@mart/auth';

describe('secret redaction', () => {
  it('redacts credential-shaped keys at any depth', () => {
    const redacted = redact({
      safe: 'visible',
      accessToken: 'super-secret',
      nested: { apiKey: 'k', deeper: { password: 'p', ok: 1 } },
      list: [{ authorization: 'Bearer x' }],
    }) as Record<string, unknown>;

    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toContain('super-secret');
    expect(serialized).not.toContain('Bearer x');
    expect(serialized).toContain('visible');
    expect(redacted['safe']).toBe('visible');
  });

  it('matches the credential vocabulary providers actually use', () => {
    for (const key of [
      'password',
      'apiKey',
      'api_key',
      'access_token',
      'refreshToken',
      'clientSecret',
      'authorization',
      'privateKey',
      'credentials',
      'sessionId',
      'cookie',
    ]) {
      expect(SENSITIVE_KEY_PATTERN.test(key)).toBe(true);
    }
    for (const key of ['campaignId', 'spend', 'installDate', 'country']) {
      expect(SENSITIVE_KEY_PATTERN.test(key)).toBe(false);
    }
  });

  it('never reveals a full secret when masking for display', () => {
    expect(maskSecret('abcdefghijklmnop')).toBe('abcd...');
    expect(maskSecret(null)).toBe('');
  });

  it('detects sensitive keys in audit metadata before it is written', () => {
    expect(containsSensitiveKey({ providerKey: 'meta_ads', ok: true })).toBe(false);
    expect(containsSensitiveKey({ providerKey: 'meta_ads', accessToken: 'x' })).toBe(true);
    expect(containsSensitiveKey({ nested: { deep: { apiToken: 'x' } } })).toBe(true);
  });
});

describe('password handling', () => {
  it('round-trips a password through scrypt without storing it', async () => {
    const hash = await hashPassword('CorrectHorse123!');
    expect(hash).not.toContain('CorrectHorse123!');
    expect(hash.startsWith('scrypt$')).toBe(true);
    expect(await verifyPassword('CorrectHorse123!', hash)).toBe(true);
    expect(await verifyPassword('wrong-password-1A', hash)).toBe(false);
  });

  it('produces a different hash for the same password (unique salt)', async () => {
    const a = await hashPassword('CorrectHorse123!');
    const b = await hashPassword('CorrectHorse123!');
    expect(a).not.toBe(b);
  });

  it('rejects malformed stored hashes rather than throwing', async () => {
    expect(await verifyPassword('x', 'not-a-hash')).toBe(false);
    expect(await verifyPassword('x', 'scrypt$1$2$3$4')).toBe(false);
  });

  it('enforces a minimum password policy', () => {
    expect(checkPasswordPolicy('short1A').ok).toBe(false);
    expect(checkPasswordPolicy('alllowercase123').ok).toBe(false);
    expect(checkPasswordPolicy('NoDigitsHereAtAll').ok).toBe(false);
    expect(checkPasswordPolicy('GoodPassword123').ok).toBe(true);
  });
});

describe('role-based access control', () => {
  it('gives viewers read access and no mutation rights', () => {
    expect(roleHasPermission('viewer', 'metrics:read')).toBe(true);
    expect(roleHasPermission('viewer', 'integration:read')).toBe(true);
    expect(roleHasPermission('viewer', 'integration:connect')).toBe(false);
    expect(roleHasPermission('viewer', 'sync:trigger')).toBe(false);
    expect(roleHasPermission('viewer', 'app:create')).toBe(false);
  });

  it('lets analysts trigger syncs but not change integrations', () => {
    expect(roleHasPermission('analyst', 'sync:trigger')).toBe(true);
    expect(roleHasPermission('analyst', 'integration:connect')).toBe(false);
    expect(roleHasPermission('analyst', 'integration:manage_credentials')).toBe(false);
    expect(roleHasPermission('analyst', 'org:manage_members')).toBe(false);
    expect(roleHasPermission('analyst', 'mapping:verify')).toBe(false);
  });

  it('lets admins manage integrations but reserves org settings for owners', () => {
    expect(roleHasPermission('admin', 'integration:connect')).toBe(true);
    expect(roleHasPermission('admin', 'integration:manage_credentials')).toBe(true);
    expect(roleHasPermission('admin', 'mapping:verify')).toBe(true);
    expect(roleHasPermission('admin', 'org:manage_settings')).toBe(false);
    expect(roleHasPermission('owner', 'org:manage_settings')).toBe(true);
  });

  it('is strictly cumulative from viewer to owner', () => {
    const ladder = [
      ['viewer', 'analyst'],
      ['analyst', 'admin'],
      ['admin', 'owner'],
    ] as const;
    for (const [lowerRole, higherRole] of ladder) {
      for (const permission of ROLE_PERMISSIONS[lowerRole]) {
        expect(ROLE_PERMISSIONS[higherRole]).toContain(permission);
      }
    }
  });

  it('throws a forbidden error naming the missing permission', () => {
    expect(() => assertPermission('viewer', 'integration:connect')).toThrowError(
      /integration:connect/,
    );
    expect(() => assertPermission('owner', 'integration:connect')).not.toThrow();
  });
});

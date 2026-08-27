import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { queryRows } from '@mart/db';
import { getCredentialStore } from '@mart/integrations';
import {
  addMember,
  closeServer,
  connectProvider,
  createApp,
  getServer,
  registerUser,
  request,
  truncateAll,
  type TestUser,
} from './helpers.js';
import { installFakeProviders, removeFakeProviders, resetControls } from './fakeProviders.js';

describe('authentication', () => {
  beforeAll(() => installFakeProviders());
  afterAll(async () => {
    removeFakeProviders();
    await closeServer();
  });
  beforeEach(async () => {
    await truncateAll();
    resetControls();
  });

  it('rejects unauthenticated access to every protected route', async () => {
    const paths = [
      '/api/v1/auth/me',
      '/api/v1/organizations',
      `/api/v1/organizations/${'00000000-0000-0000-0000-000000000001'}/apps`,
      `/api/v1/organizations/${'00000000-0000-0000-0000-000000000001'}/connections`,
    ];
    for (const path of paths) {
      const response = await request(null, 'GET', path);
      expect.soft(response.statusCode, path).toBe(401);
    }
  });

  it('signs in, exposes identity, and signs out', async () => {
    const user = await registerUser();
    const me = await request(user, 'GET', '/api/v1/auth/me');
    expect(me.statusCode).toBe(200);
    expect((me.json() as { user: { email: string } }).user.email).toBe(user.email);

    const app = await getServer();
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: user.email, password: user.password },
    });
    expect(login.statusCode).toBe(200);

    const logout = await request(user, 'POST', '/api/v1/auth/logout', {});
    expect(logout.statusCode).toBe(200);

    const afterLogout = await request(user, 'GET', '/api/v1/auth/me');
    expect(afterLogout.statusCode).toBe(401);
  });

  it('rejects a wrong password without revealing whether the account exists', async () => {
    const user = await registerUser();
    const app = await getServer();
    const wrongPassword = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: user.email, password: 'WrongPassword123' },
    });
    const unknownUser = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'nobody@example.com', password: 'WrongPassword123' },
    });
    expect(wrongPassword.statusCode).toBe(401);
    expect(unknownUser.statusCode).toBe(401);
    // Identical apart from the per-request id: the response must not tell an
    // attacker which of the two failure modes occurred.
    const strip = (body: unknown) => {
      const parsed = body as { error: { code: string; message: string } };
      return { code: parsed.error.code, message: parsed.error.message };
    };
    expect(strip(wrongPassword.json())).toEqual(strip(unknownUser.json()));
  });

  it('never stores or returns a password', async () => {
    const user = await registerUser();
    const rows = await queryRows<{ password_hash: string }>(
      'SELECT password_hash FROM users WHERE id = $1',
      [user.userId],
    );
    expect(rows[0]?.password_hash).not.toContain(user.password);
    expect(rows[0]?.password_hash.startsWith('scrypt$')).toBe(true);

    const me = await request(user, 'GET', '/api/v1/auth/me');
    expect(JSON.stringify(me.json())).not.toContain('password');
  });

  it('requires a CSRF header on mutations', async () => {
    const user = await registerUser();
    const app = await getServer();
    // Cookie present, CSRF header absent: the classic cross-site request shape.
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${user.organizationId}/apps`,
      headers: { cookie: user.cookie },
      payload: { name: 'X', platform: 'ios', bundleId: 'com.x.y' },
    });
    expect(response.statusCode).toBe(403);
    expect((response.json() as { error: { message: string } }).error.message).toMatch(/CSRF/i);
  });

  it('rejects a forged CSRF token', async () => {
    const user = await registerUser();
    const app = await getServer();
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${user.organizationId}/apps`,
      headers: { cookie: user.cookie, 'x-mart-csrf': 'forged-token' },
      payload: { name: 'X', platform: 'ios', bundleId: 'com.x.y' },
    });
    expect(response.statusCode).toBe(403);
  });

  it('validates request bodies and reports the offending field', async () => {
    const user = await registerUser();
    const response = await request(
      user,
      'POST',
      `/api/v1/organizations/${user.organizationId}/apps`,
      {
        name: '',
        platform: 'windows',
        bundleId: 'com.x.y',
      },
    );
    expect(response.statusCode).toBe(400);
    const body = response.json() as {
      error: { code: string; details: { issues: Array<{ path: string }> } };
    };
    expect(body.error.code).toBe('validation_failed');
    expect(body.error.details.issues.map((i) => i.path)).toContain('platform');
  });

  it('returns a request id on every response for traceability', async () => {
    const user = await registerUser();
    const response = await request(user, 'GET', '/api/v1/auth/me');
    expect(response.headers['x-request-id']).toBeTruthy();
  });
});

describe('role-based access control', () => {
  let owner: TestUser;
  let viewer: TestUser;
  let analyst: TestUser;
  let admin: TestUser;
  let app: { id: string };

  beforeAll(() => installFakeProviders());
  afterAll(async () => {
    removeFakeProviders();
    await closeServer();
  });

  beforeEach(async () => {
    await truncateAll();
    resetControls();
    owner = await registerUser({ organizationName: 'RBAC Org' });
    viewer = await registerUser();
    analyst = await registerUser();
    admin = await registerUser();
    app = await createApp(owner);

    await addMember(owner, owner.organizationId, viewer.email, 'viewer');
    await addMember(owner, owner.organizationId, analyst.email, 'analyst');
    await addMember(owner, owner.organizationId, admin.email, 'admin');
  });

  const asOrg = (user: TestUser, path: string) =>
    `/api/v1/organizations/${owner.organizationId}${path}`;

  it('lets a viewer read but not mutate integrations', async () => {
    const read = await request(viewer, 'GET', asOrg(viewer, '/connections'));
    expect(read.statusCode).toBe(200);

    const connect = await request(viewer, 'POST', asOrg(viewer, '/connections'), {
      providerKey: 'meta_ads',
      credentials: { accessToken: 'a'.repeat(40) },
    });
    expect(connect.statusCode).toBe(403);
    expect((connect.json() as { error: { code: string } }).error.code).toBe('forbidden');
  });

  it('does not let a viewer trigger a sync or create an app', async () => {
    const sync = await request(viewer, 'POST', asOrg(viewer, `/apps/${app.id}/sync`), {});
    expect(sync.statusCode).toBe(403);

    const created = await request(viewer, 'POST', asOrg(viewer, '/apps'), {
      name: 'Nope',
      platform: 'ios',
      bundleId: 'com.nope.app',
    });
    expect(created.statusCode).toBe(403);
  });

  it('lets an analyst trigger a sync but not manage integrations or members', async () => {
    const connect = await request(analyst, 'POST', asOrg(analyst, '/connections'), {
      providerKey: 'meta_ads',
      credentials: { accessToken: 'a'.repeat(40) },
    });
    expect(connect.statusCode).toBe(403);

    const member = await request(analyst, 'POST', asOrg(analyst, '/members'), {
      email: viewer.email,
      role: 'admin',
    });
    expect(member.statusCode).toBe(403);

    // Sync trigger is allowed by role; it fails validation only because no
    // provider is bound yet, which proves the authorization check passed.
    const sync = await request(analyst, 'POST', asOrg(analyst, `/apps/${app.id}/sync`), {});
    expect(sync.statusCode).toBe(400);
  });

  it('lets an admin connect integrations', async () => {
    const connect = await request(admin, 'POST', asOrg(admin, '/connections'), {
      providerKey: 'meta_ads',
      credentials: { accessToken: 'a'.repeat(40) },
    });
    expect(connect.statusCode).toBe(201);
  });

  it('does not let an admin change organization settings reserved for owners', async () => {
    const members = await request(admin, 'GET', asOrg(admin, '/members'));
    expect(members.statusCode).toBe(200);
    const permissions = (members.json() as { permissions: string[] }).permissions;
    expect(permissions).not.toContain('org:manage_settings');
  });

  it('does not let a viewer verify a mapping', async () => {
    const response = await request(
      viewer,
      'POST',
      asOrg(viewer, `/apps/${app.id}/mappings/00000000-0000-0000-0000-000000000001/verify`),
      { decision: 'verify' },
    );
    expect(response.statusCode).toBe(403);
  });
});

describe('credential security', () => {
  let user: TestUser;
  const secret = 'meta-secret-token-value-1234567890';

  beforeAll(() => installFakeProviders());
  afterAll(async () => {
    removeFakeProviders();
    await closeServer();
  });

  beforeEach(async () => {
    await truncateAll();
    resetControls();
    user = await registerUser();
  });

  it('encrypts credentials at rest so the plaintext never appears in the database', async () => {
    const { connectionId } = await connectProvider(user, 'meta_ads', { accessToken: secret });

    const rows = await queryRows<{ ciphertext: Buffer; iv: Buffer; fingerprint: string }>(
      'SELECT ciphertext, iv, fingerprint FROM integration_credentials WHERE connection_id = $1',
      [connectionId],
    );
    expect(rows).toHaveLength(1);
    const ciphertext = rows[0]?.ciphertext;
    expect(ciphertext).toBeInstanceOf(Buffer);
    expect(ciphertext?.toString('utf8')).not.toContain(secret);
    expect(rows[0]?.fingerprint).not.toContain(secret);

    // A full-table scan of every text column must not contain the secret.
    const dump = await queryRows<{ payload: string }>(
      `SELECT COALESCE(string_agg(t::text, ' '), '') AS payload FROM integration_credentials t`,
    );
    expect(dump[0]?.payload ?? '').not.toContain(secret);
  });

  it('decrypts only for the owning organization', async () => {
    const { connectionId } = await connectProvider(user, 'meta_ads', { accessToken: secret });
    const store = getCredentialStore();

    const own = await store.get({ organizationId: user.organizationId, connectionId });
    expect(own).toEqual({ kind: 'meta_ads', accessToken: secret });

    const other = await registerUser();
    await expect(store.get({ organizationId: other.organizationId, connectionId })).rejects.toThrow(
      /does not belong/i,
    );
  });

  it('never returns credentials from any API response', async () => {
    await connectProvider(user, 'meta_ads', { accessToken: secret });
    const responses = await Promise.all([
      request(user, 'GET', `/api/v1/organizations/${user.organizationId}/connections`),
      request(user, 'GET', `/api/v1/organizations/${user.organizationId}/providers`),
      request(user, 'GET', `/api/v1/organizations/${user.organizationId}/audit`),
    ]);
    for (const response of responses) {
      expect.soft(response.body).not.toContain(secret);
    }

    // The connection view carries credential metadata only - no value, and no
    // field that could hold one. (The provider catalogue does name the form
    // field 'accessToken', which is a schema description, not a secret.)
    const connections = responses[0];
    expect(connections?.body).not.toContain('accessToken');
    expect(connections?.body).not.toContain('ciphertext');
    const parsed = connections?.json() as {
      connections: Array<{ credential: Record<string, unknown> }>;
    };
    expect(Object.keys(parsed.connections[0]?.credential ?? {}).sort()).toEqual([
      'expiresAt',
      'fingerprint',
      'rotatedAt',
    ]);
  });

  it('exposes only a fingerprint, and the fingerprint changes when the credential does', async () => {
    const { connectionId } = await connectProvider(user, 'meta_ads', { accessToken: secret });
    const before = await request(
      user,
      'GET',
      `/api/v1/organizations/${user.organizationId}/connections`,
    );
    const firstFingerprint = (
      before.json() as { connections: Array<{ credential: { fingerprint: string } }> }
    ).connections[0]?.credential.fingerprint;
    expect(firstFingerprint).toBeTruthy();

    const replaced = await request(
      user,
      'POST',
      `/api/v1/organizations/${user.organizationId}/connections/${connectionId}/credentials`,
      { credentials: { accessToken: 'a-completely-different-token-value' } },
    );
    expect(replaced.statusCode).toBe(200);
    const newFingerprint = (replaced.json() as { credential: { fingerprint: string } }).credential
      .fingerprint;
    expect(newFingerprint).not.toBe(firstFingerprint);
  });

  it('keeps credentials out of the audit log', async () => {
    await connectProvider(user, 'meta_ads', { accessToken: secret });
    const rows = await queryRows<{ metadata: Record<string, unknown> }>(
      'SELECT metadata FROM audit_log WHERE organization_id = $1',
      [user.organizationId],
    );
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain(secret);
  });

  it('deletes the credential when the connection is disconnected', async () => {
    const { connectionId } = await connectProvider(user, 'meta_ads', { accessToken: secret });
    await request(
      user,
      'POST',
      `/api/v1/organizations/${user.organizationId}/connections/${connectionId}/disconnect`,
      {},
    );
    const rows = await queryRows('SELECT 1 FROM integration_credentials WHERE connection_id = $1', [
      connectionId,
    ]);
    expect(rows).toHaveLength(0);
  });
});

describe('audit log', () => {
  beforeAll(() => installFakeProviders());
  afterAll(async () => {
    removeFakeProviders();
    await closeServer();
  });
  beforeEach(async () => {
    await truncateAll();
    resetControls();
  });

  it('is append-only at the database level', async () => {
    const user = await registerUser();
    await expect(
      queryRows("UPDATE audit_log SET action = 'tampered' WHERE organization_id = $1", [
        user.organizationId,
      ]),
    ).rejects.toThrow();
    await expect(
      queryRows('DELETE FROM audit_log WHERE organization_id = $1', [user.organizationId]),
    ).rejects.toThrow();
  });

  it('records the security-sensitive actions Phase 0A requires', async () => {
    const user = await registerUser();
    const app = await createApp(user);
    await connectProvider(user, 'appsflyer', { apiToken: 'x'.repeat(40) });
    await request(
      user,
      'POST',
      `/api/v1/organizations/${user.organizationId}/apps/${app.id}/attribution-provider`,
      { provider: 'appsflyer', confirmSwitch: true },
    );

    const response = await request(
      user,
      'GET',
      `/api/v1/organizations/${user.organizationId}/audit`,
    );
    const actions = (response.json() as { entries: Array<{ action: string }> }).entries.map(
      (e) => e.action,
    );
    expect(actions).toContain('organization.created');
    expect(actions).toContain('app.created');
    expect(actions).toContain('integration.connected');
    expect(actions).toContain('app.primary_attribution_provider_changed');
  });
});

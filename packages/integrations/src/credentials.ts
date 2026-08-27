import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { AppError } from '@mart/shared';
import { getConfig } from '@mart/config';
import { credentialsRepo, type Queryable } from '@mart/db';

/**
 * Provider credential shapes.
 *
 * These values only ever exist in memory inside the API/worker process and as
 * ciphertext at rest. They are never returned by any API route.
 */
export type MetaAdsCredentials = { kind: 'meta_ads'; accessToken: string };
export type AppsFlyerCredentials = { kind: 'appsflyer'; apiToken: string };
export type TenjinCredentials = { kind: 'tenjin'; apiKey: string };

export type ProviderCredentials = MetaAdsCredentials | AppsFlyerCredentials | TenjinCredentials;

export type CredentialMetadata = {
  fingerprint: string;
  expiresAt: Date | null;
  rotatedAt: Date | null;
};

/**
 * Storage abstraction.
 *
 * The local implementation encrypts with AES-256-GCM under a server-side master
 * key. A managed implementation (AWS KMS, GCP Secret Manager, Vault) can be
 * substituted without touching adapters or routes, because nothing outside this
 * module knows how a credential is persisted.
 */
export interface CredentialStore {
  put(
    input: {
      organizationId: string;
      connectionId: string;
      credentials: ProviderCredentials;
      expiresAt?: Date | null;
    },
    client?: Queryable,
  ): Promise<CredentialMetadata>;

  get(
    input: { organizationId: string; connectionId: string },
    client?: Queryable,
  ): Promise<ProviderCredentials | null>;

  metadata(connectionId: string, client?: Queryable): Promise<CredentialMetadata | null>;

  delete(connectionId: string, client?: Queryable): Promise<void>;
}

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;

function masterKey(): Buffer {
  const key = Buffer.from(getConfig().MART_CREDENTIAL_KEY, 'base64');
  if (key.length !== 32) {
    throw new AppError('internal_error', 'Credential encryption key is misconfigured');
  }
  return key;
}

/**
 * Non-reversible fingerprint, used to tell whether a credential changed without
 * ever comparing or displaying plaintext.
 */
export function fingerprintCredentials(credentials: ProviderCredentials): string {
  return createHmac('sha256', masterKey())
    .update(JSON.stringify(credentials))
    .digest('hex')
    .slice(0, 32);
}

export class EncryptedDbCredentialStore implements CredentialStore {
  async put(
    input: {
      organizationId: string;
      connectionId: string;
      credentials: ProviderCredentials;
      expiresAt?: Date | null;
    },
    client?: Queryable,
  ): Promise<CredentialMetadata> {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, masterKey(), iv);
    // Binding the tenant and connection into the AAD means ciphertext copied to
    // another row fails authentication instead of silently decrypting.
    cipher.setAAD(Buffer.from(`${input.organizationId}:${input.connectionId}`));
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(input.credentials), 'utf8'),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();
    const fingerprint = fingerprintCredentials(input.credentials);

    await credentialsRepo.putEncryptedCredential(
      {
        organizationId: input.organizationId,
        connectionId: input.connectionId,
        algorithm: ALGORITHM,
        keyVersion: 'local-v1',
        ciphertext,
        iv,
        authTag,
        fingerprint,
        expiresAt: input.expiresAt ?? null,
      },
      client,
    );

    return { fingerprint, expiresAt: input.expiresAt ?? null, rotatedAt: new Date() };
  }

  async get(
    input: { organizationId: string; connectionId: string },
    client?: Queryable,
  ): Promise<ProviderCredentials | null> {
    const row = await credentialsRepo.getEncryptedCredential(input.connectionId, client);
    if (!row) return null;
    // Defence in depth: the row is also scoped by connection, but a mismatched
    // tenant must never decrypt.
    if (row.organization_id !== input.organizationId) {
      throw new AppError('forbidden', 'Credential does not belong to this organization');
    }
    try {
      const decipher = createDecipheriv(ALGORITHM, masterKey(), row.iv);
      decipher.setAAD(Buffer.from(`${row.organization_id}:${row.connection_id}`));
      decipher.setAuthTag(row.auth_tag);
      const plaintext = Buffer.concat([decipher.update(row.ciphertext), decipher.final()]);
      return JSON.parse(plaintext.toString('utf8')) as ProviderCredentials;
    } catch (error) {
      // A failure here means the key rotated or the row was tampered with.
      throw new AppError('internal_error', 'Stored credential could not be decrypted', {
        cause: error,
      });
    }
  }

  async metadata(connectionId: string, client?: Queryable): Promise<CredentialMetadata | null> {
    const row = await credentialsRepo.getCredentialMetadata(connectionId, client);
    if (!row) return null;
    return {
      fingerprint: row.fingerprint,
      expiresAt: row.expires_at,
      rotatedAt: row.rotated_at,
    };
  }

  async delete(connectionId: string, client?: Queryable): Promise<void> {
    await credentialsRepo.deleteCredential(connectionId, client);
  }
}

let store: CredentialStore | null = null;

export function getCredentialStore(): CredentialStore {
  if (!store) store = new EncryptedDbCredentialStore();
  return store;
}

/** Test seam for substituting a managed store. */
export function setCredentialStore(next: CredentialStore | null): void {
  store = next;
}

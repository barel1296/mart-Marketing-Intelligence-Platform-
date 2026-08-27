import { queryOne, query, type Queryable } from '../pool.js';

/**
 * Raw credential storage.
 *
 * This module is intentionally the only place that touches integration_credentials.
 * It stores ciphertext only and has no plaintext concept: encryption and
 * decryption live in packages/integrations/credentials, so the database layer
 * cannot leak a secret even if misused.
 */
export type EncryptedCredentialRow = {
  connection_id: string;
  organization_id: string;
  algorithm: string;
  key_version: string;
  ciphertext: Buffer;
  iv: Buffer;
  auth_tag: Buffer;
  fingerprint: string;
  expires_at: Date | null;
  rotated_at: Date | null;
  updated_at: Date;
};

export async function putEncryptedCredential(
  input: {
    organizationId: string;
    connectionId: string;
    algorithm: string;
    keyVersion: string;
    ciphertext: Buffer;
    iv: Buffer;
    authTag: Buffer;
    fingerprint: string;
    expiresAt?: Date | null;
  },
  client?: Queryable,
): Promise<void> {
  await query(
    `INSERT INTO integration_credentials
       (organization_id, connection_id, algorithm, key_version, ciphertext, iv, auth_tag, fingerprint, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (connection_id) DO UPDATE SET
       algorithm = EXCLUDED.algorithm,
       key_version = EXCLUDED.key_version,
       ciphertext = EXCLUDED.ciphertext,
       iv = EXCLUDED.iv,
       auth_tag = EXCLUDED.auth_tag,
       fingerprint = EXCLUDED.fingerprint,
       expires_at = EXCLUDED.expires_at,
       rotated_at = now()`,
    [
      input.organizationId,
      input.connectionId,
      input.algorithm,
      input.keyVersion,
      input.ciphertext,
      input.iv,
      input.authTag,
      input.fingerprint,
      input.expiresAt ?? null,
    ],
    client,
  );
}

export async function getEncryptedCredential(
  connectionId: string,
  client?: Queryable,
): Promise<EncryptedCredentialRow | null> {
  return queryOne<EncryptedCredentialRow>(
    `SELECT connection_id, organization_id, algorithm, key_version, ciphertext, iv, auth_tag,
            fingerprint, expires_at, rotated_at, updated_at
     FROM integration_credentials WHERE connection_id = $1`,
    [connectionId],
    client,
  );
}

/** Metadata safe to expose in an API response (never the ciphertext itself). */
export async function getCredentialMetadata(
  connectionId: string,
  client?: Queryable,
): Promise<{ fingerprint: string; expires_at: Date | null; rotated_at: Date | null } | null> {
  return queryOne(
    `SELECT fingerprint, expires_at, rotated_at
     FROM integration_credentials WHERE connection_id = $1`,
    [connectionId],
    client,
  );
}

export async function deleteCredential(connectionId: string, client?: Queryable): Promise<void> {
  await query(
    'DELETE FROM integration_credentials WHERE connection_id = $1',
    [connectionId],
    client,
  );
}

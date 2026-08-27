import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { getLogger } from '@mart/observability';
import { getPool, query, type Queryable } from './pool.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// Works from both src (tsx/vitest) and dist (compiled) layouts.
export const MIGRATIONS_DIR = path.resolve(here, '..', 'migrations');

export type MigrationRecord = {
  version: string;
  name: string;
  checksum: string;
};

async function ensureMigrationsTable(client: Queryable): Promise<void> {
  await query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version     text PRIMARY KEY,
       name        text NOT NULL,
       checksum    text NOT NULL,
       applied_at  timestamptz NOT NULL DEFAULT now()
     )`,
    [],
    client,
  );
}

export async function listMigrationFiles(): Promise<
  Array<{ version: string; name: string; file: string }>
> {
  const entries = await readdir(MIGRATIONS_DIR);
  return entries
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((file) => {
      const version = file.slice(0, file.indexOf('_'));
      return { version, name: file.replace(/\.sql$/, ''), file: path.join(MIGRATIONS_DIR, file) };
    });
}

/**
 * Apply pending migrations inside a single transaction.
 *
 * Checksums are verified on every run: editing an already-applied migration is
 * an error rather than a silent divergence between environments.
 */
export async function migrate(): Promise<{ applied: string[]; alreadyApplied: string[] }> {
  const log = getLogger();
  const files = await listMigrationFiles();
  const client = await getPool().connect();
  const applied: string[] = [];
  const alreadyApplied: string[] = [];

  try {
    await client.query('BEGIN');
    // Serialize concurrent migrators (api + worker booting together).
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['mart_schema_migrations']);
    await ensureMigrationsTable(client);

    const existing = new Map<string, MigrationRecord>();
    const rows = await client.query<MigrationRecord>(
      'SELECT version, name, checksum FROM schema_migrations',
    );
    for (const row of rows.rows) existing.set(row.version, row);

    for (const migration of files) {
      const sql = await readFile(migration.file, 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const prior = existing.get(migration.version);

      if (prior) {
        if (prior.checksum !== checksum) {
          throw new Error(
            `Migration ${migration.name} was modified after being applied ` +
              `(expected checksum ${prior.checksum}, found ${checksum}). ` +
              'Create a new migration instead of editing an applied one.',
          );
        }
        alreadyApplied.push(migration.name);
        continue;
      }

      log.info({ migration: migration.name }, 'applying migration');
      await client.query(sql);
      await client.query(
        'INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)',
        [migration.version, migration.name, checksum],
      );
      applied.push(migration.name);
    }

    await client.query('COMMIT');
    return { applied, alreadyApplied };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Drop and recreate the public schema. Never callable against production. */
export async function resetSchema(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('resetSchema is not permitted in production');
  }
  await query('DROP SCHEMA IF EXISTS public CASCADE');
  await query('CREATE SCHEMA public');
}

import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll } from 'vitest';

/**
 * Integration test environment.
 *
 * These tests run against a real PostgreSQL database, because the properties
 * they assert - tenant isolation, upsert idempotency, append-only audit - are
 * database behaviour and cannot be proven against a mock.
 */
process.env['NODE_ENV'] = 'test';
process.env['DATABASE_URL'] =
  process.env['TEST_DATABASE_URL'] ?? 'postgres://mart:mart_local_dev@localhost:5432/mart_test';
process.env['MART_CREDENTIAL_KEY'] =
  process.env['TEST_MART_CREDENTIAL_KEY'] ?? randomBytes(32).toString('base64');
process.env['LOG_LEVEL'] = process.env['TEST_LOG_LEVEL'] ?? 'silent';
process.env['LOG_PRETTY'] = 'false';
process.env['COOKIE_SECURE'] = 'false';
process.env['SYNC_WINDOW_CHUNK_DAYS'] = '7';
process.env['SYNC_RESTATEMENT_LOOKBACK_DAYS'] = '3';
process.env['SYNC_DEFAULT_BACKFILL_DAYS'] = '30';

/*
 * Provider base URLs point at a loopback port that is only listening while the
 * fixture-provider test is running. Any other test that reached a network would
 * fail loudly with a connection error rather than silently hitting a real API.
 */
process.env['META_GRAPH_BASE_URL'] = 'http://127.0.0.1:4917';
process.env['APPSFLYER_BASE_URL'] = 'http://127.0.0.1:4917';
process.env['TENJIN_BASE_URL'] = 'http://127.0.0.1:4917';

const { migrate, resetSchema, closePool } = await import('@mart/db');

beforeAll(async () => {
  // A clean schema per run keeps migrations themselves under test.
  await resetSchema();
  const result = await migrate();
  if (result.applied.length === 0) {
    throw new Error('Expected migrations to apply against a freshly reset schema');
  }
}, 60_000);

afterAll(async () => {
  await closePool();
});

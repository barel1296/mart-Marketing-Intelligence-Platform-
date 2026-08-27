import pg from 'pg';
import { getConfig } from '@mart/config';
import { getLogger, counters } from '@mart/observability';
import { AppError } from '@mart/shared';

const { Pool } = pg;

/** Anything that can run a parameterized query: the pool or a transaction client. */
export interface Queryable {
  query<T extends pg.QueryResultRow = pg.QueryResultRow>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<pg.QueryResult<T>>;
}

let pool: pg.Pool | null = null;

// numeric/int8 are returned as strings by node-postgres to avoid precision loss.
// MART money and count values are read through explicit converters, so we opt
// into numbers only where the magnitude is provably safe (bigint counters are
// parsed by the repository layer).
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => v);
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => v);
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);

export function getPool(): pg.Pool {
  if (pool) return pool;
  const config = getConfig();
  pool = new Pool({
    connectionString: config.DATABASE_URL,
    max: config.DATABASE_POOL_MAX,
    statement_timeout: config.DATABASE_STATEMENT_TIMEOUT_MS,
    application_name: 'mart',
  });
  pool.on('error', (err) => {
    getLogger().error({ err: err.message }, 'postgres pool error');
    counters.increment('db_pool_errors_total');
  });
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

const SLOW_QUERY_MS = 500;

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  sql: string,
  params: readonly unknown[] = [],
  client: Queryable = getPool(),
): Promise<pg.QueryResult<T>> {
  const started = Date.now();
  try {
    const result = await client.query<T>(sql, params);
    const elapsed = Date.now() - started;
    counters.increment('db_queries_total');
    if (elapsed > SLOW_QUERY_MS) {
      // Log the statement shape only; parameters may contain business data.
      getLogger().warn({ elapsedMs: elapsed, sql: sql.slice(0, 200) }, 'slow query');
      counters.increment('db_slow_queries_total');
    }
    return result;
  } catch (error) {
    counters.increment('db_query_errors_total');
    const message = error instanceof Error ? error.message : 'query failed';
    getLogger().error({ sql: sql.slice(0, 200), err: message }, 'database query failed');
    throw new AppError('internal_error', 'Database query failed', { cause: error });
  }
}

export async function queryRows<T extends pg.QueryResultRow = pg.QueryResultRow>(
  sql: string,
  params: readonly unknown[] = [],
  client: Queryable = getPool(),
): Promise<T[]> {
  return (await query<T>(sql, params, client)).rows;
}

export async function queryOne<T extends pg.QueryResultRow = pg.QueryResultRow>(
  sql: string,
  params: readonly unknown[] = [],
  client: Queryable = getPool(),
): Promise<T | null> {
  const rows = await queryRows<T>(sql, params, client);
  return rows[0] ?? null;
}

export async function withTransaction<T>(fn: (client: Queryable) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Rolling back a broken connection can itself fail; the original error wins.
    }
    throw error;
  } finally {
    client.release();
  }
}

/** Parse a bigint column returned as text. */
export function toNumber(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** Parse a numeric(20,6) money column returned as text, preserving null. */
export function toNullableNumber(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

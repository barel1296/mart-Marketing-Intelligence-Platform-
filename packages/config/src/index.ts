import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';

/**
 * Load a local `.env`, if there is one.
 *
 * Node's loader never overrides a variable that is already set, so a real
 * deployment's environment always wins and a test that sets its own values
 * before importing this module is unaffected. This exists so that
 * `pnpm db:migrate` in a fresh checkout behaves the way the README says it
 * does, rather than failing on a variable that is sitting in a file two
 * directories up.
 */
function loadDotEnv(): void {
  let directory = resolve(process.cwd());
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = join(directory, '.env');
    if (existsSync(candidate)) {
      try {
        process.loadEnvFile(candidate);
      } catch {
        // An unreadable or malformed .env must not stop the process: the schema
        // below will report precisely what is missing.
      }
      return;
    }
    const parent = dirname(directory);
    if (parent === directory) return;
    directory = parent;
  }
}

/**
 * Runtime configuration.
 *
 * Every environment variable MART depends on is declared here and validated at
 * process start, so a misconfigured deployment fails immediately and loudly
 * instead of failing later inside a sync run.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  // --- HTTP -----------------------------------------------------------------
  API_PORT: z.coerce.number().int().positive().default(4000),
  API_HOST: z.string().default('0.0.0.0'),
  /** Public origin of the web app, used for cookie + CORS decisions. */
  WEB_ORIGIN: z.string().url().default('http://localhost:3000'),

  // --- Database -------------------------------------------------------------
  DATABASE_URL: z.string().min(1),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),
  DATABASE_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),

  // --- Security -------------------------------------------------------------
  /**
   * Base64-encoded 32-byte key used by the local encrypted credential store.
   * In production this is replaced by a managed KMS-backed store; see
   * packages/integrations/src/credentials.
   */
  MART_CREDENTIAL_KEY: z
    .string()
    .min(1)
    .refine((v) => Buffer.from(v, 'base64').length === 32, {
      message: 'MART_CREDENTIAL_KEY must be a base64-encoded 32-byte key',
    }),
  SESSION_COOKIE_NAME: z.string().default('mart_session'),
  SESSION_TTL_HOURS: z.coerce
    .number()
    .int()
    .positive()
    .default(24 * 14),
  /** Secure cookies are mandatory outside development. */
  COOKIE_SECURE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  // --- Worker ---------------------------------------------------------------
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(5_000),
  WORKER_HEALTH_PORT: z.coerce.number().int().positive().default(4001),
  WORKER_CONCURRENCY: z.coerce.number().int().positive().max(16).default(2),

  // --- Sync behaviour -------------------------------------------------------
  /** How many recent days are re-synchronized to absorb provider restatement. */
  SYNC_RESTATEMENT_LOOKBACK_DAYS: z.coerce.number().int().min(0).max(90).default(7),
  SYNC_DEFAULT_BACKFILL_DAYS: z.coerce.number().int().min(1).max(400).default(30),
  SYNC_WINDOW_CHUNK_DAYS: z.coerce.number().int().min(1).max(90).default(7),
  SYNC_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),

  // --- Providers ------------------------------------------------------------
  META_GRAPH_API_VERSION: z.string().default('v21.0'),
  META_GRAPH_BASE_URL: z.string().url().default('https://graph.facebook.com'),
  APPSFLYER_BASE_URL: z.string().url().default('https://hq1.appsflyer.com'),
  TENJIN_BASE_URL: z.string().url().default('https://reporting.tenjin.com'),

  // --- Observability --------------------------------------------------------
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  LOG_PRETTY: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

export type MartConfig = Readonly<z.infer<typeof envSchema>>;

let cached: MartConfig | null = null;

export function loadConfig(source: NodeJS.ProcessEnv = process.env): MartConfig {
  if (source === process.env) loadDotEnv();
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new Error(`Invalid MART configuration: ${issues}`);
  }
  const config = Object.freeze(parsed.data);
  if (config.NODE_ENV === 'production' && !config.COOKIE_SECURE) {
    throw new Error('COOKIE_SECURE must be true in production');
  }
  return config;
}

export function getConfig(): MartConfig {
  if (!cached) cached = loadConfig();
  return cached;
}

/** Test helper: reset the memoized config so a new environment can be loaded. */
export function resetConfigCache(): void {
  cached = null;
}

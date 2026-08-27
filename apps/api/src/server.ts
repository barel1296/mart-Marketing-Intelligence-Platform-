import { getConfig } from '@mart/config';
import { getLogger } from '@mart/observability';
import { closePool, migrate } from '@mart/db';
import { buildServer } from './app.js';

const config = getConfig();
const log = getLogger();

async function main(): Promise<void> {
  // Migrations are advisory-locked, so API and worker can boot together.
  const result = await migrate();
  if (result.applied.length > 0) {
    log.info({ applied: result.applied }, 'database migrations applied');
  }

  const server = await buildServer();
  await server.listen({ port: config.API_PORT, host: config.API_HOST });
  log.info({ port: config.API_PORT }, 'mart api listening');

  const shutdown = async (signal: string): Promise<void> => {
    log.info({ signal }, 'shutting down');
    await server.close();
    await closePool();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((error: unknown) => {
  log.fatal({ err: error instanceof Error ? error.message : String(error) }, 'api failed to start');
  process.exit(1);
});

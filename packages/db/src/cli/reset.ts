import { migrate, resetSchema } from '../migrate.js';
import { closePool } from '../pool.js';

if (process.env.NODE_ENV === 'production') {
  process.stderr.write('Refusing to reset the schema in production\n');
  process.exit(1);
}
await resetSchema();
const result = await migrate();
process.stdout.write(`Schema reset; applied ${result.applied.length} migration(s)\n`);
await closePool();

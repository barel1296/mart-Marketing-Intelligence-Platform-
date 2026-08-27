import { migrate } from '../migrate.js';
import { closePool } from '../pool.js';

const result = await migrate();
if (result.applied.length === 0) {
  process.stdout.write(`No pending migrations (${result.alreadyApplied.length} already applied)\n`);
} else {
  process.stdout.write(`Applied ${result.applied.length} migration(s):\n`);
  for (const name of result.applied) process.stdout.write(`  - ${name}\n`);
}
await closePool();

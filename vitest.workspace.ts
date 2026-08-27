import { defineWorkspace } from 'vitest/config';
import { alias } from './vitest.config.js';

export default defineWorkspace([
  {
    resolve: { alias },
    test: {
      name: 'unit',
      environment: 'node',
      include: ['tests/unit/**/*.test.ts'],
    },
  },
  {
    resolve: { alias },
    test: {
      name: 'integration',
      environment: 'node',
      include: ['tests/integration/**/*.test.ts'],
      setupFiles: ['tests/integration/setup.ts'],
      hookTimeout: 60_000,
      testTimeout: 60_000,
      // Integration tests share one database; run them serially.
      pool: 'forks',
      poolOptions: { forks: { singleFork: true } },
      fileParallelism: false,
    },
  },
]);

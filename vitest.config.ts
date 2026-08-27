import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));

export const alias = {
  '@mart/shared': path.join(root, 'packages/shared/src/index.ts'),
  '@mart/config': path.join(root, 'packages/config/src/index.ts'),
  '@mart/observability': path.join(root, 'packages/observability/src/index.ts'),
  '@mart/db': path.join(root, 'packages/db/src/index.ts'),
  '@mart/auth': path.join(root, 'packages/auth/src/index.ts'),
  '@mart/integrations': path.join(root, 'packages/integrations/src/index.ts'),
  '@mart/metrics': path.join(root, 'packages/metrics/src/index.ts'),
};

export default defineConfig({
  resolve: { alias },
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
  },
});

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/e2e-org/**/*.org.e2e.test.ts'],
    environment: 'node',
    pool: 'forks',
    testTimeout: 20 * 60 * 1000,
    hookTimeout: 20 * 60 * 1000,
    env: {
      NODE_NO_WARNINGS: '1',
    },
  },
});

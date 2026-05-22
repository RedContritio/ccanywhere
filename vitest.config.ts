import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: false,
      },
    },
    testTimeout: 10_000,
    hookTimeout: 10_000,
  },
});

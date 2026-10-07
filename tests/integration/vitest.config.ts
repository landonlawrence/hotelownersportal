import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['./src/globalSetup.ts'],
    setupFiles: ['./src/setupEnv.ts'],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 180_000,
    include: ['src/**/*.test.ts'],
  },
});

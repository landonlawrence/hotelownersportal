import { defineConfig } from '@playwright/test';

/**
 * End-to-end tests run against the LOCAL stack: local Supabase (db reset in
 * global setup), the local API server and the Vite dev server. Tenants are
 * addressed through *.localhost hosts so branding resolution is exercised.
 */
export default defineConfig({
  testDir: './tests',
  globalSetup: './global-setup.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://harborview.localhost:5173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    viewport: { width: 1440, height: 900 },
  },
  webServer: [
    {
      command: 'npm run start -w services/api',
      cwd: '..',
      url: 'http://localhost:8787/health',
      reuseExistingServer: true,
      timeout: 120_000,
      env: { LOCAL_SCHEDULER: 'off' },
    },
    {
      command: 'npm run dev -w apps/web',
      cwd: '..',
      url: 'http://localhost:5173',
      reuseExistingServer: true,
      timeout: 120_000,
    },
  ],
});

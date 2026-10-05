import { defineConfig } from '@playwright/test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * End-to-end: the real server bundle serving the built dashboard on :8099,
 * seeded by e2e/global-setup.ts. Run `npm run build` in server/ and here first.
 */
const dataDir = join(tmpdir(), `snitch-e2e-${process.pid}`);
process.env.SNITCH_E2E_DATA_DIR ??= dataDir;
const port = 8099;

export default defineConfig({
  testDir: 'e2e',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  // No retries: a test that only passes on a second try is a bug to fix, not noise.
  retries: 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  globalSetup: './e2e/global-setup.ts',
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: 'retain-on-failure',
    ...(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {}),
  },
  webServer: {
    command: 'node ../server/dist/index.js',
    url: `http://127.0.0.1:${port}/health`,
    reuseExistingServer: false,
    timeout: 30_000,
    env: {
      PORT: String(port),
      SNITCH_DATA_DIR: process.env.SNITCH_E2E_DATA_DIR,
      SNITCH_PUBLIC_URL: `http://127.0.0.1:${port}`,
      SNITCH_PUBLIC_DIR: join(import.meta.dirname, 'dist'),
      SNITCH_BOOTSTRAP_ADMIN_EMAIL: 'admin@e2e.test',
      SNITCH_BOOTSTRAP_ADMIN_PASSWORD: 'e2e-password-123',
      SNITCH_ALLOW_PRIVATE_WEBHOOKS: 'true',
      SNITCH_REPORTS_PER_IP_PER_10_MIN: '1000',
    },
  },
});

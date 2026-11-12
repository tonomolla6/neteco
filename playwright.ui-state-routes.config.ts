import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: 'ui-state-routes.spec.ts',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  forbidOnly: true,
  updateSnapshots: 'none',
  reporter: 'list',
  outputDir: 'test-results/ui013-routes',
  use: {
    baseURL: process.env.NETECO_UI_STATE_E2E_ORIGIN,
    trace: 'off',
    screenshot: 'off',
    video: 'off'
  }
})

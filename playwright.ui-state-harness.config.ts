import { defineConfig } from '@playwright/test'

/** Dedicated connect-only component visual checks. No webServer, credentials,
 * provider, DB fixture, demo login, browser install or local launch fallback. */
export default defineConfig({
  testDir: './tests/visual',
  testMatch: 'ui-state-harness.spec.ts',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  forbidOnly: true,
  updateSnapshots: 'none',
  reporter: 'list',
  outputDir: 'test-results/ui013-visual',
  snapshotPathTemplate: '{testDir}/ui013-reviewed-baselines/{arg}{ext}',
  use: {
    locale: 'es-ES',
    timezoneId: 'UTC',
    colorScheme: 'light',
    reducedMotion: 'reduce',
    deviceScaleFactor: 1,
    trace: 'off',
    video: 'off',
    screenshot: 'off'
  }
})

import { defineConfig } from '@playwright/test'
import base from './playwright.config'

export default defineConfig({
  ...base,
  testDir: './tests/visual',
  fullyParallel: false,
  updateSnapshots: 'none',
  workers: 1,
  reporter: process.env.CI
    ? [
        ['html', { outputFolder: 'playwright-visual-report', open: 'never' }],
        ['junit', { outputFile: 'test-results/visual.xml' }]
      ]
    : 'list',
  outputDir: 'test-results/visual',
  snapshotPathTemplate: '{testDir}/{testFilePath}-snapshots/{arg}-{projectName}{ext}',
  expect: {
    toHaveScreenshot: {
      animations: 'disabled',
      caret: 'hide',
      scale: 'css',
      maxDiffPixelRatio: 0.002
    }
  },
  use: {
    ...base.use,
    colorScheme: 'light',
    reducedMotion: 'reduce',
    deviceScaleFactor: 1,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off'
  },
  projects: [
    { name: 'desktop', use: { browserName: 'chromium', viewport: { width: 1440, height: 1000 } } },
    {
      name: 'mobile',
      use: { browserName: 'chromium', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }
    }
  ]
})

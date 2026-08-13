import { defineConfig } from '@playwright/test'
import base from './playwright.config'

export default defineConfig({
  ...base,
  testDir: './tests/browser-matrix',
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI
    ? [
        ['html', { outputFolder: 'playwright-matrix-report', open: 'never' }],
        ['junit', { outputFile: 'test-results/browser-matrix.xml' }]
      ]
    : 'list',
  outputDir: 'test-results/browser-matrix'
})

import { defineConfig } from '@playwright/test'
import base from './playwright.config'

export default defineConfig({
  ...base,
  reporter: process.env.CI
    ? [
        ['html', { outputFolder: 'playwright-a11y-report', open: 'never' }],
        ['junit', { outputFile: 'test-results/accessibility.xml' }]
      ]
    : 'list',
  outputDir: 'test-results/accessibility'
})

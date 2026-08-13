import { defineConfig } from '@playwright/test'
import matrix from './playwright.matrix.config'

export default defineConfig({
  ...matrix,
  repeatEach: 2,
  retries: 0,
  reporter: [['json', { outputFile: 'test-results/flaky-browser-raw.json' }]],
  outputDir: 'test-results/flaky-browser'
})

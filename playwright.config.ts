import { defineConfig, devices } from '@playwright/test'
import { resolve } from 'node:path'
import { REDSYS_OFFICIAL_CONTRACT } from './tests/fixtures/redsys-official'

const port = Number(process.env.PLAYWRIGHT_PORT ?? 3100)
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? `http://127.0.0.1:${port}`
const mediaStorageDirectory = resolve(process.cwd(), '.data/e2e-media')

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI
    ? [
        ['html', { open: 'never' }],
        ['junit', { outputFile: 'test-results/e2e.xml' }]
      ]
    : 'list',
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    locale: 'es-ES',
    timezoneId: 'Europe/Madrid'
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
    { name: 'mobile-chrome', use: { ...devices['Pixel 7'] } },
    { name: 'mobile-safari', use: { ...devices['iPhone 15'] } }
  ],
  webServer: process.env.PLAYWRIGHT_BASE_URL
    ? undefined
    : {
        command: `npm run preview -- --port ${port}`,
        url: `${baseURL}/api/health/live`,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
        env: {
          HOST: '127.0.0.1',
          APP_ENV: 'test',
          APP_BASE_URL: baseURL,
          NUXT_APP_ENV: 'test',
          NUXT_PUBLIC_APP_ENV: 'test',
          NUXT_PUBLIC_BASE_URL: baseURL,
          DATABASE_URL: process.env.DATABASE_URL ?? 'postgres://neteco:neteco-local@localhost:56432/neteco',
          REDIS_URL: process.env.REDIS_URL ?? 'redis://localhost:56379/0',
          NUXT_SESSION_PASSWORD: process.env.NUXT_SESSION_PASSWORD ?? 'test-only-session-password-32-characters',
          AUTH_TOKEN_PEPPER: process.env.AUTH_TOKEN_PEPPER ?? 'local-only-token-pepper-change-me',
          AUTH_ENCRYPTION_KEY: process.env.AUTH_ENCRYPTION_KEY ?? 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
          NETECO_TEST_NOW: '2026-08-13T12:00:00.000Z',
          EMAIL_WEBHOOK_SECRET: 'test-email-webhook-secret-at-least-24-characters',
          PAYMENT_PROVIDER: 'redsys',
          NUXT_PAYMENT_PROVIDER: 'redsys',
          REDSYS_ENV: 'sandbox',
          NUXT_REDSYS_ENVIRONMENT: 'sandbox',
          REDSYS_MERCHANT_CODE: REDSYS_OFFICIAL_CONTRACT.sandbox.merchantCode,
          NUXT_REDSYS_MERCHANT_CODE: JSON.stringify(REDSYS_OFFICIAL_CONTRACT.sandbox.merchantCode),
          REDSYS_TERMINAL: REDSYS_OFFICIAL_CONTRACT.sandbox.terminal,
          NUXT_REDSYS_TERMINAL: JSON.stringify(REDSYS_OFFICIAL_CONTRACT.sandbox.terminal),
          REDSYS_SECRET_KEY: REDSYS_OFFICIAL_CONTRACT.sandbox.secretKey,
          NUXT_REDSYS_SECRET_KEY: REDSYS_OFFICIAL_CONTRACT.sandbox.secretKey,
          REDSYS_CURRENCY: REDSYS_OFFICIAL_CONTRACT.sandbox.currency,
          NUXT_REDSYS_CURRENCY: JSON.stringify(REDSYS_OFFICIAL_CONTRACT.sandbox.currency),
          REDSYS_MERCHANT_NAME: 'NETECO E2E',
          NUXT_REDSYS_MERCHANT_NAME: 'NETECO E2E',
          BANK_TRANSFER_ENABLED: 'true',
          NUXT_BANK_TRANSFER_ENABLED: 'true',
          NUXT_PUBLIC_BANK_TRANSFER_ENABLED: 'true',
          BANK_TRANSFER_IBAN: 'ES9121000418450200051332',
          NUXT_BANK_TRANSFER_IBAN: 'ES9121000418450200051332',
          BANK_TRANSFER_BENEFICIARY: 'NETECO E2E',
          NUXT_BANK_TRANSFER_BENEFICIARY: 'NETECO E2E',
          INVOICE_PROVIDER: 'mock',
          CARRIER_PROVIDER: 'mock',
          MOCK_CARRIER_TRACKING_SEQUENCE: 'exception,delivered+exception',
          MEDIA_STORAGE_DIRECTORY: mediaStorageDirectory,
          NUXT_MEDIA_STORAGE_DIRECTORY: mediaStorageDirectory,
          MEDIA_MAX_BYTES: '1000',
          NUXT_MEDIA_MAX_BYTES: '1000'
        }
      }
})

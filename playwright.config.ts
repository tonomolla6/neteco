import { defineConfig, devices } from '@playwright/test'

const port = Number(process.env.PLAYWRIGHT_PORT ?? 3100)
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? `http://127.0.0.1:${port}`

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
          EMAIL_WEBHOOK_SECRET: 'test-email-webhook-secret-at-least-24-characters',
          PAYMENT_PROVIDER: 'mock',
          INVOICE_PROVIDER: 'mock',
          CARRIER_PROVIDER: 'mock'
        }
      }
})

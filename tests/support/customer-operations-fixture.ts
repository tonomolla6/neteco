import { vi } from 'vitest'
import type { CustomerOperationsEnv } from '../../workers/runtime/customer-operations-config'

export function environment(overrides: Record<string, unknown> = {}): CustomerOperationsEnv {
  return {
    APP_ENV: 'local',
    AUTH_ORIGIN: 'https://neteco.invalid',
    AUTH_ENABLED: 'false',
    DB: {
      prepare: vi.fn(() => {
        throw new Error('unexpected_database_access')
      }),
      batch: vi.fn()
    },
    MEDIA: { get: vi.fn(), put: vi.fn(), head: vi.fn() },
    IMAGES: {},
    AUTH_RATE_LIMIT_PEPPER: 'synthetic-private-quota-pepper-0123456789abcdef',
    NUXT_SESSION_PASSWORD: 'synthetic-session-password-0123456789abcdef',
    CART_EDGE_LIMIT: { limit: vi.fn(async () => ({ success: true })) },
    ADMIN_EDGE_LIMIT: { limit: vi.fn(async () => ({ success: true })) },
    NEWSLETTER_EMAIL: { send: vi.fn() },
    NEWSLETTER_PUBLIC_ORIGIN: 'https://neteco.invalid',
    NEWSLETTER_EMAIL_FROM: 'newsletter@example.invalid',
    ...overrides
  } as unknown as CustomerOperationsEnv
}

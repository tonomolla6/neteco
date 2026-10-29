import { describe, it, expect } from 'vitest'
import {
  handleShippingCalendarsHttp,
  type ShippingCalendarsHttpDependencies
} from '../../workers/catalog/shipping-calendar-http'
const origin = 'https://shop.neteco.test'
function deps(): ShippingCalendarsHttpDependencies {
  return {
    database: {
      prepare: () => {
        throw new Error('D1 must not be consulted')
      }
    } as unknown as D1Database,
    sessionCookieConfiguration: {
      password: 'synthetic-calendar-password-012345678901234567890123456789',
      maxAgeSeconds: 3600
    },
    origin,
    edgeLimiter: { limit: async () => ({ success: true }) } as unknown as RateLimit,
    rateLimitPepper: 'synthetic-calendar-edge-pepper-01234567890123456789'
  }
}
describe('Shipping calendars private boundary', () => {
  it('rejects methods before cookies and D1 with private no-store', async () => {
    const response = await handleShippingCalendarsHttp(
      new Request(`${origin}/api/admin/shipping/calendars`, { method: 'DELETE' }),
      deps()
    )
    expect(response?.status).toBe(405)
    expect(response?.headers.get('allow')).toBe('GET')
    expect(response?.headers.get('cache-control')).toBe('private, no-store')
  })
  it('requires a server verified session for calendar reads', async () => {
    const response = await handleShippingCalendarsHttp(
      new Request(`${origin}/api/admin/shipping/calendars`, { headers: { 'cf-connecting-ip': '192.0.2.78' } }),
      deps()
    )
    expect(response?.status).toBe(401)
  })
  it('rejects cross-origin mutations before any database work', async () => {
    const response = await handleShippingCalendarsHttp(
      new Request(`${origin}/api/admin/shipping/calendars/commands`, {
        method: 'POST',
        headers: {
          origin: 'https://other.example.test',
          'cf-connecting-ip': '192.0.2.78',
          'content-type': 'application/json'
        },
        body: '{}'
      }),
      deps()
    )
    expect(response?.status).toBe(403)
  })
})

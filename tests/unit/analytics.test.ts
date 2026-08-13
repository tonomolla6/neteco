import { describe, expect, it } from 'vitest'
import { analyticsConsent, clientAnalyticsEventSchema, containsLikelyPii } from '../../server/utils/analytics'

const common = {
  eventId: '11111111-1111-4111-8111-111111111111',
  taxonomyVersion: 'v1' as const,
  occurredAt: '2026-08-13T12:00:00.000Z'
}

describe('analytics event contract', () => {
  it.each([
    ['page_view', { path: '/catalogo' }],
    ['catalog_viewed', { category: null, page: 2, resultCount: 20 }],
    ['search_completed', { query: 'detergente', resultCount: 3 }],
    ['product_viewed', { productId: 1, variantId: 2 }],
    ['cart_item_added', { variantId: 2, quantity: 1, cartVersion: 3 }],
    ['cart_item_removed', { variantId: 2, quantity: 1, cartVersion: 4 }],
    ['checkout_started', { itemCount: 2, totalCents: 3490 }],
    ['web_vital', { metric: 'LCP', value: 1200, rating: 'good', path: '/catalogo', navigationType: 'navigate' }]
  ])('accepts the v1 %s event', (name, properties) => {
    expect(clientAnalyticsEventSchema.safeParse({ ...common, name, properties }).success).toBe(true)
  })

  it.each([
    { ...common, name: 'unknown', properties: {} },
    { ...common, name: 'page_view', properties: { path: '/catalogo?q=secret' } },
    { ...common, name: 'catalog_viewed', properties: { category: null, page: 0, resultCount: 2 } },
    { ...common, name: 'product_viewed', properties: { productId: '1', variantId: 2 } },
    { ...common, name: 'checkout_started', properties: { itemCount: 1, totalCents: 20, email: 'extra' } },
    { ...common, name: 'web_vital', properties: { metric: 'LCP', value: 120_001, rating: 'poor', path: '/' } }
  ])('rejects invalid or expanded payload %#', (payload) => {
    expect(clientAnalyticsEventSchema.safeParse(payload).success).toBe(false)
  })

  it('recognizes only an explicit versioned analytics grant in supported cookie encodings', () => {
    const grant = JSON.stringify({ version: 'v1', analytics: true })
    expect(analyticsConsent(grant)).toBe(true)
    expect(analyticsConsent(encodeURIComponent(grant))).toBe(true)
    expect(analyticsConsent(JSON.stringify(grant))).toBe(true)
    expect(analyticsConsent(JSON.stringify({ version: 'v1', analytics: false }))).toBe(false)
    expect(analyticsConsent(undefined)).toBe(false)
    expect(analyticsConsent('invalid')).toBe(false)
  })

  it.each(['cliente@example.com', '+34 600 123 456', '600123456', '12345678Z', 'X1234567L'])(
    'detects prohibited personal data: %s',
    (value) => expect(containsLikelyPii({ query: value })).toBe(true)
  )

  it('allows bounded anonymous analytics values', () => {
    expect(containsLikelyPii({ path: '/catalogo', productId: 42, query: 'detergente neutro' })).toBe(false)
  })
})

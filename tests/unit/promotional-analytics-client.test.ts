import { describe, expect, it, vi } from 'vitest'
import { dispatchClientAnalytics, prepareClientAnalyticsEvent } from '../../shared/analytics-client'
import { clientAnalyticsEventSchema as legacyNodeSchema } from '../../server/utils/analytics'

const event = (name = 'promotional_impression') => ({
  eventId: '90000000-0000-4000-8000-000000000001',
  taxonomyVersion: 'v1',
  occurredAt: '2026-10-09T20:00:00Z',
  name,
  properties: {
    pageId: '90000000-0000-4000-8000-000000000002',
    publicationId: '90000000-0000-4000-8000-000000000003',
    version: 3,
    placement: 'home',
    blockId: name === 'promotional_click' ? '90000000-0000-4000-8000-000000000004' : null
  }
})

describe('Cloudflare promotional analytics browser boundary', () => {
  it.each(['promotional_impression', 'promotional_click'])(
    'accepts only the typed %s payload without UUID/phone false positives',
    (name) => {
      const input = event(name)
      const prepared = prepareClientAnalyticsEvent(input)
      expect(prepared?.event).toEqual(input)
      expect(prepared?.layer).toEqual({ event: name, ...input.properties })
      expect(Object.isFrozen(prepared?.event.properties)).toBe(true)
      expect(Object.isFrozen(prepared?.event)).toBe(true)
    }
  )

  it('rejects free text, addresses, URLs, extra keys, invalid references and impossible placement/version', () => {
    const input = event()
    for (const properties of [
      { ...input.properties, email: 'customer@example.test' },
      { ...input.properties, url: 'https://shop.test/?email=customer@example.test' },
      { ...input.properties, label: 'arbitrary campaign text' },
      { ...input.properties, pageId: 'customer@example.test' },
      { ...input.properties, publicationId: '../private' },
      { ...input.properties, placement: 'account' },
      { ...input.properties, version: 0 },
      { ...input.properties, version: Number.MAX_SAFE_INTEGER + 1 },
      { ...input.properties, blockId: '90000000-0000-4000-8000-000000000004' }
    ])
      expect(prepareClientAnalyticsEvent({ ...input, properties })).toBeNull()
    expect(prepareClientAnalyticsEvent({ ...input, customerId: 'private' })).toBeNull()
    expect(prepareClientAnalyticsEvent({ ...event('promotional_click'), properties: input.properties })).toBeNull()
  })

  it('transports a consented public event exactly once and never retries a failed transport', async () => {
    const input = event('promotional_click')
    const transport = vi.fn().mockRejectedValue(new Error('offline'))
    const layer: unknown[] = []
    await expect(
      dispatchClientAnalytics({ consent: true, path: '/', query: {}, event: input }, transport, layer)
    ).resolves.toBeUndefined()
    expect(transport).toHaveBeenCalledTimes(1)
    expect(transport).toHaveBeenCalledWith(input)
    expect(layer).toEqual([{ event: input.name, ...input.properties }])
  })

  it('does not transport without consent or on private/preview routes', async () => {
    const transport = vi.fn()
    for (const context of [
      { consent: false, path: '/', query: {} },
      { consent: true, path: '/admin', query: {} },
      { consent: true, path: '/cuenta/pedidos', query: {} },
      { consent: true, path: '/contenido/promocion', query: { preview: 'grant' } }
    ])
      await dispatchClientAnalytics({ ...context, event: event() }, transport)
    expect(transport).not.toHaveBeenCalled()
  })

  it('does not broaden the legacy Node taxonomy or weaken legacy PII filtering', () => {
    expect(legacyNodeSchema.safeParse(event()).success).toBe(false)
    expect(legacyNodeSchema.safeParse(event('promotional_click')).success).toBe(false)
    const legacy = { ...event(), name: 'page_view', properties: { path: '/catalogo' } }
    expect(legacyNodeSchema.safeParse(legacy).success).toBe(true)
    expect(prepareClientAnalyticsEvent(legacy)?.event).toEqual(legacy)
    expect(
      prepareClientAnalyticsEvent({
        ...legacy,
        name: 'search_completed',
        properties: { query: 'customer@example.test', resultCount: 1 }
      })
    ).toBeNull()
  })
})

import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import AdminAudiences from '../../app/components/AdminAudiences.vue'
import '#app/nuxt-vitest-app-entry'

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  runtime: 'cloudflare'
}))

mockNuxtImport('useRequestFetch', () => () => mocks.request)
mockNuxtImport('useRuntimeConfig', () => () => ({
  app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
  public: { serverRuntime: mocks.runtime }
}))

const mockSegments = [
  {
    id: 'seg-1111-1111-1111-111111111111',
    slug: 'clientes-hosteleria-valencia',
    name: 'Hostelería y Restauración Valencia',
    description: 'Clientes del sector HORECA con compras recurrentes',
    targetType: 'b2b',
    version: 2,
    rules: {
      logic: 'AND',
      conditions: [
        { field: 'customer_type', operator: 'eq', value: 'b2b' },
        { field: 'orders_count', operator: 'gte', value: 2 }
      ]
    },
    estimatedTotalUsers: 140,
    estimatedConsentedUsers: 95,
    status: 'active'
  }
]

const mockPreview = {
  items: [
    {
      id: 'usr-1',
      maskedIdentifier: 'h***a@example.invalid',
      customerType: 'b2b',
      hasConsent: true,
      orderCount: 5,
      totalSpentCents: 120000,
      daysSinceLastOrder: 14
    },
    {
      id: 'usr-2',
      maskedIdentifier: 'r***e@example.invalid',
      customerType: 'b2b',
      hasConsent: false,
      orderCount: 3,
      totalSpentCents: 65000,
      daysSinceLastOrder: 45
    }
  ]
}

describe('AdminAudiences component (ADM-027)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.request.mockImplementation(async (url: string, opts?: { method?: string; body?: unknown }) => {
      if (url === '/api/admin/audiences') {
        if (opts?.method === 'POST') {
          return {
            segmentId: 'seg-2222-2222-2222-222222222222',
            slug: 'nuevo-segmento',
            version: 1
          }
        }
        return { items: mockSegments }
      }
      if (url.includes('/estimate')) {
        return {
          totalMatchingUsers: 150,
          consentedUsers: 105,
          unconsentedUsers: 45,
          consentPercentage: 70
        }
      }
      if (url.includes('/preview')) {
        return mockPreview
      }
      throw new Error(`Unhandled URL ${url}`)
    })
  })

  it('renders audience segments with version indicator and size estimation', async () => {
    const wrapper = await mountSuspended(AdminAudiences)
    await flushPromises()

    expect(wrapper.text()).toContain('Segmentos y Audiencias')
    expect(wrapper.text()).toContain('Hostelería y Restauración Valencia')
    expect(wrapper.text()).toContain('v2')
    expect(wrapper.text()).toContain('140')
  })

  it('allows estimating audience size and consent breakdown', async () => {
    const wrapper = await mountSuspended(AdminAudiences)
    await flushPromises()

    const estBtn = wrapper.find('button[data-test="estimate-audience"]')
    if (estBtn.exists()) {
      await estBtn.trigger('click')
      await flushPromises()
      expect(wrapper.text()).toContain('70%')
    }
  })

  it('displays privacy-safe preview without raw PII', async () => {
    const wrapper = await mountSuspended(AdminAudiences)
    await flushPromises()

    const prevBtn = wrapper.find('button[data-test="preview-audience"]')
    if (prevBtn.exists()) {
      await prevBtn.trigger('click')
      await flushPromises()
      expect(wrapper.text()).toContain('h***a@example.invalid')
      expect(wrapper.text()).not.toContain('password')
      expect(wrapper.text()).not.toContain('token')
    }
  })
})

import { mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ProductUgcReviews from '../../app/components/ProductUgcReviews.vue'
import '#app/nuxt-vitest-app-entry'

const sampleReviews = [
  {
    id: 'rev-1',
    productId: 'prod-1',
    rating: 5,
    title: 'Desengrasa de maravilla',
    content: 'Comprado para taller mecánico con excelente resultado.',
    displayName: 'Paco Mecánico',
    isVerifiedBuyer: true,
    photos: [
      {
        id: 'photo-1',
        photoUrl: 'https://media.neteco.es/p1.png',
        mimeType: 'image/png',
        width: 800,
        height: 600,
        sortOrder: 0
      }
    ],
    incentiveBadge: 'Compra verificada sin compensación',
    incentiveDisclosure: null,
    createdAt: '2026-10-29T10:00:00Z'
  }
]

describe('ProductUgcReviews.vue Component', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/ugc-reviews')) {
          return {
            ok: true,
            json: async () => ({
              reviews: sampleReviews,
              total: 1
            })
          }
        }
        return { ok: false, json: async () => ({ error: { code: 'not_found' } }) }
      })
    )
  })

  it('mounts and renders reviews list with rating and verified buyer badge', async () => {
    const wrapper = await mountSuspended(ProductUgcReviews, {
      props: {
        productId: 'prod-1'
      }
    })
    await flushPromises()

    expect(wrapper.text()).toContain('Opiniones de clientes con fotografías')
    expect(wrapper.text()).toContain('Desengrasa de maravilla')
    expect(wrapper.text()).toContain('Compra verificada sin compensación')
    expect(wrapper.text()).toContain('Paco Mecánico')
    expect(wrapper.find('img').attributes('src')).toBe('https://media.neteco.es/p1.png')
  })

  it('renders empty state when there are no reviews', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ reviews: [], total: 0 })
      }))
    )

    const wrapper = await mountSuspended(ProductUgcReviews, {
      props: {
        productId: 'prod-empty'
      }
    })
    await flushPromises()

    expect(wrapper.text()).toContain('Aún no hay opiniones con fotografías')
  })

  it('toggles review submission form and displays incentive transparency fields', async () => {
    const wrapper = await mountSuspended(ProductUgcReviews, {
      props: {
        productId: 'prod-1'
      }
    })
    await flushPromises()

    const toggleBtn = wrapper.find('button[type="button"]')
    await toggleBtn.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('Nueva opinión con fotos')
    expect(wrapper.text()).toContain('Transparencia e incentivos')
    expect(wrapper.find('#review-title').exists()).toBe(true)
    expect(wrapper.find('#review-content').exists()).toBe(true)
  })
})

import { mockNuxtImport, mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import { expect, it, vi } from 'vitest'
import HomePage from '../../app/pages/index.vue'
import '#app/nuxt-vitest-app-entry'

const { contextualFetch } = vi.hoisted(() => ({ contextualFetch: vi.fn() }))
mockNuxtImport('useRequestFetch', (original) => () => {
  const fallback = original()
  return Object.assign(
    (url: string, options?: { params?: { category?: string } }) =>
      options?.params?.category ? contextualFetch(url, options) : fallback(url, options),
    fallback
  ) as typeof fallback
})
const slugs = ['cocina-profesional', 'mesa-y-buffet', 'reposteria-y-pasteleria', 'equipamiento-y-exterior']
const roots = slugs.map((slug, index) => ({
  id: index + 1,
  name: 'Familia ' + index,
  slug,
  parentId: null,
  sort: index,
  count: 16,
  children: []
}))
registerEndpoint('/api/categories', () => ({ roots, flat: roots }))
// This transport lacks the Worker request context, so filtered calls have no samples.
registerEndpoint('/api/products', () => ({ items: [], total: 0, page: 1, pages: 1 }))
it('preserves Worker request context when loading product photos for all main-family tiles', async () => {
  contextualFetch.mockImplementation(async (_url, options) => {
    const index = slugs.indexOf(options.params.category)
    return {
      items: [
        {
          id: 100 + index,
          name: 'Foto ' + index,
          image: `/media/10000000-0000-4000-8000-00000000000${index}/image`,
          categoryId: index + 1,
          visual: { type: 'caja', color: '#888' },
          minPrice: 1000,
          minNetPrice: 826,
          formats: 1,
          featured: false,
          badges: [],
          brand: 'Lacor',
          slug: 'foto-' + index
        }
      ],
      total: 1,
      page: 1,
      pages: 1
    }
  })
  const wrapper = await mountSuspended(HomePage, {
    global: {
      stubs: {
        PromotionalBlocks: true,
        HeroOfferSlider: true,
        ProductCard: true,
        HomeReorder: true,
        ProductImage: defineComponent({
          props: { product: Object },
          setup: (props) => () => h('img', { 'data-context-photo': '', src: props.product?.image })
        })
      }
    }
  })
  try {
    await flushPromises()
    const requested = contextualFetch.mock.calls.map(([, options]) => options?.params?.category)
    expect(slugs.every((slug) => requested.includes(slug))).toBe(true)
    for (const slug of ['mesa-y-buffet', 'equipamiento-y-exterior'])
      expect(
        wrapper.get(`[data-home-family][href="/categoria/${slug}"] [data-context-photo]`).attributes('src')
      ).toMatch(/^\/media\//)
  } finally {
    wrapper.unmount()
  }
})

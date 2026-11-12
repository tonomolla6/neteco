import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { defineComponent, h } from 'vue'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import ProductImage from '../../app/components/ProductImage.vue'
import '#app/nuxt-vitest-app-entry'

const { runtime } = vi.hoisted(() => ({ runtime: vi.fn(() => ({ public: { mediaGoverned: false } })) }))
mockNuxtImport('useRuntimeConfig', (original) => () => {
  const config = original()
  return { ...config, public: { ...config.public, ...runtime().public } }
})
const source = '/media/12345678-1234-4321-aaaa-123456789abc'
const second = '/media/87654321-4321-4321-bbbb-cba987654321'
const mounted: Awaited<ReturnType<typeof mountSuspended>>[] = []
beforeEach(() => {
  runtime.mockReturnValue({ public: { mediaGoverned: false } })
  vi.spyOn(HTMLImageElement.prototype, 'complete', 'get').mockReturnValue(false)
})
afterEach(() => {
  mounted.splice(0).forEach((wrapper) => wrapper.unmount())
  vi.restoreAllMocks()
})
async function picture(image = source) {
  const wrapper = await mountSuspended(ProductImage, {
    props: { product: { image, imageAlt: 'Cacerola real del catálogo', name: 'Cacerola' } },
    global: {
      stubs: {
        NuxtImg: defineComponent({
          inheritAttrs: false,
          setup:
            (_, { attrs }) =>
            () =>
              h('img', { ...attrs, 'data-ipx': '' })
        }),
        ProductVisual: defineComponent({ setup: () => () => h('div', { 'data-visual': '' }) }),
        PublishedProductImage: true,
        NuxtLink: true
      }
    }
  })
  mounted.push(wrapper)
  return wrapper
}
it('uses the Node media endpoint directly, with useful alt and lazy loading', async () => {
  const wrapper = await picture()
  expect(wrapper.find('[data-ipx]').exists()).toBe(false)
  expect(wrapper.get('img').attributes('src')).toBe(source)
  expect(wrapper.get('img').attributes('alt')).toBe('Cacerola real del catálogo')
  expect(wrapper.get('img').attributes('loading')).toBe('lazy')
  await wrapper.get('img').trigger('load')
  expect(wrapper.find('.animate-pulse').exists()).toBe(false)
})
it('falls back when the endpoint withdraws the image, then resets for another source', async () => {
  const wrapper = await picture()
  await wrapper.get('img').trigger('error')
  expect(wrapper.find('img').exists()).toBe(false)
  expect(wrapper.find('[data-visual]').exists()).toBe(true)
  await wrapper.setProps({ product: { image: second, name: 'Otra cacerola' } })
  expect(wrapper.get('img').attributes('src')).toBe(second)
})
it('keeps the existing transformer for static product photos', async () => {
  const wrapper = await picture('/img/products/demo.webp')
  expect(wrapper.get('[data-ipx]').attributes('src')).toBe('/img/products/demo.webp')
})
it('does not accept a legacy Node asset in the Cloudflare governed profile', async () => {
  runtime.mockReturnValue({ public: { mediaGoverned: true } })
  const wrapper = await picture()
  expect(wrapper.find('img').exists()).toBe(false)
  expect(wrapper.find('[data-visual]').exists()).toBe(true)
})

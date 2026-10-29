import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { defineComponent, h, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import PublishedProductImage from '../../app/components/PublishedProductImage.vue'
import ProductImage from '../../app/components/ProductImage.vue'
// Reuse the established component-test preload: keep cold Nuxt imports outside
// its fixed bootstrap hook deadline, without bypassing actual component setup.
import '#app/nuxt-vitest-app-entry'

mockNuxtImport('useUserSession', () => () => ({
  ready: ref(true),
  loggedIn: ref(false),
  user: ref(null),
  session: ref(null),
  clear: async () => undefined,
  openInPopup: () => undefined,
  fetch: async () => undefined
}))

const publicationId = '12345678-1234-4321-aaaa-123456789abc'
const imagePath = `/media/${publicationId}/image`
const responsiveWidths = [256, 400, 640, 800, 1200, 1600]
const sizes = '(max-width: 640px) 45vw, 320px'
const imageAlt = 'Envase real de Producto 1, etiqueta frontal'

const mounted: Array<{ unmount: () => void }> = []

const VisualStub = defineComponent({
  props: { visual: Object },
  setup() {
    return () => h('div', { 'data-product-visual': '', 'aria-label': 'Ilustración de familia, no fotografía' })
  }
})
const LegacyImageStub = defineComponent({
  inheritAttrs: false,
  setup(_, { attrs }) {
    return () => h('img', { ...attrs, 'data-legacy-image': '' })
  }
})

async function renderPublished(
  patch: Partial<{
    src: string
    alt: string
    sizes: string
    imageClass: string
    loading: 'lazy' | 'eager'
  }> = {}
) {
  const wrapper = await mountSuspended(PublishedProductImage, {
    props: { src: imagePath, alt: imageAlt, sizes, ...patch }
  })
  mounted.push(wrapper)
  return wrapper
}

async function renderProduct(
  patch: { image?: string; imageAlt?: string; name?: string; context?: 'card' | 'detail' } = {}
) {
  const wrapper = await mountSuspended(ProductImage, {
    props: {
      product: {
        image: patch.image ?? imagePath,
        imageAlt: patch.imageAlt ?? imageAlt,
        name: patch.name ?? 'Producto 1',
        visual: { type: 'garrafa', color: '#123456' }
      },
      sizes,
      context: patch.context ?? 'card'
    },
    global: {
      components: { PublishedProductImage },
      stubs: { PublishedProductImage: false, ProductVisual: VisualStub, NuxtImg: LegacyImageStub }
    }
  })
  mounted.push(wrapper)
  return wrapper
}

describe('PublishedProductImage governed responsive component', () => {
  beforeEach(() => {
    // Native load completion is controlled explicitly: this test does not
    // download an image or infer successful decoding from its URL alone.
    vi.spyOn(HTMLImageElement.prototype, 'complete', 'get').mockReturnValue(false)
    vi.spyOn(HTMLImageElement.prototype, 'naturalWidth', 'get').mockReturnValue(0)
  })
  afterEach(() => {
    for (const wrapper of mounted.splice(0)) wrapper.unmount()
    vi.restoreAllMocks()
  })

  it('renders AVIF and WebP picture sources before the JPEG fallback with bounded width descriptors', async () => {
    const wrapper = await renderPublished()
    expect(wrapper.findAll('picture')).toHaveLength(1)
    expect(wrapper.get('picture').element.children.length).toBe(3)
    const sources = wrapper.findAll('source')
    expect(sources.map((source) => source.attributes('type'))).toEqual(['image/avif', 'image/webp'])
    for (const [source, format] of [
      [sources[0]!, 'avif'],
      [sources[1]!, 'webp']
    ] as const) {
      expect(source.attributes('srcset').split(', ')).toEqual(
        responsiveWidths.map((width) => `${imagePath}?w=${width}&format=${format} ${width}w`)
      )
      expect(source.attributes('sizes')).toBe(sizes)
    }
    const image = wrapper.get('img')
    expect(image.attributes('src')).toBe(`${imagePath}?w=800&format=jpeg`)
    expect(image.attributes('srcset').split(', ')).toEqual(
      responsiveWidths.map((width) => `${imagePath}?w=${width}&format=jpeg ${width}w`)
    )
    expect(image.attributes('sizes')).toBe(sizes)
    expect(image.attributes('alt')).toBe(imageAlt)
    expect(image.attributes('loading')).toBe('lazy')
    expect(image.attributes('decoding')).toBe('async')
    expect(wrapper.emitted()).toEqual({})
  })

  it.each([64, 128, 256, 400, 640, 800, 1200, 1600])(
    'accepts only protocol-supported incoming width %s while generating the canonical JPEG fallback',
    async (width) => {
      const wrapper = await renderPublished({ src: `${imagePath}?w=${width}&format=webp` })
      expect(wrapper.get('img').attributes('src')).toBe(`${imagePath}?w=800&format=jpeg`)
      expect(wrapper.get('source[type="image/avif"]').attributes('srcset')).toContain(
        `${imagePath}?w=1600&format=avif 1600w`
      )
    }
  )

  it('passes explicit eager loading, contextual alt and image styling to the native image only', async () => {
    const wrapper = await renderPublished({
      loading: 'eager',
      imageClass: 'object-contain rounded-xl',
      alt: 'Etiqueta <frontal> & lateral',
      sizes: '100vw'
    })
    const image = wrapper.get('img')
    expect(image.attributes('loading')).toBe('eager')
    expect(image.attributes('alt')).toBe('Etiqueta <frontal> & lateral')
    expect(image.classes()).toContain('object-contain')
    expect(image.classes()).toContain('rounded-xl')
    expect(wrapper.get('picture').classes()).not.toContain('object-contain')
    for (const node of wrapper.findAll('img, source')) expect(node.attributes('sizes')).toBe('100vw')
    await wrapper.setProps({ alt: '', loading: 'lazy', sizes: '50vw' })
    expect(wrapper.get('img').attributes('alt')).toBe('')
    expect(wrapper.get('img').attributes('loading')).toBe('lazy')
    for (const node of wrapper.findAll('img, source')) expect(node.attributes('sizes')).toBe('50vw')
  })

  it('forwards native load/error events without declaring a URL to be successfully loaded', async () => {
    const wrapper = await renderPublished()
    expect(wrapper.emitted('load')).toBeUndefined()
    expect(wrapper.emitted('error')).toBeUndefined()
    await wrapper.get('img').trigger('load')
    expect(wrapper.emitted('load')).toEqual([[]])
    await wrapper.get('img').trigger('error')
    expect(wrapper.emitted('error')).toEqual([[]])
  })

  it('reports a successfully decoded cached image during mount when the native event preceded hydration', async () => {
    vi.spyOn(HTMLImageElement.prototype, 'complete', 'get').mockReturnValue(true)
    vi.spyOn(HTMLImageElement.prototype, 'naturalWidth', 'get').mockReturnValue(800)
    const wrapper = await renderPublished()
    expect(wrapper.emitted('load')).toEqual([[]])
    expect(wrapper.emitted('error')).toBeUndefined()
  })

  it('reports a failed cached image instead of inventing successful load during mount', async () => {
    vi.spyOn(HTMLImageElement.prototype, 'complete', 'get').mockReturnValue(true)
    const wrapper = await renderPublished()
    expect(wrapper.emitted('error')).toEqual([[]])
    expect(wrapper.emitted('load')).toBeUndefined()
  })

  it.each([
    '',
    '/img/products/demo.jpg',
    `https://arbitrary.invalid${imagePath}`,
    `https://media-private.r2.dev${imagePath}`,
    `https://example.r2.cloudflarestorage.com/bucket${imagePath}`,
    `//arbitrary.invalid${imagePath}`,
    `data:image/png;base64,${publicationId}`,
    `blob:https://arbitrary.invalid/${publicationId}`,
    'quarantine/upload/checksum',
    '/quarantine/upload/checksum',
    '/media/quarantine/original/image',
    '/media/not-a-uuid/image',
    imagePath.replace('/image', '/document'),
    imagePath.replace('/media/', '/%6dedia/'),
    imagePath.replace('/image', '/image/extra'),
    `${imagePath}?w=1800`,
    `${imagePath}?w=0800`,
    `${imagePath}?format=png`,
    `${imagePath}?format=webp&format=jpeg`,
    `${imagePath}?w=800&w=1600`,
    `${imagePath}?url=https://arbitrary.invalid/original`,
    `${imagePath}?w=800?format=avif`,
    `${imagePath}#fragment`,
    `${imagePath}\\extra`
  ])('renders no picture, source or image for an ungoverned source: %s', async (src) => {
    const wrapper = await renderPublished({ src })
    expect(wrapper.find('picture').exists()).toBe(false)
    expect(wrapper.find('source').exists()).toBe(false)
    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.emitted('load')).toBeUndefined()
    expect(wrapper.emitted('error')).toBeUndefined()
  })

  it('reactively changes all derivatives to the new publication and removes invalid sources', async () => {
    const wrapper = await renderPublished()
    const nextPath = '/media/87654321-4321-4321-bbbb-cba987654321/image'
    await wrapper.setProps({ src: `${nextPath}?w=400&format=avif` })
    expect(wrapper.get('img').attributes('src')).toBe(`${nextPath}?w=800&format=jpeg`)
    expect(wrapper.html()).not.toContain(publicationId)
    for (const source of wrapper.findAll('source')) expect(source.attributes('srcset')).toContain(nextPath)
    await wrapper.setProps({ src: 'quarantine/private-original/checksum' })
    expect(wrapper.find('picture').exists()).toBe(false)
    await wrapper.setProps({ src: imagePath })
    expect(wrapper.get('img').attributes('src')).toBe(`${imagePath}?w=800&format=jpeg`)
  })

  it('integrates with ProductImage: removes its loading skeleton and falls back honestly on native error', async () => {
    const wrapper = await renderProduct({ context: 'detail' })
    expect(wrapper.find('picture').exists()).toBe(true)
    expect(wrapper.find('[data-legacy-image]').exists()).toBe(false)
    expect(wrapper.find('.animate-pulse').exists()).toBe(true)
    await wrapper.get('img').trigger('load')
    expect(wrapper.find('.animate-pulse').exists()).toBe(false)
    await wrapper.get('img').trigger('error')
    expect(wrapper.find('picture').exists()).toBe(false)
    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.get('[data-product-visual]').attributes('aria-label')).toContain('no fotografía')
    expect(wrapper.text()).toContain('Todavía no tenemos foto de esta referencia.')
    expect(wrapper.get('a[href="/contacto"]').text()).toContain('Pídenosla')
  })

  it('integrates cached success/failure with ProductImage without leaving an endless skeleton', async () => {
    vi.spyOn(HTMLImageElement.prototype, 'complete', 'get').mockReturnValue(true)
    vi.spyOn(HTMLImageElement.prototype, 'naturalWidth', 'get').mockReturnValue(800)
    const loaded = await renderProduct()
    expect(loaded.find('picture').exists()).toBe(true)
    expect(loaded.find('.animate-pulse').exists()).toBe(false)
    vi.spyOn(HTMLImageElement.prototype, 'naturalWidth', 'get').mockReturnValue(0)
    const failed = await renderProduct()
    expect(failed.find('picture').exists()).toBe(false)
    expect(failed.find('[data-product-visual]').exists()).toBe(true)
    expect(failed.find('.animate-pulse').exists()).toBe(false)
  })

  it('resets ProductImage failure/loading state when a different governed publication is selected', async () => {
    const wrapper = await renderProduct()
    await wrapper.get('img').trigger('error')
    expect(wrapper.find('[data-product-visual]').exists()).toBe(true)
    const nextPath = '/media/87654321-4321-4321-bbbb-cba987654321/image'
    await wrapper.setProps({ product: { image: nextPath, imageAlt: 'Nueva fotografía explícita', name: 'Producto 1' } })
    expect(wrapper.find('[data-product-visual]').exists()).toBe(false)
    expect(wrapper.find('.animate-pulse').exists()).toBe(true)
    expect(wrapper.get('img').attributes('src')).toBe(`${nextPath}?w=800&format=jpeg`)
    expect(wrapper.get('img').attributes('alt')).toBe('Nueva fotografía explícita')
    await wrapper.get('img').trigger('load')
    expect(wrapper.find('.animate-pulse').exists()).toBe(false)
  })
})

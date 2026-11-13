import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { DOMWrapper, flushPromises } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import ProductGallery from '../../app/components/ProductGallery.vue'

mockNuxtImport('useRuntimeConfig', (original) => () => {
  const config = original()
  return { ...config, public: { ...config.public, mediaGoverned: true } }
})
const first = '/media/12345678-1234-4321-aaaa-123456789abc/image'
const second = '/media/87654321-4321-4321-bbbb-cba987654321/image'
const images = [
  { src: first, alt: 'Envase azul autorizado' },
  { src: second, alt: 'Etiqueta azul autorizada' }
]
const roots: Awaited<ReturnType<typeof mountSuspended>>[] = []
afterEach(() => roots.splice(0).forEach((root) => root.unmount()))
async function gallery(input = images) {
  const root = await mountSuspended(ProductGallery, {
    attachTo: document.body,
    props: { images: input, name: 'Producto azul', contextKey: 'azul' },
    slots: { empty: '<p data-empty>Fotografía bajo petición</p>' },
    global: { stubs: { UIcon: true, Teleport: false } }
  })
  roots.push(root)
  return root
}
const viewer = () => document.body.querySelector<HTMLElement>('[data-gallery-viewer]')

describe('product gallery', () => {
  it('offers governed thumbnails and keyboard navigation with a single selected option', async () => {
    const root = await gallery()
    const options = root.findAll('[role="option"]')
    expect(options).toHaveLength(2)
    expect(options[0]!.attributes('aria-selected')).toBe('true')
    await options[0]!.trigger('keydown', { key: 'End' })
    expect(options[1]!.attributes('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(options[1]!.element)
    const main = root.get('button[aria-label^="Ampliar"] img')
    expect(main.attributes('src')).toBe(`${second}?w=1200&format=jpeg`)
    expect(main.attributes('alt')).toBe(images[1]!.alt)
    await options[1]!.trigger('keydown', { key: 'ArrowRight' })
    expect(options[0]!.attributes('aria-selected')).toBe('true')
  })

  it('opens a bounded governed image, zooms, changes photo and closes with Escape', async () => {
    const root = await gallery()
    const opener = root.get('button[aria-label^="Ampliar"]')
    ;(opener.element as HTMLButtonElement).focus()
    await opener.trigger('click')
    await flushPromises()
    const dialog = new DOMWrapper(viewer()!)
    expect(dialog.get('img').attributes('src')).toBe(`${first}?w=1600&format=jpeg`)
    await dialog.trigger('keydown', { key: '+' })
    expect(dialog.get('img').attributes('style')).toContain('scale(1.5)')
    await dialog.trigger('keydown', { key: 'ArrowRight' })
    expect(dialog.get('img').attributes('src')).toBe(`${second}?w=1600&format=jpeg`)
    expect(dialog.get('img').attributes('style')).toContain('scale(1)')
    await dialog.trigger('keydown', { key: 'Escape' })
    await flushPromises()
    expect(viewer()).toBeNull()
    expect(document.activeElement).toBe(opener.element)
  })

  it('closes the viewer when another variant/source replaces its images', async () => {
    const root = await gallery()
    await root.get('button[aria-label^="Ampliar"]').trigger('click')
    await flushPromises()
    expect(viewer()).not.toBeNull()
    await root.setProps({ contextKey: 'otro', images: [{ src: second, alt: 'Otro formato' }] })
    await flushPromises()
    expect(viewer()).toBeNull()
    expect(root.get('button[aria-label^="Ampliar"] img').attributes('alt')).toBe('Otro formato')
  })

  it('removes failed images and shows the fallback when none remain', async () => {
    const root = await gallery([images[0]!])
    await root.get('button[aria-label^="Ampliar"] img').trigger('error')
    expect(root.find('img').exists()).toBe(false)
    expect(root.get('[data-empty]').text()).toContain('bajo petición')
  })

  it.each(['/img/products/legacy.webp', 'https://unapproved.invalid/photo.jpg', `${first}?token=private`])(
    'never renders an ungoverned source in the Cloudflare gallery: %s',
    async (src) => {
      const root = await gallery([{ src, alt: 'No autorizada' }])
      expect(root.find('img').exists()).toBe(false)
      expect(root.get('[data-empty]').exists()).toBe(true)
      expect(root.html()).not.toContain(src)
    }
  )
})

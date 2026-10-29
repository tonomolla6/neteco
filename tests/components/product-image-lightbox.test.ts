import { mount, DOMWrapper, flushPromises } from '@vue/test-utils'
import { computed, createSSRApp, defineComponent, h, nextTick, ref } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import Lightbox from '../../app/components/ProductImageLightbox.vue'
import '#app/nuxt-vitest-app-entry'

const src = '/media/12345678-1234-4321-aaaa-123456789abc/image?w=1600&format=jpeg'
const alt = 'Envase azul autorizado, etiqueta frontal'
const mounted: ReturnType<typeof mount>[] = []
const roots: HTMLElement[] = []
let previousOverflow: string | undefined
function dialog() {
  return new DOMWrapper(document.body.querySelector<HTMLElement>('[role="dialog"]')!)
}
async function render(props: Partial<{ open: boolean; src: string | null; contextKey: string }> = {}) {
  previousOverflow ??= document.body.style.overflow
  const root = document.createElement('div'),
    trigger = document.createElement('button'),
    outside = document.createElement('button')
  trigger.textContent = 'Abrir imagen'
  outside.textContent = 'Fondo ajeno'
  root.append(trigger, outside)
  document.body.append(root)
  roots.push(root)
  trigger.focus()
  const wrapper = mount(Lightbox, {
    attachTo: root,
    props: {
      src,
      alt,
      name: 'Producto azul',
      trigger,
      contextKey: 'variant-blue',
      open: true,
      ...props,
      'onUpdate:open': (value: boolean) => {
        void wrapper.setProps({ open: value })
      }
    }
  })
  mounted.push(wrapper)
  await flushPromises()
  return { wrapper, trigger, outside }
}
async function opened() {
  const value = await render()
  await vi.waitFor(() => expect(document.body.querySelector('[role="dialog"]')).not.toBeNull())
  return value
}
async function close() {
  await dialog().get('[data-lightbox-close]').trigger('click')
  await vi.waitFor(() => expect(document.body.querySelector('[role="dialog"]')).toBeNull())
}
afterEach(async () => {
  mounted.splice(0).forEach((wrapper) => wrapper.unmount())
  await nextTick()
  roots.splice(0).forEach((root) => root.remove())
  if (previousOverflow !== undefined) document.body.style.overflow = previousOverflow
  previousOverflow = undefined
  vi.restoreAllMocks()
})

it('does not mount or request a high-resolution image while closed, including SSR', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch')
  await render({ open: false })
  expect(document.body.querySelector('[role="dialog"], [data-lightbox-image]')).toBeNull()
  const html = await renderToString(
    createSSRApp({ render: () => h(Lightbox, { open: false, src, alt, name: 'Producto', trigger: null }) })
  )
  expect(html).not.toContain(src)
  expect(html).not.toContain('<img')
  expect(fetch).not.toHaveBeenCalled()
})
it('opens a labelled modal with contextual alt, lazy decoding and no referrer', async () => {
  await opened()
  expect(dialog().attributes('aria-modal')).toBe('true')
  const image = dialog().get('[data-lightbox-image]')
  expect(image.attributes('src')).toBe(src)
  expect(image.attributes('alt')).toBe(alt)
  expect(image.attributes('loading')).toBe('lazy')
  expect(image.attributes('decoding')).toBe('async')
  expect(image.attributes('referrerpolicy')).toBe('no-referrer')
  expect(dialog().text()).toContain('Producto azul')
  expect(dialog().text()).toContain('teclado')
})
it('opens from a real host whose high-resolution source is deferred until v-model becomes true', async () => {
  previousOverflow = document.body.style.overflow
  const root = document.createElement('div')
  document.body.append(root)
  roots.push(root)
  const host = defineComponent({
    setup() {
      const open = ref(false),
        trigger = ref<HTMLButtonElement | null>(null),
        deferred = computed(() => (open.value ? src : null))
      return () =>
        h('div', [
          h(
            'button',
            {
              ref: trigger,
              'data-host-trigger': '',
              onClick: () => {
                open.value = true
              }
            },
            'Ver imagen'
          ),
          h(Lightbox, {
            open: open.value,
            src: deferred.value,
            alt,
            name: 'Producto azul',
            trigger: trigger.value,
            contextKey: 'variant-blue',
            'onUpdate:open': (value: boolean) => {
              open.value = value
            }
          })
        ])
    }
  })
  const wrapper = mount(host, { attachTo: root })
  mounted.push(wrapper)
  expect(document.body.querySelector('[data-lightbox-image]')).toBeNull()
  await wrapper.get('[data-host-trigger]').trigger('click')
  await flushPromises()
  expect(document.body.querySelector('[role="dialog"]')).not.toBeNull()
  expect(dialog().get('[data-lightbox-image]').attributes('src')).toBe(src)
})
it('moves focus inside and wraps Tab and Shift+Tab without background focus', async () => {
  const { outside } = await opened()
  const first = dialog().get('[data-lightbox-close]').element as HTMLElement
  await vi.waitFor(() => expect(document.activeElement).toBe(first))
  const buttons = [...dialog().element.querySelectorAll<HTMLButtonElement>('button:not([disabled])')]
  const last = buttons.at(-1)!
  last.focus()
  last.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }))
  expect(document.activeElement).toBe(first)
  first.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }))
  expect(document.activeElement).toBe(last)
  outside.focus()
  await nextTick()
  expect(dialog().element.contains(document.activeElement)).toBe(true)
})
it('restores the current connected opening button on Escape', async () => {
  const { trigger } = await opened()
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  await vi.waitFor(() => expect(document.body.querySelector('[role="dialog"]')).toBeNull())
  await vi.waitFor(() => expect(document.activeElement).toBe(trigger))
})
it('does not focus a disconnected or replaced trigger', async () => {
  const { trigger, wrapper, outside } = await opened()
  trigger.remove()
  await wrapper.setProps({ trigger: outside })
  const focus = vi.spyOn(outside, 'focus')
  await close()
  expect(focus).not.toHaveBeenCalled()
})
it('locks body scroll and restores its prior value on close and unmount', async () => {
  previousOverflow = document.body.style.overflow
  document.body.style.overflow = 'scroll'
  const { wrapper } = await opened()
  expect(document.body.style.overflow).toBe('hidden')
  await close()
  expect(document.body.style.overflow).toBe('scroll')
  await wrapper.setProps({ open: true })
  await flushPromises()
  expect(document.body.style.overflow).toBe('hidden')
  wrapper.unmount()
  await nextTick()
  expect(document.body.style.overflow).toBe('scroll')
})
it('does not overwrite a foreign body style changed while the viewer was open', async () => {
  await opened()
  document.body.style.overflow = 'clip'
  await close()
  expect(document.body.style.overflow).toBe('clip')
})
it('only closes for the backdrop itself, not image or panel clicks', async () => {
  await opened()
  await dialog().get('[data-lightbox-image]').trigger('click')
  expect(document.body.querySelector('[role="dialog"]')).not.toBeNull()
  const backdrop = new DOMWrapper(document.body.querySelector<HTMLElement>('[data-lightbox-backdrop]')!)
  await backdrop.trigger('click')
  await vi.waitFor(() => expect(document.body.querySelector('[role="dialog"]')).toBeNull())
})
it('supports bounded centre zoom, keyboard pan and reset without requiring a mouse', async () => {
  await opened()
  const panel = dialog(),
    image = panel.get('[data-lightbox-image]')
  await panel.trigger('keydown', { key: '+' })
  expect(image.attributes('style')).toContain('scale(1.5)')
  await panel.trigger('keydown', { key: 'ArrowRight' })
  expect(image.attributes('style')).toContain('-10%')
  await panel.trigger('keydown', { key: 'ArrowDown' })
  expect(image.attributes('style')).toContain('-10%')
  for (let index = 0; index < 20; index++) await panel.get('[data-lightbox-zoom-in]').trigger('click')
  expect(image.attributes('style')).toContain('scale(3)')
  expect(panel.get('[data-lightbox-zoom-in]').attributes('disabled')).toBeDefined()
  await panel.trigger('keydown', { key: '0' })
  expect(image.attributes('style')).toContain('scale(1)')
  expect(image.attributes('style')).not.toContain('-10%')
  await panel.trigger('keydown', { key: '-' })
  expect(image.attributes('style')).toContain('scale(1)')
})
it('exposes touch-operable zoom, pan and reset buttons with reduced-motion styling', async () => {
  await opened()
  const panel = dialog()
  await panel.get('[data-lightbox-zoom-in]').trigger('click')
  await panel.get('[data-lightbox-pan-left]').trigger('click')
  expect(panel.get('[data-lightbox-image]').attributes('style')).toContain('10%')
  await panel.get('[data-lightbox-reset]').trigger('click')
  expect(panel.get('[data-lightbox-image]').attributes('style')).toContain('scale(1)')
  expect(panel.get('[data-lightbox-image]').classes()).toContain('motion-reduce:transition-none')
  expect(panel.element.querySelector('button:not([aria-label])')).toBeNull()
})
it.each([{ src: null }, { src: 'https://unapproved.invalid/image.jpg' }, { src: '//unapproved.invalid/image.jpg' }])(
  'clears an open invalid image without requesting a replacement %j',
  async (patch) => {
    const { wrapper } = await opened()
    await wrapper.setProps(patch)
    await vi.waitFor(() => expect(document.body.querySelector('[role="dialog"], [data-lightbox-image]')).toBeNull())
    expect(wrapper.emitted('update:open')?.at(-1)).toEqual([false])
  }
)
it('closes and clears zoom on a variant change, even when its image URL is shared', async () => {
  const { wrapper } = await opened()
  await dialog().get('[data-lightbox-zoom-in]').trigger('click')
  await wrapper.setProps({ contextKey: 'variant-red' })
  await vi.waitFor(() => expect(document.body.querySelector('[role="dialog"]')).toBeNull())
  await wrapper.setProps({ open: true })
  await flushPromises()
  expect(dialog().get('[data-lightbox-image]').attributes('style')).toContain('scale(1)')
})
it('shows a stable failure state with at most one explicit image retry per opening', async () => {
  await opened()
  await dialog().get('[data-lightbox-image]').trigger('error')
  expect(dialog().find('[data-lightbox-image]').exists()).toBe(false)
  expect(dialog().get('[role="alert"]').text()).toContain('imagen')
  await dialog().get('[data-lightbox-retry]').trigger('click')
  await dialog().get('[data-lightbox-image]').trigger('error')
  expect(dialog().find('[data-lightbox-retry]').exists()).toBe(false)
  expect(dialog().find('[data-lightbox-close]').exists()).toBe(true)
})

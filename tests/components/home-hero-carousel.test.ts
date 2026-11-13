import { mountSuspended } from '@nuxt/test-utils/runtime'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import HomeHeroCarousel from '../../app/components/home/HomeHeroCarousel.vue'
import type { ProductCardData } from '../../shared/types/catalog'

const roots: Awaited<ReturnType<typeof mountSuspended>>[] = []
let tick: (() => void) | undefined
let reduced = false
beforeEach(() => {
  tick = undefined
  reduced = false
  const nativeInterval = globalThis.setInterval
  vi.spyOn(globalThis, 'setInterval').mockImplementation(((
    handler: () => void,
    timeout: number,
    ...args: unknown[]
  ) => {
    if (timeout === 6000) {
      tick = handler
      return 78342
    }
    return nativeInterval(handler, timeout, ...args)
  }) as typeof setInterval)
  vi.spyOn(window, 'matchMedia').mockImplementation((media) => ({
    media,
    matches: reduced,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: () => true
  }))
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
})
afterEach(() => {
  roots.splice(0).forEach((root) => root.unmount())
  vi.restoreAllMocks()
})
const card: ProductCardData = {
  id: 1,
  slug: 'producto-1',
  name: 'Producto de prueba',
  brand: 'NETECO',
  image: null,
  imageAlt: null,
  visual: { type: 'garrafa', color: '#fff' },
  minPrice: 500,
  minNetPrice: 413,
  compareAtPrice: null,
  formats: 1,
  badges: []
}
async function mount(heading: 'h1' | 'h2' = 'h1') {
  const root = await mountSuspended(HomeHeroCarousel, {
    props: { offers: [card], featured: [card], heading },
    global: { stubs: { UIcon: true, ProductImage: true, PriceBlock: true } }
  })
  Object.defineProperty(root.get('[aria-live]').element, 'scrollTo', { configurable: true, value: vi.fn() })
  roots.push(root)
  return root
}
const current = (root: Awaited<ReturnType<typeof mount>>) =>
  root.findAll('[aria-roledescription="diapositiva"]').findIndex((slide) => slide.attributes('inert') === undefined)

describe('home carousel controls', () => {
  it('keeps only the current slide in the tab order and supports the returning-customer heading', async () => {
    const root = await mount('h2')
    expect(root.find('h1').exists()).toBe(false)
    expect(root.find('h2').exists()).toBe(true)
    expect(current(root)).toBe(0)
    expect(root.findAll('[aria-roledescription="diapositiva"]:not([inert])')).toHaveLength(1)
  })
  it('advances at the configured interval and pauses for hover and focus', async () => {
    const root = await mount()
    tick!()
    await root.vm.$nextTick()
    expect(current(root)).toBe(1)
    await root.get('[data-home-hero]').trigger('mouseenter')
    tick!()
    await root.vm.$nextTick()
    expect(current(root)).toBe(1)
    await root.get('[data-home-hero]').trigger('mouseleave')
    await root.get('[data-home-hero]').trigger('focusin')
    tick!()
    await root.vm.$nextTick()
    expect(current(root)).toBe(1)
  })
  it('stops automatic movement after keyboard navigation and wraps at the beginning', async () => {
    const root = await mount()
    const total = root.findAll('[aria-roledescription="diapositiva"]').length
    await root.get('[data-home-hero]').trigger('focusin')
    await root.get('[data-home-hero]').trigger('keydown', { key: 'ArrowLeft' })
    expect(current(root)).toBe(total - 1)
    tick!()
    await root.vm.$nextTick()
    expect(current(root)).toBe(total - 1)
  })
  it('honours reduced motion before any automatic advance', async () => {
    reduced = true
    const root = await mount()
    tick!()
    await root.vm.$nextTick()
    expect(current(root)).toBe(0)
  })
  it('keeps keyboard focus paused after the pointer leaves and resumes only through its explicit control', async () => {
    const root = await mount()
    await root.get('[data-home-hero]').trigger('mouseenter')
    await root.get('[data-home-hero]').trigger('focusin')
    await root.get('[data-home-hero]').trigger('mouseleave')
    tick!()
    await root.vm.$nextTick()
    expect(current(root)).toBe(0)
    expect(root.get('[aria-live]').attributes('aria-live')).toBe('polite')
    await root.get('[aria-label="Pausar el pase automático"]').trigger('click')
    tick!()
    await root.vm.$nextTick()
    expect(current(root)).toBe(0)
    await root.get('[aria-label="Reanudar el pase automático"]').trigger('click')
    tick!()
    await root.vm.$nextTick()
    expect(current(root)).toBe(1)
  })
  it('clears its owned interval when unmounted', async () => {
    const root = await mount()
    const clear = vi.spyOn(globalThis, 'clearInterval')
    root.unmount()
    roots.splice(roots.indexOf(root), 1)
    expect(clear).toHaveBeenCalledWith(78342)
  })
})

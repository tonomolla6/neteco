// @vitest-environment nuxt
import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AppHeader from '../../app/components/AppHeader.vue'
import AppBottomBar from '../../app/components/AppBottomBar.vue'
import DefaultLayout from '../../app/layouts/default.vue'

const state = vi.hoisted(() => ({
  loggedIn: false,
  orders: [] as Array<Record<string, unknown>>,
  path: '/',
  start: vi.fn()
}))
mockNuxtImport('useUserSession', () => () => ({
  loggedIn: ref(state.loggedIn),
  user: ref(state.loggedIn ? { id: 'u', name: 'Bar Central', email: 'compras@example.invalid', company: null } : null),
  session: ref(null),
  ready: ref(true),
  clear: vi.fn()
}))
mockNuxtImport('useRoute', () => () => ({ path: state.path, fullPath: state.path, query: {} }))
mockNuxtImport('useFetch', () => async (url: string) => ({
  data: ref(
    url === '/api/orders'
      ? { orders: state.orders }
      : {
          roots: [
            { id: 1, name: 'Productos químicos', slug: 'productos-quimicos', count: 0, children: [] },
            {
              id: 2,
              name: 'Menaje y hostelería',
              slug: 'menaje-hosteleria',
              count: 20,
              children: [{ id: 3, name: 'Guantes', slug: 'guantes', count: 20, children: [] }]
            }
          ]
        }
  )
}))

const stubs = {
  SearchBox: true,
  ReorderDialog: { template: '<div data-reorder-dialog />', methods: { start: state.start } },
  AppFooter: true,
  ConsentManager: true,
  MarketingModalHost: true
}
const wrappers: Array<{ unmount: () => void }> = []
async function mount<T>(component: T, options: Record<string, unknown> = {}) {
  const wrapper = await mountSuspended(component as never, { global: { stubs }, ...options })
  wrappers.push(wrapper)
  await flushPromises()
  return wrapper
}
beforeEach(() => {
  state.loggedIn = false
  state.orders = []
  state.path = '/'
  state.start.mockReset()
})
afterEach(() => wrappers.splice(0).forEach((wrapper) => wrapper.unmount()))

describe('shop header as the entry to ordering', () => {
  it('always links to quick order and to the lists, and lets the visitor switch VAT', async () => {
    const header = await mount(AppHeader)
    const quick = header.get('[data-header-quick-order]')
    expect(quick.attributes('href')).toBe('/pedido-rapido')
    expect(quick.text()).toContain('Pedido rápido')
    expect(header.get('[data-header-lists]').attributes('href')).toBe('/cuenta/listas')
    expect(header.get('[data-header-lists]').text()).toContain('Listas')
    expect(header.find('[role="radiogroup"][aria-label="Precios"]').exists()).toBe(true)
  })

  it('leaves families without products out of the menu', async () => {
    const header = await mount(AppHeader)
    expect(header.find('a[href="/categoria/productos-quimicos"]').exists()).toBe(false)
    expect(header.find('a[href="/categoria/menaje-hosteleria"]').exists()).toBe(true)
    await header.get('[aria-label="Abrir menú"]').trigger('click')
    await flushPromises()
    const menu = document.querySelector('[role="dialog"][aria-label="Menú de navegación"]')!
    expect(menu.textContent).not.toContain('Productos químicos')
    expect(menu.textContent).toContain('Menaje y hostelería')
    expect(menu.querySelector('a[href="/cuenta/listas"]')).not.toBeNull()
  })

  it('offers to repeat the last order only to a signed-in customer who has one', async () => {
    expect((await mount(AppHeader)).find('[data-header-reorder]').exists()).toBe(false)
    state.loggedIn = true
    expect((await mount(AppHeader)).find('[data-header-reorder]').exists()).toBe(false)
    state.orders = [{ id: 'ord-9', status: 'entregado', total: 14260, createdAt: '2026-10-03T10:00:00Z', lines: 8 }]
    const header = await mount(AppHeader)
    const repeat = header.get('[data-header-reorder]')
    expect(repeat.text()).toContain('Repetir último pedido')
    await repeat.trigger('click')
    expect(state.start).toHaveBeenCalledWith('ord-9')
  })
})

describe('mobile bottom bar', () => {
  it('has four large destinations and is hidden from the desktop layout', async () => {
    const bar = await mount(AppBottomBar)
    const nav = bar.get('nav')
    expect(nav.attributes('aria-label')).toBe('Accesos rápidos')
    expect(nav.classes()).toContain('lg:hidden')
    const links = bar.findAll('a')
    expect(links.map((link) => [link.text(), link.attributes('href')])).toEqual([
      ['Inicio', '/'],
      ['Buscar', '/buscar'],
      ['Pedido rápido', '/pedido-rapido'],
      ['Listas', '/cuenta/listas']
    ])
    expect(links.every((link) => link.classes().includes('min-h-14'))).toBe(true)
    expect(bar.get('a[href="/"]').attributes('aria-current')).toBe('page')
  })

  it.each(['/checkout', '/carrito', '/producto/guante-nitrilo', '/admin', '/admin/pedidos'])(
    'is not rendered on %s, where a purchase bar or another shell owns the bottom edge',
    async (path) => {
      state.path = path
      expect((await mount(AppBottomBar)).find('nav').exists()).toBe(false)
    }
  )

  it('the layout reserves its height so it never covers content', async () => {
    const layout = await mount(DefaultLayout, { slots: { default: '<p>contenido</p>' } })
    expect(layout.find('nav[aria-label="Accesos rápidos"]').exists()).toBe(true)
    expect(layout.get('#contenido-principal').classes()).toContain('pb-14')
    expect(layout.get('#contenido-principal').classes()).toContain('lg:pb-0')
    state.path = '/checkout'
    const checkout = await mount(DefaultLayout, { slots: { default: '<p>contenido</p>' } })
    expect(checkout.get('#contenido-principal').classes()).not.toContain('pb-14')
  })
})

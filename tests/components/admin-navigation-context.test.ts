import { mountSuspended } from '@nuxt/test-utils/runtime'
import { afterEach, describe, expect, it } from 'vitest'
import AdminNavigationContext from '../../app/components/AdminNavigationContext.vue'
import type { AdminNavigationLink } from '../../shared/admin-navigation'
import '#app/nuxt-vitest-app-entry'

// UI003: supplied authorized destinations only; segment-specific breadcrumbs,
// generic detail labels without raw route/query data; mounted-only recent
// navigation max five/dedup; revocation, transient loading and session isolation;
// native keyboard links, accessible current location, legacy routes, no storage/API.
const groups = [
  {
    label: 'Operación',
    links: [
      { to: '/admin', label: 'Hoy', icon: '', exact: true },
      ...['pedidos', 'productos', 'clientes', 'flags', 'soporte', 'inventario'].map((name) => ({
        to: `/admin/${name}`,
        label: name,
        icon: ''
      }))
    ]
  }
]
type Wrapper = Awaited<ReturnType<typeof mountSuspended>>
const mounted: Wrapper[] = []
async function render(path = '/admin/pedidos', value: Array<{ label: string; links: AdminNavigationLink[] }> = groups) {
  const wrapper = await mountSuspended(AdminNavigationContext, {
    props: { groups: value, path, scopeKey: 'actor-session-1', enabled: true },
    global: { stubs: { NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' } } }
  })
  mounted.push(wrapper)
  return wrapper
}
afterEach(() => {
  mounted.splice(0).forEach((wrapper) => wrapper.unmount())
})
const recent = (wrapper: Wrapper) => wrapper.findAll('[data-recent] a').map((link) => link.attributes('href'))

describe('authorized administrative navigation context', () => {
  it('hides links during same-session verification and restores authorized canonical recent navigation', async () => {
    const wrapper = await render()
    await wrapper.setProps({ pending: true, enabled: false, groups: [], path: '/admin/productos' })
    expect(wrapper.find('a').exists()).toBe(false)
    expect(wrapper.text()).toBe('')
    await wrapper.setProps({ pending: false, enabled: true, groups })
    expect(recent(wrapper)).toEqual(['/admin/productos', '/admin/pedidos'])
  })
  it('purges retained history when pending verification becomes an authorization error', async () => {
    const wrapper = await render()
    await wrapper.setProps({ pending: true, enabled: false, groups: [] })
    await wrapper.setProps({ pending: false })
    await wrapper.setProps({ enabled: true, groups, path: '/admin/productos' })
    expect(recent(wrapper)).toEqual(['/admin/productos'])
  })
  it('purges canonical history on identity change even while verification is pending', async () => {
    const wrapper = await render()
    await wrapper.setProps({
      pending: true,
      enabled: false,
      groups: [],
      scopeKey: 'new-actor-session',
      path: '/admin/productos'
    })
    await wrapper.setProps({ pending: false, enabled: true, groups })
    expect(recent(wrapper)).toEqual(['/admin/productos'])
  })
  it('renders supplied grouping, breadcrumb home and current page semantics', async () => {
    const wrapper = await render()
    expect(wrapper.get('nav[aria-label="Ubicación administrativa"]').text()).toContain('pedidos')
    expect(wrapper.get('[aria-current="page"]').text()).toBe('pedidos')
    expect(wrapper.get('[data-breadcrumbs] a').attributes('href')).toBe('/admin')
    expect(wrapper.text()).toContain('Operación')
  })
  it('uses a generic detail and never exposes UUID, query, fragment or client label', async () => {
    const wrapper = await render('/admin/pedidos/10000000-0000-4000-8000-000000000001?cliente=Privado#secreto')
    expect(wrapper.get('[aria-current="page"]').text()).toBe('Detalle')
    expect(wrapper.get('[data-breadcrumbs] a[href="/admin/pedidos"]').text()).toBe('pedidos')
    expect(wrapper.html()).not.toMatch(/10000000|Privado|secreto|cliente=/)
    expect(recent(wrapper)).toEqual(['/admin/pedidos'])
  })
  it.each(['/admin/pedidosX', '/admin/desconocido', '/admin//pedidos', '/admin/pedidos/../clientes'])(
    'does not manufacture a breadcrumb for %s',
    async (path) => {
      const wrapper = await render(path)
      expect(wrapper.find('[data-breadcrumbs]').exists()).toBe(false)
      expect(recent(wrapper)).toEqual([])
    }
  )
  it('selects the most specific supplied parent and respects exact links', async () => {
    const wrapper = await render('/admin/pedidos/archivo/123', [
      { label: 'Operación', links: [...groups[0]!.links, { to: '/admin/pedidos/archivo', label: 'Archivo', icon: '' }] }
    ])
    expect(wrapper.get('[data-breadcrumbs] a[href="/admin/pedidos/archivo"]').text()).toBe('Archivo')
    await wrapper.setProps({
      groups: [{ label: 'Operación', links: [{ to: '/admin/pedidos', label: 'Pedidos', icon: '', exact: true }] }]
    })
    expect(wrapper.find('[data-breadcrumbs]').exists()).toBe(false)
  })
  it('does not invent a home link when not supplied and normalizes a trailing slash', async () => {
    const wrapper = await render('/admin/productos/?q=private', [
      { label: 'Catálogo', links: [{ to: '/admin/productos', label: 'Productos', icon: '' }] }
    ])
    expect(wrapper.get('[aria-current="page"]').text()).toBe('Productos')
    expect(wrapper.find('[data-breadcrumbs] a').exists()).toBe(false)
  })
  it('keeps at most five canonical destinations, newest first, deduplicating detail visits', async () => {
    const wrapper = await render()
    for (const path of ['productos', 'clientes', 'flags', 'soporte', 'inventario', 'productos/uuid?pii=secret'])
      await wrapper.setProps({ path: `/admin/${path}` })
    expect(recent(wrapper)).toEqual([
      '/admin/productos',
      '/admin/inventario',
      '/admin/soporte',
      '/admin/flags',
      '/admin/clientes'
    ])
    expect(wrapper.text()).toContain('Páginas visitadas en este panel')
    expect(wrapper.html()).not.toContain('secret')
  })
  it.each(['disabled', 'empty', 'scope'] as const)('purges old history on %s authority transition', async (mode) => {
    const wrapper = await render()
    await wrapper.setProps({ path: '/admin/productos' })
    expect(recent(wrapper)).toEqual(['/admin/productos', '/admin/pedidos'])
    await wrapper.setProps(
      mode === 'disabled' ? { enabled: false } : mode === 'empty' ? { groups: [] } : { scopeKey: 'other-session' }
    )
    if (mode !== 'scope') expect(wrapper.find('[data-breadcrumbs]').exists()).toBe(false)
    expect(recent(wrapper)).not.toContain('/admin/pedidos')
    await wrapper.setProps({ enabled: true, groups, path: '/admin/soporte' })
    expect(recent(wrapper)).not.toContain('/admin/pedidos')
  })
  it('removes withdrawn destinations immediately while preserving remaining authorized navigation', async () => {
    const wrapper = await render()
    await wrapper.setProps({ path: '/admin/productos' })
    await wrapper.setProps({ groups: [{ label: 'Catálogo', links: [groups[0]!.links[2]!] }] })
    expect(recent(wrapper)).toEqual(['/admin/productos'])
    expect(wrapper.html()).not.toContain('/admin/pedidos')
  })
  it('uses native focusable links including legacy Node destinations, without simulated actions', async () => {
    const wrapper = await render('/admin/clientes')
    await wrapper.setProps({ path: '/admin/flags' })
    const link = wrapper.get('[data-recent] a[href="/admin/clientes"]')
    expect(link.element.tagName).toBe('A')
    expect(link.attributes('tabindex')).not.toBe('-1')
    await link.trigger('keydown', { key: 'Enter' })
    expect(link.attributes('href')).toBe('/admin/clientes')
    expect(wrapper.text()).not.toMatch(/auditad|acción reciente/i)
  })
  it('blocks unsafe supplied destinations and empty session scopes', async () => {
    const wrapper = await render('/admin/pedidos', [
      {
        label: 'Unsafe',
        links: [
          { to: 'https://example.com', label: 'External', icon: '' },
          { to: '/admin/pedidos?token=secret', label: 'Secret', icon: '' }
        ]
      }
    ])
    expect(wrapper.find('a').exists()).toBe(false)
    await wrapper.setProps({ groups, scopeKey: '' })
    expect(wrapper.find('[data-breadcrumbs]').exists()).toBe(false)
  })
})

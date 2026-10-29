import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { reactive, ref, defineComponent, h, type Ref } from 'vue'
import { useNuxtApp, useState } from '#app'
import { useAdminNavigation } from '../../app/composables/useAdminNavigation'
import AdminLayout from '../../app/layouts/admin.vue'
import AppHeader from '../../app/components/AppHeader.vue'
import { adminNavigationGroups, canNavigateAdmin, type AdminCapabilities } from '../../shared/admin-navigation'
import '#app/nuxt-vitest-app-entry'

const { request, sessionMock, routeMock, routerMock, runtimeMock } = vi.hoisted(() => ({
  request: vi.fn(),
  sessionMock: vi.fn(),
  routeMock: vi.fn(),
  routerMock: vi.fn(),
  runtimeMock: vi.fn(() => ({
    app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
    public: { serverRuntime: 'cloudflare' }
  }))
}))
mockNuxtImport('useRequestFetch', () => () => request)
mockNuxtImport('useUserSession', () => sessionMock)
mockNuxtImport('useRoute', () => routeMock)
mockNuxtImport('useRouter', () => () => {
  const router = useNuxtApp().$router
  const override = routerMock()
  return override
    ? new Proxy(router, {
        get: (target, key) => (key === 'currentRoute' ? override.currentRoute : Reflect.get(target, key))
      })
    : router
})
mockNuxtImport('useRuntimeConfig', () => runtimeMock)
mockNuxtImport('useFetch', () => async () => ({ data: ref({ roots: [] }) }))
const identityId = '10000000-0000-4000-8000-000000000001',
  sessionId = '20000000-0000-4000-8000-000000000001'
let actor: {
  loggedIn: Ref<boolean>
  user: Ref<Record<string, unknown>>
  session: Ref<Record<string, unknown>>
  clear: () => Promise<void>
}
let route: { path: string; fullPath: string }
let routerRoute: Ref<{ path: string; fullPath: string }>
let wrappers: Awaited<ReturnType<typeof mountSuspended>>[] = []
const caps = (permissions = ['support.manage'], state = 'ready') => ({
  source: 'cloudflare',
  identityId,
  sessionId,
  sessionVersion: 1,
  state,
  permissions
})
it('offers promotion administration only to a currently authorized administrator, never catalog-only or revoked authority', () => {
  const admin = caps(['administration.manage']) as AdminCapabilities
  expect(
    adminNavigationGroups(admin)
      .flatMap((group) => group.links)
      .map((link) => link.to)
  ).toContain('/admin/promociones')
  expect(canNavigateAdmin('/admin/promociones', admin)).toBe(true)
  expect(canNavigateAdmin('/admin/promociones', caps(['catalog.write']) as AdminCapabilities)).toBe(false)
  expect(canNavigateAdmin('/admin/promociones', { ...admin, state: 'forbidden', permissions: [] })).toBe(false)
})
it('offers the catalog quality queue only with live catalog authority', () => {
  const catalog = caps(['catalog.write']) as AdminCapabilities
  expect(
    adminNavigationGroups(catalog)
      .flatMap((group) => group.links)
      .map((link) => link.to)
  ).toContain('/admin/calidad-catalogo')
  expect(canNavigateAdmin('/admin/calidad-catalogo', catalog)).toBe(true)
  expect(canNavigateAdmin('/admin/calidad-catalogo', caps(['support.manage']) as AdminCapabilities)).toBe(false)
  expect(canNavigateAdmin('/admin/calidad-catalogo', { ...catalog, state: 'forbidden', permissions: [] })).toBe(false)
})
const stubs = {
  AdminGlobalSearch: {
    name: 'AdminGlobalSearch',
    props: ['enabled', 'scopeKey', 'pending', 'groups'],
    template: '<div data-admin-global-search-probe />'
  },
  AdminRecentActivity: {
    name: 'AdminRecentActivity',
    props: ['enabled', 'scopeKey', 'pending'],
    template: '<div data-admin-activity-probe />'
  },
  AdminNavigationContext: {
    name: 'AdminNavigationContext',
    props: ['groups', 'enabled', 'path', 'scopeKey', 'pending'],
    template: '<div data-admin-context-probe />'
  },
  AdminCommandPalette: {
    name: 'AdminCommandPalette',
    props: ['groups', 'enabled'],
    template: '<button data-command-palette-probe :disabled="!enabled">Buscar tareas</button>'
  },
  SearchBox: true,
  UIcon: true,
  PackageIcon: true,
  UButton: { props: ['to'], template: '<a v-if="to" :href="to"><slot /></a><button v-else><slot /></button>' },
  UAlert: {
    props: ['title', 'description'],
    template: '<div role="alert">{{title}}{{description}}<slot name="actions" /></div>'
  }
}
async function mount(header = false) {
  const wrapper = await mountSuspended(header ? AppHeader : AdminLayout, {
    slots: header ? {} : { default: 'Contenido privado' },
    global: { stubs }
  })
  wrappers.push(wrapper)
  await flushPromises()
  return wrapper
}
beforeEach(async () => {
  vi.clearAllMocks()
  runtimeMock.mockReturnValue({
    app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
    public: { serverRuntime: 'cloudflare' }
  })
  const { clearNuxtState } = await import('#app')
  clearNuxtState('admin-navigation')
  actor = {
    loggedIn: ref(true),
    user: ref({ id: identityId, name: 'Staff', role: 'customer', emailVerified: true, mfaVerified: true }),
    session: ref({ sessionId, sessionVersion: 1 }),
    clear: async () => undefined
  }
  route = reactive({ path: '/admin/soporte', fullPath: '/admin/soporte' })
  routerRoute = ref(route)
  sessionMock.mockReturnValue(actor)
  routeMock.mockReturnValue(route)
  routerMock.mockReturnValue({ currentRoute: routerRoute })
  request.mockResolvedValue(caps())
})
afterEach(() => {
  for (const wrapper of wrappers) wrapper.unmount()
  wrappers = []
})

describe('permission-based staff navigation', () => {
  it('recovers hydrated loading state with a matching key but no client promise and releases the authorized slot', async () => {
    route.path = route.fullPath = '/admin/inventario'
    request.mockResolvedValue(caps(['inventory.read']))
    let navigation!: ReturnType<typeof useAdminNavigation>
    const Harness = defineComponent({
      setup() {
        const state = useState('admin-navigation')
        state.value = {
          key: JSON.stringify([true, identityId, sessionId, 1, true, true]) + '|' + route.fullPath,
          generation: 9,
          status: 'loading',
          capabilities: null
        }
        navigation = useAdminNavigation()
        return () =>
          navigation.routeAllowed.value
            ? h('div', { 'data-hydrated-inventory-slot': '' }, 'Inventario autorizado')
            : h('div', 'Comprobando permisos')
      }
    })
    const wrapper = await mountSuspended(Harness)
    wrappers.push(wrapper)
    await flushPromises()
    expect(request).toHaveBeenCalledExactlyOnceWith('/api/admin/capabilities', { cache: 'no-store' })
    expect(navigation.status.value).toBe('ready')
    expect(navigation.capabilities.value).toEqual(caps(['inventory.read']))
    expect(wrapper.find('[data-hydrated-inventory-slot]').exists()).toBe(true)
  })

  it('does not restart loading when another client consumer owns the actual pending promise', async () => {
    let resolve!: (value: unknown) => void
    request.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done
        })
    )
    let first!: ReturnType<typeof useAdminNavigation>, second!: ReturnType<typeof useAdminNavigation>
    const Child = defineComponent({
      setup() {
        second = useAdminNavigation()
        return () => h('div', second.status.value)
      }
    })
    const Harness = defineComponent({
      setup() {
        first = useAdminNavigation()
        return () => h(Child)
      }
    })
    const wrapper = await mountSuspended(Harness)
    wrappers.push(wrapper)
    expect(first.status.value).toBe('loading')
    expect(second.status.value).toBe('loading')
    expect(request).toHaveBeenCalledTimes(1)
    resolve(caps())
    await flushPromises()
    expect(first.status.value).toBe('ready')
    expect(second.status.value).toBe('ready')
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('retains matching ready SSR capabilities without an unnecessary client read', async () => {
    let navigation!: ReturnType<typeof useAdminNavigation>
    const Harness = defineComponent({
      setup() {
        const state = useState('admin-navigation')
        state.value = {
          key: JSON.stringify([true, identityId, sessionId, 1, true, true]) + '|' + route.fullPath,
          generation: 9,
          status: 'ready',
          capabilities: caps()
        }
        navigation = useAdminNavigation()
        return () =>
          navigation.routeAllowed.value ? h('div', { 'data-ready-ssr-slot': '' }, 'Contenido autorizado') : h('div')
      }
    })
    const wrapper = await mountSuspended(Harness)
    wrappers.push(wrapper)
    await flushPromises()
    expect(request).not.toHaveBeenCalled()
    expect(navigation.status.value).toBe('ready')
    expect(wrapper.find('[data-ready-ssr-slot]').exists()).toBe(true)
  })

  it.each([
    ['cloudflare', false],
    ['cloudflare', true],
    ['node', false],
    ['node', true]
  ] as const)(
    'offers the implemented quick-order route on desktop/mobile: %s, loggedIn=%s',
    async (runtime, loggedIn) => {
      runtimeMock.mockReturnValue({
        app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
        public: { serverRuntime: runtime }
      })
      actor.loggedIn.value = loggedIn
      if (!loggedIn) actor.user.value = {}
      const wrapper = await mount(true)
      expect(wrapper.findAll('a[href="/pedido-rapido"]')).toHaveLength(runtime === 'cloudflare' ? 1 : 0)
      await wrapper.get('[aria-label="Abrir menú"]').trigger('click')
      await flushPromises()
      // The actual mobile navigation is teleported outside the mounted header.
      const menu = document.querySelector('[role="dialog"][aria-label="Menú de navegación"]')
      expect(menu).not.toBeNull()
      expect(menu!.querySelectorAll('a[href="/pedido-rapido"]')).toHaveLength(runtime === 'cloudflare' ? 1 : 0)
      expect(menu!.querySelector('a[href="/catalogo"]')).not.toBeNull()
      expect(wrapper.find('a[href="/catalogo"]').exists()).toBe(true)
    }
  )

  it.each(['ready', 'denied', 'session-changed'] as const)(
    'does not deadlock the real layout on deferred Nuxt SPA route handoff: %s',
    async (mode) => {
      route.path = '/admin/pedidos'
      route.fullPath = route.path
      request.mockResolvedValue(caps(['administration.manage']))
      let middlewareNavigation!: ReturnType<typeof useAdminNavigation>
      const Harness = defineComponent({
        setup() {
          middlewareNavigation = useAdminNavigation()
          return () =>
            h(
              AdminLayout,
              {},
              { default: () => h('div', { 'data-real-detail-mount': '' }, 'Detalle privado autorizado') }
            )
        }
      })
      const wrapper = await mountSuspended(Harness, { global: { stubs } })
      wrappers.push(wrapper)
      await flushPromises()
      expect(wrapper.find('[data-real-detail-mount]').exists()).toBe(true)
      const target = '/admin/pedidos/30000000-0000-4000-8000-000000000001'
      request.mockResolvedValue(
        caps(mode === 'denied' ? [] : ['administration.manage'], mode === 'denied' ? 'forbidden' : 'ready')
      )
      // Middleware authorizes `to` before Vue Router commits it. Nuxt's useRoute
      // deliberately remains on the old page until page:finish can fire.
      await middlewareNavigation.refresh(target)
      if (mode === 'session-changed') {
        request.mockRejectedValue(new Error('new session authority unavailable'))
        actor.session.value.sessionVersion = 2
      }
      routerRoute.value = { path: target, fullPath: target }
      await flushPromises()
      expect(route.fullPath).toBe('/admin/pedidos')
      expect(wrapper.find('[data-real-detail-mount]').exists()).toBe(mode === 'ready')
      expect(middlewareNavigation.routeAllowed.value).toBe(mode === 'ready')
      if (mode === 'ready') expect(middlewareNavigation.status.value).toBe('ready')
    }
  )
  it('binds global entity search to current authorized groups and invalidates it when the session changes', async () => {
    request.mockResolvedValueOnce(caps(['catalog.write']))
    const wrapper = await mount()
    const search = wrapper.findComponent({ name: 'AdminGlobalSearch' })
    expect(search.exists()).toBe(true)
    expect(search.props('enabled')).toBe(true)
    expect(search.props('pending')).toBe(false)
    expect(
      search.props('groups').flatMap((group: { links: Array<{ to: string }> }) => group.links.map((link) => link.to))
    ).toContain('/admin/productos')
    const originalScope = search.props('scopeKey')
    request.mockRejectedValueOnce(new Error('unavailable'))
    actor.session.value.sessionVersion = 2
    await flushPromises()
    expect(search.props('scopeKey')).not.toBe(originalScope)
    expect(search.props('enabled')).toBe(false)
    expect(search.props('groups')).toEqual([])
  })
  it('binds audited activity to live Cloudflare authority and invalidates it on session failure', async () => {
    const wrapper = await mount()
    const activity = wrapper.findComponent({ name: 'AdminRecentActivity' })
    expect(activity.exists()).toBe(true)
    expect(activity.props('enabled')).toBe(true)
    expect(activity.props('pending')).toBe(false)
    const originalScope = activity.props('scopeKey')
    request.mockRejectedValueOnce(new Error('unavailable'))
    actor.session.value.sessionVersion = 2
    await flushPromises()
    expect(activity.props('scopeKey')).not.toBe(originalScope)
    expect(activity.props('enabled')).toBe(false)
  })
  it('does not mount a Cloudflare audited activity reader on the legacy Node deployment', async () => {
    runtimeMock.mockReturnValue({
      app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
      public: { serverRuntime: 'node' }
    })
    const wrapper = await mount()
    expect(wrapper.findComponent({ name: 'AdminRecentActivity' }).exists()).toBe(false)
    expect(wrapper.findComponent({ name: 'AdminGlobalSearch' }).exists()).toBe(false)
  })
  it('mounts authorized context bound to the current identity and session and clears it on loss of authority', async () => {
    const wrapper = await mount()
    const context = wrapper.findComponent({ name: 'AdminNavigationContext' })
    expect(context.exists()).toBe(true)
    expect(context.props('path')).toBe('/admin/soporte')
    expect(context.props('enabled')).toBe(true)
    expect(context.props('pending')).toBe(false)
    expect(
      context.props('groups').flatMap((group: { links: Array<{ to: string }> }) => group.links.map((link) => link.to))
    ).toEqual(['/admin/soporte'])
    const originalScope = context.props('scopeKey')
    request.mockRejectedValueOnce(new Error('unavailable'))
    actor.session.value.sessionVersion = 2
    await flushPromises()
    expect(context.props('scopeKey')).not.toBe(originalScope)
    expect(context.props('enabled')).toBe(false)
    expect(context.props('groups')).toEqual([])
    expect(context.props('pending')).toBe(false)
  })
  it('does not mark a route with a matching string prefix as the current section', async () => {
    route.path = '/admin/pedidos-historia'
    route.fullPath = route.path
    request.mockResolvedValue(caps(['administration.manage']))
    const wrapper = await mount()
    expect(wrapper.find('#admin-nav [aria-current="page"]').exists()).toBe(false)
  })
  it('mounts the task palette with only live authorized groups and disables it after authority is lost', async () => {
    const wrapper = await mount()
    const palette = wrapper.findComponent({ name: 'AdminCommandPalette' })
    expect(palette.exists()).toBe(true)
    expect(palette.props('enabled')).toBe(true)
    expect(
      palette.props('groups').flatMap((group: { links: Array<{ to: string }> }) => group.links.map((link) => link.to))
    ).toEqual(['/admin/soporte'])
    request.mockRejectedValueOnce(new Error('permissions_unavailable'))
    actor.session.value.sessionVersion = 2
    await flushPromises()
    expect(palette.props('enabled')).toBe(false)
    expect(palette.props('groups')).toEqual([])
  })
  it('deduplicates concurrent self reads for the same identity, session and route', async () => {
    const resolvers: Array<(value: unknown) => void> = []
    request.mockImplementation(() => new Promise((done) => resolvers.push(done)))
    const Harness = defineComponent({
      setup() {
        const nav = useAdminNavigation()
        void nav.refresh()
        void nav.refresh()
        return () => h('div')
      }
    })
    const wrapper = await mountSuspended(Harness)
    wrappers.push(wrapper)
    const calls = request.mock.calls.length
    for (const resolve of resolvers) resolve(caps())
    await flushPromises()
    expect(calls).toBe(1)
  })
  it('distinguishes an expired session from a permissions outage and offers login', async () => {
    request.mockRejectedValue({ statusCode: 401 })
    const wrapper = await mount()
    expect(wrapper.findAll('nav a')).toHaveLength(0)
    expect(wrapper.text()).toContain('La sesión ha caducado')
    expect(wrapper.find('a[href^="/login"]').exists()).toBe(true)
    expect(wrapper.text()).not.toContain('Contenido privado')
  })
  it('shows only the support routes for live support grants, ignoring the cached customer role', async () => {
    const wrapper = await mount()
    expect(wrapper.find('nav a[href="/admin/soporte"]').exists()).toBe(true)
    expect(wrapper.find('nav a[href="/admin/pedidos"]').exists()).toBe(false)
    expect(wrapper.find('nav a[href="/admin/productos"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('Contenido privado')
  })
  it('never shows cached admin links after failure and supports explicit refresh', async () => {
    actor.user.value.role = 'admin'
    request.mockRejectedValueOnce(new Error('unavailable'))
    const wrapper = await mount()
    expect(wrapper.findAll('nav a')).toHaveLength(0)
    expect(wrapper.text()).toContain('No se han podido comprobar los permisos')
    expect(wrapper.text()).not.toContain('Contenido privado')
    await wrapper.get('[data-admin-permissions-refresh]').trigger('click')
    await flushPromises()
    expect(wrapper.find('nav a[href="/admin/soporte"]').exists()).toBe(true)
  })
  it.each(['mfa_required', 'email_unverified', 'forbidden'])(
    'shows %s separately without business content',
    async (state) => {
      request.mockResolvedValue(caps([], state))
      const wrapper = await mount()
      expect(wrapper.findAll('nav a')).toHaveLength(0)
      expect(wrapper.text()).not.toContain('Contenido privado')
      expect(wrapper.text()).not.toContain('No se han podido comprobar los permisos')
      if (state === 'mfa_required') expect(wrapper.find('a[href="/cuenta/seguridad"]').exists()).toBe(true)
    }
  )
  it('clears links on session changes and ignores an old in-flight response', async () => {
    const wrapper = await mount()
    let resolve!: (value: unknown) => void
    request.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done
        })
    )
    await wrapper.get('[data-admin-permissions-refresh]').trigger('click')
    expect(wrapper.findAll('nav a')).toHaveLength(0)
    actor.session.value.sessionVersion = 2
    await flushPromises()
    resolve(caps())
    await flushPromises()
    expect(wrapper.findAll('nav a')).toHaveLength(0)
  })
  it('revalidates when changing routes and does not retain revoked grants', async () => {
    const wrapper = await mount()
    request.mockResolvedValue(caps([], 'forbidden'))
    route.path = '/admin/productos'
    route.fullPath = route.path
    await flushPromises()
    expect(wrapper.findAll('nav a')).toHaveLength(0)
    expect(wrapper.text()).not.toContain('Contenido privado')
  })
  it('preserves keyboard skip navigation and the mobile toggle', async () => {
    const wrapper = await mount()
    expect(wrapper.find('a[href="#panel-principal"]').exists()).toBe(true)
    const button = wrapper.get('[aria-controls="admin-nav"]')
    expect(button.attributes('aria-expanded')).toBe('false')
    await button.trigger('click')
    expect(button.attributes('aria-expanded')).toBe('true')
  })
  it('offers a staff entry in the store header using live grants, never a cached admin role', async () => {
    const wrapper = await mount(true)
    await wrapper.get('[aria-label="Mi cuenta"]').trigger('click')
    expect(wrapper.find('a[href="/admin"]').exists()).toBe(true)
    request.mockResolvedValue(caps([], 'forbidden'))
    actor.user.value.role = 'admin'
    route.fullPath = '/catalogo'
    route.path = '/catalogo'
    await flushPromises()
    await wrapper.get('[aria-label="Mi cuenta"]').trigger('click')
    expect(wrapper.find('a[href="/admin"]').exists()).toBe(false)
  })
})

import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { ref } from 'vue'
import { afterEach, expect, it, vi } from 'vitest'
import AdminOrderWorkbench from '../../app/components/AdminOrderWorkbench.vue'
import CustomerOrdersPage from '../../app/pages/cuenta/pedidos.vue'
import { createUiStateHarness, UI_STATES, UI_STATE_SURFACES, uiStateOrderDetail } from '../fixtures/ui-state-harness'
import { captureUiStateMarkup } from '../fixtures/ui-state-visual-artifacts'
import '#app/nuxt-vitest-app-entry'

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  fetch: vi.fn(),
  lazy: vi.fn(),
  owner: null as unknown,
  navigation: null as unknown,
  runtime: vi.fn(() => ({
    app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
    public: { serverRuntime: 'cloudflare' }
  }))
}))
mockNuxtImport('useRequestFetch', () => () => mocks.request)
mockNuxtImport('$fetch', () => mocks.request)
mockNuxtImport('useFetch', () => mocks.fetch)
mockNuxtImport('useLazyFetch', () => mocks.lazy)
mockNuxtImport('useUserSession', () => () => mocks.owner)
mockNuxtImport('useAdminNavigation', () => () => mocks.navigation)
mockNuxtImport('useRuntimeConfig', () => mocks.runtime)
mockNuxtImport('onBeforeRouteLeave', () => () => {})
mockNuxtImport('onBeforeRouteUpdate', () => () => {})

const mounted: Array<{ unmount(): void }> = [],
  scenarios: Array<ReturnType<typeof createUiStateHarness>> = []
afterEach(() => {
  for (const item of mounted.splice(0)) item.unmount()
  for (const scenario of scenarios.splice(0)) scenario.dispose()
})

for (const surface of UI_STATE_SURFACES)
  for (const state of UI_STATES)
    it(`mounts the real ${surface} in deterministic ${state} state`, async () => {
      const scenario = createUiStateHarness(surface, state)
      scenarios.push(scenario)
      const authority = scenario.authority
      const owner = {
        ready: ref(authority.ready),
        loggedIn: ref(authority.loggedIn),
        user: ref(authority.user),
        session: ref(authority.session)
      }
      mocks.owner = owner
      mocks.navigation = { status: ref('ready'), capabilities: ref(authority.capabilities) }
      mocks.request.mockReset().mockImplementation(scenario.request)
      const data = ref<unknown>(scenario.data),
        status = ref(scenario.initialStatus)
      const refresh = vi.fn(async () => {
        data.value = await scenario.request(scenario.endpoint)
        status.value = 'success'
      })
      mocks.fetch.mockReset().mockImplementation((path: string) => {
        expect(path).toBe('/api/orders')
        return { data, status, error: ref(null), refresh }
      })
      mocks.lazy.mockReset().mockImplementation((path: string) => {
        const match = /^\/api\/orders\/([0-9a-f-]+)\/lines$/.exec(path)
        if (!match) throw Error('Unapproved child fixture read')
        return { data: ref(uiStateOrderDetail(match[1]!)), status: ref('success'), error: ref(null), refresh: vi.fn() }
      })
      const component = scenario.component === 'AdminOrderWorkbench' ? AdminOrderWorkbench : CustomerOrdersPage
      const wrapper = await mountSuspended(component, {
        global: {
          stubs: {
            // Other command/overlay workflows have their own suites; keep the real
            // order row, table, empty/loading/error widgets and styling under test.
            OrderTimelinePanel: true,
            OrderCancellationPanel: true,
            OrderTrackingPanel: true,
            ReorderDialog: true
          }
        }
      })
      mounted.push(wrapper)
      await flushPromises()
      expect(wrapper.find('h1').text()).toContain(
        surface === 'admin-orders' ? 'Pedidos · banco de preparación' : 'Mis pedidos'
      )
      if (surface === 'admin-orders') {
        if (state === 'permission-denied') {
          expect(wrapper.text()).toContain('Confirma la sesión')
          expect(scenario.reads()).toHaveLength(0)
        } else if (state === 'loading') expect(wrapper.find('[data-wb-loading]').exists()).toBe(true)
        else if (state === 'empty') expect(wrapper.find('[data-wb-empty]').exists()).toBe(true)
        else if (state === 'error') expect(wrapper.text()).toContain('No se ha podido confirmar la cola')
        else {
          expect(wrapper.findAll('[data-wb-open]')).toHaveLength(25)
          if (state === 'stale') {
            await wrapper.get('[data-wb-form]').trigger('submit')
            await flushPromises()
            expect(wrapper.text()).toContain('No se ha podido confirmar la cola')
            expect(wrapper.findAll('[data-wb-open]')).toHaveLength(0)
          }
        }
      } else {
        if (state === 'loading') expect(wrapper.text()).toContain('Cargando tus pedidos.')
        else if (state === 'empty') expect(wrapper.text()).toContain('Todavía no tienes pedidos')
        else if (['error', 'stale', 'permission-denied'].includes(state)) {
          expect(wrapper.text()).toContain('No hemos podido cargar tus pedidos')
          expect(wrapper.text()).not.toContain('SYNTHETIC-UI013')
        } else {
          expect(wrapper.text()).toContain('SYNTHETIC-UI013')
          expect(wrapper.findAll('article')).toHaveLength(25)
        }
      }
      await captureUiStateMarkup(scenario.id, scenario.component, wrapper.html())
    })

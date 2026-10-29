import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { computed, defineComponent, h, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import InventoryPage from '../../app/pages/admin/inventario.vue'
import '#app/nuxt-vitest-app-entry'

const mocks = vi.hoisted(() => ({ request: vi.fn(), session: vi.fn(), navigation: vi.fn() }))
mockNuxtImport('$fetch', () => mocks.request)
mockNuxtImport('useUserSession', () => mocks.session)
mockNuxtImport('useRuntimeConfig', () => () => ({
  app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
  public: { serverRuntime: 'cloudflare' }
}))
vi.mock('../../app/composables/useAdminNavigation', () => ({ useAdminNavigation: mocks.navigation }))
const ID = '91000000-0000-4000-8000-000000000001'
const state = () => ({
  ready: ref(true),
  loggedIn: ref(true),
  user: ref({ id: ID, role: 'warehouse', emailVerified: true, mfaVerified: true }),
  session: ref({ sessionId: '91000000-0000-4000-8000-000000000002', sessionVersion: 1 })
})
let session: ReturnType<typeof state>
const permission = ref(true)
let wrapper: Awaited<ReturnType<typeof mountSuspended>> | undefined
const Button = defineComponent({
  props: { disabled: Boolean, loading: Boolean },
  setup:
    (props, { attrs, slots }) =>
    () =>
      h('button', { ...attrs, disabled: props.disabled || props.loading }, slots.default?.())
})
const result = () => ({
  source: 'cloudflare',
  capabilities: { inventoryRead: true, inventorySearch: true },
  items: [
    {
      id: 11,
      uuid: '92000000-0000-4000-8000-000000000001',
      sku: 'PRIVATE-SKU',
      name: 'Private operator product',
      unitBase: 'ud',
      unitLabel: 'unidad'
    }
  ],
  pagination: { page: 1, perPage: 25, total: 1, pages: 1 },
  evaluatedAt: '2026-10-08T10:00:00Z'
})
beforeEach(() => {
  session = state()
  permission.value = true
  mocks.session.mockReturnValue(session)
  mocks.request.mockReset()
  mocks.navigation.mockReturnValue({
    status: ref('ready'),
    capabilities: computed(() => ({
      source: 'cloudflare',
      identityId: session.user.value.id,
      sessionId: session.session.value.sessionId,
      sessionVersion: session.session.value.sessionVersion,
      state: 'ready',
      permissions: permission.value ? ['inventory.read'] : []
    }))
  })
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
})
async function render() {
  wrapper = await mountSuspended(InventoryPage, { global: { stubs: { UButton: Button, InventoryAlertsPanel: true } } })
  return wrapper
}
async function search() {
  await wrapper!.get('[data-testid="inventory-search"]').setValue('PRIVATE')
  await wrapper!.get('[data-testid="search-inventory"]').trigger('submit')
  await flushPromises()
}
describe('inventory current authority and scoped private reads', () => {
  it.each(['email', 'permission'] as const)('does not query when current %s authority is absent', async (boundary) => {
    if (boundary === 'email') session.user.value.emailVerified = false
    else permission.value = false
    await render()
    await search()
    expect(mocks.request).not.toHaveBeenCalled()
  })
  it.each(['session', 'email', 'permission'] as const)(
    'purges private results and drafts on %s change',
    async (boundary) => {
      mocks.request.mockResolvedValue(result())
      await render()
      await search()
      expect(wrapper!.text()).toContain('Private operator product')
      if (boundary === 'session') session.session.value.sessionVersion++
      else if (boundary === 'email') session.user.value.emailVerified = false
      else permission.value = false
      await flushPromises()
      expect(wrapper!.text()).not.toContain('Private operator product')
      expect((wrapper!.get('[data-testid="inventory-search"]').element as HTMLInputElement).value).toBe('')
    }
  )
  it('rejects a search response for a different pagination snapshot', async () => {
    mocks.request.mockResolvedValue({ ...result(), pagination: { page: 2, perPage: 25, total: 26, pages: 2 } })
    await render()
    await search()
    expect(wrapper!.text()).not.toContain('Private operator product')
    expect(wrapper!.text()).toContain('No se ha podido confirmar la búsqueda privada')
  })
  it('ignores an old response after same-identity session rotation', async () => {
    let resolve!: (value: ReturnType<typeof result>) => void
    mocks.request.mockReturnValue(
      new Promise((done) => {
        resolve = done
      })
    )
    await render()
    await search()
    session.session.value.sessionVersion++
    await flushPromises()
    resolve(result())
    await flushPromises()
    expect(wrapper!.text()).not.toContain('Private operator product')
  })
})

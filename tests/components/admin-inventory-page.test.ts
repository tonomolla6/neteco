import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { computed, defineComponent, h, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import InventoryPage from '../../app/pages/admin/inventario.vue'
import InventoryOperations from '../../app/components/InventoryOperations.vue'
import '#app/nuxt-vitest-app-entry'
const { request, sessionMock, runtimeMock, navigationMock } = vi.hoisted(() => ({
  navigationMock: vi.fn(),
  request: vi.fn(),
  sessionMock: vi.fn(),
  runtimeMock: vi.fn(() => ({
    app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
    public: { serverRuntime: 'cloudflare' }
  }))
}))
mockNuxtImport('$fetch', () => request)
mockNuxtImport('useUserSession', () => sessionMock)
mockNuxtImport('useRuntimeConfig', () => runtimeMock)
vi.mock('../../app/composables/useAdminNavigation', () => ({ useAdminNavigation: navigationMock }))
const ACTOR = '10000000-0000-4000-8000-000000000041',
  OTHER = '10000000-0000-4000-8000-000000000042',
  VARIANT = '40000000-0000-4000-8000-000000000041',
  PRODUCT = '30000000-0000-4000-8000-000000000041'
const session = () => ({
  ready: ref(true),
  loggedIn: ref(true),
  user: ref<{ id: string; role: string; mfaVerified: boolean; emailVerified: boolean } | null>({
    id: ACTOR,
    role: 'warehouse',
    mfaVerified: true,
    emailVerified: true
  }),
  session: ref({ sessionId: '10000000-0000-4000-8000-000000000043', sessionVersion: 1 }),
  clear: async () => undefined,
  fetch: async () => undefined,
  openInPopup: () => undefined
})
let currentSession: ReturnType<typeof session>
const context = (version = 1) => ({
  source: 'cloudflare',
  capabilities: {
    inventoryRead: true,
    inventoryReceipt: true,
    inventoryCountPropose: true,
    inventoryCountApprove: true
  },
  variant: {
    id: 11,
    uuid: VARIANT,
    productId: 1,
    productUuid: PRODUCT,
    sku: 'WAREHOUSE-041',
    format: 'Caja',
    status: 'draft',
    unitBase: 'ud',
    unitLabel: 'unidad'
  },
  warehouse: { id: 'main', code: 'MAIN', name: 'Synthetic warehouse' },
  balance: {
    physicalQuantity: version === 1 ? 20 : 25,
    blockedQuantity: 1,
    safetyStock: 2,
    reservedQuantity: 0,
    sellableQuantity: version === 1 ? 17 : 22,
    version
  },
  reconciliation: {
    consistent: true,
    physicalLedgerQuantity: version === 1 ? 20 : 25,
    reservedLedgerQuantity: 0,
    movementCount: version,
    reservationExpiryPending: 0
  },
  ledger: { items: [], pagination: { page: 1, perPage: 25, total: version, pages: 1 } },
  counts: { items: [], hasMore: false },
  evaluatedAt: '2026-10-01T00:00:00Z'
})
const search = () => ({
  source: 'cloudflare',
  capabilities: { inventoryRead: true, inventorySearch: true },
  items: [
    {
      id: 11,
      uuid: VARIANT,
      sku: 'WAREHOUSE-041',
      name: 'Synthetic operator product',
      unitBase: 'ud',
      unitLabel: 'unidad'
    }
  ],
  pagination: { page: 1, perPage: 25, total: 1, pages: 1 },
  evaluatedAt: '2026-10-01T00:00:00Z'
})
const receipt = () => ({
  source: 'cloudflare',
  action: 'receipt',
  commandId: '60000000-0000-4000-8000-000000000041',
  variantId: 11,
  variantUuid: VARIANT,
  warehouseId: 'main',
  balanceVersion: 2,
  physicalQuantity: 25,
  physicalDelta: 5,
  proposedPhysicalDelta: null,
  proposalId: null,
  updated: true
})
const Button = defineComponent({
  inheritAttrs: false,
  props: { loading: Boolean, disabled: Boolean },
  setup:
    (props, { attrs, slots }) =>
    () =>
      h(
        'button',
        { ...attrs, type: attrs.type ?? 'button', disabled: props.loading || props.disabled },
        slots.default?.()
      )
})
const mounted: Array<{ unmount: () => void }> = []
beforeEach(() => {
  currentSession = session()
  sessionMock.mockImplementation(() => currentSession)
  navigationMock.mockReturnValue({
    status: ref('ready'),
    capabilities: computed(() => ({
      source: 'cloudflare',
      identityId: currentSession.user.value?.id,
      sessionId: currentSession.session.value.sessionId,
      sessionVersion: currentSession.session.value.sessionVersion,
      state: currentSession.user.value?.mfaVerified ? 'ready' : 'mfa_required',
      permissions: currentSession.user.value?.mfaVerified ? ['inventory.read'] : []
    }))
  })
  request.mockReset()
  runtimeMock.mockReset()
  runtimeMock.mockReturnValue({
    app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
    public: { serverRuntime: 'cloudflare' }
  })
})
afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount()
})
async function render() {
  const wrapper = await mountSuspended(InventoryPage, {
    global: {
      stubs: {
        UButton: Button,
        InventoryOperations: false,
        InventoryAlertsPanel: true,
        InventoryCountImportPanel: true
      },
      components: { InventoryOperations }
    }
  })
  mounted.push(wrapper)
  return wrapper
}
async function lookup(wrapper: Awaited<ReturnType<typeof render>>) {
  await wrapper.get('[data-testid="inventory-lookup"]').setValue('11')
  await wrapper.get('details form').trigger('submit')
  await flushPromises()
}
async function prepare(wrapper: Awaited<ReturnType<typeof render>>) {
  await wrapper.get('[data-testid="receipt-quantity"]').setValue('5')
  await wrapper.get('[data-testid="inventory-reference"]').setValue('DELIVERY-041')
  await wrapper.get('[data-testid="inventory-reason"]').setValue('Synthetic independently documented entry')
  await wrapper.get('[data-testid="prepare-receipt"]').trigger('submit')
  await flushPromises()
}
describe('inventory focused operational page, not catalog/admin role', () => {
  it('lets a warehouse operator find by SKU/name and select existing inventory', async () => {
    request.mockResolvedValueOnce(search()).mockResolvedValueOnce(context())
    const wrapper = await render()
    await wrapper.get('[data-testid="inventory-search"]').setValue('WAREHOUSE')
    await wrapper.get('[data-testid="search-inventory"]').trigger('submit')
    await flushPromises()
    expect(request.mock.calls[0]?.[0]).toBe('/api/admin/inventory/variants')
    expect(wrapper.text()).toContain('Synthetic operator product')
    await wrapper.get('[data-testid="choose-inventory-variant"]').trigger('click')
    await flushPromises()
    expect(request.mock.calls[1]?.[0]).toBe('/api/admin/inventory/variants/11')
    expect(wrapper.find('[data-testid="prepare-receipt"]').exists()).toBe(true)
    expect(wrapper.text()).not.toContain('Productos · Admin')
  })
  it('does not dispatch search/context callbacks after unmount', async () => {
    let resolve: ((value: ReturnType<typeof search>) => void) | undefined
    request.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done
        })
    )
    const wrapper = await render()
    await wrapper.get('[data-testid="inventory-search"]').setValue('WAREHOUSE')
    await wrapper.get('[data-testid="search-inventory"]').trigger('submit')
    wrapper.unmount()
    resolve!(search())
    await flushPromises()
    expect(request).toHaveBeenCalledTimes(1)
  })
  it('clears facts/pending selection on logout or different operator', async () => {
    request.mockResolvedValue(context())
    const wrapper = await render()
    await lookup(wrapper)
    expect(wrapper.text()).toContain('WAREHOUSE-041')
    currentSession.user.value = { id: OTHER, role: 'warehouse', mfaVerified: true, emailVerified: true }
    await flushPromises()
    expect(wrapper.find('[data-testid="prepare-receipt"]').exists()).toBe(false)
    currentSession.loggedIn.value = false
    await flushPromises()
    expect(wrapper.find('[data-testid="choose-inventory-variant"]').exists()).toBe(false)
  })
  it('preserves same-key intent across transient MFA loss during POST and restoration', async () => {
    let resolvePost: ((value: ReturnType<typeof receipt>) => void) | undefined
    let posted = false
    request.mockImplementation(async (_path: string, options?: { method?: string }) => {
      if (options?.method === 'POST') {
        posted = true
        return new Promise((done) => {
          resolvePost = done
        })
      }
      return context(posted ? 2 : 1)
    })
    const wrapper = await render()
    await lookup(wrapper)
    await prepare(wrapper)
    await wrapper.get('[data-testid="confirm-inventory"]').trigger('click')
    await flushPromises()
    const first = request.mock.calls.find((call) => call[1]?.method === 'POST')!
    expect(first).toBeDefined()
    currentSession.user.value!.mfaVerified = false
    await flushPromises()
    expect(wrapper.find('[data-testid="receipt-quantity"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="retry-inventory"]').exists()).toBe(false)
    resolvePost!(receipt())
    await flushPromises()
    currentSession.user.value!.mfaVerified = true
    await flushPromises()
    expect(wrapper.find('[data-testid="retry-inventory"]').exists()).toBe(true)
    request.mockImplementation(async (_path: string, options?: { method?: string }) =>
      options?.method === 'POST' ? receipt() : context(2)
    )
    await wrapper.get('[data-testid="retry-inventory"]').trigger('click')
    await flushPromises()
    const writes = request.mock.calls.filter((call) => call[1]?.method === 'POST')
    expect(writes).toHaveLength(2)
    expect(writes[1]).toEqual([first[0], { ...first[1], onResponseError: expect.any(Function) }])
    expect(wrapper.text()).toContain('Movimiento confirmado y auditado')
  })
  it('does not keep old balance operable after postcommit read outage', async () => {
    let posted = false
    request.mockImplementation(async (_path: string, options?: { method?: string }) => {
      if (options?.method === 'POST') {
        posted = true
        return receipt()
      }
      if (posted) throw new Error('private read outage')
      return context()
    })
    const wrapper = await render()
    await lookup(wrapper)
    await prepare(wrapper)
    await wrapper.get('[data-testid="confirm-inventory"]').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('Movimiento confirmado y auditado')
    expect(wrapper.find('[data-testid="receipt-quantity"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('El saldo actual no está confirmado')
  })
  it('does not dispatch while read permission/authority is unconfirmed', async () => {
    const wrapper = await render()
    currentSession.ready.value = false
    await wrapper.get('[data-testid="inventory-search"]').setValue('WAREHOUSE')
    await wrapper.get('[data-testid="search-inventory"]').trigger('submit')
    await flushPromises()
    expect(request).not.toHaveBeenCalled()
  })
})

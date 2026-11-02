import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { computed, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import InventoryPage from '../../app/pages/admin/inventario.vue'
import InventoryAlertsPanel from '../../app/components/InventoryAlertsPanel.vue'
import { inventoryAlertIntentHash } from '../../shared/inventory-alerts'
import '#app/nuxt-vitest-app-entry'

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  navigation: vi.fn(),
  session: vi.fn(),
  runtime: vi.fn(() => ({
    app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
    public: { serverRuntime: 'cloudflare' }
  })),
  route: vi.fn()
}))
mockNuxtImport('$fetch', () => mocks.request)
mockNuxtImport('useUserSession', () => mocks.session)
mockNuxtImport('useRuntimeConfig', () => mocks.runtime)
mockNuxtImport('useRoute', () => mocks.route)
vi.mock('../../app/composables/useAdminNavigation', () => ({ useAdminNavigation: mocks.navigation }))

const ACTOR = 'a1000000-0000-4000-8000-000000000011'
const ALERT = 'a3000000-0000-4000-8000-000000000011'
const TIME = '2026-10-09T09:00:00Z'
const item = () => ({
  id: ALERT,
  variantId: 11,
  sku: 'SKU-ALERT-11',
  kind: 'low',
  state: 'open',
  version: 1,
  threshold: 5,
  sellableQuantity: 3,
  currentKind: 'low',
  createdAt: TIME,
  updatedAt: TIME,
  to: '/admin/inventario?variantId=11'
})
function queue() {
  return {
    source: 'cloudflare',
    evaluatedAt: TIME,
    lastEvaluationAt: TIME,
    warehouse: { id: 'main', code: 'MAIN', name: 'Almacén único sintético' },
    capabilities: { inventoryRead: true, inventoryWrite: true },
    items: [item()],
    pagination: { page: 1, perPage: 25, total: 1, pages: 1 }
  }
}
function policy() {
  return {
    source: 'cloudflare',
    variantId: 11,
    version: 0,
    threshold: null as number | null,
    updatedAt: null as string | null,
    capabilities: { inventoryRead: true, inventoryWrite: true }
  }
}
const state = () => ({
  ready: ref(true),
  loggedIn: ref(true),
  user: ref({ id: ACTOR, role: 'warehouse', emailVerified: true, mfaVerified: true }),
  session: ref({ sessionId: 'a2000000-0000-4000-8000-000000000011', sessionVersion: 1 })
})
let session: ReturnType<typeof state>
const permission = ref(true)
const mounted: Array<{ unmount(): void }> = []
beforeEach(() => {
  session = state()
  permission.value = true
  mocks.session.mockReturnValue(session)
  mocks.request.mockReset()
  mocks.request.mockResolvedValue(queue())
  mocks.route.mockReturnValue({ query: {} })
  mocks.runtime.mockReturnValue({
    app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
    public: { serverRuntime: 'cloudflare' }
  })
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
  for (const wrapper of mounted.splice(0)) wrapper.unmount()
})

describe('inventory alerts integrated operator journey', () => {
  it('offers a real stock-alert queue on the authorized inventory page before selecting a variant', async () => {
    const wrapper = await mountSuspended(InventoryPage)
    mounted.push(wrapper)
    expect(wrapper.find('[aria-label="Alertas operativas de inventario"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="inventory-search"]').exists()).toBe(true)
    expect(mocks.request.mock.calls.every(([, options]) => !options?.method || options.method === 'GET')).toBe(true)
  })
  it('does not introduce native alert reads or controls on Node', async () => {
    mocks.runtime.mockReturnValue({
      app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
      public: { serverRuntime: 'node' }
    })
    const wrapper = await mountSuspended(InventoryPage)
    mounted.push(wrapper)
    expect(wrapper.find('[aria-label="Alertas operativas de inventario"]').exists()).toBe(false)
    expect(mocks.request).not.toHaveBeenCalled()
  })
  it('selects the existing receipt/count context through one GET and no automatic stock command', async () => {
    mocks.request.mockImplementation(async (path: string) => {
      if (path === '/api/admin/inventory/alerts') return queue()
      throw new Error('Existing variant read intentionally unavailable')
    })
    const wrapper = await mountSuspended(InventoryPage)
    mounted.push(wrapper)
    await flushPromises()
    await wrapper.get('a[href="/admin/inventario?variantId=11"]').trigger('click')
    await flushPromises()
    expect(mocks.request.mock.calls.filter(([path]) => path === '/api/admin/inventory/variants/11')).toHaveLength(1)
    expect(writes()).toHaveLength(0)
  })
  it('integrates command pending without purging its own recovery and purges it when authority is revoked', async () => {
    api()
    const wrapper = await mountSuspended(InventoryPage)
    mounted.push(wrapper)
    await flushPromises()
    await prepareAck(wrapper)
    expect(wrapper.get('[data-testid="search-inventory"]').attributes('disabled')).toBeDefined()
    expect(wrapper.find('[data-testid="alerts-confirm"]').exists()).toBe(true)
    expect(writes()).toHaveLength(0)
    permission.value = false
    await flushPromises()
    expect(wrapper.find('[data-testid="alerts-confirm"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('SKU-ALERT-11')
    expect(writes()).toHaveLength(0)
  })
  it('configures the threshold of a variant selected by SKU without typing an internal ID or rereading stock', async () => {
    const variant = {
      id: 11,
      uuid: 'a4000000-0000-4000-8000-000000000011',
      productId: 1,
      productUuid: 'a5000000-0000-4000-8000-000000000011',
      sku: 'SKU-ALERT-11',
      format: 'Caja',
      status: 'draft',
      unitBase: 'ud',
      unitLabel: 'unidad'
    }
    mocks.request.mockImplementation(async (path: string) => {
      if (path === '/api/admin/inventory/alerts') return { ...queue(), items: [] }
      if (path === '/api/admin/inventory/variants')
        return {
          source: 'cloudflare',
          capabilities: { inventoryRead: true, inventorySearch: true },
          items: [
            {
              id: variant.id,
              uuid: variant.uuid,
              sku: variant.sku,
              name: 'Producto sintético',
              unitBase: 'ud',
              unitLabel: 'unidad'
            }
          ],
          pagination: { page: 1, perPage: 25, total: 1, pages: 1 },
          evaluatedAt: TIME
        }
      if (path.endsWith('/alert-policy')) return policy()
      if (path === '/api/admin/inventory/variants/11')
        return {
          source: 'cloudflare',
          capabilities: {
            inventoryRead: true,
            inventoryReceipt: true,
            inventoryCountPropose: true,
            inventoryCountApprove: true
          },
          variant,
          warehouse: queue().warehouse,
          balance: {
            physicalQuantity: 3,
            blockedQuantity: 0,
            safetyStock: 0,
            reservedQuantity: 0,
            sellableQuantity: 3,
            version: 1
          },
          reconciliation: {
            consistent: true,
            physicalLedgerQuantity: 3,
            reservedLedgerQuantity: 0,
            movementCount: 1,
            reservationExpiryPending: 0
          },
          ledger: { items: [], pagination: { page: 1, perPage: 25, total: 0, pages: 1 } },
          counts: { items: [], hasMore: false },
          evaluatedAt: TIME
        }
      throw new Error('Unexpected inventory read')
    })
    const wrapper = await mountSuspended(InventoryPage)
    mounted.push(wrapper)
    await flushPromises()
    await wrapper.get('[data-testid="inventory-search"]').setValue('SKU-ALERT-11')
    await wrapper.get('[data-testid="search-inventory"]').trigger('submit')
    await flushPromises()
    await wrapper.get('[data-testid="choose-inventory-variant"]').trigger('click')
    await flushPromises()
    const configure = wrapper
      .findAll('button')
      .find((button) => button.text() === 'Configurar umbral de la variante seleccionada')
    expect(
      configure,
      'selected SKU must offer threshold configuration without an internal-ID prerequisite'
    ).toBeDefined()
    await configure!.trigger('click')
    await flushPromises()
    expect(
      mocks.request.mock.calls.filter(([path]) => path === '/api/admin/inventory/variants/11/alert-policy')
    ).toHaveLength(1)
    expect(mocks.request.mock.calls.filter(([path]) => path === '/api/admin/inventory/variants/11')).toHaveLength(1)
    expect(wrapper.get('[data-testid="alerts-threshold"]').exists()).toBe(true)
    expect(writes()).toHaveLength(0)
  })
  it.each(['11', '011', '0', ['11', '12']])(
    'consumes only a canonical authorized variant link %j',
    async (variantId) => {
      mocks.route.mockReturnValue({ query: { variantId } })
      mocks.request.mockImplementation(async (path: string) => {
        if (path === '/api/admin/inventory/alerts') return queue()
        throw new Error('Existing variant read intentionally unavailable')
      })
      const wrapper = await mountSuspended(InventoryPage)
      mounted.push(wrapper)
      await flushPromises()
      expect(
        mocks.request.mock.calls.filter(([path]) => path.startsWith('/api/admin/inventory/variants/'))
      ).toHaveLength(variantId === '11' ? 1 : 0)
      expect(writes()).toHaveLength(0)
    }
  )
  it.each(['permission', 'email', 'mfa'])(
    'never consumes a variant link without live %s authority',
    async (boundary) => {
      mocks.route.mockReturnValue({ query: { variantId: '11' } })
      if (boundary === 'permission') permission.value = false
      else if (boundary === 'email') session.user.value.emailVerified = false
      else session.user.value.mfaVerified = false
      const wrapper = await mountSuspended(InventoryPage)
      mounted.push(wrapper)
      await flushPromises()
      expect(mocks.request).not.toHaveBeenCalled()
    }
  )
})

function writes() {
  return mocks.request.mock.calls.filter(([, options]) => ['POST', 'PUT', 'DELETE'].includes(options?.method))
}
async function panel(props: Record<string, unknown> = {}) {
  const wrapper = await mountSuspended(InventoryAlertsPanel, {
    props: { scopeKey: 'operator-session-1', enabled: true, pending: false, ...props }
  })
  mounted.push(wrapper)
  await flushPromises()
  return wrapper
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { resolve, promise }
}
function api() {
  let currentQueue = queue(),
    currentPolicy = policy(),
    receipt: Record<string, unknown> | null = null
  type Options = {
    method?: string
    headers?: Record<string, string>
    body?: Record<string, unknown>
    query?: { state?: string; page?: number }
  }
  const handler = async (path: string, options: Options = {}) => {
    if (options.method === 'PUT' || options.method === 'POST') {
      const action = path.endsWith('/alert-policy') ? 'threshold' : path.endsWith('/ack') ? 'ack' : 'evaluate'
      const targetId = action === 'threshold' ? '11' : action === 'ack' ? ALERT : 'warehouse'
      receipt = {
        source: 'cloudflare',
        commandId: options.headers!['Idempotency-Key'],
        action,
        targetId,
        payloadHash: await inventoryAlertIntentHash(action, targetId, options.body),
        version: action === 'evaluate' ? null : Number(options.body!.expectedVersion) + 1,
        processed: action === 'evaluate' ? 1 : 0,
        opened: 0,
        updated: 0,
        resolved: 0,
        nextAfterVariantId: null
      }
      if (action === 'threshold')
        currentPolicy = {
          ...currentPolicy,
          threshold: options.body!.threshold as number | null,
          version: Number(options.body!.expectedVersion) + 1,
          updatedAt: TIME
        }
      if (action === 'ack')
        currentQueue = { ...currentQueue, items: [{ ...item(), state: 'acknowledged', version: 2 }] }
      return receipt
    }
    if (path.includes('/commands/'))
      return receipt
        ? { source: 'cloudflare', outcome: 'applied', receipt }
        : { source: 'cloudflare', outcome: 'unknown' }
    if (path.endsWith('/alert-policy')) return currentPolicy
    const state = options.query?.state
    const items =
      state === 'all' ? currentQueue.items : currentQueue.items.filter((entry) => entry.state === (state || 'open'))
    return {
      ...currentQueue,
      items,
      pagination: { ...currentQueue.pagination, page: options.query?.page ?? 1, total: items.length }
    }
  }
  mocks.request.mockImplementation(handler)
  return {
    handler,
    setQueue(value: ReturnType<typeof queue>) {
      currentQueue = value
    },
    setPolicy(value: ReturnType<typeof policy>) {
      currentPolicy = value
    }
  }
}
async function prepareAck(wrapper: Awaited<ReturnType<typeof panel>>) {
  await wrapper.get(`[data-alert-ack="${ALERT}"]`).trigger('click')
  await wrapper.get('[data-testid="alerts-ack-reason"]').setValue('Revisión operativa documentada')
  await wrapper.get('[data-testid="alerts-ack-form"]').trigger('submit')
  await flushPromises()
  await vi.waitFor(() => expect(wrapper.find('[data-testid="alerts-confirm"]').exists()).toBe(true))
}
describe('inventory alert reads and governed actions', () => {
  it('loads real GET facts, labels persisted state separately and never sends on mount/filter input', async () => {
    const wrapper = await panel()
    expect(mocks.request.mock.calls[0]).toMatchObject([
      '/api/admin/inventory/alerts',
      { retry: 0, cache: 'no-store', query: { state: 'open', q: '', page: 1, perPage: 25 } }
    ])
    expect(wrapper.text()).toContain('Stock bajo')
    expect(wrapper.text()).toContain('Abierta')
    expect(wrapper.text()).toContain('Hecho actual: Stock bajo')
    await wrapper.get('[data-testid="alerts-query"]').setValue('SKU-ALERT')
    expect(mocks.request).toHaveBeenCalledTimes(1)
    expect(writes()).toHaveLength(0)
  })
  it('applies server kind/state/SKU filters and exact pagination only on explicit requests', async () => {
    mocks.request.mockImplementation(async (_path, options) => ({
      ...queue(),
      pagination: { page: options.query.page, perPage: 25, total: 26, pages: 2 }
    }))
    const wrapper = await panel()
    await wrapper.get('[data-testid="alerts-query"]').setValue('SKU-ALERT')
    await wrapper.get('[data-testid="alerts-kind"]').setValue('low')
    await wrapper.get('[data-testid="alerts-state"]').setValue('all')
    await wrapper.get('[data-testid="alerts-filters"]').trigger('submit')
    await flushPromises()
    expect(mocks.request.mock.calls.at(-1)?.[1].query).toEqual({
      state: 'all',
      kind: 'low',
      q: 'SKU-ALERT',
      page: 1,
      perPage: 25
    })
    await wrapper.get('[data-testid="alerts-next"]').trigger('click')
    await flushPromises()
    expect(mocks.request.mock.calls.at(-1)?.[1].query.page).toBe(2)
  })
  it('keeps not-evaluated distinct from confirmed empty and read failure', async () => {
    mocks.request.mockResolvedValue({
      ...queue(),
      items: [],
      lastEvaluationAt: null,
      pagination: { page: 1, perPage: 25, total: 0, pages: 0 }
    })
    const wrapper = await panel()
    expect(wrapper.text()).toContain('Aún no evaluado')
    expect(wrapper.text()).toContain('No hay episodios en esta consulta confirmada')
    mocks.request.mockRejectedValueOnce(new Error('private server detail'))
    await wrapper.get('[data-testid="alerts-refresh"]').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('Un error no significa que no haya alertas')
    expect(wrapper.text()).not.toContain('No hay episodios en esta consulta confirmada')
    expect(wrapper.text()).not.toContain('private server detail')
  })
  it.each(['source', 'page', 'destination'])(
    'rejects a malformed or uncorrelated %s DTO rather than showing private facts',
    async (fault) => {
      const data = queue()
      if (fault === 'source') data.source = 'node'
      if (fault === 'page') data.pagination.page = 2
      if (fault === 'destination') data.items[0]!.to = '/admin/inventario?variantId=12'
      mocks.request.mockResolvedValue(data)
      const wrapper = await panel()
      expect(wrapper.text()).not.toContain('SKU-ALERT-11')
      expect(wrapper.find('[role="alert"]').exists()).toBe(true)
    }
  )
  it('does not invent write rights for an inventory reader', async () => {
    mocks.request.mockResolvedValue({ ...queue(), capabilities: { inventoryRead: true, inventoryWrite: false } })
    const wrapper = await panel()
    expect(wrapper.find('[data-testid="alerts-evaluate"]').exists()).toBe(false)
    expect(wrapper.find('[data-alert-ack]').exists()).toBe(false)
  })
  it('prepares threshold separately from safety stock, and confirms only after matching receipt and current policy', async () => {
    api()
    const wrapper = await panel()
    await wrapper.get('[data-alert-policy="11"]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-testid="alerts-threshold"]').setValue('7')
    await wrapper.get('[data-testid="alerts-threshold-reason"]').setValue('Umbral operacional documentado')
    await wrapper.get('[data-testid="alerts-threshold-form"]').trigger('submit')
    await flushPromises()
    await vi.waitFor(() => expect(wrapper.find('[data-testid="alerts-confirm"]').exists()).toBe(true))
    expect(writes()).toHaveLength(0)
    expect(wrapper.text()).toContain('Nuevo umbral: 7')
    await wrapper.get('[data-testid="alerts-confirm"]').trigger('click')
    await flushPromises()
    // Hashing/receipt verification is genuinely asynchronous; wait for the outcome.
    await vi.waitFor(() => expect(wrapper.emitted('confirmed')).toHaveLength(1))
    expect(writes()).toHaveLength(1)
    expect(writes()[0]).toMatchObject([
      '/api/admin/inventory/variants/11/alert-policy',
      { method: 'PUT', retry: 0, body: { expectedVersion: 0, threshold: 7, reason: 'Umbral operacional documentado' } }
    ])
    expect(writes()[0]![1].body).not.toHaveProperty('safetyStock')
    expect(wrapper.emitted('confirmed')).toHaveLength(1)
    expect(wrapper.text()).toContain('No modifica el stock de seguridad')
  })
  it('ACK is explicit and audited, never an automatic stock repair', async () => {
    api()
    const wrapper = await panel()
    await prepareAck(wrapper)
    expect(writes()).toHaveLength(0)
    await wrapper.get('[data-testid="alerts-confirm"]').trigger('click')
    await flushPromises()
    await vi.waitFor(() => expect(wrapper.emitted('confirmed')).toHaveLength(1))
    expect(writes()).toHaveLength(1)
    expect(writes()[0]![1].body).toEqual({ expectedVersion: 1, reason: 'Revisión operativa documentada' })
    expect(mocks.request.mock.calls).toContainEqual([
      '/api/admin/inventory/alerts',
      expect.objectContaining({ query: expect.objectContaining({ state: 'all', alertId: ALERT, q: '' }) })
    ])
    expect(wrapper.emitted('confirmed')).toHaveLength(1)
    expect(wrapper.text()).toContain('No repara ni resuelve el stock')
  })
  it('retains frozen uncertainty after a lost response and recovers through GET without another POST', async () => {
    const service = api()
    let lose = true
    mocks.request.mockImplementation(async (path, options) => {
      const result = await service.handler(path, options)
      if (options?.method === 'POST' && lose) {
        lose = false
        throw new Error('lost after commit')
      }
      return result
    })
    const wrapper = await panel()
    await prepareAck(wrapper)
    await wrapper.get('[data-testid="alerts-confirm"]').trigger('click')
    await flushPromises()
    // The recover button stays disabled while the lost POST is still settling.
    await vi.waitFor(() =>
      expect(wrapper.find('[data-testid="alerts-recover"]').attributes('disabled')).toBeUndefined()
    )
    expect(wrapper.emitted('confirmed')).toBeUndefined()
    expect(wrapper.emitted('pending')?.at(-1)).toEqual([true])
    await wrapper.get('[data-testid="alerts-recover"]').trigger('click')
    await vi.waitFor(() => expect(wrapper.emitted('confirmed')).toHaveLength(1))
    expect(writes()).toHaveLength(1)
    const lookup = mocks.request.mock.calls.find(([path]) => path.includes('/commands/'))!
    expect(lookup[0]).not.toContain('Revisión')
    expect(lookup[1].headers['X-Neteco-Command-Payload-Hash']).toMatch(/^[0-9a-f]{64}$/)
    expect(wrapper.emitted('confirmed')).toHaveLength(1)
    expect(wrapper.emitted('pending')?.at(-1)).toEqual([false])
  })
  it('unknown receipt is not absence; manual replay preserves the exact key, body and target', async () => {
    const service = api()
    let fail = true
    mocks.request.mockImplementation(async (path, options) => {
      if (options?.method === 'POST' && fail) {
        fail = false
        throw new Error('lost before response')
      }
      return service.handler(path, options)
    })
    const wrapper = await panel()
    await prepareAck(wrapper)
    await wrapper.get('[data-testid="alerts-confirm"]').trigger('click')
    await flushPromises()
    const original = writes()[0]!
    await wrapper.get('[data-testid="alerts-recover"]').trigger('click')
    await flushPromises()
    expect(wrapper.emitted('pending')?.at(-1)).toEqual([true])
    expect(wrapper.text()).toContain('desconocido no significa que no se aplicara')
    await wrapper.get('[data-testid="alerts-replay"]').trigger('click')
    await flushPromises()
    expect(writes()[1]).toMatchObject([
      original[0],
      { method: original[1].method, headers: original[1].headers, body: original[1].body }
    ])
  })
  it.each([401, 403, 409, 429, 500, 503])(
    'keeps an uncertain intention after HTTP %s without automatic POST retry',
    async (status) => {
      const service = api()
      mocks.request.mockImplementation(async (path, options) => {
        if (options?.method === 'POST') throw Object.assign(new Error('PRIVATE'), { status })
        return service.handler(path, options)
      })
      const wrapper = await panel()
      await prepareAck(wrapper)
      await wrapper.get('[data-testid="alerts-confirm"]').trigger('click')
      await flushPromises()
      expect(writes()).toHaveLength(1)
      expect(wrapper.find('[data-testid="alerts-recover"]').exists()).toBe(true)
      expect(wrapper.text()).not.toContain('PRIVATE')
    }
  )
  it('singleflights confirm, does not send the next evaluation batch automatically', async () => {
    const service = api(),
      hold = deferred<unknown>()
    mocks.request.mockImplementation(async (path, options) => {
      if (options?.method === 'POST') {
        const receipt = (await service.handler(path, options)) as Record<string, unknown>
        return hold.promise.then(() => ({ ...receipt, nextAfterVariantId: 11 }))
      }
      return service.handler(path, options)
    })
    const wrapper = await panel()
    await wrapper.get('[data-testid="alerts-evaluate"]').trigger('click')
    await flushPromises()
    await vi.waitFor(() => expect(wrapper.find('[data-testid="alerts-confirm"]').exists()).toBe(true))
    const confirm = wrapper.get('[data-testid="alerts-confirm"]')
    await confirm.trigger('click')
    await confirm.trigger('click')
    await vi.waitFor(() => expect(writes()).toHaveLength(1))
    hold.resolve(undefined)
    await vi.waitFor(() => expect(wrapper.find('[data-testid="alerts-evaluate-next"]').exists()).toBe(true))
    expect(writes()).toHaveLength(1)
    await wrapper.get('[data-testid="alerts-evaluate-next"]').trigger('click')
    await vi.waitFor(() => expect(wrapper.text()).toContain('después de la variante 11'))
    expect(writes()).toHaveLength(1)
  })
  it('does not clear a historical receipt if the current read fails', async () => {
    const service = api()
    let sent = false
    mocks.request.mockImplementation(async (path, options) => {
      if (sent && !options?.method && !path.includes('/commands/')) throw new Error('read failed')
      const result = await service.handler(path, options)
      if (options?.method === 'POST') sent = true
      return result
    })
    const wrapper = await panel()
    await prepareAck(wrapper)
    await wrapper.get('[data-testid="alerts-confirm"]').trigger('click')
    await flushPromises()
    expect(wrapper.emitted('confirmed')).toBeUndefined()
    expect(wrapper.emitted('pending')?.at(-1)).toEqual([true])
  })
  it.each(['key', 'hash', 'target', 'version'])('retains uncertainty for an uncorrelated receipt %s', async (fault) => {
    const service = api()
    mocks.request.mockImplementation(async (path, options) => {
      const value = await service.handler(path, options)
      if (options?.method !== 'POST') return value
      const receipt = { ...(value as Record<string, unknown>) }
      if (fault === 'key') receipt.commandId = 'a9000000-0000-4000-8000-000000000011'
      if (fault === 'hash') receipt.payloadHash = '0'.repeat(64)
      if (fault === 'target') receipt.targetId = 'a9000000-0000-4000-8000-000000000011'
      if (fault === 'version') receipt.version = 3
      return receipt
    })
    const wrapper = await panel()
    await prepareAck(wrapper)
    await wrapper.get('[data-testid="alerts-confirm"]').trigger('click')
    await flushPromises()
    expect(wrapper.emitted('confirmed')).toBeUndefined()
    expect(wrapper.emitted('pending')?.at(-1)).toEqual([true])
  })
  it('scope revocation purges an in-flight command and never announces a late successful receipt', async () => {
    const service = api(),
      hold = deferred<unknown>()
    let committed: unknown
    mocks.request.mockImplementation(async (path, options) => {
      const value = await service.handler(path, options)
      if (options?.method === 'POST') {
        committed = value
        return hold.promise
      }
      return value
    })
    const wrapper = await panel()
    await prepareAck(wrapper)
    await wrapper.get('[data-testid="alerts-confirm"]').trigger('click')
    await vi.waitFor(() => expect(writes()).toHaveLength(1))
    await wrapper.setProps({ scopeKey: 'another-session', enabled: false })
    hold.resolve(committed)
    await flushPromises()
    expect(wrapper.emitted('confirmed')).toBeUndefined()
    expect(wrapper.emitted('pending')?.at(-1)).toEqual([false])
    expect(wrapper.text()).not.toContain('SKU-ALERT-11')
    expect(writes()).toHaveLength(1)
  })
  it.each(['scope', 'authority', 'unmount'])(
    'purges private pending context and rejects late results on %s',
    async (boundary) => {
      const hold = deferred<unknown>()
      mocks.request.mockReturnValue(hold.promise)
      const wrapper = await panel()
      if (boundary === 'scope') await wrapper.setProps({ scopeKey: 'operator-session-2', enabled: false })
      if (boundary === 'authority') await wrapper.setProps({ enabled: false })
      if (boundary === 'unmount') wrapper.unmount()
      hold.resolve(queue())
      await flushPromises()
      expect(wrapper.text()).not.toContain('SKU-ALERT-11')
      expect(writes()).toHaveLength(0)
    }
  )
  it('external pending blocks another operation without dropping the original frozen command', async () => {
    api()
    const wrapper = await panel()
    await prepareAck(wrapper)
    await wrapper.setProps({ pending: true })
    expect(wrapper.get('[data-testid="alerts-confirm"]').attributes('disabled')).toBeDefined()
    await wrapper.setProps({ pending: false })
    expect(wrapper.find('[data-testid="alerts-confirm"]').exists()).toBe(true)
    expect(writes()).toHaveLength(0)
  })
})

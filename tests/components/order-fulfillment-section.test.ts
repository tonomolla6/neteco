import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import OrderFulfillmentSection from '../../app/components/OrderFulfillmentSection.vue'
import OrderFulfillmentPanel from '../../app/components/OrderFulfillmentPanel.vue'
import type { AdminOrderFulfillment } from '../../shared/order-fulfillment'
import '#app/nuxt-vitest-app-entry'

const { read, post, sessionMock } = vi.hoisted(() => ({ read: vi.fn(), post: vi.fn(), sessionMock: vi.fn() }))
mockNuxtImport('useRequestFetch', () => () => read)
mockNuxtImport('$fetch', () => post)
mockNuxtImport('useUserSession', () => sessionMock)
const ACTOR = '10000000-0000-4000-8000-000000000043',
  OTHER = '10000000-0000-4000-8000-000000000044',
  ORDER = '30000000-0000-4000-8000-000000000043',
  NEXT = '30000000-0000-4000-8000-000000000044'
const session = () => ({
  ready: ref(true),
  loggedIn: ref(true),
  user: ref<{ id: string; emailVerified: boolean; mfaVerified: boolean } | null>({
    id: ACTOR,
    emailVerified: true,
    mfaVerified: true
  }),
  session: ref(null),
  clear: async () => undefined,
  fetch: async () => undefined,
  openInPopup: () => undefined
})
const context = (orderId = ORDER, version = 0): AdminOrderFulfillment => ({
  source: 'cloudflare',
  orderId,
  warehouse: { id: 'main', code: 'MAIN', name: 'Synthetic only warehouse' },
  shippingMethod: 'pickup',
  state: version === 0 ? 'pending' : 'picking',
  interruptedState: null,
  version,
  readiness: { ready: true, blockers: [] },
  capabilities: {
    fulfillmentRead: true,
    fulfillmentTransitions: true,
    allowedActions: version === 0 ? ['picking', 'exception'] : ['packed', 'exception']
  },
  inventoryPolicy: 'allocated_on_payment_no_fulfillment_decrement',
  timeline: { items: [], pagination: { page: 1, perPage: 25, total: version, pages: Math.ceil(version / 25) } },
  evaluatedAt: '2026-10-03T00:00:00Z'
})
const receipt = () => ({
  source: 'cloudflare',
  action: 'picking',
  commandId: '40000000-0000-4000-8000-000000000043',
  orderId: ORDER,
  warehouseId: 'main',
  state: 'picking',
  interruptedState: null,
  version: 1,
  inventoryEffect: 'none',
  updated: true
})
let currentSession: ReturnType<typeof session>
const mounted: Array<{ unmount: () => void }> = []
beforeEach(() => {
  currentSession = session()
  sessionMock.mockImplementation(() => currentSession)
  read.mockReset()
  post.mockReset()
  read.mockResolvedValue(context())
})
afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount()
})
async function render(props: Record<string, unknown> = {}) {
  const wrapper = await mountSuspended(OrderFulfillmentSection, {
    props: { orderId: ORDER, runtime: 'cloudflare', ...props },
    global: { components: { OrderFulfillmentPanel }, stubs: { OrderFulfillmentPanel: false, OrderPackingPanel: true } }
  })
  mounted.push(wrapper)
  await flushPromises()
  post.mockClear()
  return wrapper
}
async function prepare(wrapper: Awaited<ReturnType<typeof render>>) {
  await wrapper.get('[data-testid="fulfillment-action"]').setValue('picking')
  await wrapper.get('[data-testid="fulfillment-reason"]').setValue('Synthetic verified warehouse operation')
  await wrapper.get('form').trigger('submit')
  await flushPromises()
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
describe('private fulfillment section fresh read ownership', () => {
  it('fetches the exact current private resource uncached without GET retries and mounts a confirmed panel', async () => {
    const wrapper = await render()
    expect(read).toHaveBeenCalledTimes(1)
    expect(read.mock.calls[0]).toEqual([
      `/api/admin/orders/${ORDER}/fulfillment`,
      { method: 'GET', query: { page: 1, perPage: 25 }, retry: 0, cache: 'no-store' }
    ])
    expect(wrapper.text()).toContain('Pendiente de preparación')
    expect(wrapper.find('form').exists()).toBe(true)
  })
  it.each(['ready', 'loggedIn', 'emailVerified', 'mfaVerified'])(
    'does not fetch or expose facts without %s',
    async (flag) => {
      if (flag === 'ready') currentSession.ready.value = false
      if (flag === 'loggedIn') currentSession.loggedIn.value = false
      if (flag === 'emailVerified') currentSession.user.value!.emailVerified = false
      if (flag === 'mfaVerified') currentSession.user.value!.mfaVerified = false
      const wrapper = await render()
      expect(read).not.toHaveBeenCalled()
      expect(wrapper.find('form').exists()).toBe(false)
      expect(wrapper.text()).not.toContain('Pendiente de preparación')
    }
  )
  it.each([{ orderId: 'not-a-uuid' }, { runtime: 'legacy' }])(
    'never dispatches malformed resource/runtime %#',
    async (props) => {
      const wrapper = await render(props)
      expect(read).not.toHaveBeenCalled()
      expect(wrapper.find('form').exists()).toBe(false)
    }
  )
  it('shows loading with no old facts while refreshing and coalesces manual reload calls', async () => {
    const wrapper = await render(),
      pending = deferred<AdminOrderFulfillment>()
    read.mockReturnValueOnce(pending.promise)
    const panel = wrapper.findComponent(OrderFulfillmentPanel),
      reload = panel.props('reload') as () => Promise<unknown>
    const first = reload(),
      second = reload()
    await flushPromises()
    expect(first).toBe(second)
    expect(read).toHaveBeenCalledTimes(2)
    expect(wrapper.find('[data-testid="fulfillment-loading"]').exists()).toBe(true)
    expect(wrapper.find('form').exists()).toBe(false)
    await wrapper.get('[data-testid="fulfillment-refresh"]').trigger('click')
    expect(read).toHaveBeenCalledTimes(2)
    pending.resolve(context())
    await first
    await flushPromises()
    expect(wrapper.find('form').exists()).toBe(true)
  })
  it.each(['network', 'malformed', 'wrong_order'])(
    'a %s read never becomes writable empty/pending fallback',
    async (outcome) => {
      const wrapper = await render()
      if (outcome === 'network') read.mockRejectedValueOnce(new Error('private database details'))
      if (outcome === 'malformed') read.mockResolvedValueOnce({ source: 'cloudflare', state: 'pending' })
      if (outcome === 'wrong_order') read.mockResolvedValueOnce(context(NEXT))
      await wrapper.get('[data-testid="fulfillment-refresh"]').trigger('click')
      await flushPromises()
      expect(wrapper.find('[data-testid="fulfillment-read-error"]').exists()).toBe(true)
      expect(wrapper.find('form').exists()).toBe(false)
      expect(wrapper.text()).not.toMatch(/private database details|Pendiente de preparación/)
      read.mockResolvedValueOnce(context())
      await wrapper.get('[data-testid="fulfillment-refresh"]').trigger('click')
      await flushPromises()
      expect(wrapper.find('form').exists()).toBe(true)
    }
  )
  it('clears old facts and intent on logout; stale in-flight read cannot restore them', async () => {
    const wrapper = await render()
    await prepare(wrapper)
    const pending = deferred<AdminOrderFulfillment>()
    read.mockReturnValueOnce(pending.promise)
    await wrapper.get('[data-testid="fulfillment-refresh"]').trigger('click')
    await flushPromises()
    currentSession.loggedIn.value = false
    await flushPromises()
    pending.resolve(context())
    await flushPromises()
    expect(wrapper.findComponent(OrderFulfillmentPanel).exists()).toBe(false)
    expect(wrapper.text()).not.toContain('Pendiente de preparación')
    currentSession.loggedIn.value = true
    read.mockResolvedValue(context())
    await flushPromises()
    expect(wrapper.find('[data-testid="fulfillment-confirm"]').exists()).toBe(false)
  })
  it('identity change remounts the panel and stale actor GET cannot replace new confirmed context', async () => {
    const wrapper = await render()
    await prepare(wrapper)
    const pending = deferred<AdminOrderFulfillment>()
    read.mockReturnValueOnce(pending.promise)
    await wrapper.get('[data-testid="fulfillment-refresh"]').trigger('click')
    await flushPromises()
    currentSession.user.value = { id: OTHER, emailVerified: true, mfaVerified: true }
    read.mockResolvedValue(context())
    await flushPromises()
    pending.resolve(context())
    await flushPromises()
    expect(wrapper.find('[data-testid="fulfillment-confirm"]').exists()).toBe(false)
    expect(wrapper.findComponent(OrderFulfillmentPanel).props('operatorId')).toBe(OTHER)
  })
  it('order change remounts context and ignores stale previous order completions', async () => {
    const wrapper = await render()
    await prepare(wrapper)
    const pending = deferred<AdminOrderFulfillment>()
    read.mockReturnValueOnce(pending.promise)
    await wrapper.get('[data-testid="fulfillment-refresh"]').trigger('click')
    await flushPromises()
    read.mockResolvedValue(context(NEXT))
    await wrapper.setProps({ orderId: NEXT })
    await flushPromises()
    pending.resolve(context())
    await flushPromises()
    expect(wrapper.find('[data-testid="fulfillment-confirm"]').exists()).toBe(false)
    expect(wrapper.findComponent(OrderFulfillmentPanel).props('snapshot')).toMatchObject({ orderId: NEXT })
  })
  it('preflight reload rejects lost authority and does not dispatch a POST', async () => {
    const wrapper = await render()
    await prepare(wrapper)
    const pending = deferred<AdminOrderFulfillment>()
    read.mockReturnValueOnce(pending.promise)
    await wrapper.get('[data-testid="fulfillment-confirm"]').trigger('click')
    await flushPromises()
    currentSession.user.value!.emailVerified = false
    await flushPromises()
    pending.resolve(context())
    await flushPromises()
    expect(post).not.toHaveBeenCalled()
    expect(wrapper.emitted('confirmed')).toBeUndefined()
  })
  it('transient MFA loss during a possibly committed POST hides facts and preserves exact recovery for same actor', async () => {
    const wrapper = await render()
    await prepare(wrapper)
    const pending = deferred<ReturnType<typeof receipt>>()
    post.mockReturnValueOnce(pending.promise)
    await wrapper.get('[data-testid="fulfillment-confirm"]').trigger('click')
    await flushPromises()
    const first = post.mock.calls[0]!
    currentSession.user.value!.mfaVerified = false
    await flushPromises()
    expect(wrapper.find('form').exists()).toBe(false)
    expect(wrapper.find('[data-testid="fulfillment-retry"]').exists()).toBe(false)
    pending.resolve(receipt())
    await flushPromises()
    read.mockResolvedValue(context(ORDER, 1))
    currentSession.user.value!.mfaVerified = true
    await flushPromises()
    expect(wrapper.find('[data-testid="fulfillment-retry"]').exists()).toBe(true)
    post.mockResolvedValueOnce(receipt())
    await wrapper.get('[data-testid="fulfillment-retry"]').trigger('click')
    await flushPromises()
    expect(post.mock.calls[1]).toEqual([first[0], { ...first[1], onResponseError: expect.any(Function) }])
    expect(wrapper.emitted('confirmed')?.[0]?.[0]).toMatchObject(receipt())
  })
  it('a confirmed POST followed by read outage stays confirmed but does not leave old facts operable', async () => {
    const wrapper = await render()
    await prepare(wrapper)
    read.mockResolvedValueOnce(context()).mockRejectedValueOnce(new Error('postcommit read outage'))
    post.mockResolvedValueOnce(receipt())
    await wrapper.get('[data-testid="fulfillment-confirm"]').trigger('click')
    await flushPromises()
    expect(wrapper.emitted('confirmed')).toHaveLength(1)
    expect(wrapper.find('form').exists()).toBe(false)
    expect(wrapper.find('[data-testid="fulfillment-read-error"]').exists()).toBe(true)
  })
  it('readiness loss invalidates in-flight generation and restores only a new confirmed read', async () => {
    const wrapper = await render(),
      pending = deferred<AdminOrderFulfillment>()
    read.mockReturnValueOnce(pending.promise)
    await wrapper.get('[data-testid="fulfillment-refresh"]').trigger('click')
    await flushPromises()
    currentSession.ready.value = false
    await flushPromises()
    read.mockResolvedValue(context(ORDER, 1))
    currentSession.ready.value = true
    await flushPromises()
    pending.resolve(context())
    await flushPromises()
    expect(wrapper.findComponent(OrderFulfillmentPanel).props('snapshot')).toMatchObject({ version: 1 })
  })
  it('runtime change removes private facts and never forwards a stale read into a legacy runtime', async () => {
    const wrapper = await render(),
      pending = deferred<AdminOrderFulfillment>()
    read.mockReturnValueOnce(pending.promise)
    await wrapper.get('[data-testid="fulfillment-refresh"]').trigger('click')
    await flushPromises()
    await wrapper.setProps({ runtime: 'legacy' })
    pending.resolve(context())
    await flushPromises()
    expect(wrapper.find('form').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('Pendiente de preparación')
    expect(post).not.toHaveBeenCalled()
  })
  it('ignores awaited GET after unmount without private rendering or events', async () => {
    const wrapper = await render(),
      pending = deferred<AdminOrderFulfillment>()
    read.mockReturnValueOnce(pending.promise)
    await wrapper.get('[data-testid="fulfillment-refresh"]').trigger('click')
    await flushPromises()
    wrapper.unmount()
    pending.resolve(context())
    await flushPromises()
    expect(wrapper.emitted('confirmed')).toBeUndefined()
    expect(post).not.toHaveBeenCalled()
  })
})

import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { computed, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import OrderReturnSection from '../../app/components/OrderReturnSection.vue'
import CustomerReturnSection from '../../app/components/CustomerReturnSection.vue'
import OrderReturnPanel from '../../app/components/OrderReturnPanel.vue'
import CustomerReturnPanel from '../../app/components/CustomerReturnPanel.vue'
import {
  ACTOR,
  OTHER,
  ORDER,
  NEXT,
  REF,
  NEXT_REF,
  adminContext,
  customerContext,
  listContext,
  deferred
} from './order-returns-fixture'
import '#app/nuxt-vitest-app-entry'
const { read, post, sessionMock, navigationMock } = vi.hoisted(() => ({
  read: vi.fn(),
  post: vi.fn(),
  sessionMock: vi.fn(),
  navigationMock: vi.fn()
}))
mockNuxtImport('useRequestFetch', () => () => read)
mockNuxtImport('$fetch', () => post)
mockNuxtImport('useUserSession', () => sessionMock)
vi.mock('../../app/composables/useAdminNavigation', () => ({ useAdminNavigation: navigationMock }))
const session = () => ({
  ready: ref(true),
  loggedIn: ref(true),
  user: ref<{ id: string; emailVerified: boolean; mfaVerified: boolean } | null>({
    id: ACTOR,
    emailVerified: true,
    mfaVerified: true
  }),
  session: ref({ sessionId: '10000000-0000-4000-8000-000000000048', sessionVersion: 1 }),
  clear: async () => undefined,
  fetch: async () => undefined,
  openInPopup: () => undefined
})
let actor: ReturnType<typeof session>
const mounted: Array<{ unmount: () => void }> = []
beforeEach(() => {
  actor = session()
  sessionMock.mockImplementation(() => actor)
  navigationMock.mockReturnValue({
    status: ref('ready'),
    capabilities: computed(() => ({
      source: 'cloudflare',
      identityId: actor.user.value?.id,
      sessionId: actor.session.value.sessionId,
      sessionVersion: actor.session.value.sessionVersion,
      state: actor.user.value?.mfaVerified ? 'ready' : 'mfa_required',
      permissions: actor.user.value?.mfaVerified ? ['administration.manage'] : []
    }))
  })
  read.mockReset()
  post.mockReset()
})
afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount()
})
async function admin(props: Record<string, unknown> = {}) {
  read.mockImplementation(async (url) => (url === '/api/admin/returns' ? listContext() : adminContext()))
  const wrapper = await mountSuspended(OrderReturnSection, {
    props: { runtime: 'cloudflare', publicRef: REF, ...props },
    global: { components: { OrderReturnPanel }, stubs: { OrderReturnPanel: false } }
  })
  mounted.push(wrapper)
  await flushPromises()
  return wrapper
}
async function customer(props: Record<string, unknown> = {}) {
  if (!read.getMockImplementation()) read.mockResolvedValue(customerContext())
  const wrapper = await mountSuspended(CustomerReturnSection, {
    props: { runtime: 'cloudflare', orderId: ORDER, ...props },
    global: { components: { CustomerReturnPanel }, stubs: { CustomerReturnPanel: false } }
  })
  mounted.push(wrapper)
  await flushPromises()
  return wrapper
}
describe('private RMA sections ownership and confirmed reads', () => {
  it('reads exact public ref uncached and only displays strict admin DTO', async () => {
    const wrapper = await admin()
    expect(read).toHaveBeenCalledTimes(1)
    expect(read.mock.calls[0]).toMatchObject([
      `/api/admin/returns/${REF}`,
      { method: 'GET', retry: 0, cache: 'no-store', query: { page: 1, perPage: 25 } }
    ])
    expect(wrapper.text()).toContain('Historical product')
    expect(post).not.toHaveBeenCalled()
  })
  it('native list filters are server-side and selection uses publicRef, never legacy id', async () => {
    const wrapper = await admin({ publicRef: undefined })
    expect(read.mock.calls[0]?.[0]).toBe('/api/admin/returns')
    await wrapper.get(`[data-testid="return-open-${REF}"]`).trigger('click')
    await flushPromises()
    expect(read.mock.calls.some((call) => call[0] === `/api/admin/returns/${REF}`)).toBe(true)
    await wrapper.get('[data-testid="return-list-query"]').setValue('Original buyer')
    await wrapper.get('[data-testid="return-list-state"]').setValue('requested')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(read.mock.calls.at(-1)?.[1].query).toMatchObject({ q: 'Original buyer', state: 'requested' })
  })
  it.each(['node', 'unknown'])('does not fetch legacy/unknown runtime %s', async (runtime) => {
    const wrapper = await admin({ runtime })
    expect(read).not.toHaveBeenCalled()
    expect(wrapper.text()).not.toContain('Historical product')
  })
  it('admin requires email and MFA before read; customer does not invent MFA requirement', async () => {
    actor.user.value!.mfaVerified = false
    const wrapper = await admin()
    expect(read).not.toHaveBeenCalled()
    expect(wrapper.text()).not.toContain('Historical product')
    read.mockReset()
    const owned = await customer()
    expect(read).toHaveBeenCalledTimes(1)
    expect(owned.text()).toContain('Historical product')
  })
  it('manual admin read is single-flight and malformed fresh GET hides former facts', async () => {
    const wrapper = await admin()
    const hold = deferred<unknown>()
    read.mockReturnValueOnce(hold.promise)
    await wrapper.get('[data-testid="return-refresh"]').trigger('click')
    await wrapper.get('[data-testid="return-refresh"]').trigger('click')
    expect(read).toHaveBeenCalledTimes(2)
    expect(wrapper.text()).not.toContain('Historical product')
    hold.resolve({ items: [] })
    await flushPromises()
    expect(wrapper.find('[data-testid="return-detail-error"]').exists()).toBe(true)
    expect(wrapper.text()).not.toContain('No hay expedientes')
  })
  it('foreign admin ref and failed list are not valid empty history', async () => {
    const wrapper = await admin()
    read.mockResolvedValueOnce({ ...adminContext(), publicRef: NEXT_REF })
    await wrapper.get('[data-testid="return-refresh"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="return-detail-error"]').exists()).toBe(true)
    const list = await admin({ publicRef: undefined })
    read.mockRejectedValueOnce(new Error('provider'))
    await list.get('[data-testid="return-refresh"]').trigger('click')
    await flushPromises()
    expect(list.find('[data-testid="return-list-error"]').exists()).toBe(true)
  })
  it('logout clears private list/detail and late GET cannot restore them', async () => {
    const wrapper = await admin()
    const hold = deferred<unknown>()
    read.mockReturnValueOnce(hold.promise)
    await wrapper.get('[data-testid="return-refresh"]').trigger('click')
    actor.loggedIn.value = false
    actor.user.value = null
    hold.resolve(adminContext())
    await flushPromises()
    expect(wrapper.text()).not.toContain(REF)
    expect(wrapper.text()).not.toContain('Historical product')
    expect(wrapper.findComponent(OrderReturnPanel).exists()).toBe(false)
  })
  it('identity change remounts panel and late old-operator GET is ignored', async () => {
    const wrapper = await admin(),
      old = wrapper.findComponent(OrderReturnPanel).vm.$.uid
    const hold = deferred<unknown>()
    read.mockReturnValueOnce(hold.promise)
    await wrapper.get('[data-testid="return-refresh"]').trigger('click')
    actor.user.value!.id = OTHER
    await flushPromises()
    hold.resolve(adminContext())
    await flushPromises()
    expect(wrapper.findComponent(OrderReturnPanel).vm.$.uid).not.toBe(old)
    expect(read.mock.calls).toHaveLength(3)
  })
  it('temporary MFA loss hides facts but keeps leaf instance for same operator', async () => {
    const wrapper = await admin(),
      old = wrapper.findComponent(OrderReturnPanel).vm.$.uid
    actor.user.value!.mfaVerified = false
    await flushPromises()
    expect(wrapper.text()).not.toContain('Historical product')
    expect(wrapper.findComponent(OrderReturnPanel).vm.$.uid).toBe(old)
    actor.user.value!.mfaVerified = true
    await flushPromises()
    expect(wrapper.findComponent(OrderReturnPanel).vm.$.uid).toBe(old)
    expect(read).toHaveBeenCalledTimes(2)
  })
  it('customer uses current UUID ownership and no retry/no cache', async () => {
    const wrapper = await customer()
    expect(read.mock.calls[0]).toMatchObject([
      `/api/orders/${ORDER}/returns`,
      { method: 'GET', retry: 0, cache: 'no-store' }
    ])
    expect(wrapper.text()).toContain('Historical product')
    expect(post).not.toHaveBeenCalled()
  })
  it.each([{ orderId: 'legacy-order-number' }, { runtime: 'node' }])(
    'customer invalid ID/runtime does not fetch %#',
    async (props) => {
      const wrapper = await customer(props)
      expect(read).not.toHaveBeenCalled()
      expect(wrapper.text()).not.toContain('Historical product')
    }
  )
  it('guest and unverified customer do not acquire authority from known order or email', async () => {
    actor.loggedIn.value = false
    actor.user.value = null
    const wrapper = await customer()
    expect(read).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('contrato de verificación')
    actor.loggedIn.value = true
    actor.user.value = { id: ACTOR, emailVerified: false, mfaVerified: false }
    await flushPromises()
    expect(read).not.toHaveBeenCalled()
  })
  it('wrong-order or rejected read cannot expose available units', async () => {
    read.mockResolvedValueOnce(customerContext(NEXT))
    const wrapper = await customer()
    expect(wrapper.find('[data-testid="customer-return-read-error"]').exists()).toBe(true)
    expect(wrapper.text()).not.toContain('Historical product')
    read.mockRejectedValueOnce(new Error('provider'))
    await wrapper.get('[data-testid="customer-return-refresh"]').trigger('click')
    await flushPromises()
    expect(wrapper.text()).not.toContain('No hay solicitudes confirmadas')
  })
  it('customer order change and late prior GET cannot restore previous context', async () => {
    const wrapper = await customer()
    const hold = deferred<unknown>()
    read.mockReturnValueOnce(hold.promise)
    await wrapper.get('[data-testid="customer-return-refresh"]').trigger('click')
    read.mockResolvedValueOnce(customerContext(NEXT))
    await wrapper.setProps({ orderId: NEXT })
    await flushPromises()
    hold.resolve(customerContext())
    await flushPromises()
    expect(wrapper.findComponent(CustomerReturnPanel).props('snapshot').orderId).toBe(NEXT)
  })
  it('ready/email lapse hides customer facts without losing same-key recovery instance', async () => {
    const wrapper = await customer(),
      old = wrapper.findComponent(CustomerReturnPanel).vm.$.uid
    actor.ready.value = false
    await flushPromises()
    expect(wrapper.text()).not.toContain('Historical product')
    expect(wrapper.findComponent(CustomerReturnPanel).vm.$.uid).toBe(old)
    actor.ready.value = true
    await flushPromises()
    expect(read).toHaveBeenCalledTimes(2)
    expect(wrapper.findComponent(CustomerReturnPanel).vm.$.uid).toBe(old)
  })
  it('unmounted section discards late response and has no mutation side effect', async () => {
    const wrapper = await customer()
    const hold = deferred<unknown>()
    read.mockReturnValueOnce(hold.promise)
    await wrapper.get('[data-testid="customer-return-refresh"]').trigger('click')
    wrapper.unmount()
    hold.resolve(customerContext())
    await flushPromises()
    expect(post).not.toHaveBeenCalled()
  })
})

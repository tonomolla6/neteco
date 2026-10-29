import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { computed, proxyRefs, ref } from 'vue'
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
  receipt,
  listContext,
  deferred
} from './order-returns-fixture'
import '#app/nuxt-vitest-app-entry'

const mocks = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn(), session: vi.fn(), navigation: vi.fn() }))
mockNuxtImport('useRequestFetch', () => () => mocks.read)
mockNuxtImport('$fetch', () => mocks.write)
mockNuxtImport('useUserSession', () => mocks.session)
vi.mock('../../app/composables/useAdminNavigation', () => ({ useAdminNavigation: mocks.navigation }))
const sessionState = () => ({
  ready: ref(true),
  loggedIn: ref(true),
  user: ref({ id: ACTOR, emailVerified: true, mfaVerified: true }),
  session: ref({ sessionId: OTHER, sessionVersion: 1 })
})
let actor: ReturnType<typeof sessionState>
const permission = ref(true)
const navigationStatus = ref('ready')
const mounted: Array<{ unmount: () => void }> = []
beforeEach(() => {
  actor = sessionState()
  permission.value = true
  navigationStatus.value = 'ready'
  mocks.session.mockReturnValue(actor)
  mocks.read.mockReset()
  mocks.write.mockReset()
  mocks.navigation.mockReturnValue({
    status: navigationStatus,
    capabilities: computed(() => ({
      source: 'cloudflare',
      identityId: actor.user.value.id,
      sessionId: actor.session.value.sessionId,
      sessionVersion: actor.session.value.sessionVersion,
      state: 'ready',
      permissions: permission.value ? ['administration.manage'] : []
    }))
  })
})
afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount()
})
async function section(audience: 'admin' | 'customer') {
  mocks.read.mockResolvedValue(audience === 'admin' ? adminContext() : customerContext())
  const wrapper =
    audience === 'admin'
      ? await mountSuspended(OrderReturnSection, {
          props: { runtime: 'cloudflare', publicRef: REF },
          global: { components: { OrderReturnPanel }, stubs: { OrderReturnPanel: false } }
        })
      : await mountSuspended(CustomerReturnSection, {
          props: { runtime: 'cloudflare', orderId: ORDER },
          global: { components: { CustomerReturnPanel }, stubs: { CustomerReturnPanel: false } }
        })
  mounted.push(wrapper)
  await flushPromises()
  return wrapper
}
describe('RMA real session DTO and current authority', () => {
  it('does not read admin private data from a role or session without the current grant', async () => {
    permission.value = false
    const wrapper = await section('admin')
    expect(mocks.read).not.toHaveBeenCalled()
    expect(wrapper.text()).not.toContain('Historical product')
  })
  it.each(['permission', 'unauthenticated'])(
    'purges the admin private draft on confirmed %s loss',
    async (boundary) => {
      const wrapper = await section('admin')
      await wrapper.get('[data-testid="return-reason"]').setValue('Private operator draft')
      if (boundary === 'permission') permission.value = false
      else navigationStatus.value = 'unauthenticated'
      await flushPromises()
      expect(wrapper.text()).not.toContain('Historical product')
      expect(wrapper.findComponent(OrderReturnPanel).exists()).toBe(false)
      expect(mocks.write).not.toHaveBeenCalled()
    }
  )
  it('purges the private admin list query and filters when its session rotates', async () => {
    mocks.read.mockResolvedValue(listContext())
    const wrapper = await mountSuspended(OrderReturnSection, { props: { runtime: 'cloudflare' } })
    mounted.push(wrapper)
    await flushPromises()
    await wrapper.get('[data-testid="return-list-query"]').setValue('Private customer filter')
    await wrapper.get('[data-testid="return-list-state"]').setValue('requested')
    actor.session.value.sessionVersion++
    await flushPromises()
    const state = proxyRefs(wrapper.setupState)
    expect(state.query).toBe('')
    expect(state.state).toBe('')
    expect(mocks.write).not.toHaveBeenCalled()
  })
  for (const audience of ['admin', 'customer'] as const) {
    const Panel = audience === 'admin' ? OrderReturnPanel : CustomerReturnPanel
    const reasonSelector =
      audience === 'admin' ? '[data-testid="return-reason"]' : '[data-testid="customer-return-reason"]'
    it.each(['rate_limited', 'version_conflict', 'not_found'])(
      `${audience} retains the original uncertain intent when recovery returns %s`,
      async (code) => {
        const wrapper = await section(audience)
        const panel = wrapper.findComponent(Panel)
        if (audience === 'admin') {
          await wrapper.get('[data-testid="return-action"]').setValue('approved')
          await wrapper.get('[data-testid="return-public-message"]').setValue('Información visible para el cliente.')
          await wrapper.get('[data-testid="return-evidence"]').setValue('Private warehouse evidence reference')
          await wrapper.get('[data-testid="return-decision"]').setValue('documented-review-ref')
        } else await wrapper.get('[data-testid="customer-return-quantity-0"]').setValue(1)
        await wrapper.get(reasonSelector).setValue('Private scoped return reason')
        await panel.get('form').trigger('submit')
        mocks.write.mockRejectedValueOnce(new Error('response lost after possible commit'))
        const selector =
          audience === 'admin' ? '[data-testid="return-confirm"]' : '[data-testid="customer-return-confirm"]'
        await wrapper.get(selector).trigger('click')
        await flushPromises()
        const original = mocks.write.mock.calls[0]!
        mocks.write.mockImplementationOnce(async (_path, options) => {
          options.onResponseError({
            response: {
              status: code === 'rate_limited' ? 429 : code === 'not_found' ? 404 : 409,
              _data: { error: { code } }
            }
          })
          throw new Error('rejection before command lookup')
        })
        await wrapper.get(selector).trigger('click')
        await flushPromises()
        const state = proxyRefs(panel.vm.$.setupState)
        expect(state.intent).not.toBeNull()
        expect(state.ambiguous).toBe(true)
        expect(mocks.write.mock.calls[1]).toEqual([
          original[0],
          { ...original[1], onResponseError: expect.any(Function) }
        ])
        expect(wrapper.emitted('confirmed')).toBeUndefined()
        expect(wrapper.text()).not.toContain('rechazada de forma confirmada')
      }
    )
    it.each(['sessionId', 'sessionVersion', 'email'] as const)(
      `${audience} purges the old panel and drafts on %s boundary`,
      async (boundary) => {
        const wrapper = await section(audience)
        const old = wrapper.findComponent(Panel),
          oldUid = old.vm.$.uid
        await wrapper.get(reasonSelector).setValue('Private scoped return reason')
        const state = proxyRefs(old.vm.$.setupState)
        if (boundary === 'sessionId') actor.session.value.sessionId = NEXT
        else if (boundary === 'sessionVersion') actor.session.value.sessionVersion++
        else actor.user.value.emailVerified = false
        await flushPromises()
        expect(state.reason).toBe('')
        if (boundary === 'email') expect(wrapper.findComponent(Panel).exists()).toBe(false)
        else {
          expect(wrapper.findComponent(Panel).vm.$.uid).not.toBe(oldUid)
          expect((wrapper.get(reasonSelector).element as HTMLTextAreaElement).value).toBe('')
        }
        expect(mocks.write).not.toHaveBeenCalled()
      }
    )
    it(`${audience} rejects a response from the previous session while a fresh read is pending`, async () => {
      const wrapper = await section(audience)
      const stale = deferred<unknown>(),
        fresh = deferred<unknown>()
      mocks.read.mockReturnValueOnce(stale.promise).mockReturnValueOnce(fresh.promise)
      await wrapper
        .get(audience === 'admin' ? '[data-testid="return-refresh"]' : '[data-testid="customer-return-refresh"]')
        .trigger('click')
      actor.session.value.sessionVersion++
      await flushPromises()
      stale.resolve(audience === 'admin' ? adminContext() : customerContext())
      await flushPromises()
      expect(wrapper.text()).not.toContain('Historical product')
      fresh.resolve(audience === 'admin' ? adminContext() : customerContext())
      await flushPromises()
      expect(wrapper.text()).toContain('Historical product')
    })
    it(`${audience} purges local PII and frozen intention on unmount`, async () => {
      const wrapper = await section(audience)
      const panel = wrapper.findComponent(Panel)
      await wrapper.get(reasonSelector).setValue('Private scoped return reason')
      const state = proxyRefs(panel.vm.$.setupState)
      wrapper.unmount()
      expect(state.reason).toBe('')
      expect(state.intent).toBeNull()
    })
    it(`${audience} discards a late write receipt from a previous session without replaying it`, async () => {
      const wrapper = await section(audience)
      const panel = wrapper.findComponent(Panel)
      if (audience === 'admin') {
        await wrapper.get('[data-testid="return-action"]').setValue('approved')
        await wrapper.get('[data-testid="return-public-message"]').setValue('Información visible para el cliente.')
        await wrapper.get('[data-testid="return-evidence"]').setValue('Private warehouse evidence reference')
        await wrapper.get('[data-testid="return-decision"]').setValue('documented-review-ref')
      } else await wrapper.get('[data-testid="customer-return-quantity-0"]').setValue(1)
      await wrapper.get(reasonSelector).setValue('Private scoped return reason')
      await panel.get('form').trigger('submit')
      const hold = deferred<unknown>()
      mocks.write.mockReturnValue(hold.promise)
      await wrapper
        .get(audience === 'admin' ? '[data-testid="return-confirm"]' : '[data-testid="customer-return-confirm"]')
        .trigger('click')
      await flushPromises()
      expect(mocks.write).toHaveBeenCalledTimes(1)
      const state = proxyRefs(panel.vm.$.setupState)
      actor.session.value.sessionVersion++
      await flushPromises()
      hold.resolve(audience === 'admin' ? receipt() : receipt('requested', 1))
      await flushPromises()
      expect(state.intent).toBeNull()
      expect(state.reason).toBe('')
      expect(wrapper.emitted('confirmed')).toBeUndefined()
      expect(mocks.write).toHaveBeenCalledTimes(1)
      expect(wrapper.text()).not.toContain('Operación confirmada')
      expect(wrapper.text()).not.toContain('Solicitud registrada')
    })
  }
})

describe('RMA confirmed read correlation', () => {
  it.each(['publicRef', 'orderId', 'warehouse'] as const)(
    'does not enable new admin operations after a historical receipt with wrong fresh %s',
    async (field) => {
      let readNumber = 0
      const changed = adminContext('approved', 2)
      if (field === 'publicRef') changed.publicRef = NEXT_REF
      else if (field === 'orderId') changed.orderId = NEXT
      else changed.warehouse = { id: 'other', name: 'Other warehouse' }
      const reload = vi.fn(async () => (++readNumber === 1 ? adminContext() : changed))
      const wrapper = await mountSuspended(OrderReturnPanel, {
        props: { snapshot: adminContext(), operatorId: ACTOR, runtime: 'cloudflare', authorize: () => true, reload }
      })
      mounted.push(wrapper)
      await wrapper.get('[data-testid="return-action"]').setValue('approved')
      await wrapper.get('[data-testid="return-reason"]').setValue('Private documented case review')
      await wrapper.get('[data-testid="return-public-message"]').setValue('Información visible para el cliente.')
      await wrapper.get('[data-testid="return-evidence"]').setValue('Private warehouse evidence reference')
      await wrapper.get('[data-testid="return-decision"]').setValue('documented-review-ref')
      await wrapper.get('form').trigger('submit')
      mocks.write.mockResolvedValue(receipt())
      await wrapper.get('[data-testid="return-confirm"]').trigger('click')
      await flushPromises()
      expect(wrapper.emitted('confirmed')).toHaveLength(1)
      expect(wrapper.find('[data-testid="return-facts"]').exists()).toBe(false)
      expect(wrapper.text()).toContain('El recibo es histórico')
      expect(mocks.write).toHaveBeenCalledTimes(1)
    }
  )
})

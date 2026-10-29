import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { defineComponent, h, ref } from 'vue'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import Communications from '../../app/pages/cuenta/comunicaciones.vue'
import { DELIVERY_PREFERENCES_NOTICE_TEXT } from '../../shared/delivery-preferences'
import '#app/nuxt-vitest-app-entry'

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  legacy: vi.fn(),
  session: vi.fn(),
  leave: vi.fn(),
  runtime: vi.fn(() => ({
    app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
    public: { serverRuntime: 'cloudflare' }
  }))
}))
mockNuxtImport('useRequestFetch', () => () => mocks.request)
mockNuxtImport('useFetch', () => mocks.legacy)
mockNuxtImport('useUserSession', () => mocks.session)
mockNuxtImport('useRuntimeConfig', () => mocks.runtime)
mockNuxtImport('onBeforeRouteLeave', () => mocks.leave)
const ID = '10000000-0000-4000-8000-000000000050',
  SID = '20000000-0000-4000-8000-000000000050'
function panel(name: string) {
  return defineComponent({
    name,
    props: ['scopeKey', 'enabled', 'pending'],
    emits: ['pending'],
    setup: () => () => h('section', name)
  })
}
const Privacy = panel('AccountPrivacyPanel'),
  Marketing = panel('AccountPreferencesPanel')
const Surface = defineComponent({
  setup:
    (_, { slots }) =>
    () =>
      h('section', slots.default?.())
})
let auth: ReturnType<typeof currentSession>
let wrapper: Awaited<ReturnType<typeof mountSuspended>> | undefined
function currentSession() {
  return {
    ready: ref(true),
    loggedIn: ref(true),
    user: ref({ id: ID, email: 'owner@example.invalid', emailVerified: true }),
    session: ref({ sessionId: SID, sessionVersion: 1 })
  }
}
beforeEach(() => {
  auth = currentSession()
  mocks.session.mockReturnValue(auth)
  mocks.request.mockReset().mockResolvedValue({
    source: 'cloudflare',
    version: 0,
    deliveryUpdates: true,
    policyVersion: 'delivery-notices-2026-10-09',
    noticeText: DELIVERY_PREFERENCES_NOTICE_TEXT,
    updatedAt: null
  })
  mocks.legacy
    .mockReset()
    .mockImplementation(async () => ({ data: ref({ preferences: [], requests: [] }), refresh: vi.fn() }))
  mocks.leave.mockReset()
  mocks.runtime.mockReturnValue({
    app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
    public: { serverRuntime: 'cloudflare' }
  })
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  vi.restoreAllMocks()
})
async function render() {
  wrapper = await mountSuspended(Communications, {
    global: {
      stubs: {
        AccountPrivacyPanel: Privacy,
        AccountPreferencesPanel: Marketing,
        UiSurface: Surface,
        UiPageHeader: Surface,
        UButton: true,
        USwitch: true,
        UModal: true,
        AccountFeedback: true
      }
    }
  })
  await flushPromises()
  return wrapper
}
it('offers operational delivery notices in the real verified-account page, independently of commercial preferences', async () => {
  const page = await render()
  expect(page.find('section[aria-label="Avisos de entrega"]').exists()).toBe(true)
  expect(mocks.request).toHaveBeenCalledWith(
    '/api/account/delivery-preferences',
    expect.objectContaining({ method: 'GET', retry: 0 })
  )
  expect(page.getComponent(Privacy).props('pending')).toBe(false)
  expect(page.getComponent(Marketing).props('pending')).toBe(false)
  expect(mocks.legacy).not.toHaveBeenCalled()
})
it('keeps the delivery recovery mounted while blocking only competing panels', async () => {
  const page = await render(),
    delivery = page.findComponent({ name: 'DeliveryPreferencesPanel' })
  expect(delivery.exists()).toBe(true)
  delivery.vm.$emit('pending', true)
  await flushPromises()
  expect(delivery.props('pending')).toBe(false)
  expect(page.getComponent(Privacy).props('pending')).toBe(true)
  expect(page.getComponent(Marketing).props('pending')).toBe(true)
  page.getComponent(Privacy).vm.$emit('pending', true)
  await flushPromises()
  expect(delivery.props('pending')).toBe(true)
})
it('purges delivery mount on verification loss and ignores its late pending event', async () => {
  const page = await render(),
    delivery = page.findComponent({ name: 'DeliveryPreferencesPanel' })
  expect(delivery.exists()).toBe(true)
  const handler = delivery.vm.$.vnode.props!.onPending as (value: boolean) => void
  auth.user.value.emailVerified = false
  await flushPromises()
  expect(delivery.vm.$.isUnmounted).toBe(true)
  auth.user.value.emailVerified = true
  await flushPromises()
  handler(true)
  await flushPromises()
  expect(page.getComponent(Marketing).props('pending')).toBe(false)
})
it('Node retains its original reads without the Cloudflare delivery panel', async () => {
  mocks.runtime.mockReturnValue({
    app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
    public: { serverRuntime: 'node' }
  })
  const page = await render()
  expect(page.findComponent({ name: 'DeliveryPreferencesPanel' }).exists()).toBe(false)
  expect(mocks.request).not.toHaveBeenCalled()
  expect(mocks.legacy.mock.calls.map(([path]) => path)).toEqual(['/api/account/preferences', '/api/account/privacy'])
})

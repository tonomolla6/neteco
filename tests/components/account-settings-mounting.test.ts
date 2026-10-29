import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { defineComponent, h, ref } from 'vue'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import Communications from '../../app/pages/cuenta/comunicaciones.vue'
import '#app/nuxt-vitest-app-entry'
const mocks = vi.hoisted(() => ({
  legacy: vi.fn(),
  write: vi.fn(),
  session: vi.fn(),
  leave: vi.fn(),
  runtime: vi.fn(() => ({
    app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
    public: { serverRuntime: 'cloudflare' }
  }))
}))
mockNuxtImport('useFetch', () => mocks.legacy)
mockNuxtImport('$fetch', () => mocks.write)
mockNuxtImport('useUserSession', () => mocks.session)
mockNuxtImport('useRuntimeConfig', () => mocks.runtime)
mockNuxtImport('onBeforeRouteLeave', () => mocks.leave)
const ID = '10000000-0000-4000-8000-000000000050',
  SID = '20000000-0000-4000-8000-000000000050',
  OTHER = '30000000-0000-4000-8000-000000000050'
function stub(name: string) {
  return defineComponent({
    name,
    props: { scopeKey: String, enabled: Boolean, pending: Boolean, runtime: String },
    emits: ['pending', 'confirmed'],
    setup: () => () => h('section', name)
  })
}
const Privacy = stub('AccountPrivacyPanel'),
  Preferences = stub('AccountPreferencesPanel')
const Surface = defineComponent({
  setup:
    (_, { slots }) =>
    () =>
      h('section', slots.default?.())
})
const Button = defineComponent({
  setup:
    (_, { slots, attrs }) =>
    () =>
      h('button', attrs, slots.default?.())
})
const Link = defineComponent({
  props: ['to'],
  setup:
    (props, { slots }) =>
    () =>
      h('a', { href: props.to }, slots.default?.())
})
let auth: {
  ready: ReturnType<typeof ref<boolean>>
  loggedIn: ReturnType<typeof ref<boolean>>
  user: ReturnType<typeof ref<{ id: string; email: string; emailVerified: boolean; mfaVerified: boolean } | null>>
  session: ReturnType<typeof ref<{ sessionId: string; sessionVersion: number } | null>>
}
let wrapper: Awaited<ReturnType<typeof mountSuspended>> | undefined
async function render() {
  wrapper = await mountSuspended(Communications, {
    global: {
      stubs: {
        AccountPrivacyPanel: Privacy,
        AccountPreferencesPanel: Preferences,
        DeliveryPreferencesPanel: true,
        UiSurface: Surface,
        UiPageHeader: Surface,
        UButton: Button,
        NuxtLink: Link,
        USwitch: true,
        UModal: true,
        AccountFeedback: true
      }
    }
  })
  await flushPromises()
  return wrapper
}
beforeEach(() => {
  auth = {
    ready: ref(true),
    loggedIn: ref(true),
    user: ref({ id: ID, email: 'owner@example.invalid', emailVerified: true, mfaVerified: false }),
    session: ref({ sessionId: SID, sessionVersion: 1 })
  }
  mocks.session.mockReturnValue(auth)
  mocks.legacy.mockReset().mockImplementation(async (path: string) => ({
    data: ref(path.endsWith('/privacy') ? { requests: [] } : { preferences: [] }),
    refresh: vi.fn()
  }))
  mocks.write.mockReset()
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
it('mounts both actual CF panels for verified current customer without requiring MFA; no legacy GET or write', async () => {
  const page = await render()
  for (const panel of [Privacy, Preferences])
    expect(page.getComponent(panel).props()).toMatchObject({ enabled: true, pending: false })
  const scope = page.getComponent(Privacy).props('scopeKey')
  expect(page.getComponent(Preferences).props('runtime')).toBe('cloudflare')
  expect(scope).toBe(page.getComponent(Preferences).props('scopeKey'))
  for (const value of [ID, SID, 'owner@example.invalid']) expect(scope).toContain(value)
  expect(mocks.legacy).not.toHaveBeenCalled()
  expect(mocks.write).not.toHaveBeenCalled()
  expect(page.text()).not.toMatch(
    /anonimización tampoco están disponibles|avisos de producto y reposición no está disponible/
  )
  expect(page.text()).toContain('doble opt-in')
  expect(page.find('a[href="/cuenta/newsletter"]').exists()).toBe(true)
})
it.each(['ready', 'loggedIn', 'email', 'identity', 'session', 'version'])(
  'does not mount private panels with invalid %s authority',
  async (kind) => {
    if (kind === 'ready') auth.ready.value = false
    if (kind === 'loggedIn') auth.loggedIn.value = false
    if (kind === 'email') auth.user.value!.emailVerified = false
    if (kind === 'identity') auth.user.value!.id = 'invalid'
    if (kind === 'session') auth.session.value!.sessionId = 'invalid'
    if (kind === 'version') auth.session.value!.sessionVersion = 0
    const page = await render()
    expect(page.findComponent(Privacy).exists()).toBe(false)
    expect(page.findComponent(Preferences).exists()).toBe(false)
    expect(mocks.legacy).not.toHaveBeenCalled()
    expect(mocks.write).not.toHaveBeenCalled()
  }
)
it.each(['privacy', 'preferences'])(
  '%s pending blocks only the competing panel, never its own recovery',
  async (kind) => {
    const page = await render(),
      owner = kind === 'privacy' ? Privacy : Preferences,
      other = kind === 'privacy' ? Preferences : Privacy
    page.getComponent(owner).vm.$emit('pending', true)
    await flushPromises()
    expect(page.getComponent(owner).props('pending')).toBe(false)
    expect(page.getComponent(other).props('pending')).toBe(true)
    page.getComponent(owner).vm.$emit('pending', false)
    await flushPromises()
    expect(page.getComponent(other).props('pending')).toBe(false)
  }
)
it.each(['identity', 'email', 'session', 'version', 'verification', 'ready', 'logout'])(
  'purges old mounts and cross-pending on %s boundary; late previous events cannot relock',
  async (kind) => {
    const page = await render(),
      old = page.getComponent(Privacy),
      original = old.props('scopeKey')
    const staleHandler = old.vm.$.vnode.props!.onPending as (value: boolean) => void
    old.vm.$emit('pending', true)
    await flushPromises()
    expect(page.getComponent(Preferences).props('pending')).toBe(true)
    if (kind === 'identity') auth.user.value!.id = OTHER
    if (kind === 'email') auth.user.value!.email = 'other@example.invalid'
    if (kind === 'session') auth.session.value!.sessionId = OTHER
    if (kind === 'version') auth.session.value!.sessionVersion++
    if (kind === 'verification') auth.user.value!.emailVerified = false
    if (kind === 'ready') auth.ready.value = false
    if (kind === 'logout') auth.loggedIn.value = false
    await flushPromises()
    expect(old.vm.$.isUnmounted).toBe(true)
    auth.user.value!.emailVerified = true
    auth.ready.value = true
    auth.loggedIn.value = true
    await flushPromises()
    staleHandler(true)
    await flushPromises()
    expect(page.getComponent(Preferences).props('pending')).toBe(false)
    if (!['ready', 'logout', 'verification'].includes(kind))
      expect(page.getComponent(Privacy).props('scopeKey')).not.toBe(original)
  }
)
it('warns on leaving during pending without sending any command; recovered pending permits navigation', async () => {
  const page = await render()
  page.getComponent(Privacy).vm.$emit('pending', true)
  await flushPromises()
  Object.defineProperty(window, 'confirm', { value: vi.fn(() => false), configurable: true, writable: true })
  const guard = mocks.leave.mock.calls[0]![0] as () => boolean
  expect(guard()).toBe(false)
  expect(window.confirm).toHaveBeenCalledOnce()
  expect(mocks.write).not.toHaveBeenCalled()
  page.getComponent(Privacy).vm.$emit('pending', false)
  await flushPromises()
  expect(guard()).toBe(true)
})
it('Node keeps both legacy GETs and PUT flow with no D1 panels', async () => {
  mocks.runtime.mockReturnValue({
    app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
    public: { serverRuntime: 'node' }
  })
  const page = await render()
  expect(mocks.legacy.mock.calls.map((call) => call[0])).toEqual(['/api/account/preferences', '/api/account/privacy'])
  expect(page.findComponent(Privacy).exists()).toBe(false)
  expect(page.findComponent(Preferences).exists()).toBe(false)
  await page
    .findAll('button')
    .find((entry) => entry.text() === 'Guardar preferencias')!
    .trigger('click')
  await flushPromises()
  expect(mocks.write).toHaveBeenCalledWith('/api/account/preferences', expect.objectContaining({ method: 'PUT' }))
})
it.each(['unexpected', '', undefined])(
  'unsupported runtime %s cannot fall through to Node reads or writes',
  async (runtime) => {
    mocks.runtime.mockReturnValue({
      app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
      public: { serverRuntime: runtime as string }
    })
    const page = await render()
    expect(mocks.legacy).not.toHaveBeenCalled()
    expect(page.findComponent(Privacy).exists()).toBe(false)
    expect(page.findComponent(Preferences).exists()).toBe(false)
    const actions = page.setupState as unknown as {
      savePreferences(): Promise<void>
      requestExport(): Promise<void>
      requestAnonymize(): Promise<void>
    }
    await actions.savePreferences()
    await actions.requestExport()
    await actions.requestAnonymize()
    expect(mocks.write).not.toHaveBeenCalled()
  }
)

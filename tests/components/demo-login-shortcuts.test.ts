import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { ref, reactive } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import DemoLoginShortcuts from '../../app/components/DemoLoginShortcuts.vue'
import LoginPage from '../../app/pages/login.vue'
import '#app/nuxt-vitest-app-entry'

const { post, fallback, refresh, navigate, sessionMock, configuration } = vi.hoisted(() => ({
  post: vi.fn(),
  fallback: vi.fn(),
  refresh: vi.fn(),
  navigate: vi.fn(),
  sessionMock: vi.fn(),
  configuration: vi.fn()
}))
mockNuxtImport('useRequestFetch', () => () => Object.assign(fallback, { raw: post }))
mockNuxtImport('$fetch', () => fallback)
mockNuxtImport(
  'useUserSession',
  () => () =>
    sessionMock() ?? {
      ready: ref(true),
      loggedIn: ref(false),
      user: ref(null),
      session: ref(null),
      fetch: async () => undefined,
      clear: async () => undefined,
      openInPopup: () => undefined
    }
)
mockNuxtImport('navigateTo', () => navigate)
mockNuxtImport(
  'useRuntimeConfig',
  () => () =>
    configuration() ?? {
      app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '', buildId: 'synthetic-nuxt-test' },
      public: { serverRuntime: 'node', demoEnabled: false }
    }
)
type Role = 'customer' | 'admin'
type User = { id: string; role: Role; emailVerified: boolean; mfaVerified: boolean }
const CUSTOMER = '10000000-0000-4000-8000-000000000053',
  ADMIN = '20000000-0000-4000-8000-000000000053',
  OTHER = '30000000-0000-4000-8000-000000000053'
const identity = (role: Role) => (role === 'admin' ? ADMIN : CUSTOMER)
const receipt = (role: Role = 'customer') => ({ source: 'cloudflare', demo: true, role, identityId: identity(role) })
const session = () => ({
  ready: ref(true),
  loggedIn: ref(false),
  user: ref<User | null>(null),
  session: ref(null),
  fetch: refresh,
  clear: async () => undefined,
  openInPopup: () => undefined
})
const configurationState = () =>
  reactive({
    app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '', buildId: 'synthetic-nuxt-test' },
    public: { serverRuntime: 'cloudflare', demoEnabled: true }
  })
let actor = session(),
  runtime = configurationState()
sessionMock.mockImplementation(() => actor)
configuration.mockImplementation(() => runtime)
const mounted: Array<{ unmount: () => void }> = []
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((success, failure) => {
    resolve = success
    reject = failure
  })
  return { promise, resolve, reject }
}
function confirm(role: Role) {
  actor.ready.value = true
  actor.loggedIn.value = true
  actor.user.value = { id: identity(role), role, emailVerified: true, mfaVerified: role === 'admin' }
}
beforeEach(() => {
  actor = session()
  runtime = configurationState()
  sessionMock.mockImplementation(() => actor)
  configuration.mockImplementation(() => runtime)
  post.mockReset().mockImplementation(async (_url, options) => ({ status: 200, _data: receipt(options.body.role) }))
  fallback.mockReset()
  refresh.mockReset().mockImplementation(async () => {
    confirm(post.mock.calls.at(-1)![1].body.role)
  })
  navigate.mockReset().mockResolvedValue(undefined)
})
afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount()
})
async function render(props: { runtime?: unknown; enabled?: unknown } = {}) {
  const wrapper = await mountSuspended(DemoLoginShortcuts, {
    props: { runtime: 'cloudflare', enabled: true, ...props }
  })
  mounted.push(wrapper)
  await flushPromises()
  return wrapper
}
const button = (role: Role) => `[data-testid="demo-login-${role}"]`

describe('isolated Cloudflare demo login shortcuts', () => {
  it.each([
    { runtime: 'node' },
    { runtime: 'unknown' },
    { runtime: null },
    { enabled: false },
    { enabled: 'true' },
    { enabled: 1 },
    { enabled: null },
    { enabled: undefined }
  ])('never exposes shortcuts outside the explicit boolean Cloudflare opt-in %#', async (props) => {
    const wrapper = await render(props)
    expect(wrapper.find('[data-testid="demo-login-shortcuts"]').exists()).toBe(false)
    expect(post).not.toHaveBeenCalled()
    expect(fallback).not.toHaveBeenCalled()
    expect(refresh).not.toHaveBeenCalled()
  })
  it('labels synthetic isolation and uses accessible native buttons without credentials', async () => {
    const wrapper = await render()
    expect(wrapper.text()).toContain('DEMO · sintética y aislada')
    expect(wrapper.text()).toContain('Sin pagos reales')
    for (const role of ['customer', 'admin'] as const) {
      const control = wrapper.get(button(role))
      expect(control.element.tagName).toBe('BUTTON')
      expect(control.attributes('type')).toBe('button')
      expect(control.attributes('aria-describedby')).toBe('demo-login-description')
      expect(control.attributes('disabled')).toBeUndefined()
    }
    expect(wrapper.text()).not.toMatch(/password|contraseña|secret|@/i)
    expect(post).not.toHaveBeenCalled()
  })
  it.each(['customer', 'admin'] as const)(
    'posts only %s once and navigates only after the exact fresh verified session',
    async (role) => {
      const wrapper = await render()
      await wrapper.get(button(role)).trigger('click')
      await flushPromises()
      expect(post).toHaveBeenCalledExactlyOnceWith('/api/demo/login', {
        method: 'POST',
        body: { role },
        retry: 0,
        credentials: 'same-origin',
        referrerPolicy: 'no-referrer',
        cache: 'no-store'
      })
      expect(refresh).toHaveBeenCalledTimes(1)
      expect(navigate).toHaveBeenCalledExactlyOnceWith(role === 'admin' ? '/admin' : '/cuenta')
      expect(refresh.mock.invocationCallOrder[0]).toBeGreaterThan(post.mock.invocationCallOrder[0]!)
      expect(navigate.mock.invocationCallOrder[0]).toBeGreaterThan(refresh.mock.invocationCallOrder[0]!)
      expect(fallback).not.toHaveBeenCalled()
    }
  )
  it('disables both buttons for the entire POST and session-refresh single flight', async () => {
    const pending = deferred<{ status: number; _data: unknown }>(),
      heldRefresh = deferred<undefined>()
    post.mockReturnValueOnce(pending.promise)
    refresh.mockImplementationOnce(async () => {
      await heldRefresh.promise
      confirm('customer')
    })
    const wrapper = await render()
    await wrapper.get(button('customer')).trigger('click')
    for (const role of ['customer', 'admin'] as const)
      expect(wrapper.get(button(role)).attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-testid="demo-login-shortcuts"]').attributes('aria-busy')).toBe('true')
    await wrapper.get(button('admin')).trigger('click')
    expect(post).toHaveBeenCalledTimes(1)
    pending.resolve({ status: 200, _data: receipt() })
    await flushPromises()
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(navigate).not.toHaveBeenCalled()
    expect(wrapper.get(button('admin')).attributes('disabled')).toBeDefined()
    heldRefresh.resolve(undefined)
    await flushPromises()
    expect(navigate).toHaveBeenCalledExactlyOnceWith('/cuenta')
    expect(wrapper.get(button('admin')).attributes('disabled')).toBeUndefined()
  })
  it('waits for session readiness before accepting a click', async () => {
    actor.ready.value = false
    const wrapper = await render()
    expect(wrapper.get(button('customer')).attributes('disabled')).toBeDefined()
    await wrapper.get(button('customer')).trigger('click')
    expect(post).not.toHaveBeenCalled()
  })
  it('a rejected POST shows a bounded generic error, never refreshes, retries or leaks its body', async () => {
    post.mockRejectedValueOnce({
      data: { secret: 'SYNTHETIC_PRIVATE_PAYLOAD', error: { message: 'provider details' } }
    })
    const wrapper = await render()
    await wrapper.get(button('admin')).trigger('click')
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toContain('No se ha podido confirmar')
    expect(wrapper.text()).not.toContain('SYNTHETIC_PRIVATE_PAYLOAD')
    expect(post).toHaveBeenCalledTimes(1)
    expect(refresh).not.toHaveBeenCalled()
    expect(navigate).not.toHaveBeenCalled()
    const retry = deferred<{ status: number; _data: unknown }>()
    post.mockReturnValueOnce(retry.promise)
    await wrapper.get(button('admin')).trigger('click')
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    retry.resolve({ status: 200, _data: receipt('admin') })
    await flushPromises()
    expect(post).toHaveBeenCalledTimes(2)
    expect(navigate).toHaveBeenCalledExactlyOnceWith('/admin')
  })
  it.each([
    { status: 201, _data: receipt() },
    { status: 200, _data: { ...receipt(), demo: false } },
    { status: 200, _data: receipt('admin') },
    { status: 200, _data: { ...receipt(), identityId: 'legacy-id' } },
    { status: 200, _data: { ...receipt(), source: 'node' } },
    { status: 200, _data: { ...receipt(), extra: 'not-authoritative' } }
  ])('rejects an unconfirmed or mismatched receipt before refreshing %#', async (response) => {
    post.mockResolvedValueOnce(response)
    const wrapper = await render()
    await wrapper.get(button('customer')).trigger('click')
    await flushPromises()
    expect(wrapper.find('[role="alert"]').exists()).toBe(true)
    expect(refresh).not.toHaveBeenCalled()
    expect(navigate).not.toHaveBeenCalled()
    expect(post).toHaveBeenCalledTimes(1)
  })
  it('does not execute getter-bearing receipt values', async () => {
    const data = receipt(),
      getter = vi.fn(() => 'cloudflare')
    Object.defineProperty(data, 'source', { enumerable: true, get: getter })
    post.mockResolvedValueOnce({ status: 200, _data: data })
    const wrapper = await render()
    await wrapper.get(button('customer')).trigger('click')
    await flushPromises()
    expect(getter).not.toHaveBeenCalled()
    expect(refresh).not.toHaveBeenCalled()
    expect(navigate).not.toHaveBeenCalled()
  })
  it('a failed session refresh cannot navigate despite an accepted POST', async () => {
    refresh.mockRejectedValueOnce(Error('synthetic unavailable'))
    const wrapper = await render()
    await wrapper.get(button('customer')).trigger('click')
    await flushPromises()
    expect(wrapper.find('[role="alert"]').exists()).toBe(true)
    expect(navigate).not.toHaveBeenCalled()
    expect(post).toHaveBeenCalledTimes(1)
    expect(refresh).toHaveBeenCalledTimes(1)
  })
  it.each(['logged_out', 'identity_mismatch', 'wrong_role', 'email_unverified', 'admin_mfa_unverified'] as const)(
    'requires confirmed session authority after refresh: %s',
    async (change) => {
      refresh.mockImplementationOnce(async () => {
        confirm('admin')
        if (change === 'logged_out') actor.loggedIn.value = false
        if (change === 'identity_mismatch') actor.user.value!.id = OTHER
        if (change === 'wrong_role') actor.user.value!.role = 'customer'
        if (change === 'email_unverified') actor.user.value!.emailVerified = false
        if (change === 'admin_mfa_unverified') actor.user.value!.mfaVerified = false
      })
      const wrapper = await render()
      await wrapper.get(button('admin')).trigger('click')
      await flushPromises()
      expect(navigate).not.toHaveBeenCalled()
      expect(wrapper.find('[role="alert"]').exists()).toBe(true)
    }
  )
  it.each([{ runtime: 'node' }, { enabled: false }])(
    'a disabled context invalidates a late accepted POST %#',
    async (props) => {
      const pending = deferred<{ status: number; _data: unknown }>()
      post.mockReturnValueOnce(pending.promise)
      const wrapper = await render()
      await wrapper.get(button('customer')).trigger('click')
      await wrapper.setProps(props)
      pending.resolve({ status: 200, _data: receipt() })
      await flushPromises()
      expect(refresh).not.toHaveBeenCalled()
      expect(navigate).not.toHaveBeenCalled()
      expect(wrapper.find('[data-testid="demo-login-shortcuts"]').exists()).toBe(false)
    }
  )
  it('a context changed during refresh cannot navigate from the stale completion', async () => {
    const held = deferred<undefined>()
    refresh.mockImplementationOnce(async () => {
      await held.promise
      confirm('admin')
    })
    const wrapper = await render()
    await wrapper.get(button('admin')).trigger('click')
    await flushPromises()
    await wrapper.setProps({ enabled: false })
    held.resolve(undefined)
    await flushPromises()
    expect(navigate).not.toHaveBeenCalled()
  })
  it('unmount discards a late POST without refresh or navigation', async () => {
    const pending = deferred<{ status: number; _data: unknown }>()
    post.mockReturnValueOnce(pending.promise)
    const wrapper = await render()
    await wrapper.get(button('customer')).trigger('click')
    wrapper.unmount()
    mounted.splice(mounted.indexOf(wrapper), 1)
    pending.resolve({ status: 200, _data: receipt() })
    await flushPromises()
    expect(refresh).not.toHaveBeenCalled()
    expect(navigate).not.toHaveBeenCalled()
  })
  it('mounts on the login page alongside the existing form and follows only public demo opt-in', async () => {
    const wrapper = await mountSuspended(LoginPage, {
      route: '/login',
      global: { stubs: { LoginForm: true, NuxtLink: true } }
    })
    mounted.push(wrapper)
    await flushPromises()
    expect(wrapper.findComponent(DemoLoginShortcuts).exists()).toBe(true)
    expect(wrapper.find('login-form-stub').exists()).toBe(true)
    expect(wrapper.find('[data-testid="demo-login-shortcuts"]').exists()).toBe(true)
    expect(wrapper.get('.max-w-md').classes()).toContain('pb-56')
    runtime.public.demoEnabled = false
    await flushPromises()
    expect(wrapper.find('[data-testid="demo-login-shortcuts"]').exists()).toBe(false)
    expect(wrapper.get('.max-w-md').classes()).not.toContain('pb-56')
    expect(fallback).not.toHaveBeenCalled()
    expect(post).not.toHaveBeenCalled()
  })
})

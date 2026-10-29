import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SharedCart from '../../app/pages/carrito-compartido.vue'
import { sharedCartResolveResponseSchema } from '../../shared/cart-snapshots'
import '#app/nuxt-vitest-app-entry'

// Matrix: fragment capture+immediate scrub; explicit bounded resolve/current
// public facts, never an origin-cart authority or price write; strict correlation;
// explicit copy, singleflight, partial unavailable, uncertain ADD stops remaining;
// new preview before only never-attempted continuation; scope/late/unmount purge;
// missing/invalid link, Node, no analytics/referrer/token DOM/storage.
const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  add: vi.fn(),
  session: vi.fn(),
  analytics: vi.fn(),
  runtime: vi.fn(() => ({
    app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
    public: { serverRuntime: 'cloudflare' }
  }))
}))
mockNuxtImport('useRequestFetch', () => () => mocks.request)
mockNuxtImport('useUserSession', () => mocks.session)
mockNuxtImport('useRuntimeConfig', () => mocks.runtime)
mockNuxtImport('useAnalytics', () => () => ({ track: mocks.analytics }))
const blocked = ref(false)
vi.mock('../../app/stores/cart', () => ({
  useCartStore: () => ({
    add: mocks.add,
    get pendingMutation() {
      return blocked.value
    },
    get blockedMutations() {
      return blocked.value
    }
  })
}))
const SHARE = '40000000-0000-4000-8000-000000000001',
  TOKEN = 'A'.repeat(43)
function result() {
  return sharedCartResolveResponseSchema.parse({
    source: 'cloudflare',
    id: SHARE,
    expiresAt: '2026-10-10T15:00:00Z',
    evaluatedAt: '2026-10-09T15:00:00Z',
    items: [11, 12].map((id) => ({
      variantId: `variant-${id}`,
      quantity: 2,
      available: true,
      reason: null,
      cartVariantId: id,
      name: `Producto público ${id}`,
      sku: `SKU-${id}`,
      slug: `producto-${id}`,
      format: 'Caja',
      unitLabel: 'caja',
      baseUnitGrossCents: 1210,
      unitGrossCents: 1210,
      netCents: 2000,
      taxCents: 420,
      grossCents: 2420,
      taxRateBasisPoints: 2100,
      minimumQuantity: 2,
      maximumQuantity: 10,
      quantityIncrement: 2
    }))
  })
}
let auth: {
  ready: ReturnType<typeof ref<boolean>>
  loggedIn: ReturnType<typeof ref<boolean>>
  user: ReturnType<typeof ref>
  session: ReturnType<typeof ref>
}
const wrappers: Awaited<ReturnType<typeof mountSuspended>>[] = []
async function render(fragment = `${SHARE}.${TOKEN}`) {
  window.history.replaceState(null, '', `/carrito/compartido${fragment ? `#${fragment}` : ''}`)
  const wrapper = await mountSuspended(SharedCart)
  wrappers.push(wrapper)
  await flushPromises()
  return wrapper
}
async function resolve(wrapper: Awaited<ReturnType<typeof mountSuspended>>) {
  await wrapper.get('[data-shared-resolve]').trigger('click')
  await flushPromises()
}
async function copy(wrapper: Awaited<ReturnType<typeof mountSuspended>>) {
  await wrapper.get('[data-shared-confirm]').setValue(true)
  await wrapper.get('[data-shared-copy]').trigger('click')
  await flushPromises()
}
beforeEach(() => {
  blocked.value = false
  mocks.analytics.mockReset()
  mocks.add.mockReset().mockResolvedValue(undefined)
  mocks.request.mockReset().mockResolvedValue(result())
  auth = { ready: ref(true), loggedIn: ref(false), user: ref(null), session: ref(null) }
  mocks.session.mockReturnValue(auth)
  mocks.runtime.mockReturnValue({
    app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
    public: { serverRuntime: 'cloudflare' }
  })
})
afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount()
  window.history.replaceState(null, '', '/')
  vi.restoreAllMocks()
})
describe('shared cart current public preview and explicit copy', () => {
  it('scrubs the fragment before any request, keeps capability out of DOM/storage/analytics', async () => {
    const storage = vi.spyOn(Storage.prototype, 'setItem')
    const wrapper = await render()
    expect(window.location.hash).toBe('')
    expect(wrapper.html()).not.toContain(TOKEN)
    expect(storage).not.toHaveBeenCalled()
    expect(mocks.analytics).not.toHaveBeenCalled()
    expect(mocks.request).not.toHaveBeenCalled()
    expect(mocks.add).not.toHaveBeenCalled()
  })
  it('resolves only explicitly, with capability in the body and no referrer/retry', async () => {
    const wrapper = await render()
    await resolve(wrapper)
    expect(mocks.request).toHaveBeenCalledWith(
      '/api/cart/shared/resolve',
      expect.objectContaining({
        method: 'POST',
        body: { id: SHARE, token: TOKEN },
        retry: 0,
        referrerPolicy: 'no-referrer'
      })
    )
    expect(wrapper.text()).toContain('Producto público 11')
    expect(wrapper.text()).toContain('actuales')
    expect(mocks.add).not.toHaveBeenCalled()
  })
  it.each(['', 'invalid.secret', `${SHARE}.${TOKEN}extra`])(
    'fails closed for missing or malformed fragment %s',
    async (fragment) => {
      const wrapper = await render(fragment)
      expect(window.location.hash).toBe('')
      expect(mocks.request).not.toHaveBeenCalled()
      expect(wrapper.text()).toMatch(/enlace.*(?:inválido|incompleto)/i)
      expect(mocks.add).not.toHaveBeenCalled()
    }
  )
  it('only copies confirmed current selections through cart.add; never passes source totals/authority', async () => {
    const wrapper = await render()
    await resolve(wrapper)
    expect(wrapper.get('[data-shared-copy]').attributes('disabled')).toBeDefined()
    await copy(wrapper)
    expect(mocks.add.mock.calls).toEqual([
      [{ variantId: 11 }, 2],
      [{ variantId: 12 }, 2]
    ])
    expect(mocks.request).toHaveBeenCalledTimes(1)
  })
  it('uncertain first ADD stops the batch and excludes that line from all future copies', async () => {
    mocks.add.mockImplementationOnce(async () => {
      blocked.value = true
      throw new Error('lost response')
    })
    const wrapper = await render()
    await resolve(wrapper)
    await copy(wrapper)
    expect(mocks.add.mock.calls).toEqual([[{ variantId: 11 }, 2]])
    expect(wrapper.text()).toContain('incierto')
    expect(wrapper.text()).toContain('sin intentar')
    expect(wrapper.text()).not.toContain('no se ha añadido')
    expect(mocks.request).toHaveBeenCalledTimes(1)
    blocked.value = false
    await flushPromises()
    await resolve(wrapper)
    await copy(wrapper)
    expect(mocks.add.mock.calls).toEqual([
      [{ variantId: 11 }, 2],
      [{ variantId: 12 }, 2]
    ])
  })
  it.each(['wrong-id', 'malformed', 'failed'])(
    'does not turn %s read into prices, empty success or ADD',
    async (mode) => {
      if (mode === 'failed') mocks.request.mockRejectedValue(new Error(`SQL private ${TOKEN}`))
      else
        mocks.request.mockResolvedValue(
          mode === 'wrong-id'
            ? { ...result(), id: '50000000-0000-4000-8000-000000000001' }
            : { source: 'cloudflare', items: [] }
        )
      const wrapper = await render()
      await resolve(wrapper)
      expect(wrapper.find('[data-shared-confirm]').exists()).toBe(false)
      expect(wrapper.text()).not.toContain('Producto público')
      expect(wrapper.text()).not.toContain(TOKEN)
      expect(mocks.add).not.toHaveBeenCalled()
    }
  )
  it('preserves Node without resolving a CF capability', async () => {
    mocks.runtime.mockReturnValue({
      app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
      public: { serverRuntime: 'node' }
    })
    await render()
    expect(mocks.request).not.toHaveBeenCalled()
    expect(mocks.add).not.toHaveBeenCalled()
  })
  it('identity/session change purges the public preview and frozen capability', async () => {
    const wrapper = await render()
    await resolve(wrapper)
    auth.loggedIn.value = true
    auth.user.value = {
      id: '60000000-0000-4000-8000-000000000001',
      email: 'other@example.invalid',
      emailVerified: true
    }
    auth.session.value = { sessionId: '70000000-0000-4000-8000-000000000001', sessionVersion: 1 }
    await flushPromises()
    expect(wrapper.text()).not.toContain('Producto público')
    expect(wrapper.find('[data-shared-confirm]').exists()).toBe(false)
    expect(mocks.add).not.toHaveBeenCalled()
  })
  it('keeps the anonymous fragment across initial session-ready confirmation without an actor change', async () => {
    auth.ready.value = false
    const wrapper = await render()
    expect(window.location.hash).toBe('')
    auth.ready.value = true
    await flushPromises()
    await resolve(wrapper)
    expect(mocks.request).toHaveBeenCalledWith(
      '/api/cart/shared/resolve',
      expect.objectContaining({ body: { id: SHARE, token: TOKEN } })
    )
    expect(wrapper.text()).toContain('Producto público 11')
  })
  it('does not require verified email to read the same public capability that a guest can read', async () => {
    auth.loggedIn.value = true
    auth.user.value = {
      id: '60000000-0000-4000-8000-000000000001',
      email: 'owner@example.invalid',
      emailVerified: false
    }
    auth.session.value = { sessionId: '70000000-0000-4000-8000-000000000001', sessionVersion: 1 }
    const wrapper = await render()
    await resolve(wrapper)
    expect(wrapper.text()).toContain('Producto público 11')
    expect(mocks.add).not.toHaveBeenCalled()
  })
})

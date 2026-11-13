import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useCartStore } from '../../app/stores/cart'
import '#app/nuxt-vitest-app-entry'

const { request, sessionMock, runtimeMock } = vi.hoisted(() => ({
  request: vi.fn(),
  sessionMock: vi.fn(),
  runtimeMock: vi.fn(() => ({
    app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
    public: { serverRuntime: 'cloudflare' }
  }))
}))
mockNuxtImport('$fetch', () => request)
mockNuxtImport('useUserSession', () => () => sessionMock())
mockNuxtImport('useRuntimeConfig', () => () => runtimeMock())
mockNuxtImport('useAnalytics', () => () => ({ track: vi.fn() }))

const snapshot = (version = 1, id = 'cart-synthetic') => ({
  id,
  version,
  status: 'active',
  expiresAt: '2027-01-01T00:00:00Z',
  items: [],
  count: 0,
  subtotal: 0,
  subtotalNet: 0,
  tax: 0
})
let cart: ReturnType<typeof useCartStore>
let identity: {
  loggedIn: ReturnType<typeof ref<boolean>>
  user: ReturnType<typeof ref>
  session: ReturnType<typeof ref>
}
let wrapper: Awaited<ReturnType<typeof mountSuspended>> | undefined
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}
async function setupStore() {
  const pinia = createPinia()
  setActivePinia(pinia)
  wrapper = await mountSuspended(
    defineComponent({
      setup() {
        cart = useCartStore(pinia)
        return () => h('div')
      }
    })
  )
  cart.apply(snapshot())
}
const posts = () => request.mock.calls.filter(([, options]) => options?.method === 'POST')
async function loseAdd(failure: unknown = new Error('private SQL failure')) {
  request.mockImplementation(async (path: string, options?: { method?: string }) => {
    if (options?.method === 'POST') throw failure
    if (path === '/api/cart') return snapshot(2)
    throw new Error('unexpected request')
  })
  await expect(cart.add({ variantId: 11 }, 3)).rejects.toBeDefined()
}
beforeEach(async () => {
  localStorage.clear()
  request.mockReset()
  identity = {
    loggedIn: ref(true),
    user: ref({ id: 'synthetic-owner-private' }),
    session: ref({ sessionId: 'synthetic-session-private', sessionVersion: 1 })
  }
  sessionMock.mockImplementation(() => identity)
  runtimeMock.mockReturnValue({
    app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
    public: { serverRuntime: 'cloudflare' }
  })
  await setupStore()
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('cart ADD original-intent recovery', () => {
  it.each([undefined, 500, 409, 404])(
    'retains an uncertain ADD after %s and blocks new mutations',
    async (statusCode) => {
      await loseAdd(statusCode ? { statusCode } : undefined)
      expect(cart.pendingMutation).toBe(true)
      expect(cart.canRecoverAdd).toBe(true)
      expect(cart.canRetryAdd).toBe(true)
      await expect(cart.add({ variantId: 12 }, 1)).rejects.toBeDefined()
      await expect(cart.setQty(11, 2)).rejects.toBeDefined()
      await expect(cart.remove(11)).rejects.toBeDefined()
      await expect(cart.clear()).rejects.toBeDefined()
      expect(posts()).toHaveLength(1)
      expect(cart.error).not.toContain('private SQL')
    }
  )
  it('retries only explicitly, with the exact original body even after a newer read', async () => {
    const item = { variantId: 11 }
    await loseAdd()
    const original = structuredClone(posts()[0]![1].body)
    item.variantId = 999
    cart.apply(snapshot(8))
    expect(posts()).toHaveLength(1)
    request.mockResolvedValue(snapshot(9))
    await cart.retryAdd()
    expect(posts()).toHaveLength(2)
    expect(posts()[1]![1].body).toEqual(original)
    expect(cart.pendingMutation).toBe(false)
  })
  it('singleflights the initial ADD and does not clear its guard through a concurrent read', async () => {
    const pending = deferred<ReturnType<typeof snapshot>>()
    request.mockImplementation(async (_path, options) => (options?.method === 'POST' ? pending.promise : snapshot()))
    const first = cart.add({ variantId: 11 }, 3)
    await vi.waitFor(() => expect(posts()).toHaveLength(1))
    expect(cart.pendingMutation).toBe(true)
    await expect(cart.add({ variantId: 11 }, 3)).rejects.toBeDefined()
    await cart.load({ restoreCachedItems: false })
    await expect(cart.setQty(11, 9)).rejects.toBeDefined()
    pending.resolve(snapshot(2))
    await first
    expect(posts()).toHaveLength(1)
    expect(cart.pendingMutation).toBe(false)
  })
  it.each([
    'unknown',
    'conflict',
    'unavailable',
    'unauthorized',
    'wrong-cart',
    'wrong-key',
    'invalid-version',
    'wrong-version'
  ])('keeps the original intent when receipt is %s', async (mode) => {
    await loseAdd()
    const body = posts()[0]![1].body
    request.mockImplementation(async (path) => {
      if (path === '/api/cart') return snapshot(2)
      if (mode === 'conflict') throw { statusCode: 409 }
      if (mode === 'unauthorized') throw { statusCode: 401 }
      if (mode === 'unavailable') throw new Error('private receipt storage')
      return {
        source: 'cloudflare',
        cartId: mode === 'wrong-cart' ? 'other-cart' : cart.id,
        commandId: mode === 'wrong-key' ? 'other-key' : body.idempotencyKey,
        outcome: mode === 'unknown' ? 'unknown' : 'applied',
        appliedVersion: mode === 'unknown' ? null : mode === 'invalid-version' ? 0 : mode === 'wrong-version' ? 3 : 2
      }
    })
    await cart.recoverAdd()
    expect(cart.pendingMutation).toBe(true)
    expect(cart.canRetryAdd).toBe(true)
    expect(posts()).toHaveLength(1)
    expect(cart.error).not.toContain('private receipt')
  })
  it('checks an authorized receipt then reads the current cart before releasing uncertainty', async () => {
    await loseAdd()
    const body = posts()[0]![1].body
    request.mockReset().mockImplementation(async (path, options) => {
      if (path === '/api/cart') return snapshot(7)
      expect(path).toBe(`/api/cart/operations/${encodeURIComponent(body.idempotencyKey)}`)
      expect(options.query).toEqual({ variantId: 11, quantity: 3, expectedVersion: 1 })
      return {
        source: 'cloudflare',
        cartId: cart.id,
        commandId: body.idempotencyKey,
        outcome: 'applied',
        appliedVersion: 2
      }
    })
    await cart.recoverAdd()
    expect(request.mock.calls.map(([path]) => path)).toEqual([
      `/api/cart/operations/${body.idempotencyKey}`,
      '/api/cart'
    ])
    expect(cart.version).toBe(7)
    expect(cart.pendingMutation).toBe(false)
    expect(posts()).toHaveLength(0)
  })
  it('does not resend a confirmed ADD if the subsequent current-cart read fails', async () => {
    await loseAdd()
    const body = posts()[0]![1].body
    request.mockImplementation(async (path) => {
      if (path === '/api/cart') throw new Error('read outage')
      return {
        source: 'cloudflare',
        cartId: cart.id,
        commandId: body.idempotencyKey,
        outcome: 'applied',
        appliedVersion: 2
      }
    })
    await cart.recoverAdd()
    expect(cart.pendingMutation).toBe(true)
    expect(cart.canRetryAdd).toBe(false)
    await cart.retryAdd()
    expect(posts()).toHaveLength(1)
    request.mockImplementation(async (path) => (path === '/api/cart' ? snapshot(8) : undefined))
    await cart.recoverAdd()
    expect(cart.pendingMutation).toBe(false)
  })
  it('does not clear a confirmed ADD with an older current-cart version', async () => {
    await loseAdd()
    const body = posts()[0]![1].body
    request.mockImplementation(async (path) =>
      path === '/api/cart'
        ? snapshot(1)
        : {
            source: 'cloudflare',
            cartId: cart.id,
            commandId: body.idempotencyKey,
            outcome: 'applied',
            appliedVersion: 2
          }
    )
    await cart.recoverAdd()
    expect(cart.pendingMutation).toBe(true)
    expect(cart.canRetryAdd).toBe(false)
    expect(posts()).toHaveLength(1)
  })
  it.each(['setQty', 'remove'] as const)(
    'blocks %s if an ADD begins while its initial read is pending',
    async (operation) => {
      const loading = deferred<undefined>()
      vi.spyOn(cart, 'ensureLoaded')
        .mockImplementationOnce(() => loading.promise)
        .mockResolvedValue(undefined)
      const mutation = (operation === 'setQty' ? cart.setQty(11, 2) : cart.remove(11)).catch(() => undefined)
      await flushPromises()
      const posted = deferred<ReturnType<typeof snapshot>>()
      request.mockImplementation(async (_path, options) => (options?.method === 'POST' ? posted.promise : snapshot()))
      const add = cart.add({ variantId: 12 }, 1)
      await vi.waitFor(() => expect(posts()).toHaveLength(1))
      loading.resolve(undefined)
      await mutation
      expect(request.mock.calls.some(([, options]) => options?.method === 'PUT' || options?.method === 'DELETE')).toBe(
        false
      )
      posted.resolve(snapshot(2))
      await add
    }
  )
  it.each(['owner', 'session', 'logout', 'cart', 'reset'])(
    'purges stale intent after %s and ignores its late response',
    async (mode) => {
      const pending = deferred<ReturnType<typeof snapshot>>()
      request.mockImplementation(async (_path, options) => (options?.method === 'POST' ? pending.promise : snapshot()))
      const first = cart.add({ variantId: 11 }, 3)
      await vi.waitFor(() => expect(posts()).toHaveLength(1))
      if (mode === 'owner') identity.user.value = { id: 'different-owner' }
      if (mode === 'session') identity.session.value = { sessionId: 'different-session', sessionVersion: 2 }
      if (mode === 'logout') identity.loggedIn.value = false
      if (mode === 'cart') cart.apply(snapshot(1, 'different-cart'))
      if (mode === 'reset') cart.resetLocal()
      pending.resolve(snapshot(2))
      await first.catch(() => undefined)
      expect(cart.pendingMutation).toBe(false)
      expect(cart.version).not.toBe(2)
      await cart.retryAdd()
      expect(posts()).toHaveLength(1)
    }
  )
  it('restores an uncertain intent across reload without exposing identity or posting automatically', async () => {
    await loseAdd()
    const original = structuredClone(posts()[0]![1].body)
    const journal = Object.keys(localStorage)
      .filter((key) => key !== 'neteco-cart-cache')
      .map((key) => localStorage.getItem(key))
      .join('')
    expect(journal).toContain(original.idempotencyKey)
    expect(journal).not.toContain('synthetic-owner-private')
    expect(journal).not.toContain('synthetic-session-private')
    wrapper?.unmount()
    await setupStore()
    request.mockResolvedValue(snapshot(4))
    await cart.load({ restoreCachedItems: false })
    expect(cart.pendingMutation).toBe(true)
    expect(posts()).toHaveLength(1)
    await cart.retryAdd()
    expect(posts()[1]![1].body).toEqual(original)
  })
  it('does not use the Cloudflare receipt endpoint in the Node runtime', async () => {
    runtimeMock.mockReturnValue({
      app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
      public: { serverRuntime: 'node' }
    })
    await loseAdd()
    expect(cart.canRecoverAdd).toBe(false)
    await cart.recoverAdd()
    expect(request.mock.calls.some(([path]) => path.includes('/operations/'))).toBe(false)
    expect(posts()[0]![1].headers).toBeUndefined()
  })
  it('binds both CF ADD requests to the same frozen cart header', async () => {
    await loseAdd()
    expect(posts()[0]![1].headers).toEqual({ 'X-Neteco-Cart-Id': 'cart-synthetic' })
    request.mockResolvedValue(snapshot(2))
    await cart.retryAdd()
    expect(posts()[1]![1].headers).toEqual(posts()[0]![1].headers)
    expect(posts()[1]![1].body).toEqual(posts()[0]![1].body)
  })
  it.each([400, 422])('releases a definitive precommit validation rejection %s', async (statusCode) => {
    await loseAdd({ statusCode })
    expect(cart.pendingMutation).toBe(false)
    request.mockResolvedValue(snapshot(2))
    await cart.add({ variantId: 12 }, 1)
    expect(posts()).toHaveLength(2)
    expect(posts()[1]![1].body.idempotencyKey).not.toBe(posts()[0]![1].body.idempotencyKey)
  })
  it.each([400, 422])('does not mistake replay rejection %s for an uncommitted initial ADD', async (statusCode) => {
    await loseAdd()
    const original = structuredClone(posts()[0]![1].body)
    request.mockImplementation(async (path, options) => {
      if (options?.method === 'POST') throw { statusCode }
      if (path === '/api/cart') return snapshot(2)
      return {
        source: 'cloudflare',
        cartId: cart.id,
        commandId: original.idempotencyKey,
        outcome: 'applied',
        appliedVersion: 2
      }
    })
    await cart.retryAdd().catch(() => undefined)
    expect(cart.pendingMutation).toBe(true)
    expect(posts()[1]![1].body).toEqual(original)
    await cart.recoverAdd()
    expect(cart.pendingMutation).toBe(false)
  })
  it('freezes the first call synchronously and rejects a concurrent initial ADD', async () => {
    request.mockResolvedValue(snapshot(2))
    const item = { variantId: 11 }
    const first = cart.add(item, 3)
    item.variantId = 999
    const second = cart.add({ variantId: 12 }, 7).catch(() => undefined)
    await Promise.all([first, second])
    expect(posts()).toHaveLength(1)
    expect(posts()[0]![1].body).toMatchObject({ variantId: 11, quantity: 3, expectedVersion: 1 })
  })
  it('does not POST when the cart changes before the intention finishes preparation', async () => {
    request.mockResolvedValue(snapshot(2))
    const first = cart.add({ variantId: 11 }, 3)
    cart.apply(snapshot(1, 'new-cart-before-send'))
    await first.catch(() => undefined)
    expect(posts()).toHaveLength(0)
    expect(cart.id).toBe('new-cart-before-send')
  })
  it('does not POST if journal storage fails before sending', async () => {
    const storage = localStorage
    vi.stubGlobal('localStorage', {
      getItem: storage.getItem.bind(storage),
      removeItem: storage.removeItem.bind(storage),
      setItem: () => {
        throw new Error('quota')
      }
    })
    await expect(cart.add({ variantId: 11 }, 3)).rejects.toBeDefined()
    expect(posts()).toHaveLength(0)
    expect(cart.error).toContain('No se ha podido guardar')
  })
  it.each(['setQty', 'remove', 'clear'] as const)(
    'does not %s if the previous journal cannot be read',
    async (operation) => {
      const storage = localStorage
      vi.stubGlobal('localStorage', {
        setItem: storage.setItem.bind(storage),
        removeItem: storage.removeItem.bind(storage),
        getItem: (key: string) => {
          if (key === 'neteco-cart-add-v1') throw new Error('storage blocked')
          return storage.getItem(key)
        }
      })
      request.mockResolvedValue(snapshot(2))
      await (
        operation === 'setQty' ? cart.setQty(11, 2) : operation === 'remove' ? cart.remove(11) : cart.clear()
      ).catch(() => undefined)
      expect(request).not.toHaveBeenCalled()
    }
  )
  it('does not resend to a different current cart during manual retry', async () => {
    await loseAdd()
    request.mockResolvedValue(snapshot(1, 'different-cookie-cart'))
    await cart.retryAdd().catch(() => undefined)
    expect(posts()).toHaveLength(1)
    expect(cart.pendingMutation).toBe(true)
    expect(cart.id).toBe('cart-synthetic')
  })
  it('does not send a stale retry after the identity changes during its control GET', async () => {
    await loseAdd()
    const pending = deferred<ReturnType<typeof snapshot>>()
    request.mockImplementation(async () => pending.promise)
    const retry = cart.retryAdd().catch(() => undefined)
    await flushPromises()
    identity.loggedIn.value = false
    pending.resolve(snapshot(2))
    await retry
    expect(posts()).toHaveLength(1)
    expect(cart.pendingMutation).toBe(false)
  })
  it.each(['failed-read', 'foreign-cart', 'foreign-owner', 'malformed', 'oversized'])(
    'never reimports cached items while checking a %s journal',
    async (mode) => {
      await loseAdd()
      const key = 'neteco-cart-add-v1'
      const original = JSON.parse(localStorage.getItem(key)!)
      if (mode === 'foreign-owner') original.scope = '0'.repeat(64)
      if (mode === 'foreign-cart') original.cartId = 'other-cart'
      localStorage.setItem(
        key,
        mode === 'malformed' ? '{' : mode === 'oversized' ? 'x'.repeat(2049) : JSON.stringify(original)
      )
      localStorage.setItem('neteco-cart', JSON.stringify([{ variantId: 11, qty: 3 }]))
      wrapper?.unmount()
      await setupStore()
      request.mockReset().mockImplementation(async () => {
        if (mode === 'failed-read') throw new Error('outage')
        return snapshot(3)
      })
      await cart.load()
      expect(posts()).toHaveLength(0)
      if (mode === 'failed-read') {
        expect(cart.pendingMutation).toBe(true)
        await expect(cart.add({ variantId: 99 }, 2)).rejects.toBeDefined()
        expect(posts()).toHaveLength(0)
      } else {
        expect(cart.pendingMutation).toBe(false)
        expect(localStorage.getItem(key)).toBeNull()
      }
    }
  )
})

function seedNonEmptyCart() {
  const original = {
    ...snapshot(3),
    items: [
      {
        productId: 1,
        slug: 'synthetic',
        name: 'Synthetic',
        brand: 'NETECO',
        variantId: 11,
        format: '1 L',
        sku: 'SYN-11',
        price: 100,
        netPrice: 83,
        taxRateBasisPoints: 2100,
        qty: 3,
        visual: { type: 'bottle', color: '#123456' }
      }
    ],
    count: 3,
    subtotal: 300,
    subtotalNet: 249,
    tax: 51
  }
  cart.apply(original)
  return original
}

describe('confirmed cart clearing', () => {
  it('reads the replacement cart and becomes ready without restoring cached lines or sending another mutation', async () => {
    seedNonEmptyCart()
    request.mockImplementation(async (_path, options) =>
      options?.method === 'DELETE' ? { ok: true } : snapshot(1, 'replacement-cart')
    )
    await cart.clear()
    expect(cart).toMatchObject({
      ready: true,
      loading: false,
      error: '',
      id: 'replacement-cart',
      version: 1,
      items: []
    })
    expect({ subtotal: cart.subtotal, tax: cart.tax }).toEqual({ subtotal: 0, tax: 0 })
    expect(request.mock.calls.map(([path, options]) => [path, options?.method ?? 'GET'])).toEqual([
      ['/api/cart', 'DELETE'],
      ['/api/cart', 'GET']
    ])
    expect(request.mock.calls[0]?.[1]?.query).toEqual({ expectedVersion: 3, idempotencyKey: expect.any(String) })
    expect(posts()).toEqual([])
    expect(localStorage.getItem('neteco-cart-cache')).toBe('[]')
  })
  it('exposes a replacement read failure without silently declaring an authoritative empty cart', async () => {
    seedNonEmptyCart()
    request.mockImplementation(async (_path, options) => {
      if (options?.method === 'DELETE') return { ok: true }
      throw new Error('private SQL transport detail')
    })
    await cart.clear()
    expect(cart).toMatchObject({
      ready: true,
      loading: false,
      id: null,
      items: [],
      error: 'No se ha podido sincronizar el carrito'
    })
    expect(posts()).toEqual([])
    expect(localStorage.getItem('neteco-cart-cache')).toBe('[]')
  })
  it('preserves the confirmed original cart when the clear request fails', async () => {
    const original = seedNonEmptyCart()
    request.mockRejectedValue(new Error('transport failure'))
    await expect(cart.clear()).rejects.toThrow('transport failure')
    expect(cart).toMatchObject({ ready: true, id: original.id, version: original.version, items: original.items })
    expect(request).toHaveBeenCalledTimes(1)
    expect(posts()).toEqual([])
  })
  it('does not erase another identity cart when an earlier clear completes', async () => {
    seedNonEmptyCart()
    const deletion = deferred<{ ok: boolean }>()
    request.mockReturnValue(deletion.promise)
    const clearing = cart.clear()
    await flushPromises()
    identity.user.value = { id: 'another-owner' }
    identity.session.value = { sessionId: 'another-session', sessionVersion: 1 }
    cart.apply(snapshot(7, 'another-identity-cart'))
    deletion.resolve({ ok: true })
    await clearing
    expect(cart).toMatchObject({ ready: true, id: 'another-identity-cart', version: 7 })
    expect(request).toHaveBeenCalledTimes(1)
  })
  it('discards an older pending read before reading the replacement cart', async () => {
    const original = seedNonEmptyCart()
    const oldRead = deferred<typeof original>()
    let gets = 0
    request.mockImplementation(async (_path, options) =>
      options?.method === 'DELETE' ? { ok: true } : ++gets === 1 ? oldRead.promise : snapshot(1, 'replacement-cart')
    )
    const reading = cart.load()
    await flushPromises()
    const clearing = cart.clear()
    await flushPromises()
    oldRead.resolve(original)
    await reading
    await clearing
    expect(cart).toMatchObject({ ready: true, loading: false, id: 'replacement-cart', version: 1, items: [] })
    expect(gets).toBe(2)
    expect(posts()).toEqual([])
  })
})

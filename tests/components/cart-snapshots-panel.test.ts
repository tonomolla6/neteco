import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import CartSnapshotsPanel from '../../app/components/CartSnapshotsPanel.vue'
import {
  cartSnapshotIntentHash,
  cartSnapshotResponseSchema,
  cartSnapshotRevokeIntentHash
} from '../../shared/cart-snapshots'
import '#app/nuxt-vitest-app-entry'

// Matrix: current verified customer/Node boundary; real list/error/empty states;
// explicit private save versus share, one frozen command, manual recovery;
// correlated fresh confirmation, capability clipboard only by user gesture;
// revocation/session/unmount and late response purge; cart recovery blocks writes.
const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  session: vi.fn(),
  blocked: false,
  cartId: '10000000-0000-4000-8000-000000000001',
  cartVersion: 7,
  runtime: vi.fn(() => ({
    app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
    public: { serverRuntime: 'cloudflare' }
  }))
}))
mockNuxtImport('useRequestFetch', () => () => mocks.request)
mockNuxtImport('useUserSession', () => mocks.session)
mockNuxtImport('useRuntimeConfig', () => mocks.runtime)
vi.mock('../../app/stores/cart', () => ({
  useCartStore: () => ({
    get id() {
      return mocks.cartId
    },
    get version() {
      return mocks.cartVersion
    },
    ready: true,
    loading: false,
    error: '',
    items: [{ variantId: 11, qty: 2 }],
    get pendingMutation() {
      return mocks.blocked
    },
    get blockedMutations() {
      return mocks.blocked
    }
  })
}))
const ROOT = '/api/account/cart-snapshots'
const LIST = '80000000-0000-4000-8000-000000000001'
const SHARE = '90000000-0000-4000-8000-000000000001'
async function response(options: {
  body: { name: string; expectedCartVersion: number; createShare: boolean }
  headers: Record<string, string>
}) {
  return cartSnapshotResponseSchema.parse({
    source: 'cloudflare',
    receipt: {
      commandId: options.headers['Idempotency-Key'],
      payloadHash: await cartSnapshotIntentHash(options.body),
      listId: LIST,
      shareId: options.body.createShare ? SHARE : null,
      cartVersion: 7,
      createdAt: '2026-10-09T15:00:00Z',
      expiresAt: options.body.createShare ? '2026-10-10T15:00:00Z' : null
    },
    share: options.body.createShare ? { id: SHARE, token: 'A'.repeat(43), expiresAt: '2026-10-10T15:00:00Z' } : null
  })
}
function deferred() {
  let resolve!: (value: unknown) => void
  const promise = new Promise<unknown>((yes) => {
    resolve = yes
  })
  return { resolve, promise }
}
let auth: {
  ready: ReturnType<typeof ref<boolean>>
  loggedIn: ReturnType<typeof ref<boolean>>
  user: ReturnType<typeof ref>
  session: ReturnType<typeof ref>
}
const wrappers: Awaited<ReturnType<typeof mountSuspended>>[] = []
async function render() {
  const wrapper = await mountSuspended(CartSnapshotsPanel)
  wrappers.push(wrapper)
  await flushPromises()
  return wrapper
}
const writes = () => mocks.request.mock.calls.filter(([, options]) => options?.method === 'POST')
beforeEach(() => {
  mocks.blocked = false
  mocks.cartId = '10000000-0000-4000-8000-000000000001'
  mocks.cartVersion = 7
  auth = {
    ready: ref(true),
    loggedIn: ref(true),
    user: ref({ id: '20000000-0000-4000-8000-000000000001', email: 'owner@example.invalid', emailVerified: true }),
    session: ref({ sessionId: '30000000-0000-4000-8000-000000000001', sessionVersion: 1 })
  }
  mocks.session.mockReturnValue(auth)
  mocks.runtime.mockReturnValue({
    app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
    public: { serverRuntime: 'cloudflare' }
  })
  mocks.request.mockReset().mockResolvedValue({ source: 'cloudflare', items: [] })
})
afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount()
  vi.restoreAllMocks()
})
describe('customer cart snapshots', () => {
  it('reads the current private list and distinguishes confirmed empty from failure', async () => {
    const wrapper = await render()
    expect(mocks.request).toHaveBeenCalledWith(ROOT, expect.objectContaining({ retry: 0 }))
    expect(wrapper.text()).toContain('Todavía no has guardado ningún carrito')
    expect(writes()).toHaveLength(0)
  })
  it('failed reads expose an explicit GET retry, never a false empty list', async () => {
    mocks.request.mockRejectedValue(new Error('private SQL failure'))
    const wrapper = await render()
    expect(wrapper.text()).not.toContain('Todavía no has guardado ningún carrito')
    expect(wrapper.text()).not.toContain('private SQL')
    await wrapper.get('[data-snapshot-refresh]').trigger('click')
    await flushPromises()
    expect(mocks.request).toHaveBeenCalledTimes(2)
    expect(writes()).toHaveLength(0)
  })
  it.each([false, true])(
    'explicit save sends createShare=%s and current version, not client items/prices',
    async (share) => {
      const wrapper = await render()
      await wrapper.get('[data-snapshot-name]').setValue('Reposición semanal')
      mocks.request.mockRejectedValue(new Error('response lost'))
      await wrapper.get(share ? '[data-snapshot-share]' : '[data-snapshot-save]').trigger('click')
      await vi.waitFor(() => expect(writes()).toHaveLength(1))
      await vi.waitFor(() => expect(wrapper.text()).toContain('incierto'))
      const [path, options] = writes()[0]!
      expect(path).toBe(ROOT)
      expect(options.body).toEqual({ name: 'Reposición semanal', expectedCartVersion: 7, createShare: share })
      expect(options.retry).toBe(0)
      expect(options.headers['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/)
      expect(options.headers['X-Neteco-Cart-Id']).toBe(mocks.cartId)
      expect(wrapper.text()).toContain('incierto')
      expect(wrapper.find('[data-snapshot-check]').exists()).toBe(true)
      expect(writes()).toHaveLength(1)
    }
  )
  it('does not read or offer saving to a guest, or an unverified customer', async () => {
    auth.user.value.emailVerified = false
    const wrapper = await render()
    expect(mocks.request).not.toHaveBeenCalled()
    expect(wrapper.find('[data-snapshot-save]').exists()).toBe(false)
  })
  it('preserves Node by never calling the Cloudflare snapshot API', async () => {
    mocks.runtime.mockReturnValue({
      app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
      public: { serverRuntime: 'node' }
    })
    await render()
    expect(mocks.request).not.toHaveBeenCalled()
  })
  it('blocks saving while the cart owns an unresolved ADD', async () => {
    mocks.blocked = true
    const wrapper = await render()
    if (wrapper.find('[data-snapshot-save]').exists())
      expect(wrapper.get('[data-snapshot-save]').attributes()).toHaveProperty('disabled')
    expect(writes()).toHaveLength(0)
  })
  it('session-version revocation purges the name and old recovery controls', async () => {
    const wrapper = await render()
    await wrapper.get('[data-snapshot-name]').setValue('Private operator draft')
    auth.session.value.sessionVersion++
    await flushPromises()
    expect(wrapper.html()).not.toContain('Private operator draft')
    expect(wrapper.find('[data-snapshot-check]').exists()).toBe(false)
    expect(writes()).toHaveLength(0)
  })
  it('confirms saving only after the matching receipt and a fresh list includes that command', async () => {
    const wrapper = await render()
    let saved: Awaited<ReturnType<typeof response>> | undefined
    mocks.request.mockImplementation(async (_path, options) => {
      if (options?.method === 'POST') {
        saved = await response(options)
        return saved
      }
      return { source: 'cloudflare', items: saved ? [{ receipt: saved.receipt, revoked: false }] : [] }
    })
    await wrapper.get('[data-snapshot-name]').setValue('Compra habitual')
    await wrapper.get('[data-snapshot-save]').trigger('click')
    await vi.waitFor(() => expect(wrapper.text()).toContain('Lista guardada y confirmada'))
    expect(writes()).toHaveLength(1)
    expect(mocks.request.mock.calls.filter(([, options]) => options?.method !== 'POST')).toHaveLength(2)
  })
  it('matching ACK plus failed fresh GET retains recovery instead of announcing success', async () => {
    const wrapper = await render()
    mocks.request.mockImplementation(async (_path, options) => {
      if (options?.method === 'POST') return response(options)
      throw new Error('read outage')
    })
    await wrapper.get('[data-snapshot-name]').setValue('Compra habitual')
    await wrapper.get('[data-snapshot-save]').trigger('click')
    await vi.waitFor(() => expect(wrapper.find('[data-snapshot-check]').exists()).toBe(true))
    expect(wrapper.text()).not.toContain('Lista guardada y confirmada')
    expect(writes()).toHaveLength(1)
  })
  it('doubleclick and an unknown manual receipt never generate another POST/key', async () => {
    const wrapper = await render()
    const pending = deferred()
    mocks.request.mockImplementation((_path, options) =>
      options?.method === 'POST'
        ? pending.promise
        : Promise.resolve({ source: 'cloudflare', outcome: 'unknown', receipt: null, share: null })
    )
    await wrapper.get('[data-snapshot-name]').setValue('Compra habitual')
    await wrapper.get('[data-snapshot-save]').trigger('click')
    await wrapper.get('[data-snapshot-save]').trigger('click')
    await vi.waitFor(() => expect(writes()).toHaveLength(1))
    const original = writes()[0]![1]
    pending.resolve({ source: 'invalid' })
    await vi.waitFor(() => expect(wrapper.text()).toContain('incierto'))
    await wrapper.get('[data-snapshot-check]').trigger('click')
    await flushPromises()
    expect(mocks.request).toHaveBeenCalledWith(
      `${ROOT}/commands/${original.headers['Idempotency-Key']}`,
      expect.objectContaining({
        retry: 0,
        headers: {
          'X-Neteco-Command-Payload-Hash': await cartSnapshotIntentHash(original.body),
          'X-Neteco-Cart-Id': mocks.cartId
        }
      })
    )
    expect(wrapper.text()).toContain('incierto')
    expect(writes()).toHaveLength(1)
  })
  it('late private list after email revocation cannot reveal links or enable save', async () => {
    const pending = deferred()
    mocks.request.mockReturnValue(pending.promise)
    const wrapper = await render()
    auth.user.value.emailVerified = false
    pending.resolve({
      source: 'cloudflare',
      items: [
        {
          receipt: {
            commandId: LIST,
            payloadHash: 'a'.repeat(64),
            listId: LIST,
            shareId: SHARE,
            cartVersion: 7,
            createdAt: '2026-10-09T15:00:00Z',
            expiresAt: '2026-10-10T15:00:00Z'
          },
          revoked: false
        }
      ]
    })
    await flushPromises()
    expect(wrapper.html()).not.toContain(SHARE)
    expect(wrapper.find('[data-snapshot-save]').exists()).toBe(false)
  })
  it('a server 401 purges the private draft and prevents automatic read/write retry', async () => {
    const wrapper = await render()
    await wrapper.get('[data-snapshot-name]').setValue('Private operator draft')
    mocks.request.mockRejectedValue({ statusCode: 401 })
    await wrapper.get('[data-snapshot-save]').trigger('click')
    await vi.waitFor(() => expect(writes()).toHaveLength(1))
    await flushPromises()
    expect(wrapper.html()).not.toContain('Private operator draft')
    expect(wrapper.find('[data-snapshot-check]').exists()).toBe(false)
    expect(writes()).toHaveLength(1)
  })
  it('revokes only by explicit action, with empty body/key, and confirms by fresh list', async () => {
    const receipt = {
      commandId: LIST,
      payloadHash: 'a'.repeat(64),
      listId: LIST,
      shareId: SHARE,
      cartVersion: 7,
      createdAt: '2026-10-09T15:00:00Z',
      expiresAt: '2026-10-10T15:00:00Z'
    }
    let revoked = false
    mocks.request.mockImplementation(async (_path, options) => {
      if (options?.method === 'POST') {
        revoked = true
        return {
          source: 'cloudflare',
          commandId: options.headers['Idempotency-Key'],
          payloadHash: await cartSnapshotRevokeIntentHash(SHARE, {}),
          shareId: SHARE,
          revoked: true,
          revokedAt: '2026-10-09T16:00:00Z'
        }
      }
      return { source: 'cloudflare', items: [{ receipt, revoked }] }
    })
    const wrapper = await render()
    expect(writes()).toHaveLength(0)
    await wrapper.get(`[data-snapshot-revoke="${SHARE}"]`).trigger('click')
    await vi.waitFor(() => expect(wrapper.text()).toContain('Enlace revocado y confirmado'))
    expect(writes()).toHaveLength(1)
    expect(writes()[0]![0]).toBe(`${ROOT}/${SHARE}/revoke`)
    expect(writes()[0]![1].body).toEqual({})
    expect(writes()[0]![1].retry).toBe(0)
  })
  it('does not put a newly created capability in the DOM and copies only after explicit click', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    try {
      const wrapper = await render()
      let saved: Awaited<ReturnType<typeof response>> | undefined
      mocks.request.mockImplementation(async (_path, options) => {
        if (options?.method === 'POST') {
          saved = await response(options)
          return saved
        }
        return { source: 'cloudflare', items: saved ? [{ receipt: saved.receipt, revoked: false }] : [] }
      })
      await wrapper.get('[data-snapshot-name]').setValue('Compartir compra')
      await wrapper.get('[data-snapshot-share]').trigger('click')
      await vi.waitFor(() => expect(wrapper.find('[data-snapshot-copy]').exists()).toBe(true))
      expect(writeText).not.toHaveBeenCalled()
      expect(wrapper.html()).not.toContain('A'.repeat(43))
      await wrapper.get('[data-snapshot-copy]').trigger('click')
      expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/carrito/compartido#${SHARE}.${'A'.repeat(43)}`)
    } finally {
      if (original) Object.defineProperty(navigator, 'clipboard', original)
      else Reflect.deleteProperty(navigator, 'clipboard')
    }
  })
  it.each(['deleted', 'revoked'] as const)(
    'confirms the historical command without restoring a %s list/link',
    async (state) => {
      const wrapper = await render()
      let original: Awaited<ReturnType<typeof response>> | undefined
      mocks.request.mockImplementation(async (path, options) => {
        if (options?.method === 'POST') {
          original = await response(options)
          throw new Error('committed response lost')
        }
        if (path.includes('/commands/'))
          return {
            source: 'cloudflare',
            action: 'create',
            outcome: 'applied',
            receipt: original!.receipt,
            share: original!.share
          }
        return {
          source: 'cloudflare',
          items: state === 'deleted' ? [] : [{ receipt: original!.receipt, revoked: true }]
        }
      })
      await wrapper.get('[data-snapshot-name]').setValue('Historique de commande')
      await wrapper.get('[data-snapshot-share]').trigger('click')
      await vi.waitFor(() => expect(wrapper.text()).toContain('incierto'))
      await wrapper.get('[data-snapshot-check]').trigger('click')
      await vi.waitFor(() =>
        expect(wrapper.text()).toContain(
          state === 'deleted'
            ? 'La operación original está confirmada; la lista se eliminó después. No se ha vuelto a crear.'
            : 'La operación original está confirmada; el enlace fue revocado. No se ha vuelto a activar.'
        )
      )
      expect(wrapper.find('[data-snapshot-check]').exists()).toBe(false)
      expect(wrapper.find('[data-snapshot-copy]').exists()).toBe(false)
      expect(wrapper.text()).not.toContain('Lista guardada y confirmada')
      expect(writes()).toHaveLength(1)
    }
  )
  it('never saves a replacement cart that appears while the original intent hash is pending', async () => {
    mocks.cartVersion = 2
    const wrapper = await render()
    const pending = deferred()
    const digest = crypto.subtle.digest.bind(crypto.subtle)
    vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce(() => pending.promise as Promise<ArrayBuffer>)
    await wrapper.get('[data-snapshot-name]').setValue('Original cart A')
    await wrapper.get('[data-snapshot-save]').trigger('click')
    mocks.cartId = '10000000-0000-4000-8000-000000000002'
    pending.resolve(await digest('SHA-256', new TextEncoder().encode('controlled hash result')))
    await flushPromises()
    expect(writes()).toHaveLength(0)
    expect(wrapper.find('[data-snapshot-check]').exists()).toBe(false)
    expect(wrapper.find('[data-snapshot-copy]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('Lista guardada y confirmada')
  })
})

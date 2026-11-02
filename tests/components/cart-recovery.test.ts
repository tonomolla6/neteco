import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { ref } from 'vue'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import Panel from '../../app/components/CartRecoveryPanel.vue'
import Page from '../../app/pages/cuenta/recuperar-carrito.vue'
import {
  CART_RECOVERY_POLICY_VERSION as POLICY,
  CART_RECOVERY_NOTICE_TEXT as NOTICE,
  cartRecoveryIntentHash
} from '../../shared/cart-recovery'
import '#app/nuxt-vitest-app-entry'

const mocks = vi.hoisted(() => ({ request: vi.fn(), auth: { value: null as unknown } }))
mockNuxtImport('useRequestFetch', () => () => mocks.request)
mockNuxtImport('useUserSession', () => () => mocks.auth.value)
mockNuxtImport('useRuntimeConfig', () => () => ({
  app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
  public: { serverRuntime: 'cloudflare' }
}))
const id = '10000000-0000-4000-8000-000000000090',
  cartId = '20000000-0000-4000-8000-000000000090',
  token = 'cr1.' + 'a'.repeat(64),
  now = '2030-01-02T00:00:00Z'
type Options = { method?: string; body?: Record<string, unknown>; headers?: Record<string, string> }
let auth: ReturnType<typeof session>,
  preference = {
    source: 'cloudflare',
    version: 0,
    recoveryEnabled: false,
    policyVersion: POLICY,
    noticeText: NOTICE,
    updatedAt: null as string | null
  }
const mounted: Array<{ unmount: () => void }> = []
function session() {
  return {
    ready: ref(true),
    loggedIn: ref(true),
    user: ref({ id: '10000000-0000-4000-8000-000000000050', emailVerified: true }),
    session: ref({ sessionId: '20000000-0000-4000-8000-000000000050', sessionVersion: 1 })
  }
}
const resolved = {
  source: 'cloudflare',
  associationId: id,
  cartId,
  stage: 'cart',
  cartVersion: 2,
  expiresAt: '2030-01-03T00:00:00Z',
  lines: [
    {
      variantId: 11,
      quantity: 2,
      name: 'Producto publicado',
      sku: 'SKU-11',
      unitGrossCents: 500,
      netCents: 826,
      taxCents: 174,
      grossCents: 1000
    }
  ],
  inventoryEffect: 'none',
  economicEffect: 'none',
  evaluatedAt: now
}
const writes = () =>
  mocks.request.mock.calls.filter(
    ([path, options]) => ['POST', 'PUT'].includes(options?.method) && !String(path).endsWith('/resolve')
  )
beforeEach(() => {
  auth = session()
  mocks.auth.value = auth
  preference = {
    source: 'cloudflare',
    version: 0,
    recoveryEnabled: false,
    policyVersion: POLICY,
    noticeText: NOTICE,
    updatedAt: null
  }
  window.history.replaceState({}, '', '/cuenta/recuperar-carrito')
  mocks.request.mockReset().mockImplementation(async (path: string, options: Options = {}) => {
    if (path.endsWith('/resolve')) return resolved
    if (path === '/api/cart')
      return {
        id: cartId,
        version: 3,
        status: 'active',
        items: [{ variantId: 11, qty: 2 }],
        expiresAt: resolved.expiresAt
      }
    if (options.method === 'PUT' || options.method === 'POST') {
      const action = path.endsWith('/preferences')
        ? 'preferences'
        : path.endsWith('/associations')
          ? 'associate'
          : 'resume'
      if (action === 'preferences')
        preference = {
          ...preference,
          version: 1,
          recoveryEnabled: options.body!.recoveryEnabled as boolean,
          updatedAt: now
        }
      return {
        source: 'cloudflare',
        commandId: options.headers!['Idempotency-Key'],
        action,
        payloadHash: await cartRecoveryIntentHash(action, options.body),
        version: action === 'resume' ? 3 : 1,
        associationId: action === 'preferences' ? null : id,
        cartVersion: action === 'preferences' ? null : action === 'resume' ? 3 : 2,
        recoveryEnabled: true,
        recordedAt: now,
        inventoryEffect: 'none',
        economicEffect: 'none'
      }
    }
    if (path.includes('/commands/')) return { source: 'cloudflare', outcome: 'unknown', receipt: null }
    return preference
  })
})
afterEach(() => {
  mounted.splice(0).forEach((w) => w.unmount())
  window.history.replaceState({}, '', '/')
  vi.restoreAllMocks()
})
async function render(props = {}) {
  const w = await mountSuspended(Panel, {
    props: { scopeKey: 'current-owner', enabled: true, pending: false, ...props }
  })
  mounted.push(w)
  await flushPromises()
  return w
}
async function load(w: Awaited<ReturnType<typeof render>>) {
  await w.get('[data-recovery-load]').trigger('click')
  await flushPromises()
}
async function review(w: Awaited<ReturnType<typeof render>>) {
  await w.get('[data-recovery-consent]').setValue(true)
  await w.get('[data-recovery-review-preferences]').trigger('click')
  await vi.waitFor(() => expect(w.find('[data-recovery-confirm]').exists()).toBe(true))
}
it('keeps disabled, external-pending and unauthenticated panels free of private requests and writes', async () => {
  await render({ enabled: false })
  await render({ pending: true })
  auth.loggedIn.value = false
  await render()
  expect(mocks.request).not.toHaveBeenCalled()
  expect(document.cookie).not.toContain(token)
})
it('loads the dedicated false default explicitly, separate from newsletter and global communications', async () => {
  const w = await render()
  expect(mocks.request).not.toHaveBeenCalled()
  await load(w)
  expect(w.get('[data-recovery-consent]').element).toHaveProperty('checked', false)
  expect(w.text()).toContain(NOTICE)
  expect(w.find('a[href="/cuenta/comunicaciones"]').exists()).toBe(true)
})
it('reviews frozen consent before a single PUT and proves the receipt with fresh preferences', async () => {
  const w = await render()
  await load(w)
  await review(w)
  expect(writes()).toHaveLength(0)
  await w.get('[data-recovery-confirm]').trigger('click')
  await vi.waitFor(() => expect(w.emitted('confirmed')).toHaveLength(1))
  const [, request] = mocks.request.mock.calls.find(([, o]) => o?.method === 'PUT')!
  expect(request.body).toEqual({ expectedVersion: 0, recoveryEnabled: true, policyVersion: POLICY })
  expect(writes()).toHaveLength(1)
  expect(mocks.request.mock.calls.filter(([p]) => p.endsWith('/preferences'))).toHaveLength(3)
})
it('keeps an ambiguous command frozen and only checks its exact receipt manually, never auto-resending', async () => {
  const original = mocks.request.getMockImplementation()!
  mocks.request.mockImplementation(async (path: string, options: Options = {}) => {
    if (options.method === 'PUT') throw new Error('synthetic_transport_loss')
    return original(path, options)
  })
  const w = await render()
  await load(w)
  await review(w)
  await w.get('[data-recovery-confirm]').trigger('click')
  await flushPromises()
  await w.get('[data-recovery-check]').trigger('click')
  await flushPromises()
  expect(writes()).toHaveLength(1)
  expect(
    mocks.request.mock.calls.find(([p]) => p.includes('/commands/'))?.[1]?.headers?.['X-Neteco-Command-Payload-Hash']
  ).toMatch(/^[a-f0-9]{64}$/)
  expect(w.emitted('confirmed')).toBeUndefined()
})
it('associates only the reviewed cart version and possession header, with no browser prices or token body', async () => {
  preference = { ...preference, version: 1, recoveryEnabled: true, updatedAt: now }
  const w = await render({ cartId, cartVersion: 2, stage: 'checkout' })
  await load(w)
  await w.get('[data-recovery-review-association]').trigger('click')
  await vi.waitFor(() => expect(w.find('[data-recovery-confirm]').exists()).toBe(true))
  await w.get('[data-recovery-confirm]').trigger('click')
  await flushPromises()
  const [, request] = mocks.request.mock.calls.find(([p]) => p.endsWith('/associations'))!
  expect(request.headers['X-Neteco-Cart-Id']).toBe(cartId)
  expect(request.body).toEqual({ expectedCartVersion: 2, stage: 'checkout', policyVersion: POLICY })
})
it('resolves only on explicit review and resumes once after current server prices, then proves the current cart', async () => {
  const w = await render({ recovery: { id, token } })
  expect(mocks.request).not.toHaveBeenCalled()
  await w.get('[data-recovery-resolve]').trigger('click')
  await flushPromises()
  expect(w.text()).toContain('Producto publicado')
  expect(mocks.request.mock.calls.filter(([p]) => p.endsWith('/resume'))).toHaveLength(0)
  await w.get('[data-recovery-review-resume]').trigger('click')
  await vi.waitFor(() => expect(w.find('[data-recovery-confirm]').exists()).toBe(true))
  await w.get('[data-recovery-confirm]').trigger('click')
  await vi.waitFor(() => expect(w.emitted('confirmed')).toHaveLength(1))
  const [, request] = mocks.request.mock.calls.find(([p]) => p.endsWith('/resume'))!
  expect(request.body).toEqual({ id, token, expectedCartVersion: 2 })
  expect(mocks.request.mock.calls.some(([p]) => p === '/api/cart')).toBe(true)
  expect(w.html()).not.toContain(token)
})
it('purges private results and frozen credentials on owner changes before any stale confirmation', async () => {
  const w = await render({ recovery: { id, token } })
  await w.get('[data-recovery-resolve]').trigger('click')
  await flushPromises()
  expect(w.text()).toContain('Producto publicado')
  await w.setProps({ scopeKey: 'other-owner', enabled: false })
  expect(w.text()).not.toContain('Producto publicado')
  expect(w.find('[data-recovery-confirm]').exists()).toBe(false)
  expect(mocks.request.mock.calls.filter(([p]) => p.endsWith('/resume'))).toHaveLength(0)
})
it('does not confirm resume against a different cart even with the same version and exact quantities', async () => {
  const original = mocks.request.getMockImplementation()!
  mocks.request.mockImplementation(async (path: string, options: Options = {}) => {
    const response = await original(path, options)
    return path === '/api/cart' ? { ...response, id: '30000000-0000-4000-8000-000000000090' } : response
  })
  const w = await render({ recovery: { id, token } })
  await w.get('[data-recovery-resolve]').trigger('click')
  await flushPromises()
  expect(w.text()).toContain('Producto publicado')
  await w.get('[data-recovery-review-resume]').trigger('click')
  await vi.waitFor(() => expect(w.find('[data-recovery-confirm]').exists()).toBe(true))
  await w.get('[data-recovery-confirm]').trigger('click')
  // The receipt projection is verified against the live cart after real async hashing.
  await vi.waitFor(() => expect(mocks.request.mock.calls.some(([path]) => path === '/api/cart')).toBe(true))
  await flushPromises()
  expect(w.emitted('confirmed')).toBeUndefined()
  expect(w.find('[data-recovery-check]').exists()).toBe(true)
})
it('scrubs an anonymous fragment without sending or transferring its secret through a login redirect', async () => {
  auth.loggedIn.value = false
  window.history.replaceState({}, '', '/cuenta/recuperar-carrito#id=' + id + '&token=' + token)
  const w = await mountSuspended(Page)
  mounted.push(w)
  await flushPromises()
  expect(window.location.hash).toBe('')
  expect(mocks.request).not.toHaveBeenCalled()
  expect(w.get('a[href="/login?redirect=%2Fcuenta%2Frecuperar-carrito"]').exists()).toBe(true)
  expect(w.html()).not.toContain(token)
  expect(w.text()).toMatch(/reabre/i)
})
it('scrubs and accepts a second same-document recovery fragment without remounting or automatically resolving it', async () => {
  const secondId = '30000000-0000-4000-8000-000000000090',
    secondToken = 'cr1.' + 'b'.repeat(64)
  window.history.replaceState({}, '', '/cuenta/recuperar-carrito#id=' + id + '&token=' + token)
  const w = await mountSuspended(Page)
  mounted.push(w)
  await flushPromises()
  expect(window.location.hash).toBe('')
  expect(mocks.request).not.toHaveBeenCalled()
  window.history.replaceState({}, '', '/cuenta/recuperar-carrito#id=' + secondId + '&token=' + secondToken)
  window.dispatchEvent(new HashChangeEvent('hashchange'))
  expect(window.location.hash, 'same-document navigation must scrub the new secret immediately').toBe('')
  await flushPromises()
  expect(mocks.request).not.toHaveBeenCalled()
  const original = mocks.request.getMockImplementation()!
  mocks.request.mockImplementation(async (path: string, options: Options = {}) =>
    path.endsWith('/resolve') ? { ...resolved, associationId: secondId } : original(path, options)
  )
  await w.get('[data-recovery-resolve]').trigger('click')
  await flushPromises()
  const resolves = mocks.request.mock.calls.filter(([path]) => path.endsWith('/resolve'))
  expect(resolves).toHaveLength(1)
  expect(resolves[0]![1].body).toEqual({ id: secondId, token: secondToken })
  expect(writes()).toHaveLength(0)
  expect(w.text()).toContain('Producto publicado')
  expect(w.html()).not.toContain(secondToken)
  auth.session.value = { ...auth.session.value, sessionId: '30000000-0000-4000-8000-000000000050' }
  await flushPromises()
  expect(w.find('[data-recovery-resolve]').exists()).toBe(false)
  expect(w.text()).not.toContain('Producto publicado')
})
it('scrubs a new fragment while an ambiguous resume stays bound to its original reviewed command', async () => {
  const original = mocks.request.getMockImplementation()!
  mocks.request.mockImplementation(async (path: string, options: Options = {}) => {
    if (path.endsWith('/resume')) throw new Error('synthetic_transport_loss')
    return original(path, options)
  })
  window.history.replaceState({}, '', '/cuenta/recuperar-carrito#id=' + id + '&token=' + token)
  const w = await mountSuspended(Page)
  mounted.push(w)
  await flushPromises()
  await w.get('[data-recovery-resolve]').trigger('click')
  await flushPromises()
  await w.get('[data-recovery-review-resume]').trigger('click')
  await vi.waitFor(() => expect(w.find('[data-recovery-confirm]').exists()).toBe(true))
  await w.get('[data-recovery-confirm]').trigger('click')
  await vi.waitFor(() => expect(w.find('[data-recovery-check]').exists()).toBe(true))
  const sent = mocks.request.mock.calls.find(([path]) => path.endsWith('/resume'))![1]
  window.history.replaceState({}, '', '/cuenta/recuperar-carrito#id=' + id + '&token=cr1.' + 'b'.repeat(64))
  window.dispatchEvent(new HashChangeEvent('hashchange'))
  expect(window.location.hash).toBe('')
  await flushPromises()
  expect(w.find('[data-recovery-check]').exists()).toBe(true)
  expect(writes()).toHaveLength(1)
  await w.get('[data-recovery-check]').trigger('click')
  await vi.waitFor(() => expect(mocks.request.mock.calls.some(([path]) => path.includes('/commands/'))).toBe(true))
  expect(mocks.request.mock.calls.find(([path]) => path.includes('/commands/'))?.[0]).toContain(
    sent.headers['Idempotency-Key']
  )
  expect(
    mocks.request.mock.calls.find(([path]) => path.includes('/commands/'))?.[1].headers['X-Neteco-Command-Payload-Hash']
  ).toBe(await cartRecoveryIntentHash('resume', sent.body))
  expect(writes()).toHaveLength(1)
})
it('scrubs later anonymous fragments without retaining them and removes its hash listener on unmount', async () => {
  auth.loggedIn.value = false
  const w = await mountSuspended(Page)
  mounted.push(w)
  window.history.replaceState({}, '', '/cuenta/recuperar-carrito#id=' + id + '&token=' + token)
  window.dispatchEvent(new HashChangeEvent('hashchange'))
  expect(window.location.hash).toBe('')
  await flushPromises()
  auth.loggedIn.value = true
  await flushPromises()
  expect(w.find('[data-recovery-resolve]').exists()).toBe(false)
  expect(mocks.request).not.toHaveBeenCalled()
  w.unmount()
  mounted.pop()
  window.history.replaceState({}, '', '/cuenta/recuperar-carrito#id=' + id + '&token=' + token)
  window.dispatchEvent(new HashChangeEvent('hashchange'))
  expect(window.location.hash).toContain(token)
  expect(mocks.request).not.toHaveBeenCalled()
})
it('keeps integrated page resume confirmation after clearing the capability, then purges it on owner change', async () => {
  window.history.replaceState({}, '', '/cuenta/recuperar-carrito#id=' + id + '&token=' + token)
  const w = await mountSuspended(Page)
  mounted.push(w)
  await flushPromises()
  expect(window.location.hash).toBe('')
  expect(mocks.request).not.toHaveBeenCalled()
  await w.get('[data-recovery-resolve]').trigger('click')
  await flushPromises()
  expect(w.text()).toContain('Producto publicado')
  await w.get('[data-recovery-review-resume]').trigger('click')
  await vi.waitFor(() => expect(w.find('[data-recovery-confirm]').exists()).toBe(true))
  await w.get('[data-recovery-confirm]').trigger('click')
  await vi.waitFor(() => expect(mocks.request.mock.calls.some(([path]) => path === '/api/cart')).toBe(true))
  await flushPromises()
  const confirmation = 'El carrito se ha retomado y comprobado. Revisa el envío antes de realizar un pedido.'
  expect(w.text()).toContain(confirmation)
  expect(w.find('[data-recovery-resolve]').exists()).toBe(false)
  expect(w.html()).not.toContain(token)
  expect(window.location.href).not.toContain(token)
  expect(mocks.request.mock.calls.filter(([path]) => path.endsWith('/resume'))).toHaveLength(1)
  auth.session.value = { ...auth.session.value, sessionId: '30000000-0000-4000-8000-000000000050' }
  await flushPromises()
  expect(w.text()).not.toContain(confirmation)
  expect(w.text()).not.toContain('Producto publicado')
  expect(w.find('[data-recovery-confirm]').exists()).toBe(false)
  expect(w.html()).not.toContain(token)
  expect(mocks.request.mock.calls.filter(([path]) => path.endsWith('/resume'))).toHaveLength(1)
})
it('does not claim a resumed cart when the integrated page confirms only a preference', async () => {
  window.history.replaceState({}, '', '/cuenta/recuperar-carrito#id=' + id + '&token=' + token)
  const w = await mountSuspended(Page)
  mounted.push(w)
  await flushPromises()
  await w.get('[data-recovery-load]').trigger('click')
  await flushPromises()
  await w.get('[data-recovery-consent]').setValue(true)
  await w.get('[data-recovery-review-preferences]').trigger('click')
  await vi.waitFor(() => expect(w.find('[data-recovery-confirm]').exists()).toBe(true))
  await w.get('[data-recovery-confirm]').trigger('click')
  await vi.waitFor(() => expect(w.text()).toContain('La operación está confirmada.'))
  await flushPromises()
  expect(w.text()).not.toContain('El carrito se ha retomado y comprobado.')
  expect(mocks.request.mock.calls.filter(([path]) => path.endsWith('/resume'))).toHaveLength(0)
  expect(w.html()).not.toContain(token)
  expect(window.location.hash).toBe('')
  auth.session.value = { ...auth.session.value, sessionId: '30000000-0000-4000-8000-000000000050' }
  await flushPromises()
  expect(w.text()).not.toContain('La operación está confirmada.')
})

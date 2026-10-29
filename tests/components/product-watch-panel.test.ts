import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { ref } from 'vue'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import Panel from '../../app/components/ProductWatchPanel.vue'
import {
  PRODUCT_WATCH_POLICY_VERSION as POLICY,
  PRODUCT_WATCH_NOTICE_TEXT as TEXT,
  productWatchIntentHash
} from '../../shared/product-watch'
import '#app/nuxt-vitest-app-entry'
const mocks = vi.hoisted(() => ({ request: vi.fn(), auth: { value: null as unknown } }))
mockNuxtImport('useRequestFetch', () => () => mocks.request)
mockNuxtImport('useUserSession', () => () => mocks.auth.value)
const id = '10000000-0000-4000-8000-000000000087',
  now = '2030-01-02T00:00:00Z'
const item = {
  id,
  variantId: 11,
  kind: 'price_drop',
  status: 'pending',
  version: 1,
  createdAt: now,
  confirmationExpiresAt: '2030-01-04T00:00:00Z',
  confirmedAt: null,
  cancelledAt: null,
  baselineGrossCents: null,
  suppressedByPreferences: true,
  notifications: 0
}
type RequestOptions = { method?: string; body?: Record<string, unknown>; headers?: Record<string, string> }
let auth: ReturnType<typeof session>,
  current = { ...item }
function session() {
  return {
    ready: ref(true),
    loggedIn: ref(true),
    user: ref({ id: '10000000-0000-4000-8000-000000000050', emailVerified: true }),
    session: ref({ sessionId: '20000000-0000-4000-8000-000000000050', sessionVersion: 1 })
  }
}
function list() {
  return {
    source: 'cloudflare',
    page: 1,
    perPage: 25,
    total: 1,
    items: [current],
    policyVersion: POLICY,
    noticeText: TEXT,
    evaluatedAt: now
  }
}
async function receipt(path: string, options: RequestOptions) {
  const action = path.endsWith('/cancel') ? 'cancel' : 'create',
    target = action === 'cancel' ? id : null
  return {
    source: 'cloudflare',
    commandId: options.headers!['Idempotency-Key'],
    action,
    watchId: id,
    payloadHash: await productWatchIntentHash(action, target, options.body),
    version: action === 'cancel' ? 2 : 1,
    status: action === 'cancel' ? 'cancelled' : 'pending',
    recordedAt: now,
    inventoryEffect: 'none',
    economicEffect: 'none'
  }
}
const mounted: Array<{ unmount: () => void }> = []
beforeEach(() => {
  auth = session()
  mocks.auth.value = auth
  current = { ...item }
  mocks.request.mockReset().mockImplementation(async (path: string, options: RequestOptions = {}) => {
    if (options.method === 'POST') {
      const r = await receipt(path, options)
      if (r.action === 'cancel')
        current = { ...current, status: 'cancelled', version: 2, cancelledAt: now } as typeof current
      return r
    }
    return path.endsWith(id) ? { source: 'cloudflare', item: current, evaluatedAt: now } : list()
  })
})
afterEach(() => {
  mounted.splice(0).forEach((w) => w.unmount())
  vi.restoreAllMocks()
})
async function render(props = {}) {
  const w = await mountSuspended(Panel, {
    props: { scopeKey: 'current-owner', enabled: true, pending: false, variantId: 11, ...props }
  })
  mounted.push(w)
  await flushPromises()
  return w
}
const posts = () => mocks.request.mock.calls.filter(([, options]) => options?.method === 'POST')
async function review(w: Awaited<ReturnType<typeof render>>) {
  await w.get('[data-watch-consent]').setValue(true)
  await w.get('[data-watch-kind]').setValue('price_drop')
  await w.get('[data-watch-review]').trigger('click')
  await vi.waitFor(() => expect(w.find('[data-watch-confirm]').exists()).toBe(true))
}
it('reads live own watches and explains variant consent, preferences and no stock reservation', async () => {
  const w = await render()
  expect(mocks.request).toHaveBeenCalledWith('/api/account/product-watches', expect.any(Object))
  expect(w.text()).toContain(TEXT)
  expect(w.get('a[href="/cuenta/comunicaciones"]').exists()).toBe(true)
  expect(posts()).toHaveLength(0)
})
it.each([{ enabled: false }, { pending: true }])(
  'does not read or mutate without enabled current context %j',
  async (props) => {
    await render(props)
    expect(mocks.request).not.toHaveBeenCalled()
  }
)
it('requires explicit consent and review then confirms a pending registration only by receipt plus exact detail', async () => {
  const w = await render()
  await w.get('[data-watch-review]').trigger('click')
  expect(w.find('[data-watch-confirm]').exists()).toBe(false)
  expect(posts()).toHaveLength(0)
  await review(w)
  await w.get('[data-watch-confirm]').trigger('click')
  await vi.waitFor(() => expect(w.text()).toContain('Solicitud pendiente de confirmar por correo'))
  expect(posts()).toHaveLength(1)
  expect(posts()[0]![1].body).toEqual({ variantId: 11, kind: 'price_drop', consent: true, policyVersion: POLICY })
  expect(mocks.request.mock.calls.some(([path]) => path === `/api/account/product-watches/${id}`)).toBe(true)
  expect(w.text()).not.toContain('Correo enviado')
})
it('recovers a lost response by exact key and hash plus fresh detail without another mutation', async () => {
  const w = await render()
  await review(w)
  mocks.request.mockRejectedValueOnce(Error('lost'))
  await w.get('[data-watch-confirm]').trigger('click')
  await vi.waitFor(() => expect(w.find('[data-watch-recover]').exists()).toBe(true))
  const sent = posts()[0]!,
    saved = await receipt(sent[0], sent[1])
  mocks.request.mockImplementation(async (path: string) =>
    path.includes('/commands/')
      ? { source: 'cloudflare', outcome: 'applied', receipt: saved }
      : { source: 'cloudflare', item: current, evaluatedAt: now }
  )
  await w.get('[data-watch-recover]').trigger('click')
  await vi.waitFor(() => expect(w.text()).toContain('Solicitud pendiente de confirmar por correo'))
  expect(posts()).toHaveLength(1)
  const recovery = mocks.request.mock.calls.find(([path]) => path.includes('/commands/'))!
  expect(recovery[0]).toBe(`/api/account/product-watches/commands/${saved.commandId}`)
  expect(recovery[1].headers['X-Neteco-Command-Payload-Hash']).toBe(saved.payloadHash)
})
it('allows explicit cancellation of pending consent with its real version and fresh proof', async () => {
  const w = await render()
  await w.get(`[data-watch-cancel="${id}"]`).trigger('click')
  await vi.waitFor(() => expect(w.find('[data-watch-confirm]').exists()).toBe(true))
  expect(posts()).toHaveLength(0)
  await w.get('[data-watch-confirm]').trigger('click')
  await vi.waitFor(() => expect(w.text()).toContain('Aviso cancelado'))
  expect(posts()[0]![0]).toBe(`/api/account/product-watches/${id}/cancel`)
  expect(posts()[0]![1].body).toEqual({ expectedVersion: 1 })
})
it('purges private state and frozen intention when the current owner changes', async () => {
  const w = await render()
  await review(w)
  auth.session.value.sessionVersion = 2
  await flushPromises()
  expect(w.find('[data-watch-confirm]').exists()).toBe(false)
  expect(posts()).toHaveLength(0)
})
it('does not confirm success or resend on a receipt for another watch', async () => {
  const w = await render()
  await review(w)
  mocks.request.mockImplementationOnce(async (path: string, options: RequestOptions) => ({
    ...(await receipt(path, options)),
    watchId: '20000000-0000-4000-8000-000000000087'
  }))
  await w.get('[data-watch-confirm]').trigger('click')
  await vi.waitFor(() => expect(w.find('[data-watch-recover]').exists()).toBe(true))
  expect(w.text()).not.toContain('Solicitud pendiente de confirmar por correo')
  expect(posts()).toHaveLength(1)
})

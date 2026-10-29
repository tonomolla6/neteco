import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { ref } from 'vue'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import Panel from '../../app/components/DeliveryPreferencesPanel.vue'
import {
  DELIVERY_PREFERENCES_NOTICE_TEXT as TEXT,
  DELIVERY_PREFERENCES_POLICY_VERSION as POLICY,
  deliveryPreferenceIntentHash
} from '../../shared/delivery-preferences'
import '#app/nuxt-vitest-app-entry'
const mocks = vi.hoisted(() => ({ request: vi.fn(), auth: { value: null as unknown } }))
mockNuxtImport('useRequestFetch', () => () => mocks.request)
mockNuxtImport('useUserSession', () => () => mocks.auth.value)
const initial = {
  source: 'cloudflare',
  version: 0,
  deliveryUpdates: true,
  policyVersion: POLICY,
  noticeText: TEXT,
  updatedAt: null
}
type Options = {
  method?: string
  body?: { expectedVersion: number; deliveryUpdates: boolean; policyVersion: typeof POLICY }
  headers?: Record<string, string>
}
const instant = '2026-10-09T12:00:00Z'
const fresh = (version = 1, deliveryUpdates = false) => ({ ...initial, version, deliveryUpdates, updatedAt: instant })
function receipt(options: Options) {
  return {
    source: 'cloudflare',
    commandId: options.headers!['Idempotency-Key'],
    ...options.body!,
    version: options.body!.expectedVersion + 1,
    textHash: 'a'.repeat(64),
    recordedAt: instant
  }
}
let auth: ReturnType<typeof session>
function session() {
  return {
    ready: ref(true),
    loggedIn: ref(true),
    user: ref({ id: '10000000-0000-4000-8000-000000000050', emailVerified: true }),
    session: ref({ sessionId: '20000000-0000-4000-8000-000000000050', sessionVersion: 1 })
  }
}
const mounted: Array<{ unmount: () => void }> = []
beforeEach(() => {
  auth = session()
  mocks.auth.value = auth
  let current: unknown = initial
  mocks.request.mockReset().mockImplementation(async (_path: string, options: Options) => {
    if (options.method === 'PUT') {
      current = fresh(options.body!.expectedVersion + 1, options.body!.deliveryUpdates)
      return receipt(options)
    }
    return current
  })
})
afterEach(() => {
  mounted.splice(0).forEach((w) => w.unmount())
  vi.restoreAllMocks()
})
async function render(props = {}) {
  const w = await mountSuspended(Panel, {
    props: { scopeKey: 'owner-session', enabled: true, pending: false, ...props }
  })
  mounted.push(w)
  await flushPromises()
  return w
}
async function choose(w: Awaited<ReturnType<typeof render>>) {
  await w.get('[data-delivery-updates]').setValue(false)
  await w.get('[data-delivery-ack]').setValue(true)
}
const puts = () => mocks.request.mock.calls.filter(([, options]) => options?.method === 'PUT')
it('shows confirmed enabled defaults and honest operational-only scope without changing marketing', async () => {
  const w = await render()
  expect(w.get('[data-delivery-updates]').element).toHaveProperty('checked', true)
  expect(w.text()).toContain(TEXT)
  expect(w.text()).toContain('Recibir avisos de preparación y entrega')
  expect(puts()).toHaveLength(0)
})
it.each([{ enabled: false }, { pending: true }, { scopeKey: '' }])(
  'does not request without active context %j',
  async (props) => {
    await render(props)
    expect(mocks.request).not.toHaveBeenCalled()
  }
)
it('requires verified current session but not MFA', async () => {
  auth.user.value.emailVerified = false
  await render()
  expect(mocks.request).not.toHaveBeenCalled()
})
it.each(['failed', 'malformed'])('does not invent defaults from %s reads', async (kind) => {
  mocks.request.mockImplementation(async () => {
    if (kind === 'failed') throw Error('unavailable')
    return { ...initial, deliveryUpdates: false }
  })
  const w = await render()
  expect(w.find('[data-delivery-updates]').exists()).toBe(false)
  expect(w.find('[data-delivery-retry]').exists()).toBe(true)
})
it('requires explicit confirmation and one frozen PUT before receipt plus current-state confirmation', async () => {
  const w = await render()
  await w.get('form').trigger('submit')
  expect(puts()).toHaveLength(0)
  await choose(w)
  await w.get('form').trigger('submit')
  await vi.waitFor(() => expect(w.text()).toContain('Avisos de entrega guardados'))
  expect(puts()).toHaveLength(1)
  expect(puts()[0]![1].body).toEqual({ expectedVersion: 0, deliveryUpdates: false, policyVersion: POLICY })
  expect(puts()[0]![1].headers['Idempotency-Key']).toMatch(/^[a-f0-9-]{36}$/)
  expect(w.text()).toContain('Avisos de entrega guardados')
  expect(mocks.request).toHaveBeenCalledTimes(3)
})
it('recovers a lost committed response using exact hash and receipt before fresh GET, never another PUT', async () => {
  const w = await render()
  await choose(w)
  mocks.request.mockRejectedValueOnce(Error('lost'))
  await w.get('form').trigger('submit')
  await vi.waitFor(() => expect(w.find('[data-delivery-unknown]').exists()).toBe(true))
  const options = puts()[0]![1],
    saved = receipt(options)
  mocks.request.mockImplementation(async (path: string) =>
    path.includes('/commands/')
      ? { source: 'cloudflare', commandId: saved.commandId, outcome: 'applied', receipt: saved }
      : fresh()
  )
  await w.get('[data-delivery-recover]').trigger('click')
  await flushPromises()
  expect(puts()).toHaveLength(1)
  expect(w.text()).toContain('Avisos de entrega guardados')
  expect(mocks.request).toHaveBeenCalledWith(
    `/api/account/delivery-preferences/commands/${saved.commandId}`,
    expect.objectContaining({
      headers: { 'X-Neteco-Command-Payload-Hash': await deliveryPreferenceIntentHash(options.body) },
      method: 'GET'
    })
  )
})
it('unknown receipt cannot prove no effect or success even if current choice matches', async () => {
  const w = await render()
  await choose(w)
  mocks.request.mockRejectedValueOnce(Error('lost'))
  await w.get('form').trigger('submit')
  await vi.waitFor(() => expect(w.find('[data-delivery-unknown]').exists()).toBe(true))
  mocks.request.mockImplementation(async () => ({
    source: 'cloudflare',
    commandId: puts()[0]![1].headers['Idempotency-Key'],
    outcome: 'unknown',
    receipt: null
  }))
  await w.get('[data-delivery-recover]').trigger('click')
  await flushPromises()
  expect(w.find('[data-delivery-unknown]').exists()).toBe(true)
  expect(w.text()).not.toContain('Avisos de entrega guardados')
  expect(puts()).toHaveLength(1)
})
it.each(['failed', 'stale', 'different'])('receipt with %s fresh read retains uncertainty', async (kind) => {
  const w = await render()
  await choose(w)
  mocks.request.mockImplementation(async (_path: string, options: Options) => {
    if (options.method === 'PUT') return receipt(options)
    if (kind === 'failed') throw Error('lost')
    return kind === 'stale' ? initial : fresh(1, true)
  })
  await w.get('form').trigger('submit')
  await vi.waitFor(() => expect(w.find('[data-delivery-unknown]').exists()).toBe(true))
  expect(w.find('[data-delivery-unknown]').exists()).toBe(true)
  expect(w.text()).not.toContain('Avisos de entrega guardados')
})
it.each([401, 403])('purges receipt, snapshot and intent on hard %s revocation', async (statusCode) => {
  const w = await render()
  await choose(w)
  mocks.request.mockRejectedValueOnce({ statusCode })
  await w.get('form').trigger('submit')
  await vi.waitFor(() => expect(w.find('form').exists()).toBe(false))
  expect(w.find('form').exists()).toBe(false)
  expect(w.find('[data-delivery-recover]').exists()).toBe(false)
  expect(w.emitted('pending')?.at(-1)).toEqual([false])
})
it('scope changes abort and ignore a late successful PUT without contaminating another account', async () => {
  const w = await render()
  await choose(w)
  let resolve!: (value: unknown) => void
  mocks.request.mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r
      })
  )
  await w.get('form').trigger('submit')
  await vi.waitFor(() => expect(puts()).toHaveLength(1))
  const options = puts()[0]![1]
  await w.setProps({ enabled: false, scopeKey: 'other' })
  resolve(receipt(options))
  await flushPromises()
  expect(w.text()).not.toContain('Avisos de entrega guardados')
  expect(w.find('form').exists()).toBe(false)
  expect(mocks.request).toHaveBeenCalledTimes(2)
})
it('double submission is singleflight, and disposal releases pending', async () => {
  const w = await render()
  await choose(w)
  mocks.request.mockImplementationOnce(() => new Promise(() => {}))
  await w.get('form').trigger('submit')
  await w.get('form').trigger('submit')
  await vi.waitFor(() => expect(puts()).toHaveLength(1))
  expect(puts()).toHaveLength(1)
  w.unmount()
  expect(w.emitted('pending')?.at(-1)).toEqual([false])
})
it('a mismatched command receipt never confirms or clears the original intention', async () => {
  const w = await render()
  await choose(w)
  mocks.request.mockImplementationOnce(async (_path: string, options: Options) => ({
    ...receipt(options),
    deliveryUpdates: true
  }))
  await w.get('form').trigger('submit')
  await vi.waitFor(() => expect(w.find('[data-delivery-unknown]').exists()).toBe(true))
  expect(w.find('[data-delivery-unknown]').exists()).toBe(true)
  expect(w.find('[data-delivery-recover]').exists()).toBe(true)
  expect(w.emitted('confirmed')).toBeUndefined()
})
it('hard revocation during manual recovery purges the frozen intention without resending', async () => {
  const w = await render()
  await choose(w)
  mocks.request.mockRejectedValueOnce(Error('lost'))
  await w.get('form').trigger('submit')
  await vi.waitFor(() => expect(w.find('[data-delivery-unknown]').exists()).toBe(true))
  mocks.request.mockRejectedValueOnce({ statusCode: 403 })
  await w.get('[data-delivery-recover]').trigger('click')
  await flushPromises()
  expect(w.find('form').exists()).toBe(false)
  expect(w.find('[data-delivery-recover]').exists()).toBe(false)
  expect(puts()).toHaveLength(1)
})
it('a proven initial CAS rejection permits a manual fresh read, never another automatic PUT', async () => {
  const w = await render()
  await choose(w)
  mocks.request.mockRejectedValueOnce({ statusCode: 409, data: { error: { code: 'version_conflict' } } })
  await w.get('form').trigger('submit')
  await vi.waitFor(() => expect(w.find('[data-delivery-retry]').exists()).toBe(true))
  expect(w.find('[data-delivery-recover]').exists()).toBe(false)
  expect(w.emitted('pending')?.at(-1)).toEqual([false])
  mocks.request.mockResolvedValueOnce(fresh(2, true))
  await w.get('[data-delivery-retry]').trigger('click')
  await flushPromises()
  expect(w.get('[data-delivery-updates]').element).toHaveProperty('checked', true)
  expect(puts()).toHaveLength(1)
})
it('a CAS-shaped error after receipt does not erase the applied command or unblock siblings', async () => {
  const w = await render()
  await choose(w)
  mocks.request.mockImplementation(async (_path: string, options: Options) => {
    if (options.method === 'PUT') return receipt(options)
    throw { statusCode: 409, data: { error: { code: 'version_conflict' } } }
  })
  await w.get('form').trigger('submit')
  await vi.waitFor(() => expect(w.find('[data-delivery-unknown]').exists()).toBe(true))
  expect(w.find('[data-delivery-recover]').exists()).toBe(true)
  expect(w.emitted('pending')?.at(-1)).toEqual([true])
})
it('a local hash failure before PUT releases pending and offers a manual read instead of unrecoverable unknown', async () => {
  const w = await render()
  await choose(w)
  vi.spyOn(globalThis.crypto.subtle, 'digest').mockRejectedValueOnce(Error('local_hash_failure'))
  await w.get('form').trigger('submit')
  await vi.waitFor(() => expect(w.emitted('pending')?.at(-1)).toEqual([false]))
  expect(puts()).toHaveLength(0)
  expect(w.find('[data-delivery-unknown]').exists()).toBe(false)
  expect(w.find('[data-delivery-retry]').exists()).toBe(true)
})
it.each([0, 2])(
  'unknown receipt permits discarding only after a fresh version advances from the frozen CAS (%s)',
  async (version) => {
    const w = await render()
    await choose(w)
    mocks.request.mockRejectedValueOnce(Error('lost'))
    await w.get('form').trigger('submit')
    await vi.waitFor(() => expect(w.find('[data-delivery-unknown]').exists()).toBe(true))
    const key = puts()[0]![1].headers['Idempotency-Key']
    mocks.request.mockImplementation(async (path: string) =>
      path.includes('/commands/')
        ? { source: 'cloudflare', commandId: key, outcome: 'unknown', receipt: null }
        : version
          ? fresh(version, true)
          : initial
    )
    await w.get('[data-delivery-recover]').trigger('click')
    await flushPromises()
    expect(w.find('[data-delivery-discard]').exists()).toBe(version > 0)
    if (version > 0) {
      await w.get('[data-delivery-discard]').trigger('click')
      expect(w.find('[data-delivery-retry]').exists()).toBe(true)
      expect(w.find('form').exists()).toBe(false)
      expect(w.emitted('pending')?.at(-1)).toEqual([false])
    }
    expect(puts()).toHaveLength(1)
    expect(w.emitted('confirmed')).toBeUndefined()
  }
)

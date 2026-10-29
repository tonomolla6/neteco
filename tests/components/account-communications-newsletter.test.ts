import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { ref, defineComponent, h } from 'vue'
import { beforeEach, afterEach, it, expect, vi } from 'vitest'
import Communications from '../../app/pages/cuenta/comunicaciones.vue'
import Newsletter from '../../app/pages/cuenta/newsletter.vue'
import Panel from '../../app/components/NewsletterPreferencesPanel.vue'
import '#app/nuxt-vitest-app-entry'
const { request, legacy, write, runtime } = vi.hoisted(() => ({
  request: vi.fn(),
  legacy: vi.fn(),
  write: vi.fn(),
  runtime: vi.fn(() => ({
    app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
    public: { serverRuntime: 'cloudflare' }
  }))
}))
mockNuxtImport('useRequestFetch', () => () => request)
mockNuxtImport('useFetch', () => legacy)
mockNuxtImport('$fetch', () => write)
mockNuxtImport('useRuntimeConfig', () => runtime)
mockNuxtImport('useUserSession', () => () => auth)
const ID = '10000000-0000-4000-8000-000000000050',
  SID = '20000000-0000-4000-8000-000000000050',
  SUB = '30000000-0000-4000-8000-000000000050'
let auth: {
  ready: ReturnType<typeof ref<boolean>>
  loggedIn: ReturnType<typeof ref<boolean>>
  user: ReturnType<typeof ref<{ id: string; email: string; emailVerified: boolean; mfaVerified: boolean } | null>>
  session: ReturnType<typeof ref<{ sessionId: string; sessionVersion: number } | null>>
}
const wrappers: Array<{ unmount: () => void }> = []
const initial = () => ({
  source: 'cloudflare',
  subscriptionId: SUB,
  status: 'confirmed',
  revision: 0,
  preference: null,
  topics: [{ id: ID, code: 'limpieza', label: 'PRIVATE_OWNER_TOPIC', active: true, revision: 1 }],
  canSave: true,
  canUnsubscribe: true,
  externalDelivery: false
})
const pref = { frequency: 'weekly', topics: [], locale: 'es', quietHours: null }
const acknowledged = () => ({ source: 'cloudflare', resourceId: SUB, revision: 1, action: 'save', updated: true })
const fresh = () => ({ ...initial(), revision: 1, preference: pref })
const Surface = defineComponent({ setup: (_, ctx) => () => h('section', ctx.slots.default?.()) })
const Button = defineComponent({
  props: { disabled: Boolean, loading: Boolean },
  setup: (props, ctx) => () =>
    h('button', { ...ctx.attrs, disabled: props.disabled || props.loading }, ctx.slots.default?.())
})
const Link = defineComponent({
  props: { to: String },
  setup: (props, ctx) => () => h('a', { href: props.to }, ctx.slots.default?.())
})
beforeEach(() => {
  auth = {
    ready: ref(true),
    loggedIn: ref(true),
    user: ref({ id: ID, email: 'owner@example.invalid', emailVerified: true, mfaVerified: false }),
    session: ref({ sessionId: SID, sessionVersion: 1 })
  }
  request.mockReset().mockResolvedValue(initial())
  legacy.mockReset().mockImplementation(async (path) => ({
    data: ref(path.endsWith('/privacy') ? { requests: [] } : { preferences: [] }),
    refresh: vi.fn(async () => undefined)
  }))
  write.mockReset()
  runtime.mockReturnValue({
    app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
    public: { serverRuntime: 'cloudflare' }
  })
})
afterEach(() => {
  for (const w of wrappers.splice(0)) w.unmount()
})
async function render(
  component: typeof Panel | typeof Newsletter | typeof Communications,
  props: Record<string, unknown> = {}
) {
  const w = await mountSuspended(component, {
    props,
    global: {
      stubs: {
        UiSurface: Surface,
        UButton: Button,
        NuxtLink: Link,
        UModal: true,
        USwitch: true,
        AccountPrivacyPanel: true,
        AccountPreferencesPanel: true,
        DeliveryPreferencesPanel: true
      }
    }
  })
  wrappers.push(w)
  await flushPromises()
  return w
}
const panel = () =>
  render(Panel, {
    endpoint: '/api/account/newsletter/preferences',
    actorId: ID,
    authorize: () => auth.ready.value && auth.loggedIn.value && auth.user.value?.emailVerified === true
  })
const click = async (w: Awaited<ReturnType<typeof render>>, text: string) => {
  await w
    .findAll('button')
    .find((button) => button.text() === text)!
    .trigger('click')
  await flushPromises()
}
async function submit(w: Awaited<ReturnType<typeof render>>) {
  await w.find('select').setValue('weekly')
  await w.find('form').trigger('submit')
  await flushPromises()
}
const puts = () => request.mock.calls.filter((call) => call[1]?.method === 'PUT')
it('CF communications mounts current settings panels without Node calls and retains newsletter management', async () => {
  const w = await render(Communications)
  expect(legacy).not.toHaveBeenCalled()
  expect(write).not.toHaveBeenCalled()
  expect(request).not.toHaveBeenCalled()
  expect(w.find('account-privacy-panel-stub').exists()).toBe(true)
  expect(w.find('account-preferences-panel-stub').exists()).toBe(true)
  expect(w.text()).not.toContain('tampoco están disponibles')
  expect(w.text()).toContain('anonimización')
  expect(w.find('a[href="/cuenta/newsletter"]').exists()).toBe(true)
  expect(w.findAll('button').some((button) => /Descargar|anonimización|Guardar preferencias/.test(button.text()))).toBe(
    false
  )
})
it('Node communications preserves its two legacy reads and preference action', async () => {
  runtime.mockReturnValue({
    app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
    public: { serverRuntime: 'node' }
  })
  const w = await render(Communications)
  expect(legacy.mock.calls.map((call) => call[0])).toEqual(['/api/account/preferences', '/api/account/privacy'])
  expect(w.text()).toContain('Descargar mis datos')
  await click(w, 'Guardar preferencias')
  expect(write).toHaveBeenCalledWith('/api/account/preferences', expect.objectContaining({ method: 'PUT' }))
})
it.each([
  'unready',
  'loggedout',
  'unverified',
  'missinguser',
  'badidentity',
  'missingsession',
  'badsession',
  'zeroversion',
  'fractionalversion'
])('newsletter with %s has no private request', async (kind) => {
  if (kind === 'unready') auth.ready.value = false
  if (kind === 'loggedout') auth.loggedIn.value = false
  if (kind === 'unverified') auth.user.value!.emailVerified = false
  if (kind === 'missinguser') auth.user.value = null
  if (kind === 'badidentity') auth.user.value!.id = 'invalid'
  if (kind === 'missingsession') auth.session.value = null
  if (kind === 'badsession') auth.session.value!.sessionId = 'invalid'
  if (kind === 'zeroversion') auth.session.value!.sessionVersion = 0
  if (kind === 'fractionalversion') auth.session.value!.sessionVersion = 1.5
  const w = await render(Newsletter)
  expect(request).not.toHaveBeenCalled()
  expect(w.text()).not.toContain('PRIVATE_OWNER_TOPIC')
})
it('verified CF customer without MFA enrollment can read; no implicit write or consent', async () => {
  const w = await render(Newsletter)
  expect(request).toHaveBeenCalledTimes(1)
  expect(puts()).toHaveLength(0)
  expect(w.text()).toContain('PRIVATE_OWNER_TOPIC')
  expect(w.find<HTMLSelectElement>('select').element.value).toBe('')
})
it.each(['session', 'version', 'email', 'identity'])(
  'newsletter purges stale PII and ignores previous %s request after boundary',
  async (kind) => {
    let resolve!: (value: unknown) => void
    request.mockReturnValueOnce(
      new Promise((r) => {
        resolve = r
      })
    )
    const w = await render(Newsletter)
    if (kind === 'session') auth.session.value!.sessionId = SUB
    if (kind === 'version') auth.session.value!.sessionVersion = 2
    if (kind === 'email') auth.user.value!.email = 'new@example.invalid'
    if (kind === 'identity') auth.user.value!.id = SUB
    request.mockResolvedValue({ ...initial(), topics: [] })
    await flushPromises()
    resolve(initial())
    await flushPromises()
    expect(w.text()).not.toContain('PRIVATE_OWNER_TOPIC')
    expect(puts()).toHaveLength(0)
  }
)
it('same-identity verification loss removes loaded private data without another read', async () => {
  const w = await render(Newsletter)
  expect(w.text()).toContain('PRIVATE_OWNER_TOPIC')
  auth.user.value!.emailVerified = false
  await flushPromises()
  expect(w.text()).not.toContain('PRIVATE_OWNER_TOPIC')
  expect(request).toHaveBeenCalledTimes(1)
})
it('Node newsletter preserves unavailable D1 management and sends no CF requests', async () => {
  runtime.mockReturnValue({
    app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
    public: { serverRuntime: 'node' }
  })
  await render(Newsletter)
  expect(request).not.toHaveBeenCalled()
})
it.each(['failed', 'stale', 'foreign', 'different'])(
  'ACK followed by %s GET never announces success or discards recovery intent',
  async (mode) => {
    let reads = 0
    request.mockImplementation(async (_path, options) => {
      if (options?.method === 'PUT') return acknowledged()
      if (reads++ === 0) return initial()
      if (mode === 'failed') throw new Error('PRIVATE_SERVER_ERROR')
      return mode === 'stale'
        ? initial()
        : mode === 'foreign'
          ? { ...fresh(), subscriptionId: ID }
          : { ...fresh(), preference: { ...pref, frequency: 'monthly' } }
    })
    const w = await panel()
    await submit(w)
    expect(w.text()).not.toContain('guardadas y confirmadas')
    expect(w.text()).not.toContain('PRIVATE_SERVER_ERROR')
    expect(w.text()).toContain('pendiente de confirmar')
    expect(puts()).toHaveLength(1)
  }
)
it('ACK plus manual matching GET clears intent and never repeats the acknowledged PUT', async () => {
  let reads = 0
  request.mockImplementation(async (_path, options) => {
    if (options?.method === 'PUT') return acknowledged()
    if (reads++ === 0) return initial()
    throw new Error('read-offline')
  })
  const w = await panel()
  await submit(w)
  expect(w.text()).not.toContain('guardadas y confirmadas')
  request.mockResolvedValue(fresh())
  await click(w, 'Actualizar estado confirmado')
  expect(w.text()).toContain('guardadas y confirmadas')
  expect(w.text()).not.toContain('petición pendiente')
  expect(puts()).toHaveLength(1)
})
it('lost ACK plus matching GET is not proof of this command; exact manual retry only', async () => {
  let reads = 0
  request.mockImplementation(async (_path, options) => {
    if (options?.method === 'PUT') throw new Error('unknown')
    return reads++ ? fresh() : initial()
  })
  const w = await panel()
  await submit(w)
  await click(w, 'Actualizar estado confirmado')
  expect(w.text()).not.toContain('guardadas y confirmadas')
  expect(w.text()).toContain('petición pendiente')
  expect(puts()).toHaveLength(1)
  await click(w, 'Reintentar misma petición')
  const writes = puts()
  expect(writes).toHaveLength(2)
  expect(writes[1]![1].body).toEqual(writes[0]![1].body)
  expect(writes[1]![1].headers['Idempotency-Key']).toBe(writes[0]![1].headers['Idempotency-Key'])
})
it.each([401, 403])('HTTP authority loss %s purges private snapshot and pending command', async (statusCode) => {
  request.mockImplementation(async (_path, options) => {
    if (options?.method === 'PUT') throw { statusCode }
    return initial()
  })
  const w = await panel()
  await submit(w)
  expect(w.text()).not.toContain('PRIVATE_OWNER_TOPIC')
  expect(w.text()).not.toContain('petición pendiente')
  expect(w.find('form').exists()).toBe(false)
})
it('unmount aborts an in-flight private GET', async () => {
  let signal: AbortSignal | undefined
  request.mockImplementation((_path, options) => {
    signal = options.signal
    return new Promise(() => {})
  })
  const w = await panel()
  w.unmount()
  expect(signal?.aborted).toBe(true)
})
it('a queued old session request cannot dispatch after same-identity rotation', async () => {
  let previous: (() => void) | undefined
  request.mockImplementation((_path, options) => {
    previous ??= options.onRequest
    return new Promise(() => {})
  })
  await render(Newsletter)
  auth.session.value!.sessionVersion = 2
  await flushPromises()
  expect(() => previous!()).toThrow('authority_changed')
})
it('unknown original commit is never cleared by a nonconclusive rejection of the explicit replay', async () => {
  let attempts = 0
  request.mockImplementation(async (_path, options) => {
    if (options?.method === 'PUT') {
      if (attempts++ === 0) throw new Error('lost-original')
      throw { statusCode: 409, data: { error: { code: 'idempotency_conflict' } } }
    }
    return initial()
  })
  const w = await panel()
  await submit(w)
  await click(w, 'Reintentar misma petición')
  expect(w.text()).toContain('petición pendiente')
  expect(w.text()).not.toContain('rechazado el comando antes')
  expect(puts()).toHaveLength(2)
})
it('matching unsubscribe ACK plus failed read does not falsely announce permanent cancellation', async () => {
  let reads = 0
  request.mockImplementation(async (_path, options) => {
    if (options?.method === 'PUT') return { ...acknowledged(), action: 'unsubscribe' }
    if (reads++ === 0) return initial()
    throw new Error('read-offline')
  })
  const w = await panel()
  await click(w, 'Darme de baja')
  expect(puts()).toHaveLength(0)
  await click(w, 'Confirmar baja permanente')
  expect(w.text()).not.toContain('Baja confirmada')
  expect(w.text()).toContain('petición pendiente')
  expect(puts()).toHaveLength(1)
})
it('refresh remains singleflight and no transport retries are implicit', async () => {
  const w = await panel()
  let resolve!: (value: unknown) => void
  request.mockReturnValue(
    new Promise((r) => {
      resolve = r
    })
  )
  const button = w.findAll('button').find((item) => item.text() === 'Actualizar estado confirmado')!
  await button.trigger('click')
  await button.trigger('click')
  expect(request).toHaveBeenCalledTimes(2)
  expect(request.mock.calls[1]![1].retry).toBe(0)
  resolve(initial())
  await flushPromises()
})

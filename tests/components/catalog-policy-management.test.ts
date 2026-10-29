import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { defineComponent, h, nextTick, proxyRefs, reactive, ref, toValue } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import PoliciesPage from '../../app/pages/admin/politicas-catalogo.vue'
import '#app/nuxt-vitest-app-entry'

const { fetchMock, requestMock, runtimeMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  requestMock: vi.fn(),
  runtimeMock: vi.fn(() => ({
    app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
    public: { serverRuntime: 'cloudflare' }
  }))
}))
mockNuxtImport('useFetch', () => fetchMock)
mockNuxtImport('$fetch', () => requestMock)
mockNuxtImport('useRuntimeConfig', () => runtimeMock)
mockNuxtImport('useUserSession', () => () => ({
  ready: ref(true),
  loggedIn: ref(true),
  user: ref({ id: 'synthetic-admin', role: 'admin', mfaVerified: true }),
  session: ref(null),
  clear: async () => undefined,
  fetch: async () => undefined,
  openInPopup: () => undefined
}))
const ID = 'a1000000-0000-4000-8000-000000000001'
const NEW_ID = 'a1000000-0000-4000-8000-000000000002'
const policy = () => ({
  id: ID,
  code: 'equipment',
  version: 3,
  name: 'Política sintética',
  requiredFields: ['usage'],
  requiredMediaRoles: ['datasheet'],
  identifierExceptionsAllowed: false,
  validFrom: '2026-09-30T10:00:00Z',
  validUntil: null,
  current: true,
  withdrawn: false,
  assignedProductCount: 2,
  publishedProductCount: 0
})
const payload = (items = [policy()], perPage = 20, total = items.length) => ({
  source: 'cloudflare',
  capabilities: { publicationPoliciesRead: true, publicationPoliciesWrite: true },
  items,
  pagination: { page: 1, perPage, total, pages: Math.ceil(total / perPage) },
  evaluatedAt: '2026-09-30T12:00:00Z'
})
const receipt = (action = 'policy_create', resourceId = NEW_ID, policyVersion = 4) => ({
  source: 'cloudflare',
  action,
  entityId: NEW_ID,
  resourceId,
  policyVersion,
  productId: null,
  productUuid: null,
  catalogVersion: null,
  updated: true
})
const Button = defineComponent({
  inheritAttrs: false,
  props: { disabled: Boolean, loading: Boolean },
  setup:
    (props, { attrs, slots }) =>
    () =>
      h(
        'button',
        { ...attrs, type: attrs.type ?? 'button', disabled: props.disabled || props.loading },
        slots.default?.()
      )
})
const stubs = { UButton: Button, UBadge: defineComponent({ template: '<span><slot /></span>' }) }
type Wrapper = Awaited<ReturnType<typeof mountSuspended>>
let wrapper: Wrapper | undefined
let data: ReturnType<typeof ref<unknown>>
let status: ReturnType<typeof ref<string>>
let latestData: ReturnType<typeof ref<unknown>>
let latestStatus: ReturnType<typeof ref<string>>
let runtime: { app: { baseURL: string; buildAssetsDir: string; cdnURL: string }; public: { serverRuntime: string } }
const refresh = vi.fn<() => Promise<unknown>>()
const latestRefresh = vi.fn<() => Promise<unknown>>()
async function render(options: { data?: unknown; status?: string; runtime?: string } = {}) {
  data = ref(Object.hasOwn(options, 'data') ? options.data : payload())
  status = ref(options.status ?? 'success')
  latestData = ref(payload([policy()], 1, 7))
  latestStatus = ref('idle')
  runtime.public.serverRuntime = options.runtime ?? 'cloudflare'
  fetchMock.mockImplementation((url: string | (() => string)) =>
    String(toValue(url)).includes('perPage=1&')
      ? { data: latestData, status: latestStatus, refresh: latestRefresh }
      : { data, status, refresh }
  )
  wrapper = await mountSuspended(PoliciesPage, { global: { stubs } })
  return wrapper
}
const state = (page: Wrapper) => proxyRefs(page.setupState) as Record<string, unknown>
const form = (page: Wrapper) => state(page).form as Record<string, unknown>
async function invoke(page: Wrapper, name: string) {
  await (state(page)[name] as () => Promise<void>)()
  await flushPromises()
}
async function prepare(page: Wrapper) {
  await page.get('#policy-code').setValue('equipment')
  await invoke(page, 'lookup')
  Object.assign(form(page), {
    name: '  Política revisada  ',
    requiredFields: ['series', 'usage'],
    requiredMediaRoles: ['label', 'datasheet'],
    exceptions: 'false',
    validFrom: '2026-09-30T10:00:00Z',
    validUntil: '',
    reason: '  Revisión de requisitos documentada  ',
    confirmed: true
  })
  await nextTick()
}
const calls = () => requestMock.mock.calls.map((call) => call.slice(0, 2))
beforeEach(() => {
  requestMock.mockReset().mockResolvedValue(receipt())
  fetchMock.mockReset()
  refresh.mockReset().mockResolvedValue(undefined)
  latestRefresh.mockReset().mockImplementation(async () => {
    latestStatus.value = 'success'
  })
  runtime = reactive({
    app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
    public: { serverRuntime: 'cloudflare' }
  })
  runtimeMock.mockReturnValue(runtime)
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
})

describe('private versioned catalog policies', () => {
  it('shows accessible governance without automatic writes, defaults or legal approval', async () => {
    const page = await render()
    expect(page.text()).toContain('Políticas de publicación')
    expect(page.text()).toContain('No sustituyen la revisión legal')
    expect(page.get('#policy-exceptions').element).toHaveProperty('value', '')
    expect(requestMock).not.toHaveBeenCalled()
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: 'GET', immediate: true, server: true, watch: false })
    expect(String(toValue(fetchMock.mock.calls[0]?.[0]))).toBe('/api/admin/catalog/policies?page=1&perPage=20')
  })
  it.each(['idle', 'pending', 'error'])('never treats %s cached rows as a successful read', async (readStatus) => {
    const page = await render({ status: readStatus })
    expect(page.text()).not.toContain('Política sintética')
    expect(page.find('#policy-code').exists()).toBe(false)
    expect(page.find(readStatus === 'error' ? '[role="alert"]' : '[role="status"]').exists()).toBe(true)
    await invoke(page, 'createPolicy')
    await invoke(page, 'withdrawPolicy')
    expect(requestMock).not.toHaveBeenCalled()
  })
  it('distinguishes a successful empty result', async () => {
    const page = await render({ data: payload([]) })
    expect(page.text()).toContain('No hay políticas en esta consulta')
    expect(page.find('#policy-code').exists()).toBe(true)
  })
  it.each([
    null,
    {},
    { ...payload(), source: 'node' },
    { ...payload(), capabilities: { publicationPoliciesRead: 1, publicationPoliciesWrite: true } },
    { ...payload(), capabilities: Object.create({ publicationPoliciesRead: true, publicationPoliciesWrite: true }) },
    { ...payload(), evaluatedAt: '2026-02-30T10:00:00Z' },
    { ...payload(), evaluatedAt: '2026-09-30T10:00:00.000Z' },
    { ...payload(), items: [{ ...policy(), requiredFields: ['usage', 'usage'] }] },
    { ...payload(), items: [{ ...policy(), requiredMediaRoles: ['not-a-role'] }] },
    { ...payload(), items: [{ ...policy(), validFrom: '2027-09-30T10:00:00Z' }] },
    { ...payload(), pagination: { page: 2, perPage: 20, total: 1, pages: 1 } }
  ])('hides malformed/private-denied content %#', async (bad) => {
    const page = await render({ data: bad })
    expect(page.find('#policy-code').exists()).toBe(false)
    expect(page.get('[role="alert"]').text()).toContain('consulta privada válida')
    await invoke(page, 'createPolicy')
    expect(requestMock).not.toHaveBeenCalled()
  })
  it('does not execute poisoned DTO getters', async () => {
    const getter = vi.fn(() => 'cloudflare')
    const bad = Object.defineProperty(payload(), 'source', { get: getter, enumerable: true })
    const page = await render({ data: bad })
    expect(page.find('#policy-code').exists()).toBe(false)
    expect(getter).not.toHaveBeenCalled()
  })
  it.each(['node', 'unknown'])('does not use a %s fallback or send commands', async (value) => {
    const page = await render({ runtime: value })
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ immediate: false, server: false })
    await invoke(page, 'readList')
    await invoke(page, 'createPolicy')
    expect(refresh).not.toHaveBeenCalled()
    expect(requestMock).not.toHaveBeenCalled()
  })
  it('looks up the exact code with perPage=1 and never infers max from unfiltered rows', async () => {
    const page = await render()
    Object.assign(form(page), {
      code: 'equipment',
      name: 'Política revisada',
      exceptions: 'false',
      validFrom: '2026-09-30T10:00:00Z',
      reason: 'Revisión documentada',
      confirmed: true
    })
    await nextTick()
    await invoke(page, 'createPolicy')
    expect(requestMock).not.toHaveBeenCalled()
    await invoke(page, 'lookup')
    expect(String(toValue(fetchMock.mock.calls[1]?.[0]))).toBe(
      '/api/admin/catalog/policies?page=1&perPage=1&code=equipment'
    )
    expect(page.text()).toContain('Nueva versión: 4')
    await page.get('#policy-code').setValue('another-code')
    await invoke(page, 'createPolicy')
    expect(requestMock).not.toHaveBeenCalled()
  })
  it('creates a strict canonical frozen command with crypto key and refetches rather than applying receipt', async () => {
    const page = await render()
    const original = data.value
    await prepare(page)
    await invoke(page, 'createPolicy')
    expect(calls()).toEqual([
      [
        '/api/admin/catalog/policies',
        {
          method: 'POST',
          body: {
            code: 'equipment',
            name: 'Política revisada',
            expectedVersion: 3,
            requiredFields: ['series', 'usage'],
            requiredMediaRoles: ['datasheet', 'label'],
            identifierExceptionsAllowed: false,
            validFrom: '2026-09-30T10:00:00Z',
            validUntil: null,
            reason: 'Revisión de requisitos documentada'
          },
          headers: { Origin: window.location.origin, 'Idempotency-Key': expect.stringMatching(/^[0-9a-f-]{36}$/) }
        }
      ]
    ])
    expect(refresh).toHaveBeenCalledOnce()
    expect(data.value).toBe(original)
    expect(page.text()).toContain('Cambio registrado')
  })
  it.each([
    { exceptions: '' },
    { confirmed: false },
    { reason: 'corto' },
    { reason: 'Motivo inválido\ncon control' },
    { validFrom: '2026-02-30T10:00:00Z' },
    { validFrom: '2026-09-30T10:00:00.000Z' },
    { validUntil: '2026-09-30T09:00:00Z' },
    { requiredFields: ['usage', 'usage'] },
    { requiredMediaRoles: ['bad'] }
  ])('requires explicit reviewed valid inputs %#', async (bad) => {
    const page = await render()
    await prepare(page)
    Object.assign(form(page), bad)
    await invoke(page, 'createPolicy')
    expect(requestMock).not.toHaveBeenCalled()
  })
  it('blocks withdrawal with published products and preserves audit semantics', async () => {
    const page = await render({ data: payload([{ ...policy(), publishedProductCount: 1 }]) })
    expect(page.text()).toContain('Retirada bloqueada')
    Object.assign(state(page), { withdrawal: ID, withdrawReason: 'Retirada documentada', withdrawConfirmed: true })
    await invoke(page, 'withdrawPolicy')
    expect(requestMock).not.toHaveBeenCalled()
  })
  it('withdraws only selected private policy/version with reason and exact receipt', async () => {
    const page = await render()
    requestMock.mockResolvedValueOnce(receipt('policy_withdraw', ID, 3))
    Object.assign(state(page), { withdrawal: ID, withdrawReason: 'Retirada documentada', withdrawConfirmed: true })
    await invoke(page, 'withdrawPolicy')
    expect(calls()[0]).toEqual([
      `/api/admin/catalog/policies/${ID}/withdraw`,
      expect.objectContaining({ method: 'POST', body: { expectedVersion: 3, reason: 'Retirada documentada' } })
    ])
    expect(refresh).toHaveBeenCalledOnce()
  })
  it('identifies each withdrawal action and the selected policy in its visible confirmation', async () => {
    const page = await render({
      data: payload([policy(), { ...policy(), id: NEW_ID, code: 'other', name: 'Otra política', version: 2 }])
    })
    const actions = page.findAll('button').filter((button) => button.text() === 'Revisar retirada')
    expect(actions.map((button) => button.attributes('aria-label'))).toEqual([
      'Revisar retirada de Política sintética (equipment, versión 3)',
      'Revisar retirada de Otra política (other, versión 2)'
    ])
    await actions[1]!.trigger('click')
    expect(page.findAll('legend').map((legend) => legend.text())).toContain(
      'Confirmar retirada de Otra política (other, versión 2)'
    )
    expect(requestMock).not.toHaveBeenCalled()
  })
  it('retains an ambiguous key/body across GET with advanced version and requires manual exact replay', async () => {
    const page = await render()
    await prepare(page)
    requestMock.mockRejectedValueOnce(new Error('lost response'))
    await invoke(page, 'createPolicy')
    const original = calls()[0]
    refresh.mockImplementationOnce(async () => {
      status.value = 'pending'
      await nextTick()
      data.value = payload([{ ...policy(), version: 4 }])
      status.value = 'success'
    })
    await invoke(page, 'readList')
    expect(requestMock).toHaveBeenCalledOnce()
    Object.assign(form(page), { reason: 'Otro motivo deliberado', name: 'Otro nombre' })
    await invoke(page, 'createPolicy')
    expect(requestMock).toHaveBeenCalledOnce()
    await invoke(page, 'retry')
    expect(calls()[1]).toEqual(original)
    expect(page.text()).toContain('Cambio registrado')
  })
  it.each(['version_conflict', 'policy_in_use', 'forbidden', 'mfa_required', 'idempotency_conflict'])(
    'clears %s intents and requires explicit read before another command',
    async (code) => {
      const page = await render()
      await prepare(page)
      requestMock.mockRejectedValueOnce({ data: { error: { code } } })
      await invoke(page, 'createPolicy')
      await invoke(page, 'retry')
      await invoke(page, 'createPolicy')
      expect(requestMock).toHaveBeenCalledOnce()
      expect(refresh).not.toHaveBeenCalled()
      expect(page.find('[role="alert"]').exists()).toBe(true)
      await invoke(page, 'readList')
      expect(refresh).toHaveBeenCalledOnce()
      expect(page.text()).toContain('Consulta el código exacto antes de crear')
    }
  )
  it('guards concurrent commands, cached revoked callbacks and unmount', async () => {
    const page = await render()
    await prepare(page)
    let resolve: (value: unknown) => void = () => undefined
    requestMock.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done
        })
    )
    const run = (state(page).createPolicy as () => Promise<void>)()
    await nextTick()
    await invoke(page, 'createPolicy')
    await invoke(page, 'readList')
    expect(requestMock).toHaveBeenCalledOnce()
    expect(refresh).not.toHaveBeenCalled()
    page.unmount()
    resolve(receipt())
    await run
    expect(refresh).not.toHaveBeenCalled()
    wrapper = undefined
  })
  it('rechecks live runtime and read capability before a cached mutation callback', async () => {
    const page = await render()
    await prepare(page)
    const callback = state(page).createPolicy as () => Promise<void>
    data.value = { ...payload(), capabilities: { publicationPoliciesRead: true, publicationPoliciesWrite: false } }
    await callback()
    runtime.public.serverRuntime = 'unknown'
    await callback()
    expect(requestMock).not.toHaveBeenCalled()
  })
  it('rejects malformed receipts as ambiguous without claiming success', async () => {
    const page = await render()
    await prepare(page)
    requestMock.mockResolvedValueOnce({ ...receipt(), policyVersion: 5 })
    await invoke(page, 'createPolicy')
    expect(page.text()).not.toContain('Cambio registrado')
    expect(refresh).not.toHaveBeenCalled()
    expect(page.text()).toContain('Reintentar exactamente')
  })
  it('allows one explicit GET retry and recovers an error without writes', async () => {
    const page = await render({ status: 'error' })
    refresh.mockImplementationOnce(async () => {
      status.value = 'pending'
      await nextTick()
      await invoke(page, 'readList')
      status.value = 'success'
    })
    await invoke(page, 'readList')
    expect(refresh).toHaveBeenCalledOnce()
    expect(page.text()).toContain('Política sintética')
    expect(requestMock).not.toHaveBeenCalled()
  })
})

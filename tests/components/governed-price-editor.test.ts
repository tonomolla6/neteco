import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { defineComponent, h, nextTick, proxyRefs, ref, shallowRef } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Editor from '../../app/components/GovernedPriceEditor.vue'
import '#app/nuxt-vitest-app-entry'

const { requestMock, fetchMock, runtimeMock } = vi.hoisted(() => ({
  requestMock: vi.fn(),
  fetchMock: vi.fn(),
  runtimeMock: vi.fn(() => ({
    app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
    public: { serverRuntime: 'cloudflare' }
  }))
}))
mockNuxtImport('$fetch', () => requestMock)
mockNuxtImport('useFetch', () => fetchMock)
mockNuxtImport('useRuntimeConfig', () => runtimeMock)
mockNuxtImport('useUserSession', () => () => ({
  ready: ref(true),
  loggedIn,
  user,
  session: ref(null),
  clear: async () => undefined,
  fetch: async () => undefined,
  openInPopup: () => undefined
}))
const loggedIn = ref(true)
const user = shallowRef<unknown>({ id: 'synthetic-price-admin' })
const VARIANT = 'a3000000-0000-4000-8000-000000000001'
const PRODUCT = 'a3000000-0000-4000-8000-000000000002'
const NEW_PRICE = 'a3000000-0000-4000-8000-000000000003'
const COMMAND = 'a3000000-0000-4000-8000-000000000004'
const HEAD = 'imported price €#1'
const INSTANT = '2030-10-01T09:00:00.000Z'
const version = (id = HEAD) => ({
  id,
  grossCents: 1200,
  compareAtGrossCents: null,
  referenceGrossCents30d: 1000,
  volumeTiers: [],
  validFrom: '2030-10-02T09:00:00.000Z',
  validUntil: null,
  status: 'approved',
  reason: 'Aprobación sintética existente'
})
const item = () => ({
  variantId: VARIANT,
  id: 11,
  sku: 'SKU-PRICE-11',
  format: 'Caja',
  product: 'Producto sintético',
  productId: 1,
  productUuid: PRODUCT,
  catalogVersion: 4,
  currency: 'EUR',
  grossCents: 1000,
  compareAtGrossCents: null,
  referenceGrossCents30d: null,
  volumeTiers: [],
  pricingVersion: `legacy:${VARIANT}`,
  currentPrice: { kind: 'legacy', versionId: null },
  quantityRules: { minimumQuantity: 2, maximumQuantity: 20, quantityIncrement: 2 },
  validFrom: null,
  history: [],
  historyPagination: { page: 1, perPage: 1, total: 1, pages: 1 },
  scheduled: version(),
  latestApproved: version(),
  cancellable: true
})
const payload = () => ({
  source: 'cloudflare',
  capabilities: {
    pricesRead: true,
    priceHistoryRead: true,
    priceSchedulesRead: true,
    priceWrite: false,
    priceSchedule: true,
    priceCancel: true
  },
  items: [item()],
  pricingInstant: INSTANT,
  referenceEvidence: 'available_approved_windows_only',
  pagination: { page: 1, perPage: 1, total: 1, pages: 1 },
  limits: { itemsPerPageMax: 500, historyPerPageMax: 100, returnedVersionRecordsMax: 5000 }
})
const receipt = (action: 'price_schedule' | 'price_cancel' = 'price_schedule') => ({
  source: 'cloudflare',
  action,
  commandId: COMMAND,
  priceId: action === 'price_cancel' ? HEAD : NEW_PRICE,
  variantId: VARIANT,
  variantLegacyId: 11,
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
const Input = defineComponent({
  inheritAttrs: false,
  props: { modelValue: [String, Number] },
  emits: ['update:modelValue'],
  setup:
    (props, { attrs, emit }) =>
    () =>
      h('input', {
        ...attrs,
        value: props.modelValue ?? '',
        onInput: (event: Event) => emit('update:modelValue', (event.target as HTMLInputElement).value)
      })
})
const Field = defineComponent({
  props: { label: String },
  setup:
    (props, { slots }) =>
    () =>
      h('label', [props.label, slots.default?.()])
})
type Wrapper = Awaited<ReturnType<typeof mountSuspended>>
type Props = InstanceType<typeof Editor>['$props']
let wrapper: Wrapper | undefined
let data = shallowRef<unknown>(payload())
let status = ref('success')
let error = shallowRef<unknown>(null)
let refresh = vi.fn<() => Promise<unknown>>()
const state = (page: Wrapper) => proxyRefs(page.setupState) as Record<string, unknown>
const invoke = (page: Wrapper, action: string) => (state(page)[action] as () => Promise<void>)()
const button = (page: Wrapper, text: string) => page.findAll('button').find((entry) => entry.text() === text)!
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (value: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
async function render(overrides: Partial<Props> = {}) {
  const refreshList = vi.fn<() => Promise<unknown>>(async () => undefined)
  const authorize = vi.fn(() => true)
  wrapper = await mountSuspended(Editor, {
    props: { variantLegacyId: 11, runtime: 'cloudflare', authorize, refreshList, ...overrides },
    global: { stubs: { UButton: Button, UInput: Input, UFormField: Field } }
  })
  await flushPromises()
  return { page: wrapper, refreshList, authorize }
}
async function prepare(page: Wrapper) {
  Object.assign(state(page).form as Record<string, unknown>, {
    gross: '12,34',
    compareAt: '15.00',
    validFrom: '2030-10-03T10:00:00',
    reason: 'Cambio de tarifa revisado',
    tiers: [
      { minimumQuantity: '4', unitGross: '11.00' },
      { minimumQuantity: '8', unitGross: '10.50' }
    ]
  })
  await nextTick()
  state(page).confirmed = true
  await nextTick()
}
async function prepareCancel(page: Wrapper) {
  state(page).cancelReason = 'Cancelar la programación revisada'
  await nextTick()
  state(page).cancelConfirmed = true
  await nextTick()
}
// Nuxt may append a generated third argument; the per-request response hook is
// transport observation, not command identity. Compare every financial wire
// field exactly, including the frozen body and idempotency headers.
const calls = () =>
  requestMock.mock.calls.map(([path, options]) => [
    path,
    {
      method: options.method,
      body: options.body,
      headers: options.headers,
      retry: options.retry
    }
  ])
beforeEach(() => {
  data = shallowRef<unknown>(payload())
  status = ref('success')
  error = shallowRef(null)
  loggedIn.value = true
  user.value = { id: 'synthetic-price-admin' }
  requestMock.mockReset().mockResolvedValue(receipt())
  refresh = vi.fn<() => Promise<unknown>>(async () => undefined)
  fetchMock.mockReset().mockReturnValue({ data, status, error, refresh })
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
})

describe('governed financial price commands', () => {
  it('uses an isolated private targeted GET, labelled fields and explicit confirmation without an automatic write', async () => {
    const { page } = await render()
    expect(fetchMock.mock.calls[0]?.slice(0, 2)).toEqual([
      '/api/admin/prices',
      expect.objectContaining({
        key: 'admin-governed-price:11',
        query: { variant: 11, page: 1, perPage: 1, historyPerPage: 1 },
        immediate: true,
        server: true
      })
    ])
    expect(page.text()).toContain('Programar un precio')
    expect(page.text()).toContain('No aprueban la publicación')
    expect(page.text()).toContain('no acreditan un historial completo')
    expect(page.get('label').text()).toContain('Precio con IVA')
    expect(page.findAll('input[type="checkbox"]')).toHaveLength(2)
    expect(button(page, 'Registrar programación').attributes('disabled')).toBeDefined()
    expect(requestMock).not.toHaveBeenCalled()
  })
  it.each(['node', 'unknown', '', undefined])('does not read automatically or write in runtime %s', async (runtime) => {
    const { page } = await render({ runtime })
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ immediate: false, server: false })
    await prepare(page)
    await invoke(page, 'schedule')
    await invoke(page, 'cancel')
    await invoke(page, 'reload')
    expect(requestMock).not.toHaveBeenCalled()
    expect(refresh).not.toHaveBeenCalled()
    expect(page.find('form').exists()).toBe(false)
  })
  it.each(['idle', 'pending', 'error'])(
    'does not confirm cached data or allow callbacks in read state %s',
    async (readState) => {
      status.value = readState
      const { page } = await render()
      await prepare(page)
      await invoke(page, 'schedule')
      await invoke(page, 'cancel')
      expect(page.find('form').exists()).toBe(false)
      expect(requestMock).not.toHaveBeenCalled()
      expect(page.find('[role="status"], [role="alert"]').exists()).toBe(true)
    }
  )
  const poisons: Array<[string, (value: ReturnType<typeof payload>) => unknown]> = [
    ['source', (value) => ({ ...value, source: 'node' })],
    [
      'missing head',
      (value) => {
        const { latestApproved: _head, ...rest } = value.items[0]!
        return { ...value, items: [rest] }
      }
    ],
    ['bad version', (value) => ({ ...value, items: [{ ...value.items[0], catalogVersion: 0 }] })],
    ['foreign numeric identity', (value) => ({ ...value, items: [{ ...value.items[0], id: 12 }] })],
    [
      'contradictory current identity',
      (value) => ({ ...value, items: [{ ...value.items[0], currentPrice: { kind: 'governed', versionId: null } }] })
    ],
    ['contradictory cancellation', (value) => ({ ...value, items: [{ ...value.items[0], cancellable: false }] })],
    ['unsafe instant', (value) => ({ ...value, pricingInstant: '2030-02-30T00:00:00Z' })],
    ['inherited data', (value) => Object.assign(Object.create({ source: 'cloudflare' }), value)],
    [
      'getter',
      (value) =>
        Object.defineProperty(value, 'items', {
          enumerable: true,
          get() {
            throw new Error('never evaluate getter')
          }
        })
    ]
  ]
  it.each(poisons)('hides poisoned %s DTO and blocks programmatic writes', async (_name, poison) => {
    data.value = poison(payload())
    const { page } = await render()
    await prepare(page)
    await invoke(page, 'schedule')
    await invoke(page, 'cancel')
    expect(page.find('form').exists()).toBe(false)
    expect(requestMock).not.toHaveBeenCalled()
  })
  it.each([
    ['missing', undefined],
    ['false', false],
    ['numeric', 1],
    ['string', 'true']
  ])('requires literal narrow capability: %s', async (_name, value) => {
    data.value = { ...payload(), capabilities: { ...payload().capabilities, priceSchedule: value } }
    const { page } = await render()
    await prepare(page)
    await invoke(page, 'schedule')
    expect(requestMock).not.toHaveBeenCalled()
  })
  it('does not let a hostile generic write flag or foreign parent authority authorize a command', async () => {
    data.value = { ...payload(), capabilities: { ...payload().capabilities, priceWrite: true } }
    const { page } = await render({ authorize: () => false })
    await prepare(page)
    await invoke(page, 'schedule')
    expect(requestMock).not.toHaveBeenCalled()
  })
  it('sends exact integer money/tiers and current version/head only after explicit review, then refreshes GET instead of applying a receipt', async () => {
    const { page, refreshList } = await render()
    await prepare(page)
    refresh.mockImplementation(async () => {
      const fresh = payload()
      fresh.items[0]!.latestApproved = version(NEW_PRICE)
      fresh.items[0]!.scheduled = version(NEW_PRICE)
      data.value = fresh
    })
    await invoke(page, 'schedule')
    expect(calls()).toEqual([
      [
        '/api/admin/prices',
        expect.objectContaining({
          method: 'POST',
          retry: 0,
          headers: { Origin: window.location.origin, 'Idempotency-Key': expect.stringMatching(/^[0-9a-f-]{36}$/) },
          body: {
            variantId: VARIANT,
            expectedCatalogVersion: 4,
            expectedLatestApprovedId: HEAD,
            grossCents: 1234,
            compareAtGrossCents: 1500,
            volumeTiers: [
              { minimumQuantity: 4, unitGrossCents: 1100 },
              { minimumQuantity: 8, unitGrossCents: 1050 }
            ],
            validFrom: new Date('2030-10-03T10:00:00').toISOString(),
            reason: 'Cambio de tarifa revisado'
          }
        })
      ]
    ])
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(refreshList).toHaveBeenCalledTimes(1)
    expect(data.value).toMatchObject({
      items: [{ catalogVersion: 4, grossCents: 1000, latestApproved: { id: NEW_PRICE } }]
    })
    expect(page.get('[role="status"]').text()).toContain('recibo no sustituye')
  })
  it.each([
    ['zero', '0'],
    ['float precision', '12.345'],
    ['coercion', '1e2'],
    ['negative', '-1'],
    ['unsafe', '9999999999999999999']
  ])('rejects %s money without a request', async (_name, gross) => {
    const { page } = await render()
    await prepare(page)
    ;(state(page).form as Record<string, unknown>).gross = gross
    await nextTick()
    state(page).confirmed = true
    await invoke(page, 'schedule')
    expect(requestMock).not.toHaveBeenCalled()
    expect(page.find('[role="alert"]').exists()).toBe(true)
  })
  it('requires reason and confirmation and invalidates confirmation after intentional edits', async () => {
    const { page } = await render()
    await prepare(page)
    state(page).confirmed = false
    await invoke(page, 'schedule')
    expect(requestMock).not.toHaveBeenCalled()
    state(page).confirmed = true
    ;(state(page).form as Record<string, unknown>).reason = 'x'
    await nextTick()
    expect(state(page).confirmed).toBe(false)
    state(page).confirmed = true
    await invoke(page, 'schedule')
    expect(requestMock).not.toHaveBeenCalled()
  })
  it('blocks duplicate/inflight callbacks and sends a cancellation only for the exact complete imported head', async () => {
    requestMock.mockResolvedValueOnce(receipt('price_cancel'))
    const { page } = await render()
    await prepareCancel(page)
    await invoke(page, 'cancel')
    expect(calls()[0]).toEqual([
      `/api/admin/prices/${encodeURIComponent(HEAD)}/cancel`,
      expect.objectContaining({
        method: 'POST',
        retry: 0,
        body: { expectedCatalogVersion: 4, expectedLatestApprovedId: HEAD, reason: 'Cancelar la programación revisada' }
      })
    ])
    await prepare(page)
    const pending = deferred<unknown>()
    requestMock.mockReturnValueOnce(pending.promise)
    const first = invoke(page, 'schedule')
    await invoke(page, 'schedule')
    await invoke(page, 'cancel')
    await invoke(page, 'reload')
    expect(requestMock).toHaveBeenCalledTimes(2)
    expect(refresh).toHaveBeenCalledTimes(1)
    pending.resolve(receipt())
    await first
  })
  it('does not authorize cancelling a current head even if cached callbacks remain', async () => {
    const value = payload()
    value.items[0]!.latestApproved.validFrom = INSTANT
    value.items[0]!.cancellable = false
    data.value = { ...value, items: [{ ...value.items[0], scheduled: null }] }
    const { page } = await render()
    await prepareCancel(page)
    await invoke(page, 'cancel')
    expect(requestMock).not.toHaveBeenCalled()
    expect(button(page, 'Cancelar programación').attributes('disabled')).toBeDefined()
  })
  it.each([
    'version_conflict',
    'head_conflict',
    'quantity_conflict',
    'not_cancellable',
    'csrf_rejected',
    'rate_limited'
  ])('blocks new commands after deterministic %s until explicit fresh GET', async (code) => {
    requestMock.mockRejectedValueOnce({ data: { error: { code } } })
    const { page } = await render()
    await prepare(page)
    await invoke(page, 'schedule')
    expect(page.find('[role="alert"]').exists()).toBe(true)
    expect(page.text()).not.toContain('No sabemos')
    expect(button(page, 'Reintentar exactamente este comando')).toBeUndefined()
    await invoke(page, 'schedule')
    await invoke(page, 'cancel')
    expect(requestMock).toHaveBeenCalledTimes(1)
    await invoke(page, 'reload')
    await prepare(page)
    await invoke(page, 'schedule')
    expect(requestMock).toHaveBeenCalledTimes(2)
  })
  it.each(['forbidden', 'mfa_required', 'email_unverified', 'unauthenticated'])(
    'preserves a possible committed intent after %s, blocks all commands until authorized GET and replays the original body/key',
    async (code) => {
      requestMock.mockRejectedValueOnce({ status: code === 'unauthenticated' ? 401 : 403, data: { error: { code } } })
      const { page } = await render()
      await prepare(page)
      await invoke(page, 'schedule')
      const original = calls()[0]
      expect(page.text()).toContain('No sabemos')
      expect(page.find('form').exists()).toBe(false)
      expect(button(page, 'Reintentar exactamente este comando').attributes('disabled')).toBeDefined()
      await invoke(page, 'schedule')
      await invoke(page, 'cancel')
      await invoke(page, 'replay')
      expect(requestMock).toHaveBeenCalledTimes(1)
      expect(refresh).not.toHaveBeenCalled()
      refresh.mockImplementation(async () => {
        const advanced = payload()
        advanced.items[0]!.catalogVersion = 5
        advanced.items[0]!.latestApproved = version(NEW_PRICE)
        data.value = advanced
      })
      await invoke(page, 'reload')
      await invoke(page, 'schedule')
      expect(requestMock).toHaveBeenCalledTimes(1)
      await invoke(page, 'replay')
      expect(calls()[1]).toEqual(original)
    }
  )
  it.each([new Error('synthetic lost response'), { status: 503 }, { status: 501 }])(
    'retains an ambiguous exact command across a later GET with advanced version/head',
    async (failure) => {
      requestMock.mockRejectedValueOnce(failure)
      const { page } = await render()
      await prepare(page)
      await invoke(page, 'schedule')
      const original = calls()[0]
      expect(refresh).not.toHaveBeenCalled()
      expect(page.text()).toContain('No sabemos')
      refresh.mockImplementation(async () => {
        const advanced = payload()
        advanced.items[0]!.catalogVersion = 5
        advanced.items[0]!.latestApproved = version(NEW_PRICE)
        data.value = advanced
      })
      await invoke(page, 'reload')
      expect(requestMock).toHaveBeenCalledTimes(1)
      expect(button(page, 'Registrar programación').attributes('disabled')).toBeDefined()
      await invoke(page, 'replay')
      expect(calls()[1]).toEqual(original)
      expect(requestMock).toHaveBeenCalledTimes(2)
      expect(refresh).toHaveBeenCalledTimes(2)
      expect(data.value).toMatchObject({ items: [{ catalogVersion: 5, grossCents: 1000 }] })
    }
  )
  it.each([
    ['wrong variant', { ...receipt(), variantId: PRODUCT }],
    ['wrong action', { ...receipt(), action: 'price_cancel' }],
    ['legacy-looking new ID', { ...receipt(), priceId: 'not-a-new-uuid' }],
    ['inherited receipt', Object.assign(Object.create({ source: 'cloudflare' }), receipt())],
    ['malformed', { ok: true }]
  ])('does not announce success for %s receipt and permits only exact retry', async (_name, value) => {
    requestMock.mockResolvedValueOnce(value)
    const { page } = await render()
    await prepare(page)
    await invoke(page, 'schedule')
    expect(page.text()).toContain('No sabemos')
    expect(page.text()).not.toContain('Comando registrado')
    expect(refresh).not.toHaveBeenCalled()
    await invoke(page, 'replay')
    expect(calls()[1]).toEqual(calls()[0])
  })
  it('disables cached retry when capability is revoked, preserving the exact original key/body after permission returns', async () => {
    requestMock.mockRejectedValueOnce(new Error('synthetic lost response'))
    const { page } = await render()
    await prepare(page)
    await invoke(page, 'schedule')
    const original = calls()[0]
    const revoked = payload()
    revoked.capabilities.priceSchedule = false
    data.value = revoked
    await nextTick()
    expect(button(page, 'Reintentar exactamente este comando').attributes('disabled')).toBeDefined()
    await invoke(page, 'replay')
    expect(requestMock).toHaveBeenCalledTimes(1)
    data.value = payload()
    await nextTick()
    await invoke(page, 'replay')
    expect(calls()[1]).toEqual(original)
  })
  it('retains a sent command as uncertain when permission changes during the provider await, then manually replays its exact original body/key', async () => {
    const pending = deferred<unknown>()
    requestMock.mockReturnValueOnce(pending.promise)
    const { page } = await render()
    await prepare(page)
    const first = invoke(page, 'schedule')
    const original = calls()[0]
    const revoked = payload()
    revoked.capabilities.priceSchedule = false
    data.value = revoked
    await nextTick()
    pending.reject(new Error('synthetic lost response'))
    await first
    expect(button(page, 'Reintentar exactamente este comando').attributes('disabled')).toBeDefined()
    await invoke(page, 'schedule')
    await invoke(page, 'replay')
    expect(requestMock).toHaveBeenCalledTimes(1)
    data.value = payload()
    await nextTick()
    await invoke(page, 'replay')
    expect(calls()[1]).toEqual(original)
  })
  it('uses the captured own HTTP error envelope without invoking FetchError-style or hostile getters', async () => {
    const getter = vi.fn(() => {
      throw new Error('never evaluate error getter')
    })
    requestMock.mockImplementationOnce(async (_path, options) => {
      options.onResponseError({ response: { _data: { error: { code: 'head_conflict' } } } })
      throw Object.defineProperty(new Error('synthetic response'), 'data', { get: getter })
    })
    const { page } = await render()
    await prepare(page)
    await invoke(page, 'schedule')
    expect(getter).not.toHaveBeenCalled()
    expect(page.text()).toContain('última aprobación ha cambiado')
    expect(page.text()).not.toContain('No sabemos')
    expect(refresh).not.toHaveBeenCalled()
  })
  it('manual GET recovery is guarded against duplicates and never repeats a write after a failed read', async () => {
    error.value = new Error('synthetic cached read failure')
    const { page } = await render()
    const pending = deferred<unknown>()
    refresh.mockReturnValueOnce(pending.promise)
    const first = invoke(page, 'reload')
    await invoke(page, 'reload')
    await invoke(page, 'schedule')
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(requestMock).not.toHaveBeenCalled()
    error.value = null
    status.value = 'success'
    pending.resolve(undefined)
    await first
    await prepare(page)
    await invoke(page, 'schedule')
    expect(requestMock).toHaveBeenCalledTimes(1)
  })
  it.each(['logout', 'actor', 'runtime', 'identity', 'unmount'])(
    'ignores a late receipt after %s authority changes',
    async (change) => {
      const pending = deferred<unknown>()
      requestMock.mockReturnValueOnce(pending.promise)
      const { page, refreshList } = await render()
      await prepare(page)
      const first = invoke(page, 'schedule')
      if (change === 'logout') loggedIn.value = false
      else if (change === 'actor') user.value = { id: 'different-synthetic-actor' }
      else if (change === 'runtime') await page.setProps({ runtime: 'unknown' })
      else if (change === 'identity') await page.setProps({ variantLegacyId: 12 })
      else page.unmount()
      await nextTick()
      pending.resolve(receipt())
      await first
      await invoke(page, 'schedule')
      await invoke(page, 'replay')
      expect(refresh).not.toHaveBeenCalled()
      expect(refreshList).not.toHaveBeenCalled()
      expect(requestMock).toHaveBeenCalledTimes(1)
      if (change !== 'unmount') expect(page.text()).not.toContain('Comando registrado')
    }
  )
})

import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises, type DOMWrapper } from '@vue/test-utils'
import { defineComponent, h, ref, unref, type PropType } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import PricingPage from '../../app/pages/admin/precios.vue'
import type { D1AdminPriceItem, D1AdminPriceVersion, D1AdminPricingList } from '../../workers/catalog/admin-pricing'
import '#app/nuxt-vitest-app-entry'

const { fetchMock, requestMock, toastMock, runtimeMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  requestMock: vi.fn(),
  toastMock: vi.fn(),
  runtimeMock: vi.fn(() => ({
    app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
    public: { serverRuntime: 'cloudflare', baseUrl: 'https://neteco.invalid' }
  }))
}))
mockNuxtImport('useFetch', () => fetchMock)
mockNuxtImport('$fetch', () => requestMock)
mockNuxtImport('useToast', () => () => ({ add: toastMock }))
mockNuxtImport('useRuntimeConfig', () => runtimeMock)
mockNuxtImport('useUserSession', () => () => ({
  ready: ref(true),
  loggedIn: ref(true),
  user: ref({ id: 'synthetic-admin', role: 'admin', mfaVerified: true }),
  session: ref(null),
  clear: async () => undefined,
  openInPopup: () => undefined,
  fetch: async () => undefined
}))

const INSTANT = '2026-08-12T12:00:00.000Z'
const READ_ONLY = {
  pricesRead: true,
  priceHistoryRead: true,
  priceSchedulesRead: true,
  priceWrite: false,
  priceSchedule: false,
  priceCancel: false
} as const
const version = (overrides: Partial<D1AdminPriceVersion> = {}): D1AdminPriceVersion => ({
  id: '22222222-2222-4222-8222-222222222222',
  grossCents: 1310,
  compareAtGrossCents: 1510,
  referenceGrossCents30d: 1110,
  volumeTiers: [{ minimumQuantity: 10, unitGrossCents: 1010 }],
  validFrom: '2026-08-13T12:00:00.000Z',
  validUntil: null,
  status: 'approved',
  reason: 'Campaña aprobada existente',
  ...overrides
})
const item = (overrides: Partial<D1AdminPriceItem> = {}): D1AdminPriceItem => ({
  variantId: '11111111-1111-4111-8111-111111111111',
  id: 11,
  sku: 'SKU-PRICE-11',
  format: 'Caja 6 unidades',
  product: 'Producto privado de prueba',
  currency: 'EUR',
  grossCents: 1210,
  compareAtGrossCents: 1410,
  referenceGrossCents30d: 1110,
  volumeTiers: [{ minimumQuantity: 10, unitGrossCents: 1010 }],
  pricingVersion: 'price-version-1',
  currentPrice: { kind: 'governed', versionId: 'price-version-1' },
  productId: 1,
  productUuid: '33333333-3333-4333-8333-333333333333',
  catalogVersion: 1,
  quantityRules: { minimumQuantity: 1, maximumQuantity: null, quantityIncrement: 1 },
  latestApproved: version(),
  cancellable: true,
  validFrom: '2026-08-01T00:00:00.000Z',
  history: [version()],
  historyPagination: { page: 1, perPage: 20, total: 1, pages: 1 },
  scheduled: version(),
  ...overrides
})
type Payload = Omit<D1AdminPricingList, 'source' | 'capabilities'> & {
  source?: string
  capabilities?: Record<string, unknown>
}
const payload = (overrides: Partial<Payload> = {}): Payload => ({
  source: 'cloudflare',
  capabilities: READ_ONLY,
  items: [item()],
  pagination: { page: 1, perPage: 25, total: 1, pages: 1 },
  pricingInstant: INSTANT,
  referenceEvidence: 'available_approved_windows_only',
  limits: { itemsPerPageMax: 500, historyPerPageMax: 8, returnedVersionRecordsMax: 4500 },
  ...overrides
})
const historyPayload = (overrides: Partial<Payload> = {}): Payload =>
  payload({
    pagination: { page: 1, perPage: 1, total: 1, pages: 1 },
    limits: { itemsPerPageMax: 500, historyPerPageMax: 100, returnedVersionRecordsMax: 101 },
    ...overrides
  })
const money = (cents: number, currency = 'EUR') =>
  new Intl.NumberFormat('es-ES', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(cents / 100)

const Header = defineComponent({
  props: { title: String, description: String, count: Number },
  setup(props) {
    return () => h('header', { 'data-count': props.count }, [h('h1', props.title), h('p', props.description)])
  }
})
const Slot = defineComponent({
  setup:
    (_, { slots }) =>
    () =>
      h('span', slots.default?.())
})
const Alert = defineComponent({
  props: { title: String, description: String },
  setup: (props) => () => h('aside', [h('strong', props.title), h('p', props.description)])
})
const Button = defineComponent({
  inheritAttrs: false,
  props: { disabled: Boolean, loading: Boolean },
  setup(props, { attrs, slots }) {
    return () =>
      h(
        'button',
        {
          ...attrs,
          type: attrs.type ?? 'button',
          disabled: props.disabled || props.loading,
          'data-loading': String(props.loading)
        },
        slots.default?.()
      )
  }
})
const Input = defineComponent({
  inheritAttrs: false,
  props: { modelValue: [String, Number] },
  emits: ['update:modelValue'],
  setup(props, { attrs, emit }) {
    return () =>
      h('input', {
        ...attrs,
        value: props.modelValue ?? '',
        onInput: (event: Event) => emit('update:modelValue', (event.target as HTMLInputElement).value)
      })
  }
})
const Field = defineComponent({
  props: { label: String },
  setup:
    (props, { slots }) =>
    () =>
      h('label', { 'data-field': props.label }, [props.label, slots.default?.()])
})
const Modal = defineComponent({
  props: { open: Boolean, title: String },
  emits: ['update:open'],
  setup(props, { slots, emit }) {
    return () =>
      props.open
        ? h('dialog', { open: true, 'data-title': props.title }, [
            h('h2', props.title),
            slots.body?.(),
            slots.footer?.(),
            h('button', { onClick: () => emit('update:open', false) }, 'Cerrar modal')
          ])
        : null
  }
})
const Governed = defineComponent({
  props: { variantLegacyId: Number, runtime: String, authorize: Function, refreshList: Function },
  setup: (props) => () => h('section', { 'data-governed': props.variantLegacyId }, 'Editor D1 separado')
})
type Column = { key: string; hideOnMobile?: boolean }
const Table = defineComponent({
  props: {
    rows: { type: Array as PropType<D1AdminPriceItem[]>, default: () => [] },
    columns: { type: Array as PropType<Column[]>, default: () => [] },
    page: Number,
    perPage: Number,
    total: Number,
    status: String,
    emptyTitle: String,
    errorMessage: String
  },
  emits: ['update:page', 'search', 'retry'],
  setup(props, { emit, slots }) {
    return () =>
      h(
        'section',
        {
          'data-table': '',
          'data-page': props.page,
          'data-per-page': props.perPage,
          'data-total': props.total,
          'data-status': props.status
        },
        [
          h('input', {
            'aria-label': 'Buscar tarifa',
            onInput: (event: Event) => emit('search', (event.target as HTMLInputElement).value)
          }),
          props.status === 'pending'
            ? h('p', { role: 'status' }, 'Cargando tarifa')
            : props.status === 'error'
              ? h('div', { role: 'alert' }, [
                  props.errorMessage,
                  h('button', { onClick: () => emit('retry') }, 'Reintentar')
                ])
              : props.rows.length
                ? props.rows.map((row) =>
                    h('article', { 'data-row': row.variantId }, [
                      ...props.columns.map((column) =>
                        h(
                          'div',
                          {
                            'data-cell': column.key,
                            'data-hide-mobile': String(column.hideOnMobile ?? false)
                          },
                          slots[`cell-${column.key}`]?.({ row })
                        )
                      ),
                      slots['row-actions']?.({ row })
                    ])
                  )
                : h('p', props.emptyTitle),
          h(
            'button',
            { disabled: (props.page ?? 1) <= 1, onClick: () => emit('update:page', (props.page ?? 1) - 1) },
            'Página anterior'
          ),
          h(
            'button',
            {
              disabled: (props.page ?? 1) * (props.perPage ?? 25) >= (props.total ?? 0),
              onClick: () => emit('update:page', (props.page ?? 1) + 1)
            },
            'Página siguiente'
          )
        ]
      )
  }
})

type Page = Awaited<ReturnType<typeof mountSuspended>>
type Scope = { findAll(selector: string): DOMWrapper<Element>[] }
let wrapper: Page | undefined
async function render(
  options: {
    runtime?: string
    data?: Payload | { items: D1AdminPriceItem[] } | null
    status?: string
  } = {}
) {
  runtimeMock.mockReturnValue({
    app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
    public: { serverRuntime: options.runtime ?? 'cloudflare', baseUrl: 'https://neteco.invalid' }
  })
  const data = ref(options.data === undefined ? payload() : options.data)
  const status = ref(options.status ?? 'success')
  const refresh = vi.fn().mockResolvedValue(undefined)
  fetchMock.mockReturnValue({ data, status, refresh, error: ref(null) })
  wrapper = await mountSuspended(PricingPage, {
    global: {
      stubs: {
        UiPageHeader: Header,
        UiDataTable: Table,
        UButton: Button,
        UAlert: Alert,
        UBadge: Slot,
        UIcon: true,
        UInput: Input,
        UFormField: Field,
        UModal: Modal,
        GovernedPriceEditor: Governed
      }
    }
  })
  return { page: wrapper, data, refresh }
}
function button(scope: Scope, text: string) {
  const target = scope.findAll('button').find((candidate) => candidate.text() === text)
  if (!target) throw new Error(`Missing button: ${text}`)
  return target
}
const historyDialog = (page: Page) => page.get('dialog[data-title="Histórico de precios"]')
const queryParameters = () => unref(fetchMock.mock.calls[0]![1].query)
async function viewHistory(page: Page, sku = 'SKU-PRICE-11') {
  await button(page, `Ver histórico de ${sku}`).trigger('click')
  await flushPromises()
  return historyDialog(page)
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((fulfil) => {
    resolve = fulfil
  })
  return { promise, resolve }
}

describe('Cloudflare administrative pricing consultation', () => {
  beforeEach(() => {
    fetchMock.mockReset()
    requestMock.mockReset().mockResolvedValue(historyPayload())
    toastMock.mockReset()
  })
  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
  })

  it('shows real current, compare, reference, volume and scheduled prices without write controls', async () => {
    const { page } = await render()
    expect(page.text()).toContain('Tarifa D1 gobernada')
    expect(page.text()).toContain('Producto privado de prueba')
    expect(page.text()).toContain('SKU-PRICE-11')
    expect(page.get('[data-cell="grossCents"]').text()).toContain(money(1210))
    expect(page.get('[data-cell="grossCents"]').text()).toContain(money(1410))
    expect(page.get('[data-cell="referenceGrossCents30d"]').text()).toContain(money(1110))
    expect(page.get('[data-cell="volumeTiers"]').text()).toContain(`≥ 10: ${money(1010)}/ud`)
    expect(page.get('[data-cell="scheduled"]').text()).toContain(money(1310))
    expect(page.get('[data-cell="volumeTiers"]').attributes('data-hide-mobile')).toBe('false')
    expect(page.get('[data-cell="referenceGrossCents30d"]').attributes('data-hide-mobile')).toBe('false')
    expect(page.text()).toContain('en esta página')
    expect(page.findAll('button').some((candidate) => /^(Programar|Cancelar|Editar)/.test(candidate.text()))).toBe(
      false
    )
    expect(page.find('form').exists()).toBe(false)
    expect(requestMock).not.toHaveBeenCalled()
  })

  it.each([
    ['missing', undefined],
    ['empty', {}],
    ['negative', { pricesRead: false }],
    ['non-boolean', { pricesRead: 'true' }]
  ] satisfies Array<[string, Record<string, unknown> | undefined]>)(
    'fails closed for %s read capabilities rather than showing hostile private rows',
    async (_, capabilities) => {
      const { page } = await render({ data: payload({ capabilities }) })
      expect(page.text()).toContain('Consulta de precios no disponible')
      expect(page.text()).not.toContain('Producto privado de prueba')
      expect(page.find('[data-row]').exists()).toBe(false)
      expect(page.find('dialog').exists()).toBe(false)
      expect(page.get('[data-table]').attributes('data-total')).toBe('0')
      expect(requestMock).not.toHaveBeenCalled()
    }
  )

  it.each([undefined, 'node', 'untrusted'])(
    'does not treat source %s as a Cloudflare read contract',
    async (source) => {
      const { page } = await render({ data: payload({ source }) })
      expect(page.find('[data-row]').exists()).toBe(false)
      expect(page.text()).not.toContain('SKU-PRICE-11')
    }
  )

  it('never turns broad hostile write capabilities into legacy Cloudflare scheduling or cancellation callbacks', async () => {
    const { page } = await render({
      data: payload({ capabilities: { ...READ_ONLY, priceWrite: true, priceSchedule: true, priceCancel: true } })
    })
    const history = await viewHistory(page)
    expect(history.text()).toContain('Campaña aprobada existente')
    expect(page.findAll('button').some((candidate) => /^(Programar|Cancelar|Editar)/.test(candidate.text()))).toBe(
      false
    )
    expect(
      requestMock.mock.calls.every(([url, options]) => url === '/api/admin/prices' && options.method === 'GET')
    ).toBe(true)
  })
  it('opens only the separate narrow editor and rechecks parent read/capability authority for every retained callback', async () => {
    const grants = { ...READ_ONLY, priceSchedule: true, priceCancel: true }
    const { page, data, refresh } = await render({ data: payload({ capabilities: grants }) })
    await button(page, 'Gestionar vigencias').trigger('click')
    const child = page.getComponent(Governed)
    expect(child.props()).toMatchObject({ variantLegacyId: 11, runtime: 'cloudflare' })
    const authorize = child.props('authorize') as (
      identity: { variantId: string; variantLegacyId: number; productUuid: string },
      action?: string
    ) => boolean
    const identity = { variantId: item().variantId, variantLegacyId: 11, productUuid: item().productUuid }
    expect(authorize(identity, 'price_schedule')).toBe(true)
    expect(authorize(identity, 'price_cancel')).toBe(true)
    expect(authorize({ ...identity, variantLegacyId: 12 }, 'price_schedule')).toBe(false)
    data.value = payload({ capabilities: READ_ONLY })
    await flushPromises()
    expect(authorize(identity, 'price_schedule')).toBe(false)
    expect(authorize(identity, 'price_cancel')).toBe(false)
    data.value = payload({ capabilities: grants, items: [item({ catalogVersion: 2 })] })
    await flushPromises()
    expect(authorize(identity, 'price_schedule')).toBe(true) // Recovery of an exact historical command, not a new version.
    data.value = payload({
      capabilities: grants,
      items: [item({ productUuid: 'a4000000-0000-4000-8000-000000000099' })]
    })
    await flushPromises()
    expect(authorize({ ...identity, productUuid: 'a4000000-0000-4000-8000-000000000099' }, 'price_schedule')).toBe(
      false
    )
    data.value = payload({ capabilities: grants })
    await flushPromises()
    await child.props('refreshList')()
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(requestMock).not.toHaveBeenCalled()
    expect(page.findAll('button').some((candidate) => candidate.text() === 'Programar')).toBe(false)
  })
  it.each(['idle', 'pending', 'error'])('does not offer the narrow editor from cached %s reads', async (status) => {
    const { page } = await render({
      status,
      data: payload({ capabilities: { ...READ_ONLY, priceSchedule: true, priceCancel: true } })
    })
    expect(page.findAll('button').some((candidate) => candidate.text() === 'Gestionar vigencias')).toBe(false)
    expect(page.findComponent(Governed).exists()).toBe(false)
    expect(requestMock).not.toHaveBeenCalled()
  })
  it('does not treat an unknown runtime as legacy Node authorization', async () => {
    const { page } = await render({
      runtime: 'unknown',
      data: payload({ capabilities: { ...READ_ONLY, priceSchedule: true, priceCancel: true } })
    })
    expect(page.find('[data-row]').exists()).toBe(false)
    expect(page.findAll('button').some((candidate) => /Programar|Gestionar vigencias/.test(candidate.text()))).toBe(
      false
    )
    expect(requestMock).not.toHaveBeenCalled()
  })

  it('honors independent history and schedule read capabilities', async () => {
    const { page } = await render({ data: payload({ capabilities: { pricesRead: true } }) })
    expect(page.text()).toContain('SKU-PRICE-11')
    expect(page.find('[data-cell="scheduled"]').exists()).toBe(false)
    expect(page.findAll('button').some((candidate) => candidate.text().startsWith('Ver histórico'))).toBe(false)
    expect(page.text()).not.toContain('Campaña aprobada existente')
    expect(requestMock).not.toHaveBeenCalled()
  })

  it('uses real currency and does not falsely label non-EUR amounts as euros', async () => {
    requestMock.mockResolvedValue(historyPayload({ items: [item({ currency: 'USD' })] }))
    const { page } = await render({ data: payload({ items: [item({ currency: 'USD' })] }) })
    expect(page.get('[data-cell="grossCents"]').text()).toContain(money(1210, 'USD'))
    expect(page.get('[data-row]').text()).not.toContain('€')
    const history = await viewHistory(page)
    expect(history.text()).toContain(money(1310, 'USD'))
    expect(history.text()).not.toContain('€')
  })

  it('does not invent currency or a validity date for incomplete legacy metadata', async () => {
    const incomplete = item({ validFrom: null })
    delete (incomplete as Partial<D1AdminPriceItem>).currency
    const { page } = await render({ data: payload({ items: [incomplete] }) })
    expect(page.get('[data-cell="grossCents"]').text()).toContain('Precio base sin fecha de vigencia registrada')
    expect(page.get('[data-cell="grossCents"]').text()).toContain('moneda no disponible')
    expect(page.get('[data-row]').text()).not.toContain('€')
    expect(page.text()).not.toContain('Invalid Date')
  })

  it('uses scheduled from the entire governed history rather than the displayed bounded history page', async () => {
    const distant = version({ grossCents: 9910, validFrom: '2027-01-01T12:00:00.000Z' })
    const { page } = await render({ data: payload({ items: [item({ history: [distant], scheduled: version() })] }) })
    expect(page.get('[data-cell="scheduled"]').text()).toContain(money(1310))
    expect(page.get('[data-cell="scheduled"]').text()).not.toContain(money(9910))
  })

  it('does not infer a scheduled price from history when the authoritative scheduled field is null', async () => {
    const { page } = await render({ data: payload({ items: [item({ scheduled: null })] }) })
    expect(page.get('[data-cell="scheduled"]').text()).toBe('—')
    expect(page.text()).not.toContain('un cambio de precio programado')
  })

  it('paginates against the server total and never applies a second client slice to a server page', async () => {
    const { page, data } = await render({
      data: payload({ pagination: { page: 1, perPage: 25, total: 51, pages: 3 } })
    })
    expect(queryParameters()).toEqual({ q: undefined, page: 1, perPage: 25 })
    expect(page.get('header').attributes('data-count')).toBe('51')
    await button(page, 'Página siguiente').trigger('click')
    expect(queryParameters()).toEqual({ q: undefined, page: 2, perPage: 25 })
    data.value = payload({
      items: [item({ sku: 'SKU-PAGE-2' })],
      pagination: { page: 2, perPage: 25, total: 51, pages: 3 }
    })
    await flushPromises()
    expect(page.text()).toContain('SKU-PAGE-2')
    expect(page.findAll('[data-row]')).toHaveLength(1)
    await page.get('[aria-label="Buscar tarifa"]').setValue('Producto 100%')
    expect(queryParameters()).toEqual({ q: 'Producto 100%', page: 1, perPage: 25 })
  })

  it('fetches fresh history using the same GET route and canonical legacy variant selector only', async () => {
    const { page } = await render()
    const history = await viewHistory(page)
    expect(requestMock).toHaveBeenCalledWith('/api/admin/prices', {
      method: 'GET',
      query: { variant: 11, page: 1, perPage: 1, historyPage: 1, historyPerPage: 20 }
    })
    expect(history.text()).toContain('Campaña aprobada existente')
    expect(history.text()).toContain('Programado')
    expect(history.text()).toContain(`Anterior: ${money(1510)}`)
    expect(history.text()).toContain(`Ref. 30 días: ${money(1110)}`)
    expect(history.text()).toContain(`≥ 10: ${money(1010)}/ud`)
    expect(history.text()).toContain('1 versión · página 1 de 1')
    expect(button(history, 'Histórico anterior').attributes('disabled')).toBeDefined()
    expect(button(history, 'Histórico siguiente').attributes('disabled')).toBeDefined()
  })

  it('paginates full history independently of the list and retains cancelled evidence without a cancel button', async () => {
    requestMock.mockResolvedValueOnce(
      historyPayload({ items: [item({ historyPagination: { page: 1, perPage: 20, total: 35, pages: 2 } })] })
    )
    requestMock.mockResolvedValueOnce(
      historyPayload({
        items: [
          item({
            history: [version({ status: 'cancelled', reason: 'Precio cancelado existente' })],
            historyPagination: { page: 2, perPage: 20, total: 35, pages: 2 }
          })
        ]
      })
    )
    const { page } = await render()
    const history = await viewHistory(page)
    await button(history, 'Histórico siguiente').trigger('click')
    await flushPromises()
    expect(requestMock.mock.calls[1]![1].query).toEqual({
      variant: 11,
      page: 1,
      perPage: 1,
      historyPage: 2,
      historyPerPage: 20
    })
    expect(history.text()).toContain('35 versiones · página 2 de 2')
    expect(history.text()).toContain('Precio cancelado existente')
    expect(history.text()).toContain('Cancelado')
    expect(button(history, 'Histórico siguiente').attributes('disabled')).toBeDefined()
    expect(button(history, 'Histórico anterior').attributes('disabled')).toBeUndefined()
    expect(queryParameters().page).toBe(1)
    expect(history.findAll('button').some((candidate) => candidate.text() === 'Cancelar')).toBe(false)
  })

  it('shows fresh-history loading rather than falsely displaying the list snapshot as a complete history', async () => {
    const pending = deferred<Payload>()
    requestMock.mockReturnValueOnce(pending.promise)
    const { page } = await render()
    await button(page, 'Ver histórico de SKU-PRICE-11').trigger('click')
    const history = historyDialog(page)
    expect(history.get('[role="status"]').text()).toContain('Cargando el histórico')
    expect(history.text()).not.toContain('Campaña aprobada existente')
    pending.resolve(historyPayload())
    await flushPromises()
    expect(history.find('[role="status"]').exists()).toBe(false)
    expect(history.text()).toContain('Campaña aprobada existente')
  })

  it('shows a sanitized history failure and retries the same requested history page', async () => {
    requestMock.mockResolvedValueOnce(
      historyPayload({ items: [item({ historyPagination: { page: 1, perPage: 20, total: 35, pages: 2 } })] })
    )
    requestMock.mockRejectedValueOnce(new Error('SQL private table names'))
    requestMock.mockResolvedValueOnce(
      historyPayload({ items: [item({ historyPagination: { page: 2, perPage: 20, total: 35, pages: 2 } })] })
    )
    const { page } = await render()
    const history = await viewHistory(page)
    await button(history, 'Histórico siguiente').trigger('click')
    await flushPromises()
    expect(history.get('[role="alert"]').text()).toContain('No hemos podido cargar el histórico')
    expect(history.text()).not.toContain('SQL private table names')
    await button(history, 'Reintentar histórico').trigger('click')
    await flushPromises()
    expect(requestMock.mock.calls[2]![1].query.historyPage).toBe(2)
    expect(history.text()).toContain('página 2 de 2')
  })

  it.each([
    historyPayload({ source: undefined }),
    historyPayload({ capabilities: { pricesRead: true, priceHistoryRead: false } }),
    historyPayload({
      items: [item({ variantId: '33333333-3333-4333-8333-333333333333', product: 'Other private product' })]
    }),
    historyPayload({ items: [item({ id: 999 })] })
  ])('fails closed for a mismatched or unauthorized fresh history response', async (response) => {
    requestMock.mockResolvedValueOnce(response)
    const { page } = await render()
    const history = await viewHistory(page)
    expect(history.find('[role="alert"]').exists()).toBe(true)
    expect(history.text()).not.toContain('Campaña aprobada existente')
    expect(history.text()).not.toContain('Other private product')
  })

  it('closes and discards a pending history result when read capability is revoked', async () => {
    const pending = deferred<Payload>()
    requestMock.mockReturnValueOnce(pending.promise)
    const { page, data } = await render()
    await button(page, 'Ver histórico de SKU-PRICE-11').trigger('click')
    expect(page.find('dialog').exists()).toBe(true)
    data.value = payload({ capabilities: { pricesRead: true, priceHistoryRead: false } })
    await flushPromises()
    expect(page.find('dialog').exists()).toBe(false)
    pending.resolve(historyPayload())
    await flushPromises()
    expect(page.find('dialog').exists()).toBe(false)
    expect(page.text()).not.toContain('Campaña aprobada existente')
  })

  it('ignores the response of a closed history dialog instead of reopening it', async () => {
    const pending = deferred<Payload>()
    requestMock.mockReturnValueOnce(pending.promise)
    const { page } = await render()
    await button(page, 'Ver histórico de SKU-PRICE-11').trigger('click')
    await button(historyDialog(page), 'Cerrar histórico').trigger('click')
    pending.resolve(historyPayload())
    await flushPromises()
    expect(page.find('dialog').exists()).toBe(false)
  })

  it('does not let a late response from one variant replace the newly opened variant history', async () => {
    const pending = deferred<Payload>()
    const second = item({
      id: 12,
      variantId: '33333333-3333-4333-8333-333333333333',
      sku: 'SKU-PRICE-12',
      product: 'Segundo producto',
      history: [version({ reason: 'Histórico de la segunda referencia' })]
    })
    requestMock.mockReturnValueOnce(pending.promise)
    requestMock.mockResolvedValueOnce(historyPayload({ items: [second] }))
    const { page } = await render({ data: payload({ items: [item(), second] }) })
    await button(page, 'Ver histórico de SKU-PRICE-11').trigger('click')
    await button(historyDialog(page), 'Cerrar histórico').trigger('click')
    const history = await viewHistory(page, 'SKU-PRICE-12')
    expect(requestMock.mock.calls[1]![1].query.variant).toBe(12)
    expect(history.text()).toContain('Histórico de la segunda referencia')
    pending.resolve(historyPayload())
    await flushPromises()
    expect(history.text()).toContain('Histórico de la segunda referencia')
    expect(history.text()).not.toContain('Campaña aprobada existente')
    expect(history.text()).not.toContain('SKU-PRICE-11')
  })

  it('removes existing private rows and an open history when the general read capability is revoked', async () => {
    const { page, data } = await render()
    await viewHistory(page)
    data.value = payload({ capabilities: { ...READ_ONLY, pricesRead: false } })
    await flushPromises()
    expect(page.find('[data-row]').exists()).toBe(false)
    expect(page.find('dialog').exists()).toBe(false)
    expect(page.text()).not.toContain('SKU-PRICE-11')
    expect(page.text()).not.toContain('Campaña aprobada existente')
  })

  it('shows an honest empty history rather than inventing changes', async () => {
    requestMock.mockResolvedValueOnce(
      historyPayload({
        items: [item({ history: [], historyPagination: { page: 1, perPage: 20, total: 0, pages: 0 } })]
      })
    )
    const { page } = await render()
    const history = await viewHistory(page)
    expect(history.text()).toContain('Esta referencia no tiene cambios de precio todavía')
    expect(history.text()).toContain('0 versiones · página 1 de 1')
    expect(history.text()).not.toContain('Campaña aprobada existente')
  })

  it.each(['pending', 'error'])(
    'preserves the list %s state and does not display stale private rows',
    async (status) => {
      const { page, refresh } = await render({ status, data: null })
      expect(page.get('[data-table]').attributes('data-status')).toBe(status)
      expect(page.find('[data-row]').exists()).toBe(false)
      if (status === 'error') {
        expect(page.get('[role="alert"]').text()).toContain('No hemos podido cargar la tarifa')
        await button(page, 'Reintentar').trigger('click')
        expect(refresh).toHaveBeenCalledOnce()
      } else {
        expect(page.find('[role="status"]').exists()).toBe(true)
      }
      expect(requestMock).not.toHaveBeenCalled()
    }
  )

  it('preserves Node scheduling, cent conversion, tiers and legacy POST contract without capability metadata', async () => {
    requestMock.mockResolvedValueOnce({ ok: true })
    const { page, refresh } = await render({ runtime: 'node', data: { items: [item()] } })
    expect(page.text()).not.toContain('Tarifa D1 en modo consulta')
    expect(queryParameters()).toEqual({ q: undefined })
    await button(page, 'Programar').trigger('click')
    const form = page.get('dialog[data-title="Programar un precio"]')
    await form.get('[data-field="Nuevo precio (IVA incluido)"] input').setValue('14.50')
    await form.get('[data-field="Precio anterior"] input').setValue('17.50')
    await form.get('[data-field="Vigente desde"] input').setValue('2099-08-13T12:00')
    await form.get('[data-field="Motivo"] input').setValue('Campaña Node')
    await form.get('form').trigger('submit')
    await flushPromises()
    expect(requestMock).toHaveBeenCalledWith('/api/admin/prices', {
      method: 'POST',
      body: {
        variantId: item().variantId,
        grossCents: 1450,
        compareAtGrossCents: 1750,
        volumeTiers: [{ minimumQuantity: 10, unitGrossCents: 1010 }],
        validFrom: new Date('2099-08-13T12:00').toISOString(),
        reason: 'Campaña Node'
      }
    })
    expect(refresh).toHaveBeenCalledOnce()
    expect(page.find('dialog[data-title="Programar un precio"]').exists()).toBe(false)
  })

  it('preserves Node embedded history and future cancellation without requesting a new GET route', async () => {
    requestMock.mockResolvedValueOnce({ ok: true })
    const future = version({ validFrom: '2099-08-13T12:00:00.000Z' })
    const { page, refresh } = await render({ runtime: 'node', data: { items: [item({ history: [future] })] } })
    const history = await viewHistory(page)
    expect(requestMock).not.toHaveBeenCalled()
    await button(history, 'Cancelar').trigger('click')
    const cancellation = page.get('dialog[data-title="Cancelar el precio programado"]')
    await cancellation.get('input').setValue(' ab ')
    await button(cancellation, 'Cancelar programación').trigger('click')
    expect(requestMock).not.toHaveBeenCalled()
    await cancellation.get('input').setValue('  Campaña aplazada  ')
    await button(cancellation, 'Cancelar programación').trigger('click')
    await flushPromises()
    expect(requestMock).toHaveBeenCalledWith(`/api/admin/prices/${future.id}/cancel`, {
      method: 'POST',
      body: { reason: 'Campaña aplazada' }
    })
    expect(refresh).toHaveBeenCalledOnce()
    expect(page.find('dialog').exists()).toBe(false)
  })

  it('preserves Node optional compare price and empty volume tiers rather than inventing values', async () => {
    requestMock.mockResolvedValueOnce({ ok: true })
    const { page } = await render({
      runtime: 'node',
      data: { items: [item({ compareAtGrossCents: null, volumeTiers: [] })] }
    })
    await button(page, 'Programar').trigger('click')
    const form = page.get('dialog[data-title="Programar un precio"]')
    await form.get('[data-field="Vigente desde"] input').setValue('2099-08-13T12:00')
    await form.get('[data-field="Motivo"] input').setValue('Nueva tarifa')
    await form.get('form').trigger('submit')
    await flushPromises()
    expect(requestMock.mock.calls[0]![1].body.compareAtGrossCents).toBeNull()
    expect(requestMock.mock.calls[0]![1].body.volumeTiers).toEqual([])
  })

  it('preserves Node schedule error feedback, form contents and retry without pretending success', async () => {
    requestMock.mockRejectedValueOnce({ data: { statusMessage: 'No se ha podido programar' } })
    const { page, refresh } = await render({ runtime: 'node', data: { items: [item()] } })
    await button(page, 'Programar').trigger('click')
    const form = page.get('dialog[data-title="Programar un precio"]')
    await form.get('[data-field="Vigente desde"] input').setValue('2099-08-13T12:00')
    await form.get('[data-field="Motivo"] input').setValue('Campaña a revisar')
    await form.get('form').trigger('submit')
    await flushPromises()
    expect(page.find('dialog[data-title="Programar un precio"]').exists()).toBe(true)
    expect((form.get('[data-field="Motivo"] input').element as HTMLInputElement).value).toBe('Campaña a revisar')
    expect(button(form, 'Programar precio').attributes('data-loading')).toBe('false')
    expect(refresh).not.toHaveBeenCalled()
    expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ color: 'error' }))
  })

  it('preserves Node scheduling loading while suppressing duplicate submission', async () => {
    const pending = deferred<{ ok: boolean }>()
    requestMock.mockReturnValueOnce(pending.promise)
    const { page } = await render({ runtime: 'node', data: { items: [item()] } })
    await button(page, 'Programar').trigger('click')
    const form = page.get('dialog[data-title="Programar un precio"]')
    await form.get('[data-field="Vigente desde"] input').setValue('2099-08-13T12:00')
    await form.get('[data-field="Motivo"] input').setValue('Campaña a revisar')
    await form.get('form').trigger('submit')
    expect(button(form, 'Programar precio').attributes('data-loading')).toBe('true')
    await form.get('form').trigger('submit')
    expect(requestMock).toHaveBeenCalledOnce()
    pending.resolve({ ok: true })
    await flushPromises()
    expect(page.find('dialog[data-title="Programar un precio"]').exists()).toBe(false)
  })

  it('preserves the Node client-side 25-row pagination and derives upcoming versions from embedded history', async () => {
    const future = version({ grossCents: 9910, validFrom: '2099-08-13T12:00:00.000Z' })
    const rows = Array.from({ length: 26 }, (_, index) =>
      item({
        variantId: `node-variant-${index + 1}`,
        id: index + 1,
        sku: `SKU-NODE-${index + 1}`,
        history: [future],
        scheduled: null
      })
    )
    const { page } = await render({ runtime: 'node', data: { items: rows } })
    expect(page.findAll('[data-row]')).toHaveLength(25)
    expect(page.find('[data-row="node-variant-26"]').exists()).toBe(false)
    expect(page.findAll('[data-cell="scheduled"]')[0]!.text()).toContain(money(9910))
    await button(page, 'Página siguiente').trigger('click')
    expect(page.findAll('[data-row]')).toHaveLength(1)
    expect(page.text()).toContain('SKU-NODE-26')
    expect(queryParameters()).toEqual({ q: undefined })
  })
})

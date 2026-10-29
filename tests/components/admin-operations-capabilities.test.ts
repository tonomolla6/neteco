import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises, type DOMWrapper } from '@vue/test-utils'
import { defineComponent, h, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import OperationsPage from '../../app/pages/admin/operaciones.vue'
import '#app/nuxt-vitest-app-entry'

const { fetchMock, requestMock, toastMock, runtimeMock, navigationMock, sessionMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  requestMock: vi.fn(),
  toastMock: vi.fn(),
  navigationMock: vi.fn(),
  sessionMock: vi.fn(),
  runtimeMock: vi.fn(() => ({
    app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
    public: { serverRuntime: 'node', baseUrl: 'https://neteco.invalid' }
  }))
}))
vi.mock('../../app/composables/useAdminNavigation', () => ({ useAdminNavigation: () => navigationMock() }))
mockNuxtImport('useFetch', () => fetchMock)
mockNuxtImport('$fetch', () => requestMock)
mockNuxtImport('useToast', () => () => ({ add: toastMock }))
mockNuxtImport('useRuntimeConfig', () => runtimeMock)
mockNuxtImport('useUserSession', () => () => sessionMock())
const CalendarPanel = defineComponent({
  props: { scopeKey: String, enabled: Boolean, pending: Boolean },
  template: '<section data-calendar-mount :data-enabled="String(enabled)" :data-scope="scopeKey" />'
})
const CommunicationPanel = defineComponent({
  props: { scopeKey: String, enabled: Boolean, pending: Boolean },
  emits: ['pending'],
  template:
    '<section data-communication-mount :data-enabled="String(enabled)" :data-scope="scopeKey" :data-pending="String(pending)" />'
})
const passthrough = defineComponent({ template: '<section><slot /><slot name="actions" /></section>' })
const Header = defineComponent({
  props: { title: String, description: String },
  setup:
    (props, { slots }) =>
    () =>
      h('header', [h('h1', props.title), h('p', props.description), slots.actions?.()])
})
const EmptyState = defineComponent({
  props: { title: String, description: String, variant: String },
  setup(props, { slots }) {
    return () =>
      h('div', { 'data-state': props.variant ?? 'empty', role: props.variant === 'error' ? 'alert' : undefined }, [
        props.title,
        props.description,
        slots.default?.()
      ])
  }
})
const Button = defineComponent({
  inheritAttrs: false,
  props: { disabled: Boolean, loading: Boolean },
  setup:
    (props, { attrs, slots }) =>
    () =>
      h(
        'button',
        { ...attrs, type: 'button', disabled: props.disabled || props.loading, 'data-loading': String(props.loading) },
        slots.default?.()
      )
})
const Input = defineComponent({
  inheritAttrs: false,
  props: { modelValue: String },
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
      h('label', { 'data-field': props.label }, [props.label, slots.default?.()])
})
const Modal = defineComponent({
  props: { open: Boolean, title: String },
  emits: ['update:open'],
  setup:
    (props, { slots, emit }) =>
    () =>
      props.open
        ? h('dialog', { open: true }, [
            h('h2', props.title),
            slots.body?.(),
            slots.footer?.(),
            h('button', { onClick: () => emit('update:open', false) }, 'Cerrar modal')
          ])
        : null
})
const Alert = defineComponent({
  props: { title: String, description: String },
  setup: (props) => () => h('aside', [h('strong', props.title), h('p', props.description)])
})

type Payload = {
  source?: string
  generatedAt: string
  summary: Record<string, unknown>
  capabilities?: Record<string, unknown>
  queues: Array<{ eventType: string; status: string; depth: number; oldestAt: string; maxAttempts: number }>
  deadLetters: Array<{
    id: string
    eventType: string
    attempts: number
    errorCode: string | null
    errorMessage: string
    createdAt: string
  }>
  bankTransfers: Array<{
    id: string
    externalId: string
    bookedAt: string
    amountCents: number
    currency: string
    reference: string
    reviewReason: string
  }>
}

const operations = (): Payload & { capabilities: Record<string, boolean> } => ({
  generatedAt: '2026-09-25T09:00:00Z',
  summary: {
    queueDepth: 4,
    fiscalExceptions: 0,
    inventoryExceptions: 1,
    emailDeliveryExceptions: 2,
    bankTransfersPendingReview: null,
    deadLetters: null,
    staleRefunds: null,
    supportOverdue: null,
    staleShipments: null,
    communicationFailures: null
  },
  capabilities: {
    queueDepth: true,
    fiscalExceptions: true,
    inventoryExceptions: true,
    emailDeliveryExceptions: true,
    bankTransfersPendingReview: false,
    deadLetters: false,
    queueDetails: false
  },
  queues: [],
  deadLetters: [],
  bankTransfers: []
})

const INVENTORY_KEYS = [
  'inventoryReservationExpiryPending',
  'inventoryLedgerDivergences',
  'inventoryAvailabilityDeficits',
  'inventoryStockExceptionOrders',
  'inventoryBackorderCommitments'
] as const
const cloudflareOperations = (): Payload => {
  const base = operations()
  return {
    ...base,
    source: 'cloudflare',
    summary: {
      ...base.summary,
      inventoryExceptions: 7,
      inventoryReservationExpiryPending: 2,
      inventoryLedgerDivergences: 1,
      inventoryAvailabilityDeficits: 3,
      inventoryStockExceptionOrders: 4,
      inventoryBackorderCommitments: 5
    },
    capabilities: {
      ...base.capabilities,
      ...Object.fromEntries(INVENTORY_KEYS.map((key) => [key, true]))
    }
  }
}
const nodeDetails = (): Payload => ({
  ...operations(),
  capabilities: undefined,
  summary: { queueDepth: 1, deadLetters: 1, bankTransfersPendingReview: 1, inventoryExceptions: 0 },
  queues: [{ eventType: 'order.shipped', status: 'retry', depth: 1, oldestAt: '2026-09-25T09:00:00Z', maxAttempts: 2 }],
  deadLetters: [
    {
      id: 'outbox-existing',
      eventType: 'order.shipped',
      attempts: 3,
      errorCode: 'PROVIDER_UNAVAILABLE',
      errorMessage: 'Proveedor temporalmente no disponible',
      createdAt: '2026-09-25T09:00:00Z'
    }
  ],
  bankTransfers: [
    {
      id: 'movement-existing',
      externalId: 'external-existing',
      bookedAt: '2026-09-25T09:00:00Z',
      amountCents: 1234,
      currency: 'EUR',
      reference: 'Referencia recibida existente',
      reviewReason: 'Revisar referencia del pedido'
    }
  ]
})
const mounted: Array<{ unmount: () => void }> = []
async function renderState(data: Payload | null = operations(), status = 'success', runtime = 'node') {
  runtimeMock.mockReturnValue({
    app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
    public: { serverRuntime: runtime, baseUrl: 'https://neteco.invalid' }
  })
  const response = ref(data)
  const readStatus = ref(status)
  const refresh = vi.fn(async () => undefined)
  fetchMock.mockReturnValue({ data: response, status: readStatus, refresh })
  const wrapper = await mountSuspended(OperationsPage, {
    global: {
      stubs: {
        UiPageHeader: Header,
        ShippingCalendarPanel: CalendarPanel,
        AdminCommunicationHistoryPanel: CommunicationPanel,
        UiSurface: passthrough,
        UiEmptyState: EmptyState,
        UIcon: true,
        UButton: Button,
        UModal: Modal,
        UAlert: Alert,
        UFormField: Field,
        UInput: Input,
        UBadge: passthrough
      }
    }
  })
  mounted.push(wrapper)
  return { wrapper, response, readStatus, refresh }
}
async function render(data: Payload | null = operations(), status = 'success') {
  return (await renderState(data, status)).wrapper
}
type Page = Awaited<ReturnType<typeof render>>
function button(scope: Page | DOMWrapper<Element>, text: string) {
  const result = scope.findAll('button').find((element) => element.text() === text)
  if (!result) throw new Error(`Missing button: ${text}`)
  return result
}
function inventoryCard(wrapper: Page, key: string) {
  return wrapper.get(`[data-inventory-metric="${key}"]`)
}
function zeroInventory(data = cloudflareOperations()): Payload {
  return {
    ...data,
    summary: { ...data.summary, inventoryExceptions: 0, ...Object.fromEntries(INVENTORY_KEYS.map((key) => [key, 0])) }
  }
}
beforeEach(() => {
  sessionMock.mockReturnValue({
    ready: ref(true),
    loggedIn: ref(true),
    user: ref({ id: 'synthetic-admin', role: 'admin', emailVerified: true, mfaVerified: true }),
    session: ref({ sessionId: 'synthetic-session', sessionVersion: 1 }),
    clear: async () => undefined,
    openInPopup: () => undefined,
    fetch: async () => undefined
  })
  fetchMock.mockReset()
  requestMock.mockReset().mockResolvedValue({ ok: true })
  toastMock.mockReset()
  navigationMock.mockReturnValue({
    cloudflare: ref(true),
    capabilities: ref(null),
    status: ref('ready'),
    groups: ref([]),
    staffEntry: ref(false),
    routeAllowed: ref(true),
    refresh: vi.fn(),
    requiresLogin: () => false
  })
})
afterEach(() => {
  mounted.splice(0).forEach((wrapper) => wrapper.unmount())
})

describe('administrative operations capabilities rendered states', () => {
  it('binds communication history to the exact administrative session and coordinates pending panels', async () => {
    const caps = ref<unknown>({
      state: 'ready',
      identityId: 'synthetic-admin',
      sessionId: 'synthetic-session',
      sessionVersion: 1,
      permissions: ['administration.manage']
    })
    navigationMock().capabilities = caps
    const { wrapper } = await renderState(cloudflareOperations(), 'success', 'cloudflare')
    expect(wrapper.get('[data-communication-mount]').attributes('data-enabled')).toBe('true')
    expect(wrapper.get('[data-communication-mount]').attributes('data-scope')).toContain('synthetic-session')
    wrapper.getComponent(CalendarPanel).vm.$emit('pending', true)
    await flushPromises()
    expect(wrapper.get('[data-communication-mount]').attributes('data-pending')).toBe('true')
    wrapper.getComponent(CalendarPanel).vm.$emit('pending', false)
    wrapper.getComponent(CommunicationPanel).vm.$emit('pending', true)
    await flushPromises()
    expect(button(wrapper, 'Actualizar').attributes('disabled')).toBeDefined()
    caps.value = {
      state: 'ready',
      identityId: 'synthetic-admin',
      sessionId: 'synthetic-session',
      sessionVersion: 2,
      permissions: ['administration.manage']
    }
    await flushPromises()
    expect(wrapper.get('[data-communication-mount]').attributes('data-enabled')).toBe('false')
    expect(wrapper.get('[data-communication-mount]').attributes('data-scope')).toBe('')
    expect(requestMock).not.toHaveBeenCalled()
  })

  it('does not mount the Cloudflare communication history in the legacy Node runtime', async () => {
    const { wrapper } = await renderState(operations(), 'success', 'node')
    expect(wrapper.find('[data-communication-mount]').exists()).toBe(false)
  })

  it('mounts shipping calendars only for the Cloudflare runtime with an exact current session capability', async () => {
    const caps = ref<unknown>({
      state: 'ready',
      identityId: 'synthetic-admin',
      sessionId: 'synthetic-session',
      sessionVersion: 1,
      permissions: ['administration.manage']
    })
    navigationMock().capabilities = caps
    const { wrapper } = await renderState(cloudflareOperations(), 'success', 'cloudflare')
    expect(wrapper.get('[data-calendar-mount]').attributes('data-enabled')).toBe('true')
    expect(wrapper.get('[data-calendar-mount]').attributes('data-scope')).toContain('synthetic-session')
    caps.value = {
      state: 'ready',
      identityId: 'other-admin',
      sessionId: 'synthetic-session',
      sessionVersion: 1,
      permissions: ['administration.manage']
    }
    await flushPromises()
    expect(wrapper.get('[data-calendar-mount]').attributes('data-enabled')).toBe('false')
    expect(wrapper.get('[data-calendar-mount]').attributes('data-scope')).toBe('')
    expect(requestMock).not.toHaveBeenCalled()
  })
  it('does not expose the Cloudflare shipping-calendar writer in the legacy Node runtime', async () => {
    const wrapper = await render()
    expect(wrapper.find('[data-calendar-mount]').exists()).toBe(false)
  })
  it('shows observed SLA and scheduled follow-up counts separately with a permission-governed support destination', async () => {
    const caps = ref<unknown>({ state: 'ready', permissions: ['support.manage'] })
    navigationMock().capabilities = caps
    const payload = cloudflareOperations()
    Object.assign(payload.summary, { supportOverdue: 3, supportNextActionOverdue: 2 })
    Object.assign(payload.capabilities!, { supportOverdue: true, supportNextActionOverdue: true })
    const { wrapper } = await renderState(payload, 'success', 'cloudflare')
    expect(wrapper.get('[data-metric="supportOverdue"]').text()).toContain('3')
    expect(wrapper.get('[data-metric="supportNextActionOverdue"]').text()).toContain('2')
    expect(wrapper.get('[data-metric="supportOverdue"] a').attributes('href')).toBe('/admin/soporte')
    expect(wrapper.text()).toContain('Los expedientes pueden aparecer en ambos recuentos')
    expect(wrapper.text()).not.toContain('5 expedientes vencidos')
    caps.value = { state: 'ready', permissions: ['administration.manage'] }
    await flushPromises()
    expect(wrapper.find('[data-metric="supportOverdue"] a').exists()).toBe(false)
    caps.value = { state: 'mfa_required', permissions: [] }
    await flushPromises()
    expect(wrapper.find('[data-metric="supportOverdue"] a').exists()).toBe(false)
    expect(requestMock).not.toHaveBeenCalled()
  })
  it.each([null, -1, 1.5, '2'])(
    'never converts unavailable or malformed support measurements %j into a zero or link',
    async (count) => {
      navigationMock().capabilities.value = { state: 'ready', permissions: ['support.manage'] }
      const payload = cloudflareOperations()
      payload.summary.supportOverdue = count as number | null
      payload.summary.supportNextActionOverdue = count as number | null
      Object.assign(payload.capabilities!, { supportOverdue: true, supportNextActionOverdue: true })
      const { wrapper } = await renderState(payload, 'success', 'cloudflare')
      for (const key of ['supportOverdue', 'supportNextActionOverdue']) {
        expect(wrapper.get(`[data-metric="${key}"]`).text()).toContain('No disponible')
        expect(wrapper.find(`[data-metric="${key}"] a`).exists()).toBe(false)
      }
    }
  )
  it('distinguishes observed zero support commitments from unsupported counts and untrusted source', async () => {
    navigationMock().capabilities.value = { state: 'ready', permissions: ['support.manage'] }
    const payload = cloudflareOperations()
    Object.assign(payload.summary, { supportOverdue: 0, supportNextActionOverdue: 0 })
    Object.assign(payload.capabilities!, { supportOverdue: true, supportNextActionOverdue: true })
    const { wrapper, response } = await renderState(payload, 'success', 'cloudflare')
    expect(wrapper.get('[data-metric="supportOverdue"] p').text()).toBe('0')
    expect(wrapper.get('[data-metric="supportNextActionOverdue"] p').text()).toBe('0')
    response.value = { ...payload, source: 'node' }
    await flushPromises()
    expect(wrapper.get('[data-metric="supportOverdue"] p').text()).toBe('—')
    expect(wrapper.find('[data-metric="supportOverdue"] a').exists()).toBe(false)
    response.value = { ...payload, capabilities: { supportOverdue: false, supportNextActionOverdue: false } }
    await flushPromises()
    expect(wrapper.get('[data-metric="supportNextActionOverdue"] p').text()).toBe('—')
  })
  it('renders only measured counts, missing capabilities and positive D1 queue depth without claiming an empty queue', async () => {
    const wrapper = await render()
    expect(wrapper.text()).toContain('Hay 4 trabajos pendientes medidos en D1')
    expect(wrapper.text()).toContain('Conciliación bancaria no disponible')
    expect(wrapper.text()).toContain('Mensajes muertos no disponibles')
    expect(wrapper.text()).toContain('Entrega de emails bloqueada')
    expect(wrapper.text()).toContain('No disponible')
    expect(wrapper.get('[data-metric="queueDepth"]').text()).toContain('4')
    expect(wrapper.get('[data-metric="emailDeliveryExceptions"]').text()).toContain('2')
    expect(wrapper.get('[data-metric="deadLetters"]').text()).toContain('—')
    expect(wrapper.text()).not.toContain('La cola está vacía')
    expect(wrapper.text()).not.toContain('Todos los ingresos recibidos están casados')
    expect(wrapper.text()).not.toContain('Ningún proceso asíncrono ha agotado')
  })
  it('distinguishes observed zero from an unsupported or missing count', async () => {
    const data = operations()
    data.summary.deadLetters = 0
    data.summary.queueDepth = 0
    const wrapper = await render(data)
    expect(wrapper.get('[data-metric="queueDepth"]').text()).toContain('0')
    expect(wrapper.get('[data-metric="queueDepth"]').text()).not.toContain('No disponible')
    expect(wrapper.get('[data-metric="deadLetters"]').text()).toContain('—')
    expect(wrapper.get('[data-metric="deadLetters"]').text()).toContain('No disponible')
  })
  it('renders a failed read as unknown, not successful empty or zero metrics', async () => {
    const wrapper = await render(operations(), 'error')
    expect(wrapper.text()).toContain('No se han podido consultar las operaciones')
    expect(wrapper.text()).not.toContain('La cola está vacía')
    expect(wrapper.text()).not.toContain('Transferencias por conciliar')
    expect(wrapper.text()).not.toContain('No hay mensajes muertos')
  })
  it('does not render empty success claims while the read is pending', async () => {
    const wrapper = await render(null, 'pending')
    expect(wrapper.find('[aria-busy="true"]').exists()).toBe(true)
    expect(wrapper.text()).not.toContain('No hay transferencias pendientes')
    expect(wrapper.text()).not.toContain('La cola está vacía')
  })
  it('cannot claim an empty supported queue if its measured depth is positive', async () => {
    const data = operations()
    Object.assign(data.capabilities, { queueDetails: true })
    const wrapper = await render(data)
    expect(wrapper.text()).toContain('Desglose de trabajo pendiente no disponible')
    expect(wrapper.text()).not.toContain('La cola está vacía')
  })
})

describe('Cloudflare single-location inventory diagnostics', () => {
  it('reads the existing operations route and renders five measured units without summing overlapping incidents', async () => {
    const { wrapper } = await renderState(cloudflareOperations(), 'success', 'cloudflare')
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/admin/operations')
    expect(wrapper.text()).toContain('Resumen de operaciones en modo consulta')
    expect(wrapper.get('[data-metric="inventoryExceptions"] p').text()).toBe('7')
    const expected = [
      ['inventoryReservationExpiryPending', 'Liberación pendiente', '2 reservas'],
      ['inventoryLedgerDivergences', 'Diferencias en el registro', '1 referencia'],
      ['inventoryAvailabilityDeficits', 'Reservas sin cobertura', '3 referencias'],
      ['inventoryStockExceptionOrders', 'Pedidos con excepción de stock', '4 pedidos'],
      ['inventoryBackorderCommitments', 'Compromiso permitido', '5 referencias']
    ] as const
    for (const [key, label, count] of expected) {
      const card = inventoryCard(wrapper, key)
      expect(card.get('dt').text()).toBe(label)
      expect(card.get('dd').text().replace(/\s+/g, ' ')).toBe(count)
    }
    expect(wrapper.text()).toContain('Los recuentos no se suman')
    expect(wrapper.find('[data-metric="inventoryExceptions"]').classes()).toContain('border-amber-200')
    expect(requestMock).not.toHaveBeenCalled()
  })

  it('shows an expired retained reservation independently from zero inventory inconsistencies', async () => {
    const data = zeroInventory()
    data.summary.inventoryReservationExpiryPending = 1
    const { wrapper } = await renderState(data, 'success', 'cloudflare')
    expect(wrapper.get('[data-metric="inventoryExceptions"] p').text()).toBe('0')
    expect(inventoryCard(wrapper, 'inventoryReservationExpiryPending').get('dd').text()).toMatch(/^1\s+reserva$/)
    expect(inventoryCard(wrapper, 'inventoryReservationExpiryPending').text()).toContain(
      'no implica por sí sola stock incoherente'
    )
    expect(inventoryCard(wrapper, 'inventoryLedgerDivergences').get('dd').text()).toMatch(/^0\s+referencias$/)
    expect(wrapper.get('[data-metric="inventoryExceptions"]').classes()).not.toContain('border-amber-200')
  })

  it('marks the observed ledger difference, rather than attributing TTL to ledger drift', async () => {
    const data = zeroInventory()
    data.summary.inventoryReservationExpiryPending = 1
    data.summary.inventoryLedgerDivergences = 1
    data.summary.inventoryExceptions = 1
    const { wrapper } = await renderState(data, 'success', 'cloudflare')
    expect(inventoryCard(wrapper, 'inventoryLedgerDivergences').classes()).toContain('border-amber-200')
    expect(inventoryCard(wrapper, 'inventoryLedgerDivergences').text()).toContain('sus movimientos registrados')
    expect(wrapper.get('[data-metric="inventoryExceptions"] p').text()).toBe('1')
  })

  it('defines uncovered reservations by the nonnegative sellable threshold, not negative physical stock', async () => {
    const { wrapper } = await renderState(cloudflareOperations(), 'success', 'cloudflare')
    const card = inventoryCard(wrapper, 'inventoryAvailabilityDeficits')
    expect(card.classes()).toContain('border-amber-200')
    expect(card.text()).toContain('Reservas retenidas que superan la disponibilidad vendible')
    expect(card.text()).toContain('tras bloqueos y stock de seguridad, sin backorder autorizado')
    expect(card.text()).toContain('Esa disponibilidad nunca baja de cero')
    expect(card.text()).toContain('Estar agotado sin reservas no es una incidencia')
    expect(card.text()).not.toContain('Disponibilidad bruta bajo cero')
  })

  it('keeps an observed zero deficit at zero even if additional raw stock fields suggest normal exhaustion', async () => {
    const data = zeroInventory()
    Object.assign(data.summary, { physicalQuantity: 0, safetyStock: 5, reservedQuantity: 0 })
    const { wrapper } = await renderState(data, 'success', 'cloudflare')
    const card = inventoryCard(wrapper, 'inventoryAvailabilityDeficits')
    expect(card.get('dd').text()).toMatch(/^0\s+referencias$/)
    expect(card.classes()).not.toContain('border-amber-200')
    expect(wrapper.get('[data-metric="inventoryExceptions"] p').text()).toBe('0')
    expect(wrapper.text()).not.toContain('safetyStock')
  })

  it('presents authorized backorder commitments as permitted, not an error or an added inconsistency', async () => {
    const data = zeroInventory()
    data.summary.inventoryBackorderCommitments = 3
    const { wrapper } = await renderState(data, 'success', 'cloudflare')
    const card = inventoryCard(wrapper, 'inventoryBackorderCommitments')
    expect(card.get('dt').text()).toBe('Compromiso permitido')
    expect(card.get('dd').text()).toMatch(/^3\s+referencias$/)
    expect(card.text()).toContain('Es un compromiso permitido, no un error de stock')
    expect(card.classes()).not.toContain('border-amber-200')
    expect(wrapper.get('[data-metric="inventoryExceptions"] p').text()).toBe('0')
  })

  it('keeps order exceptions observable when balance scope is unverified, without treating unknown balance counts as zero', async () => {
    const data = cloudflareOperations()
    data.summary.inventoryExceptions = null
    data.capabilities!.inventoryExceptions = false
    for (const key of INVENTORY_KEYS.filter((key) => key !== 'inventoryStockExceptionOrders')) {
      data.summary[key] = null
      data.capabilities![key] = false
    }
    data.summary.inventoryStockExceptionOrders = 2
    const { wrapper } = await renderState(data, 'success', 'cloudflare')
    expect(wrapper.get('[data-metric="inventoryExceptions"] p').text()).toBe('—')
    expect(inventoryCard(wrapper, 'inventoryStockExceptionOrders').get('dd').text()).toMatch(/^2\s+pedidos$/)
    for (const key of INVENTORY_KEYS.filter((key) => key !== 'inventoryStockExceptionOrders')) {
      expect(inventoryCard(wrapper, key).get('dd').text()).toContain('—')
      expect(inventoryCard(wrapper, key).get('dd').text()).toContain('No disponible')
    }
    expect(wrapper.get('[data-inventory-diagnostics] [role="status"]').text()).toContain(
      'Los recuentos no disponibles se muestran como «—»'
    )
    expect(wrapper.text()).not.toContain('Seleccionar almacén')
  })

  it('does not render diagnostic counts or claim zeros when their capabilities are absent', async () => {
    const data = cloudflareOperations()
    data.capabilities = operations().capabilities
    const { wrapper } = await renderState(data, 'success', 'cloudflare')
    expect(wrapper.findAll('[data-inventory-metric]')).toHaveLength(0)
    expect(wrapper.get('[data-inventory-diagnostics]').text()).toContain(
      'Diagnóstico detallado de inventario no disponible'
    )
    expect(wrapper.text()).toContain('No podemos confirmar que esos estados sean cero')
  })

  it('fails closed when the entire Cloudflare capability object is missing', async () => {
    const data = cloudflareOperations()
    data.capabilities = undefined
    const { wrapper } = await renderState(data, 'success', 'cloudflare')
    expect(wrapper.findAll('[data-inventory-metric]')).toHaveLength(0)
    expect(wrapper.get('[data-metric="inventoryExceptions"] p').text()).toBe('—')
    expect(wrapper.get('[data-metric="queueDepth"] p').text()).toBe('—')
    expect(wrapper.text()).toContain('Diagnóstico detallado de inventario no disponible')
    expect(wrapper.findAll('button').map((element) => element.text())).toEqual(['Actualizar'])
    expect(requestMock).not.toHaveBeenCalled()
  })

  it('can show permitted backorder and an independently observed structural ledger exception together', async () => {
    const data = zeroInventory()
    data.summary.inventoryBackorderCommitments = 1
    data.summary.inventoryLedgerDivergences = 1
    data.summary.inventoryExceptions = 1
    const { wrapper } = await renderState(data, 'success', 'cloudflare')
    expect(inventoryCard(wrapper, 'inventoryLedgerDivergences').text()).toContain(
      'reservas retenidas sin saldo verificable'
    )
    expect(inventoryCard(wrapper, 'inventoryLedgerDivergences').classes()).toContain('border-amber-200')
    expect(inventoryCard(wrapper, 'inventoryBackorderCommitments').classes()).not.toContain('border-amber-200')
    expect(inventoryCard(wrapper, 'inventoryAvailabilityDeficits').get('dd').text()).toMatch(/^0\s+referencias$/)
    expect(wrapper.get('[data-metric="inventoryExceptions"] p').text()).toBe('1')
  })

  it('shows a partial supported diagnostic without upgrading other measurements', async () => {
    const data = cloudflareOperations()
    data.capabilities = { inventoryReservationExpiryPending: true }
    const { wrapper } = await renderState(data, 'success', 'cloudflare')
    expect(inventoryCard(wrapper, 'inventoryReservationExpiryPending').get('dd').text()).toMatch(/^2\s+reservas$/)
    expect(inventoryCard(wrapper, 'inventoryLedgerDivergences').get('dd').text()).toContain('No disponible')
    expect(wrapper.get('[data-metric="inventoryExceptions"] p').text()).toBe('—')
    expect(wrapper.get('[data-metric="queueDepth"] p').text()).toBe('—')
  })

  it.each([undefined, false, 'true', 1, null, {}])(
    'requires literal true for the ledger capability (%j)',
    async (cap) => {
      const data = cloudflareOperations()
      data.capabilities!.inventoryLedgerDivergences = cap
      const { wrapper } = await renderState(data, 'success', 'cloudflare')
      const card = inventoryCard(wrapper, 'inventoryLedgerDivergences')
      expect(card.get('dd').text()).toContain('—')
      expect(card.get('dd').text()).toContain('No disponible')
      expect(card.classes()).not.toContain('border-amber-200')
    }
  )

  it.each([undefined, 'node', 'Cloudflare', 'other'])(
    'rejects untrusted source %j despite true capabilities',
    async (source) => {
      const data = cloudflareOperations()
      data.source = source
      const { wrapper } = await renderState(data, 'success', 'cloudflare')
      expect(wrapper.findAll('[data-inventory-metric]')).toHaveLength(0)
      for (const key of ['queueDepth', 'inventoryExceptions', 'fiscalExceptions']) {
        expect(wrapper.get(`[data-metric="${key}"] p`).text()).toBe('—')
      }
      expect(wrapper.get('header').text()).not.toContain('09:00')
      expect(requestMock).not.toHaveBeenCalled()
    }
  )

  it.each(['', 'other', 'Node', 'Cloudflare'])(
    'does not grant the Node fallback to an unrecognized runtime %j',
    async (runtime) => {
      const data = { ...cloudflareOperations(), ...nodeDetails(), source: 'cloudflare' }
      data.capabilities = {
        ...cloudflareOperations().capabilities,
        bankTransfersPendingReview: true,
        bankTransfersReconcile: true,
        deadLetters: true,
        deadLetterReplay: true,
        queueDetails: true
      }
      const { wrapper } = await renderState(data, 'success', runtime)
      expect(wrapper.get('[data-metric="queueDepth"] p').text()).toBe('—')
      expect(wrapper.findAll('[data-inventory-metric]')).toHaveLength(0)
      expect(wrapper.find('dialog, input, table').exists()).toBe(false)
      expect(wrapper.text()).not.toContain('Referencia recibida existente')
      expect(wrapper.text()).not.toContain('Proveedor temporalmente no disponible')
      expect(wrapper.findAll('button').map((element) => element.text())).toEqual(['Actualizar'])
      expect(requestMock).not.toHaveBeenCalled()
    }
  )

  it.each([-1, 0.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '3', null, undefined])(
    'does not invent a count from an invalid measured value (%j)',
    async (count) => {
      const data = cloudflareOperations()
      data.summary.inventoryLedgerDivergences = count
      const { wrapper } = await renderState(data, 'success', 'cloudflare')
      expect(inventoryCard(wrapper, 'inventoryLedgerDivergences').get('dd').text()).toContain('No disponible')
      expect(inventoryCard(wrapper, 'inventoryLedgerDivergences').classes()).not.toContain('border-amber-200')
    }
  )

  it('hides private details and never offers POST actions even if every unsupported capability is asserted', async () => {
    const data = cloudflareOperations()
    Object.assign(data.capabilities!, {
      queueDetails: true,
      deadLetters: true,
      bankTransfersPendingReview: true,
      bankTransfersReconcile: true,
      deadLetterReplay: true,
      inventoryWrite: true,
      inventoryTransfer: true
    })
    const details = nodeDetails()
    data.bankTransfers = details.bankTransfers.map((item) => ({ ...item, reference: 'private-bank@example.invalid' }))
    data.deadLetters = details.deadLetters.map((item) => ({
      ...item,
      errorMessage: 'SELECT private_sql; secret-actor'
    }))
    data.queues = [
      { eventType: 'private-queue-event', status: 'pending', depth: 1, oldestAt: '2000-01-01', maxAttempts: 0 }
    ]
    Object.assign(data.summary, { privateActor: 'private-actor@example.invalid' })
    const { wrapper, refresh } = await renderState(data, 'success', 'cloudflare')
    expect(wrapper.text()).toContain('Conciliación bancaria no disponible')
    expect(wrapper.text()).toContain('Mensajes muertos no disponibles')
    expect(wrapper.text()).toContain('Detalle de colas no disponible')
    for (const privateValue of [
      'private-bank@',
      'private_sql',
      'secret-actor',
      'private-queue-event',
      'private-actor@'
    ]) {
      expect(wrapper.text()).not.toContain(privateValue)
    }
    expect(wrapper.text()).not.toContain('nadie ha intentado procesar todavía')
    expect(wrapper.find('dialog').exists()).toBe(false)
    expect(wrapper.findAll('button').map((element) => element.text())).toEqual(['Actualizar'])
    expect(wrapper.find('input, select, a').exists()).toBe(false)
    await button(wrapper, 'Actualizar').trigger('click')
    expect(refresh).toHaveBeenCalledOnce()
    expect(requestMock).not.toHaveBeenCalled()
  })

  it('revokes displayed measurements immediately when source or capabilities stop being trusted', async () => {
    const { wrapper, response } = await renderState(cloudflareOperations(), 'success', 'cloudflare')
    expect(inventoryCard(wrapper, 'inventoryLedgerDivergences').get('dd').text()).toMatch(/^1\s+referencia$/)
    response.value = { ...cloudflareOperations(), capabilities: {} }
    await flushPromises()
    expect(wrapper.findAll('[data-inventory-metric]')).toHaveLength(0)
    expect(wrapper.get('[data-metric="inventoryExceptions"] p').text()).toBe('—')
    response.value = { ...cloudflareOperations(), source: 'node' }
    await flushPromises()
    expect(wrapper.findAll('[data-inventory-metric]')).toHaveLength(0)
    expect(requestMock).not.toHaveBeenCalled()
  })

  it('exposes named diagnostic groups and count descriptions without hiding them on small layouts', async () => {
    const { wrapper } = await renderState(cloudflareOperations(), 'success', 'cloudflare')
    const section = wrapper.get('[data-inventory-diagnostics]')
    const heading = section.get(`#${section.attributes('aria-labelledby')}`)
    expect(heading.element.tagName).toBe('H2')
    expect(heading.text()).toBe('Inventario del único almacén')
    const list = section.get('dl')
    expect(list.classes()).toEqual(expect.arrayContaining(['grid-cols-1', 'sm:grid-cols-2', 'lg:grid-cols-3']))
    expect(section.get(`#${list.attributes('aria-describedby')}`).text()).toContain('Los recuentos no se suman')
    for (const key of INVENTORY_KEYS) {
      const card = inventoryCard(wrapper, key)
      expect(card.classes()).toContain('min-w-0')
      expect(card.classes()).not.toContain('hidden')
      expect(card.get('dt').text()).not.toBe('')
      expect(section.get(`#${card.get('dd').attributes('aria-describedby')}`).text()).not.toBe('')
    }
    const ids = wrapper.findAll('[id]').map((element) => element.attributes('id'))
    expect(new Set(ids).size).toBe(ids.length)
    expect(section.find('table, select, button, input').exists()).toBe(false)
  })
})

describe('operations read lifecycle and retries', () => {
  it('does not show stale successful measurements while a refreshed read is pending', async () => {
    const { wrapper, readStatus } = await renderState(cloudflareOperations(), 'success', 'cloudflare')
    readStatus.value = 'pending'
    await flushPromises()
    expect(wrapper.get('[aria-busy="true"]').attributes('aria-label')).toBe('Cargando operaciones')
    expect(wrapper.find('[data-inventory-diagnostics]').exists()).toBe(false)
    expect(wrapper.find('[data-metric]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('La cola está vacía')
  })

  it('reports a failed read accessibly and only refreshes the real GET when retried', async () => {
    const { wrapper, refresh } = await renderState(cloudflareOperations(), 'error', 'cloudflare')
    expect(wrapper.get('[role="alert"]').text()).toContain('No se han podido consultar las operaciones')
    expect(wrapper.text()).toContain('No podemos confirmar el estado de colas ni incidencias')
    expect(wrapper.find('[data-inventory-metric]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('stock incoherente')
    await button(wrapper, 'Reintentar').trigger('click')
    expect(refresh).toHaveBeenCalledOnce()
    expect(requestMock).not.toHaveBeenCalled()
  })

  it('treats an absent payload as an unavailable read, not successful zero inventory', async () => {
    const { wrapper } = await renderState(null, 'success', 'cloudflare')
    expect(wrapper.get('[role="alert"]').text()).toContain('No se han podido consultar las operaciones')
    expect(wrapper.find('[data-metric]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('No hay transferencias pendientes')
  })

  it('shows fresh server measurements after retry and removes the unavailable state', async () => {
    const { wrapper, refresh, response, readStatus } = await renderState(null, 'error', 'cloudflare')
    refresh.mockImplementationOnce(async () => {
      response.value = zeroInventory()
      readStatus.value = 'success'
    })
    await button(wrapper, 'Reintentar').trigger('click')
    await flushPromises()
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    expect(inventoryCard(wrapper, 'inventoryLedgerDivergences').get('dd').text()).toMatch(/^0\s+referencias$/)
    expect(wrapper.get('[data-metric="inventoryExceptions"] p').text()).toBe('0')
    expect(requestMock).not.toHaveBeenCalled()
  })

  it('does not render an invalid server timestamp or leak its contents', async () => {
    const data = cloudflareOperations()
    data.generatedAt = 'private-invalid-generatedAt'
    const { wrapper } = await renderState(data, 'success', 'cloudflare')
    expect(wrapper.get('header').text()).not.toContain('Invalid Date')
    expect(wrapper.text()).not.toContain('private-invalid-generatedAt')
    expect(inventoryCard(wrapper, 'inventoryLedgerDivergences').get('dd').text()).toMatch(/^1\s+referencia$/)
  })
})

describe('existing Node operations remain available', () => {
  it('preserves real counts and details when the original Node endpoint has no source or capabilities', async () => {
    const { wrapper } = await renderState(nodeDetails())
    expect(wrapper.get('[data-metric="queueDepth"] p').text()).toBe('1')
    expect(wrapper.get('[data-metric="inventoryExceptions"] p').text()).toBe('0')
    expect(wrapper.get('[data-metric="emailDeliveryExceptions"]').text()).toContain('No disponible')
    expect(wrapper.text()).toContain('Referencia recibida existente')
    expect(wrapper.text()).toContain('Proveedor temporalmente no disponible')
    expect(wrapper.text()).toContain('order.shipped')
    expect(wrapper.find('table').exists()).toBe(true)
    expect(button(wrapper, 'Conciliar').exists()).toBe(true)
    expect(button(wrapper, 'Reintentar').exists()).toBe(true)
    expect(wrapper.text()).not.toContain('Resumen de operaciones en modo consulta')
    expect(wrapper.findAll('[data-inventory-metric]')).toHaveLength(0)
    expect(wrapper.text()).toContain('Diagnóstico detallado de inventario no disponible')
  })

  it('preserves the existing bank reconciliation POST with an explicit valid reason and normalized order', async () => {
    const { wrapper, refresh } = await renderState(nodeDetails())
    await button(wrapper, 'Conciliar').trigger('click')
    const dialog = wrapper.get('dialog')
    expect(dialog.text()).toContain('Conciliar la transferencia')
    expect(button(dialog, 'Conciliar').attributes('disabled')).toBeDefined()
    await dialog.get('[data-field="Número de pedido"] input').setValue(' ne55e6d06533 ')
    await dialog.get('[data-field="Motivo"] input').setValue(' Referencia confirmada ')
    await button(dialog, 'Conciliar').trigger('click')
    await flushPromises()
    expect(requestMock).toHaveBeenCalledExactlyOnceWith(
      '/api/admin/operations/bank-transfers/movement-existing/reconcile',
      {
        method: 'POST',
        body: { orderNumber: 'NE55E6D06533', reason: 'Referencia confirmada' }
      }
    )
    expect(refresh).toHaveBeenCalledOnce()
    expect(wrapper.find('dialog').exists()).toBe(false)
    expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ color: 'success' }))
  })

  it('preserves the existing dead-letter retry POST only after entering a reason', async () => {
    const { wrapper, refresh } = await renderState(nodeDetails())
    await button(wrapper, 'Reintentar').trigger('click')
    const dialog = wrapper.get('dialog')
    expect(dialog.text()).toContain('Devolver el evento a la cola')
    expect(button(dialog, 'Reintentar').attributes('disabled')).toBeDefined()
    await dialog.get('[data-field="Motivo"] input').setValue(' Proveedor restablecido ')
    await button(dialog, 'Reintentar').trigger('click')
    await flushPromises()
    expect(requestMock).toHaveBeenCalledExactlyOnceWith('/api/admin/operations/outbox/outbox-existing/retry', {
      method: 'POST',
      body: { reason: 'Proveedor restablecido' }
    })
    expect(refresh).toHaveBeenCalledOnce()
    expect(wrapper.find('dialog').exists()).toBe(false)
  })

  it('honors explicit false Node capabilities rather than applying the compatibility fallback', async () => {
    const data = nodeDetails()
    data.capabilities = {
      bankTransfersPendingReview: false,
      bankTransfersReconcile: false,
      deadLetters: false,
      deadLetterReplay: false,
      queueDetails: false,
      inventoryExceptions: false
    }
    const { wrapper } = await renderState(data)
    expect(wrapper.text()).not.toContain('Referencia recibida existente')
    expect(wrapper.text()).not.toContain('Proveedor temporalmente no disponible')
    expect(wrapper.find('table').exists()).toBe(false)
    expect(wrapper.get('[data-metric="inventoryExceptions"] p').text()).toBe('—')
    expect(wrapper.findAll('button').map((element) => element.text())).toEqual(['Actualizar'])
  })

  it('blocks a pending Node confirmation if its real action capability is revoked', async () => {
    const { wrapper, response } = await renderState(nodeDetails())
    await button(wrapper, 'Conciliar').trigger('click')
    const dialog = wrapper.get('dialog')
    await dialog.get('[data-field="Número de pedido"] input').setValue('NE55E6D06533')
    await dialog.get('[data-field="Motivo"] input').setValue('Referencia confirmada')
    response.value = { ...nodeDetails(), capabilities: { bankTransfersReconcile: false } }
    await flushPromises()
    expect(button(dialog, 'Conciliar').attributes('disabled')).toBeDefined()
    await button(dialog, 'Conciliar').trigger('click')
    expect(requestMock).not.toHaveBeenCalled()
  })

  it('prevents duplicate Node writes while a valid request is pending', async () => {
    let resolveRequest: (value: unknown) => void = () => undefined
    requestMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRequest = resolve
        })
    )
    const { wrapper } = await renderState(nodeDetails())
    await button(wrapper, 'Reintentar').trigger('click')
    const dialog = wrapper.get('dialog')
    await dialog.get('[data-field="Motivo"] input').setValue('Proveedor restablecido')
    await button(dialog, 'Reintentar').trigger('click')
    expect(button(dialog, 'Reintentar').attributes('data-loading')).toBe('true')
    await button(dialog, 'Reintentar').trigger('click')
    expect(requestMock).toHaveBeenCalledOnce()
    resolveRequest({ ok: true })
    await flushPromises()
    expect(wrapper.find('dialog').exists()).toBe(false)
  })

  it('preserves a failed Node action for explicit retry without presenting it as a completed reconciliation', async () => {
    requestMock.mockRejectedValueOnce(new Error('Synthetic unavailable backend'))
    const { wrapper, refresh } = await renderState(nodeDetails())
    await button(wrapper, 'Conciliar').trigger('click')
    const dialog = wrapper.get('dialog')
    await dialog.get('[data-field="Número de pedido"] input').setValue('NE55E6D06533')
    await dialog.get('[data-field="Motivo"] input').setValue('Referencia confirmada')
    await button(dialog, 'Conciliar').trigger('click')
    await flushPromises()
    expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ color: 'error' }))
    expect(refresh).not.toHaveBeenCalled()
    expect(wrapper.find('dialog').exists()).toBe(true)
    expect(button(wrapper.get('dialog'), 'Conciliar').attributes('data-loading')).toBe('false')
    await button(wrapper.get('dialog'), 'Conciliar').trigger('click')
    await flushPromises()
    expect(requestMock).toHaveBeenCalledTimes(2)
    expect(refresh).toHaveBeenCalledOnce()
  })
})

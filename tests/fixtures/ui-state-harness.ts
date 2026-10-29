import { deterministicUuid, FIXED_TEST_INSTANT } from './deterministic'
import type { AdminOrderSummary } from '../../shared/types/admin'
import type { OrderSummary, OrderDetailLines } from '../../app/composables/useAccount'

export const UI_STATE_WIDTHS = [320, 768, 1024, 1440] as const
export type UiStateSurface = 'admin-orders' | 'customer-orders'
export type UiState = 'dense' | 'empty' | 'loading' | 'error' | 'stale' | 'permission-denied'
export const UI_STATES: readonly UiState[] = ['dense', 'empty', 'loading', 'error', 'stale', 'permission-denied']
export const UI_STATE_SURFACES: readonly UiStateSurface[] = ['admin-orders', 'customer-orders']
export function selectUiStateCase(surface: string, state: string) {
  if (!UI_STATE_SURFACES.includes(surface as UiStateSurface) || !UI_STATES.includes(state as UiState))
    throw Error('Unknown UI fixture case')
  return {
    id: surface + '-' + state,
    component: surface === 'admin-orders' ? ('AdminOrderWorkbench' as const) : ('CustomerOrdersPage' as const),
    path: surface === 'admin-orders' ? '/admin/pedidos' : '/cuenta/pedidos',
    surface: surface as UiStateSurface,
    state: state as UiState
  }
}
export function uiStateOrder(index: number): OrderSummary {
  return {
    id: deterministicUuid('ui013-order-' + index),
    status: 'pagado',
    total: 12100 + index,
    createdAt: FIXED_TEST_INSTANT,
    lines: 3,
    invoiceAvailable: false,
    fullDetailAvailable: true
  }
}
function adminOrder(index: number): AdminOrderSummary {
  const order = uiStateOrder(index)
  return {
    id: order.id,
    status: order.status,
    total: order.total,
    createdAt: order.createdAt,
    lines: order.lines,
    orderStatus: 'awaiting_payment',
    paymentStatus: 'captured',
    fulfillmentStatus: 'pending',
    inventoryStatus: 'allocated',
    invoiceStatus: 'unavailable',
    name: 'Cliente sintético de pruebas con denominación extensa ' + index,
    company: index % 2 ? 'Empresa sintética de pruebas, nunca datos reales' : null,
    email: `cliente-${index}@example.invalid`,
    city: 'Xàtiva · dirección sintética',
    paymentMethod: 'tarjeta',
    shippingMethod: 'recogida',
    shipmentId: null,
    trackingNumber: null,
    shipmentStatus: null
  }
}
export function uiStateOrderDetail(orderId: string): OrderDetailLines {
  return {
    orderId,
    orderedAt: FIXED_TEST_INSTANT,
    shippingMethod: 'Recogida',
    paymentMethod: 'Tarjeta',
    fulfillmentStatus: 'pending',
    destination: null,
    totals: { subtotalNet: 10000, shippingNet: 0, tax: 2100, total: 12100 },
    shipment: null,
    lines: Array.from({ length: 3 }, (_, index) => ({
      sku: 'SYNTHETIC-UI013-' + index,
      name: 'Referencia sintética con nombre extenso para comprobar ajuste de líneas ' + index,
      format: 'Caja de prueba',
      quantity: 1,
      unitGross: 4033 + (index === 0 ? 1 : 0),
      lineGross: 4033 + (index === 0 ? 1 : 0),
      variantId: null,
      slug: null,
      image: null,
      visual: null,
      available: false,
      reason: 'Fixture visual, no oferta de venta'
    }))
  }
}
export const UI_STATE_IDENTITY = deterministicUuid('ui013-identity')
export const UI_STATE_SESSION = deterministicUuid('ui013-session')
export function uiStateAuthority(surface: UiStateSurface, state: UiState) {
  return {
    ready: true,
    loggedIn: true,
    user: { id: UI_STATE_IDENTITY, emailVerified: true, mfaVerified: surface === 'admin-orders' },
    session: { sessionId: UI_STATE_SESSION, sessionVersion: 1 },
    capabilities: {
      source: 'cloudflare' as const,
      identityId: UI_STATE_IDENTITY,
      sessionId: UI_STATE_SESSION,
      sessionVersion: 1,
      state: 'ready' as const,
      permissions: surface === 'admin-orders' && state !== 'permission-denied' ? ['administration.manage'] : []
    }
  }
}
export function createUiStateHarness(surface: UiStateSurface, state: UiState) {
  const selected = selectUiStateCase(surface, state)
  const endpoint = surface === 'admin-orders' ? '/api/admin/orders' : '/api/orders'
  const count = state === 'empty' ? 0 : 25
  const data =
    surface === 'admin-orders'
      ? {
          source: 'cloudflare',
          items: Array.from({ length: count }, (_, index) => adminOrder(index)),
          pagination: { page: 1, perPage: 25, total: count, pages: count ? 1 : 0 },
          capabilities: {
            orderStatusUpdate: false,
            shipments: false,
            tracking: false,
            refunds: false,
            returns: false,
            invoices: false,
            notes: false,
            customerPreview: false,
            paymentsRead: true,
            inventoryRead: true,
            fulfillmentRead: true,
            orderHistory: true
          }
        }
      : { orders: Array.from({ length: count }, (_, index) => uiStateOrder(index)) }
  let disposed = false,
    released = false
  const pending = new Set<{ resolve(value: unknown): void; reject(error: Error): void }>()
  const reads: string[] = []
  const error = () =>
    Object.assign(new Error('Synthetic UI state fixture failure'), {
      statusCode: state === 'permission-denied' ? 403 : 503
    })
  const request = async (path: string, options?: { method?: string }): Promise<unknown> => {
    if (disposed || (options?.method && options.method !== 'GET') || path !== endpoint)
      throw Error('Unapproved UI fixture request')
    reads.push(path)
    if (state === 'error' || state === 'permission-denied' || (state === 'stale' && reads.length > 1)) throw error()
    if (state === 'loading' && !released) return new Promise((resolve, reject) => pending.add({ resolve, reject }))
    return structuredClone(data)
  }
  return {
    ...selected,
    endpoint,
    authority: uiStateAuthority(surface, state),
    data: structuredClone(data),
    request,
    initialStatus:
      state === 'loading' ? 'pending' : ['error', 'stale', 'permission-denied'].includes(state) ? 'error' : 'success',
    settle: () => {
      released = true
      for (const item of pending) item.resolve(structuredClone(data))
      pending.clear()
    },
    dispose: () => {
      disposed = true
      for (const item of pending) item.reject(Error('UI fixture disposed'))
      pending.clear()
    },
    reads: () => [...reads]
  }
}

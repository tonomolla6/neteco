<script setup lang="ts">
import type { UiColor } from '~~/shared/types/catalog'
import type { AdminTone } from '~/utils/adminLabels'
import OrderFulfillmentSection from '~/components/OrderFulfillmentSection.vue'
import OrderFiscalSection from '~/components/OrderFiscalSection.vue'
import OrderRefundPanel from '~/components/refunds/OrderRefundPanel.vue'
import AdminRefundActions from '~/components/refunds/AdminRefundActions.vue'
import OrderTimelinePanel from '~/components/OrderTimelinePanel.vue'
import OrderTrackingPanel from '~/components/OrderTrackingPanel.vue'
import BeplyOrderPanel from '~/components/BeplyOrderPanel.vue'
import OrderCancellationPanel from '~/components/OrderCancellationPanel.vue'
import OrderAnnotationsPanel from '~/components/OrderAnnotationsPanel.vue'
import { orderCancellationReceiptSchema } from '~~/shared/order-cancellation'
import { catalogPolicyUuidSchema } from '~~/shared/catalog-publication-policy'

definePageMeta({ layout: 'admin', middleware: 'admin' })

/**
 * Ficha del pedido en el panel.
 *
 * Antes no existía: desde el listado se saltaba a `/pedido/[id]`, que es la ficha
 * del cliente y esconde a propósito casi todo lo que hace falta para resolver una
 * llamada —el intento de pago y por qué lo rechazó el banco, los eventos del
 * transportista, la traza de quién cambió qué—. Quien atendía el teléfono acababa
 * consultando la base de datos.
 *
 * La pantalla está ordenada por la secuencia de una llamada real: primero en qué
 * estado está el pedido, luego qué llevaba, luego el cobro, luego el envío, y al
 * final la traza. Los datos del cliente van en la columna lateral y se quedan fijos
 * al desplazar, porque son lo que se lee en voz alta mientras se mira el resto.
 */
interface DetailLine {
  id: string
  sku: string
  name: string
  format: string
  unitLabel: string
  quantity: number
  unitNet: number
  discountNet: number | null
  taxRate: number
  tax: number
  lineGross: number
  slug: string | null
  image: string | null
  imageAlt?: string | null
  visual: { type: string; color: string } | null
  returned: number | null
  inCatalog: boolean
}

interface OrderDetail {
  capabilities?: {
    orderStatusUpdate: boolean
    shipments: boolean
    tracking: boolean
    invoices: boolean
    customerPreview: boolean
  }
  fiscalEvaluation?: { status: string; createdAt: string } | null
  order: {
    id: string
    status: string
    orderStatus: string
    paymentStatus: string
    fulfillmentStatus: string
    inventoryStatus: string
    invoiceStatus: string
    shippingMethod: string
    paymentMethod: string
    createdAt: string
    confirmedAt: string | null
    updatedAt: string
    purchaseOrderReference?: string | null
    totals: { subtotalNet: number; discountNet: number | null; shippingNet: number; tax: number; total: number }
  }
  customer: {
    name: string | null
    email: string | null
    phone: string | null
    company: string | null
    companyStatus: string | null
    taxId: string | null
    isGuest: boolean
  }
  shippingAddress: Record<string, string | null> | null
  billingAddress: Record<string, string | null> | null
  lines: DetailLine[]
  payments: Array<{
    id: string
    provider: string
    method: string
    status: string
    amount: number
    reference: string | null
    createdAt: string
    updatedAt: string
    lastEvent: string | null
    lastResponseCode: string | null
    lastEventAt: string | null
    refunded: number | null
  }>
  shipments: Array<{
    id: string
    provider: string
    serviceCode: string
    trackingNumber: string | null
    status: string
    estimatedCost: number
    actualCost: number | null
    hasLabel: boolean
    createdAt: string
    updatedAt: string
    events: Array<{ status: string; location: string | null; description: string | null; occurredAt: string }>
  }>
  returns: Array<{
    id: string
    publicNumber: string
    status: string
    reason: string
    resolution: string | null
    createdAt: string
    units: number
  }>
  invoices: Array<{ id: string; series: string; kind: string; status: string; amount: number; createdAt: string }>
  notes: Array<{ id: string; note: string; author: string | null; createdAt: string }>
  timeline: Array<{
    id: string
    eventType: string
    actorType: string
    origin: string
    reason: string | null
    createdAt: string
    fromState: Record<string, string> | null
    toState: Record<string, string> | null
  }>
  history: Array<{ id: string; total: number; status: string; createdAt: string }>
}

const route = useRoute()
const orderId = computed(() => String(route.params.id))
const toast = useToast()
const runtime = useRuntimeConfig().public.serverRuntime
const timelineSession = useUserSession()
const timelineNavigation = runtime === 'cloudflare' ? useAdminNavigation() : null
const timelineScope = computed(() =>
  JSON.stringify([
    timelineSession.loggedIn.value,
    timelineSession.user.value?.id,
    timelineSession.session.value?.sessionId,
    timelineSession.session.value?.sessionVersion,
    timelineSession.user.value?.emailVerified,
    timelineSession.user.value?.mfaVerified
  ])
)
const originalTimelineScope = timelineScope.value
const timelineScopeRevoked = ref(false)
watch(
  timelineScope,
  () => {
    timelineScopeRevoked.value = true
  },
  { flush: 'sync' }
)
const financialCommandPending = ref(false)
const cancellationPending = ref(false)
const annotationsPending = ref(false)
const fulfillmentCommandPending = ref(false)
const cancellationRevision = ref(0)
const cancellationReadFailed = ref(false)
function confirmFinancialNavigation() {
  if (cancellationPending.value || annotationsPending.value || fulfillmentCommandPending.value)
    return (
      import.meta.client &&
      window.confirm(
        'Hay un cambio del pedido sin confirmar. Si sales de esta pantalla no podrás comprobar su resultado. ¿Quieres salir?'
      )
    )
  return (
    !financialCommandPending.value ||
    (import.meta.client &&
      window.confirm(
        'Hay un reembolso sin confirmar. Si sales de esta pantalla no podrás comprobar su resultado. ¿Quieres salir?'
      ))
  )
}
onBeforeRouteLeave(confirmFinancialNavigation)
onBeforeRouteUpdate(confirmFinancialNavigation)
watch(orderId, () => {
  financialCommandPending.value = false
})

const { data, refresh, status, error } = await useFetch<OrderDetail>(() => `/api/admin/orders/${orderId.value}/detail`)
const timelineReady = computed(() => {
  const capabilities = timelineNavigation?.capabilities.value
  return (
    runtime === 'cloudflare' &&
    timelineSession.loggedIn.value &&
    !timelineScopeRevoked.value &&
    timelineScope.value === originalTimelineScope &&
    status.value === 'success' &&
    !cancellationReadFailed.value &&
    !error.value &&
    catalogPolicyUuidSchema.safeParse(orderId.value).success &&
    data.value?.order.id === orderId.value &&
    timelineNavigation?.status.value === 'ready' &&
    capabilities?.state === 'ready' &&
    capabilities.identityId === timelineSession.user.value?.id &&
    capabilities.sessionId === timelineSession.session.value?.sessionId &&
    capabilities.sessionVersion === timelineSession.session.value?.sessionVersion &&
    capabilities.permissions.includes('administration.manage')
  )
})
const annotationsReady = computed(
  () =>
    timelineReady.value &&
    timelineSession.user.value?.emailVerified === true &&
    timelineSession.user.value?.mfaVerified === true
)
watch(
  timelineReady,
  (allowed) => {
    if (!allowed) {
      cancellationPending.value = false
      annotationsPending.value = false
    }
  },
  { flush: 'sync' }
)
function beforeCancellationUnload(event: BeforeUnloadEvent) {
  if (cancellationPending.value || annotationsPending.value || fulfillmentCommandPending.value) {
    event.preventDefault()
    event.returnValue = ''
  }
}
onMounted(() => window.addEventListener('beforeunload', beforeCancellationUnload))
onBeforeUnmount(() => window.removeEventListener('beforeunload', beforeCancellationUnload))
async function cancellationConfirmed(raw: unknown) {
  const parsed = orderCancellationReceiptSchema.safeParse(raw)
  if (!timelineReady.value || !parsed.success || parsed.data.orderId !== orderId.value) return
  const scope = timelineScope.value,
    id = orderId.value
  cancellationPending.value = false
  try {
    await refresh()
  } catch {
    if (timelineScope.value === scope && orderId.value === id) cancellationReadFailed.value = true
  }
  if (timelineScope.value === scope && orderId.value === id && !timelineScopeRevoked.value) cancellationRevision.value++
}

useSeoMeta({ title: () => `Pedido ${orderId.value} · Admin` })

const order = computed(() => data.value?.order)
const TONES: Record<string, AdminTone> = { success: 'success', warning: 'warning', error: 'danger', info: 'info' }
/** Color de estado heredado (`UiColor`) → tono de `AdminBadge`. */
const tone = (color: string | undefined): AdminTone => TONES[color ?? ''] ?? 'neutral'
const shortId = (id: string) => '#' + id.slice(0, 8).toUpperCase()
const canChangeState = computed(() => data.value?.capabilities?.orderStatusUpdate ?? true)
const canShip = computed(() => data.value?.capabilities?.shipments ?? true)
function readState(map: Parameters<typeof metaFor>[0], value: string): ReturnType<typeof metaFor> {
  const labels: Record<string, string> = {
    unavailable: 'No disponible',
    expired: 'Caducado',
    processing: 'Procesando',
    provider_authorised: 'Autorizado por el banco',
    redirect_ready: 'Esperando al cliente en el banco',
    stock_exception: 'Incidencia de stock'
  }
  return labels[value]
    ? { label: labels[value]!, color: value === 'stock_exception' ? 'warning' : 'neutral' }
    : metaFor(map, value)
}
const statusMeta = computed(() =>
  order.value ? (ORDER_STATUS[order.value.status] ?? ORDER_STATUS.pendiente_pago!) : null
)

/**
 * La tira de diagnóstico. Un pedido lleva cinco máquinas de estado a la vez, y la
 * pregunta operativa casi siempre es en cuál de ellas se ha quedado parado.
 */
const machines = computed(() => {
  if (!order.value) return []
  return [
    { key: 'Pedido', meta: readState(ORDER_LIFECYCLE, order.value.orderStatus), icon: 'i-lucide-receipt-text' },
    { key: 'Cobro', meta: readState(PAYMENT_STATE, order.value.paymentStatus), icon: 'i-lucide-credit-card' },
    { key: 'Almacén', meta: readState(INVENTORY_STATE, order.value.inventoryStatus), icon: 'i-lucide-boxes' },
    { key: 'Preparación', meta: readState(SHIPMENT_STATE, order.value.fulfillmentStatus), icon: 'i-lucide-package' },
    { key: 'Factura', meta: readState(INVOICE_STATE, order.value.invoiceStatus), icon: 'i-lucide-file-text' }
  ]
})

const shippingLabel = computed(
  () =>
    SHIPPING_METHODS.find((method) => method.value === order.value?.shippingMethod)?.label ??
    order.value?.shippingMethod
)
const paymentLabel = computed(
  () =>
    PAYMENT_METHOD_LABEL[order.value?.paymentMethod ?? ''] ??
    (order.value?.paymentMethod || 'Método de pago no registrado')
)

const unitsTotal = computed(() => (data.value?.lines ?? []).reduce((sum, line) => sum + line.quantity, 0))
const refundedTotal = computed(() =>
  (data.value?.payments ?? []).reduce((sum, payment) => sum + (payment.refunded ?? 0), 0)
)

function address(value: Record<string, string | null> | null) {
  if (!value) return []
  return [
    value.recipientName || value.name,
    value.companyName || value.company,
    value.line1,
    value.line2,
    [value.postalCode, formatPlace(value.city)].filter(Boolean).join(' '),
    value.region,
    value.phone
  ].filter((part): part is string => Boolean(part && part.trim()))
}

/** Los estados que cambian entre dos entradas de la traza: lo demás es ruido. */
function transition(entry: OrderDetail['timeline'][number]) {
  if (!entry.fromState || !entry.toState) return []
  return Object.keys(entry.toState)
    .filter((key) => entry.fromState?.[key] !== entry.toState?.[key])
    .map((key) => ({ key, from: entry.fromState?.[key] ?? '—', to: entry.toState?.[key] ?? '—' }))
}

/**
 * `from_state` y `to_state` guardan las siete máquinas con clave corta —`order`,
 * `payment`, `fulfillment`…—, que no es como se llama ninguna columna. El mapa
 * traduce clave y valor a la vez.
 */
const MACHINE_LABEL: Record<string, string> = {
  order: 'Pedido',
  payment: 'Cobro',
  inventory: 'Almacén',
  fulfillment: 'Preparación',
  invoice: 'Factura',
  refund: 'Reembolso',
  return: 'Devolución'
}

const STATE_MAPS: Record<string, Record<string, { label: string; color: UiColor }>> = {
  order: ORDER_LIFECYCLE,
  payment: PAYMENT_STATE,
  inventory: INVENTORY_STATE,
  fulfillment: SHIPMENT_STATE,
  invoice: INVOICE_STATE,
  refund: REFUND_STATE,
  return: RETURN_STATE
}

function stateLabel(machine: string, value: string) {
  const map = STATE_MAPS[machine]
  return map ? metaFor(map, value).label : value
}

/* --- Acciones ----------------------------------------------------------- */
const saving = ref(false)

const changing = ref(false)
const nextStatus = ref('')
const reason = ref('')
const reasonError = computed(() =>
  reason.value.trim().length && reason.value.trim().length < 3 ? 'El motivo necesita al menos 3 caracteres.' : ''
)
const statusOptions = Object.entries(ORDER_STATUS).map(([value, meta]) => ({ label: meta.label, value }))

function startChange() {
  if (cancellationPending.value || annotationsPending.value || !canChangeState.value) return
  nextStatus.value = order.value?.status ?? ''
  reason.value = ''
  changing.value = true
}

async function confirmChange() {
  if (
    cancellationPending.value ||
    annotationsPending.value ||
    !canChangeState.value ||
    !order.value ||
    reason.value.trim().length < 3 ||
    nextStatus.value === order.value.status
  )
    return
  saving.value = true
  try {
    await $fetch(`/api/admin/orders/${orderId.value}`, {
      method: 'PUT',
      body: { status: nextStatus.value, reason: reason.value.trim() }
    })
    toast.add({
      title: `Estado cambiado a «${ORDER_STATUS[nextStatus.value]?.label}»`,
      color: 'success',
      icon: 'i-lucide-check'
    })
    changing.value = false
    await refresh()
  } catch (requestError) {
    toast.add({ title: apiErrorMessage(requestError, 'No se ha podido cambiar el estado'), color: 'error' })
  } finally {
    saving.value = false
  }
}

const shipping = ref(false)
const serviceCode = ref('')

function startShipment() {
  if (cancellationPending.value || annotationsPending.value || !canShip.value) return
  serviceCode.value = order.value?.shippingMethod === 'reparto' ? 'OWN-DAY' : 'STANDARD-PARCEL'
  shipping.value = true
}

async function confirmShipment() {
  if (cancellationPending.value || annotationsPending.value || !canShip.value || !serviceCode.value.trim()) return
  saving.value = true
  try {
    await $fetch(`/api/admin/orders/${orderId.value}/shipment`, {
      method: 'POST',
      body: { serviceCode: serviceCode.value.trim() }
    })
    toast.add({ title: 'Expedición creada', color: 'success', icon: 'i-lucide-truck' })
    shipping.value = false
    await refresh()
  } catch (requestError) {
    toast.add({ title: apiErrorMessage(requestError, 'No se ha podido crear la expedición'), color: 'error' })
  } finally {
    saving.value = false
  }
}

async function syncTracking(shipmentId: string) {
  if (cancellationPending.value || annotationsPending.value || data.value?.capabilities?.tracking === false) return
  try {
    await $fetch(`/api/admin/shipments/${shipmentId}/tracking`, { method: 'POST' })
    toast.add({ title: 'Seguimiento actualizado', color: 'success' })
    await refresh()
  } catch (requestError) {
    toast.add({ title: apiErrorMessage(requestError, 'No se ha podido sincronizar'), color: 'error' })
  }
}

const retrying = ref(false)
const invoiceReason = ref('')

async function retryInvoice() {
  if (cancellationPending.value || annotationsPending.value || data.value?.capabilities?.invoices === false) return
  if (invoiceReason.value.trim().length < 3) return
  saving.value = true
  try {
    await $fetch(`/api/admin/invoices/${orderId.value}/retry`, {
      method: 'POST',
      body: { reason: invoiceReason.value.trim() }
    })
    toast.add({ title: 'Emisión reintentada', color: 'success', icon: 'i-lucide-file-text' })
    retrying.value = false
    invoiceReason.value = ''
    await refresh()
  } catch (requestError) {
    toast.add({ title: apiErrorMessage(requestError, 'No se ha podido reintentar la factura'), color: 'error' })
  } finally {
    saving.value = false
  }
}

const notFound = computed(() => (error.value as { statusCode?: number } | null)?.statusCode === 404)
</script>

<template>
  <AdminPage :title="`Pedido ${shortId(orderId)}`" :back="{ to: '/admin/pedidos', label: 'Pedidos' }" description="">
    <template v-if="order && statusMeta" #title-extra>
      <AdminBadge :tone="tone(statusMeta.color)">{{ statusMeta.label }}</AdminBadge>
    </template>
    <template v-if="order" #actions>
      <AdminButton
        v-if="data?.capabilities?.customerPreview !== false"
        icon="i-lucide-external-link"
        :to="`/pedido/${order.id}`"
        target="_blank"
      >
        Ver como el cliente
      </AdminButton>
      <AdminButton v-if="canChangeState" variant="primary" icon="i-lucide-pencil" @click="startChange">
        Cambiar estado
      </AdminButton>
    </template>

    <div v-if="status === 'pending'" class="adm-stack" aria-busy="true">
      <span class="sr-only">Cargando el pedido…</span>
      <div class="h-20 animate-pulse rounded-[var(--radius-surface)] bg-[var(--surface-sunken)]" />
      <div class="grid grid-cols-1 gap-5 xl:grid-cols-3">
        <div class="h-96 animate-pulse rounded-[var(--radius-surface)] bg-[var(--surface-sunken)] xl:col-span-2" />
        <div class="h-64 animate-pulse rounded-[var(--radius-surface)] bg-[var(--surface-sunken)]" />
      </div>
    </div>

    <AdminCard v-else-if="error || !data" flush>
      <AdminEmptyState
        :variant="notFound ? 'empty' : 'error'"
        icon="i-lucide-file-question"
        :title="notFound ? 'Este pedido no existe' : 'No hemos podido cargar el pedido'"
        :description="
          notFound
            ? 'Comprueba el número y vuelve al listado de pedidos.'
            : 'Puede ser un fallo puntual de conexión. Vuelve a intentarlo.'
        "
      >
        <AdminButton v-if="notFound" to="/admin/pedidos" icon="i-lucide-arrow-left">Volver al listado</AdminButton>
        <AdminButton v-else icon="i-lucide-rotate-cw" @click="refresh()">Reintentar</AdminButton>
      </AdminEmptyState>
    </AdminCard>

    <div v-else-if="order" class="adm-stack">
      <!-- Resumen: de un vistazo, en qué punto está cada parte del pedido -->
      <AdminCard flush>
        <div
          class="flex flex-wrap items-center gap-x-6 gap-y-1 border-b border-[var(--border)] px-5 py-3 text-[var(--text-muted)]"
        >
          <span>{{ adminDate(order.createdAt, true) }}</span>
          <span class="font-semibold tabular-nums text-[var(--text-strong)]">{{
            formatPrice(order.totals.total)
          }}</span>
          <span>{{ unitsTotal }} {{ unitsTotal === 1 ? 'unidad' : 'unidades' }}</span>
          <span>{{ shippingLabel }}</span>
          <span>{{ paymentLabel }}</span>
          <span v-if="order.purchaseOrderReference" data-testid="order-purchase-reference" class="min-w-0">
            Referencia del cliente:
            <span class="font-medium text-[var(--text-strong)] [overflow-wrap:anywhere]">{{
              order.purchaseOrderReference
            }}</span>
          </span>
        </div>
        <ul class="grid grid-cols-2 gap-px bg-[var(--border)] sm:grid-cols-3 lg:grid-cols-5">
          <li v-for="machine in machines" :key="machine.key" class="bg-[var(--surface)] px-5 py-3">
            <p class="flex items-center gap-1.5 text-xs font-semibold text-[var(--text-muted)]">
              <UIcon :name="machine.icon" class="size-3.5" />
              {{ machine.key }}
            </p>
            <AdminBadge class="mt-1.5" :tone="tone(machine.meta.color)">{{ machine.meta.label }}</AdminBadge>
          </li>
        </ul>
      </AdminCard>

      <div class="grid grid-cols-1 items-start gap-5 xl:grid-cols-3">
        <div class="adm-stack min-w-0 xl:col-span-2">
          <!-- Artículos -->
          <AdminCard
            title="Artículos"
            :description="`${data.lines.length} ${data.lines.length === 1 ? 'referencia' : 'referencias'}`"
            flush
          >
            <div class="adm-table-wrap">
              <table class="adm-table min-w-[38rem]">
                <thead>
                  <tr>
                    <th scope="col">Artículo</th>
                    <th scope="col" data-numeric>Cantidad</th>
                    <th scope="col" data-numeric>Precio sin IVA</th>
                    <th scope="col" data-numeric>IVA</th>
                    <th scope="col" data-numeric>Total</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="line in data.lines" :key="line.id">
                    <td>
                      <div class="flex items-start gap-3">
                        <OrderLineThumb :line="line" size="sm" />
                        <div class="min-w-0">
                          <component
                            :is="line.slug ? 'NuxtLink' : 'p'"
                            :to="line.slug ? `/producto/${line.slug}` : undefined"
                            class="font-medium text-[var(--text-strong)]"
                            :class="line.slug && 'hover:text-neteco-700 hover:underline'"
                          >
                            {{ line.name }}
                          </component>
                          <p class="text-xs text-[var(--text-muted)]">
                            <span class="tabular-nums">{{ line.sku }}</span> · {{ line.format }}
                          </p>
                          <div v-if="!line.inCatalog || line.returned" class="mt-1 flex flex-wrap gap-1.5">
                            <AdminBadge v-if="!line.inCatalog" tone="warning">Ya no está en el catálogo</AdminBadge>
                            <AdminBadge v-if="line.returned" tone="warning">
                              {{ line.returned }} {{ line.returned === 1 ? 'unidad devuelta' : 'unidades devueltas' }}
                            </AdminBadge>
                          </div>
                        </div>
                      </div>
                    </td>
                    <td data-numeric class="align-top">
                      {{ line.quantity }}
                      <span class="block text-xs text-[var(--text-muted)]">{{ line.unitLabel }}</span>
                    </td>
                    <td data-numeric class="align-top">
                      {{ formatPrice(line.unitNet) }}
                      <span v-if="line.discountNet" class="block text-xs text-[var(--text-muted)]">
                        Descuento: −{{ formatPrice(line.discountNet) }}
                      </span>
                    </td>
                    <td data-numeric class="align-top text-[var(--text-muted)]">{{ line.taxRate / 100 }} %</td>
                    <td data-numeric class="align-top font-semibold text-[var(--text-strong)]">
                      {{ formatPrice(line.lineGross) }}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>

            <dl class="space-y-1.5 border-t border-[var(--border)] px-5 py-4 sm:ml-auto sm:max-w-sm">
              <div class="flex justify-between gap-4">
                <dt class="text-[var(--text-muted)]">
                  {{ order.totals.discountNet ? 'Productos antes de descuentos (sin IVA)' : 'Productos (sin IVA)' }}
                </dt>
                <dd class="tabular-nums">{{ formatPrice(order.totals.subtotalNet) }}</dd>
              </div>
              <div v-if="order.totals.discountNet" class="flex justify-between gap-4">
                <dt class="text-[var(--text-muted)]">Descuentos</dt>
                <dd class="tabular-nums">−{{ formatPrice(order.totals.discountNet) }}</dd>
              </div>
              <div class="flex justify-between gap-4">
                <dt class="text-[var(--text-muted)]">Envío</dt>
                <dd class="tabular-nums">
                  {{ order.totals.shippingNet ? formatPrice(order.totals.shippingNet) : 'Gratis' }}
                </dd>
              </div>
              <div class="flex justify-between gap-4">
                <dt class="text-[var(--text-muted)]">IVA</dt>
                <dd class="tabular-nums">{{ formatPrice(order.totals.tax) }}</dd>
              </div>
              <div
                class="flex justify-between gap-4 border-t border-[var(--border)] pt-2 font-semibold text-[var(--text-strong)]"
              >
                <dt>Total</dt>
                <dd class="tabular-nums">{{ formatPrice(order.totals.total) }}</dd>
              </div>
              <div v-if="refundedTotal" class="flex justify-between gap-4 text-[var(--text-muted)]">
                <dt>Reembolsado</dt>
                <dd class="tabular-nums">−{{ formatPrice(refundedTotal) }}</dd>
              </div>
            </dl>
          </AdminCard>

          <!-- Preparación y entrega -->
          <AdminCard
            v-if="runtime === 'cloudflare' && !cancellationPending && !annotationsPending"
            title="Preparación y entrega"
          >
            <OrderFulfillmentSection
              :order-id="orderId"
              :runtime="runtime"
              @confirmed="refresh()"
              @pending="fulfillmentCommandPending = $event"
            />
          </AdminCard>

          <!-- Envío -->
          <AdminCard title="Envío" flush>
            <template v-if="canShip && !data.shipments.length" #actions>
              <AdminButton size="sm" icon="i-lucide-truck" @click="startShipment">Crear envío</AdminButton>
            </template>

            <AdminEmptyState
              v-if="!data.shipments.length"
              compact
              icon="i-lucide-truck"
              :title="canShip ? 'Todavía no hay envío' : 'Sin envíos con transportista'"
              :description="
                !canShip
                  ? 'El seguimiento del pedido se lleva desde «Preparación y entrega».'
                  : order.paymentStatus === 'captured'
                    ? `El pedido está cobrado y listo para preparar. Entrega elegida por el cliente: ${shippingLabel}.`
                    : 'El envío se crea cuando el cobro está confirmado.'
              "
            />

            <ul v-else class="divide-y divide-[var(--border)]">
              <li v-for="shipment in data.shipments" :key="shipment.id" class="p-5">
                <div class="flex flex-wrap items-start justify-between gap-3">
                  <div class="min-w-0">
                    <p class="font-medium text-[var(--text-strong)]">
                      {{ shipment.provider }}
                      <span class="font-normal text-[var(--text-muted)]">· {{ shipment.serviceCode }}</span>
                    </p>
                    <div class="mt-1.5 flex flex-wrap items-center gap-2">
                      <AdminBadge :tone="tone(metaFor(SHIPMENT_STATE, shipment.status).color)">
                        {{ metaFor(SHIPMENT_STATE, shipment.status).label }}
                      </AdminBadge>
                      <span v-if="shipment.trackingNumber" class="text-xs tabular-nums text-[var(--text-muted)]">
                        {{ shipment.trackingNumber }}
                      </span>
                    </div>
                  </div>
                  <div class="flex shrink-0 gap-2">
                    <AdminButton
                      v-if="shipment.hasLabel"
                      :to="`/api/admin/shipments/${shipment.id}/label`"
                      target="_blank"
                      external
                      size="sm"
                      icon="i-lucide-printer"
                    >
                      Etiqueta
                    </AdminButton>
                    <AdminButton
                      size="sm"
                      icon="i-lucide-rotate-cw"
                      :aria-label="`Actualizar el seguimiento de ${shipment.trackingNumber ?? shipment.serviceCode}`"
                      @click="syncTracking(shipment.id)"
                    >
                      Actualizar seguimiento
                    </AdminButton>
                  </div>
                </div>

                <ol v-if="shipment.events.length" class="mt-4 space-y-2.5 border-l border-[var(--border)] pl-4">
                  <li v-for="shipmentEvent in shipment.events" :key="shipmentEvent.occurredAt" class="relative">
                    <span class="absolute -left-[1.3125rem] top-1.5 size-2 rounded-full bg-[var(--border-strong)]" />
                    <p class="text-[var(--text-strong)]">
                      {{ shipmentEvent.description || metaFor(SHIPMENT_STATE, shipmentEvent.status).label }}
                    </p>
                    <p class="text-xs text-[var(--text-muted)]">
                      {{ adminDate(shipmentEvent.occurredAt, true) }}
                      <template v-if="shipmentEvent.location"> · {{ formatPlace(shipmentEvent.location) }}</template>
                    </p>
                  </li>
                </ol>
                <p v-else class="adm-help mt-3">El transportista todavía no ha comunicado ningún movimiento.</p>
              </li>
            </ul>
          </AdminCard>

          <OrderTrackingPanel
            v-if="timelineReady"
            :order-id="orderId"
            audience="admin"
            :scope-key="originalTimelineScope"
            :enabled="timelineReady"
            :pending="financialCommandPending || cancellationPending || annotationsPending || fulfillmentCommandPending"
          />
          <BeplyOrderPanel
            v-if="timelineReady"
            :order-id="orderId"
            audience="admin"
            :scope-key="originalTimelineScope"
            :enabled="timelineReady"
            :pending="financialCommandPending || cancellationPending || annotationsPending || fulfillmentCommandPending"
          />

          <OrderRefundPanel
            v-if="runtime === 'cloudflare' && !cancellationPending && !annotationsPending"
            :key="orderId"
            :order-id="orderId"
            :runtime="runtime"
            audience="admin"
          >
            <template #admin="{ snapshot, credits, reload, authorize, operatorId }">
              <AdminRefundActions
                :order-id="orderId"
                :runtime="runtime"
                audience="admin"
                :operator-id="operatorId ?? ''"
                :snapshot="snapshot"
                :credits="credits"
                :authorize="authorize"
                :reload="reload"
                @pending="financialCommandPending = $event"
              />
            </template>
          </OrderRefundPanel>

          <!-- Devoluciones, solo si las hay -->
          <AdminCard v-if="data.returns.length" title="Devoluciones" flush>
            <ul class="divide-y divide-[var(--border)]">
              <li
                v-for="returnRow in data.returns"
                :key="returnRow.id"
                class="flex flex-wrap items-start justify-between gap-3 px-5 py-4"
              >
                <div class="min-w-0">
                  <p class="font-medium tabular-nums text-[var(--text-strong)]">{{ returnRow.publicNumber }}</p>
                  <p class="mt-0.5 text-[var(--text)]">{{ returnRow.reason }}</p>
                  <p class="mt-1 text-xs text-[var(--text-muted)]">
                    {{ returnRow.units }} {{ returnRow.units === 1 ? 'unidad' : 'unidades' }} ·
                    {{ adminDate(returnRow.createdAt) }}
                    <template v-if="returnRow.resolution"> · {{ returnRow.resolution }}</template>
                  </p>
                </div>
                <AdminBadge :tone="tone(metaFor(RETURN_STATE, returnRow.status).color)">
                  {{ metaFor(RETURN_STATE, returnRow.status).label }}
                </AdminBadge>
              </li>
            </ul>
          </AdminCard>

          <!-- Cronología -->
          <OrderTimelinePanel
            v-if="runtime === 'cloudflare' && timelineReady"
            :key="cancellationRevision"
            class="adm-card p-5"
            :order-id="orderId"
            audience="admin"
            :scope-key="originalTimelineScope"
            :enabled="timelineReady"
            :pending="status !== 'success' || timelineNavigation?.status.value !== 'ready'"
          />
          <AdminCard
            v-else-if="runtime !== 'cloudflare'"
            title="Historial del pedido"
            description="Quién hizo qué y cuándo"
            flush
          >
            <AdminEmptyState
              v-if="!data.timeline.length"
              compact
              icon="i-lucide-history"
              title="Sin movimientos registrados"
              description="Aquí aparece cada cambio de estado con su autor y su motivo."
            />

            <ol v-else class="space-y-4 p-5">
              <li v-for="entry in data.timeline" :key="entry.id" class="relative pl-7">
                <span
                  class="absolute left-0 top-0.5 flex size-5 items-center justify-center rounded-full bg-[var(--surface-sunken)]"
                >
                  <UIcon
                    :name="ORDER_EVENT[entry.eventType]?.icon ?? 'i-lucide-dot'"
                    class="size-3 text-[var(--text-muted)]"
                  />
                </span>
                <div class="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                  <p class="font-medium text-[var(--text-strong)]">
                    {{ ORDER_EVENT[entry.eventType]?.label ?? adminHumanize(entry.eventType) }}
                  </p>
                  <span class="text-xs text-[var(--text-muted)]">{{ adminDate(entry.createdAt, true) }}</span>
                </div>
                <p class="mt-0.5 text-xs text-[var(--text-muted)]">
                  {{ EVENT_ACTOR[entry.actorType]?.label ?? adminHumanize(entry.actorType) }}
                </p>
                <p v-if="entry.reason" class="mt-1 text-[var(--text)]">«{{ entry.reason }}»</p>
                <ul
                  v-if="transition(entry).length"
                  class="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--text-muted)]"
                >
                  <li v-for="change in transition(entry)" :key="change.key">
                    {{ MACHINE_LABEL[change.key] ?? adminHumanize(change.key) }}:
                    {{ stateLabel(change.key, change.from) }} →
                    <span class="font-medium text-[var(--text)]">{{ stateLabel(change.key, change.to) }}</span>
                  </li>
                </ul>
              </li>
            </ol>
          </AdminCard>
        </div>

        <!-- Columna lateral: cliente, cobro, facturación y notas -->
        <div class="adm-stack min-w-0 xl:sticky xl:top-4">
          <AdminCard title="Cliente">
            <p class="font-medium text-[var(--text-strong)]">
              {{ data.customer.company || data.customer.name || 'Sin nombre' }}
            </p>
            <p v-if="data.customer.company && data.customer.name" class="text-[var(--text)]">
              {{ data.customer.name }}
            </p>

            <div class="mt-3 space-y-1.5">
              <a
                v-if="data.customer.email"
                :href="`mailto:${data.customer.email}`"
                class="flex items-center gap-2 text-neteco-700 hover:underline"
              >
                <UIcon name="i-lucide-mail" class="size-4 shrink-0" />
                <span class="truncate">{{ data.customer.email }}</span>
              </a>
              <a
                v-if="data.customer.phone"
                :href="`tel:${data.customer.phone.replace(/\s/g, '')}`"
                class="flex items-center gap-2 text-neteco-700 hover:underline"
              >
                <UIcon name="i-lucide-phone" class="size-4 shrink-0" />
                {{ data.customer.phone }}
              </a>
              <p v-if="data.customer.taxId" class="flex items-center gap-2 text-[var(--text-muted)]">
                <UIcon name="i-lucide-building-2" class="size-4 shrink-0" />
                <span class="tabular-nums">{{ data.customer.taxId }}</span>
              </p>
            </div>

            <div class="mt-3 flex flex-wrap gap-2">
              <AdminBadge v-if="data.customer.isGuest" plain>Compró sin cuenta</AdminBadge>
              <AdminBadge
                v-else-if="data.customer.companyStatus && COMPANY_STATUS[data.customer.companyStatus]"
                :tone="tone(COMPANY_STATUS[data.customer.companyStatus]!.color)"
              >
                Empresa {{ COMPANY_STATUS[data.customer.companyStatus]!.label.toLowerCase() }}
              </AdminBadge>
            </div>

            <div class="mt-4 border-t border-[var(--border)] pt-3">
              <p class="adm-label">Dirección de entrega</p>
              <address v-if="address(data.shippingAddress).length" class="mt-1 not-italic text-[var(--text)]">
                <p v-for="part in address(data.shippingAddress)" :key="part">{{ part }}</p>
              </address>
              <p v-else class="adm-help mt-1">
                {{ order.shippingMethod === 'recogida' ? 'Recogida en almacén.' : 'Sin dirección de entrega.' }}
              </p>
              <p
                v-if="data.shippingAddress?.instructions"
                class="mt-2 rounded-[var(--radius-control)] bg-[var(--surface-sunken)] p-2.5 text-[var(--text)]"
              >
                {{ data.shippingAddress.instructions }}
              </p>
            </div>
          </AdminCard>

          <!-- Cobro -->
          <AdminCard title="Cobro" flush>
            <template #actions>
              <AdminBadge :tone="tone(readState(PAYMENT_STATE, order.paymentStatus).color)">
                {{ readState(PAYMENT_STATE, order.paymentStatus).label }}
              </AdminBadge>
            </template>

            <AdminEmptyState
              v-if="!data.payments.length"
              compact
              icon="i-lucide-credit-card"
              title="Sin intentos de pago"
              description="Este pedido todavía no tiene ningún intento de pago."
            />

            <ul v-else class="divide-y divide-[var(--border)]">
              <li v-for="payment in data.payments" :key="payment.id" class="px-5 py-4">
                <div class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                  <p class="font-medium text-[var(--text-strong)]">
                    {{ PAYMENT_METHOD_LABEL[payment.method] ?? adminHumanize(payment.method) }}
                  </p>
                  <p class="font-semibold tabular-nums text-[var(--text-strong)]">
                    {{ formatPrice(payment.amount) }}
                  </p>
                </div>

                <div class="mt-2 flex flex-wrap items-center gap-2">
                  <AdminBadge :tone="tone(readState(PAYMENT_STATE, payment.status).color)">
                    {{ readState(PAYMENT_STATE, payment.status).label }}
                  </AdminBadge>
                  <span v-if="payment.reference" class="text-xs tabular-nums text-[var(--text-muted)]">
                    Ref. {{ payment.reference }}
                  </span>
                  <span v-if="payment.refunded" class="text-xs text-[var(--text-muted)]">
                    Reembolsado {{ formatPrice(payment.refunded) }}
                  </span>
                </div>

                <p v-if="redsysReason(payment.lastResponseCode)" class="mt-2 text-[var(--text)]">
                  {{ redsysReason(payment.lastResponseCode) }}
                  <span v-if="payment.lastEventAt" class="text-[var(--text-muted)]">
                    · {{ adminDate(payment.lastEventAt, true) }}
                  </span>
                </p>
                <p v-else class="adm-help mt-2">Iniciado el {{ adminDate(payment.createdAt, true) }}</p>
              </li>
            </ul>
          </AdminCard>

          <AdminCard title="Facturación">
            <address v-if="address(data.billingAddress).length" class="not-italic text-[var(--text)]">
              <p v-for="part in address(data.billingAddress)" :key="part">{{ part }}</p>
            </address>
            <p v-else class="adm-help">Sin dirección de facturación.</p>

            <OrderFiscalSection
              v-if="runtime === 'cloudflare'"
              class="mt-3 border-t border-[var(--border)] pt-3"
              :order-id="orderId"
              :runtime="runtime"
              audience="admin"
            />
            <ul
              v-if="runtime !== 'cloudflare' && data.invoices.length"
              class="mt-3 space-y-2 border-t border-[var(--border)] pt-3"
            >
              <li v-for="invoice in data.invoices" :key="invoice.id" class="flex items-center justify-between gap-3">
                <div class="min-w-0">
                  <p class="truncate tabular-nums text-[var(--text-strong)]">
                    {{ invoice.series }}
                    <span v-if="invoice.kind === 'credit_note'" class="text-[var(--text-muted)]">(rectificativa)</span>
                  </p>
                  <p class="text-xs text-[var(--text-muted)]">{{ adminDate(invoice.createdAt) }}</p>
                </div>
                <span class="shrink-0 tabular-nums">{{ formatPrice(invoice.amount) }}</span>
              </li>
            </ul>

            <div v-if="runtime !== 'cloudflare'" class="mt-3 border-t border-[var(--border)] pt-3">
              <div class="flex items-center justify-between gap-3">
                <span class="text-[var(--text-muted)]">Estado de la factura</span>
                <AdminBadge :tone="tone(readState(INVOICE_STATE, order.invoiceStatus).color)">
                  {{ readState(INVOICE_STATE, order.invoiceStatus).label }}
                </AdminBadge>
              </div>
              <AdminButton
                v-if="
                  data.capabilities?.invoices !== false &&
                  ['failed', 'not_requested', 'queued'].includes(order.invoiceStatus) &&
                  order.paymentStatus === 'captured'
                "
                class="mt-3 w-full"
                size="sm"
                icon="i-lucide-rotate-cw"
                @click="retrying = true"
              >
                Volver a emitir la factura
              </AdminButton>
              <p v-if="data.capabilities?.invoices === false" class="adm-help mt-3">
                La emisión de facturas no está disponible.
                <template v-if="data.fiscalEvaluation">
                  Revisión fiscal: {{ adminStatusLabel(data.fiscalEvaluation.status).toLowerCase() }}.
                </template>
              </p>
            </div>
          </AdminCard>

          <OrderAnnotationsPanel
            v-if="annotationsReady"
            :key="orderId"
            class="adm-card p-5"
            :order-id="orderId"
            :scope-key="originalTimelineScope"
            :enabled="annotationsReady"
            :pending="financialCommandPending || fulfillmentCommandPending || cancellationPending || saving"
            @pending="annotationsPending = $event"
          />
          <div v-if="annotationsPending" data-order-annotations-pending role="status">
            <UAlert
              color="warning"
              variant="subtle"
              icon="i-lucide-hourglass"
              title="Hay un cambio de notas o etiquetas sin confirmar"
              description="No cierres esta pestaña hasta comprobar su resultado."
            />
          </div>
          <AdminCard v-if="runtime !== 'cloudflare' && data.notes.length" title="Notas internas">
            <ul class="space-y-3">
              <li v-for="note in data.notes" :key="note.id">
                <p class="text-[var(--text)]">{{ note.note }}</p>
                <p class="mt-0.5 text-xs text-[var(--text-muted)]">
                  {{ note.author ?? 'Equipo' }} · {{ adminDate(note.createdAt, true) }}
                </p>
              </li>
            </ul>
          </AdminCard>

          <AdminCard v-if="data.history.length" title="Pedidos anteriores" description="Del mismo cliente" flush>
            <ul class="divide-y divide-[var(--border)]">
              <li
                v-for="other in data.history"
                :key="other.id"
                class="flex items-center justify-between gap-3 px-5 py-2.5"
              >
                <NuxtLink
                  :to="`/admin/pedidos/${other.id}`"
                  class="font-medium tabular-nums text-neteco-700 hover:underline"
                  :title="other.id"
                >
                  {{ shortId(other.id) }}
                </NuxtLink>
                <span class="text-xs text-[var(--text-muted)]">{{ adminDate(other.createdAt) }}</span>
                <span class="shrink-0 font-medium tabular-nums">{{ formatPrice(other.total) }}</span>
              </li>
            </ul>
          </AdminCard>

          <!-- Zona de riesgo: cancelar el pedido -->
          <OrderCancellationPanel
            v-if="timelineReady"
            class="adm-card p-5"
            :order-id="orderId"
            audience="admin"
            :scope-key="originalTimelineScope"
            :enabled="timelineReady"
            :pending="financialCommandPending || fulfillmentCommandPending || annotationsPending || saving"
            @pending="cancellationPending = $event"
            @confirmed="cancellationConfirmed"
          />
          <div v-if="cancellationPending" data-order-cancellation-pending role="status">
            <UAlert
              color="warning"
              variant="subtle"
              icon="i-lucide-hourglass"
              title="Hay una cancelación sin confirmar"
              description="No cierres esta pestaña hasta comprobar su resultado."
            />
          </div>
        </div>
      </div>
    </div>

    <UModal v-model:open="changing" title="Cambiar el estado del pedido" :ui="{ footer: 'justify-end gap-2' }">
      <template #body>
        <div v-if="order" class="adm space-y-4">
          <p class="text-[var(--text)]">
            Pedido <span class="font-semibold tabular-nums">{{ shortId(order.id) }}</span> de
            <span class="font-semibold">{{ data?.customer.company || data?.customer.name }}</span
            >, por <span class="font-semibold tabular-nums">{{ formatPrice(order.totals.total) }}</span
            >.
          </p>
          <div class="flex items-center gap-3 rounded-[var(--radius-surface)] bg-[var(--surface-sunken)] p-3">
            <AdminBadge v-if="statusMeta" :tone="tone(statusMeta.color)">{{ statusMeta.label }}</AdminBadge>
            <UIcon name="i-lucide-arrow-right" class="size-4 text-[var(--text-muted)]" />
            <AdminBadge :tone="tone(ORDER_STATUS[nextStatus]?.color)">
              {{ ORDER_STATUS[nextStatus]?.label ?? adminStatusLabel(nextStatus) }}
            </AdminBadge>
          </div>
          <UFormField label="Nuevo estado" required>
            <USelect v-model="nextStatus" :items="statusOptions" class="w-full" />
          </UFormField>
          <UFormField
            label="Motivo del cambio"
            required
            hint="Queda guardado en el historial con tu usuario"
            :error="reasonError"
          >
            <UTextarea
              v-model="reason"
              class="w-full"
              :rows="2"
              placeholder="Por ejemplo: cobro confirmado por transferencia"
            />
          </UFormField>
        </div>
      </template>
      <template #footer>
        <AdminButton @click="changing = false">Cancelar</AdminButton>
        <AdminButton
          variant="primary"
          :disabled="reason.trim().length < 3 || nextStatus === order?.status"
          :loading="saving"
          @click="confirmChange"
        >
          Cambiar estado
        </AdminButton>
      </template>
    </UModal>

    <UModal v-model:open="shipping" title="Crear envío" :ui="{ footer: 'justify-end gap-2' }">
      <template #body>
        <div class="adm space-y-4">
          <p class="text-[var(--text)]">
            Pedido <span class="font-semibold tabular-nums">{{ order ? shortId(order.id) : '' }}</span> ·
            {{ shippingLabel }}
          </p>
          <UFormField label="Servicio del transportista" required hint="El código del servicio presupuestado">
            <UInput v-model="serviceCode" class="w-full" />
          </UFormField>
        </div>
      </template>
      <template #footer>
        <AdminButton @click="shipping = false">Cancelar</AdminButton>
        <AdminButton variant="primary" :disabled="!serviceCode.trim()" :loading="saving" @click="confirmShipment">
          Crear envío
        </AdminButton>
      </template>
    </UModal>

    <UModal v-model:open="retrying" title="Volver a emitir la factura" :ui="{ footer: 'justify-end gap-2' }">
      <template #body>
        <div class="adm space-y-4">
          <p class="text-[var(--text)]">
            Se volverá a pedir la factura del pedido
            <span class="font-semibold tabular-nums">{{ order ? shortId(order.id) : '' }}</span
            >. Si ya hay una emitida, no se duplica.
          </p>
          <UFormField label="Motivo" required hint="Queda guardado en el historial con tu usuario">
            <UTextarea
              v-model="invoiceReason"
              class="w-full"
              :rows="2"
              placeholder="Por ejemplo: falló el proveedor de facturación"
            />
          </UFormField>
        </div>
      </template>
      <template #footer>
        <AdminButton @click="retrying = false">Cancelar</AdminButton>
        <AdminButton
          variant="primary"
          :disabled="invoiceReason.trim().length < 3"
          :loading="saving"
          @click="retryInvoice"
        >
          Volver a emitir
        </AdminButton>
      </template>
    </UModal>
  </AdminPage>
</template>

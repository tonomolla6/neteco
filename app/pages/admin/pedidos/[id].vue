<script setup lang="ts">
import type { UiColor } from '~~/shared/types/catalog'
import OrderFulfillmentSection from '~/components/OrderFulfillmentSection.vue'
import OrderFiscalSection from '~/components/OrderFiscalSection.vue'
import OrderRefundPanel from '~/components/refunds/OrderRefundPanel.vue'
import AdminRefundActions from '~/components/refunds/AdminRefundActions.vue'
import OrderTimelinePanel from '~/components/OrderTimelinePanel.vue'
import OrderTrackingPanel from '~/components/OrderTrackingPanel.vue'
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
        'Hay una operación del pedido pendiente de confirmar. Su recuperación sólo está disponible en esta pestaña; si sales perderás su intención y clave. ¿Quieres salir?'
      )
    )
  return (
    !financialCommandPending.value ||
    (import.meta.client &&
      window.confirm(
        'Hay una operación financiera pendiente de confirmar. Si sales, perderás su clave de recuperación en esta pantalla. ¿Quieres salir?'
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
const canChangeState = computed(() => data.value?.capabilities?.orderStatusUpdate ?? true)
const canShip = computed(() => data.value?.capabilities?.shipments ?? true)
function readState(map: Parameters<typeof metaFor>[0], value: string): ReturnType<typeof metaFor> {
  const labels: Record<string, string> = {
    unavailable: 'No disponible',
    expired: 'Caducado',
    processing: 'Procesando',
    provider_authorised: 'Autorizado por proveedor',
    redirect_ready: 'Redirección preparada',
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
  <div>
    <UButton to="/admin/pedidos" variant="link" color="neutral" icon="i-lucide-arrow-left" class="-ml-2 mb-1 px-2">
      Pedidos
    </UButton>

    <UiPageHeader :title="`Pedido ${orderId}`">
      <template v-if="order" #actions>
        <UButton
          v-if="data?.capabilities?.customerPreview !== false"
          color="neutral"
          variant="outline"
          icon="i-lucide-external-link"
          :to="`/pedido/${order.id}`"
          target="_blank"
        >
          Ver como el cliente
        </UButton>
        <UButton v-if="canChangeState" icon="i-lucide-pencil" @click="startChange">Cambiar estado</UButton>
      </template>
    </UiPageHeader>

    <div v-if="status === 'pending'" class="space-y-4">
      <div class="h-24 animate-pulse rounded-[var(--radius-panel)] bg-[var(--surface-sunken)]" />
      <div class="grid gap-5 grid-cols-1 xl:grid-cols-3">
        <div class="h-96 animate-pulse rounded-[var(--radius-panel)] bg-[var(--surface-sunken)] xl:col-span-2" />
        <div class="h-64 animate-pulse rounded-[var(--radius-panel)] bg-[var(--surface-sunken)]" />
      </div>
    </div>

    <template v-else-if="error || !data">
      <UiSurface padding="none">
        <UiEmptyState
          :variant="notFound ? 'empty' : 'error'"
          :icon="notFound ? 'i-lucide-file-question' : 'i-lucide-triangle-alert'"
          :title="notFound ? 'Este pedido no existe' : 'No hemos podido cargar el pedido'"
          :description="
            notFound
              ? 'Comprueba el identificador y vuelve al listado de pedidos.'
              : 'Ha fallado la consulta al servidor. Vuelve a intentarlo.'
          "
        >
          <UButton v-if="notFound" to="/admin/pedidos" icon="i-lucide-arrow-left">Volver al listado</UButton>
          <UButton v-else icon="i-lucide-refresh-cw" @click="refresh()">Reintentar</UButton>
        </UiEmptyState>
      </UiSurface>
    </template>

    <template v-else-if="order">
      <p class="-mt-3 mb-5 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-[var(--text-muted)]">
        <UBadge v-if="statusMeta" :color="statusMeta.color" :icon="statusMeta.icon" variant="subtle">
          {{ statusMeta.label }}
        </UBadge>
        <span>·</span>
        <span>{{ formatDate(order.createdAt) }}</span>
        <span>·</span>
        <span class="tabular font-semibold text-[var(--text-strong)]">{{ formatPrice(order.totals.total) }}</span>
        <span>·</span>
        <span>{{ unitsTotal }} {{ unitsTotal === 1 ? 'unidad' : 'unidades' }}</span>
      </p>

      <div v-if="order.purchaseOrderReference" data-testid="order-purchase-reference" class="mb-5 min-w-0 text-sm">
        <p class="font-semibold">Referencia interna / PO</p>
        <p class="[overflow-wrap:anywhere]">{{ order.purchaseOrderReference }}</p>
      </div>

      <!-- Tira de diagnóstico: las cinco máquinas de estado, de un vistazo -->
      <UiSurface padding="none" class="mb-5 overflow-hidden">
        <ul
          class="grid divide-y divide-[var(--border)] grid-cols-1 sm:grid-cols-3 sm:divide-y-0 lg:grid-cols-5 sm:[&>li]:border-r sm:[&>li]:border-[var(--border)] sm:[&>li:last-child]:border-r-0"
        >
          <li v-for="machine in machines" :key="machine.key" class="p-4">
            <p class="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
              <UIcon :name="machine.icon" class="size-3.5" />
              {{ machine.key }}
            </p>
            <p class="mt-1.5 font-semibold" :class="STATE_TEXT[machine.meta.color]">
              {{ machine.meta.label }}
            </p>
          </li>
        </ul>
      </UiSurface>

      <div class="grid items-start gap-5 grid-cols-1 xl:grid-cols-3">
        <div class="space-y-5 xl:col-span-2">
          <!-- Contenido -->
          <UiSurface padding="none">
            <div class="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border)] p-5">
              <h2 class="font-semibold text-[var(--text-strong)]">
                Contenido
                <span class="ml-1 font-normal text-[var(--text-muted)]">
                  {{ data.lines.length }} {{ data.lines.length === 1 ? 'referencia' : 'referencias' }}
                </span>
              </h2>
              <p class="text-sm text-[var(--text-muted)]">{{ shippingLabel }} · {{ paymentLabel }}</p>
            </div>

            <div class="overflow-x-auto">
              <table class="w-full min-w-[38rem] text-sm">
                <thead>
                  <tr
                    class="border-b border-[var(--border)] text-left text-xs uppercase tracking-wide text-[var(--text-muted)]"
                  >
                    <th scope="col" class="px-5 py-2.5 font-semibold">Referencia</th>
                    <th scope="col" class="px-3 py-2.5 text-right font-semibold">Cantidad</th>
                    <th scope="col" class="px-3 py-2.5 text-right font-semibold">Precio neto</th>
                    <th scope="col" class="px-3 py-2.5 text-right font-semibold">IVA</th>
                    <th scope="col" class="px-5 py-2.5 text-right font-semibold">Total</th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-[var(--border)]">
                  <tr v-for="line in data.lines" :key="line.id">
                    <td class="px-5 py-3">
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
                            <span class="tabular">{{ line.sku }}</span> · {{ line.format }}
                          </p>
                          <p v-if="!line.inCatalog" class="mt-1 text-xs text-[var(--ui-warning)]">
                            Ya no está publicada en el catálogo
                          </p>
                          <p v-if="line.returned" class="mt-1 text-xs text-[var(--ui-warning)]">
                            {{ line.returned }} {{ line.returned === 1 ? 'unidad devuelta' : 'unidades devueltas' }}
                          </p>
                        </div>
                      </div>
                    </td>
                    <td class="tabular px-3 py-3 text-right align-top">
                      {{ line.quantity }}
                      <span class="block text-xs text-[var(--text-muted)]">{{ line.unitLabel }}</span>
                    </td>
                    <td class="tabular px-3 py-3 text-right align-top">
                      {{ formatPrice(line.unitNet) }}
                      <span v-if="line.discountNet" class="block text-xs text-[var(--ui-success)]">
                        Descuento de línea: −{{ formatPrice(line.discountNet) }}
                      </span>
                    </td>
                    <td class="tabular px-3 py-3 text-right align-top text-[var(--text-muted)]">
                      {{ line.taxRate / 100 }} %
                    </td>
                    <td class="tabular px-5 py-3 text-right align-top font-semibold">
                      {{ formatPrice(line.lineGross) }}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>

            <dl class="space-y-1.5 border-t border-[var(--border)] p-5 text-sm">
              <div class="flex justify-between gap-4">
                <dt class="text-[var(--text-muted)]">
                  {{ order.totals.discountNet ? 'Productos antes de descuentos (sin IVA)' : 'Productos (sin IVA)' }}
                </dt>
                <dd class="tabular">{{ formatPrice(order.totals.subtotalNet) }}</dd>
              </div>
              <div v-if="order.totals.discountNet" class="flex justify-between gap-4">
                <dt class="text-[var(--text-muted)]">Descuentos</dt>
                <dd class="tabular text-[var(--ui-success)]">−{{ formatPrice(order.totals.discountNet) }}</dd>
              </div>
              <div class="flex justify-between gap-4">
                <dt class="text-[var(--text-muted)]">Envío</dt>
                <dd class="tabular">
                  {{ order.totals.shippingNet ? formatPrice(order.totals.shippingNet) : 'Gratis' }}
                </dd>
              </div>
              <div class="flex justify-between gap-4">
                <dt class="text-[var(--text-muted)]">IVA</dt>
                <dd class="tabular">{{ formatPrice(order.totals.tax) }}</dd>
              </div>
              <div
                class="flex justify-between gap-4 border-t border-[var(--border)] pt-2 text-base font-semibold text-[var(--text-strong)]"
              >
                <dt>Total</dt>
                <dd class="tabular">{{ formatPrice(order.totals.total) }}</dd>
              </div>
              <div v-if="refundedTotal" class="flex justify-between gap-4 text-[var(--text-muted)]">
                <dt>Reembolsado</dt>
                <dd class="tabular">−{{ formatPrice(refundedTotal) }}</dd>
              </div>
            </dl>
          </UiSurface>

          <!-- Cobro -->
          <UiSurface padding="none">
            <div class="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border)] p-5">
              <h2 class="font-semibold text-[var(--text-strong)]">Cobro</h2>
              <UBadge :color="readState(PAYMENT_STATE, order.paymentStatus).color" variant="subtle">
                {{ readState(PAYMENT_STATE, order.paymentStatus).label }}
              </UBadge>
            </div>

            <UiEmptyState
              v-if="!data.payments.length"
              icon="i-lucide-credit-card"
              title="Sin intentos de pago"
              description="No hay un intento de pago registrado para este pedido."
            />

            <ul v-else class="divide-y divide-[var(--border)]">
              <li v-for="payment in data.payments" :key="payment.id" class="p-5">
                <div class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                  <p class="font-medium text-[var(--text-strong)]">
                    {{ PAYMENT_METHOD_LABEL[payment.method] ?? payment.method }}
                    <span class="font-normal text-[var(--text-muted)]">vía {{ payment.provider }}</span>
                  </p>
                  <p class="tabular font-semibold">{{ formatPrice(payment.amount) }}</p>
                </div>

                <div class="mt-2 flex flex-wrap items-center gap-2">
                  <UBadge :color="readState(PAYMENT_STATE, payment.status).color" variant="subtle">
                    {{ readState(PAYMENT_STATE, payment.status).label }}
                  </UBadge>
                  <span v-if="payment.reference" class="tabular text-xs text-[var(--text-muted)]">
                    Ref. {{ payment.reference }}
                  </span>
                  <span v-if="payment.refunded" class="text-xs text-[var(--text-muted)]">
                    Reembolsado {{ formatPrice(payment.refunded) }}
                  </span>
                </div>

                <p v-if="redsysReason(payment.lastResponseCode)" class="mt-2 text-sm text-[var(--text)]">
                  {{ redsysReason(payment.lastResponseCode) }}
                  <span v-if="payment.lastEventAt" class="text-[var(--text-muted)]">
                    · {{ formatDate(payment.lastEventAt) }}
                  </span>
                </p>
                <p v-else class="mt-2 text-sm text-[var(--text-muted)]">
                  Iniciado el {{ formatDate(payment.createdAt) }}
                </p>
              </li>
            </ul>
          </UiSurface>

          <OrderCancellationPanel
            v-if="timelineReady"
            :order-id="orderId"
            audience="admin"
            :scope-key="originalTimelineScope"
            :enabled="timelineReady"
            :pending="financialCommandPending || fulfillmentCommandPending || annotationsPending || saving"
            @pending="cancellationPending = $event"
            @confirmed="cancellationConfirmed"
          />
          <p v-if="cancellationPending" data-order-cancellation-pending role="status">
            Hay una cancelación pendiente de confirmar. Conserva esta pestaña para recuperar su resultado antes de otra
            operación.
          </p>
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

          <OrderFulfillmentSection
            v-if="runtime === 'cloudflare' && !cancellationPending && !annotationsPending"
            :order-id="orderId"
            :runtime="runtime"
            @confirmed="refresh()"
            @pending="fulfillmentCommandPending = $event"
          />

          <!-- Envío -->
          <UiSurface padding="none">
            <div class="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border)] p-5">
              <h2 class="font-semibold text-[var(--text-strong)]">Envío</h2>
              <UButton v-if="canShip && !data.shipments.length" size="sm" icon="i-lucide-truck" @click="startShipment">
                Crear expedición
              </UButton>
            </div>

            <UiEmptyState
              v-if="!data.shipments.length"
              icon="i-lucide-truck"
              :title="canShip ? 'Todavía no hay expedición' : 'Expedición no disponible'"
              :description="
                !canShip
                  ? 'Este entorno conserva el método y la dirección de entrega, pero no dispone de expediciones ni seguimiento.'
                  : order.paymentStatus === 'captured'
                    ? `El pedido está cobrado y listo para preparar. Método elegido por el cliente: ${shippingLabel}.`
                    : 'La expedición se crea cuando el cobro está confirmado.'
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
                      <UBadge :color="metaFor(SHIPMENT_STATE, shipment.status).color" variant="subtle">
                        {{ metaFor(SHIPMENT_STATE, shipment.status).label }}
                      </UBadge>
                      <span v-if="shipment.trackingNumber" class="tabular text-xs text-[var(--text-muted)]">
                        {{ shipment.trackingNumber }}
                      </span>
                    </div>
                  </div>
                  <div class="flex shrink-0 gap-1">
                    <UButton
                      v-if="shipment.hasLabel"
                      :to="`/api/admin/shipments/${shipment.id}/label`"
                      target="_blank"
                      external
                      size="xs"
                      variant="soft"
                      icon="i-lucide-printer"
                    >
                      Etiqueta
                    </UButton>
                    <UButton
                      size="xs"
                      color="neutral"
                      variant="outline"
                      icon="i-lucide-refresh-cw"
                      :aria-label="`Actualizar el seguimiento de ${shipment.trackingNumber ?? shipment.serviceCode}`"
                      @click="syncTracking(shipment.id)"
                    >
                      Seguimiento
                    </UButton>
                  </div>
                </div>

                <ol v-if="shipment.events.length" class="mt-4 space-y-2.5 border-l border-[var(--border)] pl-4">
                  <li v-for="shipmentEvent in shipment.events" :key="shipmentEvent.occurredAt" class="relative text-sm">
                    <span class="absolute -left-[1.3125rem] top-1.5 size-2 rounded-full bg-[var(--border-strong)]" />
                    <p class="text-[var(--text-strong)]">
                      {{ shipmentEvent.description || metaFor(SHIPMENT_STATE, shipmentEvent.status).label }}
                    </p>
                    <p class="text-xs text-[var(--text-muted)]">
                      {{ formatDate(shipmentEvent.occurredAt) }}
                      <template v-if="shipmentEvent.location"> · {{ formatPlace(shipmentEvent.location) }}</template>
                    </p>
                  </li>
                </ol>
                <p v-else class="mt-3 text-sm text-[var(--text-muted)]">
                  El transportista todavía no ha comunicado ningún movimiento.
                </p>
              </li>
            </ul>
          </UiSurface>

          <!-- Devoluciones, solo si las hay -->
          <UiSurface v-if="data.returns.length" padding="none">
            <h2 class="border-b border-[var(--border)] p-5 font-semibold text-[var(--text-strong)]">Devoluciones</h2>
            <ul class="divide-y divide-[var(--border)]">
              <li
                v-for="returnRow in data.returns"
                :key="returnRow.id"
                class="flex flex-wrap items-start justify-between gap-3 p-5"
              >
                <div class="min-w-0">
                  <p class="tabular font-medium text-[var(--text-strong)]">{{ returnRow.publicNumber }}</p>
                  <p class="mt-0.5 text-sm text-[var(--text)]">{{ returnRow.reason }}</p>
                  <p class="mt-1 text-xs text-[var(--text-muted)]">
                    {{ returnRow.units }} {{ returnRow.units === 1 ? 'unidad' : 'unidades' }} ·
                    {{ formatDate(returnRow.createdAt) }}
                    <template v-if="returnRow.resolution"> · {{ returnRow.resolution }}</template>
                  </p>
                </div>
                <UBadge :color="metaFor(RETURN_STATE, returnRow.status).color" variant="subtle">
                  {{ metaFor(RETURN_STATE, returnRow.status).label }}
                </UBadge>
              </li>
            </ul>
          </UiSurface>

          <!-- Traza -->
          <OrderTrackingPanel
            v-if="timelineReady"
            :order-id="orderId"
            audience="admin"
            :scope-key="originalTimelineScope"
            :enabled="timelineReady"
            :pending="financialCommandPending || cancellationPending || annotationsPending || fulfillmentCommandPending"
          />
          <UiSurface v-if="runtime === 'cloudflare' && timelineReady">
            <OrderTimelinePanel
              :key="cancellationRevision"
              :order-id="orderId"
              audience="admin"
              :scope-key="originalTimelineScope"
              :enabled="timelineReady"
              :pending="status !== 'success' || timelineNavigation?.status.value !== 'ready'"
            />
          </UiSurface>
          <UiSurface v-else-if="runtime !== 'cloudflare'" padding="none">
            <h2 class="border-b border-[var(--border)] p-5 font-semibold text-[var(--text-strong)]">
              Traza
              <span class="ml-1 font-normal text-[var(--text-muted)]">quién hizo qué y cuándo</span>
            </h2>

            <UiEmptyState
              v-if="!data.timeline.length"
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
                    {{ ORDER_EVENT[entry.eventType]?.label ?? entry.eventType }}
                  </p>
                  <span class="text-xs text-[var(--text-muted)]">{{ formatDate(entry.createdAt) }}</span>
                </div>
                <p class="mt-0.5 text-xs text-[var(--text-muted)]">
                  {{ EVENT_ACTOR[entry.actorType]?.label ?? entry.actorType }} · {{ entry.origin }}
                </p>
                <p v-if="entry.reason" class="mt-1 text-sm text-[var(--text)]">«{{ entry.reason }}»</p>
                <ul
                  v-if="transition(entry).length"
                  class="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--text-muted)]"
                >
                  <li v-for="change in transition(entry)" :key="change.key">
                    {{ MACHINE_LABEL[change.key] ?? change.key }}: {{ stateLabel(change.key, change.from) }} →
                    <span class="font-medium text-[var(--text)]">{{ stateLabel(change.key, change.to) }}</span>
                  </li>
                </ul>
              </li>
            </ol>
          </UiSurface>
        </div>

        <!-- Columna del cliente -->
        <div class="space-y-5 xl:sticky xl:top-4">
          <UiSurface>
            <h2 class="font-semibold text-[var(--text-strong)]">Cliente</h2>
            <p class="mt-2 font-medium text-[var(--text-strong)]">
              {{ data.customer.company || data.customer.name || 'Sin nombre' }}
            </p>
            <p v-if="data.customer.company && data.customer.name" class="text-sm text-[var(--text)]">
              {{ data.customer.name }}
            </p>

            <div class="mt-3 space-y-1.5 text-sm">
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
                <span class="tabular">{{ data.customer.taxId }}</span>
              </p>
            </div>

            <div class="mt-3 flex flex-wrap gap-2">
              <UBadge v-if="data.customer.isGuest" color="neutral" variant="subtle" icon="i-lucide-user-x">
                Compró sin cuenta
              </UBadge>
              <UBadge
                v-else-if="data.customer.companyStatus && COMPANY_STATUS[data.customer.companyStatus]"
                :color="COMPANY_STATUS[data.customer.companyStatus]!.color"
                variant="subtle"
              >
                Empresa {{ COMPANY_STATUS[data.customer.companyStatus]!.label.toLowerCase() }}
              </UBadge>
            </div>
          </UiSurface>

          <UiSurface>
            <h2 class="font-semibold text-[var(--text-strong)]">Entrega</h2>
            <address v-if="address(data.shippingAddress).length" class="mt-2 text-sm not-italic text-[var(--text)]">
              <p v-for="part in address(data.shippingAddress)" :key="part">{{ part }}</p>
            </address>
            <p v-else class="mt-2 text-sm text-[var(--text-muted)]">
              {{ order.shippingMethod === 'recogida' ? 'Recogida en almacén.' : 'Dirección de entrega no registrada.' }}
            </p>
            <p
              v-if="data.shippingAddress?.instructions"
              class="mt-2 rounded-[var(--radius-control)] bg-[var(--surface-sunken)] p-2.5 text-sm text-[var(--text)]"
            >
              {{ data.shippingAddress.instructions }}
            </p>
          </UiSurface>

          <UiSurface>
            <h2 class="font-semibold text-[var(--text-strong)]">Facturación</h2>
            <address v-if="address(data.billingAddress).length" class="mt-2 text-sm not-italic text-[var(--text)]">
              <p v-for="part in address(data.billingAddress)" :key="part">{{ part }}</p>
            </address>
            <p v-else class="mt-2 text-sm text-[var(--text-muted)]">Dirección de facturación no registrada.</p>

            <OrderFiscalSection
              v-if="runtime === 'cloudflare'"
              class="mt-3 border-t border-[var(--border)] pt-3"
              :order-id="orderId"
              :runtime="runtime"
              audience="admin"
            />
            <ul
              v-if="runtime !== 'cloudflare' && data.invoices.length"
              class="mt-3 space-y-2 border-t border-[var(--border)] pt-3 text-sm"
            >
              <li v-for="invoice in data.invoices" :key="invoice.id" class="flex items-center justify-between gap-3">
                <div class="min-w-0">
                  <p class="tabular truncate text-[var(--text-strong)]">
                    {{ invoice.series }}
                    <span v-if="invoice.kind === 'credit_note'" class="text-[var(--text-muted)]">(rectificativa)</span>
                  </p>
                  <p class="text-xs text-[var(--text-muted)]">{{ formatDate(invoice.createdAt) }}</p>
                </div>
                <span class="tabular shrink-0">{{ formatPrice(invoice.amount) }}</span>
              </li>
            </ul>

            <div v-if="runtime !== 'cloudflare'" class="mt-3 border-t border-[var(--border)] pt-3">
              <div class="flex items-center justify-between gap-3">
                <span class="text-sm text-[var(--text-muted)]">Estado</span>
                <UBadge :color="readState(INVOICE_STATE, order.invoiceStatus).color" variant="subtle">
                  {{ readState(INVOICE_STATE, order.invoiceStatus).label }}
                </UBadge>
              </div>
              <UButton
                v-if="
                  data.capabilities?.invoices !== false &&
                  ['failed', 'not_requested', 'queued'].includes(order.invoiceStatus) &&
                  order.paymentStatus === 'captured'
                "
                class="mt-3"
                size="sm"
                color="neutral"
                variant="outline"
                icon="i-lucide-refresh-cw"
                block
                @click="retrying = true"
              >
                Reintentar emisión
              </UButton>
              <p v-if="data.capabilities?.invoices === false" class="mt-3 text-sm text-[var(--text-muted)]">
                No hay emisión ni documentos fiscales disponibles.
                <template v-if="data.fiscalEvaluation">Evaluación fiscal: {{ data.fiscalEvaluation.status }}.</template>
              </p>
            </div>
          </UiSurface>

          <UiSurface v-if="data.history.length">
            <h2 class="font-semibold text-[var(--text-strong)]">
              Pedidos anteriores
              <span class="ml-1 text-sm font-normal text-[var(--text-muted)]">del mismo cliente</span>
            </h2>
            <ul class="mt-2 divide-y divide-[var(--border)] text-sm">
              <li v-for="other in data.history" :key="other.id" class="flex items-center justify-between gap-3 py-2">
                <NuxtLink :to="`/admin/pedidos/${other.id}`" class="tabular text-neteco-700 hover:underline">
                  {{ other.id }}
                </NuxtLink>
                <span class="text-xs text-[var(--text-muted)]">{{ formatDate(other.createdAt) }}</span>
                <span class="tabular shrink-0 font-medium">{{ formatPrice(other.total) }}</span>
              </li>
            </ul>
          </UiSurface>

          <UiSurface v-if="annotationsReady">
            <OrderAnnotationsPanel
              :key="orderId"
              :order-id="orderId"
              :scope-key="originalTimelineScope"
              :enabled="annotationsReady"
              :pending="financialCommandPending || fulfillmentCommandPending || cancellationPending || saving"
              @pending="annotationsPending = $event"
            />
          </UiSurface>
          <p v-if="annotationsPending" data-order-annotations-pending role="status">
            Hay una operación de notas o etiquetas pendiente de confirmar. Conserva esta pestaña para recuperar su
            resultado antes de otra operación.
          </p>
          <UiSurface v-if="runtime !== 'cloudflare' && data.notes.length">
            <h2 class="font-semibold text-[var(--text-strong)]">Notas internas</h2>
            <ul class="mt-2 space-y-3 text-sm">
              <li v-for="note in data.notes" :key="note.id">
                <p class="text-[var(--text)]">{{ note.note }}</p>
                <p class="mt-0.5 text-xs text-[var(--text-muted)]">
                  {{ note.author ?? 'Equipo' }} · {{ formatDate(note.createdAt) }}
                </p>
              </li>
            </ul>
          </UiSurface>
        </div>
      </div>
    </template>

    <UModal v-model:open="changing" title="Cambiar el estado del pedido">
      <template #body>
        <div v-if="order" class="space-y-4">
          <p class="text-[var(--text)]">
            Pedido <span class="tabular font-semibold">{{ order.id }}</span> de
            <span class="font-semibold">{{ data?.customer.company || data?.customer.name }}</span
            >, por <span class="tabular font-semibold">{{ formatPrice(order.totals.total) }}</span
            >.
          </p>
          <div class="flex items-center gap-3 rounded-[var(--radius-surface)] bg-[var(--surface-sunken)] p-3">
            <UBadge v-if="statusMeta" :color="statusMeta.color" variant="subtle">{{ statusMeta.label }}</UBadge>
            <UIcon name="i-lucide-arrow-right" class="size-4 text-[var(--text-muted)]" />
            <UBadge :color="ORDER_STATUS[nextStatus]?.color ?? 'neutral'" variant="subtle">
              {{ ORDER_STATUS[nextStatus]?.label ?? nextStatus }}
            </UBadge>
          </div>
          <UFormField label="Nuevo estado" required>
            <USelect v-model="nextStatus" :items="statusOptions" class="w-full" />
          </UFormField>
          <UFormField label="Motivo del cambio" required hint="Queda en la traza con tu usuario" :error="reasonError">
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
        <div class="flex w-full justify-end gap-2">
          <UButton color="neutral" variant="ghost" @click="changing = false">Cancelar</UButton>
          <UButton
            :disabled="reason.trim().length < 3 || nextStatus === order?.status"
            :loading="saving"
            @click="confirmChange"
          >
            Cambiar estado
          </UButton>
        </div>
      </template>
    </UModal>

    <UModal v-model:open="shipping" title="Crear expedición">
      <template #body>
        <div class="space-y-4">
          <p class="text-[var(--text)]">
            Pedido <span class="tabular font-semibold">{{ order?.id }}</span> · {{ shippingLabel }}
          </p>
          <UFormField label="Código de servicio cotizado" required>
            <UInput v-model="serviceCode" class="w-full font-mono" />
          </UFormField>
        </div>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton color="neutral" variant="ghost" @click="shipping = false">Cancelar</UButton>
          <UButton :disabled="!serviceCode.trim()" :loading="saving" @click="confirmShipment">Crear expedición</UButton>
        </div>
      </template>
    </UModal>

    <UModal v-model:open="retrying" title="Reintentar la emisión de la factura">
      <template #body>
        <div class="space-y-4">
          <p class="text-[var(--text)]">
            Se vuelve a encolar la factura del pedido <span class="tabular font-semibold">{{ order?.id }}</span
            >. Si ya existe una emitida, el sistema la rechaza en vez de duplicarla.
          </p>
          <UFormField label="Motivo" required hint="Queda en la traza con tu usuario">
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
        <div class="flex w-full justify-end gap-2">
          <UButton color="neutral" variant="ghost" @click="retrying = false">Cancelar</UButton>
          <UButton :disabled="invoiceReason.trim().length < 3" :loading="saving" @click="retryInvoice"
            >Reintentar</UButton
          >
        </div>
      </template>
    </UModal>
  </div>
</template>

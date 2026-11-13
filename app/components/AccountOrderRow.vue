<script setup lang="ts">
import type { OrderSummary } from '~/composables/useAccount'
import { readOrderDetail } from '~/utils/orderDetail'
import OrderTimelinePanel from '~/components/OrderTimelinePanel.vue'
import OrderCancellationPanel from '~/components/OrderCancellationPanel.vue'
import { orderCancellationReceiptSchema } from '~~/shared/order-cancellation'
import { catalogPolicyUuidSchema } from '~~/shared/catalog-publication-policy'

/**
 * Tarjeta de pedido del área de cliente, con el patrón de «Mis pedidos» de Amazon.
 *
 * Cabecera gris con fecha, total, destino y número; debajo el estado en grande, los productos
 * con su imagen y, a la derecha, una columna de acciones. Nada destructivo queda a la vista:
 * la cancelación y el historial se abren en un modal, y la devolución en su propia página.
 */
const props = withDefaults(
  defineProps<{
    order: OrderSummary
    defaultOpen?: boolean
    operationPending?: boolean
    navigationManaged?: boolean
  }>(),
  { defaultOpen: false, operationPending: false, navigationManaged: false }
)
const emit = defineEmits<{ reorder: [string]; pending: [boolean]; confirmed: [string] }>()

const cancelOpen = ref(false)
const timelineOpen = ref(false)
const showAllLines = ref(false)
const { user, session, loggedIn } = useUserSession()
const timelineCloudflare = useRuntimeConfig().public.serverRuntime === 'cloudflare'
const privateScope = computed(() =>
  JSON.stringify([
    loggedIn.value,
    user.value?.id,
    session.value?.sessionId,
    session.value?.sessionVersion,
    ...(timelineCloudflare ? [user.value?.emailVerified] : [])
  ])
)
const originalScope = privateScope.value
const originalOrderId = props.order.id
const scopeRevoked = ref(false)
const retryingRead = ref(false)
const failedRead = ref(false)
let active = true
watch(
  () => [privateScope.value, props.order.id],
  () => (scopeRevoked.value = true),
  { flush: 'sync' }
)

const { data, status, refresh } = await useLazyFetch<unknown>(
  `/api/orders/${encodeURIComponent(originalOrderId)}/lines`,
  {
    key: `order-lines-${originalScope}-${originalOrderId}`
  }
)
const detail = computed(() =>
  !scopeRevoked.value && !retryingRead.value && !failedRead.value && status.value === 'success'
    ? readOrderDetail(data.value, originalOrderId)
    : null
)
const readState = computed(() =>
  scopeRevoked.value
    ? 'error'
    : retryingRead.value || status.value === 'pending' || status.value === 'idle'
      ? 'loading'
      : detail.value
        ? 'success'
        : 'error'
)
const timelineReady = computed(
  () =>
    timelineCloudflare &&
    loggedIn.value &&
    user.value?.emailVerified === true &&
    !scopeRevoked.value &&
    privateScope.value === originalScope &&
    props.order.id === originalOrderId &&
    catalogPolicyUuidSchema.safeParse(originalOrderId).success &&
    catalogPolicyUuidSchema.safeParse(user.value?.id).success &&
    catalogPolicyUuidSchema.safeParse(session.value?.sessionId).success &&
    Number.isSafeInteger(session.value?.sessionVersion) &&
    (session.value?.sessionVersion ?? 0) > 0 &&
    readState.value === 'success' &&
    detail.value !== null
)
const cancellationPending = ref(false)
const cancellationRevision = ref(0)
const operationBlocked = computed(() => cancellationPending.value || props.operationPending)
function setCancellationPending(value: boolean) {
  cancellationPending.value = value
  emit('pending', value)
}
watch(
  timelineReady,
  (allowed) => {
    if (!allowed && cancellationPending.value) setCancellationPending(false)
  },
  { flush: 'sync' }
)
function confirmCancellationNavigation() {
  if (props.navigationManaged || !cancellationPending.value) return true
  return (
    import.meta.client &&
    window.confirm(
      'Hay una cancelación pendiente de confirmar. Su recuperación sólo está disponible en esta pestaña; si sales perderás su intención y clave. ¿Quieres salir?'
    )
  )
}
onBeforeRouteLeave(confirmCancellationNavigation)
onBeforeRouteUpdate(confirmCancellationNavigation)
function beforeUnload(event: BeforeUnloadEvent) {
  if (!props.navigationManaged && cancellationPending.value) {
    event.preventDefault()
    event.returnValue = ''
  }
}
onMounted(() => window.addEventListener('beforeunload', beforeUnload))
onBeforeUnmount(() => {
  window.removeEventListener('beforeunload', beforeUnload)
  if (cancellationPending.value) setCancellationPending(false)
})
async function cancellationConfirmed(raw: unknown) {
  const parsed = orderCancellationReceiptSchema.safeParse(raw)
  if (!active || !timelineReady.value || !parsed.success || parsed.data.orderId !== originalOrderId) return
  setCancellationPending(false)
  emit('confirmed', originalOrderId)
  retryingRead.value = true
  failedRead.value = false
  try {
    await refresh()
  } catch {
    if (active) failedRead.value = true
  } finally {
    if (active && !scopeRevoked.value) {
      retryingRead.value = false
      cancellationRevision.value++
    }
  }
}
async function retryRead() {
  if (!active || scopeRevoked.value || retryingRead.value || readState.value !== 'error') return
  retryingRead.value = true
  failedRead.value = false
  try {
    await refresh()
  } catch {
    if (active) failedRead.value = true
  } finally {
    if (active) retryingRead.value = false
  }
}
onBeforeUnmount(() => {
  active = false
})

const status_ = computed(() => ORDER_STATUS[props.order.status] ?? ORDER_STATUS.pendiente_pago!)
const invoiceable = computed(
  () =>
    props.order.invoiceAvailable !== false &&
    ['pagado', 'enviado', 'entregado', 'listo_recogida'].includes(props.order.status)
)
const lines = computed(() => detail.value?.lines ?? [])
const VISIBLE_LINES = 3
const visibleLines = computed(() => (showAllLines.value ? lines.value : lines.value.slice(0, VISIBLE_LINES)))
const extra = computed(() => Math.max(0, lines.value.length - VISIBLE_LINES))
/**
 * El plan de envíos solo sustituye a la lista de productos cuando aporta algo: varios envíos
 * o una fecha prevista. Un único envío sin fecha se queda en la lista de siempre, con precios.
 */
const shipmentPlan = computed(() => {
  const plan = detail.value?.shipmentPlan
  if (!plan) return null
  return plan.shipments.length > 1 || plan.shipments.some((shipment) => shipment.from || shipment.to) ? plan : null
})
const shortId = computed(() => props.order.id.slice(0, 8).toUpperCase())
/** Estados en los que tiene sentido ofrecer cada acción; el servidor decide al abrirla. */
const cancellable = computed(() =>
  ['pendiente_pago', 'pago_fallido', 'pendiente_transferencia', 'incidencia_stock', 'pagado', 'preparando'].includes(
    props.order.status
  )
)
const returnable = computed(() =>
  ['enviado', 'entregado', 'listo_recogida', 'reembolso_parcial'].includes(props.order.status)
)
const trackable = computed(() => props.order.status === 'enviado' || Boolean(detail.value?.shipment?.trackingNumber))
const statusLead = computed(() => {
  const place = detail.value?.destination
    ? `${detail.value.destination.postalCode} ${formatPlace(detail.value.destination.city)}`
    : ''
  switch (props.order.status) {
    case 'pendiente_pago':
      return 'Completa el pago para que empecemos a prepararlo.'
    case 'pendiente_transferencia':
      return 'Lo preparamos en cuanto recibamos la transferencia.'
    case 'pago_fallido':
      return 'El pago no se completó. Puedes reintentarlo desde el pedido.'
    case 'pagado':
    case 'preparando':
      return place ? `Lo estamos preparando para enviarlo a ${place}.` : 'Lo estamos preparando.'
    case 'enviado':
      return place ? `Va de camino a ${place}.` : 'Va de camino.'
    case 'listo_recogida':
      return 'Ya puedes pasar a recogerlo.'
    case 'entregado':
      return place ? `Entregado en ${place}.` : ''
    case 'cancelado':
      return 'Este pedido se canceló.'
    default:
      return ''
  }
})
watch(timelineReady, (allowed) => {
  if (!allowed) {
    if (!cancellationPending.value) cancelOpen.value = false
    timelineOpen.value = false
  }
})
const fulfillment = computed(() => {
  const raw = detail.value?.fulfillmentStatus
  return raw ? FULFILLMENT_STATUS[raw] : undefined
})
const shippingLabel = computed(
  () => SHIPPING_METHODS.find((method) => method.value === detail.value?.shippingMethod)?.label
)
</script>

<template>
  <article
    data-account-order
    class="overflow-hidden rounded-[var(--radius-panel)] border border-[var(--border)] bg-[var(--surface)]"
  >
    <!-- Cabecera: los cuatro datos con los que se reconoce un pedido -->
    <header
      class="flex flex-wrap items-start gap-x-8 gap-y-3 border-b border-[var(--border)] bg-[var(--surface-sunken)] px-4 py-3 text-sm sm:px-5"
    >
      <div>
        <p class="text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">Pedido realizado</p>
        <p class="mt-0.5 text-[var(--text-strong)]">{{ formatAccountDate(order.createdAt) }}</p>
      </div>
      <div>
        <p class="text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">Total</p>
        <p class="tabular mt-0.5 font-semibold text-[var(--text-strong)]">{{ formatPrice(order.total) }}</p>
      </div>
      <div v-if="detail?.destination" class="hidden sm:block">
        <p class="text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">Enviar a</p>
        <p class="mt-0.5 text-[var(--text-strong)]">
          {{ detail.destination.postalCode }} {{ formatPlace(detail.destination.city) }}
        </p>
      </div>
      <div class="ml-auto text-right">
        <p class="text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
          Pedido n.º <span class="tabular normal-case text-[var(--text-strong)]" :title="order.id">{{ shortId }}</span>
        </p>
        <p class="mt-0.5 flex flex-wrap justify-end gap-x-3">
          <NuxtLink
            v-if="order.fullDetailAvailable !== false"
            :to="`/pedido/${order.id}`"
            class="font-medium text-[var(--link)] hover:underline"
          >
            Ver detalles
          </NuxtLink>
          <a
            v-if="invoiceable"
            :href="`/api/orders/${order.id}/invoice`"
            target="_blank"
            rel="noopener"
            class="font-medium text-[var(--link)] hover:underline"
          >
            Factura
          </a>
        </p>
      </div>
    </header>

    <div class="flex flex-col gap-5 px-4 py-4 sm:px-5 md:flex-row md:items-start md:gap-8">
      <div class="min-w-0 flex-1">
        <!-- Estado: lo primero que se lee -->
        <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
          <p class="text-lg font-bold text-[var(--text-strong)]">{{ status_.label }}</p>
          <UBadge v-if="fulfillment" :icon="fulfillment.icon" color="neutral" variant="subtle">
            {{ fulfillment.label }}
          </UBadge>
        </div>
        <p v-if="statusLead || shippingLabel" class="mt-0.5 text-sm text-[var(--text-muted)]">
          {{ statusLead }}
          <template v-if="shippingLabel"> {{ shippingLabel }}.</template>
          <template v-if="detail?.shipment?.trackingNumber">
            Seguimiento: <span class="tabular">{{ detail.shipment.trackingNumber }}</span
            >.
          </template>
        </p>

        <!-- Productos, con su imagen -->
        <div v-if="readState === 'loading'" class="mt-4 space-y-3" role="status" aria-busy="true">
          <p class="sr-only">Cargando el contenido del pedido.</p>
          <div v-for="n in 2" :key="n" class="flex items-center gap-4" aria-hidden="true">
            <div class="size-20 animate-pulse rounded-[var(--radius-control)] bg-[var(--surface-sunken)]" />
            <div class="h-4 w-1/2 animate-pulse rounded bg-[var(--surface-sunken)]" />
          </div>
        </div>

        <div v-else-if="readState === 'error'" class="mt-4 space-y-3">
          <p class="text-sm text-red-700">No hemos podido cargar el contenido de este pedido.</p>
          <UButton v-if="scopeRevoked" to="/cuenta/pedidos" external color="neutral" variant="outline" size="sm">
            Volver a cargar Mis pedidos
          </UButton>
          <UButton v-else data-order-detail-retry color="neutral" variant="outline" size="sm" @click="retryRead">
            Reintentar lectura del pedido
          </UButton>
        </div>

        <!-- Con plan de envíos guardado: cada envío con su fecha, estado y productos -->
        <OrderShipmentPlan
          v-else-if="shipmentPlan"
          class="mt-4"
          :plan="shipmentPlan"
          :lines="lines"
          :status="order.status"
        />

        <ul v-else class="mt-4 space-y-4">
          <li v-for="line in visibleLines" :key="line.sku" class="flex items-start gap-4">
            <OrderLineThumb :line="line" size="lg" />
            <div class="min-w-0 flex-1">
              <component
                :is="line.slug ? 'NuxtLink' : 'p'"
                :to="line.slug ? `/producto/${line.slug}?sku=${encodeURIComponent(line.sku)}` : undefined"
                class="line-clamp-2 font-medium"
                :class="line.slug ? 'text-[var(--link)] hover:underline' : 'text-[var(--text-strong)]'"
              >
                {{ line.name }}
              </component>
              <p class="mt-0.5 text-sm text-[var(--text-muted)]">
                {{ line.format }} · Ref. {{ line.sku }}
                <template v-if="!line.available"> · {{ line.reason }}</template>
              </p>
              <p class="tabular mt-0.5 text-sm text-[var(--text)]">
                {{ line.quantity }} {{ line.quantity === 1 ? 'unidad' : 'unidades' }} ·
                <span class="font-semibold text-[var(--text-strong)]">{{ formatPrice(line.lineGross) }}</span>
              </p>
            </div>
          </li>
        </ul>
        <button
          v-if="extra && readState === 'success' && !shipmentPlan"
          type="button"
          class="mt-3 inline-flex min-h-9 items-center gap-1 text-sm font-medium text-[var(--link)] hover:underline"
          :aria-expanded="showAllLines"
          @click="showAllLines = !showAllLines"
        >
          <UIcon :name="showAllLines ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'" class="size-4" />
          {{
            showAllLines ? 'Ver menos' : `Ver ${extra} ${extra === 1 ? 'producto más' : 'productos más'} de este pedido`
          }}
        </button>

        <p
          v-if="cancellationPending"
          data-order-cancellation-pending
          role="status"
          class="mt-4 rounded-[var(--radius-control)] border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900"
        >
          Hay una cancelación pendiente de confirmar. Mantén esta pestaña abierta hasta ver el resultado.
        </p>
      </div>

      <!-- Acciones: una columna de botones del mismo ancho, como en Amazon -->
      <div v-if="!scopeRevoked" data-account-order-actions class="flex shrink-0 flex-col gap-2 md:w-60">
        <UButton
          block
          :disabled="operationBlocked"
          icon="i-lucide-rotate-cw"
          @click="!operationBlocked && emit('reorder', order.id)"
        >
          Volver a pedir
        </UButton>
        <UButton
          v-if="order.fullDetailAvailable !== false"
          block
          :disabled="operationBlocked"
          color="neutral"
          variant="outline"
          :to="`/pedido/${order.id}`"
        >
          Ver pedido
        </UButton>
        <UButton
          v-if="trackable && order.fullDetailAvailable !== false"
          block
          :disabled="operationBlocked"
          color="neutral"
          variant="outline"
          :to="`/pedido/${order.id}`"
        >
          Seguir envío
        </UButton>
        <UButton
          v-if="invoiceable"
          block
          :disabled="operationBlocked"
          color="neutral"
          variant="outline"
          :to="`/api/orders/${order.id}/invoice`"
          external
          target="_blank"
        >
          Descargar factura
        </UButton>
        <UButton
          v-if="returnable"
          block
          :disabled="operationBlocked"
          color="neutral"
          variant="outline"
          :to="`/devoluciones?pedido=${order.id}`"
        >
          Devolver productos
        </UButton>
        <UButton
          v-if="timelineReady"
          block
          data-order-timeline-open
          :disabled="operationBlocked"
          color="neutral"
          variant="outline"
          @click="timelineOpen = true"
        >
          Historial del pedido
        </UButton>
        <UButton
          v-if="timelineReady && cancellable"
          block
          data-order-cancel-open
          :disabled="props.operationPending"
          color="neutral"
          variant="outline"
          @click="cancelOpen = true"
        >
          Cancelar pedido
        </UButton>
        <UButton block color="neutral" variant="ghost" to="/contacto">Ayuda con este pedido</UButton>
      </div>
    </div>

    <!-- La cancelación nunca está a la vista: se abre aquí, bajo demanda -->
    <UModal
      v-model:open="cancelOpen"
      :title="`Cancelar el pedido ${shortId}`"
      description="Cuéntanos el motivo y confirma. Si el pedido ya no admite cancelación, te lo indicamos aquí."
      :dismissible="!cancellationPending"
      :close="!cancellationPending"
    >
      <template #body>
        <div class="account-main account-embedded">
          <OrderCancellationPanel
            v-if="timelineReady"
            :order-id="originalOrderId"
            audience="customer"
            :scope-key="originalScope"
            :enabled="timelineReady"
            :pending="operationPending"
            @pending="setCancellationPending"
            @confirmed="cancellationConfirmed"
          />
        </div>
      </template>
    </UModal>

    <UModal
      v-model:open="timelineOpen"
      :title="`Historial del pedido ${shortId}`"
      description="Los pasos registrados de este pedido, del más reciente al más antiguo."
    >
      <template #body>
        <div class="account-main">
          <OrderTimelinePanel
            v-if="timelineReady"
            :key="cancellationRevision"
            :order-id="originalOrderId"
            audience="customer"
            :scope-key="originalScope"
            :enabled="timelineReady"
            :pending="readState !== 'success'"
          />
        </div>
      </template>
    </UModal>
  </article>
</template>

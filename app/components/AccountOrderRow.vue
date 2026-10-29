<script setup lang="ts">
import type { OrderSummary } from '~/composables/useAccount'
import { readOrderDetail } from '~/utils/orderDetail'
import OrderTimelinePanel from '~/components/OrderTimelinePanel.vue'
import OrderCancellationPanel from '~/components/OrderCancellationPanel.vue'
import { orderCancellationReceiptSchema } from '~~/shared/order-cancellation'
import { catalogPolicyUuidSchema } from '~~/shared/catalog-publication-policy'

/**
 * Fila de pedido del área de cliente, desplegable en el sitio.
 *
 * Antes había que salir a `/pedido/[id]` para saber qué llevaba un pedido, lo que sacaba
 * al cliente del listado y le obligaba a volver atrás para mirar el siguiente. Ahora el
 * contenido —con imagen de cada referencia— y el estado del envío se abren aquí mismo,
 * y la página completa queda como un enlace más para quien la necesite.
 *
 * El contenido se pide en cuanto la fila se monta, no al desplegar: así las miniaturas
 * están disponibles ya en el estado plegado, que es lo que permite reconocer un pedido
 * de un vistazo sin leer su número.
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

const open = ref(props.defaultOpen)
const panelId = computed(() => `pedido-${props.order.id}`)
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
    open.value &&
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
const thumbs = computed(() => lines.value.slice(0, 4))
const extra = computed(() => Math.max(0, lines.value.length - thumbs.value.length))
const fulfillment = computed(() => {
  const raw = detail.value?.fulfillmentStatus
  return raw ? FULFILLMENT_STATUS[raw] : undefined
})
const shippingLabel = computed(
  () => SHIPPING_METHODS.find((method) => method.value === detail.value?.shippingMethod)?.label
)
</script>

<template>
  <article class="overflow-hidden rounded-[var(--radius-panel)] border border-[var(--border)] bg-[var(--surface)]">
    <!-- Cabecera plegada: toda la fila abre y cierra -->
    <button
      type="button"
      class="flex w-full flex-wrap items-center gap-x-5 gap-y-3 px-4 py-4 text-left transition-colors hover:bg-[var(--canvas)]"
      :aria-expanded="open"
      :aria-controls="panelId"
      :disabled="operationBlocked"
      @click="!operationBlocked && (open = !open)"
    >
      <div class="min-w-0 flex-1">
        <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span class="tabular font-semibold text-[var(--text-strong)]">{{ order.id }}</span>
          <UBadge :color="status_.color" :icon="status_.icon" variant="subtle">
            {{ status_.label }}
          </UBadge>
        </div>
        <p class="mt-1 text-sm text-[var(--text-muted)]">
          {{ formatAccountDate(order.createdAt) }} · {{ order.lines }}
          {{ order.lines === 1 ? 'referencia' : 'referencias' }}
          <template v-if="fulfillment"> · {{ fulfillment.label }}</template>
        </p>
      </div>

      <!-- Miniaturas: reconocer el pedido sin leer el número -->
      <div v-if="thumbs.length" class="flex items-center gap-1.5">
        <OrderLineThumb v-for="line in thumbs" :key="line.sku" :line="line" size="sm" />
        <span v-if="extra" class="tabular text-sm font-medium text-[var(--text-muted)]">+{{ extra }}</span>
      </div>
      <div v-else-if="readState === 'loading'" class="flex items-center gap-1.5" aria-hidden="true">
        <div
          v-for="n in 2"
          :key="n"
          class="size-10 animate-pulse rounded-[var(--radius-control)] bg-[var(--surface-sunken)]"
        />
      </div>

      <p class="tabular text-lg font-bold text-[var(--text-strong)]">{{ formatPrice(order.total) }}</p>

      <UIcon
        name="i-lucide-chevron-down"
        class="size-5 shrink-0 text-[var(--text-muted)] transition-transform"
        :class="open && 'rotate-180'"
      />
    </button>

    <div v-if="open" :id="panelId" class="border-t border-[var(--border)]">
      <!-- Envío -->
      <div
        v-if="detail"
        class="flex flex-wrap items-center gap-x-6 gap-y-2 bg-[var(--surface-sunken)] px-4 py-3 text-sm"
      >
        <span v-if="fulfillment" class="flex items-center gap-2 font-medium text-[var(--text-strong)]">
          <UIcon :name="fulfillment.icon" class="size-4" />
          {{ fulfillment.label }}
        </span>
        <span v-if="shippingLabel" class="text-[var(--text-muted)]">{{ shippingLabel }}</span>
        <span v-if="detail.destination" class="text-[var(--text-muted)]">
          {{ detail.destination.postalCode }} {{ formatPlace(detail.destination.city) }}
        </span>
        <span v-if="detail.shipment?.trackingNumber" class="tabular flex items-center gap-1.5 text-[var(--text-muted)]">
          <UIcon name="i-lucide-truck" class="size-4" />
          {{ detail.shipment.trackingNumber }}
        </span>
      </div>

      <!-- Líneas -->
      <div v-if="readState === 'loading'" class="space-y-3 p-4" role="status" aria-busy="true">
        <p class="sr-only">Cargando el contenido del pedido.</p>
        <div
          v-for="n in 2"
          :key="n"
          class="h-14 animate-pulse rounded-[var(--radius-surface)] bg-[var(--surface-sunken)]"
        />
      </div>

      <div v-else-if="readState === 'error'" class="space-y-3 px-4 py-6">
        <p role="alert" class="text-sm text-red-700">No hemos podido cargar el contenido de este pedido.</p>
        <UButton v-if="scopeRevoked" to="/cuenta/pedidos" external color="neutral" variant="outline">
          Volver a cargar Mis pedidos
        </UButton>
        <UButton v-else data-order-detail-retry color="neutral" variant="outline" @click="retryRead">
          Reintentar lectura del pedido
        </UButton>
      </div>

      <ul v-else class="divide-y divide-[var(--border)]">
        <li v-for="line in lines" :key="line.sku" class="flex items-center gap-4 px-4 py-3">
          <OrderLineThumb :line="line" />
          <div class="min-w-0 flex-1">
            <component
              :is="line.slug ? 'NuxtLink' : 'p'"
              :to="line.slug ? `/producto/${line.slug}?sku=${encodeURIComponent(line.sku)}` : undefined"
              class="font-medium text-[var(--text-strong)]"
              :class="line.slug && 'hover:text-neteco-700 hover:underline'"
            >
              {{ line.name }}
            </component>
            <p class="text-sm text-[var(--text-muted)]">
              {{ line.format }} · Ref. {{ line.sku }}
              <template v-if="!line.available"> · {{ line.reason }}</template>
            </p>
          </div>
          <span class="tabular shrink-0 text-sm text-[var(--text-muted)]">× {{ line.quantity }}</span>
          <span class="tabular w-20 shrink-0 text-right font-semibold text-[var(--text-strong)]">
            {{ formatPrice(line.lineGross) }}
          </span>
        </li>
      </ul>

      <!-- Totales -->
      <dl v-if="detail" class="space-y-1.5 border-t border-[var(--border)] px-4 py-3 text-sm">
        <div class="flex justify-between gap-4">
          <dt class="text-[var(--text-muted)]">Productos</dt>
          <dd class="tabular">{{ formatPrice(detail.totals.subtotalNet) }}</dd>
        </div>
        <div class="flex justify-between gap-4">
          <dt class="text-[var(--text-muted)]">Envío</dt>
          <dd class="tabular">
            {{ detail.totals.shippingNet ? formatPrice(detail.totals.shippingNet) : 'Gratis' }}
          </dd>
        </div>
        <div class="flex justify-between gap-4">
          <dt class="text-[var(--text-muted)]">IVA</dt>
          <dd class="tabular">{{ formatPrice(detail.totals.tax) }}</dd>
        </div>
        <div
          class="flex justify-between gap-4 border-t border-[var(--border)] pt-1.5 font-bold text-[var(--text-strong)]"
        >
          <dt>Total</dt>
          <dd class="tabular">{{ formatPrice(detail.totals.total) }}</dd>
        </div>
      </dl>

      <!-- Acciones -->
      <div v-if="timelineReady" class="border-t border-[var(--border)] px-4 py-3">
        <OrderCancellationPanel
          :order-id="originalOrderId"
          audience="customer"
          :scope-key="originalScope"
          :enabled="timelineReady"
          :pending="operationPending"
          @pending="setCancellationPending"
          @confirmed="cancellationConfirmed"
        />
      </div>
      <p v-if="cancellationPending" data-order-cancellation-pending role="status" class="px-4 py-3 text-sm">
        Hay una cancelación pendiente de confirmar. Conserva esta pestaña para recuperar su resultado antes de otra
        operación.
      </p>
      <div v-if="timelineReady" class="border-t border-[var(--border)] px-4 py-3">
        <OrderTimelinePanel
          :key="cancellationRevision"
          :order-id="originalOrderId"
          audience="customer"
          :scope-key="originalScope"
          :enabled="timelineReady"
          :pending="readState !== 'success'"
        />
      </div>
      <div v-if="!scopeRevoked" class="flex flex-wrap gap-2 border-t border-[var(--border)] px-4 py-3">
        <UButton
          :disabled="operationBlocked"
          icon="i-lucide-rotate-cw"
          @click="!operationBlocked && emit('reorder', order.id)"
          >Volver a pedir</UButton
        >
        <UButton
          v-if="invoiceable"
          :disabled="operationBlocked"
          color="neutral"
          variant="outline"
          icon="i-lucide-file-text"
          :to="`/api/orders/${order.id}/invoice`"
          external
          target="_blank"
        >
          Descargar factura
        </UButton>
        <UButton
          v-if="order.fullDetailAvailable !== false"
          :disabled="operationBlocked"
          color="neutral"
          variant="ghost"
          :to="`/pedido/${order.id}`"
          trailing
          icon="i-lucide-arrow-right"
        >
          Ver pedido completo
        </UButton>
      </div>
    </div>
  </article>
</template>

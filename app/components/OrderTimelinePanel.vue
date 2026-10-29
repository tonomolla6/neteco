<script setup lang="ts">
import { catalogPolicyUuidSchema } from '~~/shared/catalog-publication-policy'
import {
  decodeOrderTimelineCursor,
  orderTimelineResponseSchema,
  type ORDER_TIMELINE_STATES,
  type OrderTimelineItem
} from '~~/shared/order-timeline'

const props = defineProps<{
  orderId: string
  audience: 'customer' | 'admin'
  scopeKey: string
  enabled: boolean
  pending: boolean
}>()
const request = useRequestFetch(),
  prefix = useId()
const allowed = computed(
  () =>
    props.enabled &&
    !props.pending &&
    !!props.scopeKey &&
    catalogPolicyUuidSchema.safeParse(props.orderId).success &&
    ['customer', 'admin'].includes(props.audience)
)
const items = shallowRef<OrderTimelineItem[]>([]),
  nextCursor = ref<string | null>(null)
const status = ref<'idle' | 'loading' | 'ready' | 'error'>('idle')
type Attempt = Readonly<{ cursor: string | null; prefix: ReadonlyArray<OrderTimelineItem> }>
let attempt: Attempt | null = null,
  controller: AbortController | null = null,
  generation = 0,
  alive = true
const labels = {
  checkout: { created: 'Pedido registrado', cancelled: 'Cancelación del pedido confirmada' },
  payment: {
    notification_pending: 'Notificación de pago pendiente',
    notification_failed: 'Notificación de pago fallida',
    notification_cancelled: 'Notificación de cancelación de pago registrada',
    provider_authorised: 'Autorización del proveedor registrada; no confirma cobro',
    captured: 'Captura registrada',
    stock_exception: 'Incidencia de stock al confirmar el pago',
    notification_mismatch: 'Notificación de pago no coincidente'
  },
  fulfillment: {
    picking: 'Preparación iniciada',
    packed: 'Pedido empaquetado',
    ready_for_pickup: 'Pedido listo para recoger',
    in_transit: 'Pedido en tránsito',
    delivered: 'Entrega confirmada',
    exception: 'Incidencia de preparación o entrega'
  },
  return: {
    requested: 'Solicitud de devolución registrada',
    approved: 'Devolución aprobada',
    rejected: 'Devolución rechazada',
    received: 'Devolución recibida',
    inspected: 'Inspección de devolución registrada',
    resolution_ready: 'Resolución de devolución preparada'
  },
  refund: { succeeded: 'Reembolso registrado' },
  fiscal: { issued: 'Documento fiscal emitido', fiscal_pending: 'Documento fiscal pendiente' },
  credit: { issued: 'Rectificativa emitida', fiscal_pending: 'Rectificativa pendiente' }
} satisfies { [K in keyof typeof ORDER_TIMELINE_STATES]: Record<(typeof ORDER_TIMELINE_STATES)[K][number], string> }
function label(item: OrderTimelineItem) {
  return (labels[item.kind] as Record<string, string>)[item.state]
}
function older(item: OrderTimelineItem, previous: Pick<OrderTimelineItem, 'createdAt' | 'id'>) {
  return item.createdAt < previous.createdAt || (item.createdAt === previous.createdAt && item.id < previous.id)
}
function current(epoch: number) {
  return alive && allowed.value && epoch === generation
}
function invalidate() {
  generation++
  controller?.abort()
  controller = null
  items.value = []
  nextCursor.value = null
  attempt = null
  status.value = 'idle'
}
async function read(intent: Attempt) {
  if (!alive || !allowed.value || status.value === 'loading') return
  const epoch = generation,
    abort = new AbortController()
  controller = abort
  attempt = intent
  items.value = []
  nextCursor.value = null
  status.value = 'loading'
  try {
    const cursor = intent.cursor === null ? null : decodeOrderTimelineCursor(intent.cursor)
    if (cursor && (cursor.orderId !== props.orderId || cursor.audience !== props.audience))
      throw new Error('unconfirmed_cursor')
    const raw = await request(
      `/api/${props.audience === 'admin' ? 'admin/' : ''}orders/${encodeURIComponent(props.orderId)}/timeline`,
      {
        method: 'GET',
        query: { limit: 10, ...(intent.cursor === null ? {} : { cursor: intent.cursor }) },
        cache: 'no-store',
        retry: 0,
        signal: abort.signal
      }
    )
    if (!current(epoch)) return
    const result = orderTimelineResponseSchema.parse(raw)
    if (
      result.orderId !== props.orderId ||
      result.audience !== props.audience ||
      result.items.length > 10 ||
      result.items.some((item, index) => index > 0 && !older(item, result.items[index - 1]!))
    )
      throw new Error('unconfirmed_timeline')
    if (
      cursor &&
      (result.items.some(
        (item) => item.createdAt > cursor.asOf || !older(item, { createdAt: cursor.at, id: cursor.id })
      ) ||
        (result.nextCursor !== null && decodeOrderTimelineCursor(result.nextCursor).asOf !== cursor.asOf))
    )
      throw new Error('unconfirmed_snapshot')
    const combined = [...intent.prefix, ...result.items]
    if (new Set(combined.map((item) => item.id)).size !== combined.length) throw new Error('unconfirmed_timeline')
    items.value = combined
    nextCursor.value = result.nextCursor
    status.value = 'ready'
    attempt = null
  } catch {
    if (current(epoch)) {
      items.value = []
      nextCursor.value = null
      status.value = 'error'
    }
  } finally {
    if (current(epoch)) controller = null
  }
}
function more() {
  if (status.value === 'ready' && nextCursor.value !== null)
    void read(Object.freeze({ cursor: nextCursor.value, prefix: Object.freeze([...items.value]) }))
}
function retry() {
  if (status.value === 'error' && attempt) void read(attempt)
}
function refresh() {
  if (status.value === 'loading') return
  invalidate()
  if (allowed.value) void read(Object.freeze({ cursor: null, prefix: Object.freeze([]) }))
}
watch(
  [() => props.orderId, () => props.audience, () => props.scopeKey, () => props.enabled, () => props.pending],
  () => {
    invalidate()
    if (allowed.value) void read(Object.freeze({ cursor: null, prefix: Object.freeze([]) }))
  },
  { immediate: true, flush: 'sync' }
)
onBeforeUnmount(() => {
  alive = false
  invalidate()
})
</script>
<template>
  <section v-if="allowed" :aria-labelledby="prefix + '-title'" class="min-w-0 max-w-full space-y-3">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <h2 :id="prefix + '-title'" class="text-base font-semibold">Historial del pedido</h2>
      <button
        data-timeline-refresh
        type="button"
        :disabled="status === 'loading'"
        class="rounded border px-3 py-2 text-sm focus-visible:outline-2"
        @click="refresh"
      >
        Actualizar historial
      </button>
    </div>
    <p class="text-xs text-muted">
      Hitos registrados, del más reciente al más antiguo. Fechas del servidor en UTC. No anticipa entregas ni confirma
      liquidaciones bancarias.
    </p>
    <p v-if="status === 'loading'" data-timeline-loading role="status" aria-busy="true" class="text-sm">
      Consultando historial confirmado…
    </p>
    <div v-else-if="status === 'error'" data-timeline-error role="alert" class="space-y-2 text-sm">
      <p>
        No se ha podido confirmar el historial. La vista anterior se ha descartado; puedes reintentar la lectura o
        actualizar desde el inicio.
      </p>
      <button data-timeline-retry type="button" class="rounded border px-3 py-2 focus-visible:outline-2" @click="retry">
        Reintentar lectura del historial
      </button>
    </div>
    <p v-else-if="status === 'ready' && !items.length" data-timeline-empty role="status" class="text-sm">
      No hay hitos confirmados disponibles.
    </p>
    <ol
      v-else-if="status === 'ready'"
      class="min-w-0 divide-y divide-[var(--border)]"
      aria-label="Hitos confirmados del pedido"
    >
      <li
        v-for="item in items"
        :key="item.id"
        data-timeline-item
        class="min-w-0 break-words py-3 [overflow-wrap:anywhere]"
      >
        <p class="text-sm font-medium">{{ label(item) }}</p>
        <time :datetime="item.createdAt" class="block text-xs text-muted"
          >{{ item.createdAt.slice(0, 10) }} {{ item.createdAt.slice(11, 19) }} UTC</time
        >
        <p v-if="item.validationOnly === true" class="mt-1 text-sm">
          Validación local, no acredita un cobro/factura real ni un reembolso real.
        </p>
        <p
          v-if="item.kind === 'payment' && item.state === 'captured' && item.validationOnly === null"
          class="mt-1 text-sm"
        >
          Registro interno; no acredita liquidación bancaria.
        </p>
      </li>
    </ol>
    <button
      v-if="status === 'ready' && nextCursor !== null"
      data-timeline-more
      type="button"
      class="rounded border px-3 py-2 text-sm focus-visible:outline-2"
      @click="more"
    >
      Ver hitos anteriores
    </button>
  </section>
</template>

<script setup lang="ts">
import {
  orderTrackingSchema,
  orderTrackingAudienceSchema,
  type OrderTracking,
  type OrderTrackingAudience
} from '~~/shared/order-tracking'
import { catalogPolicyUuidSchema } from '~~/shared/catalog-publication-policy'

const props = defineProps<{
  orderId: string
  audience: OrderTrackingAudience
  scopeKey: string
  enabled: boolean
  pending?: boolean
}>()
const request = useRequestFetch()
const snapshot = shallowRef<OrderTracking | null>(null)
const loading = ref(false),
  failed = ref(false),
  stale = ref(false)
let active = true,
  generation = 0,
  started = false
let controller: AbortController | null = null
const authorized = () =>
  active &&
  props.enabled &&
  !props.pending &&
  !!props.scopeKey &&
  catalogPolicyUuidSchema.safeParse(props.orderId).success &&
  orderTrackingAudienceSchema.safeParse(props.audience).success
const labels: Record<OrderTracking['fulfillment']['state'], string> = {
  pending: 'Pendiente de preparación',
  picking: 'En preparación',
  packed: 'Embalado',
  ready_for_pickup: 'Listo para recoger',
  in_transit: 'En reparto',
  delivered: 'Entregado',
  exception: 'Incidencia operativa'
}
const methodLabels = { pickup: 'Recogida en almacén', own_delivery: 'Reparto propio', parcel: 'Paquetería' }
const date = (instant: string) => adminDate(instant, true)
function purge() {
  generation++
  controller?.abort()
  controller = null
  snapshot.value = null
  loading.value = failed.value = false
}
async function read() {
  if (!authorized() || loading.value) return
  const epoch = generation,
    orderId = props.orderId,
    audience = props.audience,
    scope = props.scopeKey
  const current = () =>
    authorized() &&
    generation === epoch &&
    props.orderId === orderId &&
    props.audience === audience &&
    props.scopeKey === scope
  const ownController = new AbortController()
  controller = ownController
  loading.value = true
  snapshot.value = null
  failed.value = false
  stale.value = false
  try {
    const endpoint: string = `/api/${audience === 'admin' ? 'admin/' : ''}orders/${orderId}/tracking`
    const raw: unknown = await request(endpoint, {
      method: 'GET',
      retry: 0,
      cache: 'no-store',
      signal: ownController.signal
    })
    if (!current()) return
    const parsed = orderTrackingSchema.safeParse(raw)
    if (!parsed.success || parsed.data.orderId !== orderId || parsed.data.audience !== audience)
      throw new Error('tracking_unconfirmed')
    snapshot.value = parsed.data
  } catch {
    if (current()) {
      snapshot.value = null
      failed.value = true
    }
  } finally {
    if (current()) {
      loading.value = false
      controller = null
    }
  }
}
watch(
  () => [props.orderId, props.audience, props.scopeKey, props.enabled, props.pending],
  () => {
    purge()
    stale.value = started
    // First authorized read only. A later authority/order boundary requires an
    // explicit refresh; old private facts are never kept while it is pending.
    if (authorized() && !started) {
      started = true
      void read()
    }
  },
  { immediate: true, flush: 'sync' }
)
onBeforeUnmount(() => {
  active = false
  purge()
})
</script>

<template>
  <section
    aria-label="Seguimiento operativo del pedido"
    class="min-w-0 space-y-4 rounded-[var(--radius-surface)] border border-[var(--border)] bg-[var(--surface)] p-5"
  >
    <div class="flex flex-wrap items-center justify-between gap-3">
      <h2 class="text-base font-semibold">Seguimiento operativo del pedido</h2>
      <button
        v-if="enabled"
        data-testid="order-tracking-refresh"
        type="button"
        :disabled="loading || pending || !authorized()"
        class="rounded-lg border border-[var(--border-strong)] px-4 py-2 text-sm font-semibold disabled:opacity-50"
        @click="read"
      >
        Actualizar seguimiento
      </button>
    </div>
    <p v-if="!enabled || pending" role="status" class="text-sm">
      El contexto autorizado está pendiente de confirmación. No se muestran datos anteriores.
    </p>
    <p v-else-if="loading" role="status" class="text-sm">Consultando el seguimiento confirmado…</p>
    <p v-else-if="failed" role="alert" class="text-sm text-[var(--text)]">
      No se pudo confirmar el seguimiento. No significa que no exista una expedición; puedes consultar de nuevo o
      contactar con NETECO.
    </p>
    <p v-else-if="stale" role="status" class="text-sm">
      El contexto ha cambiado. Actualiza el seguimiento para consultar datos vigentes.
    </p>
    <template v-if="snapshot && authorized()">
      <dl class="grid min-w-0 gap-3 text-sm sm:grid-cols-2">
        <div>
          <dt class="font-semibold">Modalidad de entrega</dt>
          <dd>{{ snapshot.shippingMethod ? methodLabels[snapshot.shippingMethod] : 'Modalidad no confirmada' }}</dd>
        </div>
        <div>
          <dt class="font-semibold">Estado operativo registrado</dt>
          <dd>
            {{
              snapshot.shippingMethod === 'pickup' && snapshot.fulfillment.state === 'delivered'
                ? 'Recogido'
                : labels[snapshot.fulfillment.state]
            }}
          </dd>
        </div>
        <div>
          <dt class="font-semibold">Preparación</dt>
          <dd>
            Versión {{ snapshot.fulfillment.version
            }}<template v-if="snapshot.fulfillment.updatedAt">
              ·
              <time :datetime="snapshot.fulfillment.updatedAt">{{
                date(snapshot.fulfillment.updatedAt)
              }}</time></template
            >
          </dd>
        </div>
        <div>
          <dt class="font-semibold">Bultos registrados</dt>
          <dd>
            {{ snapshot.packing.parcelCount || 'No hay bultos registrados'
            }}<template v-if="snapshot.packing.recordedAt">
              · <time :datetime="snapshot.packing.recordedAt">{{ date(snapshot.packing.recordedAt) }}</time></template
            >
          </dd>
        </div>
      </dl>
      <ul v-if="snapshot.shipments.length" aria-label="Referencias manuales de seguimiento" class="space-y-3">
        <li
          v-for="shipment in snapshot.shipments"
          :key="shipment.parcelIndex"
          class="min-w-0 space-y-1 rounded-[var(--radius-surface)] border border-[var(--border)] p-3 text-sm"
        >
          <p class="font-semibold">Bulto {{ shipment.parcelIndex + 1 }} · referencia manual no verificada</p>
          <dl class="space-y-2">
            <div>
              <dt class="font-medium">Transportista indicado</dt>
              <dd class="break-words">{{ shipment.carrier }}</dd>
            </div>
            <div>
              <dt class="font-medium">Número de seguimiento registrado</dt>
              <dd class="break-all">{{ shipment.trackingNumber }}</dd>
            </div>
            <div>
              <dt class="font-medium">Registro manual</dt>
              <dd>
                <time :datetime="shipment.recordedAt">{{ date(shipment.recordedAt) }}</time>
              </dd>
            </div>
          </dl>
        </li>
      </ul>
      <p v-else class="text-sm">No hay referencias manuales de seguimiento registradas.</p>
      <p class="text-sm">
        Seguimiento del transportista no conectado. El registro manual no acredita aceptación ni eventos del
        transportista; no permite inferir que el pedido está en reparto o entregado.
      </p>
      <p class="text-xs text-[var(--text-muted)]">
        Consulta confirmada: <time :datetime="snapshot.evaluatedAt">{{ date(snapshot.evaluatedAt) }}</time>
      </p>
    </template>
    <a href="/contacto" class="inline-block text-sm font-semibold text-neteco-700 underline"
      >Contactar con NETECO sobre el seguimiento</a
    >
  </section>
</template>

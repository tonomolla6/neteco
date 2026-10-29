<script setup lang="ts">
import {
  adminOrderFulfillmentSchema,
  fulfillmentCommandReceiptSchema,
  fulfillmentTransitionInputSchema,
  type AdminOrderFulfillment,
  type FulfillmentAction,
  type FulfillmentCommandReceipt,
  type FulfillmentTransitionInput,
  type OrderFulfillmentState
} from '~~/shared/order-fulfillment'
import { catalogPolicyOwnJson, catalogPolicyUuidSchema } from '~~/shared/catalog-publication-policy'

const props = defineProps<{
  snapshot: unknown
  operatorId: string
  runtime: unknown
  authorize: () => boolean
  reload: () => Promise<unknown>
}>()
const emit = defineEmits<{ confirmed: [receipt: FulfillmentCommandReceipt]; pending: [value: boolean] }>()
const labels: Record<OrderFulfillmentState, string> = {
  pending: 'Pendiente de preparación',
  picking: 'En preparación',
  packed: 'Embalado',
  ready_for_pickup: 'Listo para recoger',
  in_transit: 'En reparto',
  delivered: 'Entregado',
  exception: 'Incidencia operativa'
}
const reason = ref(''),
  evidence = ref(''),
  selected = ref<FulfillmentAction | ''>('')
const busy = ref(false),
  ambiguous = ref(false),
  message = ref(''),
  contextCurrent = ref(true)
type Intent = {
  body: Readonly<FulfillmentTransitionInput>
  key: string
  orderId: string
  warehouseId: string
  operatorId: string
  interruptedState: OrderFulfillmentState | null
}
const intent = shallowRef<Readonly<Intent> | null>(null)
let active = true,
  generation = 0
onBeforeUnmount(() => {
  active = false
  generation++
})
function authorized() {
  try {
    return (
      active &&
      props.runtime === 'cloudflare' &&
      props.authorize() === true &&
      catalogPolicyUuidSchema.safeParse(props.operatorId).success
    )
  } catch {
    return false
  }
}
const view = computed(() => {
  if (!contextCurrent.value || !authorized()) return null
  const parsed = adminOrderFulfillmentSchema.safeParse(props.snapshot)
  return parsed.success ? parsed.data : null
})
watch(
  intent,
  (value) => {
    if (active) emit('pending', value !== null)
  },
  { flush: 'sync' }
)
watch(
  () => [props.operatorId, props.runtime, props.authorize()],
  () => {
    generation++
    contextCurrent.value = false
    message.value = 'Ha cambiado el acceso. No se enviará el intento de otro operador.'
  }
)
watch(
  () => props.snapshot,
  () => {
    if (authorized() && adminOrderFulfillmentSchema.safeParse(props.snapshot).success) contextCurrent.value = true
  }
)
function prepare() {
  message.value = ''
  if (busy.value || intent.value || !authorized()) return
  const data = view.value
  if (
    !data ||
    !data.warehouse ||
    !data.readiness.ready ||
    !data.capabilities.fulfillmentTransitions ||
    !selected.value ||
    !data.capabilities.allowedActions.includes(selected.value)
  )
    return
  const input = fulfillmentTransitionInputSchema.safeParse({
    action: selected.value,
    expectedVersion: data.version,
    reason: reason.value,
    ...(evidence.value ? { evidence: evidence.value } : {})
  })
  if (!input.success) {
    message.value =
      'Indica un motivo de 10–500 caracteres. El reparto, la entrega y las incidencias necesitan evidencia operativa verificable.'
    return
  }
  intent.value = Object.freeze({
    body: Object.freeze(input.data),
    key: crypto.randomUUID(),
    orderId: data.orderId,
    warehouseId: data.warehouse.id,
    operatorId: props.operatorId,
    interruptedState: input.data.action === 'exception' ? data.state : null
  })
}
function own(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object') return undefined
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined
}
function code(raw: unknown): string | null {
  try {
    const data = catalogPolicyOwnJson(raw),
      failure = own(data, 'error'),
      value = own(failure, 'code')
    return typeof value === 'string' ? value : null
  } catch {
    return null
  }
}
function responseFailure(context: unknown) {
  const response = own(context, 'response')
  let status = own(response, 'status')
  if (status === undefined && response instanceof Response) {
    try {
      status = Object.getOwnPropertyDescriptor(Response.prototype, 'status')?.get?.call(response)
    } catch {
      return null
    }
  }
  return typeof status === 'number' && status >= 400 && status < 500 ? code(own(response, '_data')) : null
}
const definitive = new Set([
  'invalid_input',
  'not_found',
  'version_conflict',
  'idempotency_conflict',
  'invalid_transition',
  'shipping_mode_mismatch',
  'order_cancelled',
  'payment_unconfirmed',
  'inventory_unconfirmed',
  'warehouse_unavailable',
  'shipping_mode_unavailable',
  'csrf_rejected',
  'invalid_idempotency_key',
  'rate_limited',
  'body_too_large',
  'json_required',
  'invalid_json',
  'unauthenticated',
  'email_unverified',
  'mfa_required',
  'forbidden'
])
async function dispatch(replay = false) {
  const pending = intent.value
  if (!pending || busy.value || !authorized() || pending.operatorId !== props.operatorId) return
  busy.value = true
  message.value = ''
  const epoch = generation
  const current = () => active && generation === epoch && authorized() && props.operatorId === pending.operatorId
  let sent = false,
    responseCode: string | null = null
  try {
    const raw = await props.reload()
    if (!current()) return
    const fresh = adminOrderFulfillmentSchema.safeParse(raw)
    if (
      !fresh.success ||
      fresh.data.orderId !== pending.orderId ||
      !fresh.data.warehouse ||
      fresh.data.warehouse.id !== pending.warehouseId ||
      !authorized()
    )
      throw new Error('fulfillment_authority_unconfirmed')
    const data = fresh.data
    if (
      !replay &&
      (!data.readiness.ready ||
        !data.capabilities.fulfillmentTransitions ||
        !data.capabilities.allowedActions.includes(pending.body.action) ||
        data.version !== pending.body.expectedVersion)
    ) {
      intent.value = null
      ambiguous.value = false
      contextCurrent.value = false
      message.value =
        'La preparación ha cambiado o está bloqueada. Revisa el estado actual antes de preparar otra operación.'
      return
    }
    // A historical same-key recovery remains valid after later transitions.
    // It must not be reinterpreted as a fresh transition on the new version.
    sent = true
    ambiguous.value = true
    // This private endpoint belongs to the native Worker router, not the
    // generated legacy Nitro order route/method union.
    const endpoint: string = `/api/admin/orders/${pending.orderId}/fulfillment/transitions`
    const result: unknown = await $fetch(endpoint, {
      method: 'POST',
      headers: { 'Idempotency-Key': pending.key },
      body: pending.body,
      retry: 0,
      onResponseError(context: unknown) {
        responseCode = responseFailure(context)
      }
    })
    if (!current()) return
    const parsed = fulfillmentCommandReceiptSchema.safeParse(catalogPolicyOwnJson(result))
    if (
      !parsed.success ||
      parsed.data.orderId !== pending.orderId ||
      parsed.data.warehouseId !== pending.warehouseId ||
      parsed.data.action !== pending.body.action ||
      parsed.data.version !== pending.body.expectedVersion + 1 ||
      parsed.data.interruptedState !== pending.interruptedState
    )
      throw new Error('fulfillment_receipt_unconfirmed')
    if (!authorized()) throw new Error('fulfillment_authority_unconfirmed')
    intent.value = null
    ambiguous.value = false
    reason.value = ''
    evidence.value = ''
    selected.value = ''
    message.value = 'Operación confirmada y auditada. No se ha vuelto a descontar inventario.'
    emit('confirmed', parsed.data)
    contextCurrent.value = false
    try {
      const refreshed = await props.reload()
      if (!current()) return
      const latest = adminOrderFulfillmentSchema.safeParse(refreshed)
      if (!latest.success || latest.data.orderId !== pending.orderId || latest.data.version < parsed.data.version)
        throw new Error('fulfillment_context_unconfirmed')
      contextCurrent.value = true
    } catch {
      if (current())
        message.value += ' No se ha podido refrescar el estado: el recibo es histórico, no una consulta actual.'
    }
  } catch {
    if (!current()) return
    contextCurrent.value = false
    const authFailure =
      responseCode && ['unauthenticated', 'email_unverified', 'mfa_required', 'forbidden'].includes(responseCode)
    if (responseCode && definitive.has(responseCode) && !(authFailure && (sent || replay))) {
      intent.value = null
      ambiguous.value = false
      message.value = 'La operación se ha rechazado. Refresca y revisa el pago, la asignación y la versión del pedido.'
    } else {
      ambiguous.value = sent || replay
      message.value = ambiguous.value
        ? 'No hay confirmación. El envío pudo haberse guardado: conserva el mismo intento y recupéralo sin crear otra operación.'
        : 'No se ha podido confirmar el acceso actual. Este intento no se ha enviado.'
    }
  } finally {
    if (active) busy.value = false
  }
}
function cancel() {
  if (!busy.value && !ambiguous.value) intent.value = null
}
function label(action: OrderFulfillmentState) {
  return labels[action]
}
function blocked(data: AdminOrderFulfillment) {
  const text: Record<string, string> = {
    order_cancelled: 'Pedido cancelado',
    payment_unconfirmed: 'Pago capturado no confirmado',
    inventory_unconfirmed: 'Asignación de inventario no conciliada',
    warehouse_unavailable: 'Único almacén no disponible',
    shipping_mode_unavailable: 'Modalidad de entrega no disponible',
    history_unconfirmed: 'Historial operativo no conciliado'
  }
  return data.readiness.blockers.map((value) => text[value]).join(' · ')
}
</script>

<template>
  <section v-if="authorized()" aria-label="Preparación y entrega del pedido" class="space-y-4">
    <div v-if="view" class="rounded-2xl border border-slate-200 bg-white p-5">
      <p class="text-xs font-semibold uppercase tracking-wider text-neteco-700">
        Único almacén · {{ view.warehouse?.code ?? 'Sin conciliar' }}
      </p>
      <h2 class="mt-1 text-xl font-bold text-slate-950">Preparación y entrega</h2>
      <p class="mt-2 text-sm text-slate-700">{{ label(view.state) }} · Versión {{ view.version }}</p>
      <p v-if="view.interruptedState" class="mt-1 text-sm text-amber-800">
        Incidencia durante: {{ label(view.interruptedState) }}. Solo se puede retomar esa etapa.
      </p>
      <p class="mt-2 text-xs text-slate-500">
        {{ view.shippingMethod === 'pickup' ? 'Recogida en almacén' : 'Entrega' }} · El inventario se asignó al capturar
        el pago; preparar y entregar no lo descuentan de nuevo.
      </p>
      <p v-if="!view.readiness.ready" role="status" class="mt-4 rounded-xl bg-amber-50 p-3 text-sm text-amber-800">
        {{ blocked(view) }}
      </p>
      <form
        v-if="view.capabilities.fulfillmentTransitions && !intent"
        class="mt-5 grid gap-3"
        @submit.prevent="prepare"
      >
        <label class="text-sm font-medium"
          >Siguiente operación
          <select
            v-model="selected"
            data-testid="fulfillment-action"
            :disabled="busy"
            class="mt-1 block w-full rounded-lg border border-slate-300 p-2"
          >
            <option value="">Selecciona una operación autorizada</option>
            <option v-for="action in view.capabilities.allowedActions" :key="action" :value="action">
              {{ label(action) }}
            </option>
          </select>
        </label>
        <label class="text-sm font-medium"
          >Motivo operativo
          <textarea
            v-model="reason"
            data-testid="fulfillment-reason"
            maxlength="500"
            rows="2"
            :disabled="busy"
            class="mt-1 block w-full rounded-lg border border-slate-300 p-2"
          />
        </label>
        <label class="text-sm font-medium"
          >Evidencia verificable (reparto, entrega o incidencia)
          <textarea
            v-model="evidence"
            data-testid="fulfillment-evidence"
            maxlength="500"
            rows="2"
            :disabled="busy"
            class="mt-1 block w-full rounded-lg border border-slate-300 p-2"
          />
        </label>
        <p class="text-xs text-slate-500">
          Registra hechos comprobados y una referencia operativa. No pegues datos bancarios, secretos ni documentación
          sensible. Esto no crea un seguimiento de transportista.
        </p>
        <button
          data-testid="fulfillment-prepare"
          type="submit"
          :disabled="busy || !selected"
          class="rounded-lg bg-neteco-700 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          Revisar operación
        </button>
      </form>
      <ol
        v-if="view.timeline.items.length"
        aria-label="Historial operativo"
        class="mt-5 space-y-3 border-t border-slate-200 pt-4"
      >
        <li v-for="event in view.timeline.items" :key="event.commandId" class="text-sm text-slate-700">
          <p class="font-semibold">{{ label(event.fromState) }} → {{ label(event.toState) }} · v{{ event.version }}</p>
          <p>{{ event.reason }}</p>
          <p v-if="event.evidence" class="text-xs text-slate-500">{{ event.evidence }}</p>
          <time :datetime="event.createdAt" class="text-xs text-slate-500">{{ event.createdAt }}</time>
        </li>
      </ol>
    </div>
    <div
      v-if="intent"
      class="rounded-xl border border-amber-300 bg-amber-50 p-4"
      aria-label="Confirmar operación de preparación"
    >
      <p class="font-semibold">{{ label(intent.body.action) }} · Versión esperada {{ intent.body.expectedVersion }}</p>
      <p class="mt-1 text-sm">{{ intent.body.reason }}</p>
      <p v-if="intent.body.evidence" class="mt-1 text-sm">{{ intent.body.evidence }}</p>
      <p v-if="ambiguous" role="status" class="mt-2 text-sm">
        Resultado sin confirmar. Se conservará la misma clave para recuperar el recibo; no se crea un segundo
        movimiento.
      </p>
      <div class="mt-3 flex gap-2">
        <button
          v-if="!ambiguous"
          data-testid="fulfillment-confirm"
          type="button"
          :disabled="busy || intent.operatorId !== operatorId"
          class="rounded-lg bg-neteco-700 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
          @click="dispatch()"
        >
          Confirmar operación
        </button>
        <button
          v-else
          data-testid="fulfillment-retry"
          type="button"
          :disabled="busy || intent.operatorId !== operatorId"
          class="rounded-lg bg-neteco-700 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
          @click="dispatch(true)"
        >
          Recuperar mismo intento
        </button>
        <button
          data-testid="fulfillment-cancel"
          type="button"
          :disabled="busy || ambiguous"
          class="rounded-lg border border-slate-300 px-4 py-2 text-sm disabled:opacity-50"
          @click="cancel"
        >
          Cancelar revisión
        </button>
      </div>
    </div>
    <p v-if="message" role="status" class="text-sm text-slate-700">{{ message }}</p>
  </section>
</template>

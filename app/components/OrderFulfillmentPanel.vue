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
import type { AdminTone } from '~/utils/adminLabels'

const props = defineProps<{
  snapshot: unknown
  operatorId: string
  runtime: unknown
  authorize: () => boolean
  reload: () => Promise<unknown>
}>()
const emit = defineEmits<{ confirmed: [receipt: FulfillmentCommandReceipt]; pending: [value: boolean] }>()
const labels: Record<OrderFulfillmentState, string> = {
  pending: 'Pendiente de preparar',
  picking: 'En preparación',
  packed: 'Embalado',
  ready_for_pickup: 'Listo para recoger',
  in_transit: 'En reparto',
  delivered: 'Entregado',
  exception: 'Incidencia'
}
const tones: Record<OrderFulfillmentState, AdminTone> = {
  pending: 'warning',
  picking: 'info',
  packed: 'info',
  ready_for_pickup: 'info',
  in_transit: 'info',
  delivered: 'success',
  exception: 'danger'
}
const deliveryLabels: Record<string, string> = {
  pickup: 'Recogida en almacén',
  own_delivery: 'Reparto propio',
  parcel: 'Envío por mensajería'
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
    message.value = 'Ha cambiado tu sesión. No se enviará nada que hubiera preparado otra persona.'
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
      'Escribe un motivo de entre 10 y 500 caracteres. Para reparto, entrega e incidencias hace falta además un justificante.'
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
      message.value = 'La preparación ha cambiado o está bloqueada. Revisa el estado actual antes de continuar.'
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
    message.value = 'Paso registrado. El stock no se ha vuelto a descontar.'
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
      if (current()) message.value += ' No hemos podido actualizar el estado: pulsa «Actualizar».'
    }
  } catch {
    if (!current()) return
    contextCurrent.value = false
    const authFailure =
      responseCode && ['unauthenticated', 'email_unverified', 'mfa_required', 'forbidden'].includes(responseCode)
    if (responseCode && definitive.has(responseCode) && !(authFailure && (sent || replay))) {
      intent.value = null
      ambiguous.value = false
      message.value =
        'No se ha podido registrar el paso. Pulsa «Actualizar» y revisa el cobro, el stock y el estado del pedido.'
    } else {
      ambiguous.value = sent || replay
      message.value = ambiguous.value
        ? 'No sabemos si el paso se ha guardado. No lo repitas: pulsa «Comprobar de nuevo» para recuperarlo sin duplicarlo.'
        : 'No hemos podido confirmar tu sesión. No se ha enviado nada.'
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
    order_cancelled: 'El pedido está cancelado',
    payment_unconfirmed: 'El cobro no está confirmado',
    inventory_unconfirmed: 'La reserva de stock no está confirmada',
    warehouse_unavailable: 'El almacén no está disponible',
    shipping_mode_unavailable: 'La forma de entrega no está disponible',
    history_unconfirmed: 'El historial de la preparación no está confirmado'
  }
  return data.readiness.blockers.map((value) => text[value]).join('. ') + '.'
}
</script>

<template>
  <section v-if="authorized()" aria-label="Preparación y entrega del pedido" class="adm-stack">
    <div v-if="view" class="adm-stack">
      <div class="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <AdminBadge :tone="tones[view.state]" class="whitespace-nowrap">{{ label(view.state) }}</AdminBadge>
        <span class="adm-help">
          {{ (view.shippingMethod && deliveryLabels[view.shippingMethod]) || 'Forma de entrega sin definir' }} ·
          <span class="whitespace-nowrap">Almacén: {{ view.warehouse?.name ?? 'sin asignar' }}</span>
        </span>
      </div>
      <UAlert
        v-if="view.interruptedState"
        color="warning"
        variant="subtle"
        icon="i-lucide-triangle-alert"
        title="Hay una incidencia abierta"
        :description="`Ocurrió durante la etapa «${label(view.interruptedState)}». Solo se puede retomar esa etapa.`"
      />
      <UAlert
        v-if="!view.readiness.ready"
        role="status"
        color="warning"
        variant="subtle"
        icon="i-lucide-circle-pause"
        title="Ahora no se puede avanzar la preparación"
        :description="blocked(view)"
      />
      <form v-if="view.capabilities.fulfillmentTransitions && !intent" class="adm-stack" @submit.prevent="prepare">
        <AdminFormField v-slot="{ id }" label="Siguiente paso">
          <select
            :id="id"
            v-model="selected"
            data-testid="fulfillment-action"
            :disabled="busy"
            class="adm-input w-full sm:max-w-sm"
          >
            <option value="">Elige el siguiente paso</option>
            <option v-for="action in view.capabilities.allowedActions" :key="action" :value="action">
              {{ label(action) }}
            </option>
          </select>
        </AdminFormField>
        <div class="grid gap-4 md:grid-cols-2">
          <AdminFormField v-slot="{ id, describedBy }" label="Motivo" help="Entre 10 y 500 caracteres.">
            <textarea
              :id="id"
              v-model="reason"
              :aria-describedby="describedBy"
              data-testid="fulfillment-reason"
              maxlength="500"
              rows="2"
              :disabled="busy"
              class="adm-input w-full"
            />
          </AdminFormField>
          <AdminFormField
            v-slot="{ id, describedBy }"
            label="Justificante"
            help="Obligatorio para reparto, entrega e incidencias: albarán, firma o referencia que lo demuestre."
          >
            <textarea
              :id="id"
              v-model="evidence"
              :aria-describedby="describedBy"
              data-testid="fulfillment-evidence"
              maxlength="500"
              rows="2"
              :disabled="busy"
              class="adm-input w-full"
            />
          </AdminFormField>
        </div>
        <div class="flex flex-wrap items-center justify-between gap-3">
          <p class="adm-help max-w-prose">
            El stock ya se reservó al cobrar el pedido: avanzar la preparación no lo descuenta otra vez ni crea un envío
            con el transportista. No escribas datos bancarios ni contraseñas.
          </p>
          <AdminButton variant="primary" type="submit" data-testid="fulfillment-prepare" :disabled="busy || !selected">
            Revisar
          </AdminButton>
        </div>
      </form>
      <div v-if="view.timeline.items.length">
        <h3 class="adm-label">Historial</h3>
        <ol aria-label="Historial de la preparación" class="mt-2 space-y-3 border-l border-[var(--border)] pl-4">
          <li v-for="event in view.timeline.items" :key="event.commandId" class="relative">
            <span class="absolute -left-[1.3125rem] top-1.5 size-2 rounded-full bg-[var(--border-strong)]" />
            <p class="font-medium text-[var(--text-strong)]">
              {{ label(event.fromState) }} → {{ label(event.toState) }}
            </p>
            <p class="break-words text-[var(--text)]">{{ event.reason }}</p>
            <p v-if="event.evidence" class="break-words text-xs text-[var(--text-muted)]">
              Justificante: {{ event.evidence }}
            </p>
            <time :datetime="event.createdAt" class="whitespace-nowrap text-xs text-[var(--text-muted)]">
              {{ adminDate(event.createdAt, true) }}
            </time>
          </li>
        </ol>
      </div>
    </div>
    <div
      v-if="intent"
      class="rounded-[var(--radius-surface)] border border-[var(--border)] bg-[var(--surface-sunken)] p-4"
      aria-label="Confirmar el paso de preparación"
    >
      <p class="adm-help">Revisa antes de confirmar</p>
      <p class="mt-0.5 font-semibold text-[var(--text-strong)]">{{ label(intent.body.action) }}</p>
      <p class="mt-2 break-words">{{ intent.body.reason }}</p>
      <p v-if="intent.body.evidence" class="mt-1 break-words text-xs text-[var(--text-muted)]">
        Justificante: {{ intent.body.evidence }}
      </p>
      <UAlert
        v-if="ambiguous"
        role="status"
        class="mt-3"
        color="warning"
        variant="subtle"
        icon="i-lucide-triangle-alert"
        title="Falta confirmar el resultado"
        description="Puede que el paso ya esté guardado. «Comprobar de nuevo» recupera este mismo paso, sin registrarlo dos veces."
      />
      <div class="mt-4 flex flex-wrap justify-end gap-2">
        <AdminButton data-testid="fulfillment-cancel" :disabled="busy || ambiguous" @click="cancel">
          Cancelar
        </AdminButton>
        <AdminButton
          v-if="!ambiguous"
          variant="primary"
          data-testid="fulfillment-confirm"
          :loading="busy"
          :disabled="intent.operatorId !== operatorId"
          @click="dispatch()"
        >
          Confirmar
        </AdminButton>
        <AdminButton
          v-else
          variant="primary"
          data-testid="fulfillment-retry"
          :loading="busy"
          :disabled="intent.operatorId !== operatorId"
          @click="dispatch(true)"
        >
          Comprobar de nuevo
        </AdminButton>
      </div>
    </div>
    <UAlert v-if="message" role="status" :color="ambiguous ? 'warning' : 'neutral'" variant="subtle" :title="message" />
  </section>
</template>

<script setup lang="ts">
import { catalogPolicyUuidSchema } from '~~/shared/catalog-publication-policy'
import {
  orderCancellationEligibilitySchema,
  orderCancellationInputSchema,
  orderCancellationReceiptSchema,
  orderCancellationCommandSchema,
  type OrderCancellationEligibility,
  type OrderCancellationReceipt,
  type OrderCancellationInput
} from '~~/shared/order-cancellation'
const props = defineProps<{
  orderId: string
  audience: 'customer' | 'admin'
  scopeKey: string
  enabled: boolean
  pending: boolean
}>()
const emit = defineEmits<{ pending: [boolean]; confirmed: [OrderCancellationReceipt] }>()
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
type Intent = Readonly<{ path: string; orderId: string; key: string; body: Readonly<OrderCancellationInput> }>
const eligibility = shallowRef<OrderCancellationEligibility | null>(null),
  intent = shallowRef<Intent | null>(null),
  receipt = shallowRef<OrderCancellationReceipt | null>(null)
const reason = ref(''),
  confirmed = ref(false),
  checked = ref(false),
  busy = ref<'eligibility' | 'post' | 'lookup' | null>(null)
const status = ref<'idle' | 'loading' | 'ready' | 'error' | 'unknown' | 'confirmed'>('idle')
let alive = true,
  generation = 0,
  controller: AbortController | null = null,
  commandPending = false
const base = () =>
  `/api/${props.audience === 'admin' ? 'admin/' : ''}orders/${encodeURIComponent(props.orderId)}/cancellation`
const blockers: Record<NonNullable<OrderCancellationEligibility['blocker']>, string> = {
  order_not_awaiting_payment: 'El estado actual del pedido no permite esta cancelación sin pago.',
  payment_history: 'Hay historial de pago registrado. Esta cancelación no está disponible.',
  preparation_history: 'Hay preparación o devolución registrada. Esta cancelación no está disponible.',
  fiscal_history: 'Hay historial fiscal registrado. Esta cancelación no está disponible.',
  reservation_unavailable: 'No se ha confirmado una reserva de inventario compatible con esta cancelación.'
}
const validInput = computed(() =>
  orderCancellationInputSchema.safeParse({ expectedStatus: 'awaiting_payment', reason: reason.value })
)
const canSubmit = computed(
  () =>
    allowed.value &&
    !busy.value &&
    !intent.value &&
    eligibility.value?.eligible === true &&
    confirmed.value &&
    validInput.value.success
)
function setCommandPending(value: boolean) {
  if (commandPending !== value) {
    commandPending = value
    emit('pending', value)
  }
}
function current(epoch: number) {
  return alive && allowed.value && generation === epoch
}
function invalidate() {
  generation++
  controller?.abort()
  controller = null
  eligibility.value = null
  intent.value = null
  receipt.value = null
  reason.value = ''
  confirmed.value = false
  checked.value = false
  busy.value = null
  status.value = 'idle'
  setCommandPending(false)
}
function parseEligibility(raw: unknown, orderId: string) {
  const value = orderCancellationEligibilitySchema.parse(raw)
  if (value.orderId !== orderId || (value.eligible && value.orderStatus !== 'awaiting_payment'))
    throw new Error('unconfirmed_eligibility')
  return value
}
async function load() {
  if (!allowed.value || busy.value || intent.value || !alive) return
  const epoch = generation,
    abort = new AbortController(),
    path = base(),
    orderId = props.orderId
  controller = abort
  busy.value = 'eligibility'
  status.value = 'loading'
  eligibility.value = null
  try {
    const raw = await request(path, { method: 'GET', cache: 'no-store', retry: 0, signal: abort.signal })
    if (!current(epoch)) return
    eligibility.value = parseEligibility(raw, orderId)
    status.value = 'ready'
  } catch {
    if (current(epoch)) status.value = 'error'
  } finally {
    if (current(epoch)) {
      busy.value = null
      controller = null
    }
  }
}
async function accept(raw: unknown, frozen: Intent, epoch: number, abort: AbortController) {
  const value = orderCancellationReceiptSchema.parse(raw)
  if (value.orderId !== frozen.orderId || value.commandId !== frozen.key) throw new Error('unconfirmed_receipt')
  const fresh = await request(frozen.path, { method: 'GET', cache: 'no-store', retry: 0, signal: abort.signal })
  if (!current(epoch) || intent.value !== frozen) return
  const state = parseEligibility(fresh, frozen.orderId)
  if (state.orderStatus !== 'cancelled' || state.eligible || state.blocker !== 'order_not_awaiting_payment')
    throw new Error('unconfirmed_current_order')
  eligibility.value = state
  receipt.value = value
  intent.value = null
  reason.value = ''
  confirmed.value = false
  checked.value = false
  status.value = 'confirmed'
  setCommandPending(false)
  emit('confirmed', value)
}
async function send(frozen: Intent) {
  if (!allowed.value || busy.value || !alive || intent.value !== frozen) return
  const epoch = generation,
    abort = new AbortController()
  controller = abort
  busy.value = 'post'
  checked.value = false
  setCommandPending(true)
  try {
    const raw = await request(frozen.path, {
      method: 'POST',
      body: frozen.body,
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': frozen.key },
      retry: 0,
      signal: abort.signal
    })
    if (!current(epoch) || intent.value !== frozen) return
    await accept(raw, frozen, epoch, abort)
  } catch {
    if (current(epoch) && intent.value === frozen) status.value = 'unknown'
  } finally {
    if (current(epoch)) {
      busy.value = null
      controller = null
    }
  }
}
function submit() {
  if (!canSubmit.value || !validInput.value.success) return
  const frozen = Object.freeze({
    path: base(),
    orderId: props.orderId,
    key: crypto.randomUUID(),
    body: Object.freeze({ ...validInput.value.data })
  })
  intent.value = frozen
  void send(frozen)
}
async function check() {
  const frozen = intent.value
  if (!frozen || !allowed.value || busy.value || !alive) return
  const epoch = generation,
    abort = new AbortController()
  controller = abort
  busy.value = 'lookup'
  checked.value = false
  try {
    const raw = await request(`${frozen.path}/commands/${frozen.key}`, {
      method: 'GET',
      cache: 'no-store',
      retry: 0,
      signal: abort.signal
    })
    if (!current(epoch) || intent.value !== frozen) return
    const result = orderCancellationCommandSchema.parse(raw)
    if (result.orderId !== frozen.orderId || result.commandId !== frozen.key) throw new Error('unconfirmed_command')
    if (result.outcome === 'cancelled') await accept(result, frozen, epoch, abort)
    else {
      checked.value = true
      status.value = 'unknown'
    }
  } catch {
    if (current(epoch) && intent.value === frozen) status.value = 'unknown'
  } finally {
    if (current(epoch)) {
      busy.value = null
      controller = null
    }
  }
}
function replay() {
  if (intent.value && checked.value && !busy.value) void send(intent.value)
}
watch(
  [() => props.orderId, () => props.audience, () => props.scopeKey, () => props.enabled, () => props.pending],
  () => {
    invalidate()
    if (allowed.value) void load()
  },
  { immediate: true, flush: 'sync' }
)
onBeforeUnmount(() => {
  alive = false
  invalidate()
})
</script>
<template>
  <section
    v-if="allowed"
    :aria-labelledby="prefix + '-title'"
    class="min-w-0 max-w-full space-y-3 break-words [overflow-wrap:anywhere]"
  >
    <h2 :id="prefix + '-title'" class="text-base font-semibold">Cancelación del pedido</h2>
    <p class="text-sm">
      Puedes cancelar un pedido mientras no se haya pagado ni preparado. Para devolver algo que ya has recibido, usa
      «devolver productos».
    </p>
    <p v-if="status === 'loading'" data-cancel-loading role="status" aria-busy="true">
      Comprobando si la cancelación está disponible…
    </p>
    <div v-else-if="status === 'error'" data-cancel-error role="alert" class="space-y-2">
      <p>No se ha podido confirmar la disponibilidad. No se ha enviado una cancelación.</p>
      <button
        type="button"
        :class="
          audience === 'admin' ? 'adm-btn adm-btn--secondary' : 'rounded border px-3 py-2 focus-visible:outline-2'
        "
        :disabled="!!busy"
        @click="load"
      >
        Reintentar consulta
      </button>
    </div>
    <div v-else-if="receipt" data-cancel-receipt role="status" class="space-y-2">
      <p>Cancelación confirmada en el registro del pedido.</p>
      <time :datetime="receipt.updatedAt">{{ adminDate(receipt.updatedAt, true) }}</time>
      <p>No acredita movimientos de pago ni un reembolso.</p>
    </div>
    <p v-else-if="eligibility && !eligibility.eligible" data-cancel-blocker role="status">
      {{ eligibility.blocker ? blockers[eligibility.blocker] : '' }}
    </p>
    <form v-if="eligibility?.eligible && !receipt" class="min-w-0 space-y-3" @submit.prevent="submit">
      <div>
        <label :for="prefix + '-reason'" class="block text-sm font-medium">Motivo de cancelación</label>
        <textarea
          :id="prefix + '-reason'"
          v-model="reason"
          data-cancel-reason
          minlength="10"
          maxlength="500"
          required
          :disabled="!!intent || !!busy"
          class="w-full min-w-0 rounded border p-2 focus-visible:outline-2"
          :aria-describedby="prefix + '-reason-help'"
        />
        <p :id="prefix + '-reason-help'" class="text-xs">Entre 10 y 500 caracteres. No incluyas datos de pago.</p>
      </div>
      <label class="flex items-start gap-2"
        ><input
          v-model="confirmed"
          data-cancel-confirm
          type="checkbox"
          required
          :disabled="!!intent || !!busy"
        />Confirmo que quiero cancelar este pedido.</label
      >
      <button
        data-cancel-submit
        type="submit"
        :disabled="!canSubmit"
        :class="audience === 'admin' ? 'adm-btn adm-btn--danger' : 'rounded border px-3 py-2 focus-visible:outline-2'"
      >
        Confirmar cancelación
      </button>
    </form>
    <p v-if="busy === 'post'" role="status" aria-busy="true">
      Enviando la cancelación. No cierres ni recargues esta vista.
    </p>
    <div v-if="intent && status === 'unknown'" data-cancel-unknown role="alert" class="min-w-0 space-y-2">
      <p>
        No se ha confirmado el resultado. La consulta pendiente no confirma ausencia de efectos. Conservamos la misma
        intención en esta pestaña; no cierres ni recargues la vista.
      </p>
      <p v-if="busy === 'lookup'" role="status" aria-busy="true">Comprobando el recibo y el estado actual…</p>
      <div class="flex flex-wrap gap-2">
        <button
          data-cancel-check
          type="button"
          :disabled="!!busy"
          :class="
            audience === 'admin' ? 'adm-btn adm-btn--secondary' : 'rounded border px-3 py-2 focus-visible:outline-2'
          "
          @click="check"
        >
          Comprobar cancelación
        </button>
        <button
          data-cancel-replay
          type="button"
          :disabled="!!busy || !checked"
          :class="
            audience === 'admin' ? 'adm-btn adm-btn--secondary' : 'rounded border px-3 py-2 focus-visible:outline-2'
          "
          @click="replay"
        >
          Reintentar la misma cancelación
        </button>
      </div>
    </div>
  </section>
</template>

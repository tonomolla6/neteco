<script setup lang="ts">
import {
  customerOrderReturnsSchema,
  returnRequestInputSchema,
  returnCommandReceiptSchema,
  returnStateLabels,
  returnResponseErrorCode,
  definiteReturnRejection,
  freezeReturnIntent,
  type ReturnRequestInput,
  type ReturnCommandReceipt
} from '~~/shared/order-returns'
import { catalogPolicyUuidSchema } from '~~/shared/catalog-publication-policy'
const props = defineProps<{
  snapshot: unknown
  operatorId: string
  runtime: unknown
  authorize: () => boolean
  reload: () => Promise<unknown>
}>()
const emit = defineEmits<{ confirmed: [receipt: ReturnCommandReceipt]; pending: [value: boolean] }>()
const reason = ref(''),
  quantities = reactive<Record<number, number>>({}),
  busy = ref(false),
  ambiguous = ref(false),
  message = ref(''),
  contextCurrent = ref(true)
type Intent = { body: ReturnRequestInput; key: string; orderId: string; operatorId: string }
const intent = shallowRef<Readonly<Intent> | null>(null)
let active = true,
  generation = 0
const authorized = () => {
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
  const parsed = customerOrderReturnsSchema.safeParse(props.snapshot)
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
  () => [props.operatorId, props.runtime, authorized()],
  () => {
    generation++
    contextCurrent.value = false
    if (intent.value && (intent.value.operatorId !== props.operatorId || props.runtime !== 'cloudflare')) {
      intent.value = null
      ambiguous.value = false
    }
    message.value = 'Confirma de nuevo tu sesión antes de continuar.'
  }
)
watch(
  () => props.snapshot,
  () => {
    const parsed = customerOrderReturnsSchema.safeParse(props.snapshot)
    if (parsed.success && intent.value && parsed.data.orderId !== intent.value.orderId) {
      generation++
      intent.value = null
      ambiguous.value = false
    }
    if (authorized() && parsed.success) contextCurrent.value = true
  }
)
onBeforeUnmount(() => {
  purge()
  active = false
  generation++
})
function purge() {
  generation++
  intent.value = null
  reason.value = message.value = ''
  for (const key of Object.keys(quantities)) Reflect.deleteProperty(quantities, key)
  busy.value = ambiguous.value = contextCurrent.value = false
}
watch(() => [props.operatorId, props.runtime], purge, { flush: 'sync' })
function prepare() {
  const data = view.value
  message.value = ''
  if (busy.value || intent.value || !data?.capabilities.returnRequest) return
  const input = returnRequestInputSchema.safeParse({
    expectedVersion: data.version,
    reason: reason.value.trim(),
    lines: data.lines
      .map((line) => ({ lineIndex: line.lineIndex, quantity: quantities[line.lineIndex] ?? 0 }))
      .filter((line) => line.quantity > 0)
  })
  if (
    !input.success ||
    input.data.lines.some(
      (line) => line.quantity > (data.lines.find((item) => item.lineIndex === line.lineIndex)?.availableQuantity ?? 0)
    )
  ) {
    message.value = 'Selecciona unidades disponibles enteras y describe el motivo (10–500 caracteres).'
    return
  }
  intent.value = freezeReturnIntent({
    body: input.data,
    key: crypto.randomUUID(),
    orderId: data.orderId,
    operatorId: props.operatorId
  })
}
async function dispatch(recovery = false) {
  const pending = intent.value
  if (!pending || busy.value || !authorized() || pending.operatorId !== props.operatorId) return
  busy.value = true
  message.value = ''
  const epoch = generation,
    current = () => active && epoch === generation && authorized() && pending.operatorId === props.operatorId
  let sent = false,
    code: string | null = null
  try {
    const fresh = customerOrderReturnsSchema.safeParse(await props.reload())
    if (!current()) return
    if (!fresh.success || fresh.data.orderId !== pending.orderId) throw new Error('return_context_unconfirmed')
    if (
      !recovery &&
      (!fresh.data.capabilities.returnRequest ||
        fresh.data.version !== pending.body.expectedVersion ||
        pending.body.lines.some(
          (line) =>
            line.quantity > (fresh.data.lines.find((item) => item.lineIndex === line.lineIndex)?.availableQuantity ?? 0)
        ))
    ) {
      intent.value = null
      ambiguous.value = false
      contextCurrent.value = false
      message.value = 'Han cambiado las unidades disponibles. Actualiza el pedido antes de preparar otra solicitud.'
      return
    }
    sent = true
    ambiguous.value = true
    const endpoint: string = `/api/orders/${pending.orderId}/returns`
    const raw: unknown = await $fetch(endpoint, {
      method: 'POST',
      body: pending.body,
      headers: { 'Idempotency-Key': pending.key },
      retry: 0,
      onResponseError(context: unknown) {
        code = returnResponseErrorCode(context)
      }
    })
    if (!current()) return
    const receipt = returnCommandReceiptSchema.safeParse(raw)
    if (
      !receipt.success ||
      receipt.data.orderId !== pending.orderId ||
      receipt.data.action !== 'requested' ||
      receipt.data.version !== 1 ||
      receipt.data.orderVersion !== pending.body.expectedVersion + 1
    )
      throw new Error('return_receipt_unconfirmed')
    intent.value = null
    ambiguous.value = false
    reason.value = ''
    for (const key of Object.keys(quantities)) Reflect.deleteProperty(quantities, key)
    contextCurrent.value = false
    message.value = `Solicitud registrada: ${receipt.data.publicRef}. Requiere revisión: no confirma admisión ni reembolso.`
    emit('confirmed', receipt.data)
    try {
      const latest = customerOrderReturnsSchema.safeParse(await props.reload())
      if (!current()) return
      if (!latest.success || latest.data.orderId !== pending.orderId || latest.data.version < receipt.data.orderVersion)
        throw new Error('return_context_unconfirmed')
      contextCurrent.value = true
    } catch {
      if (current()) message.value += ' No se ha podido confirmar el estado actual; el recibo es histórico.'
    }
  } catch {
    if (!current()) return
    contextCurrent.value = false
    if (!recovery && definiteReturnRejection(code, sent, recovery)) {
      intent.value = null
      ambiguous.value = false
      message.value = 'Solicitud rechazada de forma confirmada. Actualiza el pedido antes de preparar otra.'
    } else {
      ambiguous.value = sent || recovery
      message.value = ambiguous.value
        ? 'Resultado no confirmado. Recupera con el mismo contenido y clave para no duplicar la solicitud.'
        : 'No se ha confirmado el contexto. No se ha enviado ninguna solicitud.'
    }
  } finally {
    if (active) busy.value = false
  }
}
function cancel() {
  if (!busy.value && !ambiguous.value) {
    intent.value = null
    message.value = 'Intento no enviado cancelado.'
  }
}
</script>
<template>
  <section aria-label="Solicitudes de devolución del pedido" class="space-y-4">
    <p v-if="message && authorized()" data-testid="customer-return-message" role="status" class="rounded border p-3">
      {{ message }}
    </p>
    <div v-if="view" data-testid="customer-return-facts" class="space-y-4">
      <p class="rounded bg-amber-50 p-3 text-sm">
        Cada solicitud requiere revisión documentada. Registrarla no autoriza enviar productos ni confirma admisión,
        reembolso o factura rectificativa. Los productos recibidos quedarán en custodia no vendible.
      </p>
      <p v-if="!view.readiness.ready" role="alert">Solicitud bloqueada: {{ view.readiness.blockers.join(', ') }}</p>
      <form v-if="view.capabilities.returnRequest && !intent" class="space-y-3" @submit.prevent="prepare">
        <fieldset>
          <legend>Unidades disponibles del pedido histórico</legend>
          <label v-for="line in view.lines" :key="line.lineIndex" class="flex justify-between gap-4"
            >{{ line.name }} · {{ line.sku }} · {{ line.availableQuantity }} disponibles<input
              v-model.number="quantities[line.lineIndex]"
              :data-testid="`customer-return-quantity-${line.lineIndex}`"
              :aria-label="`Unidades de ${line.name}`"
              type="number"
              min="0"
              step="1"
              :max="line.availableQuantity"
              class="w-24 rounded border p-2"
          /></label>
        </fieldset>
        <label class="block"
          >Motivo
          <textarea
            v-model="reason"
            data-testid="customer-return-reason"
            required
            maxlength="500"
            class="block w-full rounded border p-2"
          />
        </label>
        <button data-testid="customer-return-prepare" :disabled="busy" type="submit" class="rounded border p-2">
          Preparar solicitud
        </button>
      </form>
      <p v-else-if="!view.capabilities.returnRequest && view.readiness.ready" role="status">
        No quedan unidades disponibles para una nueva solicitud. Las solicitudes previas siguen visibles.
      </p>
      <p v-if="view.pagination.total === 0">No hay solicitudes confirmadas para este pedido.</p>
      <article v-for="item in view.returns" :key="item.id" class="rounded border p-4">
        <h2>{{ item.publicRef }} · {{ returnStateLabels[item.state] }}</h2>
        <p>{{ item.publicMessage }}</p>
        <p v-for="line in item.lines" :key="line.lineIndex">
          {{ line.name }} · solicitadas {{ line.requestedQuantity }}, admitidas {{ line.authorizedQuantity }}, recibidas
          {{ line.receivedQuantity }}, inspeccionadas {{ line.inspectedQuantity }}
        </p>
        <ol>
          <li v-for="event in item.timeline.items" :key="event.version">
            {{ returnStateLabels[event.action] }} · {{ event.message }}
          </li>
        </ol>
      </article>
      <p v-if="view.pagination.pages > 1">
        Mostrando {{ view.returns.length }} de {{ view.pagination.total }} solicitudes confirmadas.
      </p>
    </div>
    <div v-if="intent && authorized()" data-testid="customer-return-intent" class="rounded border p-4">
      <p>
        Solicitud preparada para {{ intent.orderId }} ·
        {{ intent.body.lines.reduce((sum, line) => sum + line.quantity, 0) }} unidades · {{ intent.body.reason }}
      </p>
      <p v-if="ambiguous">Puede haberse registrado. La recuperación conserva la clave original.</p>
      <button
        data-testid="customer-return-confirm"
        :disabled="busy || !authorized()"
        type="button"
        class="m-2 rounded border p-2"
        @click="dispatch(ambiguous)"
      >
        {{ ambiguous ? 'Recuperar con la misma clave' : 'Confirmar solicitud' }}</button
      ><button
        v-if="!ambiguous"
        data-testid="customer-return-cancel"
        :disabled="busy"
        type="button"
        class="rounded border p-2"
        @click="cancel"
      >
        Cancelar intento no enviado
      </button>
    </div>
    <p v-if="!view && !intent && !message" role="status">No hay contexto de devolución confirmado para mostrar.</p>
  </section>
</template>

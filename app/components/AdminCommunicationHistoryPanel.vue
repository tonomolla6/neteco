<script setup lang="ts">
import {
  communicationHistorySchema,
  communicationStatusSchema,
  communicationTypeSchema,
  communicationRetryInputSchema,
  communicationRetryReceiptSchema,
  communicationRetryCommandSchema,
  communicationRetryIntentHash,
  type CommunicationHistory,
  type CommunicationRetryInput,
  type CommunicationRetryReceipt
} from '~~/shared/communication-history'
const props = defineProps<{ scopeKey: string; enabled: boolean; pending?: boolean }>()
const emit = defineEmits<{ pending: [value: boolean]; confirmed: [] }>()
const request = useRequestFetch(),
  base = '/api/admin/communications/history'
const active = computed(() => props.enabled && !props.pending && !!props.scopeKey)
const snapshot = ref<CommunicationHistory | null>(null),
  reason = ref(''),
  selection = ref<CommunicationHistory['items'][number] | null>(null)
const status = ref(''),
  eventType = ref(''),
  busy = ref(false),
  phase = ref<'idle' | 'loading' | 'ready' | 'error' | 'unknown' | 'confirmed'>('idle')
const message = ref('')
type Intent = { key: string; hash: string; eventId: string; body: CommunicationRetryInput; submitted: boolean }
const intent = ref<Intent | null>(null)
let generation = 0,
  controller: AbortController | null = null,
  commandPending = false
const statusLabels: Record<CommunicationHistory['items'][number]['status'], string> = {
  queued: 'Pendiente de recepción en la cola',
  pending: 'Preparación pendiente',
  leased: 'Preparación en curso',
  sending: 'Envío iniciado, resultado pendiente',
  sent: 'Envío registrado por el emisor',
  manual_review: 'Revisión manual',
  suppressed: 'Aviso suprimido por preferencia'
}
const typeLabels: Record<CommunicationHistory['items'][number]['eventType'], string> = {
  'order.created': 'Pedido registrado',
  'order.confirmed': 'Confirmación de pedido',
  'order.status.updated': 'Preparación o entrega',
  'order.cancelled': 'Cancelación de pedido',
  'order.cancellation.requested': 'Solicitud de cancelación',
  'order.reservation.expired': 'Reserva caducada',
  'order.shipped': 'Expedición registrada',
  'order.delivered': 'Entrega registrada',
  'refund.succeeded.email': 'Reembolso registrado',
  'return.requested': 'Solicitud de devolución',
  'return.status.updated': 'Estado de devolución',
  'support.ticket.received': 'Consulta recibida',
  'support.ticket.reply': 'Respuesta de soporte',
  'invoice.issued': 'Documento fiscal emitido'
}
function setPending(value: boolean) {
  if (commandPending !== value) {
    commandPending = value
    emit('pending', value)
  }
}
function purge() {
  generation++
  controller?.abort()
  controller = null
  snapshot.value = null
  selection.value = null
  intent.value = null
  reason.value = ''
  status.value = ''
  eventType.value = ''
  busy.value = false
  phase.value = 'idle'
  message.value = ''
  setPending(false)
}
watch(() => [props.scopeKey, props.enabled, !!props.pending], purge, { flush: 'sync' })
const valid = (epoch: number) => epoch === generation && active.value
function start() {
  controller?.abort()
  controller = new AbortController()
  return { epoch: generation, signal: controller.signal }
}
function statusCode(error: unknown) {
  const e = error as { statusCode?: number; status?: number; data?: { error?: { code?: string } } }
  return { status: e?.statusCode ?? e?.status, code: e?.data?.error?.code }
}
function hardRevocation(error: unknown) {
  if ([401, 403].includes(statusCode(error).status ?? 0)) {
    purge()
    phase.value = 'error'
    message.value = 'La autorización ya no está vigente. Se han retirado los datos privados.'
    return true
  }
  return false
}
function date(value: string) {
  return (
    new Intl.DateTimeFormat('es-ES', { dateStyle: 'short', timeStyle: 'medium', timeZone: 'UTC' }).format(
      new Date(value)
    ) + ' UTC'
  )
}
async function load(page = 1) {
  if (!active.value || busy.value || intent.value) return
  const { epoch, signal } = start()
  busy.value = true
  phase.value = 'loading'
  snapshot.value = null
  selection.value = null
  reason.value = ''
  message.value = ''
  try {
    const result = communicationHistorySchema.parse(
      await request(base, {
        method: 'GET',
        query: {
          page,
          perPage: 25,
          ...(status.value ? { status: status.value } : {}),
          ...(eventType.value ? { eventType: eventType.value } : {})
        },
        signal
      })
    )
    if (!valid(epoch)) return
    if (result.page !== page || result.perPage !== 25) throw new Error('invalid_history_page')
    snapshot.value = result
    phase.value = 'ready'
  } catch (error) {
    if (valid(epoch) && !hardRevocation(error)) {
      phase.value = 'error'
      message.value = 'No se ha podido consultar el historial. No se confirma una cola vacía.'
    }
  } finally {
    if (valid(epoch)) busy.value = false
  }
}
function select(item: CommunicationHistory['items'][number]) {
  if (!active.value || busy.value || intent.value || !item.canRetry || !item.availableAt) return
  selection.value = item
  reason.value = ''
  message.value = ''
}
async function review() {
  if (!active.value || busy.value || intent.value || !selection.value?.availableAt) return
  const epoch = generation,
    item = selection.value
  busy.value = true
  try {
    const body = communicationRetryInputSchema.parse({
      expectedAttempts: item.attempts,
      expectedAvailableAt: item.availableAt,
      reason: reason.value
    })
    const key = crypto.randomUUID(),
      hash = await communicationRetryIntentHash(item.eventId, body)
    if (!valid(epoch)) return
    intent.value = { key, hash, eventId: item.eventId, body: Object.freeze(body), submitted: false }
  } catch {
    if (valid(epoch)) {
      phase.value = 'error'
      message.value = 'Revisa el motivo y vuelve a preparar la confirmación. No se ha enviado ninguna operación.'
    }
  } finally {
    if (valid(epoch)) busy.value = false
  }
}
function receiptProof(raw: unknown, frozen: Intent): CommunicationRetryReceipt {
  const receipt = communicationRetryReceiptSchema.parse(raw)
  if (
    receipt.commandId !== frozen.key ||
    receipt.eventId !== frozen.eventId ||
    receipt.payloadHash !== frozen.hash ||
    receipt.attempts !== frozen.body.expectedAttempts ||
    receipt.previousAvailableAt !== frozen.body.expectedAvailableAt
  )
    throw new Error('receipt_mismatch')
  return receipt
}
async function confirmCurrent(receipt: CommunicationRetryReceipt, frozen: Intent, epoch: number, signal: AbortSignal) {
  const current = communicationHistorySchema.parse(
    await request(base, { method: 'GET', query: { eventId: frozen.eventId, page: 1, perPage: 25 }, signal })
  )
  if (!valid(epoch)) return
  const row = current.items[0]
  if (
    current.total !== 1 ||
    current.items.length !== 1 ||
    !row ||
    row.eventId !== receipt.eventId ||
    row.attempts < receipt.attempts
  )
    throw new Error('fresh_metadata_mismatch')
  snapshot.value = current
  selection.value = null
  intent.value = null
  reason.value = ''
  phase.value = 'confirmed'
  message.value = 'Reprogramación registrada y estado actual confirmado. No se ha invocado al emisor desde esta acción.'
  setPending(false)
  emit('confirmed')
}
async function send() {
  const frozen = intent.value
  if (!active.value || busy.value || !frozen || frozen.submitted) return
  const { epoch, signal } = start()
  frozen.submitted = true
  busy.value = true
  setPending(true)
  message.value = ''
  let received = false
  try {
    const raw = await request(base + '/' + encodeURIComponent(frozen.eventId) + '/commands', {
      method: 'POST',
      body: frozen.body,
      headers: { 'Idempotency-Key': frozen.key },
      signal
    })
    if (!valid(epoch)) return
    received = true
    const receipt = receiptProof(raw, frozen)
    await confirmCurrent(receipt, frozen, epoch, signal)
  } catch (error) {
    if (!valid(epoch) || hardRevocation(error)) return
    if (!received && statusCode(error).status === 409 && statusCode(error).code === 'version_conflict') {
      intent.value = null
      selection.value = null
      reason.value = ''
      snapshot.value = null
      setPending(false)
      phase.value = 'error'
      message.value = 'La preparación ha cambiado. Consulta de nuevo antes de revisar otra operación.'
    } else {
      phase.value = 'unknown'
      message.value = 'Resultado incierto. Comprueba el recibo de esta misma intención; no vuelvas a enviarla.'
    }
  } finally {
    if (valid(epoch)) busy.value = false
  }
}
async function recover() {
  const frozen = intent.value
  if (!active.value || busy.value || !frozen?.submitted) return
  const { epoch, signal } = start()
  busy.value = true
  try {
    const result = communicationRetryCommandSchema.parse(
      await request(base + '/commands/' + frozen.key, {
        method: 'GET',
        headers: { 'X-Neteco-Command-Payload-Hash': frozen.hash },
        signal
      })
    )
    if (!valid(epoch)) return
    if (result.outcome === 'unknown') {
      phase.value = 'unknown'
      message.value =
        'Resultado incierto: no hay un recibo confirmado en esta lectura. No acredita que la operación no se haya aplicado.'
      return
    }
    await confirmCurrent(receiptProof(result.receipt, frozen), frozen, epoch, signal)
  } catch (error) {
    if (valid(epoch) && !hardRevocation(error)) {
      phase.value = 'unknown'
      message.value =
        'Resultado incierto. No se ha podido confirmar el recibo y el estado actual; conserva esta pestaña.'
    }
  } finally {
    if (valid(epoch)) busy.value = false
  }
}
function cancelReview() {
  if (intent.value?.submitted || busy.value) return
  intent.value = null
  selection.value = null
  reason.value = ''
}
function beforeUnload(event: BeforeUnloadEvent) {
  if (intent.value?.submitted) {
    event.preventDefault()
    event.returnValue = ''
  }
}
onMounted(() => window.addEventListener('beforeunload', beforeUnload))
onBeforeUnmount(() => {
  window.removeEventListener('beforeunload', beforeUnload)
  purge()
})
</script>

<template>
  <section
    aria-label="Historial operativo de comunicaciones"
    class="min-w-0 rounded-lg border border-[var(--border)] p-4"
  >
    <h2 class="text-lg font-semibold">Historial operativo de comunicaciones</h2>
    <p class="mt-2 text-sm">
      Sólo metadatos operativos, sin destinatarios ni contenido. No envía mensajes directamente. Reprogramar la
      preparación podría permitir un envío posterior si el emisor está autorizado y habilitado; no reinicia los
      intentos.
    </p>
    <p class="mt-2 text-sm">
      Los envíos iniciados, resultados ambiguos y revisiones manuales no se rearman desde aquí. El registro del emisor
      no acredita recepción o lectura por el destinatario. Se excluyen autenticación, seguridad y marketing.
    </p>
    <template v-if="active">
      <form class="mt-4 flex flex-wrap items-end gap-3" @submit.prevent="load(1)">
        <label class="min-w-0"
          >Estado
          <select v-model="status" :disabled="busy || !!intent" class="block max-w-full rounded border p-2">
            <option value="">Todos los estados</option>
            <option v-for="value in communicationStatusSchema.options" :key="value" :value="value">
              {{ statusLabels[value] }}
            </option>
          </select>
        </label>
        <label class="min-w-0"
          >Tipo de comunicación
          <select v-model="eventType" :disabled="busy || !!intent" class="block max-w-full rounded border p-2">
            <option value="">Todos los tipos</option>
            <option v-for="value in communicationTypeSchema.options" :key="value" :value="value">
              {{ typeLabels[value] }}
            </option>
          </select>
        </label>
        <button type="submit" :disabled="busy || !!intent" class="rounded border px-3 py-2">
          Consultar historial de comunicaciones
        </button>
      </form>
      <p v-if="phase === 'loading'" role="status" class="mt-3">Consultando el historial…</p>
      <p v-if="message" :role="phase === 'error' || phase === 'unknown' ? 'alert' : 'status'" class="mt-3 break-words">
        {{ message }}
      </p>
      <template v-if="snapshot">
        <p class="mt-3 text-sm">
          Estado observado: <time :datetime="snapshot.evaluatedAt">{{ date(snapshot.evaluatedAt) }}</time
          >. {{ snapshot.total }} comunicaciones.
        </p>
        <p v-if="snapshot.total === 0" role="status">No hay comunicaciones para estos filtros.</p>
        <ul class="mt-3 space-y-3">
          <li v-for="item in snapshot.items" :key="item.eventId" class="min-w-0 rounded border p-3">
            <h3 class="font-semibold">{{ typeLabels[item.eventType] }}</h3>
            <p>{{ statusLabels[item.status] }} · {{ item.attempts }} intentos</p>
            <p class="break-all text-xs">{{ item.eventId }}</p>
            <p class="text-sm">
              Registrada: <time :datetime="item.createdAt">{{ date(item.createdAt) }}</time>
            </p>
            <p v-if="item.availableAt" class="text-sm">
              Preparación disponible: <time :datetime="item.availableAt">{{ date(item.availableAt) }}</time>
            </p>
            <p v-if="item.finishedAt" class="text-sm">
              Estado registrado: <time :datetime="item.finishedAt">{{ date(item.finishedAt) }}</time>
            </p>
            <p v-if="item.errorCode" class="text-sm">Código operativo: {{ item.errorCode }}</p>
            <button
              v-if="item.canRetry"
              type="button"
              :disabled="busy || !!intent"
              class="mt-2 rounded border px-3 py-2"
              @click="select(item)"
            >
              Revisar preparación
            </button>
            <p v-else class="mt-2 text-sm">Sin acción de reprogramación disponible.</p>
          </li>
        </ul>
        <nav aria-label="Páginas del historial de comunicaciones" class="mt-3 flex flex-wrap items-center gap-3">
          <button type="button" :disabled="busy || !!intent || snapshot.page <= 1" @click="load(snapshot.page - 1)">
            Anterior
          </button>
          <span>Página {{ snapshot.page }}</span>
          <button
            type="button"
            :disabled="busy || !!intent || snapshot.page * snapshot.perPage >= snapshot.total"
            @click="load(snapshot.page + 1)"
          >
            Siguiente
          </button>
        </nav>
      </template>
      <form v-if="selection && !intent" data-communication-review class="mt-4 space-y-3" @submit.prevent="review">
        <p>
          Revisar preparación de {{ typeLabels[selection.eventType] }}. No se vuelve a enviar un mensaje desde esta
          acción.
        </p>
        <label class="block"
          >Motivo documentado (sin datos personales)
          <textarea
            v-model="reason"
            minlength="10"
            maxlength="500"
            required
            :disabled="busy"
            class="mt-1 block w-full rounded border p-2"
          />
        </label>
        <button type="submit" :disabled="busy" class="rounded border px-3 py-2">Revisar reprogramación</button>
        <button type="button" :disabled="busy" class="ml-3" @click="cancelReview">Cancelar revisión</button>
      </form>
      <div v-if="intent && !intent.submitted" class="mt-4 space-y-3 rounded border p-3">
        <p class="break-all">{{ intent.eventId }}</p>
        <p>
          Intentos conservados: {{ intent.body.expectedAttempts }}. Se solicitará preparar de nuevo; no se acredita un
          envío.
        </p>
        <p class="break-words">Motivo: {{ intent.body.reason }}</p>
        <button type="button" :disabled="busy" class="rounded border px-3 py-2" @click="send">
          Confirmar reprogramación
        </button>
        <button type="button" :disabled="busy" class="ml-3" @click="cancelReview">Volver a revisar</button>
      </div>
      <div v-if="intent?.submitted" class="mt-4">
        <p>
          Conserva esta pestaña hasta comprobar el resultado. Salir puede perder la intención local necesaria para
          recuperar el recibo.
        </p>
        <button type="button" :disabled="busy" class="mt-2 rounded border px-3 py-2" @click="recover">
          Comprobar reprogramación
        </button>
      </div>
    </template>
    <p v-else class="mt-3" role="status">
      Consulta no autorizada o pendiente de otra operación. No se muestran datos privados.
    </p>
  </section>
</template>

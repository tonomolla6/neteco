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
  queued: 'En cola',
  pending: 'Preparación pendiente',
  leased: 'Preparación en curso',
  sending: 'Envío iniciado, resultado pendiente',
  sent: 'Enviado',
  manual_review: 'Revisión manual',
  suppressed: 'No enviado por preferencia del cliente'
}
const statusTones: Record<CommunicationHistory['items'][number]['status'], 'neutral' | 'success' | 'warning' | 'info'> =
  {
    queued: 'neutral',
    pending: 'info',
    leased: 'info',
    sending: 'info',
    sent: 'success',
    manual_review: 'warning',
    suppressed: 'neutral'
  }
const columns = [
  { key: 'eventType', label: 'Comunicación' },
  { key: 'status', label: 'Estado' },
  { key: 'createdAt', label: 'Registrada' },
  { key: 'availableAt', label: 'Próxima preparación', hideOnMobile: true },
  { key: 'finishedAt', label: 'Finalizada', hideOnMobile: true }
]
const typeLabels: Record<CommunicationHistory['items'][number]['eventType'], string> = {
  'order.created': 'Pedido registrado',
  'order.confirmed': 'Confirmación de pedido',
  'order.status.updated': 'Preparación o entrega',
  'order.cancelled': 'Cancelación de pedido',
  'order.cancellation.requested': 'Solicitud de cancelación',
  'order.reservation.expired': 'Reserva caducada',
  'order.shipped': 'Pedido enviado',
  'order.delivered': 'Pedido entregado',
  'refund.succeeded.email': 'Reembolso realizado',
  'return.requested': 'Solicitud de devolución',
  'return.status.updated': 'Estado de devolución',
  'support.ticket.received': 'Consulta recibida',
  'support.ticket.reply': 'Respuesta de soporte',
  'invoice.issued': 'Factura emitida'
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
  message.value =
    'Reprogramación registrada y estado actual confirmado. Desde esta acción no se ha enviado ningún mensaje.'
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
      message.value = 'Resultado incierto. Comprueba el resultado de esta misma operación; no vuelvas a enviarla.'
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
  <section aria-label="Historial operativo de comunicaciones" class="adm-stack min-w-0">
    <p class="adm-help max-w-3xl">
      Avisos automáticos de pedidos, devoluciones, soporte y facturas, sin destinatarios ni contenido. No envía mensajes
      directamente: reprogramar la preparación solo permite un envío posterior si el servicio de correo está activo, y
      no reinicia los intentos. Los envíos ya iniciados y las revisiones manuales no se reprograman desde aquí.
    </p>
    <template v-if="active">
      <UAlert
        v-if="message"
        :role="phase === 'error' || phase === 'unknown' ? 'alert' : 'status'"
        :color="phase === 'error' ? 'error' : phase === 'unknown' ? 'warning' : 'success'"
        variant="subtle"
        :icon="phase === 'error' || phase === 'unknown' ? 'i-lucide-triangle-alert' : 'i-lucide-circle-check'"
        :title="message"
      />
      <AdminTable
        :rows="snapshot?.items ?? []"
        :columns="columns"
        :row-key="(row) => row.eventId"
        :status="phase === 'loading' ? 'pending' : 'success'"
        :total="snapshot?.total ?? 0"
        :per-page="25"
        :page="snapshot?.page ?? 1"
        :empty-title="
          snapshot ? 'No hay comunicaciones para estos filtros' : 'Todavía no se ha consultado el historial'
        "
        :empty-description="
          snapshot ? 'Prueba con otro estado o tipo de comunicación.' : 'Elige los filtros y pulsa «Consultar».'
        "
        empty-icon="i-lucide-mail-search"
        caption="Historial de comunicaciones"
        @update:page="load($event)"
      >
        <template #toolbar>
          <form class="adm-toolbar" role="search" @submit.prevent="load(1)">
            <select v-model="status" :disabled="busy || !!intent" aria-label="Estado" class="adm-input">
              <option value="">Todos los estados</option>
              <option v-for="value in communicationStatusSchema.options" :key="value" :value="value">
                {{ statusLabels[value] }}
              </option>
            </select>
            <select
              v-model="eventType"
              :disabled="busy || !!intent"
              aria-label="Tipo de comunicación"
              class="adm-input"
            >
              <option value="">Todos los tipos</option>
              <option v-for="value in communicationTypeSchema.options" :key="value" :value="value">
                {{ typeLabels[value] }}
              </option>
            </select>
            <button type="submit" :disabled="busy || !!intent" class="adm-btn adm-btn--secondary">
              Consultar historial de comunicaciones
            </button>
            <p v-if="phase === 'loading'" role="status" class="adm-help">Consultando el historial…</p>
            <p v-else-if="snapshot" class="adm-toolbar__end adm-help">
              Datos de
              <time :datetime="snapshot.evaluatedAt">{{ adminDate(snapshot.evaluatedAt, true) }}</time>
            </p>
          </form>
        </template>
        <template #cell-eventType="{ row }">
          <span class="block font-semibold text-[var(--text-strong)]">{{ typeLabels[row.eventType] }}</span>
          <span class="adm-help block">#{{ row.eventId.slice(0, 8).toUpperCase() }}</span>
        </template>
        <template #cell-status="{ row }">
          <AdminBadge :tone="statusTones[row.status]">{{ statusLabels[row.status] }}</AdminBadge>
          <span class="adm-help ml-2 whitespace-nowrap">{{ row.attempts }} intentos</span>
          <span v-if="row.errorCode" class="adm-help block">Incidencia: {{ adminHumanize(row.errorCode) }}</span>
        </template>
        <template #cell-createdAt="{ row }">
          <time :datetime="row.createdAt">{{ adminDate(row.createdAt, true) }}</time>
        </template>
        <template #cell-availableAt="{ row }">
          <time v-if="row.availableAt" :datetime="row.availableAt">{{ adminDate(row.availableAt, true) }}</time>
          <template v-else>—</template>
        </template>
        <template #cell-finishedAt="{ row }">
          <time v-if="row.finishedAt" :datetime="row.finishedAt">{{ adminDate(row.finishedAt, true) }}</time>
          <template v-else>—</template>
        </template>
        <template #actions="{ row }">
          <button
            v-if="row.canRetry"
            type="button"
            :disabled="busy || !!intent"
            class="adm-btn adm-btn--secondary adm-btn--sm"
            @click="select(row)"
          >
            Revisar preparación
          </button>
          <span v-else class="adm-help">Sin acciones</span>
        </template>
      </AdminTable>

      <AdminCard
        v-if="selection && !intent"
        :title="`Reprogramar: ${typeLabels[selection.eventType]}`"
        description="No se vuelve a enviar un mensaje desde esta acción."
      >
        <form data-communication-review class="adm-stack" @submit.prevent="review">
          <AdminFormField
            v-slot="{ id }"
            label="Motivo"
            help="Entre 10 y 500 caracteres, sin datos personales."
            required
          >
            <textarea :id="id" v-model="reason" minlength="10" maxlength="500" required :disabled="busy" />
          </AdminFormField>
          <div class="flex flex-wrap justify-end gap-2">
            <button type="button" :disabled="busy" class="adm-btn adm-btn--secondary" @click="cancelReview">
              Cancelar revisión
            </button>
            <button type="submit" :disabled="busy" class="adm-btn adm-btn--primary">Revisar reprogramación</button>
          </div>
        </form>
      </AdminCard>

      <AdminCard v-if="intent && !intent.submitted" title="Confirma la reprogramación">
        <div class="adm-stack">
          <p>
            Comunicación #{{ intent.eventId.slice(0, 8).toUpperCase() }}. Intentos conservados:
            {{ intent.body.expectedAttempts }}. Se solicitará preparar de nuevo; no se acredita un envío.
          </p>
          <p class="break-words">Motivo: {{ intent.body.reason }}</p>
        </div>
        <template #footer>
          <button type="button" :disabled="busy" class="adm-btn adm-btn--secondary" @click="cancelReview">
            Volver a revisar
          </button>
          <button type="button" :disabled="busy" class="adm-btn adm-btn--primary" @click="send">
            Confirmar reprogramación
          </button>
        </template>
      </AdminCard>

      <AdminCard v-if="intent?.submitted" title="Comprueba el resultado">
        <p>
          Conserva esta pestaña hasta comprobar el resultado. Si sales, se pierde la referencia necesaria para recuperar
          el recibo.
        </p>
        <template #footer>
          <button type="button" :disabled="busy" class="adm-btn adm-btn--primary" @click="recover">
            Comprobar reprogramación
          </button>
        </template>
      </AdminCard>
    </template>
    <AdminCard v-else flush>
      <AdminEmptyState
        role="status"
        compact
        icon="i-lucide-lock"
        title="Historial no disponible ahora"
        description="Consulta no autorizada o pendiente de otra operación. No se muestran datos privados."
      />
    </AdminCard>
  </section>
</template>

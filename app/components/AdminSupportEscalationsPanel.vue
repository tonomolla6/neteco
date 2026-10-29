<script setup lang="ts">
import {
  supportEscalationSnapshotSchema,
  supportEscalationListSchema,
  supportRunbookLibrarySchema,
  supportEscalationInputSchema,
  supportRunbookInputSchema,
  supportEscalationReceiptSchema,
  supportEscalationCommandSchema,
  supportEscalationIntentHash,
  type SupportEscalationSnapshot,
  type SupportEscalationList,
  type SupportEscalationReceipt
} from '~~/shared/support-escalations'
import { supportRef } from '~~/shared/support-operations'
const props = defineProps<{ publicRef: string; scopeKey: string; enabled: boolean; pending?: boolean }>()
const emit = defineEmits<{ pending: [value: boolean]; confirmed: [receipt: SupportEscalationReceipt] }>()
const fetch = useRequestFetch()
const snapshot = shallowRef<SupportEscalationSnapshot | null>(null),
  queue = shallowRef<SupportEscalationList | null>(null)
const books = shallowRef<ReturnType<typeof supportRunbookLibrarySchema.parse> | null>(null)
const selectedRef = ref(props.publicRef),
  busy = ref(false),
  message = ref(''),
  uncertain = ref(false)
const filters = reactive({ queue: '', state: 'open', severity: '', owner: 'me' })
const form = reactive({
  action: 'handoff',
  queue: 'payment',
  severity: 'normal',
  ownerId: '',
  runbookId: '',
  nextAction: '',
  nextActionAt: '',
  reason: '',
  resolution: ''
})
const bookForm = reactive({
  id: '',
  action: 'draft',
  queue: 'payment',
  title: '',
  body: '',
  reason: '',
  operationalReference: '',
  reviewedAt: '',
  expiresAt: ''
})
type Intent = {
  target: string
  endpoint: string
  body: ReturnType<typeof supportEscalationInputSchema.parse> | ReturnType<typeof supportRunbookInputSchema.parse>
  key: string
  hash: string
  sent: boolean
}
const intent = shallowRef<Intent | null>(null)
let epoch = 0,
  controller: AbortController | null = null
const active = computed(() => props.enabled && !!props.scopeKey && supportRef.safeParse(props.publicRef).success)
const availableBooks = computed(() => snapshot.value?.runbooks.filter((book) => book.queue === form.queue) ?? [])
const selectedBook = computed(() => books.value?.items.find((book) => book.id === bookForm.id))
const queues = { payment: 'Pago', stock: 'Existencias', transport: 'Transporte', beply: 'Beply / fiscal' }
const severityLabels = { normal: 'Normal', high: 'Alta', critical: 'Crítica' }
function purge() {
  epoch++
  controller?.abort()
  controller = null
  snapshot.value = null
  queue.value = null
  books.value = null
  intent.value = null
  uncertain.value = false
  busy.value = false
  message.value = ''
  Object.assign(form, {
    action: 'handoff',
    queue: 'payment',
    severity: 'normal',
    ownerId: '',
    runbookId: '',
    nextAction: '',
    nextActionAt: '',
    reason: '',
    resolution: ''
  })
  Object.assign(bookForm, {
    id: '',
    action: 'draft',
    queue: 'payment',
    title: '',
    body: '',
    reason: '',
    operationalReference: '',
    reviewedAt: '',
    expiresAt: ''
  })
  Object.assign(filters, { queue: '', state: 'open', severity: '', owner: 'me' })
  selectedRef.value = props.publicRef
  emit('pending', false)
}
watch(() => [active.value, props.scopeKey, props.publicRef], purge, { flush: 'sync' })
function permitted(generation: number) {
  return active.value && generation === epoch
}
function failure(error: unknown, generation: number) {
  if (!permitted(generation)) return
  const value = error as { status?: number; statusCode?: number }
  if ([401, 403].includes(value.statusCode ?? value.status ?? 0)) {
    purge()
    message.value = 'Autorización revocada. Se han retirado los datos privados.'
    return
  }
  message.value = intent.value?.sent
    ? 'Resultado incierto. Comprueba el recibo; no vuelvas a enviar la operación.'
    : 'No se ha podido consultar o preparar la operación. No se supone ningún resultado.'
  if (intent.value?.sent) uncertain.value = true
}
async function read(target: string, page = 1) {
  const raw = await fetch<unknown>('/api/admin/support/' + target + '/escalation', {
    query: { page, perPage: 25 },
    signal: controller!.signal
  })
  const value = supportEscalationSnapshotSchema.parse(raw)
  if (value.publicRef !== target) throw new Error('identity_mismatch')
  return value
}
async function load(target = selectedRef.value, page = 1) {
  if (!active.value || props.pending || busy.value || intent.value) return
  const generation = epoch
  busy.value = true
  controller = new AbortController()
  message.value = ''
  snapshot.value = null
  try {
    const value = await read(target, page)
    if (!permitted(generation)) return
    snapshot.value = value
    selectedRef.value = target
    form.action = value.escalation ? 'update' : 'handoff'
    if (value.escalation) Object.assign(form, value.escalation, { runbookId: value.escalation.runbook.id })
  } catch (error) {
    failure(error, generation)
  } finally {
    if (permitted(generation)) busy.value = false
  }
}
async function loadQueue(page = 1) {
  if (!active.value || props.pending || busy.value || intent.value) return
  const generation = epoch
  busy.value = true
  controller = new AbortController()
  queue.value = null
  try {
    const query = { page, perPage: 25, ...Object.fromEntries(Object.entries(filters).filter(([, value]) => value)) }
    const value = supportEscalationListSchema.parse(
      await fetch<unknown>('/api/admin/support/escalations', { query, signal: controller.signal })
    )
    if (permitted(generation)) queue.value = value
  } catch (error) {
    failure(error, generation)
  } finally {
    if (permitted(generation)) busy.value = false
  }
}
async function loadBooks() {
  if (!active.value || props.pending || busy.value || intent.value) return
  const generation = epoch
  busy.value = true
  controller = new AbortController()
  books.value = null
  try {
    const value = supportRunbookLibrarySchema.parse(
      await fetch<unknown>('/api/admin/support/escalations/runbooks', { signal: controller.signal })
    )
    if (permitted(generation)) books.value = value
  } catch (error) {
    failure(error, generation)
  } finally {
    if (permitted(generation)) busy.value = false
  }
}
async function freeze(target: string, raw: unknown, runbook = false) {
  if (!active.value || props.pending || busy.value || intent.value) return
  const generation = epoch
  busy.value = true
  message.value = ''
  try {
    const body = runbook ? supportRunbookInputSchema.parse(raw) : supportEscalationInputSchema.parse(raw)
    const key = crypto.randomUUID(),
      hash = await supportEscalationIntentHash(target, body)
    if (!permitted(generation) || props.pending) return
    intent.value = {
      target,
      endpoint: runbook
        ? '/api/admin/support/escalations/runbooks/' + target + '/commands'
        : '/api/admin/support/' + target + '/escalation/commands',
      body,
      key,
      hash,
      sent: false
    }
    uncertain.value = false
    emit('pending', true)
  } catch (error) {
    failure(error, generation)
  } finally {
    if (permitted(generation)) busy.value = false
  }
}
function prepare() {
  const value = snapshot.value
  if (!value) return
  const common = {
    action: form.action,
    expectedVersion: value.escalation?.version ?? 0,
    expectedTicketVersion: value.ticketVersion,
    reason: form.reason.trim()
  }
  const runbook = availableBooks.value.find((book) => book.id === form.runbookId)
  void freeze(
    selectedRef.value,
    form.action === 'resolve'
      ? { ...common, resolution: form.resolution.trim() }
      : {
          ...common,
          queue: form.queue,
          severity: form.severity,
          ownerId: form.ownerId,
          runbook: runbook ? { id: runbook.id, version: runbook.version } : null,
          nextAction: form.nextAction.trim(),
          nextActionAt: form.nextActionAt
        }
  )
}
function prepareBook() {
  const previous = books.value?.items.find((book) => book.id === bookForm.id),
    common = { action: bookForm.action, expectedVersion: previous?.version ?? 0, reason: bookForm.reason.trim() }
  void freeze(
    bookForm.id || crypto.randomUUID(),
    bookForm.action === 'draft'
      ? { ...common, queue: bookForm.queue, title: bookForm.title.trim(), body: bookForm.body.trim() }
      : bookForm.action === 'approve'
        ? {
            ...common,
            operationalReference: bookForm.operationalReference.trim(),
            reviewedAt: bookForm.reviewedAt,
            expiresAt: bookForm.expiresAt
          }
        : common,
    true
  )
}
function receipt(raw: unknown, current: Intent) {
  const result = supportEscalationReceiptSchema.parse(raw)
  if (
    result.commandId !== current.key ||
    result.targetId !== current.target ||
    result.payloadHash !== current.hash ||
    result.action !== current.body.action ||
    result.expectedVersion !== current.body.expectedVersion ||
    result.version !== current.body.expectedVersion + 1
  )
    throw new Error('receipt_mismatch')
  return result
}
async function send(recover = false) {
  const current = intent.value
  if (!active.value || props.pending || busy.value || !current || (!recover && current.sent)) return
  const generation = epoch
  busy.value = true
  controller = new AbortController()
  const firstPost = !recover && !current.sent
  let receiptArrived = false
  try {
    let result: SupportEscalationReceipt
    if (recover) {
      const response = supportEscalationCommandSchema.parse(
        await fetch<unknown>(current.endpoint + '/' + current.key, {
          headers: { 'X-Neteco-Command-Payload-Hash': current.hash },
          signal: controller.signal
        })
      )
      if (!permitted(generation)) return
      if (response.outcome === 'unknown') {
        uncertain.value = true
        message.value = 'Resultado incierto. No hay recibo confirmado; no se vuelve a enviar.'
        return
      }
      result = receipt(response.receipt, current)
    } else {
      current.sent = true
      const rawReceipt = await fetch<unknown>(current.endpoint, {
        method: 'POST',
        body: current.body,
        headers: { 'Idempotency-Key': current.key },
        signal: controller.signal
      })
      receiptArrived = true
      result = receipt(rawReceipt, current)
    }
    if (!permitted(generation)) return
    if (current.target.startsWith('SOP-')) {
      const value = await read(current.target)
      if (!permitted(generation)) return
      const state = value.escalation
      if (!state || state.version < result.version) throw new Error('stale_read')
      if (state.version === result.version) {
        const body = supportEscalationInputSchema.parse(current.body)
        if (
          body.action === 'resolve'
            ? state.state !== 'resolved' || state.resolution !== body.resolution
            : state.queue !== body.queue ||
              state.ownerId !== body.ownerId ||
              state.severity !== body.severity ||
              state.nextAction !== body.nextAction ||
              state.nextActionAt !== body.nextActionAt ||
              state.runbook.id !== body.runbook.id ||
              state.runbook.version !== body.runbook.version
        )
          throw new Error('state_mismatch')
      }
      snapshot.value = value
    } else {
      const value = supportRunbookLibrarySchema.parse(
        await fetch<unknown>('/api/admin/support/escalations/runbooks', { signal: controller.signal })
      )
      if (!permitted(generation)) return
      const state = value.items.find((book) => book.id === current.target)
      if (!state || state.version < result.version) throw new Error('stale_read')
      if (state.version === result.version) {
        const body = supportRunbookInputSchema.parse(current.body)
        if (
          body.action === 'draft' &&
          (state.state !== 'draft' ||
            state.queue !== body.queue ||
            state.title !== body.title ||
            state.body !== body.body)
        )
          throw new Error('state_mismatch')
        if (
          body.action === 'approve' &&
          (state.state !== 'approved' ||
            state.operationalReference !== body.operationalReference ||
            state.reviewedAt !== body.reviewedAt ||
            state.expiresAt !== body.expiresAt)
        )
          throw new Error('state_mismatch')
        if (body.action === 'withdraw' && state.state !== 'withdrawn') throw new Error('state_mismatch')
      }
      books.value = value
      bookForm.id = current.target
      snapshot.value = null
    }
    intent.value = null
    uncertain.value = false
    form.reason = ''
    bookForm.reason = ''
    message.value = 'Operación interna confirmada con recibo y lectura actual.'
    emit('pending', false)
    emit('confirmed', result)
  } catch (error) {
    const value = error as { status?: number; statusCode?: number; data?: { error?: { code?: string } } }
    if (
      permitted(generation) &&
      firstPost &&
      !receiptArrived &&
      (value.statusCode ?? value.status) === 409 &&
      ['version_conflict', 'ticket_version_conflict'].includes(value.data?.error?.code ?? '')
    ) {
      intent.value = null
      snapshot.value = null
      books.value = null
      uncertain.value = false
      message.value =
        'La versión ha cambiado y este envío fue rechazado. Consulta el estado vigente antes de preparar otra operación.'
      emit('pending', false)
    } else failure(error, generation)
  } finally {
    if (permitted(generation)) busy.value = false
  }
}
function cancel() {
  if (intent.value && !intent.value.sent && !busy.value) {
    intent.value = null
    emit('pending', false)
  }
}
function leaving(event: BeforeUnloadEvent) {
  if (intent.value?.sent) {
    event.preventDefault()
    event.returnValue = ''
  }
}
onMounted(() => window.addEventListener('beforeunload', leaving))
onBeforeUnmount(() => {
  window.removeEventListener('beforeunload', leaving)
  purge()
})
</script>
<template>
  <section v-if="active" aria-label="Escalado interno de incidencias" class="min-w-0 space-y-4 rounded border p-4">
    <h3 class="font-semibold">Escalado humano interno</h3>
    <p>
      Sin cambios en cobros, existencias ni mensajes al cliente. La cola y su resolución no cambian el estado del
      ticket.
    </p>
    <p v-if="message" role="status">{{ message }}</p>
    <p v-if="busy" role="status">Consultando o registrando la operación…</p>
    <button type="button" :disabled="busy || pending || !!intent" class="rounded border p-2" @click="load()">
      Consultar escalado del ticket
    </button>
    <form v-if="!pending && !intent" class="flex flex-wrap gap-2" @submit.prevent="loadQueue()">
      <label
        >Cola
        <select v-model="filters.queue" class="rounded border p-2">
          <option value="">Todas</option>
          <option v-for="(label, key) in queues" :key="key" :value="key">{{ label }}</option>
        </select></label
      >
      <label
        >Estado
        <select v-model="filters.state" class="rounded border p-2">
          <option value="">Todos</option>
          <option value="open">Abierto</option>
          <option value="resolved">Resuelto</option>
        </select></label
      >
      <label
        >Severidad
        <select v-model="filters.severity" class="rounded border p-2">
          <option value="">Todas</option>
          <option v-for="(label, key) in severityLabels" :key="key" :value="key">{{ label }}</option>
        </select></label
      >
      <label
        >Responsable
        <select v-model="filters.owner" class="rounded border p-2">
          <option value="">Todos</option>
          <option value="me">Asignados a mí</option>
          <option v-for="staff in snapshot?.staff ?? []" :key="staff.id" :value="staff.id">{{ staff.label }}</option>
        </select></label
      >
      <button :disabled="busy || pending || !!intent" class="rounded border p-2">Consultar cola</button>
    </form>
    <div v-if="queue">
      <p v-if="!queue.items.length">No hay escalados con estos filtros confirmados.</p>
      <ul class="space-y-2">
        <li v-for="item in queue.items" :key="item.publicRef" class="break-words">
          <button
            type="button"
            :disabled="busy || pending || !!intent"
            class="rounded border p-2"
            @click="load(item.publicRef)"
          >
            {{ item.publicRef }} · {{ queues[item.queue] }} · {{ severityLabels[item.severity] }} ·
            {{ item.state === 'open' ? 'Abierto' : 'Resuelto' }}
          </button>
          <p>{{ item.nextAction }} · {{ item.nextActionAt }}</p>
        </li>
      </ul>
      <button :disabled="busy || pending || !!intent || queue.page === 1" @click="loadQueue(queue.page - 1)">
        Página anterior
      </button>
      <button
        :disabled="busy || pending || !!intent || queue.page * queue.perPage >= queue.total"
        @click="loadQueue(queue.page + 1)"
      >
        Página siguiente
      </button>
    </div>
    <div v-if="snapshot" class="space-y-3">
      <h4 class="break-words">Expediente {{ snapshot.publicRef }} · versión del ticket {{ snapshot.ticketVersion }}</h4>
      <p v-if="snapshot.escalation">
        Escalado {{ snapshot.escalation.state === 'open' ? 'abierto' : 'resuelto' }} · revisión
        {{ snapshot.escalation.version }}
      </p>
      <p v-else>Sin escalado registrado.</p>
      <form
        v-if="snapshot.escalation?.state !== 'resolved' && !intent && !pending"
        class="space-y-3"
        @submit.prevent="prepare"
      >
        <fieldset :disabled="busy || pending" class="space-y-3">
          <label class="block"
            >Acción
            <select v-model="form.action">
              <option v-if="!snapshot.escalation" value="handoff">Escalar</option>
              <option v-if="snapshot.escalation" value="update">Reasignar / actualizar</option>
              <option v-if="snapshot.escalation" value="resolve">Resolver escalado</option>
            </select></label
          >
          <template v-if="form.action !== 'resolve'">
            <label class="block"
              >Destino
              <select v-model="form.queue">
                <option v-for="(label, key) in queues" :key="key" :value="key">{{ label }}</option>
              </select></label
            >
            <label class="block"
              >Severidad
              <select v-model="form.severity">
                <option v-for="(label, key) in severityLabels" :key="key" :value="key">{{ label }}</option>
              </select></label
            >
            <label class="block"
              >Responsable elegible
              <select v-model="form.ownerId" required>
                <option value="">Selecciona responsable</option>
                <option v-for="staff in snapshot.staff" :key="staff.id" :value="staff.id">{{ staff.label }}</option>
              </select></label
            >
            <label class="block"
              >Runbook interno aprobado
              <select v-model="form.runbookId" required>
                <option value="">Selecciona revisión vigente</option>
                <option v-for="book in availableBooks" :key="book.id" :value="book.id">
                  {{ book.title }} · v{{ book.version }}
                </option>
              </select></label
            >
            <p class="whitespace-pre-wrap break-words">
              {{ availableBooks.find((book) => book.id === form.runbookId)?.body }}
            </p>
            <label class="block"
              >Siguiente acción
              <textarea
                v-model="form.nextAction"
                required
                minlength="10"
                maxlength="1000"
                class="w-full rounded border p-2"
              />
            </label>
            <label class="block"
              >Fecha de siguiente acción UTC
              <input
                v-model="form.nextActionAt"
                required
                placeholder="2026-10-10T10:00:00Z"
                class="max-w-full rounded border p-2"
            /></label>
          </template>
          <label v-else class="block"
            >Resolución interna
            <textarea
              v-model="form.resolution"
              required
              minlength="10"
              maxlength="2000"
              class="w-full rounded border p-2"
            />
          </label>
          <label class="block"
            >Motivo documentado
            <textarea v-model="form.reason" required minlength="10" maxlength="500" class="w-full rounded border p-2" />
          </label>
          <button class="rounded border p-2">Revisar escalado</button>
        </fieldset>
      </form>
      <ol>
        <li v-for="item in snapshot.history" :key="item.receipt.commandId" class="break-words border-t py-2">
          Revisión {{ item.receipt.version }} · {{ item.receipt.recordedAt }} · {{ item.actorId }}
          <p>{{ item.reason }}</p>
          <p>{{ item.snapshot.nextAction }}</p>
          <p v-if="item.snapshot.resolution">{{ item.snapshot.resolution }}</p>
        </li>
      </ol>
      <button
        :disabled="busy || pending || !!intent || snapshot.page === 1"
        @click="load(selectedRef, snapshot.page - 1)"
      >
        Historia anterior</button
      ><button
        :disabled="busy || pending || !!intent || snapshot.page * snapshot.perPage >= snapshot.total"
        @click="load(selectedRef, snapshot.page + 1)"
      >
        Más historia
      </button>
    </div>
    <details>
      <summary>Biblioteca de runbooks internos (no respuestas al cliente)</summary>
      <button type="button" :disabled="busy || pending || !!intent" class="rounded border p-2" @click="loadBooks">
        Consultar runbooks y revisiones
      </button>
      <form v-if="books && !intent && !pending" class="space-y-3" @submit.prevent="prepareBook">
        <fieldset :disabled="busy || pending" class="space-y-3">
          <label class="block"
            >Runbook
            <select v-model="bookForm.id">
              <option value="">Nuevo runbook</option>
              <option v-for="book in books.items" :key="book.id" :value="book.id">
                {{ book.title }} · v{{ book.version }} · {{ book.state }}
              </option>
            </select></label
          >
          <div v-if="selectedBook" class="space-y-2 break-words rounded border p-2">
            <p>Cola: {{ queues[selectedBook.queue] }} · revisión {{ selectedBook.version }}</p>
            <p class="whitespace-pre-wrap">{{ selectedBook.body }}</p>
            <p v-if="selectedBook.operationalReference">
              Referencia de revisión: {{ selectedBook.operationalReference }} · revisado {{ selectedBook.reviewedAt }} ·
              vigente hasta {{ selectedBook.expiresAt }}
            </p>
            <p v-else>Borrador sin aprobación operativa.</p>
          </div>
          <label class="block"
            >Operación
            <select v-model="bookForm.action">
              <option value="draft">Registrar borrador</option>
              <option value="approve">Aprobar revisión interna</option>
              <option value="withdraw">Retirar aprobación</option>
            </select></label
          >
          <template v-if="bookForm.action === 'draft'"
            ><label class="block"
              >Cola
              <select v-model="bookForm.queue">
                <option v-for="(label, key) in queues" :key="key" :value="key">{{ label }}</option>
              </select></label
            ><label class="block"
              >Título
              <input
                v-model="bookForm.title"
                required
                minlength="3"
                maxlength="120"
                class="max-w-full rounded border p-2" /></label
            ><label class="block"
              >Instrucciones internas
              <textarea
                v-model="bookForm.body"
                required
                minlength="10"
                maxlength="4000"
                class="w-full rounded border p-2"
              /></label
          ></template>
          <template v-if="bookForm.action === 'approve'"
            ><p>Documenta una revisión humana ya realizada, no una aprobación ficticia ni una promesa de proveedor.</p>
            <label class="block"
              >Referencia operativa
              <input
                v-model="bookForm.operationalReference"
                required
                maxlength="200"
                class="max-w-full rounded border p-2" /></label
            ><label class="block"
              >Revisado UTC
              <input
                v-model="bookForm.reviewedAt"
                required
                placeholder="2026-10-09T10:00:00Z"
                class="max-w-full rounded border p-2" /></label
            ><label class="block"
              >Vigente hasta UTC
              <input
                v-model="bookForm.expiresAt"
                required
                placeholder="2026-11-09T10:00:00Z"
                class="max-w-full rounded border p-2" /></label
          ></template>
          <label class="block"
            >Motivo de la revisión
            <textarea
              v-model="bookForm.reason"
              required
              minlength="10"
              maxlength="500"
              class="w-full rounded border p-2"
            /></label
          ><button class="rounded border p-2">Revisar operación de runbook</button>
        </fieldset>
      </form>
    </details>
    <div v-if="intent" class="space-y-2 rounded border p-3">
      <p>
        Revisión explícita: {{ intent.body.action }} · {{ intent.target }} · versión {{ intent.body.expectedVersion }}.
        {{ intent.body.reason }}
      </p>
      <p v-if="uncertain">Resultado incierto: conserva esta pestaña para recuperar el recibo.</p>
      <button v-if="!intent.sent" :disabled="busy || pending" class="rounded border p-2" @click="send()">
        Confirmar operación interna</button
      ><button v-else :disabled="busy || pending" class="rounded border p-2" @click="send(true)">
        Comprobar operación interna</button
      ><button v-if="!intent.sent" :disabled="busy" class="rounded border p-2" @click="cancel">
        Cancelar revisión no enviada
      </button>
    </div>
  </section>
</template>

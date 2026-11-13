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
const queues = { payment: 'Pagos', stock: 'Existencias', transport: 'Transporte', beply: 'Facturación' }
const severityLabels = { normal: 'Normal', high: 'Alta', critical: 'Crítica' }
const bookStateLabels: Record<string, string> = { draft: 'Borrador', approved: 'Aprobado', withdrawn: 'Retirado' }
const actionLabels: Record<string, string> = {
  handoff: 'Pasar a otro equipo',
  update: 'Cambiar la derivación',
  resolve: 'Dar la derivación por resuelta',
  draft: 'Guardar borrador de procedimiento',
  approve: 'Aprobar procedimiento',
  withdraw: 'Retirar la aprobación del procedimiento'
}
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-/i
function shortRef(value: string) {
  return uuidPattern.test(value) ? '#' + value.slice(0, 8).toUpperCase() : value
}
function staffName(id: string) {
  return snapshot.value?.staff.find((staff) => staff.id === id)?.label ?? 'Equipo ' + shortRef(id)
}
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
    message.value = 'Autorización revocada: ya no tienes permiso. Se han ocultado los datos.'
    return
  }
  message.value = intent.value?.sent
    ? 'Resultado incierto: no sabemos si se ha guardado. Compruébalo antes de volver a intentarlo.'
    : 'No se ha podido cargar o preparar el cambio. No se ha guardado nada.'
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
        message.value = 'Resultado incierto: todavía no consta que se haya guardado. No se ha vuelto a enviar.'
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
    message.value = 'Cambio guardado.'
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
        'Otra persona ha cambiado esta derivación y el envío se ha rechazado. Actualiza antes de volver a intentarlo.'
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
  <AdminCard
    v-if="active"
    aria-label="Escalado interno de incidencias"
    class="min-w-0"
    title="Pasar a otro equipo"
    description="Gestión interna: no cambia cobros, existencias, el estado de la consulta ni envía mensajes al cliente."
  >
    <template #actions>
      <button
        type="button"
        :disabled="busy || pending || !!intent"
        class="adm-btn adm-btn--secondary adm-btn--sm"
        @click="load()"
      >
        Ver derivación de esta consulta
      </button>
    </template>
    <div class="adm-stack">
      <UAlert v-if="message" role="status" color="info" variant="subtle" icon="i-lucide-info" :title="message" />
      <p v-if="busy" role="status" class="adm-help">Cargando…</p>

      <div v-if="snapshot" class="adm-stack">
        <p class="flex flex-wrap items-center gap-2 break-words">
          <span class="font-semibold text-[var(--text-strong)]">Consulta {{ snapshot.publicRef }}</span>
          <AdminBadge v-if="snapshot.escalation" :tone="snapshot.escalation.state === 'open' ? 'warning' : 'success'">
            {{ snapshot.escalation.state === 'open' ? 'Derivación abierta' : 'Derivación resuelta' }}
          </AdminBadge>
          <AdminBadge v-else tone="neutral" plain>Sin derivación</AdminBadge>
        </p>
        <form
          v-if="snapshot.escalation?.state !== 'resolved' && !intent && !pending"
          class="adm-stack"
          @submit.prevent="prepare"
        >
          <fieldset :disabled="busy || pending" class="adm-stack">
            <label class="adm-field">
              <span class="adm-label">Qué quieres hacer</span>
              <select v-model="form.action" class="w-full">
                <option v-if="!snapshot.escalation" value="handoff">Pasar a otro equipo</option>
                <option v-if="snapshot.escalation" value="update">Cambiar equipo, responsable o siguiente paso</option>
                <option v-if="snapshot.escalation" value="resolve">Dar la derivación por resuelta</option>
              </select>
            </label>
            <template v-if="form.action !== 'resolve'">
              <div class="adm-form-grid">
                <label class="adm-field">
                  <span class="adm-label">Equipo</span>
                  <select v-model="form.queue" class="w-full">
                    <option v-for="(label, key) in queues" :key="key" :value="key">{{ label }}</option>
                  </select>
                </label>
                <label class="adm-field">
                  <span class="adm-label">Gravedad</span>
                  <select v-model="form.severity" class="w-full">
                    <option v-for="(label, key) in severityLabels" :key="key" :value="key">{{ label }}</option>
                  </select>
                </label>
                <label class="adm-field">
                  <span class="adm-label">Responsable</span>
                  <select v-model="form.ownerId" required class="w-full">
                    <option value="">Elige una persona</option>
                    <option v-for="staff in snapshot.staff" :key="staff.id" :value="staff.id">{{ staff.label }}</option>
                  </select>
                </label>
                <label class="adm-field">
                  <span class="adm-label">Procedimiento a seguir</span>
                  <select v-model="form.runbookId" required class="w-full">
                    <option value="">Elige un procedimiento aprobado</option>
                    <option v-for="book in availableBooks" :key="book.id" :value="book.id">{{ book.title }}</option>
                  </select>
                </label>
              </div>
              <p
                v-if="availableBooks.find((book) => book.id === form.runbookId)?.body"
                class="whitespace-pre-wrap break-words rounded-[var(--radius-control)] bg-[var(--surface-sunken)] p-3 text-[var(--text-muted)]"
              >
                {{ availableBooks.find((book) => book.id === form.runbookId)?.body }}
              </p>
              <label class="adm-field">
                <span class="adm-label">Siguiente paso</span>
                <textarea v-model="form.nextAction" required minlength="10" maxlength="1000" class="w-full" />
              </label>
              <label class="adm-field">
                <span class="adm-label">Fecha del siguiente paso</span>
                <input v-model="form.nextActionAt" required placeholder="2026-10-10T10:00:00Z" class="w-full" />
                <span class="adm-help">Fecha y hora universal, con este formato.</span>
              </label>
            </template>
            <label v-else class="adm-field">
              <span class="adm-label">Cómo se ha resuelto (nota interna)</span>
              <textarea v-model="form.resolution" required minlength="10" maxlength="2000" class="w-full" />
            </label>
            <label class="adm-field">
              <span class="adm-label">Motivo (queda en el historial interno)</span>
              <textarea v-model="form.reason" required minlength="10" maxlength="500" class="w-full" />
            </label>
            <div class="flex justify-end">
              <button class="adm-btn adm-btn--primary">Continuar</button>
            </div>
          </fieldset>
        </form>
        <ol v-if="snapshot.history.length" class="adm-list" aria-label="Historial de la derivación">
          <li v-for="item in snapshot.history" :key="item.receipt.commandId" class="break-words">
            <div class="min-w-0 flex-1">
              <p class="adm-help">{{ adminDate(item.receipt.recordedAt, true) }} · {{ staffName(item.actorId) }}</p>
              <p>{{ item.reason }}</p>
              <p class="text-[var(--text-muted)]">Siguiente paso: {{ item.snapshot.nextAction }}</p>
              <p v-if="item.snapshot.resolution">Resolución: {{ item.snapshot.resolution }}</p>
            </div>
          </li>
        </ol>
        <div v-if="snapshot.total > snapshot.perPage" class="flex flex-wrap justify-end gap-2">
          <button
            class="adm-btn adm-btn--secondary adm-btn--sm"
            :disabled="busy || pending || !!intent || snapshot.page === 1"
            @click="load(selectedRef, snapshot.page - 1)"
          >
            Anterior
          </button>
          <button
            class="adm-btn adm-btn--secondary adm-btn--sm"
            :disabled="busy || pending || !!intent || snapshot.page * snapshot.perPage >= snapshot.total"
            @click="load(selectedRef, snapshot.page + 1)"
          >
            Siguiente
          </button>
        </div>
      </div>

      <details>
        <summary class="adm-btn adm-btn--ghost adm-btn--sm">Otras consultas derivadas</summary>
        <div class="adm-stack mt-3">
          <form v-if="!pending && !intent" class="adm-toolbar" @submit.prevent="loadQueue()">
            <select v-model="filters.queue" aria-label="Equipo">
              <option value="">Todos los equipos</option>
              <option v-for="(label, key) in queues" :key="key" :value="key">{{ label }}</option>
            </select>
            <select v-model="filters.state" aria-label="Estado">
              <option value="">Todos los estados</option>
              <option value="open">Abiertas</option>
              <option value="resolved">Resueltas</option>
            </select>
            <select v-model="filters.severity" aria-label="Gravedad">
              <option value="">Cualquier gravedad</option>
              <option v-for="(label, key) in severityLabels" :key="key" :value="key">{{ label }}</option>
            </select>
            <select v-model="filters.owner" aria-label="Responsable">
              <option value="">Cualquier responsable</option>
              <option value="me">Asignadas a mí</option>
              <option v-for="staff in snapshot?.staff ?? []" :key="staff.id" :value="staff.id">
                {{ staff.label }}
              </option>
            </select>
            <button :disabled="busy || pending || !!intent" class="adm-btn adm-btn--secondary">Buscar</button>
          </form>
          <template v-if="queue">
            <p v-if="!queue.items.length" class="adm-help">No hay consultas derivadas con estos filtros.</p>
            <ul v-else class="adm-list">
              <li v-for="item in queue.items" :key="item.publicRef" class="break-words">
                <div class="min-w-0 flex-1">
                  <p class="adm-list__title">
                    {{ item.publicRef }}
                    <AdminBadge :tone="item.state === 'open' ? 'warning' : 'success'">
                      {{ item.state === 'open' ? 'Abierta' : 'Resuelta' }}
                    </AdminBadge>
                  </p>
                  <p class="adm-help">
                    {{ queues[item.queue] }} · gravedad {{ severityLabels[item.severity].toLowerCase() }} ·
                    {{ item.nextAction }} · {{ adminDate(item.nextActionAt, true) }}
                  </p>
                </div>
                <button
                  type="button"
                  :disabled="busy || pending || !!intent"
                  class="adm-btn adm-btn--secondary adm-btn--sm"
                  @click="load(item.publicRef)"
                >
                  Ver
                </button>
              </li>
            </ul>
            <div v-if="queue.total > queue.perPage" class="flex flex-wrap justify-end gap-2">
              <button
                class="adm-btn adm-btn--secondary adm-btn--sm"
                :disabled="busy || pending || !!intent || queue.page === 1"
                @click="loadQueue(queue.page - 1)"
              >
                Anterior
              </button>
              <button
                class="adm-btn adm-btn--secondary adm-btn--sm"
                :disabled="busy || pending || !!intent || queue.page * queue.perPage >= queue.total"
                @click="loadQueue(queue.page + 1)"
              >
                Siguiente
              </button>
            </div>
          </template>
        </div>
      </details>

      <details>
        <summary class="adm-btn adm-btn--ghost adm-btn--sm">Procedimientos internos</summary>
        <div class="adm-stack mt-3">
          <p class="adm-help">Instrucciones para el equipo; no son respuestas para el cliente.</p>
          <div>
            <button
              type="button"
              :disabled="busy || pending || !!intent"
              class="adm-btn adm-btn--secondary adm-btn--sm"
              @click="loadBooks"
            >
              Ver procedimientos
            </button>
          </div>
          <form v-if="books && !intent && !pending" class="adm-stack" @submit.prevent="prepareBook">
            <fieldset :disabled="busy || pending" class="adm-stack">
              <label class="adm-field">
                <span class="adm-label">Procedimiento</span>
                <select v-model="bookForm.id" class="w-full">
                  <option value="">Nuevo procedimiento</option>
                  <option v-for="book in books.items" :key="book.id" :value="book.id">
                    {{ book.title }} · {{ bookStateLabels[book.state] ?? 'Otro estado' }}
                  </option>
                </select>
              </label>
              <div
                v-if="selectedBook"
                class="adm-stack break-words rounded-[var(--radius-control)] bg-[var(--surface-sunken)] p-3"
              >
                <p class="adm-help">Equipo: {{ queues[selectedBook.queue] }}</p>
                <p class="whitespace-pre-wrap">{{ selectedBook.body }}</p>
                <p v-if="selectedBook.operationalReference" class="adm-help">
                  Revisado por {{ selectedBook.operationalReference }} el
                  {{ adminDate(selectedBook.reviewedAt, true) }} · válido hasta
                  {{ adminDate(selectedBook.expiresAt, true) }}
                </p>
                <p v-else class="adm-help">Borrador sin aprobar.</p>
              </div>
              <label class="adm-field">
                <span class="adm-label">Qué quieres hacer</span>
                <select v-model="bookForm.action" class="w-full">
                  <option value="draft">Guardar borrador</option>
                  <option value="approve">Aprobar</option>
                  <option value="withdraw">Retirar la aprobación</option>
                </select>
              </label>
              <template v-if="bookForm.action === 'draft'">
                <div class="adm-form-grid">
                  <label class="adm-field">
                    <span class="adm-label">Equipo</span>
                    <select v-model="bookForm.queue" class="w-full">
                      <option v-for="(label, key) in queues" :key="key" :value="key">{{ label }}</option>
                    </select>
                  </label>
                  <label class="adm-field">
                    <span class="adm-label">Título</span>
                    <input v-model="bookForm.title" required minlength="3" maxlength="120" class="w-full" />
                  </label>
                </div>
                <label class="adm-field">
                  <span class="adm-label">Instrucciones para el equipo</span>
                  <textarea v-model="bookForm.body" required minlength="10" maxlength="4000" class="w-full" />
                </label>
              </template>
              <template v-if="bookForm.action === 'approve'">
                <p class="adm-help">Anota una revisión que ya haya hecho una persona del equipo.</p>
                <div class="adm-form-grid">
                  <label class="adm-field">
                    <span class="adm-label">Quién lo ha revisado</span>
                    <input v-model="bookForm.operationalReference" required maxlength="200" class="w-full" />
                  </label>
                  <label class="adm-field">
                    <span class="adm-label">Fecha de la revisión</span>
                    <input v-model="bookForm.reviewedAt" required placeholder="2026-10-09T10:00:00Z" class="w-full" />
                    <span class="adm-help">Fecha y hora universal, con este formato.</span>
                  </label>
                  <label class="adm-field">
                    <span class="adm-label">Válido hasta</span>
                    <input v-model="bookForm.expiresAt" required placeholder="2026-11-09T10:00:00Z" class="w-full" />
                    <span class="adm-help">Fecha y hora universal, con este formato.</span>
                  </label>
                </div>
              </template>
              <label class="adm-field">
                <span class="adm-label">Motivo del cambio</span>
                <textarea v-model="bookForm.reason" required minlength="10" maxlength="500" class="w-full" />
              </label>
              <div class="flex justify-end">
                <button class="adm-btn adm-btn--secondary">Continuar</button>
              </div>
            </fieldset>
          </form>
        </div>
      </details>

      <div
        v-if="intent"
        class="adm-stack rounded-[var(--radius-control)] border border-[var(--border)] bg-[var(--surface-sunken)] p-3"
      >
        <p class="font-semibold text-[var(--text-strong)]">
          {{ intent.sent ? 'No sabemos si se ha guardado' : 'Revisa y confirma' }}
        </p>
        <p class="break-words">
          {{ actionLabels[intent.body.action] ?? 'Cambio' }} · {{ shortRef(intent.target) }} · Motivo:
          {{ intent.body.reason }}
        </p>
        <p v-if="uncertain" class="adm-help">
          Resultado incierto: no cierres esta pestaña hasta comprobar si se ha guardado.
        </p>
        <div class="flex flex-wrap justify-end gap-2">
          <button v-if="!intent.sent" :disabled="busy" class="adm-btn adm-btn--secondary" @click="cancel">
            Cancelar
          </button>
          <button v-if="!intent.sent" :disabled="busy || pending" class="adm-btn adm-btn--primary" @click="send()">
            Confirmar y guardar
          </button>
          <button v-else :disabled="busy || pending" class="adm-btn adm-btn--primary" @click="send(true)">
            Comprobar si se guardó
          </button>
        </div>
      </div>
    </div>
  </AdminCard>
</template>

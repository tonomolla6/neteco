<script setup lang="ts">
import { catalogPolicyUuidSchema } from '~~/shared/catalog-publication-policy'
import {
  orderAnnotationsInputSchema,
  orderAnnotationsResponseSchema,
  orderAnnotationsReceiptSchema,
  orderAnnotationCommandSchema,
  type OrderAnnotationsInput,
  type OrderAnnotationsResponse,
  type OrderAnnotationsReceipt
} from '~~/shared/order-annotations'
const props = defineProps<{ orderId: string; scopeKey: string; enabled: boolean; pending: boolean }>()
const emit = defineEmits<{ pending: [boolean]; confirmed: [OrderAnnotationsReceipt] }>()
const request = useRequestFetch(),
  prefix = useId()
const allowed = computed(
  () => props.enabled && !props.pending && !!props.scopeKey && catalogPolicyUuidSchema.safeParse(props.orderId).success
)
const snapshot = shallowRef<OrderAnnotationsResponse | null>(null),
  receipt = shallowRef<OrderAnnotationsReceipt | null>(null)
type Intent = Readonly<{
  path: string
  orderId: string
  key: string
  body: Readonly<OrderAnnotationsInput>
  labels: readonly string[]
}>
const intent = shallowRef<Intent | null>(null),
  note = ref(''),
  labels = ref(''),
  checked = ref(false)
const busy = ref<'read' | 'more' | 'post' | 'lookup' | null>(null),
  status = ref<'idle' | 'loading' | 'ready' | 'error' | 'unknown' | 'confirmed' | 'conflict'>('idle')
let alive = true,
  generation = 0,
  controller: AbortController | null = null,
  commandPending = false
const base = () => `/api/admin/orders/${encodeURIComponent(props.orderId)}/annotations`
function current(epoch: number) {
  return alive && allowed.value && epoch === generation
}
function setCommandPending(value: boolean) {
  if (commandPending !== value) {
    commandPending = value
    emit('pending', value)
  }
}
function invalidate() {
  generation++
  controller?.abort()
  controller = null
  snapshot.value = null
  receipt.value = null
  intent.value = null
  note.value = ''
  labels.value = ''
  checked.value = false
  busy.value = null
  status.value = 'idle'
  setCommandPending(false)
}
function parseState(raw: unknown, orderId: string) {
  const value = orderAnnotationsResponseSchema.parse(raw)
  if (
    value.orderId !== orderId ||
    value.notes.length > 20 ||
    new Set(value.notes.map((item) => item.id)).size !== value.notes.length ||
    (value.nextCursor && !value.notes.length)
  )
    throw new Error('unconfirmed_annotations')
  return value
}
function adopt(value: OrderAnnotationsResponse) {
  snapshot.value = value
  note.value = ''
  labels.value = value.labels.join('\n')
}
async function load(more = false) {
  if (!allowed.value || busy.value || intent.value || !alive) return
  const previous = snapshot.value,
    cursor = more ? previous?.nextCursor : null
  if (more && !cursor) return
  const epoch = generation,
    abort = new AbortController(),
    path = base(),
    orderId = props.orderId
  controller = abort
  busy.value = more ? 'more' : 'read'
  status.value = more ? 'ready' : 'loading'
  if (!more) {
    snapshot.value = null
    receipt.value = null
    note.value = ''
    labels.value = ''
  }
  try {
    const raw = await request(path, {
      method: 'GET',
      query: { limit: 20, ...(cursor ? { before: cursor } : {}) },
      cache: 'no-store',
      retry: 0,
      signal: abort.signal
    })
    if (!current(epoch)) return
    const value = parseState(raw, orderId)
    if (more && previous) {
      const combined = [...previous.notes, ...value.notes]
      if (
        value.version !== previous.version ||
        JSON.stringify(value.labels) !== JSON.stringify(previous.labels) ||
        new Set(combined.map((item) => item.id)).size !== combined.length ||
        (value.nextCursor && value.nextCursor === cursor)
      )
        throw new Error('changed_annotations_page')
      snapshot.value = { ...value, notes: combined }
    } else adopt(value)
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
const input = computed(() => {
  const labelsInput = labels.value
    .split(/\r?\n/u)
    .map((value) => value.trim())
    .filter(Boolean)
  return orderAnnotationsInputSchema.safeParse({
    expectedVersion: snapshot.value?.version ?? 0,
    ...(note.value.trim() ? { note: note.value } : {}),
    ...(JSON.stringify(labelsInput) !== JSON.stringify(snapshot.value?.labels ?? []) ? { labels: labelsInput } : {})
  })
})
const canSubmit = computed(
  () =>
    allowed.value && !!snapshot.value && !busy.value && !intent.value && status.value !== 'error' && input.value.success
)
async function accept(raw: unknown, frozen: Intent, epoch: number, abort: AbortController) {
  const value = orderAnnotationsReceiptSchema.parse(raw)
  if (
    value.orderId !== frozen.orderId ||
    value.commandId !== frozen.key ||
    value.version !== frozen.body.expectedVersion + 1 ||
    JSON.stringify(value.labels) !== JSON.stringify(frozen.labels) ||
    (frozen.body.note === undefined ? value.noteId !== null : value.noteId === null)
  )
    throw new Error('unconfirmed_annotation_receipt')
  const fresh = await request(frozen.path, {
    method: 'GET',
    query: { limit: 20 },
    cache: 'no-store',
    retry: 0,
    signal: abort.signal
  })
  if (!current(epoch) || intent.value !== frozen) return
  const valueNow = parseState(fresh, frozen.orderId)
  if (
    valueNow.version < value.version ||
    (valueNow.version === value.version && JSON.stringify(valueNow.labels) !== JSON.stringify(value.labels))
  )
    throw new Error('unconfirmed_current_annotations')
  adopt(valueNow)
  receipt.value = value
  intent.value = null
  checked.value = false
  status.value = 'confirmed'
  setCommandPending(false)
  emit('confirmed', value)
}
async function send(frozen: Intent) {
  if (!allowed.value || busy.value || intent.value !== frozen || !alive) return
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
  const parsed = input.value
  if (!canSubmit.value || !parsed.success || !snapshot.value) return
  const body = { ...parsed.data, ...(parsed.data.labels ? { labels: [...parsed.data.labels] } : {}) }
  if (body.labels) Object.freeze(body.labels)
  const frozen = Object.freeze({
    path: base(),
    orderId: props.orderId,
    key: crypto.randomUUID(),
    body: Object.freeze(body),
    labels: Object.freeze([...(body.labels ?? snapshot.value.labels)])
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
    const value = orderAnnotationCommandSchema.parse(raw)
    if (value.orderId !== frozen.orderId || value.commandId !== frozen.key)
      throw new Error('unconfirmed_annotation_command')
    if (value.outcome === 'applied') await accept(value.receipt, frozen, epoch, abort)
    else {
      const fresh = await request(frozen.path, {
        method: 'GET',
        query: { limit: 20 },
        cache: 'no-store',
        retry: 0,
        signal: abort.signal
      })
      if (!current(epoch) || intent.value !== frozen) return
      const state = parseState(fresh, frozen.orderId)
      if (state.version < frozen.body.expectedVersion) throw new Error('unconfirmed_annotation_version')
      if (state.version === frozen.body.expectedVersion) {
        checked.value = true
        status.value = 'unknown'
      } else {
        // Versions and receipts are append-only and committed atomically. A
        // higher current version makes this old CAS impossible, but recheck its
        // receipt AFTER that read to catch an original commit between reads.
        const second = await request(`${frozen.path}/commands/${frozen.key}`, {
          method: 'GET',
          cache: 'no-store',
          retry: 0,
          signal: abort.signal
        })
        if (!current(epoch) || intent.value !== frozen) return
        const command = orderAnnotationCommandSchema.parse(second)
        if (command.orderId !== frozen.orderId || command.commandId !== frozen.key)
          throw new Error('unconfirmed_annotation_command')
        if (command.outcome === 'applied') await accept(command.receipt, frozen, epoch, abort)
        else {
          adopt(state)
          note.value = frozen.body.note ?? ''
          receipt.value = null
          intent.value = null
          checked.value = false
          status.value = 'conflict'
          setCommandPending(false)
        }
      }
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
  [() => props.orderId, () => props.scopeKey, () => props.enabled, () => props.pending],
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
    :aria-busy="!!busy"
    class="min-w-0 max-w-full space-y-3 break-words [overflow-wrap:anywhere]"
  >
    <div class="flex flex-wrap items-center justify-between gap-2">
      <h2 :id="prefix + '-title'" class="adm-card__title">Notas internas y etiquetas</h2>
      <button
        data-annotations-refresh
        type="button"
        :disabled="!!busy || !!intent"
        class="adm-btn adm-btn--ghost adm-btn--sm"
        @click="load()"
      >
        <UIcon name="i-lucide-rotate-cw" class="size-4" :class="busy === 'read' && 'animate-spin'" />Actualizar
      </button>
    </div>
    <p class="adm-help">Solo las ve el equipo, nunca el cliente.</p>
    <p v-if="busy === 'read'" data-annotations-loading role="status" class="adm-help">Cargando notas y etiquetas…</p>
    <div v-if="status === 'error'" data-annotations-error role="alert">
      <UAlert
        color="error"
        variant="subtle"
        icon="i-lucide-triangle-alert"
        title="No se han podido cargar las notas"
        description="Pulsa «Actualizar» antes de guardar nada."
      />
    </div>
    <template v-if="snapshot">
      <ul v-if="snapshot.labels.length" aria-label="Etiquetas internas" class="flex flex-wrap gap-2">
        <li v-for="label in snapshot.labels" :key="label" class="adm-chip max-w-full break-words">
          {{ label }}
        </li>
      </ul>
      <p v-if="!snapshot.notes.length" data-annotations-empty role="status" class="adm-help">
        Todavía no hay notas en este pedido.
      </p>
      <ol aria-label="Historial de notas internas" class="space-y-2">
        <li
          v-for="item in snapshot.notes"
          :key="item.id"
          class="min-w-0 rounded-[var(--radius-control)] bg-[var(--surface-sunken)] p-3"
        >
          <p class="whitespace-pre-wrap break-words text-[var(--text-strong)]">{{ item.text }}</p>
          <p class="mt-1 text-xs text-[var(--text-muted)]" :title="'Autor ' + item.authorId">
            <time :datetime="item.createdAt">{{ adminDate(item.createdAt, true) }}</time>
            <span class="sr-only"> · Autor {{ item.authorId }}</span>
          </p>
        </li>
      </ol>
      <button
        v-if="snapshot.nextCursor"
        data-annotations-more
        type="button"
        :disabled="!!busy || !!intent || status === 'error'"
        class="adm-btn adm-btn--secondary adm-btn--sm"
        @click="load(true)"
      >
        {{ busy === 'more' ? 'Cargando notas anteriores…' : 'Ver notas anteriores' }}
      </button>
      <form class="min-w-0 space-y-3 border-t border-[var(--border)] pt-3" @submit.prevent="submit">
        <div class="adm-field">
          <label :for="prefix + '-note'" class="adm-label">Nueva nota</label
          ><textarea
            :id="prefix + '-note'"
            v-model="note"
            data-annotations-note
            :disabled="!!busy || !!intent || status === 'error'"
            rows="3"
            maxlength="2000"
            class="adm-input w-full min-w-0"
          />
          <p class="adm-help">Hasta 2000 caracteres. Las notas guardadas no se pueden editar ni borrar.</p>
        </div>
        <div class="adm-field">
          <label :for="prefix + '-labels'" class="adm-label">Etiquetas</label
          ><textarea
            :id="prefix + '-labels'"
            v-model="labels"
            data-annotations-labels
            :disabled="!!busy || !!intent || status === 'error'"
            rows="2"
            class="adm-input w-full min-w-0"
          />
          <p class="adm-help">Una por línea, hasta 8. Déjalo vacío para quitar todas las etiquetas.</p>
        </div>
        <div class="flex justify-end">
          <button data-annotations-submit type="submit" :disabled="!canSubmit" class="adm-btn adm-btn--secondary">
            Guardar
          </button>
        </div>
      </form>
    </template>
    <div v-if="status === 'unknown'" data-annotations-unknown role="alert" class="space-y-2">
      <UAlert
        color="warning"
        variant="subtle"
        icon="i-lucide-hourglass"
        title="Todavía no sabemos si se ha guardado"
        :description="
          checked
            ? 'Sigue sin aparecer. Puedes volver a enviar exactamente los mismos cambios.'
            : 'No cierres ni recargues esta página: comprueba primero el resultado.'
        "
      />
      <div class="flex flex-wrap gap-2">
        <button
          data-annotations-check
          type="button"
          :disabled="!!busy"
          class="adm-btn adm-btn--secondary adm-btn--sm"
          @click="check"
        >
          Comprobar si se guardó</button
        ><button
          data-annotations-replay
          type="button"
          :disabled="!!busy || !checked"
          class="adm-btn adm-btn--secondary adm-btn--sm"
          @click="replay"
        >
          Volver a enviar
        </button>
      </div>
    </div>
    <div v-if="status === 'confirmed' && receipt" data-annotations-confirmed role="status">
      <UAlert color="success" variant="subtle" icon="i-lucide-circle-check" title="Cambios guardados" />
    </div>
    <div v-if="status === 'conflict'" data-annotations-conflict role="alert">
      <UAlert
        color="warning"
        variant="subtle"
        icon="i-lucide-triangle-alert"
        title="Alguien ha cambiado las notas o etiquetas mientras tanto"
        description="No se ha guardado nada. Revisa las etiquetas actuales y tu nota antes de guardar de nuevo."
      />
    </div>
  </section>
</template>

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
    <h2 :id="prefix + '-title'" class="font-semibold">Notas internas y etiquetas</h2>
    <p class="text-sm">
      Información privada de administración. Las notas se añaden al historial; las etiquetas sustituyen el conjunto
      actual. No introduzcas datos sensibles innecesarios.
    </p>
    <p v-if="busy === 'read'" data-annotations-loading role="status">Confirmando notas y etiquetas…</p>
    <p v-if="status === 'error'" data-annotations-error role="alert">
      No se ha podido confirmar la lectura. No se interpreta como un historial vacío. Actualiza la primera página antes
      de guardar.
    </p>
    <button
      data-annotations-refresh
      type="button"
      :disabled="!!busy || !!intent"
      class="max-w-full whitespace-normal rounded border px-3 py-2"
      @click="load()"
    >
      Actualizar notas y etiquetas
    </button>
    <template v-if="snapshot">
      <p class="text-sm">Última versión confirmada: {{ snapshot.version }}. Autor identificado por su ID interno.</p>
      <ul aria-label="Etiquetas internas" class="flex flex-wrap gap-2">
        <li
          v-for="label in snapshot.labels"
          :key="label"
          class="max-w-full break-words rounded bg-slate-100 px-2 py-1 text-sm"
        >
          {{ label }}
        </li>
      </ul>
      <p v-if="!snapshot.notes.length" data-annotations-empty role="status">
        No hay notas internas en este historial confirmado.
      </p>
      <ol aria-label="Historial de notas internas" class="space-y-3">
        <li v-for="item in snapshot.notes" :key="item.id" class="min-w-0 rounded border p-3">
          <p class="break-all text-xs">
            Autor {{ item.authorId }} ·
            <time :datetime="item.createdAt">{{ new Date(item.createdAt).toLocaleString('es-ES') }}</time>
          </p>
          <p class="whitespace-pre-wrap break-words">{{ item.text }}</p>
        </li>
      </ol>
      <button
        v-if="snapshot.nextCursor"
        data-annotations-more
        type="button"
        :disabled="!!busy || !!intent || status === 'error'"
        class="max-w-full whitespace-normal rounded border px-3 py-2"
        @click="load(true)"
      >
        {{ busy === 'more' ? 'Cargando notas anteriores…' : 'Cargar más notas' }}
      </button>
      <form class="min-w-0 space-y-3" @submit.prevent="submit">
        <div>
          <label :for="prefix + '-note'" class="block font-medium">Nueva nota interna (máximo 2000 caracteres)</label
          ><textarea
            :id="prefix + '-note'"
            v-model="note"
            data-annotations-note
            :disabled="!!busy || !!intent || status === 'error'"
            rows="4"
            maxlength="2000"
            class="w-full min-w-0 rounded border p-2"
          />
          <p class="text-xs">Texto plano; no se modifica ni elimina ninguna nota anterior.</p>
        </div>
        <div>
          <label :for="prefix + '-labels'" class="block font-medium"
            >Etiquetas (una por línea, hasta 8 de 40 caracteres)</label
          ><textarea
            :id="prefix + '-labels'"
            v-model="labels"
            data-annotations-labels
            :disabled="!!busy || !!intent || status === 'error'"
            rows="3"
            class="w-full min-w-0 rounded border p-2"
          />
          <p class="text-xs">
            Deja este campo vacío para retirar todas las etiquetas. Los cambios sólo se guardan al confirmar este botón.
          </p>
        </div>
        <button
          data-annotations-submit
          type="submit"
          :disabled="!canSubmit"
          class="max-w-full whitespace-normal rounded border px-3 py-2"
        >
          Guardar nota y cambios de etiquetas
        </button>
      </form>
    </template>
    <div v-if="status === 'unknown'" data-annotations-unknown role="alert" class="space-y-2 rounded border p-3">
      <p>
        Resultado no confirmado: no se sabe si los cambios se guardaron. La intención original se conserva sólo en esta
        pestaña. No cierres ni recargues mientras compruebas el resultado.
      </p>
      <div class="flex flex-wrap gap-2">
        <button
          data-annotations-check
          type="button"
          :disabled="!!busy"
          class="max-w-full whitespace-normal rounded border px-3 py-2"
          @click="check"
        >
          Comprobar cambios guardados</button
        ><button
          data-annotations-replay
          type="button"
          :disabled="!!busy || !checked"
          class="max-w-full whitespace-normal rounded border px-3 py-2"
          @click="replay"
        >
          Reintentar los mismos cambios
        </button>
      </div>
      <p v-if="checked" class="text-sm">
        La consulta todavía no confirma un efecto. Un reintento explícito reutiliza exactamente la clave y el contenido
        originales.
      </p>
    </div>
    <p v-if="status === 'confirmed' && receipt" data-annotations-confirmed role="status">
      Cambios guardados confirmados. Versión de la operación: {{ receipt.version }}.
    </p>
    <p v-if="status === 'conflict'" data-annotations-conflict role="alert">
      La versión cambió y las dos comprobaciones no encontraron un recibo de la intención original. Revisa las etiquetas
      actuales y la nota conservada antes de guardar de nuevo. No se ha reenviado ningún cambio automáticamente.
    </p>
  </section>
</template>

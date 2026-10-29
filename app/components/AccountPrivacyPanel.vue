<script setup lang="ts">
import {
  accountPrivacyResponseSchema,
  accountPrivacyRequestSchema,
  accountPrivacyCommandSchema,
  type AccountPrivacyRequest
} from '~~/shared/account-privacy'
const props = defineProps<{ scopeKey: string; enabled: boolean; pending: boolean }>()
const emit = defineEmits<{ pending: [boolean]; confirmed: [AccountPrivacyRequest] }>()
const request = useRequestFetch(),
  id = useId(),
  allowed = computed(() => props.enabled && !props.pending && !!props.scopeKey && !denied.value)
const denied = ref(false),
  rows = shallowRef<AccountPrivacyRequest[]>([]),
  type = ref<'export' | 'anonymize'>('export'),
  checked = ref(false),
  busy = ref(false),
  status = ref<'idle' | 'loading' | 'ready' | 'error' | 'unknown' | 'confirmed'>('idle')
type Intent = Readonly<{ requestType: 'export' | 'anonymize'; idempotencyKey: string }>
const intent = shallowRef<Intent | null>(null),
  ack = shallowRef<AccountPrivacyRequest | null>(null)
let alive = true,
  epoch = 0,
  controller: AbortController | null = null,
  commandPending = false
const base = '/api/account/privacy'
function setPending(value: boolean) {
  if (commandPending !== value) {
    commandPending = value
    emit('pending', value)
  }
}
function purge() {
  epoch++
  controller?.abort()
  controller = null
  rows.value = []
  intent.value = null
  ack.value = null
  checked.value = false
  type.value = 'export'
  busy.value = false
  status.value = 'idle'
  setPending(false)
}
function current(generation: number) {
  return alive && allowed.value && generation === epoch
}
function catchFailure(cause: unknown, generation: number) {
  if (!current(generation)) return
  const error = cause as { status?: number; statusCode?: number; response?: { status?: number } }
  if ([401, 403].includes(error.status ?? error.statusCode ?? error.response?.status ?? 0)) {
    purge()
    denied.value = true
    return
  }
  status.value = intent.value ? 'unknown' : 'error'
}
function options(abort: AbortController) {
  return { method: 'GET' as const, cache: 'no-store' as const, retry: 0, signal: abort.signal }
}
function parse(raw: unknown) {
  const result = accountPrivacyResponseSchema.parse(raw)
  if (
    new Set(result.requests.map((r) => r.id)).size !== result.requests.length ||
    new Set(result.requests.map((r) => r.commandId)).size !== result.requests.length
  )
    throw new Error('invalid_snapshot')
  return result.requests
}
async function load() {
  if (!alive || !allowed.value || busy.value || intent.value) return
  const generation = epoch,
    abort = new AbortController()
  controller = abort
  busy.value = true
  status.value = 'loading'
  rows.value = []
  try {
    const raw = await request(base, options(abort))
    if (current(generation)) {
      rows.value = parse(raw)
      status.value = 'ready'
    }
  } catch (error) {
    catchFailure(error, generation)
  } finally {
    if (current(generation)) {
      busy.value = false
      controller = null
    }
  }
}
async function confirm(raw: unknown, frozen: Intent, generation: number, abort: AbortController) {
  const receipt = accountPrivacyRequestSchema.parse(raw)
  if (receipt.commandId !== frozen.idempotencyKey || receipt.requestType !== frozen.requestType)
    throw new Error('invalid_receipt')
  ack.value = receipt
  const fresh = await request(base, options(abort))
  if (!current(generation) || intent.value !== frozen) return
  const state = parse(fresh),
    found = state.find((r) => r.id === receipt.id)
  if (!found || JSON.stringify(found) !== JSON.stringify(receipt)) throw new Error('unconfirmed_snapshot')
  rows.value = state
  intent.value = null
  ack.value = null
  checked.value = false
  status.value = 'confirmed'
  setPending(false)
  emit('confirmed', receipt)
}
async function send(frozen: Intent) {
  if (!alive || !allowed.value || busy.value || intent.value !== frozen || ack.value) return
  const generation = epoch,
    abort = new AbortController()
  controller = abort
  busy.value = true
  setPending(true)
  try {
    const raw = await request(base, {
      method: 'POST',
      body: frozen,
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': frozen.idempotencyKey },
      retry: 0,
      signal: abort.signal
    })
    if (current(generation) && intent.value === frozen) await confirm(raw, frozen, generation, abort)
  } catch (error) {
    catchFailure(error, generation)
  } finally {
    if (current(generation)) {
      busy.value = false
      controller = null
    }
  }
}
function submit() {
  if (
    !allowed.value ||
    busy.value ||
    intent.value ||
    !checked.value ||
    status.value !== 'ready' ||
    !['export', 'anonymize'].includes(type.value)
  )
    return
  const frozen = Object.freeze({ requestType: type.value, idempotencyKey: crypto.randomUUID() })
  intent.value = frozen
  checked.value = false
  void send(frozen)
}
async function recover() {
  const frozen = intent.value
  if (!alive || !allowed.value || busy.value || !frozen) return
  const generation = epoch,
    abort = new AbortController()
  controller = abort
  busy.value = true
  try {
    const raw = await request(`${base}/commands/${encodeURIComponent(frozen.idempotencyKey)}`, options(abort))
    if (!current(generation) || intent.value !== frozen) return
    const result = accountPrivacyCommandSchema.parse(raw)
    if (result.commandId !== frozen.idempotencyKey) throw new Error('invalid_receipt')
    if (result.outcome === 'unknown') {
      status.value = 'unknown'
      return
    }
    await confirm(result.receipt, frozen, generation, abort)
  } catch (error) {
    catchFailure(error, generation)
  } finally {
    if (current(generation)) {
      busy.value = false
      controller = null
    }
  }
}
let started = false
watch(
  () => [props.scopeKey, props.enabled, props.pending] as const,
  () => {
    purge()
    denied.value = false
    if (!started && allowed.value) {
      started = true
      void load()
    }
  },
  { immediate: true, flush: 'sync' }
)
onBeforeUnmount(() => {
  alive = false
  purge()
})
</script>
<template>
  <section v-if="allowed" class="min-w-0 space-y-4" aria-label="Privacidad de cuenta">
    <h2 class="font-semibold">Privacidad de cuenta</h2>
    <p>
      La solicitud de anonimización no borra datos automáticamente ni resuelve las obligaciones de conservación
      contractuales o fiscales. El plazo de 30 días es operativo, no una acreditación de cumplimiento legal.
    </p>
    <p>
      El archivo contiene perfil, direcciones, resumen de pedidos propios, consentimientos y preferencias de newsletter,
      y favoritos. No es una copia íntegra de todos los expedientes; no incluye notas internas ni datos de otras
      personas. Si supera los límites, la descarga falla sin truncarlo.
    </p>
    <p v-if="status === 'loading'" role="status">Cargando solicitudes…</p>
    <p v-if="status === 'error'" role="alert">No se han podido consultar las solicitudes.</p>
    <p v-if="status === 'unknown'" role="alert">
      No se ha podido confirmar la solicitud. Puede haber quedado registrada. Comprueba el recibo antes de volver a
      enviarla.
    </p>
    <p v-if="status === 'confirmed'" role="status">
      Solicitud confirmada. La anonimización, si se ha solicitado, sigue pendiente de revisión; no se ha ejecutado
      ningún borrado.
    </p>
    <button v-if="!intent" type="button" :disabled="busy" @click="load">Actualizar solicitudes</button>
    <template v-else>
      <button data-privacy-recover type="button" :disabled="busy" @click="recover">Comprobar solicitud</button>
      <button v-if="!ack" data-privacy-retry type="button" :disabled="busy" @click="send(intent)">
        Reintentar exactamente la misma solicitud
      </button>
      <p>
        La intención pendiente sólo se conserva en esta pestaña; no cierres ni abandones la página hasta aclarar el
        resultado.
      </p>
    </template>
    <form class="space-y-3" @submit.prevent="submit">
      <label :for="`${id}-type`">Tipo de solicitud</label>
      <select :id="`${id}-type`" v-model="type" :disabled="busy || !!intent">
        <option value="export">Exportar mis datos</option>
        <option value="anonymize">Solicitar anonimización</option>
      </select>
      <label class="flex items-start gap-2"
        ><input v-model="checked" type="checkbox" :disabled="busy || !!intent" />Confirmo que quiero registrar esta
        solicitud.</label
      >
      <button type="submit" :disabled="!checked || busy || !!intent || status !== 'ready'">Registrar solicitud</button>
    </form>
    <p v-if="status === 'ready' && !rows.length">No hay solicitudes registradas.</p>
    <ul class="space-y-3">
      <li v-for="row in rows" :key="row.id" class="min-w-0 break-words">
        <span>{{
          row.requestType === 'export' ? 'Exportación disponible' : 'Anonimización solicitada, pendiente de revisión'
        }}</span>
        <time :datetime="row.requestedAt">{{ row.requestedAt }}</time>
        <span>Vencimiento operativo: {{ row.dueAt }}</span>
        <a
          v-if="row.requestType === 'export' && row.status === 'completed'"
          :href="`${base}/${row.id}/download`"
          download
          rel="nofollow"
          >Descargar JSON de mis datos</a
        >
      </li>
    </ul>
  </section>
</template>

<script setup lang="ts">
import { catalogImportJobSchema, type CatalogImportJob } from '~~/shared/catalog-import-job'
import {
  catalogImportJobCommandInputSchema,
  catalogImportJobReceiptSchema,
  type CatalogImportJobReceipt
} from '~~/shared/catalog-import-job-commands'
import { catalogPolicyOwnJson, catalogPolicyUuidSchema } from '~~/shared/catalog-publication-policy'

const props = withDefaults(defineProps<{ runtime: unknown; available?: boolean; job: unknown }>(), { available: false })
const emit = defineEmits<{ updated: [job: CatalogImportJob]; completed: [receipt: CatalogImportJobReceipt] }>()
const { ready, loggedIn, user } = useUserSession()
const request = useRequestFetch(),
  prefix = useId()
const busy = ref(false),
  feedback = ref(''),
  reason = ref(''),
  confirmed = ref(false)
const server = shallowRef<CatalogImportJob | null>(null),
  binding = shallowRef<CatalogImportJob | null>(null)
type Action = 'apply' | 'revert'
type Intent = Readonly<{ action: Action; owner: string; job: CatalogImportJob; key: string; body: string }>
const intent = shallowRef<Intent | null>(null)
let epoch = 0,
  disposed = false
const actor = computed(() => {
  const value: unknown = user.value
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const field = (key: string) =>
    Reflect.has(value, key) ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined
  if (field('role') !== 'admin' || field('emailVerified') !== true || field('mfaVerified') !== true) return null
  const id = catalogPolicyUuidSchema.safeParse(field('id'))
  return id.success ? id.data : null
})
function parseJob(value: unknown) {
  const parsed = catalogImportJobSchema.safeParse(value)
  return parsed.success && parsed.data.status !== 'uploading' && parsed.data.hash !== null ? parsed.data : null
}
const supplied = computed(() => {
  const value = props.job
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of [
      'source',
      'outcome',
      'id',
      'hash',
      'status',
      'createdAt',
      'expiresAt',
      'totalPages',
      'receivedPages',
      'recordCount',
      'counts',
      'policy'
    ])
      Reflect.has(value, key)
    for (const field of ['counts', 'policy']) {
      const nested: unknown = Object.getOwnPropertyDescriptor(value, field)?.value
      if (!nested || typeof nested !== 'object' || Array.isArray(nested)) continue
      try {
        catalogPolicyOwnJson(nested)
      } catch {
        continue
      }
      // Track raw nested descriptors via a proxy only after proving own JSON;
      // never execute a getter merely to obtain a reactive dependency.
      const tracked = reactive(nested)
      Reflect.ownKeys(tracked)
      for (const key of field === 'counts'
        ? ['products', 'variants', 'assets', 'mappings']
        : ['publication', 'media', 'priceStock'])
        Reflect.has(tracked, key)
    }
  }
  return parseJob(value)
})
function identityKey(value: CatalogImportJob | null) {
  if (!value) return null
  const { status: _status, ...immutable } = value
  return JSON.stringify(immutable)
}
const suppliedKey = computed(() => identityKey(supplied.value))
const enabled = computed(
  () =>
    !disposed &&
    props.runtime === 'cloudflare' &&
    props.available === true &&
    ready.value === true &&
    loggedIn.value === true &&
    actor.value !== null &&
    supplied.value !== null
)
function clear() {
  epoch++
  intent.value = null
  busy.value = false
  feedback.value = reason.value = ''
  confirmed.value = false
  server.value = binding.value = enabled.value ? supplied.value : null
}
watch([enabled, actor, () => props.runtime, () => props.available, suppliedKey], clear, {
  flush: 'sync',
  immediate: true
})
watch(
  () => supplied.value?.status,
  () => {
    if (!enabled.value || !supplied.value || !binding.value || identityKey(binding.value) !== suppliedKey.value) return
    const order = { ready: 0, applied: 1, reverted: 2, uploading: -1 }
    if (order[supplied.value.status] < order[binding.value.status]) {
      server.value = null
      if (!intent.value) {
        reason.value = ''
        confirmed.value = false
      }
      return
    }
    server.value = binding.value = supplied.value
    if (!intent.value && !busy.value) {
      reason.value = ''
      confirmed.value = false
    }
  },
  { flush: 'sync' }
)
onBeforeUnmount(() => {
  disposed = true
  clear()
})
function current(version: number, owner: string | null, original: CatalogImportJob) {
  return (
    enabled.value &&
    !disposed &&
    epoch === version &&
    owner !== null &&
    actor.value === owner &&
    identityKey(parseJob(props.job)) === identityKey(original)
  )
}
function canSubmit(action: Action) {
  const value = server.value
  return (
    enabled.value &&
    !busy.value &&
    !intent.value &&
    confirmed.value &&
    value !== null &&
    identityKey(parseJob(props.job)) === identityKey(value) &&
    (action === 'apply'
      ? value.status === 'ready' && Date.parse(value.expiresAt) > Date.now()
      : value.status === 'applied') &&
    catalogImportJobCommandInputSchema.safeParse({ previewHash: value.hash, reason: reason.value }).success
  )
}
async function submit(action: Action) {
  if (!canSubmit(action) || !server.value || !actor.value) return
  try {
    const value = catalogImportJobSchema.parse(server.value)
    const body = catalogImportJobCommandInputSchema.parse({ previewHash: value.hash, reason: reason.value })
    Object.freeze(value.counts)
    Object.freeze(value.policy)
    Object.freeze(value)
    intent.value = Object.freeze({
      action,
      owner: actor.value,
      job: value,
      key: crypto.randomUUID(),
      body: JSON.stringify(body)
    })
  } catch {
    feedback.value = 'No se ha podido preparar un intento seguro. No se ha enviado la operación.'
    return
  }
  await dispatch()
}
async function dispatch() {
  const command = intent.value
  if (!command || busy.value || !current(epoch, command.owner, command.job)) return
  const version = epoch
  busy.value = true
  try {
    const raw: unknown = await request(`/api/admin/catalog/import-jobs/${command.job.id}/${command.action}`, {
      method: 'POST',
      body: command.body,
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': command.key },
      retry: 0,
      credentials: 'same-origin',
      referrerPolicy: 'no-referrer'
    })
    if (!current(version, command.owner, command.job)) return
    const receipt = catalogImportJobReceiptSchema.parse(raw)
    if (
      receipt.action !== command.action ||
      receipt.jobId !== command.job.id ||
      receipt.jobHash !== command.job.hash ||
      JSON.stringify(receipt.counts) !== JSON.stringify(command.job.counts)
    )
      throw new Error('receipt_binding')
    intent.value = null
    server.value = null // A durable receipt is not a live-state/permission cache.
    reason.value = ''
    confirmed.value = false
    feedback.value =
      command.action === 'apply'
        ? 'Recibo validado: trabajo aplicado como nuevos borradores, sin publicación. Consulta el estado para continuar.'
        : 'Recibo validado: reversión compensatoria aplicada; se conservan auditoría e historial.'
    emit('completed', receipt)
  } catch {
    if (current(version, command.owner, command.job)) {
      server.value = null
      feedback.value =
        'Resultado no confirmado. Consulta el estado o reintenta explícitamente el mismo intento; se conserva su clave y contenido.'
    }
  } finally {
    if (current(version, command.owner, command.job)) busy.value = false
  }
}
async function refresh() {
  const original = binding.value,
    owner = actor.value,
    version = epoch
  if (!original || busy.value || !current(version, owner, original)) return
  busy.value = true
  server.value = null
  try {
    const raw: unknown = await request(`/api/admin/catalog/import-jobs/${original.id}`, {
      method: 'GET',
      retry: 0,
      cache: 'no-store',
      credentials: 'same-origin',
      referrerPolicy: 'no-referrer'
    })
    if (!current(version, owner, original)) return
    const value = parseJob(raw)
    const order = { ready: 0, applied: 1, reverted: 2, uploading: -1 }
    if (!value || identityKey(value) !== identityKey(original) || order[value.status] < order[original.status])
      throw new Error('job_binding')
    server.value = binding.value = value
    feedback.value = 'Estado consultado sin repetir escrituras. El estado no sustituye al recibo de la operación.'
    emit('updated', value)
  } catch {
    if (current(version, owner, original))
      feedback.value = 'No se ha confirmado el estado. Puedes repetir únicamente la consulta.'
  } finally {
    if (current(version, owner, original)) busy.value = false
  }
}
</script>

<template>
  <section
    v-if="enabled"
    class="mt-4 rounded-xl border border-[var(--border)] p-4"
    :aria-busy="busy"
    :aria-labelledby="`${prefix}-title`"
  >
    <h3 :id="`${prefix}-title`" class="font-semibold">Aplicar o revertir el trabajo revisado</h3>
    <p class="mt-2 text-sm">
      Aplicar crea nuevos productos y variantes en borradores e inicializa precios y stock sólo con autorización
      explícita vigente. Los medios siguen pendientes de verificación; no publica productos.
    </p>
    <p class="mt-2 text-sm">
      La reversión sólo admite un lote sin cambios ni uso posterior; compensa stock y precios y conserva auditoría e
      historial. La vista previa paginada no aplica nada automáticamente.
    </p>
    <p v-if="server" data-command-summary class="mt-2 text-sm">
      Estado confirmado: {{ server.status }} · {{ server.counts.products }} productos ·
      {{ server.counts.variants }} variantes · {{ server.counts.assets }} archivos ·
      {{ server.counts.mappings }} relaciones. Política: {{ server.policy.publication }} · {{ server.policy.media }} ·
      {{ server.policy.priceStock }}.
    </p>
    <label :for="`${prefix}-reason`" class="mt-3 block">Motivo de la operación (3–500 caracteres)</label>
    <textarea
      :id="`${prefix}-reason`"
      v-model="reason"
      data-command-reason
      maxlength="500"
      :disabled="busy || !!intent"
    />
    <label class="block"
      ><input v-model="confirmed" data-command-confirm type="checkbox" :disabled="busy || !!intent" /> Confirmo la
      aplicación autorizada del trabajo como borradores o su reversión compensatoria, sin publicación.</label
    >
    <button type="button" data-command-apply :disabled="!canSubmit('apply')" @click="submit('apply')">
      Aplicar trabajo
    </button>
    <button type="button" data-command-revert :disabled="!canSubmit('revert')" @click="submit('revert')">
      Revertir trabajo
    </button>
    <button type="button" data-command-refresh :disabled="busy" @click="refresh">Consultar estado sin escribir</button>
    <button v-if="intent" type="button" data-command-retry :disabled="busy" @click="dispatch">
      Reintentar el mismo intento
    </button>
    <p v-if="busy" role="status" aria-live="polite">Procesando la solicitud explícita…</p>
    <p v-if="feedback" role="status" aria-live="polite" class="mt-2 text-sm">{{ feedback }}</p>
  </section>
</template>

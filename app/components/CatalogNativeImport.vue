<script setup lang="ts">
import {
  nativeImportPreviewSchema,
  nativeImportInvalidSchema,
  nativeImportReceiptSchema,
  nativeImportCommandInputSchema,
  nativeImportInputSchema,
  CATALOG_NATIVE_IMPORT_MAX_ROWS,
  CATALOG_NATIVE_IMPORT_MAX_BYTES,
  type NativeImportPreview,
  type NativeImportReceipt
} from '~~/shared/catalog-native-import'
import {
  CATALOG_TABULAR_MAX_BYTES,
  type CatalogTabularRecord,
  type CatalogTabularIssue
} from '~~/shared/catalog-tabular-core'
import { catalogPolicyUuidSchema } from '~~/shared/catalog-publication-policy'

const props = withDefaults(defineProps<{ runtime: unknown; available?: boolean }>(), { available: false })
const emit = defineEmits<{ changed: [receipt: NativeImportReceipt] }>()
const { ready, loggedIn, user } = useUserSession()
const request = useRequestFetch(),
  prefix = useId(),
  root = '/api/admin/catalog/native-import'
const input = ref<HTMLInputElement | null>(null),
  busy = ref(false),
  feedback = ref(''),
  reason = ref(''),
  confirmed = ref(false)
const records = shallowRef<CatalogTabularRecord[] | null>(null),
  issues = shallowRef<CatalogTabularIssue[]>([])
const preview = shallowRef<NativeImportPreview | null>(null),
  binding = shallowRef<NativeImportPreview | null>(null)
type Action = 'apply' | 'revert'
type Intent = Readonly<{
  action: Action
  id: string
  hash: string
  key: string
  body: string
  counts: NativeImportPreview['counts']
}>
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
const enabled = computed(
  () =>
    !disposed &&
    props.runtime === 'cloudflare' &&
    props.available === true &&
    ready.value === true &&
    loggedIn.value === true &&
    actor.value !== null
)
function clear() {
  epoch++
  records.value = null
  issues.value = []
  preview.value = binding.value = null
  intent.value = null
  busy.value = false
  feedback.value = reason.value = ''
  confirmed.value = false
  if (input.value) input.value.value = ''
}
watch([enabled, actor, () => props.runtime, () => props.available], clear, { flush: 'sync' })
onBeforeUnmount(() => {
  disposed = true
  clear()
})
function current(version: number, identity: string | null) {
  return enabled.value && epoch === version && actor.value === identity
}
async function selected(event: Event) {
  const file = event.target instanceof HTMLInputElement ? event.target.files?.[0] : undefined
  clear()
  if (!enabled.value || !(file instanceof File)) return
  const format = /^.+\.csv$/i.test(file.name) ? 'csv' : /^.+\.xlsx$/i.test(file.name) ? 'xlsx' : null
  if (!format || file.size < 1 || file.size > CATALOG_TABULAR_MAX_BYTES) {
    feedback.value = 'Selecciona un CSV o XLSX de 71 columnas, con datos y hasta 20 MB.'
    return
  }
  const version = epoch,
    identity = actor.value
  busy.value = true
  try {
    const bytes = new Uint8Array(await file.arrayBuffer())
    if (!current(version, identity)) return
    if (!bytes.length || bytes.length > CATALOG_TABULAR_MAX_BYTES) throw new Error('file_size')
    if (!import.meta.client) return
    const { decodeCatalogImportFile } = await import('~/utils/catalog-import-file.client')
    if (!current(version, identity)) return
    const result = await decodeCatalogImportFile(bytes, format)
    if (!current(version, identity)) return
    issues.value = result.validation.issues
    if (!result.validation.valid) {
      feedback.value = 'Corrige las incidencias antes de solicitar la vista previa.'
      return
    }
    if (
      !result.records.length ||
      result.records.length > CATALOG_NATIVE_IMPORT_MAX_ROWS ||
      new TextEncoder().encode(JSON.stringify({ records: result.records })).length > CATALOG_NATIVE_IMPORT_MAX_BYTES
    ) {
      feedback.value =
        'La aplicación admite como máximo 500 registros y 900.000 bytes JSON por lote. Divide el archivo en lotes más pequeños.'
      return
    }
    records.value = nativeImportInputSchema.parse({ records: result.records }).records
    feedback.value = 'Estructura local válida. El archivo no se ha enviado al servidor.'
  } catch {
    if (current(version, identity))
      feedback.value = 'No se ha podido validar el archivo. Revisa el formato y selecciónalo de nuevo.'
  } finally {
    if (current(version, identity)) busy.value = false
  }
}
async function createPreview() {
  if (!enabled.value || busy.value || intent.value || !records.value) return
  const version = epoch,
    identity = actor.value,
    body = JSON.stringify({ records: records.value })
  busy.value = true
  preview.value = binding.value = null
  reason.value = ''
  confirmed.value = false
  issues.value = []
  try {
    const raw: unknown = await request(`${root}/preview`, {
      method: 'POST',
      body,
      headers: { 'Content-Type': 'application/json' },
      retry: 0,
      credentials: 'same-origin',
      referrerPolicy: 'no-referrer'
    })
    if (!current(version, identity)) return
    const invalid = nativeImportInvalidSchema.safeParse(raw)
    if (invalid.success) {
      issues.value = invalid.data.issues as CatalogTabularIssue[]
      feedback.value = 'El servidor ha rechazado el archivo. Corrige las incidencias.'
      return
    }
    const parsed = nativeImportPreviewSchema.parse(raw)
    if (parsed.status !== 'pending') throw new Error('preview_status')
    preview.value = binding.value = parsed
    feedback.value = 'Vista previa del servidor preparada. Todavía no se ha aplicado el lote.'
  } catch {
    if (current(version, identity))
      feedback.value = 'No se ha confirmado la vista previa. No se ha solicitado aplicar el lote.'
  } finally {
    if (current(version, identity)) busy.value = false
  }
}
function sameSnapshot(value: NativeImportPreview, original: NativeImportPreview) {
  return (
    value.id === original.id &&
    value.hash === original.hash &&
    value.createdAt === original.createdAt &&
    value.expiresAt === original.expiresAt &&
    JSON.stringify(value.counts) === JSON.stringify(original.counts) &&
    JSON.stringify(value.policy) === JSON.stringify(original.policy)
  )
}
async function refresh() {
  if (!enabled.value || busy.value || !binding.value) return
  const original = binding.value,
    version = epoch,
    identity = actor.value
  busy.value = true
  preview.value = null
  try {
    const raw: unknown = await request(`${root}/previews/${original.id}`, {
      method: 'GET',
      retry: 0,
      cache: 'no-store',
      credentials: 'same-origin',
      referrerPolicy: 'no-referrer'
    })
    if (!current(version, identity)) return
    const parsed = nativeImportPreviewSchema.parse(raw)
    if (!sameSnapshot(parsed, original)) throw new Error('snapshot')
    preview.value = parsed
    feedback.value = 'Estado consultado sin repetir escrituras. Un estado no sustituye al recibo de la operación.'
  } catch {
    if (current(version, identity))
      feedback.value = 'No se ha confirmado el estado. Puedes repetir únicamente la consulta.'
  } finally {
    if (current(version, identity)) busy.value = false
  }
}
function canSubmit(action: Action) {
  return (
    enabled.value &&
    !busy.value &&
    !intent.value &&
    confirmed.value &&
    preview.value?.status === (action === 'apply' ? 'pending' : 'applied') &&
    nativeImportCommandInputSchema.safeParse({ previewHash: preview.value.hash, reason: reason.value }).success
  )
}
async function submit(action: Action) {
  if (!canSubmit(action) || !preview.value) return
  try {
    const value = preview.value
    const body = nativeImportCommandInputSchema.parse({ previewHash: value.hash, reason: reason.value })
    intent.value = Object.freeze({
      action,
      id: value.id,
      hash: value.hash,
      key: crypto.randomUUID(),
      body: JSON.stringify(body),
      counts: value.counts
    })
  } catch {
    feedback.value = 'No se ha podido preparar una clave segura. No se ha enviado la operación.'
    return
  }
  await dispatch()
}
async function dispatch() {
  if (!enabled.value || busy.value || !intent.value) return
  const command = intent.value,
    version = epoch,
    identity = actor.value
  busy.value = true
  try {
    const raw: unknown = await request(`${root}/previews/${command.id}/${command.action}`, {
      method: 'POST',
      body: command.body,
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': command.key },
      retry: 0,
      credentials: 'same-origin',
      referrerPolicy: 'no-referrer'
    })
    if (!current(version, identity)) return
    const receipt = nativeImportReceiptSchema.parse(raw)
    if (
      receipt.action !== command.action ||
      receipt.previewId !== command.id ||
      receipt.previewHash !== command.hash ||
      JSON.stringify(receipt.counts) !== JSON.stringify(command.counts)
    )
      throw new Error('receipt')
    // A receipt confirms the command, not the live state: query again before
    // enabling another command, and never automatically replay any write.
    preview.value = null
    intent.value = null
    reason.value = ''
    confirmed.value = false
    feedback.value =
      command.action === 'apply'
        ? 'Recibo validado: lote aplicado como borradores, sin publicación. Consulta su estado para continuar.'
        : 'Recibo validado: reversión compensatoria aplicada. El historial de auditoría se conserva.'
    emit('changed', receipt)
  } catch {
    if (current(version, identity)) {
      preview.value = null
      feedback.value =
        'Resultado no confirmado. Consulta el estado o reintenta explícitamente el mismo intento; se conserva su clave y contenido.'
    }
  } finally {
    if (current(version, identity)) busy.value = false
  }
}
</script>

<template>
  <section v-if="enabled" class="mb-4 rounded-xl border border-[var(--border)] p-4" :aria-busy="busy">
    <h2 class="text-base font-semibold">Importación nativa completa</h2>
    <p class="mt-2 text-sm">
      CSV o XLSX de 71 columnas: validación local hasta 20 MB. Aplicación limitada a 500 registros y 900.000 bytes JSON
      por lote; divide los archivos mayores.
    </p>
    <p class="mt-2 text-sm">
      Siempre crea productos y variantes nuevos en borrador. Inicializa precios y stock sólo con autorización explícita.
      Las aprobaciones del archivo no autorizan medios ni publicación: los medios quedan pendientes de verificación.
    </p>
    <label :for="`${prefix}-file`" class="mt-3 block">Archivo de catálogo</label>
    <input :id="`${prefix}-file`" ref="input" type="file" accept=".csv,.xlsx" @change="selected" />
    <p v-if="records" class="mt-2 text-sm">{{ records.length }} registros preparados localmente.</p>
    <button type="button" data-native-preview :disabled="busy || !records || !!intent" @click="createPreview">
      Solicitar vista previa al servidor
    </button>
    <button v-if="binding" type="button" data-native-refresh :disabled="busy" @click="refresh">Consultar estado</button>
    <div v-if="preview" class="mt-3 text-sm" data-native-summary>
      <p>
        Estado: {{ preview.status }} · {{ preview.counts.products }} productos · {{ preview.counts.variants }} variantes
        · {{ preview.counts.assets }} archivos · {{ preview.counts.mappings }} relaciones.
      </p>
      <p>
        Política del servidor: {{ preview.policy.publication }} · {{ preview.policy.media }} ·
        {{ preview.policy.priceStock }}.
      </p>
      <p>Caduca: {{ preview.expiresAt }}.</p>
    </div>
    <div v-if="binding" class="mt-3">
      <label :for="`${prefix}-reason`" class="block">Motivo de la operación (3–500 caracteres)</label>
      <textarea
        :id="`${prefix}-reason`"
        v-model="reason"
        data-native-reason
        maxlength="500"
        :disabled="busy || !!intent"
      />
      <label class="block"
        ><input v-model="confirmed" data-native-confirm type="checkbox" :disabled="busy || !!intent" /> Confirmo la
        creación de borradores y la inicialización autorizada de precios y stock, o su reversión compensatoria.</label
      >
      <p class="mt-2 text-sm">
        La reversión sólo admite un lote sin cambios ni uso posterior; compensa stock y precios y conserva auditoría e
        historial.
      </p>
      <button type="button" data-native-apply :disabled="!canSubmit('apply')" @click="submit('apply')">
        Aplicar lote
      </button>
      <button type="button" data-native-revert :disabled="!canSubmit('revert')" @click="submit('revert')">
        Revertir lote
      </button>
    </div>
    <button v-if="intent" type="button" data-native-retry :disabled="busy" @click="dispatch">
      Reintentar el mismo intento
    </button>
    <p v-if="busy" role="status" aria-live="polite">Procesando la solicitud explícita…</p>
    <p v-if="feedback" role="status" aria-live="polite" class="mt-2 text-sm">{{ feedback }}</p>
    <p v-if="issues.length" class="mt-2 text-sm">{{ issues.length }} incidencias; se muestran hasta 100.</p>
    <ul v-if="issues.length" class="mt-2 max-h-64 overflow-auto text-sm">
      <li v-for="(issue, index) in issues.slice(0, 100)" :key="index" data-native-issue>
        <span v-if="issue.row">Fila {{ issue.row }} · </span><span v-if="issue.field">{{ issue.field }}: </span
        >{{ issue.message }}
      </li>
    </ul>
  </section>
</template>

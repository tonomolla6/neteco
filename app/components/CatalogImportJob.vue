<script setup lang="ts">
import CatalogImportJobReview from './CatalogImportJobReview.vue'
import CatalogImportJobCommands from './CatalogImportJobCommands.vue'
import type { CatalogImportJobReceipt } from '~~/shared/catalog-import-job-commands'
import {
  planCatalogImportJob,
  catalogImportJobSchema,
  catalogImportJobCreateInputSchema,
  catalogImportJobFinalizeInputSchema,
  type CatalogImportJob,
  type CatalogImportJobPlan
} from '~~/shared/catalog-import-job'
import { nativeImportInvalidSchema, CATALOG_NATIVE_IMPORT_MAX_BYTES } from '~~/shared/catalog-native-import'
import { CATALOG_TABULAR_MAX_BYTES } from '~~/shared/catalog-tabular-core'
import { catalogPolicyUuidSchema } from '~~/shared/catalog-publication-policy'

const props = withDefaults(defineProps<{ runtime: unknown; available?: boolean; commandsAvailable?: boolean }>(), {
  available: false,
  commandsAvailable: false
})
const emit = defineEmits<{ prepared: [job: CatalogImportJob]; completed: [receipt: CatalogImportJobReceipt] }>()
const { ready, loggedIn, user } = useUserSession()
const request = useRequestFetch(),
  root = '/api/admin/catalog/import-jobs',
  prefix = useId()
const input = ref<HTMLInputElement | null>(null),
  busy = ref(false),
  limitRejected = ref(false),
  feedback = ref(''),
  reason = ref(''),
  confirmed = ref(false)
const plan = shallowRef<CatalogImportJobPlan | null>(null),
  job = shallowRef<CatalogImportJob | null>(null),
  binding = shallowRef<CatalogImportJob | null>(null)
const issues = shallowRef<Array<{ code: string; row?: number; field?: string; message: string }>>([])
const nextPage = ref(0),
  recoveryRequired = ref(false),
  recovered = ref(false)
const pendingCreate = shallowRef<Readonly<{ body: string; key: string }> | null>(null)
const pendingPage = shallowRef<Readonly<{ index: number; body: string }> | null>(null)
const pendingSeal = ref<string | null>(null)
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
const locked = computed(() => busy.value || !!pendingPage.value || pendingSeal.value !== null || recoveryRequired.value)
function clear() {
  epoch++
  plan.value = null
  job.value = binding.value = null
  pendingPage.value = null
  pendingCreate.value = null
  pendingSeal.value = null
  nextPage.value = 0
  busy.value = recoveryRequired.value = recovered.value = confirmed.value = false
  feedback.value = reason.value = ''
  limitRejected.value = false
  issues.value = []
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
const transport = { retry: 0, credentials: 'same-origin' as const, referrerPolicy: 'no-referrer' as const }
function jsonOptions(body: string) {
  return { ...transport, body, headers: { 'Content-Type': 'application/json' } }
}
async function selected(event: Event) {
  const file = event.target instanceof HTMLInputElement ? event.target.files?.[0] : undefined
  clear()
  if (!enabled.value || !(file instanceof File)) return
  const format = /^.+\.csv$/i.test(file.name) ? 'csv' : /^.+\.xlsx$/i.test(file.name) ? 'xlsx' : null
  if (!format || !Number.isSafeInteger(file.size) || file.size < 1 || file.size > CATALOG_TABULAR_MAX_BYTES) {
    limitRejected.value = !!format && Number.isSafeInteger(file.size) && file.size > CATALOG_TABULAR_MAX_BYTES
    feedback.value = limitRejected.value
      ? 'El archivo CSV o XLSX comprimido supera los 20 MB permitidos.'
      : 'Selecciona un CSV o XLSX de 71 columnas, con datos y hasta 20 MB.'
    return
  }
  const version = epoch,
    identity = actor.value
  busy.value = true
  try {
    const bytes = new Uint8Array(await file.arrayBuffer())
    if (!current(version, identity)) return
    if (!bytes.length || bytes.length > CATALOG_TABULAR_MAX_BYTES || !import.meta.client) throw new Error('file')
    const { decodeCatalogImportFile } = await import('~/utils/catalog-import-file.client')
    if (!current(version, identity)) return
    const result = await decodeCatalogImportFile(bytes, format)
    if (!current(version, identity)) return
    issues.value = result.validation.issues
    if (!result.validation.valid) {
      limitRejected.value = result.validation.issues.some((issue) => issue.code === 'catalog_file_too_large')
      feedback.value = 'Corrige las incidencias antes de preparar el trabajo.'
      return
    }
    const prepared = planCatalogImportJob(result.records)
    for (const page of prepared.pages)
      if (
        new TextEncoder().encode(JSON.stringify({ index: page.index, records: page.records })).byteLength >
        CATALOG_NATIVE_IMPORT_MAX_BYTES + 32
      )
        throw new Error('page_envelope')
    plan.value = prepared
    feedback.value = 'Archivo preparado localmente. Todavía no se ha enviado ninguna página.'
  } catch {
    if (current(version, identity))
      feedback.value =
        'No se ha podido preparar el archivo dentro de los límites. Revisa sus datos y selecciónalo de nuevo.'
  } finally {
    if (current(version, identity)) busy.value = false
  }
}
function validateJob(raw: unknown, original = binding.value): CatalogImportJob {
  const parsed = catalogImportJobSchema.parse(raw),
    local = plan.value
  if (!local || parsed.totalPages !== local.pages.length || parsed.recordCount !== local.recordCount)
    throw new Error('job_plan')
  if (
    original &&
    (parsed.id !== original.id ||
      parsed.createdAt !== original.createdAt ||
      JSON.stringify(parsed.policy) !== JSON.stringify(original.policy))
  )
    throw new Error('job_binding')
  if (original) {
    const order = { uploading: 0, ready: 1, applied: 2, reverted: 3 }
    if (order[parsed.status] < order[original.status]) throw new Error('job_status_regression')
    if (original.status === 'uploading' && parsed.status === 'ready') {
      // Sealing replaces the 24-hour staging TTL with a 30-minute preview TTL.
      // Only this transition may change expiry; tolerate 20 seconds of clock
      // skew without accepting an arbitrary extended authorization window.
      const expires = Date.parse(parsed.expiresAt),
        now = Date.now()
      if (expires <= now - 20_000 || expires > now + 30 * 60_000 + 20_000) throw new Error('job_seal_expiry')
    } else if (parsed.expiresAt !== original.expiresAt) throw new Error('job_expiry_binding')
  }
  if (
    original?.hash !== null &&
    original?.hash !== undefined &&
    (parsed.hash !== original.hash || JSON.stringify(parsed.counts) !== JSON.stringify(original.counts))
  )
    throw new Error('job_hash')
  if (parsed.status === 'uploading') {
    if (parsed.hash !== null || Object.values(parsed.counts).some((count) => count > parsed.recordCount))
      throw new Error('job_unsealed')
  } else if (
    !parsed.hash ||
    parsed.receivedPages !== parsed.totalPages ||
    Object.values(parsed.counts).some((count) => count < 1 || count > parsed.recordCount)
  )
    throw new Error('job_sealed')
  return parsed
}
function retain(value: CatalogImportJob) {
  job.value = value
  if (!binding.value || value.hash !== null) binding.value = value
}
function commandUpdated(value: CatalogImportJob) {
  // Only the command child's validated read-only GET can advance this state;
  // a receipt alone never authorizes an optimistic status transition.
  if (!enabled.value || props.commandsAvailable !== true) return
  try {
    retain(validateJob(value))
    feedback.value = ''
  } catch {
    feedback.value = 'No se ha confirmado un estado compatible del trabajo.'
  }
}
async function createJob() {
  if (!enabled.value || busy.value || !plan.value || binding.value) return
  const version = epoch,
    identity = actor.value
  busy.value = true
  try {
    if (!pendingCreate.value)
      pendingCreate.value = Object.freeze({
        body: JSON.stringify(
          catalogImportJobCreateInputSchema.parse({
            totalPages: plan.value.pages.length,
            recordCount: plan.value.recordCount
          })
        ),
        key: crypto.randomUUID()
      })
    const command = pendingCreate.value
    const raw: unknown = await request(root, {
      method: 'POST',
      ...jsonOptions(command.body),
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': command.key }
    })
    if (!current(version, identity)) return
    const value = validateJob(raw, null)
    if (
      value.status !== 'uploading' ||
      value.receivedPages !== 0 ||
      Object.values(value.counts).some((count) => count !== 0)
    )
      throw new Error('job_created')
    retain(value)
    pendingCreate.value = null
    feedback.value = 'Trabajo confirmado. Inicia explícitamente la subida secuencial; el catálogo no se ha aplicado.'
  } catch {
    if (current(version, identity)) {
      feedback.value =
        'Creación no confirmada. Reintenta explícitamente con la misma clave y contenido para recuperar el identificador; no se ha aplicado el catálogo.'
    }
  } finally {
    if (current(version, identity)) busy.value = false
  }
}
function invalid(raw: unknown) {
  const parsed = nativeImportInvalidSchema.safeParse(raw)
  if (!parsed.success) return false
  issues.value = parsed.data.issues
  return true
}
async function upload() {
  if (
    !enabled.value ||
    busy.value ||
    !plan.value ||
    !binding.value ||
    !job.value ||
    job.value.status !== 'uploading' ||
    pendingSeal.value !== null ||
    (recoveryRequired.value && !recovered.value)
  )
    return
  const version = epoch,
    identity = actor.value,
    original = binding.value,
    local = plan.value
  busy.value = true
  issues.value = []
  try {
    while (nextPage.value < local.pages.length) {
      if (!current(version, identity)) return
      const page = local.pages[nextPage.value]!
      if (!pendingPage.value)
        pendingPage.value = Object.freeze({
          index: page.index,
          body: JSON.stringify({ index: page.index, records: page.records })
        })
      const command = pendingPage.value
      if (command.index !== nextPage.value) throw new Error('page_intent')
      const raw: unknown = await request(`${root}/${original.id}/pages/${command.index}`, {
        method: 'PUT',
        ...jsonOptions(command.body)
      })
      if (!current(version, identity)) return
      if (invalid(raw)) {
        feedback.value = 'El servidor ha rechazado esta página. Corrige el archivo; no se ha aplicado el catálogo.'
        recoveryRequired.value = true
        recovered.value = false
        return
      }
      const value = validateJob(raw)
      if (value.status !== 'uploading' || value.receivedPages !== command.index + 1) throw new Error('page_ack')
      retain(value)
      nextPage.value = command.index + 1
      pendingPage.value = null
      recoveryRequired.value = recovered.value = false
    }
    feedback.value =
      'Todas las páginas están confirmadas. Revisa el motivo y solicita sellar la vista previa; todavía no se ha aplicado.'
  } catch {
    if (current(version, identity)) {
      job.value = null
      recoveryRequired.value = true
      recovered.value = false
      feedback.value =
        'Subida no confirmada. Consulta el estado antes de reanudar; conservamos la misma página y su contenido exacto.'
    }
  } finally {
    if (current(version, identity)) busy.value = false
  }
}
async function recover() {
  if (!enabled.value || busy.value || !binding.value) return
  const version = epoch,
    identity = actor.value,
    original = binding.value
  busy.value = true
  job.value = null
  try {
    const raw: unknown = await request(`${root}/${original.id}`, { method: 'GET', ...transport, cache: 'no-store' })
    if (!current(version, identity)) return
    const value = validateJob(raw)
    if (
      value.status === 'uploading' &&
      (value.receivedPages < nextPage.value || value.receivedPages > nextPage.value + (pendingPage.value ? 1 : 0))
    )
      throw new Error('page_order_unconfirmed')
    if (value.status !== 'uploading' && (pendingPage.value || nextPage.value !== value.totalPages))
      throw new Error('unexpected_seal')
    retain(value)
    recovered.value = true
    if (value.status === 'ready') {
      pendingSeal.value = null
      recoveryRequired.value = false
      confirmed.value = false
      emit('prepared', value)
    }
    feedback.value =
      value.status === 'ready'
        ? 'Vista previa sellada confirmada. El trabajo está preparado, no aplicado.'
        : 'Estado consultado sin enviar páginas ni sellar. Reanudar repetirá la página incierta con el mismo contenido, sin saltar páginas.'
  } catch {
    if (current(version, identity)) {
      recovered.value = false
      feedback.value =
        'No se ha confirmado un estado compatible del trabajo. No se enviarán páginas ni se aplicará el catálogo.'
    }
  } finally {
    if (current(version, identity)) busy.value = false
  }
}
function canSeal() {
  return (
    enabled.value &&
    !busy.value &&
    !!job.value &&
    job.value.status === 'uploading' &&
    !!plan.value &&
    nextPage.value === plan.value.pages.length &&
    !pendingPage.value &&
    (!recoveryRequired.value || recovered.value) &&
    (pendingSeal.value !== null ||
      (confirmed.value && catalogImportJobFinalizeInputSchema.safeParse({ reason: reason.value }).success))
  )
}
async function seal() {
  if (!canSeal() || !binding.value) return
  const version = epoch,
    identity = actor.value,
    original = binding.value
  if (pendingSeal.value === null)
    pendingSeal.value = JSON.stringify(catalogImportJobFinalizeInputSchema.parse({ reason: reason.value }))
  const body = pendingSeal.value
  busy.value = true
  issues.value = []
  try {
    const raw: unknown = await request(`${root}/${original.id}/seal`, { method: 'POST', ...jsonOptions(body) })
    if (!current(version, identity)) return
    if (invalid(raw)) {
      recoveryRequired.value = true
      recovered.value = false
      feedback.value = 'La revisión del servidor tiene incidencias. El trabajo no está listo ni aplicado.'
      return
    }
    const value = validateJob(raw)
    if (value.status !== 'ready') throw new Error('seal_unconfirmed')
    retain(value)
    pendingSeal.value = null
    recoveryRequired.value = recovered.value = confirmed.value = false
    feedback.value =
      'Vista previa sellada y preparada. No se ha aplicado ningún producto; aplicar requiere una operación y confirmación independientes.'
    emit('prepared', value)
  } catch {
    if (current(version, identity)) {
      job.value = null
      recoveryRequired.value = true
      recovered.value = false
      feedback.value =
        'Sellado no confirmado. Consulta el estado; el motivo original queda bloqueado para un reintento explícito idéntico.'
    }
  } finally {
    if (current(version, identity)) busy.value = false
  }
}
</script>

<template>
  <section v-if="enabled" class="mb-4 rounded-xl border border-[var(--border)] p-4" :aria-busy="busy">
    <h2 class="text-base font-semibold">Preparar catálogo completo por páginas</h2>
    <p class="mt-2 text-sm">
      CSV o XLSX de 71 columnas: máximo 20 MB de archivo CSV o XLSX comprimido, 100 MB de contenido XLSX descomprimido y
      25.000 registros; deben cumplirse todos los límites antes de preparar las páginas. El trabajo admite páginas de
      hasta 500 registros y 900.000 bytes; máximo 1.000 páginas y 100 MB expandidos en total.
    </p>
    <p class="mt-2 text-sm">
      Subir y sellar prepara una vista previa, no aplica ni publica el catálogo. La política es crear nuevos borradores,
      medios pendientes de verificación e inicialización de precios y stock sólo con autorización explícita.
    </p>
    <label :for="`${prefix}-file`" class="mt-3 block">Archivo completo</label>
    <input :id="`${prefix}-file`" ref="input" type="file" accept=".csv,.xlsx" @change="selected" />
    <p v-if="plan" data-job-plan class="mt-2 text-sm">
      {{ plan.recordCount }} registros · {{ plan.pages.length }} páginas · {{ plan.totalBytes }} bytes preparados
      localmente.
    </p>
    <button type="button" data-job-create :disabled="busy || !plan || !!binding" @click="createJob">
      {{ pendingCreate ? 'Reintentar la misma creación' : 'Crear trabajo de preparación' }}
    </button>
    <button
      v-if="binding && (commandsAvailable !== true || binding.status === 'uploading')"
      type="button"
      data-job-recover
      :disabled="busy"
      @click="recover"
    >
      Consultar estado para recuperar
    </button>
    <div v-if="job" data-job-summary class="mt-2 text-sm">
      <p>
        Estado del servidor: {{ job.status }} · {{ job.receivedPages }}/{{ job.totalPages }} páginas recibidas ·
        {{ job.recordCount }} registros.
      </p>
      <p>Confirmadas en esta sesión: {{ nextPage }} páginas. No se saltan páginas por inferencia.</p>
      <p>Política: {{ job.policy.publication }} · {{ job.policy.media }} · {{ job.policy.priceStock }}.</p>
      <p v-if="job.hash">
        Hash de vista previa: <span data-job-hash class="break-all">{{ job.hash }}</span> ·
        {{ job.counts.products }} productos · {{ job.counts.variants }} variantes · {{ job.counts.assets }} archivos ·
        {{ job.counts.mappings }} relaciones.
      </p>
    </div>
    <button
      v-if="binding"
      type="button"
      data-job-upload
      :disabled="
        busy ||
        !job ||
        job.status !== 'uploading' ||
        !!pendingSeal ||
        (!!plan && nextPage === plan.pages.length) ||
        (recoveryRequired && !recovered)
      "
      @click="upload"
    >
      {{ pendingPage ? 'Reanudar la misma página y continuar' : 'Iniciar subida secuencial' }}
    </button>
    <div v-if="binding" class="mt-3">
      <label :for="`${prefix}-reason`" class="block">Motivo de la revisión (3–500 caracteres)</label>
      <textarea
        :id="`${prefix}-reason`"
        v-model="reason"
        data-job-reason
        maxlength="500"
        :disabled="locked || job?.status !== 'uploading'"
      />
      <label class="block"
        ><input
          v-model="confirmed"
          data-job-confirm
          type="checkbox"
          :disabled="locked || job?.status !== 'uploading'"
        />
        Confirmo solicitar únicamente el sellado de la vista previa, sin aplicar ni publicar productos.</label
      >
      <button type="button" data-job-seal :disabled="!canSeal()" @click="seal">
        {{ pendingSeal ? 'Reintentar el mismo sellado' : 'Sellar vista previa' }}
      </button>
    </div>
    <CatalogImportJobReview v-if="job?.status === 'ready'" :runtime="runtime" :available="available" :job="job" />
    <CatalogImportJobCommands
      v-if="job && job.status !== 'uploading'"
      :runtime="runtime"
      :available="commandsAvailable"
      :job="job"
      @updated="commandUpdated"
      @completed="emit('completed', $event)"
    />
    <p v-if="busy" role="status" aria-live="polite">Procesando la solicitud explícita…</p>
    <p v-if="feedback" role="status" aria-live="polite" class="mt-2 text-sm">{{ feedback }}</p>
    <p v-if="limitRejected" data-import-limit-help role="status" class="mt-2 text-sm">
      0 filas aceptadas de este archivo; no se ha enviado ni realizado una importación parcial. Prepara manualmente
      archivos menores por productos completos, con todas sus variantes y relaciones coherentes, conservando las 71
      columnas. No cortes el CSV por saltos de línea. Cada archivo debe cumplir los límites; los trabajos separados son
      independientes, no una única operación atómica. Dividir en páginas HTTP no evita los límites del archivo.
    </p>
    <p v-if="issues.length" class="mt-2 text-sm">{{ issues.length }} incidencias; se muestran hasta 100.</p>
    <ul v-if="issues.length" class="mt-2 max-h-64 overflow-auto text-sm">
      <li v-for="(issue, index) in issues.slice(0, 100)" :key="index" data-job-issue>
        <span v-if="issue.row">Fila {{ issue.row }} · </span><span v-if="issue.field">{{ issue.field }}: </span
        >{{ issue.message }}
      </li>
    </ul>
  </section>
</template>

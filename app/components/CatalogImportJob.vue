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
      ? 'El archivo supera los 20 MB permitidos.'
      : 'Elige un archivo CSV o Excel (.xlsx) con las 71 columnas, con datos y de hasta 20 MB.'
    return
  }
  const version = epoch,
    identity = actor.value
  busy.value = true
  try {
    const bytes = new Uint8Array(await file.arrayBuffer())
    if (!current(version, identity)) return
    if (!bytes.length || bytes.length > CATALOG_TABULAR_MAX_BYTES) throw new Error('file')
    // Guarda aparte: así el paso de servidor descarta el import del lector XLSX (solo navegador).
    if (!import.meta.client) throw new Error('file')
    const { decodeCatalogImportFile } = await import('~/utils/catalog-import-file.client')
    if (!current(version, identity)) return
    const result = await decodeCatalogImportFile(bytes, format)
    if (!current(version, identity)) return
    issues.value = result.validation.issues
    if (!result.validation.valid) {
      limitRejected.value = result.validation.issues.some((issue) => issue.code === 'catalog_file_too_large')
      feedback.value = 'El archivo tiene problemas. Corrígelos y vuelve a elegirlo.'
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
    feedback.value = 'Archivo comprobado. Todavía no se ha enviado nada.'
  } catch {
    if (current(version, identity))
      feedback.value = 'No hemos podido leer el archivo. Revisa sus datos y vuelve a elegirlo.'
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
    feedback.value = 'No hemos podido confirmar el estado de la importación.'
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
    feedback.value = 'Importación creada. Ya puedes empezar a subir el archivo; el catálogo no ha cambiado.'
  } catch {
    if (current(version, identity)) {
      feedback.value =
        'No hemos podido confirmar que la importación se haya creado. Pulsa «Reintentar»: no se creará dos veces. El catálogo no ha cambiado.'
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
        feedback.value =
          'Una parte del archivo tiene problemas y no se ha aceptado. Corrige el archivo; el catálogo no ha cambiado.'
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
      'El archivo está subido entero. Escribe el motivo y prepara la vista previa; el catálogo todavía no ha cambiado.'
  } catch {
    if (current(version, identity)) {
      job.value = null
      recoveryRequired.value = true
      recovered.value = false
      feedback.value =
        'No hemos podido confirmar la última parte. Pulsa «Comprobar el estado» antes de continuar: la subida seguirá donde se quedó.'
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
        ? 'La vista previa está lista. La importación está preparada, pero no aplicada.'
        : 'Estado comprobado, sin enviar nada. Al continuar se repetirá la parte que quedó en duda, sin saltarse ninguna.'
  } catch {
    if (current(version, identity)) {
      recovered.value = false
      feedback.value =
        'No hemos podido confirmar el estado de la importación. No se enviará nada ni cambiará el catálogo.'
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
      feedback.value = 'Al revisar el archivo completo han salido problemas. La importación no está lista ni aplicada.'
      return
    }
    const value = validateJob(raw)
    if (value.status !== 'ready') throw new Error('seal_unconfirmed')
    retain(value)
    pendingSeal.value = null
    recoveryRequired.value = recovered.value = confirmed.value = false
    feedback.value =
      'La vista previa está lista. No se ha creado ningún producto: para aplicarla hay que confirmarlo aparte.'
    emit('prepared', value)
  } catch {
    if (current(version, identity)) {
      job.value = null
      recoveryRequired.value = true
      recovered.value = false
      feedback.value =
        'No hemos podido confirmar que la vista previa esté lista. Pulsa «Comprobar el estado»; el motivo se conserva para reintentarlo igual.'
    }
  } finally {
    if (current(version, identity)) busy.value = false
  }
}
// ── Presentación ────────────────────────────────────────────────────────
const statusLabels: Record<CatalogImportJob['status'], string> = {
  uploading: 'Subiendo el archivo',
  ready: 'Lista para revisar',
  applied: 'Aplicada',
  reverted: 'Deshecha'
}
const statusTones: Record<CatalogImportJob['status'], 'info' | 'warning' | 'success' | 'neutral'> = {
  uploading: 'info',
  ready: 'warning',
  applied: 'success',
  reverted: 'neutral'
}
const stage = computed(() =>
  !binding.value ? 'create' : plan.value && nextPage.value < plan.value.pages.length ? 'upload' : 'seal'
)
const count = (value: number) => value.toLocaleString('es-ES')
function megabytes(bytes: number) {
  return `${(bytes / 1048576).toLocaleString('es-ES', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} MB`
}
</script>

<template>
  <AdminCard
    v-if="enabled"
    title="Importar un catálogo grande"
    description="El archivo se sube por partes y se prepara una vista previa. Nada cambia en la tienda hasta que revises y apliques la importación."
    :aria-busy="busy"
  >
    <template #actions>
      <AdminBadge v-if="job" :tone="statusTones[job.status]" class="whitespace-nowrap">
        {{ statusLabels[job.status] }}
      </AdminBadge>
    </template>
    <div class="adm-stack">
      <AdminFormField
        :for="`${prefix}-file`"
        label="Archivo del catálogo"
        help="CSV o Excel (.xlsx) con las 71 columnas de la plantilla. Máximo 20 MB y 25.000 filas."
      >
        <input
          :id="`${prefix}-file`"
          ref="input"
          type="file"
          accept=".csv,.xlsx"
          class="adm-input"
          @change="selected"
        />
      </AdminFormField>
      <p v-if="plan" data-job-plan class="adm-help">
        <span class="whitespace-nowrap">{{ count(plan.recordCount) }} filas</span> ·
        <span class="whitespace-nowrap">{{ megabytes(plan.totalBytes) }}</span> · se enviará en
        <span class="whitespace-nowrap">{{ count(plan.pages.length) }} partes</span>. Todavía no se ha enviado nada.
      </p>

      <UAlert
        v-if="feedback"
        role="status"
        aria-live="polite"
        color="info"
        variant="subtle"
        icon="i-lucide-info"
        :title="feedback"
      />
      <UAlert
        v-if="limitRejected"
        data-import-limit-help
        role="status"
        color="warning"
        variant="subtle"
        icon="i-lucide-file-warning"
        title="El archivo es demasiado grande y no se ha importado ninguna fila"
        description="Divídelo en varios archivos más pequeños, cada uno con las 71 columnas y con los productos completos (todas sus variantes juntas, sin cortar un producto por la mitad). Cada archivo se importa por separado."
      />

      <ol class="space-y-4 border-t border-[var(--border)] pt-4">
        <li class="flex flex-wrap items-start gap-3">
          <span class="adm-list__index">1</span>
          <div class="min-w-0 flex-1 basis-56">
            <p class="font-semibold text-[var(--text-strong)]">Crear la importación</p>
            <p class="adm-help">Reserva un sitio para el archivo. No envía datos todavía.</p>
          </div>
          <button
            type="button"
            data-job-create
            class="adm-btn"
            :class="stage === 'create' ? 'adm-btn--primary' : 'adm-btn--secondary'"
            :disabled="busy || !plan || !!binding"
            @click="createJob"
          >
            {{ pendingCreate ? 'Reintentar' : binding ? 'Creada' : 'Crear importación' }}
          </button>
        </li>
        <li class="flex flex-wrap items-start gap-3">
          <span class="adm-list__index">2</span>
          <div class="min-w-0 flex-1 basis-56">
            <p class="font-semibold text-[var(--text-strong)]">Subir el archivo</p>
            <p class="adm-help">
              <template v-if="plan && binding">
                <span class="whitespace-nowrap">{{ count(nextPage) }} de {{ count(plan.pages.length) }}</span> partes
                subidas. Si se corta, continúa donde se quedó.
              </template>
              <template v-else>Se envía parte a parte y en orden.</template>
            </p>
          </div>
          <div class="flex flex-wrap gap-2">
            <button
              v-if="binding && (commandsAvailable !== true || binding.status === 'uploading')"
              type="button"
              data-job-recover
              class="adm-btn adm-btn--secondary"
              :disabled="busy"
              @click="recover"
            >
              Comprobar el estado
            </button>
            <button
              v-if="binding"
              type="button"
              data-job-upload
              class="adm-btn"
              :class="stage === 'upload' ? 'adm-btn--primary' : 'adm-btn--secondary'"
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
              {{ pendingPage ? 'Continuar la subida' : 'Empezar a subir' }}
            </button>
          </div>
        </li>
        <li class="flex flex-wrap items-start gap-3">
          <span class="adm-list__index">3</span>
          <div class="min-w-0 flex-1 basis-56">
            <p class="font-semibold text-[var(--text-strong)]">Preparar la vista previa</p>
            <p class="adm-help">Cierra la subida para poder revisar qué se crearía. No aplica ni publica productos.</p>
            <div v-if="binding" class="adm-stack mt-3">
              <AdminFormField
                :for="`${prefix}-reason`"
                label="Motivo de la importación"
                help="Entre 3 y 500 caracteres. Queda guardado en el historial."
                required
              >
                <textarea
                  :id="`${prefix}-reason`"
                  v-model="reason"
                  data-job-reason
                  rows="3"
                  maxlength="500"
                  class="adm-input"
                  :disabled="locked || job?.status !== 'uploading'"
                />
              </AdminFormField>
              <label class="adm-check">
                <input
                  v-model="confirmed"
                  data-job-confirm
                  type="checkbox"
                  :disabled="locked || job?.status !== 'uploading'"
                />
                Entiendo que esto solo prepara la vista previa: no aplica ni publica productos.
              </label>
              <div>
                <button
                  type="button"
                  data-job-seal
                  class="adm-btn"
                  :class="stage === 'seal' ? 'adm-btn--primary' : 'adm-btn--secondary'"
                  :disabled="!canSeal()"
                  @click="seal"
                >
                  {{ pendingSeal ? 'Reintentar' : 'Preparar vista previa' }}
                </button>
              </div>
            </div>
          </div>
        </li>
      </ol>

      <p v-if="busy" role="status" aria-live="polite" class="adm-help flex items-center gap-2">
        <UIcon name="i-lucide-loader-circle" class="size-4 animate-spin" />Trabajando…
      </p>

      <div v-if="job" data-job-summary class="border-t border-[var(--border)] pt-4">
        <dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2">
          <dt class="text-[var(--text-muted)]">Estado</dt>
          <dd>{{ statusLabels[job.status] }}</dd>
          <dt class="text-[var(--text-muted)]">Partes recibidas</dt>
          <dd class="whitespace-nowrap tabular-nums">{{ count(job.receivedPages) }} de {{ count(job.totalPages) }}</dd>
          <dt class="text-[var(--text-muted)]">Filas</dt>
          <dd class="whitespace-nowrap tabular-nums">{{ count(job.recordCount) }}</dd>
          <template v-if="job.hash">
            <dt class="text-[var(--text-muted)]">Se crearían</dt>
            <dd>
              {{ count(job.counts.products) }} productos, {{ count(job.counts.variants) }} variantes,
              {{ count(job.counts.assets) }} archivos y {{ count(job.counts.mappings) }} relaciones
            </dd>
            <dt class="text-[var(--text-muted)]">Código de comprobación</dt>
            <dd>
              <span data-job-hash class="whitespace-nowrap font-mono text-[0.8125rem]" :title="job.hash">{{
                job.hash.slice(0, 12).toUpperCase()
              }}</span>
              <span class="adm-help block">Identifica esta vista previa exacta.</span>
            </dd>
          </template>
        </dl>
        <p class="adm-help mt-3">
          Los productos se crean como borradores, las imágenes quedan pendientes de revisar y los precios y las
          existencias solo se cargan si lo autorizas al aplicar.
        </p>
      </div>

      <div v-if="issues.length" class="border-t border-[var(--border)] pt-4">
        <p class="mb-2 font-semibold text-[var(--text-strong)]">
          {{ count(issues.length) }} problemas en el archivo
          <span v-if="issues.length > 100" class="adm-help font-normal">(se muestran los 100 primeros)</span>
        </p>
        <div
          class="adm-table-wrap max-h-72 overflow-y-auto rounded-[var(--radius-control)] border border-[var(--border)]"
        >
          <table class="adm-table">
            <thead>
              <tr>
                <th scope="col">Fila</th>
                <th scope="col">Columna</th>
                <th scope="col">Problema</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(issue, index) in issues.slice(0, 100)" :key="index" data-job-issue>
                <td class="whitespace-nowrap tabular-nums">{{ issue.row ?? '—' }}</td>
                <td class="whitespace-nowrap">{{ issue.field ?? '—' }}</td>
                <td class="min-w-56">{{ issue.message }}</td>
              </tr>
            </tbody>
          </table>
        </div>
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
    </div>
  </AdminCard>
</template>

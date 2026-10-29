<script setup lang="ts">
import { z } from 'zod'
import {
  editorialPreviewSchema,
  editorialInvalidSchema,
  editorialReceiptSchema,
  editorialCommandInputSchema,
  type EditorialPreview,
  type EditorialInvalid,
  type EditorialReceipt
} from '~~/shared/catalog-editorial-import'
import { EDITORIAL_CSV_COLUMNS, MAX_BYTES, MAX_PRODUCTS } from '~~/shared/catalog-editorial-csv'
import { catalogPolicyOwnJson, catalogPolicyUuidSchema } from '~~/shared/catalog-publication-policy'

const props = withDefaults(defineProps<{ runtime: unknown; available?: boolean }>(), { available: false })
const emit = defineEmits<{ changed: [receipt: EditorialReceipt] }>(),
  prefix = useId(),
  root = '/api/admin/catalog/editorial-import',
  requestFetch = useRequestFetch(),
  { ready, loggedIn, user } = useUserSession()
const fileInput = ref<HTMLInputElement | null>(null),
  csv = ref(''),
  filename = ref(''),
  fileReading = ref(false),
  previewing = ref(false),
  reading = ref(false),
  writing = ref(false),
  downloading = ref(false),
  preview = shallowRef<EditorialPreview | null>(null),
  binding = shallowRef<EditorialPreview | null>(null),
  issues = shallowRef<EditorialInvalid['issues']>([]),
  readFailed = ref(false),
  feedback = ref(''),
  reason = ref(''),
  confirmed = ref(false)
type Action = 'apply' | 'revert'
type Intent = Readonly<{
  actor: string
  action: Action
  previewId: string
  previewHash: string
  key: string
  payload: string
  productCount: number
}>
const intent = shallowRef<Intent | null>(null)
let alive = true,
  generation = 0,
  downloadUrl: string | null = null
// The session identity is only a lifecycle boundary. It does not grant an
// editorial permission: the parent capability and every backend route govern it.
const actor = computed(() =>
    ready.value === true && loggedIn.value === true && catalogPolicyUuidSchema.safeParse(user.value?.id).success
      ? user.value!.id
      : null
  ),
  enabled = computed(() => alive && props.runtime === 'cloudflare' && props.available === true && actor.value !== null),
  busy = computed(() => fileReading.value || previewing.value || reading.value || writing.value || downloading.value)
function current(epoch: number, identity: string | null) {
  return alive && generation === epoch && enabled.value && actor.value === identity
}
function revokeDownload() {
  if (downloadUrl !== null) URL.revokeObjectURL(downloadUrl)
  downloadUrl = null
}
function clear() {
  generation++
  revokeDownload()
  csv.value = ''
  filename.value = ''
  preview.value = null
  binding.value = null
  issues.value = []
  intent.value = null
  reason.value = ''
  confirmed.value = false
  feedback.value = ''
  readFailed.value = false
  fileReading.value = previewing.value = reading.value = writing.value = downloading.value = false
  if (fileInput.value) fileInput.value.value = ''
}
watch([() => props.runtime, () => props.available, actor], clear, { flush: 'sync' })
onBeforeUnmount(() => {
  alive = false
  clear()
})
function own(value: unknown) {
  return catalogPolicyOwnJson(value)
}
const rollbackErrorSchema = z
  .object({ error: z.object({ code: z.enum(['version_conflict', 'preview_expired']) }).strict() })
  .strict()
function confirmedRollback(context: unknown) {
  try {
    if (!context || typeof context !== 'object') return false
    const response: unknown = Object.getOwnPropertyDescriptor(context, 'response')?.value
    if (!(response instanceof Response)) return false
    const ownStatus = Object.getOwnPropertyDescriptor(response, 'status'),
      statusGetter = Object.getOwnPropertyDescriptor(Response.prototype, 'status')?.get,
      status =
        ownStatus && Object.hasOwn(ownStatus, 'value')
          ? ownStatus.value
          : !ownStatus && statusGetter
            ? Reflect.apply(statusGetter, response, [])
            : undefined
    if (status !== 409) return false
    const descriptor = Object.getOwnPropertyDescriptor(response, '_data')
    return (
      !!descriptor && Object.hasOwn(descriptor, 'value') && rollbackErrorSchema.safeParse(own(descriptor.value)).success
    )
  } catch {
    return false
  }
}
async function chooseFile(event: Event) {
  if (!enabled.value || intent.value || previewing.value || reading.value || writing.value || downloading.value) return
  const target = event.target
  if (!(target instanceof HTMLInputElement)) return
  const file = target.files?.[0]
  clear()
  if (!file) return
  if (!(file instanceof File) || !/\.csv$/i.test(file.name) || file.size < 1 || file.size > MAX_BYTES) {
    feedback.value = 'Selecciona un archivo CSV UTF-8 de hasta 1.000.000 bytes. XLSX no está admitido.'
    return
  }
  const epoch = generation,
    identity = actor.value
  fileReading.value = true
  try {
    const buffer = await file.arrayBuffer()
    if (!current(epoch, identity)) return
    if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 1 || buffer.byteLength > MAX_BYTES)
      throw new Error('csv_unconfirmed')
    const contents = new TextDecoder('utf-8', { fatal: true }).decode(buffer)
    if (!contents.trim()) throw new Error('csv_unconfirmed')
    csv.value = contents
    filename.value = file.name.slice(0, 255)
  } catch {
    if (current(epoch, identity)) feedback.value = 'No se ha podido leer un CSV UTF-8 válido. Selecciónalo de nuevo.'
  } finally {
    if (current(epoch, identity)) fileReading.value = false
  }
}
async function createPreview() {
  if (!enabled.value || busy.value || intent.value || !csv.value) return
  const epoch = generation,
    identity = actor.value,
    payload = JSON.stringify({ csv: csv.value })
  preview.value = binding.value = null
  issues.value = []
  reason.value = ''
  confirmed.value = false
  feedback.value = ''
  readFailed.value = false
  previewing.value = true
  try {
    const raw: unknown = await requestFetch(`${root}/preview`, {
      method: 'POST',
      body: payload,
      headers: { 'Content-Type': 'application/json' },
      retry: 0,
      credentials: 'same-origin',
      referrerPolicy: 'no-referrer'
    })
    if (!current(epoch, identity)) return
    const data = own(raw),
      invalid = editorialInvalidSchema.safeParse(data)
    if (invalid.success) {
      issues.value = invalid.data.issues
      feedback.value = 'El archivo no es válido. Corrige las filas indicadas y selecciónalo de nuevo.'
      return
    }
    const parsed = editorialPreviewSchema.parse(data)
    if (parsed.status !== 'pending') throw new Error('preview_unconfirmed')
    binding.value = preview.value = parsed
    feedback.value = 'Vista previa preparada. Todavía no se ha cambiado ningún producto.'
  } catch {
    if (current(epoch, identity)) {
      preview.value = binding.value = null
      feedback.value = 'No se ha confirmado la vista previa. No se han enviado cambios a los productos.'
    }
  } finally {
    if (current(epoch, identity)) previewing.value = false
  }
}
function sameSnapshot(value: EditorialPreview, original: EditorialPreview) {
  return (
    value.id === original.id &&
    value.hash === original.hash &&
    value.createdAt === original.createdAt &&
    value.expiresAt === original.expiresAt &&
    JSON.stringify(value.products) === JSON.stringify(original.products)
  )
}
function resolves(value: EditorialPreview, command: Intent) {
  return command.action === 'apply'
    ? value.status === 'applied' || value.status === 'reverted'
    : value.status === 'reverted'
}
async function loadPreview(original = binding.value): Promise<EditorialPreview | null> {
  if (!enabled.value || !original || reading.value) return null
  const epoch = generation,
    identity = actor.value
  preview.value = null
  reading.value = true
  readFailed.value = false
  try {
    const raw: unknown = await requestFetch(`${root}/previews/${original.id}`, {
      method: 'GET',
      retry: 0,
      cache: 'no-store',
      credentials: 'same-origin',
      referrerPolicy: 'no-referrer'
    })
    if (!current(epoch, identity)) return null
    const parsed = editorialPreviewSchema.parse(own(raw))
    if (!sameSnapshot(parsed, original)) throw new Error('preview_binding_unconfirmed')
    preview.value = parsed
    return parsed
  } catch {
    if (current(epoch, identity)) {
      preview.value = null
      readFailed.value = true
      feedback.value =
        'No se ha confirmado el estado actual. Reintenta sólo la consulta; no se repetirá ninguna escritura.'
    }
    return null
  } finally {
    if (current(epoch, identity)) reading.value = false
  }
}
async function refresh() {
  if (!enabled.value || busy.value || !binding.value) return
  const epoch = generation,
    identity = actor.value
  const value = await loadPreview()
  if (!value || !current(epoch, identity)) return
  const command = intent.value
  const expiredApply = command?.action === 'apply' && value.status === 'expired'
  if (command && (resolves(value, command) || expiredApply)) {
    intent.value = null
    reason.value = ''
    confirmed.value = false
    feedback.value = expiredApply
      ? 'La vista previa ha caducado sin aplicación. Prepara otra explícitamente; no se ha reenviado el intento.'
      : 'Estado de la vista previa confirmado por una nueva consulta. No se ha reenviado la operación.'
  } else if (command) {
    feedback.value = 'El resultado del intento sigue sin confirmarse. Conservamos su clave y contenido sin reenviarlo.'
  } else
    feedback.value =
      'Estado de la vista previa consultado. Sus versiones describen el snapshot, no cambios posteriores.'
}
function canSubmit(action: Action) {
  return (
    enabled.value &&
    !busy.value &&
    !intent.value &&
    confirmed.value === true &&
    preview.value?.status === (action === 'apply' ? 'pending' : 'applied') &&
    editorialCommandInputSchema.safeParse({ previewHash: preview.value.hash, reason: reason.value }).success
  )
}
async function submit(action: Action) {
  if (!canSubmit(action) || !preview.value || !actor.value) return
  const original = preview.value,
    epoch = generation,
    identity = actor.value,
    body = editorialCommandInputSchema.parse({ previewHash: original.hash, reason: reason.value }),
    command: Intent = Object.freeze({
      actor: identity,
      action,
      previewId: original.id,
      previewHash: original.hash,
      key: crypto.randomUUID(),
      payload: JSON.stringify(body),
      productCount: original.products.length
    })
  intent.value = command
  writing.value = true
  feedback.value = ''
  let dispatched = false,
    rollback = false
  try {
    // A fresh GET is compulsory before every new command. It is not a grant:
    // the backend still checks live authority and all product versions atomically.
    const fresh = await loadPreview(original)
    if (!current(epoch, identity)) return
    if (!fresh || fresh.status !== (action === 'apply' ? 'pending' : 'applied')) {
      intent.value = null
      if (fresh) feedback.value = 'El estado ha cambiado. Revisa la consulta antes de preparar otra operación.'
      return
    }
    dispatched = true
    const raw: unknown = await requestFetch(`${root}/previews/${command.previewId}/${action}`, {
      method: 'POST',
      body: command.payload,
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': command.key },
      retry: 0,
      credentials: 'same-origin',
      referrerPolicy: 'no-referrer',
      onResponseError(context: unknown) {
        if (current(epoch, identity)) rollback = confirmedRollback(context)
      }
    })
    if (!current(epoch, identity)) return
    const receipt = editorialReceiptSchema.parse(own(raw))
    if (
      receipt.action !== action ||
      receipt.previewId !== command.previewId ||
      receipt.previewHash !== command.previewHash ||
      receipt.productCount !== command.productCount
    )
      throw new Error('receipt_unconfirmed')
    // A receipt is historical evidence, never the current state. No command is
    // retried, including after a lost response or a failed compulsory GET.
    const updated = await loadPreview(original)
    if (!current(epoch, identity)) return
    if (!updated || !resolves(updated, command)) {
      preview.value = null
      readFailed.value = true
      feedback.value = 'Hay un recibo, pero falta confirmar el estado actual. Consulta sin repetir la escritura.'
      return
    }
    intent.value = null
    reason.value = ''
    confirmed.value = false
    feedback.value = 'El estado ha sido confirmado por una consulta posterior. La importación no publica productos.'
    emit('changed', receipt)
  } catch {
    if (current(epoch, identity)) {
      preview.value = null
      readFailed.value = true
      if (!dispatched || rollback) {
        intent.value = null
        confirmed.value = false
      }
      feedback.value = rollback
        ? 'La operación ha sido rechazada sin aplicar cambios. Revisa las versiones actuales y prepara otra vista previa explícitamente.'
        : dispatched
          ? 'Resultado no confirmado. El intento conserva la misma clave y contenido; consulta su estado sin reenviarlo.'
          : 'No se ha podido confirmar la consulta previa. No se ha enviado ninguna escritura.'
    }
  } finally {
    if (current(epoch, identity)) writing.value = false
  }
}
async function downloadTemplate() {
  if (!enabled.value || busy.value || intent.value || typeof window === 'undefined') return
  const epoch = generation,
    identity = actor.value
  downloading.value = true
  feedback.value = ''
  try {
    if (!('raw' in requestFetch) || typeof requestFetch.raw !== 'function')
      throw new Error('template_transport_unavailable')
    const response = await requestFetch.raw<ArrayBuffer>(`${root}/template`, {
      method: 'GET',
      responseType: 'arrayBuffer',
      retry: 0,
      cache: 'no-store',
      credentials: 'same-origin',
      referrerPolicy: 'no-referrer'
    })
    if (!current(epoch, identity)) return
    const descriptor = Object.getOwnPropertyDescriptor(response, '_data'),
      buffer: unknown = descriptor?.value
    if (
      response.ok !== true ||
      !/^text\/csv(?:\s*;\s*charset=utf-8)?$/i.test(response.headers.get('content-type') ?? '') ||
      !/^attachment(?:;|$)/i.test(response.headers.get('content-disposition') ?? '') ||
      !descriptor ||
      !Object.hasOwn(descriptor, 'value') ||
      !(buffer instanceof ArrayBuffer) ||
      buffer.byteLength < 1 ||
      buffer.byteLength > MAX_BYTES
    )
      throw new Error('template_unconfirmed')
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer)
    if (!text.trim()) throw new Error('template_unconfirmed')
    // Incomplete draft cells are intentionally preserved. Do not parse or fill
    // this export as if it were already a valid editorial import.
    revokeDownload()
    downloadUrl = URL.createObjectURL(new Blob([buffer], { type: 'text/csv;charset=utf-8' }))
    const link = window.document.createElement('a')
    link.href = downloadUrl
    link.download = 'neteco-editorial-v1.csv'
    link.referrerPolicy = 'no-referrer'
    window.document.body.appendChild(link)
    link.click()
    link.remove()
    feedback.value = 'Plantilla descargada con los borradores actuales. Completa los campos vacíos antes de validar.'
  } catch {
    if (current(epoch, identity))
      feedback.value = 'No se ha confirmado la descarga. No se exportará una lista parcial ni inventada.'
  } finally {
    if (current(epoch, identity)) downloading.value = false
  }
}
const labels = {
    name: 'Nombre',
    shortDesc: 'Descripción breve',
    description: 'Descripción',
    usage: 'Uso',
    series: 'Serie',
    featured: 'Destacado'
  } as const,
  fields = Object.keys(labels) as Array<keyof typeof labels>,
  statuses = {
    pending: 'Sin aplicar',
    expired: 'Caducada',
    applied: 'Aplicada · historial',
    reverted: 'Revertida · historial'
  }
function valueLabel(value: string | boolean | null) {
  return value === null
    ? 'Sin valor (null)'
    : value === ''
      ? 'Vacío'
      : typeof value === 'boolean'
        ? value
          ? 'Sí'
          : 'No'
        : value
}
</script>

<template>
  <section
    :aria-labelledby="`${prefix}-heading`"
    :aria-busy="busy"
    class="space-y-5 rounded-xl border border-slate-200 bg-white p-5"
  >
    <header class="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 :id="`${prefix}-heading`" class="text-lg font-semibold text-slate-900">Importación editorial CSV</h2>
        <p class="mt-1 max-w-3xl text-sm text-slate-600">
          Revisa cambios en borradores existentes antes de aplicarlos. No se importan precios, stock, medios, estado ni
          aprobaciones; no se publica ningún producto.
        </p>
      </div>
      <UButton
        v-if="enabled"
        data-editorial-template
        type="button"
        variant="outline"
        :disabled="busy || !!intent"
        @click="downloadTemplate"
        >{{ downloading ? 'Descargando…' : 'Descargar plantilla CSV' }}</UButton
      >
    </header>
    <p v-if="!enabled" data-editorial-unavailable role="status" class="rounded-lg bg-slate-50 p-4 text-sm">
      La importación requiere el backend Cloudflare y acceso actual habilitado. No está disponible en este contexto.
    </p>
    <template v-else>
      <div class="rounded-lg border border-slate-200 p-4">
        <h3 class="font-medium">1. Selecciona el archivo</h3>
        <p :id="`${prefix}-format`" class="mt-1 text-sm text-slate-600">
          CSV UTF-8 · hasta 1.000.000 bytes · máximo {{ MAX_PRODUCTS }} productos. Conserva los identificadores y las
          versiones de la plantilla. XLSX no está admitido.
        </p>
        <details class="mt-2 text-sm">
          <summary class="cursor-pointer text-slate-700">Ver las nueve columnas del perfil editorial v1</summary>
          <code class="mt-2 block break-all text-xs">{{ EDITORIAL_CSV_COLUMNS.join(',') }}</code>
        </details>
        <label :for="`${prefix}-file`" class="mt-3 block text-sm font-medium">Archivo CSV</label>
        <input
          :id="`${prefix}-file`"
          ref="fileInput"
          data-editorial-file
          type="file"
          accept=".csv,text/csv"
          :aria-describedby="`${prefix}-format`"
          :disabled="!!intent || previewing || reading || writing || downloading"
          class="mt-2 block max-w-full rounded border border-slate-300 p-2 text-sm"
          @change="chooseFile"
        />
        <p v-if="filename" data-editorial-filename class="mt-2 break-all text-sm text-slate-700">{{ filename }}</p>
        <p v-if="fileReading" role="status" class="mt-2 text-sm">Leyendo el archivo…</p>
        <div class="mt-3 flex flex-wrap gap-2">
          <UButton data-editorial-preview type="button" :disabled="!csv || busy || !!intent" @click="createPreview">{{
            previewing ? 'Validando…' : 'Validar y previsualizar'
          }}</UButton
          ><UButton data-editorial-reset type="button" variant="ghost" :disabled="busy || !!intent" @click="clear"
            >Limpiar selección</UButton
          >
        </div>
      </div>
      <p
        v-if="feedback"
        data-editorial-feedback
        :role="readFailed || issues.length || intent ? 'alert' : 'status'"
        aria-live="polite"
        class="rounded-lg bg-slate-50 p-3 text-sm text-slate-800"
      >
        {{ feedback }}
      </p>
      <div v-if="issues.length" data-editorial-issues class="rounded-lg border border-amber-300 p-4">
        <h3 class="font-medium">Corrige el archivo antes de continuar</h3>
        <ul class="mt-2 space-y-2 text-sm">
          <li v-for="(issue, index) in issues" :key="index">
            <span v-if="issue.row">Fila {{ issue.row }} · </span><span v-if="issue.field">{{ issue.field }} · </span
            >{{ issue.message }} <code class="text-xs">({{ issue.code }})</code>
          </li>
        </ul>
      </div>
      <div v-if="binding" class="flex flex-wrap items-center gap-3">
        <UButton data-editorial-refresh type="button" variant="outline" :disabled="busy" @click="refresh">{{
          reading ? 'Consultando…' : 'Consultar estado actual'
        }}</UButton>
        <p v-if="intent" data-editorial-uncertain class="text-sm text-amber-800">
          Intento conservado sin reenvío. No prepares otra escritura hasta confirmar el resultado.
        </p>
      </div>
      <div v-if="preview" data-editorial-diff class="space-y-4 rounded-lg border border-slate-200 p-4">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <h3 class="font-medium">2. Revisa las diferencias · {{ preview.products.length }} productos</h3>
          <span data-editorial-status class="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium">{{
            statuses[preview.status]
          }}</span>
        </div>
        <p class="text-xs text-slate-600">
          Creada: <time :datetime="preview.createdAt">{{ preview.createdAt }}</time> · Caducidad para aplicar:
          <time :datetime="preview.expiresAt">{{ preview.expiresAt }}</time
          >. Las versiones pertenecen al snapshot histórico, no garantizan el estado actual de los productos.
        </p>
        <details
          v-for="(product, index) in preview.products"
          :key="product.productId"
          :open="index === 0"
          class="rounded-lg border border-slate-200"
        >
          <summary class="cursor-pointer p-3 text-sm font-medium">
            {{ product.after.name }} · ID {{ product.legacyId }} · versión {{ product.expectedVersion }}
          </summary>
          <div class="space-y-2 px-3 pb-3">
            <p class="break-all text-xs text-slate-500">{{ product.productId }}</p>
            <div class="overflow-x-auto">
              <table class="w-full min-w-[480px] text-left text-sm">
                <caption class="sr-only">
                  Diferencias editoriales de
                  {{
                    product.after.name
                  }}
                </caption>
                <thead>
                  <tr class="border-b border-slate-200">
                    <th scope="col" class="p-2">Campo</th>
                    <th scope="col" class="p-2">Antes</th>
                    <th scope="col" class="p-2">Propuesto</th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="field in fields"
                    :key="field"
                    :data-editorial-changed="product.before[field] !== product.after[field]"
                    class="border-b border-slate-100 align-top"
                  >
                    <th scope="row" class="p-2 font-medium">{{ labels[field] }}</th>
                    <td class="w-2/5 p-2">
                      <p class="max-h-40 overflow-y-auto whitespace-pre-wrap break-words">
                        {{ valueLabel(product.before[field]) }}
                      </p>
                    </td>
                    <td class="w-2/5 p-2" :class="product.before[field] !== product.after[field] ? 'bg-blue-50' : ''">
                      <p class="max-h-40 overflow-y-auto whitespace-pre-wrap break-words">
                        {{ valueLabel(product.after[field]) }}
                      </p>
                      <span v-if="product.before[field] === product.after[field]" class="text-xs text-slate-500"
                        >Sin cambios</span
                      >
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </details>
        <p v-if="preview.status === 'expired'" role="status" class="text-sm text-amber-800">
          Esta vista previa ha caducado. Crea otra con las versiones actuales; no se aplicará automáticamente.
        </p>
        <p v-if="preview.status === 'reverted'" role="status" class="text-sm text-slate-600">
          Reversión registrada. Este historial no confirma que los productos permanezcan sin cambios posteriores.
        </p>
        <form
          v-if="preview.status === 'pending' || preview.status === 'applied'"
          class="space-y-3 border-t border-slate-200 pt-4"
          @submit.prevent="submit(preview.status === 'pending' ? 'apply' : 'revert')"
        >
          <h3 class="font-medium">
            3. {{ preview.status === 'pending' ? 'Confirma la importación' : 'Revisa la reversión' }}
          </h3>
          <p v-if="preview.status === 'applied'" class="text-sm text-slate-600">
            La reversión restaura los seis valores anteriores, incluidos los vacíos. Si algún producto cambió después,
            el backend rechazará la reversión completa.
          </p>
          <label :for="`${prefix}-reason`" class="block text-sm font-medium"
            >Motivo de {{ preview.status === 'pending' ? 'la aplicación' : 'la reversión' }}</label
          >
          <textarea
            :id="`${prefix}-reason`"
            v-model="reason"
            data-editorial-reason
            rows="3"
            minlength="3"
            maxlength="500"
            required
            :disabled="busy || !!intent"
            class="block w-full rounded border border-slate-300 p-2 text-sm"
          />
          <label class="flex items-start gap-2 text-sm"
            ><input
              v-model="confirmed"
              data-editorial-confirm
              type="checkbox"
              :disabled="busy || !!intent"
              class="mt-1"
            /><span
              >He revisado todos los productos y los seis campos. Esta operación no modifica precios, stock, medios,
              estados ni aprobaciones.</span
            ></label
          >
          <UButton
            data-editorial-apply
            type="submit"
            :disabled="!canSubmit(preview.status === 'pending' ? 'apply' : 'revert')"
            >{{
              preview.status === 'pending' ? 'Aplicar cambios editoriales' : 'Revertir cambios editoriales'
            }}</UButton
          >
        </form>
      </div>
    </template>
  </section>
</template>

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
  <section :aria-labelledby="`${prefix}-heading`" :aria-busy="busy" class="adm-card">
    <header class="adm-card__head">
      <div class="min-w-0">
        <h2 :id="`${prefix}-heading`" class="adm-card__title">Actualizar textos desde un archivo</h2>
        <p class="adm-card__hint">
          Cambia de una vez el nombre, las descripciones, el uso, la serie y el destacado de productos en borrador. No
          se importan precios, stock, imágenes ni estados, y no se publica ningún producto.
        </p>
      </div>
      <button
        v-if="enabled"
        data-editorial-template
        type="button"
        class="adm-btn adm-btn--secondary"
        :disabled="busy || !!intent"
        @click="downloadTemplate"
      >
        <UIcon name="i-lucide-download" class="size-4 shrink-0" />
        {{ downloading ? 'Descargando…' : 'Descargar plantilla' }}
      </button>
    </header>
    <div class="adm-card__body adm-stack">
      <p v-if="!enabled" data-editorial-unavailable role="status" class="adm-help">
        Ahora mismo no puedes importar textos: hace falta una sesión de administrador verificada y que la importación
        esté activada en esta tienda.
      </p>
      <template v-else>
        <div class="adm-field">
          <h3 class="adm-label">1. Elige el archivo</h3>
          <p :id="`${prefix}-format`" class="adm-help">
            Archivo CSV UTF-8 de hasta 1 MB y {{ MAX_PRODUCTS }} productos como máximo. Parte de la plantilla y no
            cambies sus columnas de identificador y versión. XLSX no está admitido.
          </p>
          <details class="text-sm">
            <summary class="cursor-pointer text-[var(--text-muted)]">
              Ver las columnas que debe tener el archivo
            </summary>
            <code class="mt-2 block break-all text-xs">{{ EDITORIAL_CSV_COLUMNS.join(',') }}</code>
          </details>
          <label :for="`${prefix}-file`" class="adm-label mt-2">Archivo CSV</label>
          <input
            :id="`${prefix}-file`"
            ref="fileInput"
            data-editorial-file
            type="file"
            accept=".csv,text/csv"
            :aria-describedby="`${prefix}-format`"
            :disabled="!!intent || previewing || reading || writing || downloading"
            class="block w-full max-w-md text-sm file:mr-3 file:rounded-[var(--radius-control)] file:border file:border-[var(--border-strong)] file:bg-[var(--surface)] file:px-3 file:py-1.5 file:text-sm file:font-medium"
            @change="chooseFile"
          />
          <p v-if="filename" data-editorial-filename class="break-all text-sm text-[var(--text-muted)]">
            {{ filename }}
          </p>
          <p v-if="fileReading" role="status" class="adm-help">Leyendo el archivo…</p>
          <div class="mt-2 flex flex-wrap gap-2">
            <button
              data-editorial-preview
              type="button"
              class="adm-btn adm-btn--primary"
              :disabled="!csv || busy || !!intent"
              @click="createPreview"
            >
              {{ previewing ? 'Revisando…' : 'Revisar cambios' }}
            </button>
            <button
              data-editorial-reset
              type="button"
              class="adm-btn adm-btn--ghost"
              :disabled="busy || !!intent"
              @click="clear"
            >
              Quitar archivo
            </button>
          </div>
        </div>
        <p
          v-if="feedback"
          data-editorial-feedback
          :role="readFailed || issues.length || intent ? 'alert' : 'status'"
          aria-live="polite"
          class="rounded-[var(--radius-control)] bg-[var(--surface-sunken)] px-3 py-2 text-sm text-[var(--text-strong)]"
        >
          {{ feedback }}
        </p>
        <div
          v-if="issues.length"
          data-editorial-issues
          class="rounded-[var(--radius-surface)] border border-[var(--border)] bg-[var(--surface-sunken)] p-4"
        >
          <h3 class="adm-label">Corrige el archivo antes de continuar</h3>
          <ul class="mt-2 list-disc space-y-1 pl-5 text-sm">
            <li v-for="(issue, index) in issues" :key="index">
              <span v-if="issue.row">Fila {{ issue.row }} · </span><span v-if="issue.field">{{ issue.field }} · </span
              >{{ issue.message }}
            </li>
          </ul>
        </div>
        <div v-if="binding" class="flex flex-wrap items-center gap-3">
          <button
            data-editorial-refresh
            type="button"
            class="adm-btn adm-btn--secondary"
            :disabled="busy"
            @click="refresh"
          >
            {{ reading ? 'Consultando…' : 'Comprobar cómo ha quedado' }}
          </button>
          <p v-if="intent" data-editorial-uncertain class="adm-help">
            No sabemos si el último envío llegó. Lo conservamos sin reenvío: comprueba cómo ha quedado antes de preparar
            otro cambio.
          </p>
        </div>
        <div v-if="preview" data-editorial-diff class="adm-stack border-t border-[var(--border)] pt-4">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <h3 class="adm-label">
              2. Revisa los cambios · {{ preview.products.length }}
              {{ preview.products.length === 1 ? 'producto' : 'productos' }}
            </h3>
            <span
              data-editorial-status
              class="adm-badge"
              :class="
                preview.status === 'applied'
                  ? 'adm-badge--success'
                  : preview.status === 'pending'
                    ? 'adm-badge--warning'
                    : ''
              "
              >{{ statuses[preview.status] }}</span
            >
          </div>
          <p class="adm-help">
            Revisión preparada el
            <time :datetime="preview.createdAt">{{ adminDate(preview.createdAt, true) }}</time> · se puede aplicar hasta
            el <time :datetime="preview.expiresAt">{{ adminDate(preview.expiresAt, true) }}</time
            >. Compara con los productos tal como estaban en ese momento, no con cambios posteriores.
          </p>
          <details
            v-for="(product, index) in preview.products"
            :key="product.productId"
            :open="index === 0"
            class="rounded-[var(--radius-surface)] border border-[var(--border)]"
          >
            <summary class="cursor-pointer px-3 py-2 text-sm font-medium">
              {{ product.after.name }}
              <span class="font-normal text-[var(--text-muted)]">
                · ref. {{ product.legacyId }} · versión {{ product.expectedVersion }}
              </span>
            </summary>
            <div class="px-3 pb-3">
              <div class="adm-table-wrap">
                <table class="adm-table min-w-[480px]">
                  <caption class="sr-only">
                    Cambios de textos de
                    {{
                      product.after.name
                    }}
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Campo</th>
                      <th scope="col">Antes</th>
                      <th scope="col">Después</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr
                      v-for="field in fields"
                      :key="field"
                      :data-editorial-changed="product.before[field] !== product.after[field]"
                      class="align-top"
                    >
                      <th scope="row" class="font-medium">{{ labels[field] }}</th>
                      <td class="w-2/5">
                        <p class="max-h-40 overflow-y-auto whitespace-pre-wrap break-words">
                          {{ valueLabel(product.before[field]) }}
                        </p>
                      </td>
                      <td class="w-2/5" :class="product.before[field] !== product.after[field] ? 'bg-neteco-50' : ''">
                        <p class="max-h-40 overflow-y-auto whitespace-pre-wrap break-words">
                          {{ valueLabel(product.after[field]) }}
                        </p>
                        <span v-if="product.before[field] === product.after[field]" class="adm-help">Sin cambios</span>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </details>
          <p v-if="preview.status === 'expired'" role="status" class="adm-help">
            Esta revisión ha caducado y no se aplicará. Vuelve a subir el archivo para preparar otra con los datos
            actuales.
          </p>
          <p v-if="preview.status === 'reverted'" role="status" class="adm-help">
            Los cambios se deshicieron. Los productos pueden tener cambios posteriores que no aparecen aquí.
          </p>
          <form
            v-if="preview.status === 'pending' || preview.status === 'applied'"
            class="adm-stack border-t border-[var(--border)] pt-4"
            @submit.prevent="submit(preview.status === 'pending' ? 'apply' : 'revert')"
          >
            <h3 class="adm-label">
              3. {{ preview.status === 'pending' ? 'Confirma los cambios' : 'Deshacer los cambios' }}
            </h3>
            <p v-if="preview.status === 'applied'" class="adm-help">
              Al deshacer, los seis campos vuelven a su valor anterior, incluidos los que estaban vacíos. Si algún
              producto se ha modificado después, no se deshará ninguno.
            </p>
            <div class="adm-field">
              <label :for="`${prefix}-reason`" class="adm-label"
                >Motivo para {{ preview.status === 'pending' ? 'aplicar los cambios' : 'deshacerlos' }}</label
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
                class="adm-input w-full"
              />
            </div>
            <label class="adm-check items-start"
              ><input
                v-model="confirmed"
                data-editorial-confirm
                type="checkbox"
                :disabled="busy || !!intent"
                class="mt-0.5"
              /><span
                >He revisado todos los productos y sus seis campos. Esto no cambia precios, stock, imágenes ni
                estados.</span
              ></label
            >
            <div>
              <button
                data-editorial-apply
                type="submit"
                class="adm-btn"
                :class="preview.status === 'pending' ? 'adm-btn--primary' : 'adm-btn--danger'"
                :disabled="!canSubmit(preview.status === 'pending' ? 'apply' : 'revert')"
              >
                {{ preview.status === 'pending' ? 'Aplicar cambios' : 'Deshacer cambios' }}
              </button>
            </div>
          </form>
        </div>
      </template>
    </div>
  </section>
</template>

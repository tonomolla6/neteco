<script setup lang="ts">
import { CATALOG_TABULAR_MAX_BYTES, type CatalogTabularValidation } from '~~/shared/catalog-tabular-core'
import { catalogPolicyUuidSchema } from '~~/shared/catalog-publication-policy'

const props = withDefaults(defineProps<{ runtime: unknown; available?: boolean }>(), { available: false })
const { ready, loggedIn, user } = useUserSession()
const input = ref<HTMLInputElement | null>(null)
const busy = ref(false)
const failure = ref('')
const limitRejected = ref(false)
const report = shallowRef<CatalogTabularValidation | null>(null)
const reportFormat = ref<'csv' | 'xlsx' | null>(null)
let generation = 0
let disposed = false
const actorId = computed(() => {
  const value: unknown = user.value
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const field = (key: string): unknown => {
    // Track Vue's property dependency without evaluating an accessor supplied
    // by an unconfirmed session projection.
    if (!Reflect.has(value, key)) return undefined
    return Object.getOwnPropertyDescriptor(value, key)?.value
  }
  if (field('role') !== 'admin' || field('mfaVerified') !== true || field('emailVerified') !== true) return null
  const id = catalogPolicyUuidSchema.safeParse(field('id'))
  return id.success ? id.data : null
})
const enabled = computed(
  () =>
    props.runtime === 'cloudflare' &&
    props.available === true &&
    ready.value === true &&
    loggedIn.value === true &&
    actorId.value !== null
)
function clear() {
  generation++
  busy.value = false
  failure.value = ''
  limitRejected.value = false
  report.value = null
  reportFormat.value = null
  if (input.value) input.value.value = ''
}
watch([enabled, actorId, () => props.runtime, () => props.available], clear, { flush: 'sync' })
onBeforeUnmount(() => {
  disposed = true
  clear()
})
async function selected(event: Event) {
  // Resetting a real file input clears its FileList. Capture the selected File
  // first; clearing afterwards also permits deliberate reselection of the same file.
  const source = event.target instanceof HTMLInputElement ? event.target.files?.[0] : undefined
  clear()
  if (!enabled.value || disposed || !(event.target instanceof HTMLInputElement)) return
  if (!(source instanceof File)) return
  const format = /^.+\.csv$/i.test(source.name) ? 'csv' : /^.+\.xlsx$/i.test(source.name) ? 'xlsx' : null
  if (!format) {
    failure.value = 'Selecciona un archivo CSV o XLSX del catálogo de 71 columnas.'
    return
  }
  if (!Number.isSafeInteger(source.size) || source.size < 1 || source.size > CATALOG_TABULAR_MAX_BYTES) {
    limitRejected.value = Number.isSafeInteger(source.size) && source.size > CATALOG_TABULAR_MAX_BYTES
    failure.value = limitRejected.value
      ? 'El archivo CSV o XLSX comprimido supera los 20 MB permitidos.'
      : 'El archivo debe contener datos y no superar los 20 MB.'
    return
  }
  const version = generation
  const current = () => !disposed && version === generation && enabled.value
  busy.value = true
  try {
    const bytes = new Uint8Array(await source.arrayBuffer())
    if (!current()) return
    if (bytes.byteLength < 1 || bytes.byteLength > CATALOG_TABULAR_MAX_BYTES)
      throw new Error('invalid_catalog_file_size')
    if (!import.meta.client) return
    const { inspectCatalogImportFile } = await import('~/utils/catalog-import-file.client')
    if (!current()) return
    const result = await inspectCatalogImportFile(bytes, format)
    if (!current()) return
    report.value = result
    reportFormat.value = format
    limitRejected.value = !result.valid && result.issues.some((issue) => issue.code === 'catalog_file_too_large')
  } catch {
    if (current()) failure.value = 'No se ha podido validar el archivo. Revisa su formato y vuelve a seleccionarlo.'
  } finally {
    if (current()) busy.value = false
  }
}
const issues = computed(() => report.value?.issues.slice(0, 100) ?? [])
</script>

<template>
  <section v-if="enabled" class="mb-4 rounded-xl border border-[var(--border)] p-4" :aria-busy="busy">
    <h2 class="text-base font-semibold">Preparar importación completa</h2>
    <p id="catalog-file-description" class="mt-1 text-sm text-[var(--text-muted)]">
      Revisa un CSV o XLSX de 71 columnas en este navegador. Máximo 20 MB de archivo CSV o XLSX comprimido, 100 MB de
      contenido XLSX descomprimido y 25.000 filas; deben cumplirse todos los límites. No modifica el catálogo ni envía
      el archivo al servidor.
    </p>
    <label for="catalog-file-preflight" class="mt-3 block text-sm font-medium">Archivo de catálogo</label>
    <input
      id="catalog-file-preflight"
      ref="input"
      type="file"
      accept=".csv,.xlsx"
      aria-describedby="catalog-file-description catalog-file-boundary"
      class="mt-1 block w-full max-w-full text-sm file:mr-3 file:rounded-md file:border file:border-[var(--border)] file:px-3 file:py-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
      @change="selected"
    />
    <p id="catalog-file-boundary" class="mt-2 text-sm text-[var(--text-muted)]">
      No autoriza una importación. Referencias, permisos, precios, stock, derechos y publicación deben comprobarse en
      servidor antes de aplicar. El snapshot de exportación y la plantilla editorial usan perfiles distintos.
    </p>
    <p v-if="busy" role="status" aria-live="polite" class="mt-3 text-sm">Validando archivo localmente…</p>
    <p v-if="failure" role="alert" class="mt-3 text-sm text-[var(--danger)]">{{ failure }}</p>
    <p v-if="limitRejected" data-import-limit-help role="status" class="mt-3 text-sm">
      0 filas aceptadas de este archivo; no se ha enviado ni realizado una importación parcial. Prepara manualmente
      archivos menores por productos completos, con todas sus variantes y relaciones coherentes, conservando las 71
      columnas. No cortes el CSV por saltos de línea. Cada archivo debe cumplir los límites; las importaciones separadas
      son independientes, no una única operación atómica.
    </p>
    <div v-if="report" :data-catalog-file-format="reportFormat" class="mt-3 text-sm">
      <p role="status" aria-live="polite" class="font-medium">
        {{ report.valid ? 'Estructura local válida' : 'El archivo tiene incidencias que corregir' }}
      </p>
      <p class="mt-1">
        {{ report.summary.rows }} filas · {{ report.summary.products }}
        {{ report.summary.products === 1 ? 'producto' : 'productos' }} · {{ report.summary.variants }} variantes ·
        {{ report.summary.assets }} archivos · {{ report.summary.documents }} documentos
      </p>
      <p v-if="report.issues.length" class="mt-2">
        {{ report.issues.length }} incidencias{{ report.issues.length > 100 ? '; se muestran las primeras 100' : '' }}.
      </p>
      <ul v-if="issues.length" class="mt-2 max-h-64 list-disc space-y-1 overflow-auto pl-5">
        <li v-for="(issue, index) in issues" :key="index" data-import-issue>
          <span v-if="issue.row">Fila {{ issue.row }} · </span>
          <span v-if="issue.field">{{ issue.field }}: </span>{{ issue.message }}
        </li>
      </ul>
    </div>
  </section>
</template>

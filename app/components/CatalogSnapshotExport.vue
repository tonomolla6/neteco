<script setup lang="ts">
import {
  CATALOG_EXPORT_MAX_BYTES,
  catalogExportFiltersSchema,
  exportCatalogSnapshotCsv,
  verifyCatalogExportSnapshot,
  type CatalogExportFilters,
  type CatalogExportSnapshot
} from '~~/shared/catalog-export'
import { catalogPolicyUuidSchema } from '~~/shared/catalog-publication-policy'

const props = withDefaults(defineProps<{ runtime: unknown; available?: boolean; filters?: unknown }>(), {
  available: false,
  filters: undefined
})
const { ready, loggedIn, user } = useUserSession(),
  requestFetch = useRequestFetch(),
  prefix = useId()
const format = ref<'csv' | 'xlsx'>('csv'),
  snapshot = shallowRef<CatalogExportSnapshot | null>(null),
  busy = ref(false),
  status = ref<'idle' | 'loading' | 'error' | 'prepared' | 'empty'>('idle')
let alive = true,
  generation = 0,
  downloadUrl: string | null = null
// These checks delimit private UI state. They never replace the backend's
// current catalog.write + administration.manage permission and MFA checks.
function currentActor(): string | null {
  if (ready.value !== true || loggedIn.value !== true || !user.value || typeof user.value !== 'object') return null
  const value = user.value,
    prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return null
  function field(key: string): unknown {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    // Read only known own data fields; this also tracks Vue's reactive updates.
    return descriptor && Object.hasOwn(descriptor, 'value') ? Reflect.get(value, key) : undefined
  }
  const id = catalogPolicyUuidSchema.safeParse(field('id'))
  return id.success && field('role') === 'admin' && field('mfaVerified') === true && field('emailVerified') === true
    ? id.data
    : null
}
function currentFilters(): CatalogExportFilters | null {
  const input = props.filters === undefined ? {} : props.filters,
    parsed = catalogExportFiltersSchema.safeParse(input)
  if (!parsed.success) return null
  if (input && typeof input === 'object') {
    // The own-data schema rejects accessors before any reactive dependency is
    // read, including when a filter changes in place rather than by replacement.
    for (const key of Object.keys(parsed.data)) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key)
      if (descriptor && Object.hasOwn(descriptor, 'value')) Reflect.get(input, key)
    }
  }
  return parsed.data
}
const actor = computed(currentActor),
  selectedFilters = computed(currentFilters),
  filterKey = computed(() => (selectedFilters.value === null ? null : JSON.stringify(selectedFilters.value)))
function context() {
  if (!alive || props.runtime !== 'cloudflare' || props.available !== true) return null
  const identity = currentActor(),
    selected = currentFilters()
  return identity && selected ? { identity, filters: selected, key: JSON.stringify(selected) } : null
}
const enabled = computed(() => context() !== null)
function current(epoch: number, identity: string, key: string) {
  const value = context()
  return alive && generation === epoch && value?.identity === identity && value.key === key
}
function revokeDownload() {
  if (downloadUrl !== null) URL.revokeObjectURL(downloadUrl)
  downloadUrl = null
}
function clear() {
  generation++
  revokeDownload()
  snapshot.value = null
  busy.value = false
  status.value = 'idle'
}
watch([() => props.runtime, () => props.available, actor, filterKey], clear, { flush: 'sync' })
onBeforeUnmount(() => {
  alive = false
  clear()
})
function ownedBytes(value: unknown): Uint8Array<ArrayBuffer> {
  if (!(value instanceof Uint8Array)) throw new Error('export_unconfirmed')
  const accessor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'byteLength')?.get
  if (!accessor) throw new Error('export_unconfirmed')
  const length: unknown = Reflect.apply(accessor, value, [])
  if (typeof length !== 'number' || length < 1 || length > CATALOG_EXPORT_MAX_BYTES)
    throw new Error('export_unconfirmed')
  const copy = new Uint8Array(length)
  copy.set(value)
  return copy
}
async function download() {
  const scope = context()
  if (!scope || busy.value || typeof window === 'undefined' || !['csv', 'xlsx'].includes(format.value)) return
  const epoch = ++generation,
    selectedFormat = format.value
  revokeDownload()
  snapshot.value = null
  busy.value = true
  status.value = 'loading'
  try {
    const raw: unknown = await requestFetch('/api/admin/catalog/export/snapshot', {
      method: 'GET',
      query: scope.filters,
      retry: 0,
      cache: 'no-store',
      credentials: 'same-origin',
      referrerPolicy: 'no-referrer'
    })
    if (!current(epoch, scope.identity, scope.key)) return
    const verified = await verifyCatalogExportSnapshot(raw)
    if (!current(epoch, scope.identity, scope.key)) return
    if (JSON.stringify(verified.filters) !== scope.key) throw new Error('export_filters_unconfirmed')
    let bytes: unknown
    if (selectedFormat === 'csv') bytes = await exportCatalogSnapshotCsv(verified)
    else {
      if (!import.meta.client) throw new Error('export_client_unavailable')
      const { exportCatalogSnapshotXlsx } = await import('~/utils/catalog-export-xlsx.client')
      if (!current(epoch, scope.identity, scope.key)) return
      bytes = await exportCatalogSnapshotXlsx(verified)
    }
    if (!current(epoch, scope.identity, scope.key)) return
    const owned = ownedBytes(bytes),
      mime =
        selectedFormat === 'csv'
          ? 'text/csv;charset=utf-8'
          : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      url = URL.createObjectURL(new Blob([owned.buffer], { type: mime }))
    if (!current(epoch, scope.identity, scope.key)) {
      URL.revokeObjectURL(url)
      return
    }
    downloadUrl = url
    const link = window.document.createElement('a')
    link.href = url
    link.download = `neteco-catalogo-snapshot-v1.${selectedFormat}`
    link.referrerPolicy = 'no-referrer'
    window.document.body.appendChild(link)
    try {
      link.click()
    } finally {
      link.remove()
    }
    if (!current(epoch, scope.identity, scope.key)) return
    snapshot.value = verified
    status.value = verified.counts.products === 0 ? 'empty' : 'prepared'
  } catch {
    if (current(epoch, scope.identity, scope.key)) {
      revokeDownload()
      snapshot.value = null
      status.value = 'error'
    }
  } finally {
    if (current(epoch, scope.identity, scope.key)) busy.value = false
  }
}
const countLabels: Record<keyof CatalogExportSnapshot['counts'], string> = {
  products: 'Productos',
  variants: 'Variantes',
  inventory: 'Inventario',
  prices: 'Versiones de precio',
  media: 'Referencias de medios',
  references: 'Referencias de catálogo'
}
const statusLabels = {
  draft: 'Borrador',
  review: 'En revisión',
  published: 'Publicado',
  hidden: 'Oculto',
  discontinued: 'Retirado'
}
</script>

<template>
  <section
    :aria-labelledby="`${prefix}-heading`"
    :aria-busy="busy"
    class="space-y-4 rounded-xl border border-slate-200 bg-white p-5"
  >
    <header>
      <h2 :id="`${prefix}-heading`" class="text-lg font-semibold text-slate-900">Exportar snapshot del catálogo</h2>
      <p class="mt-1 max-w-3xl text-sm text-slate-600">
        Descarga todos los productos que coincidan con los filtros, no sólo la página visible. Es una consulta privada
        de lectura: no modifica el catálogo ni llama a proveedores.
      </p>
    </header>
    <p v-if="!enabled" data-snapshot-export-unavailable role="status" class="rounded-lg bg-slate-50 p-3 text-sm">
      La exportación requiere Cloudflare, acceso actual habilitado y una sesión administrativa verificada. Los filtros
      sólo admiten búsqueda, categoría y estado.
    </p>
    <template v-else>
      <form class="flex flex-wrap items-end gap-3" @submit.prevent="download">
        <div>
          <label :for="`${prefix}-format`" class="block text-sm font-medium">Formato del archivo</label>
          <select
            :id="`${prefix}-format`"
            v-model="format"
            data-snapshot-export-format
            :disabled="busy"
            class="mt-1 rounded border border-slate-300 bg-white px-3 py-2 text-sm"
            :aria-describedby="`${prefix}-profile`"
          >
            <option value="csv">CSV completo · entidades y Manifest</option>
            <option value="xlsx">XLSX · seis hojas y Manifest</option>
          </select>
        </div>
        <UButton data-snapshot-export-download type="submit" :disabled="busy">{{
          busy ? 'Preparando snapshot…' : 'Consultar y descargar'
        }}</UButton>
      </form>
      <p :id="`${prefix}-profile`" class="text-sm text-slate-600">
        Perfil nativo de lectura <code>native_catalog_snapshot_v1</code>. No es importable mediante el CSV editorial ni
        el formato heredado. El CSV incluye todas las entidades como <code>sheet,row_index,record_json</code>; XLSX
        contiene las mismas entidades y el Manifest. Los valores JSON conservan tipos y vacíos.
      </p>
      <p class="text-xs text-slate-500">
        Límites: 1.000 productos, 10.000 filas, 8.000.000 bytes y 20.000 caracteres por celda. Si se supera un límite,
        no se descargará un archivo parcial.
      </p>
      <p v-if="status === 'loading'" data-snapshot-export-loading role="status" aria-live="polite" class="text-sm">
        Consultando y verificando el snapshot antes de generar el archivo…
      </p>
      <p
        v-if="status === 'error'"
        data-snapshot-export-error
        role="alert"
        class="rounded-lg bg-amber-50 p-3 text-sm text-amber-900"
      >
        No se ha confirmado un snapshot completo ni su archivo. No hay descarga parcial ni datos anteriores de respaldo.
        Puedes reintentar únicamente con el botón de consulta.
      </p>
      <div v-if="snapshot" data-snapshot-export-result class="space-y-3 rounded-lg border border-slate-200 p-4">
        <p v-if="status === 'empty'" data-snapshot-export-empty role="status" class="text-sm">
          Snapshot válido sin productos que coincidan con estos filtros. El archivo mantiene su Manifest y las
          referencias incluidas.
        </p>
        <p v-else role="status" class="text-sm">
          Archivo preparado para descarga a partir de este snapshot verificado.
        </p>
        <dl class="grid gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt class="font-medium">Observado en D1</dt>
            <dd>
              <time :datetime="snapshot.observedAt">{{ snapshot.observedAt }} · UTC</time>
            </dd>
          </div>
          <div>
            <dt class="font-medium">Ámbito de la consulta</dt>
            <dd>
              Búsqueda: {{ snapshot.filters.q || 'Sin búsqueda' }} · Categoría:
              {{ snapshot.filters.category ?? 'Todas' }} · Estado:
              {{ snapshot.filters.status ? statusLabels[snapshot.filters.status] : 'Todos' }}
            </dd>
          </div>
        </dl>
        <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <div v-for="(label, key) in countLabels" :key="key" class="rounded-lg bg-slate-50 p-3">
            <p class="text-xs text-slate-600">{{ label }}</p>
            <p data-snapshot-export-count class="mt-1 text-lg font-semibold tabular-nums">
              {{ snapshot.counts[key].toLocaleString('es-ES') }}
            </p>
          </div>
        </div>
        <p class="text-xs text-slate-600">
          Refleja la consulta observada, no datos vivos. No acredita precios vigentes, disponibilidad de stock ni
          aprobación de publicación.
        </p>
      </div>
    </template>
  </section>
</template>

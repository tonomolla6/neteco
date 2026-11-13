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
  prices: 'Precios',
  media: 'Imágenes y archivos',
  references: 'Familias, marcas y otros datos'
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
  <section :aria-labelledby="`${prefix}-heading`" :aria-busy="busy" class="adm-card">
    <header class="adm-card__head">
      <div class="min-w-0">
        <h2 :id="`${prefix}-heading`" class="adm-card__title">Exportar el catálogo a un archivo</h2>
        <p class="adm-card__hint">
          Descarga todos los productos que coinciden con la búsqueda y los filtros del listado, no solo la página que
          ves. Es una copia de consulta: no cambia nada en el catálogo.
        </p>
      </div>
    </header>
    <div class="adm-card__body adm-stack">
      <p v-if="!enabled" data-snapshot-export-unavailable role="status" class="adm-help">
        Ahora mismo no puedes exportar: hace falta una sesión de administrador verificada y que la exportación esté
        activada en esta tienda.
      </p>
      <template v-else>
        <form class="flex flex-wrap items-end gap-3" @submit.prevent="download">
          <div class="adm-field">
            <label :for="`${prefix}-format`" class="adm-label">Formato del archivo</label>
            <select
              :id="`${prefix}-format`"
              v-model="format"
              data-snapshot-export-format
              :disabled="busy"
              class="adm-input"
              :aria-describedby="`${prefix}-profile`"
            >
              <option value="csv">CSV · un solo archivo de texto</option>
              <option value="xlsx">Excel (XLSX) · seis hojas</option>
            </select>
          </div>
          <button data-snapshot-export-download type="submit" class="adm-btn adm-btn--primary" :disabled="busy">
            <UIcon name="i-lucide-download" class="size-4 shrink-0" />
            {{ busy ? 'Preparando el archivo…' : 'Descargar' }}
          </button>
        </form>
        <p :id="`${prefix}-profile`" class="adm-help">
          El archivo es una copia completa para consultar o guardar: productos, variantes, stock, precios e imágenes. No
          es importable desde «Importar». Como máximo 1.000 productos y 10.000 filas; si se supera, no se descarga un
          archivo a medias: acota antes la búsqueda o los filtros del listado.
        </p>
        <p v-if="status === 'loading'" data-snapshot-export-loading role="status" aria-live="polite" class="adm-help">
          Preparando y comprobando el archivo…
        </p>
        <p v-if="status === 'error'" data-snapshot-export-error role="alert" class="adm-field__error">
          No se ha podido preparar el archivo completo y no se ha descargado nada. Vuelve a pulsar «Descargar».
        </p>
        <div
          v-if="snapshot"
          data-snapshot-export-result
          class="adm-stack rounded-[var(--radius-surface)] border border-[var(--border)] p-4"
        >
          <p v-if="status === 'empty'" data-snapshot-export-empty role="status" class="text-sm">
            Ningún producto coincide con estos filtros. El archivo se ha descargado igualmente, sin productos.
          </p>
          <p v-else role="status" class="text-sm font-semibold text-[var(--text-strong)]">Archivo descargado.</p>
          <dl class="grid gap-3 text-sm sm:grid-cols-2">
            <div>
              <dt class="adm-help">Datos tomados el</dt>
              <dd>
                <time :datetime="snapshot.observedAt">{{ adminDate(snapshot.observedAt, true) }}</time>
              </dd>
            </div>
            <div>
              <dt class="adm-help">Qué incluye</dt>
              <dd>
                Búsqueda: {{ snapshot.filters.q || 'sin búsqueda' }} · familia:
                {{ snapshot.filters.category == null ? 'todas' : 'la elegida en el listado' }} · estado:
                {{ snapshot.filters.status ? statusLabels[snapshot.filters.status] : 'todos' }}
              </dd>
            </div>
          </dl>
          <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <div
              v-for="(label, key) in countLabels"
              :key="key"
              class="rounded-[var(--radius-control)] bg-[var(--surface-sunken)] px-3 py-2"
            >
              <p class="adm-help">{{ label }}</p>
              <p data-snapshot-export-count class="text-base font-semibold tabular-nums text-[var(--text-strong)]">
                {{ snapshot.counts[key].toLocaleString('es-ES') }}
              </p>
            </div>
          </div>
          <p class="adm-help">
            Refleja el catálogo en ese momento, no datos vivos: los precios, el stock y los estados pueden haber
            cambiado después.
          </p>
        </div>
      </template>
    </div>
  </section>
</template>

<script setup lang="ts">
import {
  ORDER_EXPORT_CONTENT_TYPE,
  ORDER_EXPORT_FILENAME,
  ORDER_EXPORT_HEADERS,
  ORDER_EXPORT_MAX_BYTES,
  ORDER_EXPORT_MAX_ROWS,
  orderExportMetadataSchema,
  orderExportQuerySchema,
  verifyOrderExportCsv
} from '~~/shared/order-export'

const props = defineProps<{ scopeKey: string; enabled: boolean; pending: boolean; appliedQuery: unknown }>()
const emit = defineEmits<{ pending: [value: boolean] }>()
const request = useRequestFetch(),
  prefix = useId()
const visible = computed(() => props.enabled && !props.pending && props.scopeKey.trim().length > 0)
const query = computed(() => orderExportQuerySchema.safeParse(props.appliedQuery))
const queryKey = computed(() => (query.value.success ? JSON.stringify(query.value.data) : null))
const busy = ref(false),
  outcome = ref<'idle' | 'error' | 'success' | 'empty'>('idle'),
  rows = ref(0)
type Read = { controller: AbortController; query: Record<string, string>; bytes: Uint8Array<ArrayBuffer> | null }
let alive = true,
  generation = 0,
  active: Read | null = null,
  downloadUrl: string | null = null
function revoke() {
  if (downloadUrl !== null) URL.revokeObjectURL(downloadUrl)
  downloadUrl = null
}
function discard(read: Read) {
  read.controller.abort()
  for (const key of Object.keys(read.query)) Reflect.deleteProperty(read.query, key)
  read.bytes?.fill(0)
  read.bytes = null
}
function purge() {
  generation++
  if (active) discard(active)
  active = null
  revoke()
  busy.value = false
  emit('pending', false)
  outcome.value = 'idle'
  rows.value = 0
}
watch([() => props.scopeKey, () => props.enabled, () => props.pending, queryKey], purge, { flush: 'sync' })
onBeforeUnmount(() => {
  alive = false
  purge()
})
function current(epoch: number) {
  return alive && epoch === generation && visible.value && query.value.success
}
function headerInteger(headers: Headers, name: string) {
  const value = headers.get(name) ?? ''
  if (!/^(0|[1-9]\d*)$/.test(value)) throw new Error('export_unconfirmed')
  return Number(value)
}
async function download() {
  const parsed = query.value
  if (!visible.value || !parsed.success || busy.value || !alive) return
  const epoch = ++generation,
    read: Read = { controller: new AbortController(), query: { ...parsed.data }, bytes: null }
  active = read
  let ownUrl: string | null = null
  busy.value = true
  emit('pending', true)
  outcome.value = 'idle'
  rows.value = 0
  try {
    // This event-only browser action uses Nuxt's client $fetch (which has raw),
    // not the server-only H3Event$Fetch alternative in useRequestFetch's type.
    const response = await (request as typeof $fetch).raw<ArrayBuffer>('/api/admin/orders/export.csv', {
      method: 'GET',
      query: read.query,
      responseType: 'arrayBuffer',
      retry: 0,
      cache: 'no-store',
      credentials: 'same-origin',
      referrerPolicy: 'no-referrer',
      signal: read.controller.signal
    })
    const buffer: unknown =
      response && typeof response === 'object' ? Object.getOwnPropertyDescriptor(response, '_data')?.value : undefined
    if (!current(epoch)) {
      if (buffer instanceof ArrayBuffer) new Uint8Array(buffer).fill(0)
      return
    }
    if (!(buffer instanceof ArrayBuffer)) throw new Error('export_unconfirmed')
    const received = new Uint8Array(buffer)
    try {
      if (received.byteLength < 1 || received.byteLength > ORDER_EXPORT_MAX_BYTES) throw new Error('export_unconfirmed')
      read.bytes = received.slice()
    } finally {
      received.fill(0)
    }
    const headers = response.headers,
      cache = headers.get('cache-control') ?? ''
    if (
      response.ok !== true ||
      response.status !== 200 ||
      headers.get('content-type')?.toLowerCase() !== ORDER_EXPORT_CONTENT_TYPE ||
      headers.get('content-disposition') !== `attachment; filename="${ORDER_EXPORT_FILENAME}"` ||
      !/\bprivate\b/i.test(cache) ||
      !/\bno-store\b/i.test(cache) ||
      /\bpublic\b/i.test(cache)
    )
      throw new Error('export_unconfirmed')
    const metadata = orderExportMetadataSchema.parse({
      source: headers.get(ORDER_EXPORT_HEADERS.source),
      rows: headerInteger(headers, ORDER_EXPORT_HEADERS.rows),
      bytes: headerInteger(headers, ORDER_EXPORT_HEADERS.bytes)
    })
    verifyOrderExportCsv(read.bytes, metadata)
    if (!current(epoch)) return
    ownUrl = URL.createObjectURL(new Blob([read.bytes.buffer], { type: 'text/csv;charset=utf-8' }))
    downloadUrl = ownUrl
    if (!current(epoch)) return
    const link = document.createElement('a')
    link.href = ownUrl
    link.download = ORDER_EXPORT_FILENAME
    link.referrerPolicy = 'no-referrer'
    document.body.appendChild(link)
    try {
      link.click()
    } finally {
      link.remove()
    }
    if (!current(epoch)) return
    rows.value = metadata.rows
    outcome.value = metadata.rows === 0 ? 'empty' : 'success'
  } catch {
    if (current(epoch)) outcome.value = 'error'
  } finally {
    // The downloaded file is owned by the browser; no CSV, query or object URL
    // is retained in this component after the explicit read completes.
    discard(read)
    if (ownUrl !== null) {
      URL.revokeObjectURL(ownUrl)
      if (downloadUrl === ownUrl) downloadUrl = null
    }
    if (active === read) active = null
    if (current(epoch)) {
      busy.value = false
      emit('pending', false)
    }
  }
}
</script>

<template>
  <section
    v-if="visible"
    :aria-labelledby="`${prefix}-heading`"
    :aria-busy="busy"
    class="min-w-0 space-y-3 rounded-lg border border-slate-200 p-4"
  >
    <h2 :id="`${prefix}-heading`" class="font-semibold">Exportar pedidos</h2>
    <p class="break-words text-sm text-slate-600">
      Descarga CSV de los filtros aplicados, no de los cambios sin aplicar ni sólo de la página visible. Máximo
      {{ ORDER_EXPORT_MAX_ROWS }} pedidos y {{ ORDER_EXPORT_MAX_BYTES / 1_000_000 }} MB; no se truncan resultados.
    </p>
    <button
      type="button"
      data-order-export-download
      :disabled="busy || !query.success"
      class="max-w-full whitespace-normal rounded border px-3 py-2 disabled:opacity-50"
      @click="download"
    >
      Exportar CSV de filtros aplicados
    </button>
    <p v-if="busy" data-order-export-loading role="status">Preparando la descarga privada…</p>
    <p v-else-if="!query.success || outcome === 'error'" data-order-export-error role="alert">
      No se ha podido validar la exportación. No se ha descargado ningún archivo. Revisa el acceso y los filtros
      aplicados; si hay demasiados pedidos, acota la búsqueda antes de volver a exportar.
    </p>
    <p v-else-if="outcome === 'empty'" data-order-export-empty role="status">
      Sin pedidos para estos filtros aplicados. CSV descargado sólo con las columnas.
    </p>
    <p v-else-if="outcome === 'success'" data-order-export-success role="status">
      CSV preparado para descarga: {{ rows }} pedidos.
    </p>
  </section>
</template>

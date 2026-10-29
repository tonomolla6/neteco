<script setup lang="ts">
import { z } from 'zod'
import { catalogImportJobSchema, type CatalogImportJob } from '~~/shared/catalog-import-job'
import { catalogPolicyUuidSchema, catalogPolicyOwnJson } from '~~/shared/catalog-publication-policy'
import {
  catalogImportJobReviewEntrySchema,
  CATALOG_IMPORT_JOB_REVIEW_WARNING_TEXT
} from '~~/shared/catalog-import-job-review'

const props = withDefaults(defineProps<{ runtime: unknown; available?: boolean; job: unknown }>(), { available: false })
const { ready, loggedIn, user } = useUserSession()
const request = useRequestFetch(),
  prefix = useId()
const busy = ref(false),
  feedback = ref(''),
  failedOffset = ref<number | null>(null)
let epoch = 0,
  disposed = false,
  seen = new Set<string>(),
  seenKinds = { products: 0, variants: 0, assets: 0, media: 0 },
  warehouse: string | null = null
const actor = computed(() => {
  const value: unknown = user.value
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const field = (key: string) =>
    Reflect.has(value, key) ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined
  if (field('role') !== 'admin' || field('emailVerified') !== true || field('mfaVerified') !== true) return null
  const parsed = catalogPolicyUuidSchema.safeParse(field('id'))
  return parsed.success ? parsed.data : null
})
const confirmedJob = computed(() => {
  const value = props.job
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of [
      'source',
      'outcome',
      'id',
      'status',
      'createdAt',
      'expiresAt',
      'totalPages',
      'receivedPages',
      'recordCount',
      'hash',
      'counts',
      'policy'
    ])
      Reflect.has(value, key)
    for (const field of ['counts', 'policy']) {
      const nested: unknown = Object.getOwnPropertyDescriptor(value, field)?.value
      if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
        // Descriptors expose raw nested data even through Vue's parent proxy.
        // Validate own JSON before obtaining a dependency-tracking proxy, so
        // conversion cannot evaluate an unconfirmed accessor/prototype hook.
        try {
          catalogPolicyOwnJson(nested)
        } catch {
          continue
        }
        const tracked = reactive(nested)
        Reflect.ownKeys(tracked)
        for (const key of field === 'counts'
          ? ['products', 'variants', 'assets', 'mappings']
          : ['publication', 'media', 'priceStock'])
          Reflect.has(tracked, key)
      }
    }
  }
  const parsed = catalogImportJobSchema.safeParse(value)
  return parsed.success &&
    parsed.data.status === 'ready' &&
    parsed.data.hash !== null &&
    Date.parse(parsed.data.expiresAt) > Date.now()
    ? parsed.data
    : null
})
function freshJob() {
  const parsed = catalogImportJobSchema.safeParse(props.job)
  return parsed.success &&
    parsed.data.status === 'ready' &&
    parsed.data.hash !== null &&
    Date.parse(parsed.data.expiresAt) > Date.now()
    ? parsed.data
    : null
}
function sameJob(value: CatalogImportJob, original: CatalogImportJob) {
  return (
    value.id === original.id &&
    value.hash === original.hash &&
    value.createdAt === original.createdAt &&
    value.expiresAt === original.expiresAt &&
    value.totalPages === original.totalPages &&
    value.receivedPages === original.receivedPages &&
    value.recordCount === original.recordCount &&
    JSON.stringify(value.counts) === JSON.stringify(original.counts) &&
    JSON.stringify(value.policy) === JSON.stringify(original.policy)
  )
}
const enabled = computed(
  () =>
    !disposed &&
    props.runtime === 'cloudflare' &&
    props.available === true &&
    ready.value === true &&
    loggedIn.value === true &&
    actor.value !== null &&
    confirmedJob.value !== null
)

// An endpoint page adds two wrapper levels to the individually bounded DTO.
// Its 2MB private-response cap includes the claimed/after duplication, not a
// smaller replacement for the 20k-cell source contract.
function ownPage(raw: unknown) {
  let nodes = 0,
    bytes = 0
  const visited = new Set<object>(),
    encoder = new TextEncoder()
  function visit(value: unknown, depth: number): unknown {
    if (++nodes > 1_000_000 || depth > 12) throw new Error('review_boundary')
    if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)))
      return value
    if (typeof value === 'string') {
      bytes += encoder.encode(value).byteLength
      if (value.length > 20_000 || bytes > 2_000_000) throw new Error('review_boundary')
      return value
    }
    if (!value || typeof value !== 'object' || visited.has(value)) throw new Error('review_boundary')
    const array = Array.isArray(value),
      prototype = Object.getPrototypeOf(value),
      keys = Reflect.ownKeys(value)
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null)
      throw new Error('review_boundary')
    const length: unknown = array ? Object.getOwnPropertyDescriptor(value, 'length')?.value : null
    if (array && (typeof length !== 'number' || length > 1000 || keys.length !== length + 1))
      throw new Error('review_boundary')
    if (keys.length > 1_000_000 - nodes + 1) throw new Error('review_boundary')
    visited.add(value)
    const output: Record<string, unknown> = Object.create(null),
      items: unknown[] = []
    for (const key of keys) {
      if (array && key === 'length') continue
      if (typeof key !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(key))
        throw new Error('review_boundary')
      bytes += encoder.encode(key).byteLength
      if (key.length > 20_000 || bytes > 2_000_000) throw new Error('review_boundary')
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!
      if (
        !descriptor.enumerable ||
        !Object.hasOwn(descriptor, 'value') ||
        (array && (!/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= Number(length)))
      )
        throw new Error('review_boundary')
      const copied = visit(descriptor.value, depth + 1)
      if (array) items[Number(key)] = copied
      else output[key] = copied
    }
    visited.delete(value)
    return array ? items : output
  }
  const copy = visit(raw, 0)
  if (encoder.encode(JSON.stringify(copy)).byteLength > 2_000_000) throw new Error('review_boundary')
  return copy
}
const reviewSchema = z.preprocess(
  (value) => {
    try {
      return ownPage(value)
    } catch {
      return undefined
    }
  },
  z
    .object({
      source: z.literal('cloudflare'),
      outcome: z.literal('review'),
      jobId: catalogPolicyUuidSchema,
      jobHash: z.string().regex(/^[0-9a-f]{64}$/),
      offset: z.number().int().min(0).max(100_000),
      nextOffset: z.number().int().min(1).max(100_000).nullable(),
      totalEntries: z.number().int().min(1).max(100_000),
      entries: z.array(catalogImportJobReviewEntrySchema).min(1).max(25),
      policy: z
        .object({
          publication: z.literal('draft_only'),
          media: z.literal('pending_verification'),
          priceStock: z.literal('authorized_initialization')
        })
        .strict()
    })
    .strict()
)
type Review = z.infer<typeof reviewSchema>
const page = shallowRef<Review | null>(null),
  binding = shallowRef<CatalogImportJob | null>(null)
function clear() {
  epoch++
  page.value = binding.value = null
  seen = new Set()
  seenKinds = { products: 0, variants: 0, assets: 0, media: 0 }
  warehouse = null
  failedOffset.value = null
  busy.value = false
  feedback.value = ''
}
watch([actor, confirmedJob, () => props.runtime, () => props.available, ready, loggedIn], clear, { flush: 'sync' })
onBeforeUnmount(() => {
  disposed = true
  clear()
})
function current(version: number, identity: string | null, original: CatalogImportJob) {
  if (disposed || !enabled.value || epoch !== version || actor.value !== identity) return false
  const latest = freshJob()
  if (!latest || !sameJob(latest, original)) {
    clear()
    return false
  }
  return true
}
async function load(offset: number) {
  if (!enabled.value || busy.value || !confirmedJob.value || Date.parse(confirmedJob.value.expiresAt) <= Date.now())
    return
  const latest = freshJob()
  if (!latest || (binding.value && !sameJob(latest, binding.value))) {
    clear()
    feedback.value = 'El trabajo ha cambiado o caducado. No se consultará el diff anterior.'
    return
  }
  if (offset !== 0 && offset !== page.value?.nextOffset && offset !== failedOffset.value) return
  const original = binding.value ?? latest,
    version = epoch,
    identity = actor.value
  binding.value = original
  busy.value = true
  page.value = null
  failedOffset.value = offset
  feedback.value = ''
  try {
    const raw: unknown = await request(
      `/api/admin/catalog/import-jobs/${original.id}/review?offset=${offset}&limit=25`,
      { method: 'GET', retry: 0, cache: 'no-store', credentials: 'same-origin', referrerPolicy: 'no-referrer' }
    )
    if (!current(version, identity, original)) return
    const parsed = reviewSchema.parse(raw),
      total = Object.values(original.counts).reduce((sum, count) => sum + count, 0),
      end = offset + parsed.entries.length
    if (
      parsed.jobId !== original.id ||
      parsed.jobHash !== original.hash ||
      parsed.totalEntries !== total ||
      parsed.offset !== offset ||
      end > total ||
      parsed.nextOffset !== (end === total ? null : end) ||
      JSON.stringify(parsed.policy) !== JSON.stringify(original.policy)
    )
      throw new Error('review_binding')
    const keys = parsed.entries.map((entry) => `${entry.kind}:${entry.id}`)
    if (new Set(keys).size !== keys.length || (offset !== 0 && keys.some((key) => seen.has(key))))
      throw new Error('review_duplicates')
    const counts = offset === 0 ? { products: 0, variants: 0, assets: 0, media: 0 } : { ...seenKinds },
      location = offset === 0 ? parsed.entries[0]!.context.warehouseId : warehouse
    for (const entry of parsed.entries) {
      if (entry.context.warehouseId !== location) throw new Error('review_warehouse')
      counts[entry.kind]++
      if (counts[entry.kind] > original.counts[entry.kind === 'media' ? 'mappings' : entry.kind])
        throw new Error('review_counts')
    }
    if (offset === 0) seen = new Set()
    seenKinds = counts
    warehouse = location
    for (const key of keys) seen.add(key)
    page.value = parsed
    failedOffset.value = null
    feedback.value =
      'Diff real confirmado por el servidor. Esta consulta no concede autorización de publicación ni de aplicación.'
  } catch {
    if (current(version, identity, original))
      feedback.value =
        'No se ha confirmado esta página de revisión. Reintenta sólo la misma consulta; no se enviarán cambios.'
  } finally {
    if (epoch === version && !disposed) busy.value = false
  }
}
const warnings = Object.values(CATALOG_IMPORT_JOB_REVIEW_WARNING_TEXT)
function json(value: unknown) {
  return JSON.stringify(value, null, 2)
}
</script>

<template>
  <section
    v-if="enabled"
    class="mt-4 rounded-xl border border-[var(--border)] p-4"
    :aria-busy="busy"
    :aria-labelledby="`${prefix}-title`"
  >
    <h3 :id="`${prefix}-title`" class="font-semibold">Revisar el diff real del trabajo preparado</h3>
    <p class="mt-2 text-sm">
      Sólo lectura: compara las declaraciones del archivo con lo que se crearía. No aplica, revierte ni publica
      productos.
    </p>
    <ul class="mt-2 list-disc pl-5 text-sm">
      <li v-for="warning in warnings" :key="warning">{{ warning }}</li>
    </ul>
    <button type="button" data-review-start :disabled="busy" @click="load(0)">
      Consultar revisión desde el inicio
    </button>
    <button v-if="failedOffset !== null" type="button" data-review-retry :disabled="busy" @click="load(failedOffset)">
      Reintentar la misma página
    </button>
    <p v-if="busy" role="status" aria-live="polite">Consultando una página de revisión…</p>
    <p v-if="feedback" role="status" aria-live="polite" class="mt-2 text-sm">{{ feedback }}</p>
    <div v-if="page" class="mt-3">
      <p data-review-range class="text-sm">
        Entradas {{ page.offset + 1 }}–{{ page.offset + page.entries.length }} de {{ page.totalEntries }}.
      </p>
      <article
        v-for="entry in page.entries"
        :key="`${entry.kind}:${entry.id}`"
        data-review-entry
        class="mt-3 rounded-md border border-[var(--border)] p-3 text-sm"
      >
        <p class="font-medium">{{ entry.kind }} · {{ entry.id }}</p>
        <p>Antes: no existe (null). Después: registro nuevo propuesto, sin autoridad de publicación.</p>
        <template v-if="entry.kind === 'products'">
          <p>Nombre: {{ entry.claimed.name }} → {{ entry.after.name }}.</p>
          <p>Estado declarado: {{ entry.claimed.status }} → {{ entry.after.status }}. Publicado: null.</p>
          <p>
            Fuente: {{ entry.claimed.sourceId }} · {{ entry.claimed.sourceVersion }}. Categoría:
            {{ entry.after.categoryId }} · Marca: {{ entry.after.brandId }}.
          </p>
        </template>
        <template v-else-if="entry.kind === 'variants'">
          <p>
            SKU: {{ entry.claimed.sku }} → {{ entry.after.sku }} · Estado: {{ entry.claimed.status }} →
            {{ entry.after.status }}.
          </p>
          <p>
            Precio bruto: {{ entry.claimed.priceGrossCents }} → {{ entry.after.price.grossCents }} céntimos
            {{ entry.after.price.currency }}; comparación: {{ entry.after.price.compareAtGrossCents ?? 'null' }}.
            Impuesto: {{ entry.after.price.taxClassId }}.
          </p>
          <p>
            Inicio de precio: null, fijado por el servidor al aplicar (server_on_apply); requiere autorización vigente.
          </p>
          <p>
            Almacén: {{ entry.after.inventory.warehouseId }} · Físico: {{ entry.after.inventory.onHand }} · Bloqueado:
            {{ entry.after.inventory.blocked }} · Seguridad: {{ entry.after.inventory.safetyStock }} · Pedidos sin
            stock: {{ entry.after.inventory.backorderAllowed ? 'sí' : 'no' }}.
          </p>
          <p>
            Identificadores: EAN {{ entry.after.ean ?? 'null' }} · GTIN {{ entry.after.gtin ?? 'null' }} · MPN
            {{ entry.after.mpn ?? 'null' }}. Explicación: {{ entry.after.identifierExceptionReason ?? 'null' }} (no
            concede una excepción).
          </p>
        </template>
        <template v-else-if="entry.kind === 'assets'">
          <p>Archivo: {{ entry.claimed.originalName }} · Ruta declarada: {{ entry.claimed.storageKey }}.</p>
          <p>
            Derechos declarados: {{ entry.claimed.rightsStatus }} → {{ entry.after.rightsStatus }} · Análisis declarado:
            {{ entry.claimed.quarantineStatus }} → {{ entry.after.quarantineStatus }}.
          </p>
          <p>
            Upload verificado: null. Descriptor sin verificar; los derechos declarados no acreditan una subida ni
            publicación.
          </p>
        </template>
        <template v-else>
          <p>
            Asociación: producto {{ entry.after.productId }} · variante {{ entry.after.variantId ?? 'null' }} · archivo
            {{ entry.after.assetId }} · rol {{ entry.after.role }} · versión {{ entry.after.version }} · orden
            {{ entry.after.sortOrder }}.
          </p>
          <p>Derechos y análisis: pending. Upload verificado: null; no autoriza publicación.</p>
        </template>
        <details class="mt-2">
          <summary class="cursor-pointer">Todos los campos originales y propuestos (JSON)</summary>
          <p class="mt-2 font-medium">Declarado</p>
          <pre data-review-claimed class="max-h-80 overflow-auto whitespace-pre-wrap break-all">{{
            json(entry.claimed)
          }}</pre>
          <p class="mt-2 font-medium">Después propuesto</p>
          <pre data-review-after class="max-h-80 overflow-auto whitespace-pre-wrap break-all">{{
            json(entry.after)
          }}</pre>
        </details>
      </article>
      <button
        type="button"
        data-review-next
        :disabled="busy || page.nextOffset === null"
        @click="page.nextOffset !== null && load(page.nextOffset)"
      >
        Consultar página siguiente
      </button>
    </div>
  </section>
</template>

<script setup lang="ts">
import type { D1CatalogPublicationReadiness } from '~~/workers/catalog/catalog-publication-readiness'

const props = defineProps<{
  productId: string
  productUuid: string
  catalogVersion: number
  runtime: unknown
  authorize: (identity: { id: number; uuid: string; version: number }) => boolean
}>()
const requestedProductId = props.productId
const identity = { id: Number(props.productId), uuid: props.productUuid, version: props.catalogVersion }
const authorized = computed(
  () =>
    props.runtime === 'cloudflare' &&
    /^[1-9]\d{0,15}$/.test(requestedProductId) &&
    Number.isSafeInteger(identity.id) &&
    typeof identity.uuid === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identity.uuid) &&
    Number.isSafeInteger(identity.version) &&
    identity.version >= 1 &&
    props.productId === requestedProductId &&
    props.productUuid === identity.uuid &&
    props.catalogVersion === identity.version &&
    props.authorize(identity)
)
const { data, status, refresh } = await useFetch<D1CatalogPublicationReadiness>(
  `/api/admin/products/${requestedProductId}/publication-readiness`,
  {
    key: `admin-product-publication-readiness-${requestedProductId}-${identity.uuid}-${identity.version}`,
    method: 'GET',
    immediate: authorized.value,
    server: authorized.value,
    watch: false
  }
)

function ownData(value: unknown, fields: string[]): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    fields.every((field) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, field)
      return field in value && !!descriptor && Object.hasOwn(descriptor, 'value')
    })
  )
}
function validIssues(value: unknown): value is D1CatalogPublicationReadiness['issues'] {
  return (
    Array.isArray(value) &&
    value.every(
      (issue) =>
        ownData(issue, ['code', 'path', 'message']) &&
        typeof issue.code === 'string' &&
        issue.code.trim().length > 0 &&
        typeof issue.path === 'string' &&
        issue.path.trim().length > 0 &&
        typeof issue.message === 'string' &&
        issue.message.trim().length > 0
    )
  )
}
function canonicalInstant(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(value)) return false
  const parsed = new Date(value)
  if (!Number.isFinite(parsed.getTime())) return false
  const canonical = parsed.toISOString()
  return value === canonical || (canonical.endsWith('.000Z') && value === canonical.replace('.000Z', 'Z'))
}
const snapshot = computed(() => {
  const value = data.value
  if (
    !authorized.value ||
    status.value !== 'success' ||
    !ownData(value, [
      'source',
      'advisory',
      'publicationEnabled',
      'productId',
      'productUuid',
      'catalogVersion',
      'evaluatedAt',
      'issues',
      'limitations'
    ]) ||
    value.source !== 'cloudflare' ||
    value.advisory !== true ||
    value.publicationEnabled !== false ||
    value.productId !== identity.id ||
    value.productUuid !== identity.uuid ||
    value.catalogVersion !== identity.version ||
    !canonicalInstant(value.evaluatedAt) ||
    !validIssues(value.issues) ||
    !validIssues(value.limitations)
  )
    return null
  const result: D1CatalogPublicationReadiness = {
    source: 'cloudflare',
    advisory: true,
    publicationEnabled: false,
    productId: identity.id,
    productUuid: identity.uuid,
    catalogVersion: identity.version,
    evaluatedAt: value.evaluatedAt,
    issues: value.issues,
    limitations: value.limitations
  }
  return result
})
const retrying = ref(false)
const loading = computed(
  () => authorized.value && (retrying.value || status.value === 'idle' || status.value === 'pending')
)
let active = true
onBeforeUnmount(() => {
  active = false
})
async function retry() {
  // Recheck the parent's current DTO/capability even before queued prop updates render.
  if (
    !active ||
    retrying.value ||
    status.value === 'pending' ||
    status.value === 'idle' ||
    !authorized.value ||
    !props.authorize(identity)
  )
    return
  retrying.value = true
  try {
    await refresh()
  } catch {
    // Do not reflect provider errors or private details.
  } finally {
    retrying.value = false
  }
}
const evaluatedAt = computed(() =>
  snapshot.value
    ? new Intl.DateTimeFormat('es-ES', {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone: 'UTC'
      }).format(new Date(snapshot.value.evaluatedAt)) + ' UTC'
    : ''
)
</script>

<template>
  <section
    class="mb-6 rounded-xl border border-slate-200 p-5"
    aria-labelledby="publication-readiness-heading"
    :aria-busy="loading"
  >
    <h2 id="publication-readiness-heading" class="text-lg font-semibold">Comprobación informativa de publicación</h2>
    <p class="mt-2 text-sm text-slate-600">
      Esta consulta es informativa: no permite publicar ni acredita que el producto esté listo para publicación.
    </p>
    <p v-if="loading" role="status" class="mt-4 text-sm">Consultando incidencias y limitaciones…</p>
    <template v-else-if="snapshot">
      <p role="status" class="mt-4 text-sm text-slate-600">
        Versión {{ snapshot.catalogVersion }} · Evaluado el
        <time :datetime="snapshot.evaluatedAt">{{ evaluatedAt }}</time
        >.
      </p>
      <h3 class="mt-4 font-semibold">Incidencias observadas</h3>
      <ul v-if="snapshot.issues.length" class="mt-2 space-y-3">
        <li v-for="(issue, index) in snapshot.issues" :key="`${issue.code}:${issue.path}:${index}`">
          <p>{{ issue.message }}</p>
          <p class="text-xs text-slate-500">
            <code>{{ issue.code }}</code> · <code>{{ issue.path }}</code>
          </p>
        </li>
      </ul>
      <p v-else class="mt-2 text-sm">
        No se han observado incidencias en estas comprobaciones. Esto no confirma completitud ni habilita publicación.
      </p>
      <h3 class="mt-4 font-semibold">Limitaciones de esta consulta</h3>
      <ul v-if="snapshot.limitations.length" class="mt-2 space-y-3">
        <li v-for="(limitation, index) in snapshot.limitations" :key="`${limitation.code}:${limitation.path}:${index}`">
          <p>{{ limitation.message }}</p>
          <p class="text-xs text-slate-500">
            <code>{{ limitation.code }}</code> · <code>{{ limitation.path }}</code>
          </p>
        </li>
      </ul>
      <p v-else class="mt-2 text-sm">
        La ausencia de limitaciones enumeradas no acredita aprobación ni sustituye la validación de publicación.
      </p>
    </template>
    <template v-else>
      <p role="alert" class="mt-4 text-sm">
        No hemos podido obtener una consulta válida para la versión actual del producto.
      </p>
      <UButton v-if="authorized" type="button" class="mt-3" color="neutral" variant="outline" @click="retry"
        >Reintentar consulta</UButton
      >
    </template>
  </section>
</template>

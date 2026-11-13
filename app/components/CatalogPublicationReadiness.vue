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
const evaluatedAt = computed(() => (snapshot.value ? adminDate(snapshot.value.evaluatedAt, true) : ''))
</script>

<template>
  <AdminCard
    aria-labelledby="publication-readiness-heading"
    :aria-busy="loading"
    description="Revisión orientativa de lo que le falta a la ficha: no permite publicar ni garantiza que el producto esté listo."
  >
    <template #title><span id="publication-readiness-heading">Comprobación informativa de publicación</span></template>
    <template v-if="snapshot || (!loading && authorized)" #actions>
      <button
        v-if="!snapshot && !loading && authorized"
        type="button"
        class="adm-btn adm-btn--secondary adm-btn--sm"
        @click="retry"
      >
        Reintentar consulta
      </button>
      <AdminBadge v-else-if="snapshot" :tone="snapshot.issues.length ? 'warning' : 'neutral'">
        {{
          snapshot.issues.length
            ? `${snapshot.issues.length} ${snapshot.issues.length === 1 ? 'pendiente' : 'pendientes'}`
            : 'Sin pendientes'
        }}
      </AdminBadge>
    </template>
    <p v-if="loading" role="status" class="adm-help">Consultando incidencias y limitaciones…</p>
    <div v-else-if="snapshot" class="adm-stack">
      <p role="status" class="adm-help">
        Versión {{ snapshot.catalogVersion }} de la ficha · comprobada el
        <time :datetime="snapshot.evaluatedAt">{{ evaluatedAt }}</time
        >.
      </p>
      <div>
        <h3 class="adm-label">Incidencias observadas</h3>
        <ul v-if="snapshot.issues.length" class="adm-list">
          <li v-for="(issue, index) in snapshot.issues" :key="`${issue.code}:${issue.path}:${index}`">
            <p>{{ issue.message }}</p>
          </li>
        </ul>
        <p v-else class="adm-help">
          No se han observado incidencias en esta revisión. Esto no confirma completitud ni habilita publicación: la
          tienda vuelve a validar la ficha al publicar.
        </p>
      </div>
      <div>
        <h3 class="adm-label">Limitaciones de esta consulta</h3>
        <ul v-if="snapshot.limitations.length" class="adm-list">
          <li
            v-for="(limitation, index) in snapshot.limitations"
            :key="`${limitation.code}:${limitation.path}:${index}`"
          >
            <p>{{ limitation.message }}</p>
          </li>
        </ul>
        <p v-else class="adm-help">Esta revisión no sustituye la validación final que se hace al publicar.</p>
      </div>
    </div>
    <UAlert
      v-else
      role="alert"
      color="warning"
      variant="subtle"
      title="No hemos podido obtener una consulta válida para la versión actual del producto."
    />
  </AdminCard>
</template>

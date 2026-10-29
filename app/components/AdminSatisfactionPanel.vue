<script setup lang="ts">
import {
  adminSatisfactionQuerySchema,
  adminSatisfactionResponseSchema,
  type AdminSatisfactionResponse
} from '~~/shared/support-satisfaction'
import { supportCategoryLabels } from './support/labels'
const props = defineProps<{ scopeKey: string; enabled: boolean; pending: boolean }>()
const filters = reactive({ source: '', category: '', shippingMethod: '', score: '', comments: false })
const snapshot = shallowRef<AdminSatisfactionResponse | null>(null),
  loading = ref(false),
  failed = ref(false)
type Query = Record<string, string | number>
const applied = shallowRef<Query>({ page: 1, perPage: 20, comments: 'false' })
const shipping = { pickup: 'Recogida', own_delivery: 'Reparto propio', parcel: 'Paquetería' }
let active = true,
  generation = 0,
  controller: AbortController | null = null
const authorized = () => active && props.enabled && !!props.scopeKey
function purge() {
  generation++
  controller?.abort()
  controller = null
  snapshot.value = null
  loading.value = failed.value = false
  filters.source = filters.category = filters.shippingMethod = filters.score = ''
  filters.comments = false
  applied.value = { page: 1, perPage: 20, comments: 'false' }
}
async function read(query = applied.value) {
  if (!authorized() || props.pending || loading.value) return
  const parsedQuery = adminSatisfactionQuerySchema.safeParse(query)
  if (!parsedQuery.success) {
    failed.value = true
    snapshot.value = null
    return
  }
  const epoch = generation
  loading.value = true
  failed.value = false
  snapshot.value = null
  applied.value = { ...query }
  controller = new AbortController()
  try {
    const parsed = adminSatisfactionResponseSchema.safeParse(
      await $fetch<unknown>('/api/admin/support/satisfaction', {
        query,
        retry: 0,
        cache: 'no-store',
        signal: controller.signal
      })
    )
    if (!authorized() || epoch !== generation) return
    if (
      !parsed.success ||
      parsed.data.page !== parsedQuery.data.page ||
      parsed.data.perPage !== parsedQuery.data.perPage ||
      parsed.data.commentsIncluded !== parsedQuery.data.comments
    )
      throw new Error('unconfirmed_satisfaction_summary')
    snapshot.value = parsed.data
  } catch {
    if (authorized() && epoch === generation) failed.value = true
  } finally {
    if (authorized() && epoch === generation) loading.value = false
  }
}
function apply() {
  const query: Query = { page: 1, perPage: 20, comments: String(filters.comments) }
  for (const [key, value] of Object.entries(filters)) if (key !== 'comments' && value !== '') query[key] = String(value)
  void read(query)
}
function move(delta: number) {
  const page = Number(applied.value.page) + delta
  if (!snapshot.value || page < 1 || page > Math.ceil(snapshot.value.total / snapshot.value.perPage)) return
  void read({ ...applied.value, page })
}
watch(
  () => [props.scopeKey, props.enabled],
  () => {
    purge()
    if (authorized() && !props.pending) void read()
  },
  { immediate: true, flush: 'sync' }
)
watch(
  () => props.pending,
  (value) => {
    if (!value && authorized() && !snapshot.value && !failed.value) void read()
  }
)
onBeforeUnmount(() => {
  purge()
  active = false
})
</script>
<template>
  <section v-if="enabled" aria-label="Satisfacción de clientes" class="min-w-0 space-y-3 rounded border p-4">
    <h2 class="text-lg font-semibold">Satisfacción de clientes</h2>
    <p>
      Valoraciones voluntarias. Los segmentos no identifican clientes; los comentarios sólo se consultan expresamente.
    </p>
    <form data-testid="satisfaction-admin-filters" class="flex flex-wrap gap-3" @submit.prevent="apply">
      <label
        >Servicio<select v-model="filters.source" data-testid="satisfaction-source" :disabled="loading || pending">
          <option value="">Todos</option>
          <option value="support">Soporte</option>
          <option value="delivery">Entrega</option>
        </select></label
      >
      <label
        >Motivo<select v-model="filters.category" data-testid="satisfaction-category" :disabled="loading || pending">
          <option value="">Todos</option>
          <option v-for="(label, key) in supportCategoryLabels" :key="key" :value="key">{{ label }}</option>
        </select></label
      >
      <label
        >Modalidad<select
          v-model="filters.shippingMethod"
          data-testid="satisfaction-shipping"
          :disabled="loading || pending"
        >
          <option value="">Todas</option>
          <option v-for="(label, key) in shipping" :key="key" :value="key">{{ label }}</option>
        </select></label
      >
      <label
        >Puntuación<select
          v-model="filters.score"
          data-testid="satisfaction-score-filter"
          :disabled="loading || pending"
        >
          <option value="">Todas</option>
          <option v-for="value in 5" :key="value" :value="String(value)">{{ value }} de 5</option>
        </select></label
      >
      <label
        ><input
          v-model="filters.comments"
          data-testid="satisfaction-comments-optin"
          type="checkbox"
          :disabled="loading || pending"
        />
        Consultar comentarios privados</label
      >
      <button :disabled="loading || pending" class="rounded border p-2">Aplicar segmentos</button>
    </form>
    <p v-if="loading" role="status">Confirmando valoraciones y permisos actuales…</p>
    <p v-if="failed" role="alert">No se ha confirmado el resumen. Un error no equivale a cero valoraciones.</p>
    <button
      data-testid="satisfaction-admin-refresh"
      :disabled="loading || pending"
      class="rounded border p-2"
      @click="read()"
    >
      Actualizar resumen
    </button>
    <div v-if="snapshot" class="space-y-3">
      <p>
        {{ snapshot.stats.count }} valoraciones · Media:
        {{ snapshot.stats.average === null ? 'Sin valoraciones' : snapshot.stats.average.toFixed(2) + ' de 5' }}
      </p>
      <ul aria-label="Distribución de puntuaciones">
        <li v-for="entry in snapshot.stats.byScore" :key="entry.score">{{ entry.score }} de 5: {{ entry.count }}</li>
      </ul>
      <p v-if="!snapshot.items.length">Consulta confirmada sin valoraciones coincidentes.</p>
      <ul class="space-y-2">
        <li
          v-for="item in snapshot.items"
          :key="item.target.kind + ':' + item.target.id"
          class="min-w-0 break-words rounded border p-3"
        >
          <p>
            {{ item.target.kind === 'support' ? 'Soporte' : 'Entrega' }} · {{ item.target.id }} · {{ item.score }} de 5
            · {{ item.submittedAt }}
          </p>
          <p v-if="item.category">{{ supportCategoryLabels[item.category] }}</p>
          <p v-if="item.shippingMethod">{{ shipping[item.shippingMethod] }}</p>
          <p v-if="snapshot.commentsIncluded && item.comment">{{ item.comment }}</p>
        </li>
      </ul>
      <nav aria-label="Páginas de valoraciones" class="flex flex-wrap gap-3">
        <button
          data-testid="satisfaction-admin-previous"
          :disabled="loading || pending || snapshot.page <= 1"
          @click="move(-1)"
        >
          Anterior</button
        ><span>Página {{ snapshot.page }} · {{ snapshot.total }} resultados</span
        ><button
          data-testid="satisfaction-admin-next"
          :disabled="loading || pending || snapshot.page * snapshot.perPage >= snapshot.total"
          @click="move(1)"
        >
          Siguiente
        </button>
      </nav>
    </div>
  </section>
</template>

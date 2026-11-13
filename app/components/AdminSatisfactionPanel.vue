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
/** Las referencias de entrega son identificadores largos: se enseñan abreviados. */
function shortRef(id: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(id) ? `#${id.slice(0, 8).toUpperCase()}` : id
}
</script>
<template>
  <section v-if="enabled" aria-label="Satisfacción de clientes" class="adm-stack min-w-0">
    <div v-if="snapshot" class="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,2fr)]">
      <AdminStat label="Valoraciones" :value="snapshot.stats.count" icon="i-lucide-message-square-heart" />
      <AdminStat
        label="Nota media"
        :value="
          snapshot.stats.average === null
            ? null
            : snapshot.stats.average.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
        "
        :hint="snapshot.stats.average === null ? 'Sin valoraciones' : 'sobre 5'"
        icon="i-lucide-star"
      />
      <AdminCard title="Reparto de puntuaciones" aria-label="Distribución de puntuaciones">
        <AdminBreakdown
          :items="snapshot.stats.byScore.map((entry) => ({ label: `${entry.score} de 5`, value: entry.count }))"
        />
      </AdminCard>
    </div>

    <div class="adm-card adm-tablecard">
      <div class="adm-tablecard__bar">
        <form data-testid="satisfaction-admin-filters" class="adm-toolbar" @submit.prevent="apply">
          <select
            v-model="filters.source"
            data-testid="satisfaction-source"
            aria-label="Servicio valorado"
            :disabled="loading || pending"
          >
            <option value="">Atención y entregas</option>
            <option value="support">Solo atención</option>
            <option value="delivery">Solo entregas</option>
          </select>
          <select
            v-model="filters.category"
            data-testid="satisfaction-category"
            aria-label="Motivo de la consulta"
            :disabled="loading || pending"
          >
            <option value="">Todos los motivos</option>
            <option v-for="(label, key) in supportCategoryLabels" :key="key" :value="key">{{ label }}</option>
          </select>
          <select
            v-model="filters.shippingMethod"
            data-testid="satisfaction-shipping"
            aria-label="Forma de entrega"
            :disabled="loading || pending"
          >
            <option value="">Todas las entregas</option>
            <option v-for="(label, key) in shipping" :key="key" :value="key">{{ label }}</option>
          </select>
          <select
            v-model="filters.score"
            data-testid="satisfaction-score-filter"
            aria-label="Puntuación"
            :disabled="loading || pending"
          >
            <option value="">Todas las notas</option>
            <option v-for="value in 5" :key="value" :value="String(value)">{{ value }} de 5</option>
          </select>
          <label class="adm-check">
            <input
              v-model="filters.comments"
              data-testid="satisfaction-comments-optin"
              type="checkbox"
              :disabled="loading || pending"
            />
            Ver comentarios
          </label>
          <button :disabled="loading || pending" class="adm-btn adm-btn--secondary">Filtrar</button>
          <div class="adm-toolbar__end">
            <button
              type="button"
              data-testid="satisfaction-admin-refresh"
              :disabled="loading || pending"
              class="adm-btn adm-btn--secondary"
              @click="read()"
            >
              <UIcon name="i-lucide-rotate-cw" class="size-4" />Actualizar
            </button>
          </div>
        </form>
      </div>

      <AdminEmptyState
        v-if="failed"
        role="alert"
        variant="error"
        title="No se han podido cargar las valoraciones"
        description="Puede ser un fallo de conexión o de permisos. Vuelve a intentarlo."
      >
        <AdminButton icon="i-lucide-rotate-cw" :disabled="loading || pending" @click="read()">Reintentar</AdminButton>
      </AdminEmptyState>
      <div v-else-if="loading || !snapshot" class="adm-table-skeleton" aria-busy="true">
        <span v-if="loading" class="sr-only" role="status">Cargando valoraciones…</span>
        <div v-for="row in 4" :key="row"><i /><i /><i /><i /></div>
      </div>
      <template v-else>
        <AdminEmptyState
          v-if="!snapshot.items.length"
          icon="i-lucide-star"
          title="No hay valoraciones con estos filtros"
          description="Los clientes valoran de forma voluntaria al cerrar una consulta o recibir un pedido."
        />
        <div v-else class="adm-table-wrap">
          <table class="adm-table">
            <caption class="sr-only">
              Valoraciones de clientes
            </caption>
            <thead>
              <tr>
                <th scope="col">Servicio</th>
                <th scope="col">Referencia</th>
                <th scope="col" data-numeric>Nota</th>
                <th scope="col">Detalle</th>
                <th v-if="snapshot.commentsIncluded" scope="col">Comentario</th>
                <th scope="col">Fecha</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="item in snapshot.items" :key="item.target.kind + ':' + item.target.id">
                <td>{{ item.target.kind === 'support' ? 'Atención' : 'Entrega' }}</td>
                <td class="tabular-nums">{{ shortRef(item.target.id) }}</td>
                <td data-numeric>
                  <AdminBadge :tone="item.score >= 4 ? 'success' : item.score === 3 ? 'warning' : 'danger'" plain>
                    {{ item.score }} de 5
                  </AdminBadge>
                </td>
                <td>
                  <template v-if="item.category">{{ supportCategoryLabels[item.category] }}</template>
                  <template v-else-if="item.shippingMethod">{{ shipping[item.shippingMethod] }}</template>
                  <template v-else>—</template>
                </td>
                <td v-if="snapshot.commentsIncluded" class="max-w-sm break-words">{{ item.comment ?? '—' }}</td>
                <td class="whitespace-nowrap">{{ adminDate(item.submittedAt, true) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <nav aria-label="Páginas de valoraciones" class="adm-pagination">
          <p>
            {{ snapshot.total }} {{ snapshot.total === 1 ? 'resultado' : 'resultados' }} · página {{ snapshot.page }}
          </p>
          <div class="flex items-center gap-2">
            <button
              type="button"
              data-testid="satisfaction-admin-previous"
              class="adm-btn adm-btn--secondary adm-btn--sm"
              :disabled="loading || pending || snapshot.page <= 1"
              @click="move(-1)"
            >
              Anterior
            </button>
            <button
              type="button"
              data-testid="satisfaction-admin-next"
              class="adm-btn adm-btn--secondary adm-btn--sm"
              :disabled="loading || pending || snapshot.page * snapshot.perPage >= snapshot.total"
              @click="move(1)"
            >
              Siguiente
            </button>
          </div>
        </nav>
      </template>
    </div>
  </section>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'

interface Total {
  scope: 'public' | 'b2b'
  hits: number
  misses: number
  isolationRejections: number
  hitRate: number | null
}

const requestFetch = useRequestFetch()
const loading = ref(true)
const errorMessage = ref('')
const totals = ref<Total[]>([])
const labels: Record<string, string> = { public: 'Catálogo público', b2b: 'Catálogo de profesionales' }

async function load() {
  loading.value = true
  errorMessage.value = ''
  try {
    const res = (await requestFetch('/api/admin/performance/b2b-cache/stats?days=7')) as { stats: { totals: Total[] } }
    totals.value = res?.stats?.totals ?? []
  } catch {
    errorMessage.value = 'Vuelve a intentarlo en unos segundos.'
  } finally {
    loading.value = false
  }
}
onMounted(load)
</script>

<template>
  <section class="adm-stack" aria-label="Caché del catálogo para profesionales" data-b2b-cache-panel>
    <AdminCard v-if="errorMessage" role="alert" data-error>
      <AdminEmptyState
        compact
        variant="error"
        title="No hemos podido cargar los datos de caché"
        :description="errorMessage"
      >
        <button type="button" class="adm-btn adm-btn--secondary" data-retry @click="load">
          <UIcon name="i-lucide-rotate-cw" class="size-4 shrink-0" />
          Reintentar
        </button>
      </AdminEmptyState>
    </AdminCard>
    <div v-if="loading" class="adm-grid" data-loading>
      <span class="sr-only">Cargando estadísticas…</span>
      <div
        v-for="row in 2"
        :key="row"
        class="h-28 animate-pulse rounded-[var(--radius-surface)] bg-[var(--surface-sunken)]"
        aria-hidden="true"
      />
    </div>
    <AdminCard v-else-if="!totals.some((t) => t.hits + t.misses > 0) && !errorMessage" data-empty>
      <AdminEmptyState
        compact
        icon="i-lucide-gauge"
        title="Todavía no hay visitas registradas"
        description="Cuando los clientes naveguen por el catálogo verás aquí cuántas páginas se sirven al instante."
      />
    </AdminCard>
    <template v-else-if="!errorMessage || totals.length">
      <p class="adm-help">
        Páginas servidas al instante desde la copia guardada, en los últimos 7 días. Cada empresa y tarifa tiene su
        propia copia: los precios de un cliente nunca se muestran a otro.
      </p>
      <div class="adm-grid">
        <div v-for="t in totals" :key="t.scope" class="adm-card adm-stat" data-cache-total>
          <p class="adm-stat__label">{{ labels[t.scope] }}</p>
          <p class="adm-stat__value" data-hit-rate>
            {{ t.hitRate === null ? 'Sin datos' : `${(t.hitRate * 100).toFixed(1)}%` }}
          </p>
          <p class="adm-stat__foot">
            <span>{{ t.hits }} servidas al instante · {{ t.misses }} generadas de nuevo</span>
          </p>
          <p class="adm-stat__foot" data-rejections>
            <AdminBadge v-if="t.isolationRejections > 0" tone="danger">
              {{ t.isolationRejections }} rechazos de aislamiento
            </AdminBadge>
            <span v-else>{{ t.isolationRejections }} rechazos de aislamiento</span>
          </p>
        </div>
      </div>
    </template>
  </section>
</template>

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
const labels: Record<string, string> = { public: 'Catálogo público', b2b: 'Catálogo B2B (por empresa y tarifa)' }

async function load() {
  loading.value = true
  errorMessage.value = ''
  try {
    const res = (await requestFetch('/api/admin/performance/b2b-cache/stats?days=7')) as { stats: { totals: Total[] } }
    totals.value = res?.stats?.totals ?? []
  } catch {
    errorMessage.value = 'No se pudieron cargar las estadísticas de caché'
  } finally {
    loading.value = false
  }
}
onMounted(load)
</script>

<template>
  <section class="space-y-4" aria-labelledby="b2b-cache-title" data-b2b-cache-panel>
    <div>
      <h2 id="b2b-cache-title" class="text-lg font-semibold text-neutral-900">Caché de catálogo B2B</h2>
      <p class="text-xs text-neutral-600">
        Las claves incluyen empresa, tarifa y versión de tarifa mediante HMAC; nunca se mezclan ámbitos. Últimos 7 días.
      </p>
    </div>
    <div v-if="errorMessage" role="alert" class="rounded bg-red-100 p-3 text-sm text-red-700" data-error>
      {{ errorMessage }} <button type="button" class="ml-2 underline" data-retry @click="load">Reintentar</button>
    </div>
    <p v-if="loading" class="py-4 text-center text-sm text-neutral-500" data-loading>Cargando estadísticas...</p>
    <p
      v-else-if="!totals.some((t) => t.hits + t.misses > 0) && !errorMessage"
      class="py-4 text-center text-sm text-neutral-500"
      data-empty
    >
      Todavía no hay tráfico de caché registrado.
    </p>
    <div v-else class="grid gap-3 sm:grid-cols-2">
      <div
        v-for="t in totals"
        :key="t.scope"
        class="rounded border border-neutral-200 bg-white p-4 text-sm"
        data-cache-total
      >
        <h3 class="font-semibold">{{ labels[t.scope] }}</h3>
        <p class="text-2xl font-bold" data-hit-rate>
          {{ t.hitRate === null ? 's/d' : `${(t.hitRate * 100).toFixed(1)}%` }}
        </p>
        <p class="text-xs text-neutral-600">{{ t.hits }} aciertos · {{ t.misses }} fallos</p>
        <p
          class="text-xs"
          :class="t.isolationRejections > 0 ? 'font-semibold text-red-700' : 'text-neutral-600'"
          data-rejections
        >
          {{ t.isolationRejections }} rechazos de aislamiento
        </p>
      </div>
    </div>
  </section>
</template>

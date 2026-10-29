<script setup lang="ts">
import { ref, onMounted } from 'vue'
import type { SearchAnalyticsDashboardResponse } from '../../workers/analytics/search-analytics'

defineProps<{
  runtime?: unknown
}>()

const requestFetch = useRequestFetch()

const loading = ref(true)
const error = ref<string | null>(null)
const data = ref<SearchAnalyticsDashboardResponse | null>(null)

// Default range: last 30 days
const now = new Date()
const thirtyDaysAgo = new Date(now.getTime() - 30 * 86400000)

const fromDate = ref(thirtyDaysAgo.toISOString().slice(0, 10))
const toDate = ref(now.toISOString().slice(0, 10))
const selectedDevice = ref<'all' | 'desktop' | 'mobile' | 'tablet' | 'unknown'>('all')
const selectedSegment = ref<'all' | 'anonymous' | 'customer' | 'professional'>('all')

async function fetchDashboard() {
  loading.value = true
  error.value = null

  try {
    const fromIso = `${fromDate.value}T00:00:00Z`
    const toIso = `${toDate.value}T23:59:59Z`

    const response = await requestFetch<SearchAnalyticsDashboardResponse>('/api/admin/analytics/search', {
      method: 'GET',
      query: {
        from: fromIso,
        to: toIso,
        device: selectedDevice.value,
        segment: selectedSegment.value,
        page: 1,
        perPage: 50
      }
    })

    data.value = response
  } catch {
    error.value = 'No se ha podido cargar la analítica de búsqueda. Comprueba tus permisos de administración.'
  } finally {
    loading.value = false
  }
}

function formatPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—'
  return `${(value * 100).toFixed(1)}%`
}

onMounted(() => {
  void fetchDashboard()
})
</script>

<template>
  <div class="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8 space-y-8">
    <!-- Header -->
    <div class="border-b border-slate-200 pb-5">
      <div class="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 class="text-2xl font-bold text-slate-900 sm:text-3xl">Analítica de búsqueda</h1>
          <p class="mt-1 text-sm text-slate-600">
            Dashboard de consultas de catálogo, CTR, tasas de añadido al carrito y términos sin resultados.
          </p>
        </div>
        <div class="flex items-center gap-2">
          <NuxtLink
            to="/admin/busqueda"
            class="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50 transition"
          >
            <UIcon name="i-lucide-arrow-left" class="size-4" />
            Relevancia y sinónimos
          </NuxtLink>
        </div>
      </div>
    </div>

    <!-- Filter Bar -->
    <div class="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div class="flex flex-wrap items-end gap-4">
        <div>
          <label for="filter-from" class="block text-xs font-semibold text-slate-600 uppercase tracking-wider mb-1">
            Desde
          </label>
          <input
            id="filter-from"
            v-model="fromDate"
            type="date"
            class="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-800 shadow-sm focus:border-neteco-500 focus:ring-1 focus:ring-neteco-500"
          />
        </div>

        <div>
          <label for="filter-to" class="block text-xs font-semibold text-slate-600 uppercase tracking-wider mb-1">
            Hasta
          </label>
          <input
            id="filter-to"
            v-model="toDate"
            type="date"
            class="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-800 shadow-sm focus:border-neteco-500 focus:ring-1 focus:ring-neteco-500"
          />
        </div>

        <div>
          <label for="filter-device" class="block text-xs font-semibold text-slate-600 uppercase tracking-wider mb-1">
            Dispositivo
          </label>
          <select
            id="filter-device"
            v-model="selectedDevice"
            data-filter="device"
            class="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 shadow-sm focus:border-neteco-500 focus:ring-1 focus:ring-neteco-500"
          >
            <option value="all">Todos los dispositivos</option>
            <option value="desktop">Escritorio (Desktop)</option>
            <option value="mobile">Móvil (Mobile)</option>
            <option value="tablet">Tablet</option>
            <option value="unknown">Otro / Desconocido</option>
          </select>
        </div>

        <div>
          <label for="filter-segment" class="block text-xs font-semibold text-slate-600 uppercase tracking-wider mb-1">
            Segmento
          </label>
          <select
            id="filter-segment"
            v-model="selectedSegment"
            data-filter="segment"
            class="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 shadow-sm focus:border-neteco-500 focus:ring-1 focus:ring-neteco-500"
          >
            <option value="all">Todos los segmentos</option>
            <option value="anonymous">Visitante anónimo</option>
            <option value="customer">Cliente particular</option>
            <option value="professional">Cliente profesional (B2B)</option>
          </select>
        </div>

        <button
          type="button"
          data-action="apply-filters"
          class="inline-flex items-center gap-2 rounded-lg bg-neteco-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-neteco-700 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neteco-500"
          @click="fetchDashboard"
        >
          <UIcon name="i-lucide-filter" class="size-4" />
          Aplicar filtros
        </button>
      </div>
    </div>

    <!-- Error state -->
    <div
      v-if="error"
      role="alert"
      class="rounded-xl border border-red-200 bg-red-50 p-4 text-red-800 flex items-center justify-between"
    >
      <div class="flex items-center gap-3">
        <UIcon name="i-lucide-alert-circle" class="size-5 text-red-600 flex-shrink-0" />
        <span class="text-sm font-medium">{{ error }}</span>
      </div>
      <button type="button" class="text-sm font-semibold underline hover:text-red-900" @click="fetchDashboard">
        Reintentar
      </button>
    </div>

    <!-- Loading state -->
    <div v-if="loading" role="status" class="py-16 text-center text-slate-500">
      <UIcon name="i-lucide-loader-circle" class="size-8 animate-spin mx-auto text-neteco-600" />
      <p class="mt-2 text-sm font-medium">Cargando analítica de búsqueda…</p>
    </div>

    <!-- Main Dashboard Content -->
    <div v-else-if="data" class="space-y-8">
      <!-- KPI Summary Cards -->
      <div class="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
        <!-- Total Searches -->
        <div class="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <p class="text-xs font-semibold text-slate-500 uppercase tracking-wider">Total búsquedas</p>
          <p class="mt-2 text-3xl font-extrabold text-slate-900">{{ data.summary.totalSearches }}</p>
          <p class="mt-1 text-xs text-slate-500">Consultas registradas en el periodo</p>
        </div>

        <!-- Zero Results -->
        <div class="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <p class="text-xs font-semibold text-slate-500 uppercase tracking-wider">Sin resultados</p>
          <p class="mt-2 text-3xl font-extrabold text-amber-600">{{ data.summary.totalZeroResults }}</p>
          <p class="mt-1 text-xs text-slate-500">
            {{
              data.summary.totalSearches > 0
                ? ((data.summary.totalZeroResults / data.summary.totalSearches) * 100).toFixed(1)
                : '0'
            }}% del total de búsquedas
          </p>
        </div>

        <!-- Global CTR -->
        <div class="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <p class="text-xs font-semibold text-slate-500 uppercase tracking-wider">CTR medio (Clics)</p>
          <p class="mt-2 text-3xl font-extrabold text-slate-900">
            <template v-if="data.summary.globalCtr !== null">{{ formatPercent(data.summary.globalCtr) }}</template>
            <template v-else><span class="text-slate-400 text-xl font-normal">—</span></template>
          </p>
          <p class="mt-1 text-xs text-slate-500">
            {{ data.summary.totalClicks }} clics registrados
            <span v-if="data.summary.globalCtr === null" class="text-amber-600 ml-1">(&lt; 20 búsquedas)</span>
          </p>
        </div>

        <!-- Global Add-to-cart rate -->
        <div class="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <p class="text-xs font-semibold text-slate-500 uppercase tracking-wider">Tasa Add-to-Cart</p>
          <p class="mt-2 text-3xl font-extrabold text-slate-900">
            <template v-if="data.summary.globalAddToCartRate !== null">{{
              formatPercent(data.summary.globalAddToCartRate)
            }}</template>
            <template v-else><span class="text-slate-400 text-xl font-normal">—</span></template>
          </p>
          <p class="mt-1 text-xs text-slate-500">
            {{ data.summary.totalAddToCart }} añadidos al carrito
            <span v-if="data.summary.globalAddToCartRate === null" class="text-amber-600 ml-1"
              >(&lt; 20 búsquedas)</span
            >
          </p>
        </div>
      </div>

      <!-- Threshold Explanation Banner -->
      <div class="rounded-lg border border-sky-100 bg-sky-50/70 p-4 text-xs text-sky-900 flex items-start gap-3">
        <UIcon name="i-lucide-info" class="size-4 text-sky-600 flex-shrink-0 mt-0.5" />
        <div>
          <span class="font-semibold">Umbral mínimo de muestra estadísticamente representativa:</span>
          Para garantizar la fiabilidad estadística y proteger la privacidad de los usuarios, las tasas de conversión
          (CTR y Añadido al carrito) sólo se calculan cuando una consulta acumula al menos
          <span class="font-bold text-sky-950">20 búsquedas</span>. Las consultas con muestra inferior se identifican
          con «— (Muestra insuficiente &lt; 20)».
        </div>
      </div>

      <!-- Top Queries Table -->
      <div class="rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden">
        <div class="border-b border-slate-200 bg-slate-50/75 px-6 py-4">
          <h2 class="text-base font-bold text-slate-900">Consultas más frecuentes</h2>
          <p class="text-xs text-slate-500 mt-0.5">Términos buscados ordenados por volumen de peticiones.</p>
        </div>

        <div v-if="data.topQueries.length === 0" class="p-8 text-center text-sm text-slate-500">
          No hay datos de búsquedas registrados para el periodo y filtros seleccionados.
        </div>

        <div v-else class="overflow-x-auto">
          <table class="min-w-full divide-y divide-slate-200 text-left text-sm">
            <thead class="bg-slate-50 text-xs font-semibold text-slate-600 uppercase tracking-wider">
              <tr>
                <th scope="col" class="px-6 py-3">Término normalizado</th>
                <th scope="col" class="px-4 py-3 text-right">Búsquedas</th>
                <th scope="col" class="px-4 py-3 text-right">Clics</th>
                <th scope="col" class="px-4 py-3 text-right">CTR</th>
                <th scope="col" class="px-4 py-3 text-right">Carrito</th>
                <th scope="col" class="px-4 py-3 text-right">Tasa Carrito</th>
                <th scope="col" class="px-4 py-3 text-center">Muestra</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-200 bg-white">
              <tr v-for="q in data.topQueries" :key="q.term" class="hover:bg-slate-50/50 transition">
                <td class="px-6 py-3.5 font-medium text-slate-900">{{ q.term }}</td>
                <td class="px-4 py-3.5 text-right font-semibold text-slate-800">{{ q.searches }}</td>
                <td class="px-4 py-3.5 text-right text-slate-600">{{ q.clicks }}</td>
                <td class="px-4 py-3.5 text-right font-medium">
                  <span v-if="q.hasSufficientSample" class="text-slate-900">{{ formatPercent(q.ctr) }}</span>
                  <span v-else class="text-slate-400 font-normal" title="Muestra insuficiente (&lt; 20 búsquedas)"
                    >—</span
                  >
                </td>
                <td class="px-4 py-3.5 text-right text-slate-600">{{ q.addToCart }}</td>
                <td class="px-4 py-3.5 text-right font-medium">
                  <span v-if="q.hasSufficientSample" class="text-slate-900">{{ formatPercent(q.addToCartRate) }}</span>
                  <span v-else class="text-slate-400 font-normal" title="Muestra insuficiente (&lt; 20 búsquedas)"
                    >—</span
                  >
                </td>
                <td class="px-4 py-3.5 text-center">
                  <span
                    v-if="q.hasSufficientSample"
                    class="inline-flex items-center rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700"
                  >
                    Válida
                  </span>
                  <span
                    v-else
                    class="inline-flex items-center rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700"
                  >
                    &lt; 20
                  </span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- Zero Results Queries Table with Remediation Links -->
      <div class="rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden">
        <div
          class="border-b border-slate-200 bg-slate-50/75 px-6 py-4 flex flex-wrap items-center justify-between gap-2"
        >
          <div>
            <h2 class="text-base font-bold text-slate-900">Búsquedas sin resultados</h2>
            <p class="text-xs text-slate-500 mt-0.5">
              Consultas en las que el cliente no encontró productos. Actúa creando un sinónimo o regla de merchandising.
            </p>
          </div>
          <span
            class="inline-flex items-center rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-semibold text-amber-800"
          >
            {{ data.zeroResultQueries.length }} términos
          </span>
        </div>

        <div v-if="data.zeroResultQueries.length === 0" class="p-8 text-center text-sm text-slate-500">
          No se han detectado búsquedas con cero resultados en este periodo.
        </div>

        <div v-else class="overflow-x-auto">
          <table class="min-w-full divide-y divide-slate-200 text-left text-sm">
            <thead class="bg-slate-50 text-xs font-semibold text-slate-600 uppercase tracking-wider">
              <tr>
                <th scope="col" class="px-6 py-3">Término buscado</th>
                <th scope="col" class="px-4 py-3 text-right">Ocurrencias sin resultados</th>
                <th scope="col" class="px-6 py-3 text-right">Acciones recomendadas</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-200 bg-white">
              <tr v-for="zq in data.zeroResultQueries" :key="zq.term" class="hover:bg-slate-50/50 transition">
                <td class="px-6 py-3.5 font-medium text-slate-900">{{ zq.term }}</td>
                <td class="px-4 py-3.5 text-right font-semibold text-amber-700">{{ zq.zeroResults }}</td>
                <td class="px-6 py-3.5 text-right space-x-2">
                  <NuxtLink
                    :to="zq.synonymUrl"
                    class="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 hover:text-neteco-600 transition"
                  >
                    <UIcon name="i-lucide-arrow-left-right" class="size-3.5 text-slate-400" />
                    Crear sinónimo
                  </NuxtLink>
                  <NuxtLink
                    :to="zq.merchandisingUrl"
                    class="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 hover:text-neteco-600 transition"
                  >
                    <UIcon name="i-lucide-sparkles" class="size-3.5 text-slate-400" />
                    Crear regla
                  </NuxtLink>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </div>
</template>

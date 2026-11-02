<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { SeoContentDashboardResponse, SeoDevice } from '~~/shared/seo-content-dashboard'

const props = defineProps<{ runtime: unknown }>()
const { ready, loggedIn, user } = useUserSession()
const requestFetch = useRequestFetch()

const fromDate = ref('')
const toDate = ref('')
const selectedDevice = ref<SeoDevice>('all')
const landingFilter = ref('')
const queryFilter = ref('')

const loading = ref(false)
const error = ref<string | null>(null)
const data = ref<SeoContentDashboardResponse | null>(null)

const isAuthorized = computed(() => {
  return (
    props.runtime === 'cloudflare' &&
    ready.value === true &&
    loggedIn.value === true &&
    user.value?.emailVerified === true &&
    user.value?.mfaVerified === true
  )
})

function formatEuros(cents: number | null | undefined): string {
  if (cents === null || cents === undefined || Number.isNaN(cents)) return '0,00 €'
  return `${(cents / 100).toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`
}

function formatPercent(rate: number | null | undefined): string {
  if (rate === null || rate === undefined || Number.isNaN(rate)) return '0,0%'
  return `${(rate * 100).toFixed(1)}%`
}

function formatInteger(num: number | null | undefined): string {
  if (num === null || num === undefined || Number.isNaN(num)) return '0'
  return num.toLocaleString('es-ES')
}

async function fetchDashboard() {
  if (!isAuthorized.value) return
  loading.value = true
  error.value = null

  try {
    const params = new URLSearchParams()
    if (fromDate.value) params.set('from', fromDate.value)
    if (toDate.value) params.set('to', toDate.value)
    if (selectedDevice.value && selectedDevice.value !== 'all') params.set('device', selectedDevice.value)
    if (landingFilter.value) params.set('landingPath', landingFilter.value)
    if (queryFilter.value) params.set('query', queryFilter.value)

    const response = await requestFetch<SeoContentDashboardResponse>(
      `/api/admin/seo/dashboard${params.toString() ? `?${params.toString()}` : ''}`,
      { method: 'GET' }
    )
    data.value = response
  } catch (err: unknown) {
    error.value = err instanceof Error ? err.message : 'Error al cargar el panel de SEO y contenido'
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  if (isAuthorized.value) {
    void fetchDashboard()
  }
})
</script>

<template>
  <div class="space-y-6">
    <!-- Header -->
    <div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <h2 class="text-xl font-bold text-slate-900 flex items-center gap-2">
          SEO & Contenido: Rendimiento, Revenue Asistido y Costes
          <span class="rounded bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-800">DAT-019</span>
        </h2>
        <p class="text-sm text-slate-500">
          Impresiones, clicks, consultas, páginas de destino, revenue asistido, actualización y coste editorial (no solo
          sesiones).
        </p>
      </div>

      <button
        type="button"
        class="inline-flex items-center justify-center rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-emerald-700 disabled:opacity-50"
        :disabled="loading || !isAuthorized"
        data-testid="seo-refresh"
        @click="fetchDashboard"
      >
        <span v-if="loading">Cargando...</span>
        <span v-else>Actualizar</span>
      </button>
    </div>

    <!-- Filtros -->
    <div class="rounded-xl border border-slate-200 bg-white p-4 shadow-sm space-y-4">
      <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <div>
          <label for="seo-from-date" class="block text-xs font-medium text-slate-700">Desde</label>
          <input
            id="seo-from-date"
            v-model="fromDate"
            type="date"
            class="mt-1 block w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
          />
        </div>
        <div>
          <label for="seo-to-date" class="block text-xs font-medium text-slate-700">Hasta</label>
          <input
            id="seo-to-date"
            v-model="toDate"
            type="date"
            class="mt-1 block w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
          />
        </div>
        <div>
          <label for="seo-device-filter" class="block text-xs font-medium text-slate-700">Dispositivo</label>
          <select
            id="seo-device-filter"
            v-model="selectedDevice"
            data-testid="seo-filter-device"
            class="mt-1 block w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
          >
            <option value="all">Todos los dispositivos</option>
            <option value="desktop">Desktop</option>
            <option value="mobile">Móvil</option>
            <option value="tablet">Tablet</option>
          </select>
        </div>
        <div>
          <label for="seo-query-filter" class="block text-xs font-medium text-slate-700">Consulta</label>
          <input
            id="seo-query-filter"
            v-model="queryFilter"
            type="text"
            placeholder="Buscar query..."
            class="mt-1 block w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
          />
        </div>
        <div class="flex items-end">
          <button
            type="button"
            data-testid="seo-filter-submit"
            class="w-full rounded-md bg-slate-100 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-200"
            @click="fetchDashboard"
          >
            Filtrar
          </button>
        </div>
      </div>
    </div>

    <!-- Error State -->
    <div v-if="error" class="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
      {{ error }}
    </div>

    <!-- Data Display -->
    <div v-if="data" class="space-y-6">
      <!-- Sync Status Badge -->
      <div
        class="flex items-center justify-between rounded-lg bg-slate-50 p-3 text-xs text-slate-600 border border-slate-200"
      >
        <div>
          Estado de sincronización:
          <span
            :class="[
              'font-semibold px-2 py-0.5 rounded',
              data.syncStatus.status === 'synced' ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'
            ]"
          >
            {{ data.syncStatus.status === 'synced' ? 'Sincronizado' : 'Pendiente' }}
          </span>
          <span v-if="data.syncStatus.dataThroughDate" class="ml-2">
            (Datos hasta: {{ data.syncStatus.dataThroughDate }})
          </span>
        </div>
        <div v-if="data.syncStatus.lastSyncAt">
          Última actualización: {{ new Date(data.syncStatus.lastSyncAt).toLocaleString('es-ES') }}
        </div>
      </div>

      <!-- KPI Summary Cards -->
      <div class="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
        <div class="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <span class="text-xs font-medium text-slate-500">Impresiones</span>
          <p class="mt-1 text-2xl font-bold text-slate-900" data-testid="seo-kpi-impressions">
            {{ formatInteger(data.summary.totalImpressions) }}
          </p>
        </div>

        <div class="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <span class="text-xs font-medium text-slate-500">Clicks (CTR)</span>
          <p class="mt-1 text-2xl font-bold text-slate-900" data-testid="seo-kpi-clicks">
            {{ formatInteger(data.summary.totalClicks) }}
          </p>
          <span class="text-xs text-slate-500">CTR: {{ formatPercent(data.summary.overallCtr) }}</span>
        </div>

        <div class="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <span class="text-xs font-medium text-slate-500">Posición Media</span>
          <p class="mt-1 text-2xl font-bold text-slate-900">
            {{ data.summary.avgPosition > 0 ? data.summary.avgPosition.toFixed(1) : '-' }}
          </p>
        </div>

        <div class="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <span class="text-xs font-medium text-slate-500">Revenue Asistido</span>
          <p class="mt-1 text-2xl font-bold text-emerald-600" data-testid="seo-kpi-assisted-revenue">
            {{ formatEuros(data.summary.assistedRevenueNetCents) }}
          </p>
          <span class="text-xs text-slate-500">{{ data.summary.assistedOrdersCount }} pedidos</span>
        </div>

        <div class="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <span class="text-xs font-medium text-slate-500">Coste Contenido</span>
          <p class="mt-1 text-2xl font-bold text-slate-900" data-testid="seo-kpi-content-cost">
            {{ formatEuros(data.summary.totalContentCostCents) }}
          </p>
        </div>

        <div class="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <span class="text-xs font-medium text-slate-500">SEO ROI</span>
          <p class="mt-1 text-2xl font-bold text-indigo-600" data-testid="seo-kpi-roi">
            {{ data.summary.seoRoi > 0 ? `${data.summary.seoRoi.toFixed(2)}x` : '-' }}
          </p>
          <span class="text-xs text-slate-500">Retorno / coste</span>
        </div>
      </div>

      <!-- Landings Table -->
      <div
        class="rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden"
        data-testid="seo-landings-table"
      >
        <div class="border-b border-slate-200 bg-slate-50 px-4 py-3">
          <h3 class="text-sm font-semibold text-slate-900">Páginas de Destino (Landings) y Atribución</h3>
        </div>
        <div class="overflow-x-auto">
          <table class="min-w-full divide-y divide-slate-200 text-sm">
            <thead class="bg-slate-50 text-xs font-medium text-slate-500 uppercase tracking-wider text-left">
              <tr>
                <th class="px-4 py-3">Página de destino</th>
                <th class="px-4 py-3 text-right">Impresiones</th>
                <th class="px-4 py-3 text-right">Clicks</th>
                <th class="px-4 py-3 text-right">CTR</th>
                <th class="px-4 py-3 text-right">Pos. Media</th>
                <th class="px-4 py-3 text-right">Revenue Asistido</th>
                <th class="px-4 py-3 text-right">Coste</th>
                <th class="px-4 py-3 text-right">ROI</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-200 bg-white">
              <tr v-for="landing in data.landingPages" :key="landing.landingPath" class="hover:bg-slate-50">
                <td class="px-4 py-3 font-mono text-xs text-slate-900 truncate max-w-xs">{{ landing.landingPath }}</td>
                <td class="px-4 py-3 text-right text-slate-600">{{ formatInteger(landing.impressions) }}</td>
                <td class="px-4 py-3 text-right font-medium text-slate-900">{{ formatInteger(landing.clicks) }}</td>
                <td class="px-4 py-3 text-right text-slate-600">{{ formatPercent(landing.ctr) }}</td>
                <td class="px-4 py-3 text-right text-slate-600">{{ landing.avgPosition.toFixed(1) }}</td>
                <td class="px-4 py-3 text-right font-semibold text-emerald-600">
                  {{ formatEuros(landing.assistedRevenueNetCents) }}
                </td>
                <td class="px-4 py-3 text-right text-slate-600">{{ formatEuros(landing.contentCostCents) }}</td>
                <td class="px-4 py-3 text-right font-semibold text-indigo-600">
                  {{ landing.seoRoi > 0 ? `${landing.seoRoi.toFixed(2)}x` : '-' }}
                </td>
              </tr>
              <tr v-if="data.landingPages.length === 0">
                <td colspan="8" class="px-4 py-8 text-center text-slate-500">
                  No hay páginas de destino registradas en este período.
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- Queries Table -->
      <div
        class="rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden"
        data-testid="seo-queries-table"
      >
        <div class="border-b border-slate-200 bg-slate-50 px-4 py-3">
          <h3 class="text-sm font-semibold text-slate-900">Consultas de Búsqueda Orgánicas (Keywords)</h3>
        </div>
        <div class="overflow-x-auto">
          <table class="min-w-full divide-y divide-slate-200 text-sm">
            <thead class="bg-slate-50 text-xs font-medium text-slate-500 uppercase tracking-wider text-left">
              <tr>
                <th class="px-4 py-3">Consulta</th>
                <th class="px-4 py-3 text-right">Impresiones</th>
                <th class="px-4 py-3 text-right">Clicks</th>
                <th class="px-4 py-3 text-right">CTR</th>
                <th class="px-4 py-3 text-right">Pos. Media</th>
                <th class="px-4 py-3 text-right">Pedidos Asistidos</th>
                <th class="px-4 py-3 text-right">Revenue Asistido (Neto)</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-200 bg-white">
              <tr v-for="q in data.queries" :key="q.query" class="hover:bg-slate-50">
                <td class="px-4 py-3 font-medium text-slate-900">{{ q.query }}</td>
                <td class="px-4 py-3 text-right text-slate-600">{{ formatInteger(q.impressions) }}</td>
                <td class="px-4 py-3 text-right font-semibold text-slate-900">{{ formatInteger(q.clicks) }}</td>
                <td class="px-4 py-3 text-right text-slate-600">{{ formatPercent(q.ctr) }}</td>
                <td class="px-4 py-3 text-right text-slate-600">{{ q.avgPosition.toFixed(1) }}</td>
                <td class="px-4 py-3 text-right text-slate-600">{{ q.assistedOrdersCount }}</td>
                <td class="px-4 py-3 text-right font-semibold text-emerald-600">
                  {{ formatEuros(q.assistedRevenueNetCents) }}
                </td>
              </tr>
              <tr v-if="data.queries.length === 0">
                <td colspan="7" class="px-4 py-8 text-center text-slate-500">
                  No hay consultas de búsqueda en este período.
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </div>
</template>

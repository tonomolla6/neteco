<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { CohortsAnalyticsResponse } from '../../workers/analytics/cohorts'

const props = defineProps<{ runtime: unknown }>()
const { ready, loggedIn, user } = useUserSession()
const requestFetch = useRequestFetch()

const fromDate = ref('')
const toDate = ref('')
const selectedSegment = ref<'all' | 'particular' | 'professional'>('all')
const churnDays = ref(90)

const loading = ref(false)
const error = ref<string | null>(null)
const data = ref<CohortsAnalyticsResponse | null>(null)

const isAuthorized = computed(() => {
  return (
    props.runtime === 'cloudflare' &&
    ready.value === true &&
    loggedIn.value === true &&
    user.value?.emailVerified === true &&
    user.value?.mfaVerified === true
  )
})

function formatPercent(rate: number | null | undefined): string {
  if (rate === null || rate === undefined || Number.isNaN(rate)) return '-'
  return `${(rate * 100).toFixed(1)}%`
}

async function fetchCohorts() {
  if (!isAuthorized.value) return
  loading.value = true
  error.value = null

  try {
    const params = new URLSearchParams()
    if (fromDate.value) params.set('from', `${fromDate.value}T00:00:00Z`)
    if (toDate.value) params.set('to', `${toDate.value}T23:59:59Z`)
    if (selectedSegment.value !== 'all') params.set('segment', selectedSegment.value)
    if (churnDays.value) params.set('churnDays', String(churnDays.value))

    const response = await requestFetch<CohortsAnalyticsResponse>(
      `/api/admin/analytics/cohorts${params.toString() ? `?${params.toString()}` : ''}`,
      { method: 'GET' }
    )
    data.value = response
  } catch (err: unknown) {
    error.value = err instanceof Error ? err.message : 'Error al cargar las cohortes de analítica'
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  if (isAuthorized.value) {
    void fetchCohorts()
  }
})
</script>

<template>
  <div class="space-y-6">
    <div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <h2 class="text-xl font-bold text-slate-900 flex items-center gap-2">
          Cohortes de repetición y ciclo de vida
          <span class="rounded bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-800">DAT-014</span>
        </h2>
        <p class="text-sm text-slate-500">
          Análisis de primera/segunda compra, tiempo a recompra, churn por inactividad y desglose de clientes.
        </p>
      </div>

      <button
        type="button"
        class="inline-flex items-center justify-center rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-emerald-700 disabled:opacity-50"
        :disabled="loading || !isAuthorized"
        data-testid="cohorts-refresh"
        @click="fetchCohorts"
      >
        <span v-if="loading">Cargando...</span>
        <span v-else>Actualizar</span>
      </button>
    </div>

    <!-- Filtros -->
    <div class="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <form class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5" @submit.prevent="fetchCohorts">
        <div>
          <label for="cohorts-from" class="block text-xs font-medium text-slate-700">Desde (mes/fecha)</label>
          <input
            id="cohorts-from"
            v-model="fromDate"
            type="date"
            class="mt-1 block w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
          />
        </div>

        <div>
          <label for="cohorts-to" class="block text-xs font-medium text-slate-700">Hasta (mes/fecha)</label>
          <input
            id="cohorts-to"
            v-model="toDate"
            type="date"
            class="mt-1 block w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
          />
        </div>

        <div>
          <label for="cohorts-segment" class="block text-xs font-medium text-slate-700">Segmento</label>
          <select
            id="cohorts-segment"
            v-model="selectedSegment"
            class="mt-1 block w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
          >
            <option value="all">Todos los clientes</option>
            <option value="particular">Particular</option>
            <option value="professional">Profesional (B2B)</option>
          </select>
        </div>

        <div>
          <label for="cohorts-churn" class="block text-xs font-medium text-slate-700">Inactividad churn (días)</label>
          <input
            id="cohorts-churn"
            v-model.number="churnDays"
            type="number"
            min="1"
            max="730"
            class="mt-1 block w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
          />
        </div>

        <div class="flex items-end">
          <button
            type="submit"
            class="w-full rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white shadow hover:bg-slate-800 disabled:opacity-50"
            :disabled="loading || !isAuthorized"
            data-testid="cohorts-apply"
          >
            Consultar cohortes
          </button>
        </div>
      </form>
    </div>

    <!-- Error state -->
    <div
      v-if="error"
      class="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700"
      role="alert"
      data-testid="cohorts-error"
    >
      {{ error }}
    </div>

    <!-- Resumen KPIs -->
    <div v-if="data" class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <div class="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <p class="text-xs font-medium uppercase tracking-wider text-slate-500">Clientes analizados</p>
        <p class="mt-2 text-2xl font-bold text-slate-900" data-testid="metric-total-customers">
          {{ data.summary.totalCustomers }}
        </p>
      </div>

      <div class="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <p class="text-xs font-medium uppercase tracking-wider text-slate-500">Tasa global de recompra</p>
        <p class="mt-2 text-2xl font-bold text-emerald-600" data-testid="metric-repeat-rate">
          {{ formatPercent(data.summary.overallRepeatRate) }}
        </p>
        <p class="text-xs text-slate-400 mt-1">{{ data.summary.totalRepeatCustomers }} recompradores</p>
      </div>

      <div class="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <p class="text-xs font-medium uppercase tracking-wider text-slate-500">Tiempo mediano recompra</p>
        <p class="mt-2 text-2xl font-bold text-slate-900" data-testid="metric-median-days">
          {{ data.summary.medianDaysToRepurchase !== null ? `${data.summary.medianDaysToRepurchase} días` : 'N/A' }}
        </p>
      </div>

      <div class="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <p class="text-xs font-medium uppercase tracking-wider text-slate-500">
          Tasa de churn ({{ data.filters.churnDays }}d)
        </p>
        <p class="mt-2 text-2xl font-bold text-rose-600" data-testid="metric-churn-rate">
          {{ formatPercent(data.summary.overallChurnRate) }}
        </p>
      </div>
    </div>

    <!-- Tabla de Cohortes -->
    <div v-if="data" class="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      <div class="p-4 border-b border-slate-200 flex justify-between items-center">
        <h3 class="text-base font-semibold text-slate-900">Matriz de cohortes mensuales</h3>
        <span class="text-xs text-slate-400">Versión de definición: {{ data.definitionVersion }}</span>
      </div>

      <div v-if="data.cohorts.length === 0" class="p-8 text-center text-slate-500" data-testid="cohorts-empty">
        No hay pedidos válidos para generar cohortes en el rango seleccionado.
      </div>

      <div v-else class="overflow-x-auto">
        <table class="min-w-full divide-y divide-slate-200 text-left text-sm" data-testid="cohorts-table">
          <thead class="bg-slate-50 text-xs font-semibold text-slate-600">
            <tr>
              <th scope="col" class="py-3.5 pl-4 pr-3">Cohorte</th>
              <th scope="col" class="px-3 py-3.5">Tamaño (N)</th>
              <th scope="col" class="px-3 py-3.5">Recompra 30d</th>
              <th scope="col" class="px-3 py-3.5">Recompra 60d</th>
              <th scope="col" class="px-3 py-3.5">Recompra 90d</th>
              <th scope="col" class="px-3 py-3.5">Recompra 180d</th>
              <th scope="col" class="px-3 py-3.5">Mediana días</th>
              <th scope="col" class="px-3 py-3.5">Churn ({{ data.filters.churnDays }}d)</th>
              <th scope="col" class="px-3 py-3.5">Part. / Prof.</th>
              <th scope="col" class="py-3.5 pl-3 pr-4">Top Categorías</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-slate-200 bg-white">
            <tr v-for="c in data.cohorts" :key="c.cohort" class="hover:bg-slate-50">
              <td class="whitespace-nowrap py-3 pl-4 pr-3 font-semibold text-slate-900">{{ c.cohort }}</td>
              <td class="whitespace-nowrap px-3 py-3 font-medium text-slate-700">{{ c.size }}</td>
              <td class="whitespace-nowrap px-3 py-3">
                <span class="font-medium text-emerald-600">{{ formatPercent(c.repeat30Days.rate) }}</span>
                <span class="ml-1 text-xs text-slate-400">({{ c.repeat30Days.count }})</span>
              </td>
              <td class="whitespace-nowrap px-3 py-3">
                <span class="font-medium text-emerald-600">{{ formatPercent(c.repeat60Days.rate) }}</span>
                <span class="ml-1 text-xs text-slate-400">({{ c.repeat60Days.count }})</span>
              </td>
              <td class="whitespace-nowrap px-3 py-3">
                <span class="font-medium text-emerald-600">{{ formatPercent(c.repeat90Days.rate) }}</span>
                <span class="ml-1 text-xs text-slate-400">({{ c.repeat90Days.count }})</span>
              </td>
              <td class="whitespace-nowrap px-3 py-3">
                <span class="font-medium text-emerald-600">{{ formatPercent(c.repeat180Days.rate) }}</span>
                <span class="ml-1 text-xs text-slate-400">({{ c.repeat180Days.count }})</span>
              </td>
              <td class="whitespace-nowrap px-3 py-3 font-medium text-slate-600">
                {{ c.medianDaysToRepurchase !== null ? `${c.medianDaysToRepurchase}d` : '-' }}
              </td>
              <td class="whitespace-nowrap px-3 py-3">
                <span class="font-medium text-rose-600">{{ formatPercent(c.churn.rate) }}</span>
                <span class="ml-1 text-xs text-slate-400">({{ c.churn.count }})</span>
              </td>
              <td class="whitespace-nowrap px-3 py-3 text-xs text-slate-600">
                <div>
                  Part: {{ c.segments.particular.count }} ({{ formatPercent(c.segments.particular.repeatRate) }})
                </div>
                <div>
                  Prof: {{ c.segments.professional.count }} ({{ formatPercent(c.segments.professional.repeatRate) }})
                </div>
              </td>
              <td class="py-3 pl-3 pr-4 text-xs text-slate-600">
                <div v-for="cat in c.topCategories" :key="cat.categoryId" class="truncate max-w-[160px]">
                  {{ cat.categoryName }}: {{ cat.customerCount }}
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Definiciones documentadas -->
    <div v-if="data" class="rounded-xl border border-slate-200 bg-slate-50 p-4 text-xs text-slate-600">
      <h4 class="font-semibold text-slate-800 mb-2">
        Definiciones metodológicas (Versión {{ data.definitionVersion }})
      </h4>
      <dl class="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-2">
        <div v-for="(desc, title) in data.definitions" :key="title">
          <dt class="font-medium text-slate-700 capitalize">{{ title }}:</dt>
          <dd class="text-slate-500">{{ desc }}</dd>
        </div>
      </dl>
    </div>
  </div>
</template>
